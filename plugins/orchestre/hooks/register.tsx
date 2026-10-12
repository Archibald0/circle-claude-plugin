// Le mod du plugin orchestre : suit un run dans la session pilote, en lecture seule.
// Il lit plans/<nom>/suivi.json (orchestre-suivi/2, ou /1 d'avant la 0.11.0), que seul scripts/suivi.mjs d'orchestre écrit, et dessine :
//   - un bandeau au-dessus du prompt pendant un run (phase, avancement, en cours, à relire, durée) ;
//   - un suffixe au spinner (tâche et étape en cours) ;
//   - /suivi : un panneau en cartes (À toi, le run, les tâches en frise, le journal), ou le même état en texte ;
//   - une notification seulement pour ce qui demande quelqu'un : tâche qui attend un humain, bloquée ou en échec, run
//     arrêté ou en erreur ; avec /suivi son, un son en plus ;
//   - au retour après 15 min sans prompt, ce qui a changé ; une ligne d'état quand le bandeau de fin est masqué.
// Il n'écrit jamais dans le dépôt : ses seules écritures sont dans $.state (affichage), $.store (le son) et le prompt
// (les actions du panneau y préparent un texte, jamais envoyé).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Action, Card, Snapshot, Line, Section } from '../types'
import { FRAME_COUNT, DEMO_FRAME_MS, DEMO_PLAN, demoEnd, demoSnapshot, frameAt } from './demo.mjs'
import { IMPORTANT_TOAST_MS, FORMATS, IMAGE_MS, banner, plainText, changes, cut, since, formatOf, isImportant, statusLine, normalize, news, pane, activeRun, runInProgress, suffix, stateText } from './modele.mjs'

const PANE_ID = 'orchestre'
// Le son joué quand quelque chose t'attend, avec /suivi son (afplay sur macOS ; rien sur un terminal Linux ou Windows)
const SOUND = 'sons/attend.wav'
// Au premier prompt après ce silence, une notification dit ce qui a changé
const AWAY_MS = 15 * 60000
const NOTHING_TO_FOLLOW = 'à suivre dans ce dépôt : aucun plans/<nom>/suivi.json. Il apparaît au premier run d\'orchestre (0.8 ou plus). /suivi demo joue la démo.'
const REREAD_MS = 2000
// Un run interrompu (« sans nouvelles ») ne s'anime plus : son âge avance toutes les 30 s
const SLOW_MS = 30000
const snapshot = atom({ plugin: 'orchestre', key: 'snapshot' } as const, null)
const followedPlan = atom({ plugin: 'orchestre', key: 'plan' } as const, null)
const lastRead = atom({ plugin: 'orchestre', key: 'lastRead' } as const, 0)
const fullLog = atom({ plugin: 'orchestre', key: 'fullLog' } as const, false)
const hidden = atom({ plugin: 'orchestre', key: 'hidden' } as const, null)
const alert = atom({ plugin: 'orchestre', key: 'alert' } as const, null)

// Place des boutons à la suite du bandeau : « ⤢ Détail », toujours, et « ✕ Masquer » à la fin d'un run. Ils se cliquent,
// sans touche : un chiffre tapé seul dans un prompt vide les aurait pressés au lieu de l'écrire.
const DETAILS_RESERVE = 11
const HIDE_RESERVE = 10

// /clear, /resume et /branch remettent $.state à ses valeurs par défaut sans relancer session.start : les deux choix de
// la personne y sont gardés aussi, pour les rétablir (classic.SessionStart). Un rechargement du module, lui, garde $.state.
let chosenPlan: string | null = null
let chosenHidden: number | null = null

const parent = (p: string) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'

// Le dossier plans/ du dépôt : celui du dossier de la session, sinon d'un dossier parent (4 au plus)
async function repoRoot($: EngineInterface): Promise<string | null> {
  let dir = await $.session.cwd()
  for (let i = 0; i < 5; i++) {
    if (await $.fs.exists(`${dir}/plans`).catch(() => false)) return dir
    const up = parent(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

// Le plan à suivre : celui que /suivi plans/<nom> a choisi, s'il a un suivi.json ; sinon le suivi.json écrit en dernier,
// celui du run en cours puisque le workflow l'écrit à chaque transition. Rien n'est lu ici : une liste et des stat.
async function findPlan($: EngineInterface, base: string): Promise<string | null> {
  const chosen = await read($, followedPlan)
  if (chosen && (await $.fs.exists(`${base}/${chosen}/suivi.json`).catch(() => false))) return chosen
  const entries = await $.fs.list(`${base}/plans`).catch(() => [])
  let best: { plan: string; mtime: number } | null = null
  for (const d of entries.filter(x => x.kind === 'dir').slice(0, 50)) {
    const st = await $.fs.stat(`${base}/plans/${d.name}/suivi.json`).catch(() => null)
    if (st && (!best || st.mtimeMs > best.mtime)) best = { plan: `plans/${d.name}`, mtime: st.mtimeMs }
  }
  return best?.plan ?? null
}

async function readJson($: EngineInterface, filePath: string): Promise<unknown> {
  try {
    const t = await $.fs.read(filePath)
    return typeof t === 'string' ? JSON.parse(t) : null
  } catch {
    return null // absent, trop gros ou en cours de renommage : on garde l'affichage précédent
  }
}

// Relit suivi.json s'il a changé (ou si c'est un autre fichier), met l'instantané à jour et notifie ce qui le mérite.
// Pendant la démo, rien n'est lu. Une démo restée affichée après un rechargement du mod s'efface s'il n'y a rien à suivre.
let lastFile: string | null = null
async function refresh($: EngineInterface, force: boolean): Promise<void> {
  if (demo) return
  const base = await repoRoot($)
  if (!base) return forgetDemo($)
  const plan = await findPlan($, base)
  if (!plan) return forgetDemo($)
  const f = `${base}/${plan}/suivi.json`
  const st = await $.fs.stat(f).catch(() => null)
  if (!st) return forgetDemo($)
  if (!force && f === lastFile && st.mtimeMs === (await read($, lastRead))) return
  const doc = await readJson($, f)
  if (doc === null) return
  lastFile = f
  await update($, lastRead, () => st.mtimeMs)
  if (!FORMATS.includes(formatOf(doc) ?? '')) {
    const format = formatOf(doc) ?? 'inconnu'
    if ((await read($, alert)) !== format) {
      await update($, alert, () => format)
      $.ui.toast(`${plan}/suivi.json est au format ${format} ; ce mod lit ${FORMATS.join(' et ')}. Mets à jour le plugin orchestre.`, { timeoutMs: IMPORTANT_TOAST_MS })
    }
    return
  }
  const after = normalize(doc)
  if (!after) return
  const before = await read($, snapshot)
  await update($, snapshot, () => after)
  notify($, changes(before, after))
  await updateStatus($)
}

// Seul ce qui demande quelqu'un devient une notification (et un son, si /suivi son l'a activé) ; le reste se lit au bout
// du bandeau et dans le journal du panneau
let soundOn = false
function notify($: EngineInterface, messages: string[]): void {
  const important = messages.filter(isImportant)
  for (const message of important) $.ui.toast(message, { timeoutMs: IMPORTANT_TOAST_MS })
  if (important.length && soundOn) void $.audio.play({ asset: SOUND }).catch(() => undefined)
}

// La ligne d'état : quand le bandeau de fin est masqué et qu'il reste quelque chose à faire (relectures, ce qui attend)
let lastStatus: string | undefined
async function updateStatus($: EngineInterface): Promise<void> {
  const inst = await read($, snapshot)
  const runHidden = !!inst?.run && inst.run.status !== 'en-cours' && (await read($, hidden)) === inst.run.number
  const text = inst && runHidden ? statusLine(inst, await $.clock.now()) ?? undefined : undefined
  if (text === lastStatus) return
  lastStatus = text
  try { $.ui.status(text) } catch { /* pas de ligne d'état sur cette surface */ }
}

async function forgetDemo($: EngineInterface): Promise<void> {
  if ((await read($, snapshot))?.demo) await update($, snapshot, () => null)
}

// Le mode démo (/suivi demo) : un run joué en mémoire, pas à pas, avec ses notifications ; la dernière image reste une
// minute, puis le vrai suivi reprend. Le « Masquer » d'un run de la démo ne vaut pas pour les vrais runs.
let demo: { start: number; frameMs: number; seen: number; finished: boolean } | null = null
// Le panneau ouvert pendant la démo porte « (démo) » dans son titre : il se ferme quand la démo rend la main
let demoPane = false
async function startDemo($: EngineInterface): Promise<void> {
  demo = { start: await $.clock.now(), frameMs: DEMO_FRAME_MS, seen: -1, finished: false }
  chosenHidden = null
  await update($, hidden, () => null)
  await advanceDemo($)
}
async function advanceDemo($: EngineInterface): Promise<void> {
  if (!demo) return
  const now = await $.clock.now()
  if (now >= demoEnd(demo.start, demo.frameMs)) return quitDemo($)
  const k = Math.max(0, frameAt(now, demo.start, demo.frameMs))
  const before = await read($, snapshot)
  // Après /clear, l'image courante revient sans notification
  if (k === demo.seen && before?.demo) return
  const following = demo.seen >= 0 && !!before?.demo
  demo.seen = k
  const after = demoSnapshot(k, demo.start, demo.frameMs)
  await update($, snapshot, () => after)
  if (following) notify($, changes(before, after))
  await updateStatus($)
  if (k === FRAME_COUNT - 1 && !demo.finished) {
    demo.finished = true
    $.ui.toast('Démo terminée. Le vrai suivi reprend dans une minute ; /suivi auto pour tout de suite.', { timeoutMs: IMPORTANT_TOAST_MS })
  }
}
async function quitDemo($: EngineInterface): Promise<void> {
  if (!demo) return
  demo = null
  if (demoPane) {
    demoPane = false
    await $.ui.close({ id: PANE_ID }).catch(() => undefined)
  }
  chosenHidden = null
  await update($, hidden, () => null)
  await update($, snapshot, () => null)
  await update($, lastRead, () => 0)
  lastFile = null
  await refresh($, true).catch(() => undefined)
  await updateStatus($)
}

// On ne suit que là où quelque chose se dessine : le terminal (REPL), ou une session que l'app de bureau héberge,
// qui démarre sans surface et en reçoit une à la connexion de l'app (session.attach). Un `claude -p` ne lit rien.
let started = false
async function startFollowing($: EngineInterface): Promise<void> {
  if (started) return
  started = true
  lastPrompt = await $.clock.now()
  soundOn = (await $.store.get('son').catch(() => null)) === true
  await refresh($, true).catch(() => undefined)
  $.clock.every(REREAD_MS, () => { void refresh($, false).catch(() => undefined) })
  $.clock.every(IMAGE_MS, () => { void animate($).catch(() => undefined) })
  // En dernier : un nom déjà pris fait échouer l'enregistrement, et le suivi doit tourner quand même
  try {
    await $.command.register({ name: 'suivi', description: 'Suivi du plan orchestre : ce qui t\'attend, le run, les tâches, le journal', argumentHint: '[plans/<nom> | auto | demo | son] [texte]', immediate: true })
  } catch (err) {
    $.ui.toast(`orchestre : /suivi n'a pas pu être ajoutée (${err instanceof Error ? err.message : String(err)}). Le bandeau et les notifications restent actifs.`, { timeoutMs: IMPORTANT_TOAST_MS })
  }
}

// Les animations : pendant un run actif, et tant qu'une nouvelle a moins de 10 s, tout est redessiné à chaque image
// (spinner, barre qui pulse, chronos, nouvelle qui s'estompe). Un run sans nouvelles ne bouge plus : toutes les 30 s.
let lastRedraw = 0
async function animate($: EngineInterface): Promise<void> {
  if (demo) await advanceDemo($)
  const inst = await read($, snapshot)
  if (!inst) return
  const now = await $.clock.now()
  const lively = !!activeRun(inst, now) || !!news(inst, now)
  if (!lively && !(runInProgress(inst) && now - lastRedraw >= SLOW_MS)) return
  lastRedraw = now
  $.ui.invalidate('ui.render')
}

// Après /clear, /resume ou /branch : les choix de la personne reviennent, et suivi.json est relu tout de suite
async function restore($: EngineInterface): Promise<void> {
  if (chosenPlan) await update($, followedPlan, () => chosenPlan)
  if (chosenHidden != null) await update($, hidden, () => chosenHidden)
  await refresh($, true).catch(() => undefined)
  await updateStatus($)
}

// Le retour de la personne : son premier prompt après ABSENCE_MS de silence
let lastPrompt: number | null = null
// Les ouvertures du panneau : il dit en tête ce qui a changé depuis la précédente
let lastOpening: number | null = null
let previousVisit: number | null = null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (e.isInteractive || e.surface !== null) await startFollowing($)
    return r
  })

  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    await startFollowing($)
    return r
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    const r = await next(e)
    if (started) await restore($)
    return r
  })

  // Au retour après un silence, ce qui a changé depuis le dernier prompt. Le prompt part d'abord, toujours.
  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    const before = lastPrompt
    lastPrompt = now
    if (before == null || now - before < AWAY_MS) return r
    const inst = await read($, snapshot)
    const l = inst && !inst.demo ? since(inst, before, now) : null
    if (l) $.ui.toast(plainText(l), { timeoutMs: IMPORTANT_TOAST_MS })
    return r
  }).catch(($, e, next) => next(e))

  // /suivi répond tout de suite, même pendant un tour : le panneau, ou l'état en texte
  on('command.run', { command: 'suivi' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    if (words.includes('son')) {
      soundOn = !soundOn
      await $.store.set('son', soundOn).catch(() => undefined)
      return { text: soundOn ? 'orchestre : son activé quand quelque chose t\'attend (macOS). /suivi son pour le couper.' : 'orchestre : son coupé. /suivi son pour le remettre.' }
    }
    if (words.includes('demo') || words.includes('démo')) {
      await startDemo($)
      return { text: `Démo lancée : le run d'un plan fictif, ${DEMO_PLAN} (5 tâches, 2 phases), joué en un peu plus d'une minute dans le bandeau et les notifications, marqué DÉMO. /suivi ouvre le panneau ; /suivi auto revient au vrai suivi.` }
    }
    const plan = words.find(m => m.startsWith('plans/'))
    if (plan) {
      chosenPlan = plan.replace(/\/+$/, '')
      await update($, followedPlan, () => chosenPlan)
    }
    if (words.includes('auto')) {
      chosenPlan = null
      await update($, followedPlan, () => null)
    }
    if (plan || words.includes('auto')) await quitDemo($)
    await refresh($, true).catch(() => undefined)
    const inst = await read($, snapshot)
    if (!inst) return { text: `orchestre : rien ${NOTHING_TO_FOLLOW}` }
    const now = await $.clock.now()
    if (words.includes('texte')) return { text: stateText(inst, now) }
    return (await openPane($, inst)) ? { text: `Suivi de ${inst.plan} ouvert dans le panneau.` } : { text: stateText(inst, now) }
  })

  // Le bandeau : pendant un run, puis l'état de fin jusqu'à ce qu'on le masque ou qu'un run reparte. La bande est partagée :
  // ce que dessinent les mods suivants (next) reste dessous. « ⤢ Détail » ouvre le panneau, « ✕ Masquer » cache le bandeau
  // de fin : deux boutons à cliquer, au bout de la ligne.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const inst = await read($, snapshot)
    if (!inst || !inst.run || e.props.hasSurvey) return next(e)
    const finished = inst.run.status !== 'en-cours'
    if (finished && (await read($, hidden)) === inst.run.number) return next(e)
    const line = banner(inst, await $.clock.now(), e.props.bodyColumns, DETAILS_RESERVE + (finished ? HIDE_RESERVE : 0), true)
    if (!line) return next(e)
    const others = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const number = inst.run.number
    return (
      <Box flexDirection="column">
        <Box key="orchestre" flexDirection="row">
          {draw($, e, line, 'bandeau')}
          <Text>{'   '}</Text>
          <Button key="detail" label="⤢ Détail" plain hover={{ scope: 'orchestre-detail', color: 'inverseText', backgroundColor: 'claude', bold: true }} onPress={() => openFromBanner($, null)} />
          {finished && <Text> </Text>}
          {finished && <Button key="masquer" label="✕ Masquer" plain dimColor onPress={async () => { chosenHidden = number; await update($, hidden, () => number); await updateStatus($) }} />}
        </Box>
        {others}
      </Box>
    )
  })

  // Le spinner : la tâche et l'étape en cours, et le nombre de tâches qui tournent
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const inst = await read($, snapshot)
    const s = inst ? suffix(inst, await $.clock.now()) : null
    return s ? next({ ...e, props: { ...e.props, suffix: s } }) : next(e)
  })

  // Le panneau : une vue en cartes. t, r, b et j font défiler jusqu'à une carte (j montre aussi tout le journal) ; ← et →
  // restent à Claude Code. Les lignes de « À toi » ont les touches 1 à 9, la suite d'un run fini l ou p.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const inst = await read($, snapshot)
    if (!inst) return <Text dimColor wrap="wrap">{`Rien ${NOTHING_TO_FOLLOW}`}</Text>
    const now = await $.clock.now()
    const full = await read($, fullLog)
    const p = pane(inst, now, e.props.bodyColumns, { animated: true, fullLog: full, since: previousVisit })
    const yourTurnShown = p.cards.some(c => c.id === 'toi')
    const nav: [Section, string, string][] = [...(yourTurnShown ? [['toi', 'à toi', 'r'] as [Section, string, string]] : []), ['run', 'run', 'b'], ['taches', 'tâches', 't'], ['journal', full ? 'journal (moins)' : 'journal', 'j']]
    return (
      <Box flexDirection="column">
        {p.header.map((l, i) => (i < 2 ? <Box key={`entete-${i}`} flexDirection="row" justifyContent="center">{draw($, e, l, `entete-${i}-l`)}</Box> : draw($, e, l, `entete-${i}`)))}
        <Box key="nav" flexDirection="row" marginTop={1}>
          {nav.flatMap(([id, label, hotkey], i) => [
            ...(i ? [<Text key={`nav-entre-${id}`}>{'  '}</Text>] : []),
            <Button key={`nav-${id}`} label={label} hotkey={hotkey} plain {...(i === 0 ? { autoFocus: true as const } : {})} onPress={() => goTo($, id)} />,
          ])}
          <Text key="nav-aide" dimColor wrap="truncate">{'   · 1-9 : agir · Échap : fermer'}</Text>
        </Box>
        {p.cards.map(c => card($, e, c, p.borders))}
      </Box>
    )
  })
}

// Une carte : bord de sa couleur (sauf au-dessous de 60 colonnes, ou sans couleur), titre à gauche, compteur à droite
function card($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], c: Card, borders: boolean) {
  const { Box } = $.ui.resolve(e)
  const frame = borders && c.color ? { borderStyle: 'round', borderColor: c.color, paddingX: 1 } : {}
  return (
    <Box key={`carte-${c.id}`} flexDirection="column" marginTop={1} {...frame}>
      <Box key={`carte-${c.id}-haut`} flexDirection="row" justifyContent="space-between">
        {draw($, e, c.title, `carte-${c.id}-titre`)}
        {c.meta.length ? draw($, e, c.meta, `carte-${c.id}-meta`) : null}
      </Box>
      {c.lines.map((l, i) => draw($, e, l, `carte-${c.id}-${i}`))}
    </Box>
  )
}

// Défile jusqu'à une carte ; j montre aussi tout le journal, ou revient à ses dernières entrées
async function goTo($: EngineInterface, id: Section): Promise<void> {
  if (id === 'journal') await update($, fullLog, v => !v)
  scrollTo($, id)
}
// Juste après l'ouverture, la carte peut ne pas être encore dessinée : un second essai un peu plus tard
function scrollTo($: EngineInterface, id: Section): void {
  const attempt = () => $.ui.scroll({ in: PANE_ID, to: { key: `carte-${id}` }, block: 'start' })
  attempt().catch(() => { void $.clock.sleep(250).then(attempt).catch(() => undefined) })
}

// Le panneau, défilé jusqu'à une carte si on en nomme une. Ouvert pendant la démo, il se fermera avec elle.
async function openPane($: EngineInterface, inst: Snapshot, target: Section | null = null): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE_ID, title: `Orchestre · ${inst.plan}${inst.demo ? ' (démo)' : ''}`, focus: true, closeOnEscape: true }).catch(() => null)
  if (!opened?.isPlaced) return false
  demoPane = inst.demo
  const now = await $.clock.now()
  previousVisit = lastOpening
  lastOpening = now
  if (target) scrollTo($, target)
  return true
}

// Un clic dans le bandeau : « ⤢ Détail », « à relire », « à toi »
async function openFromBanner($: EngineInterface, target: Section | null): Promise<void> {
  const inst = await read($, snapshot)
  if (inst && !(await openPane($, inst, target))) $.ui.toast('Le panneau ne s\'ouvre pas ici : /suivi texte donne le même état.')
}

// Une action du panneau : son texte va dans le prompt, après ce qui y est déjà tapé, et rien n'est envoyé. Pendant la
// démo, rien ne va dans le prompt : une notification dit ce que la touche ferait.
async function act($: EngineInterface, action: Action): Promise<void> {
  const inst = await read($, snapshot)
  if (inst?.demo) {
    $.ui.toast(`Démo : cette touche préparerait dans le prompt « ${cut(action.prompt, 90)} ».`, { timeoutMs: IMPORTANT_TOAST_MS })
    return
  }
  const filled = await $.prompt.fill({ text: action.prompt, mode: 'append' })
  $.ui.toast(filled.isFilled ? 'Dans le prompt : relis, complète, puis envoie. Rien n\'est parti.' : 'Le prompt n\'a pas pris le texte.')
}

// Une ligne de morceaux : un Text par morceau, dans une rangée
function draw($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], line: Line, itemKey: string) {
  const { Box, Button, Text } = $.ui.resolve(e)
  if (!line.length) return <Text key={itemKey}> </Text>
  return (
    <Box key={itemKey} flexDirection="row">
      {line.map((m, i) => {
        const target = m.a, action = m.x
        // Une mention du bandeau mène à une carte : un bouton, en pastille ambre au survol. Une action du panneau : un
        // bouton à touche (1 à 9, l, p) qui prépare son texte dans le prompt.
        if (target) return <Button key={`aller-${m.k ?? target}`} label={m.t} plain hover={{ scope: `orchestre-${m.k ?? target}`, color: 'inverseText', backgroundColor: 'warning', bold: true }} onPress={() => openFromBanner($, target)} />
        if (action) return <Button key={`action-${action.hotkey ?? `${itemKey}-${i}`}`} label={m.t} plain {...(action.hotkey ? { hotkey: action.hotkey } : {})} onPress={() => act($, action)} />
        return <Text key={`${itemKey}-${i}`} color={m.c} backgroundColor={m.f} bold={m.b} dimColor={m.d} wrap="truncate">{m.t}</Text>
      })}
    </Box>
  )
}
