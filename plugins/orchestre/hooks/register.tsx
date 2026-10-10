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

import type { Action, Carte, Instantane, Ligne, Section } from '../types'
import { NB_PAS, PAS_DEMO_MS, PLAN_DEMO, finDemo, instantaneDemo, pasA } from './demo.mjs'
import { DUREE_IMPORTANTE_MS, FORMATS, IMAGE_MS, bandeau, brut, changements, court, depuis, formatDe, importante, ligneEtat, normaliser, nouvelle, panneau, runActif, runEnCours, suffixe, texteEtat } from './modele.mjs'

const PANNEAU = 'orchestre'
// Le son joué quand quelque chose t'attend, avec /suivi son (afplay sur macOS ; rien sur un terminal Linux ou Windows)
const SON = 'sons/attend.wav'
// Au premier prompt après ce silence, une notification dit ce qui a changé
const ABSENCE_MS = 15 * 60000
const RIEN_A_SUIVRE = 'à suivre dans ce dépôt : aucun plans/<nom>/suivi.json. Il apparaît au premier run d\'orchestre (0.8 ou plus). /suivi demo joue la démo.'
const RELIRE_MS = 2000
// Un run interrompu (« sans nouvelles ») ne s'anime plus : son âge avance toutes les 30 s
const LENT_MS = 30000
const instantane = atom({ plugin: 'orchestre', key: 'instantane' } as const, null)
const planSuivi = atom({ plugin: 'orchestre', key: 'plan' } as const, null)
const lu = atom({ plugin: 'orchestre', key: 'lu' } as const, 0)
const journalComplet = atom({ plugin: 'orchestre', key: 'journal' } as const, false)
const masque = atom({ plugin: 'orchestre', key: 'masque' } as const, null)
const alerte = atom({ plugin: 'orchestre', key: 'alerte' } as const, null)

// Place des boutons à la suite du bandeau : « ⤢ Détail », toujours, et « ✕ Masquer » à la fin d'un run. Ils se cliquent,
// sans touche : un chiffre tapé seul dans un prompt vide les aurait pressés au lieu de l'écrire.
const RESERVE_DETAIL = 11
const RESERVE_MASQUER = 10

// /clear, /resume et /branch remettent $.state à ses valeurs par défaut sans relancer session.start : les deux choix de
// la personne y sont gardés aussi, pour les rétablir (classic.SessionStart). Un rechargement du module, lui, garde $.state.
let planChoisi: string | null = null
let masqueChoisi: number | null = null

const parent = (p: string) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'

// Le dossier plans/ du dépôt : celui du dossier de la session, sinon d'un dossier parent (4 au plus)
async function racine($: EngineInterface): Promise<string | null> {
  let dir = await $.session.cwd()
  for (let i = 0; i < 5; i++) {
    if (await $.fs.exists(`${dir}/plans`).catch(() => false)) return dir
    const haut = parent(dir)
    if (haut === dir) break
    dir = haut
  }
  return null
}

// Le plan à suivre : celui que /suivi plans/<nom> a choisi, s'il a un suivi.json ; sinon le suivi.json écrit en dernier,
// celui du run en cours puisque le workflow l'écrit à chaque transition. Rien n'est lu ici : une liste et des stat.
async function trouverPlan($: EngineInterface, base: string): Promise<string | null> {
  const choisi = await read($, planSuivi)
  if (choisi && (await $.fs.exists(`${base}/${choisi}/suivi.json`).catch(() => false))) return choisi
  const entrees = await $.fs.list(`${base}/plans`).catch(() => [])
  let meilleur: { plan: string; mtime: number } | null = null
  for (const d of entrees.filter(x => x.kind === 'dir').slice(0, 50)) {
    const st = await $.fs.stat(`${base}/plans/${d.name}/suivi.json`).catch(() => null)
    if (st && (!meilleur || st.mtimeMs > meilleur.mtime)) meilleur = { plan: `plans/${d.name}`, mtime: st.mtimeMs }
  }
  return meilleur?.plan ?? null
}

async function lireJson($: EngineInterface, chemin: string): Promise<unknown> {
  try {
    const t = await $.fs.read(chemin)
    return typeof t === 'string' ? JSON.parse(t) : null
  } catch {
    return null // absent, trop gros ou en cours de renommage : on garde l'affichage précédent
  }
}

// Relit suivi.json s'il a changé (ou si c'est un autre fichier), met l'instantané à jour et notifie ce qui le mérite.
// Pendant la démo, rien n'est lu. Une démo restée affichée après un rechargement du mod s'efface s'il n'y a rien à suivre.
let dernierFichier: string | null = null
async function rafraichir($: EngineInterface, force: boolean): Promise<void> {
  if (demo) return
  const base = await racine($)
  if (!base) return oublierDemo($)
  const plan = await trouverPlan($, base)
  if (!plan) return oublierDemo($)
  const f = `${base}/${plan}/suivi.json`
  const st = await $.fs.stat(f).catch(() => null)
  if (!st) return oublierDemo($)
  if (!force && f === dernierFichier && st.mtimeMs === (await read($, lu))) return
  const doc = await lireJson($, f)
  if (doc === null) return
  dernierFichier = f
  await update($, lu, () => st.mtimeMs)
  if (!FORMATS.includes(formatDe(doc) ?? '')) {
    const format = formatDe(doc) ?? 'inconnu'
    if ((await read($, alerte)) !== format) {
      await update($, alerte, () => format)
      $.ui.toast(`${plan}/suivi.json est au format ${format} ; ce mod lit ${FORMATS.join(' et ')}. Mets à jour le plugin orchestre.`, { timeoutMs: DUREE_IMPORTANTE_MS })
    }
    return
  }
  const apres = normaliser(doc)
  if (!apres) return
  const avant = await read($, instantane)
  await update($, instantane, () => apres)
  notifier($, changements(avant, apres))
  await majStatut($)
}

// Seul ce qui demande quelqu'un devient une notification (et un son, si /suivi son l'a activé) ; le reste se lit au bout
// du bandeau et dans le journal du panneau
let son = false
function notifier($: EngineInterface, messages: string[]): void {
  const importants = messages.filter(importante)
  for (const message of importants) $.ui.toast(message, { timeoutMs: DUREE_IMPORTANTE_MS })
  if (importants.length && son) void $.audio.play({ asset: SON }).catch(() => undefined)
}

// La ligne d'état : quand le bandeau de fin est masqué et qu'il reste quelque chose à faire (relectures, ce qui attend)
let dernierStatut: string | undefined
async function majStatut($: EngineInterface): Promise<void> {
  const inst = await read($, instantane)
  const masqueRun = !!inst?.run && inst.run.statut !== 'en-cours' && (await read($, masque)) === inst.run.numero
  const texte = inst && masqueRun ? ligneEtat(inst, await $.clock.now()) ?? undefined : undefined
  if (texte === dernierStatut) return
  dernierStatut = texte
  try { $.ui.status(texte) } catch { /* pas de ligne d'état sur cette surface */ }
}

async function oublierDemo($: EngineInterface): Promise<void> {
  if ((await read($, instantane))?.demo) await update($, instantane, () => null)
}

// Le mode démo (/suivi demo) : un run joué en mémoire, pas à pas, avec ses notifications ; la dernière image reste une
// minute, puis le vrai suivi reprend. Le « Masquer » d'un run de la démo ne vaut pas pour les vrais runs.
let demo: { debut: number; pas: number; vu: number; fini: boolean } | null = null
// Le panneau ouvert pendant la démo porte « (démo) » dans son titre : il se ferme quand la démo rend la main
let panneauDemo = false
async function lancerDemo($: EngineInterface): Promise<void> {
  demo = { debut: await $.clock.now(), pas: PAS_DEMO_MS, vu: -1, fini: false }
  masqueChoisi = null
  await update($, masque, () => null)
  await avancerDemo($)
}
async function avancerDemo($: EngineInterface): Promise<void> {
  if (!demo) return
  const maintenant = await $.clock.now()
  if (maintenant >= finDemo(demo.debut, demo.pas)) return quitterDemo($)
  const k = Math.max(0, pasA(maintenant, demo.debut, demo.pas))
  const avant = await read($, instantane)
  // Après /clear, l'image courante revient sans notification
  if (k === demo.vu && avant?.demo) return
  const suite = demo.vu >= 0 && !!avant?.demo
  demo.vu = k
  const apres = instantaneDemo(k, demo.debut, demo.pas)
  await update($, instantane, () => apres)
  if (suite) notifier($, changements(avant, apres))
  await majStatut($)
  if (k === NB_PAS - 1 && !demo.fini) {
    demo.fini = true
    $.ui.toast('Démo terminée. Le vrai suivi reprend dans une minute ; /suivi auto pour tout de suite.', { timeoutMs: DUREE_IMPORTANTE_MS })
  }
}
async function quitterDemo($: EngineInterface): Promise<void> {
  if (!demo) return
  demo = null
  if (panneauDemo) {
    panneauDemo = false
    await $.ui.close({ id: PANNEAU }).catch(() => undefined)
  }
  masqueChoisi = null
  await update($, masque, () => null)
  await update($, instantane, () => null)
  await update($, lu, () => 0)
  dernierFichier = null
  await rafraichir($, true).catch(() => undefined)
  await majStatut($)
}

// On ne suit que là où quelque chose se dessine : le terminal (REPL), ou une session que l'app de bureau héberge,
// qui démarre sans surface et en reçoit une à la connexion de l'app (session.attach). Un `claude -p` ne lit rien.
let demarre = false
async function demarrer($: EngineInterface): Promise<void> {
  if (demarre) return
  demarre = true
  dernierPrompt = await $.clock.now()
  son = (await $.store.get('son').catch(() => null)) === true
  await rafraichir($, true).catch(() => undefined)
  $.clock.every(RELIRE_MS, () => { void rafraichir($, false).catch(() => undefined) })
  $.clock.every(IMAGE_MS, () => { void animer($).catch(() => undefined) })
  // En dernier : un nom déjà pris fait échouer l'enregistrement, et le suivi doit tourner quand même
  try {
    await $.command.register({ name: 'suivi', description: 'Suivi du plan orchestre : ce qui t\'attend, le run, les tâches, le journal', argumentHint: '[plans/<nom> | auto | demo | son] [texte]', immediate: true })
  } catch (err) {
    $.ui.toast(`orchestre : /suivi n'a pas pu être ajoutée (${err instanceof Error ? err.message : String(err)}). Le bandeau et les notifications restent actifs.`, { timeoutMs: DUREE_IMPORTANTE_MS })
  }
}

// Les animations : pendant un run actif, et tant qu'une nouvelle a moins de 10 s, tout est redessiné à chaque image
// (spinner, barre qui pulse, chronos, nouvelle qui s'estompe). Un run sans nouvelles ne bouge plus : toutes les 30 s.
let dernierRedessin = 0
async function animer($: EngineInterface): Promise<void> {
  if (demo) await avancerDemo($)
  const inst = await read($, instantane)
  if (!inst) return
  const maintenant = await $.clock.now()
  const vif = !!runActif(inst, maintenant) || !!nouvelle(inst, maintenant)
  if (!vif && !(runEnCours(inst) && maintenant - dernierRedessin >= LENT_MS)) return
  dernierRedessin = maintenant
  $.ui.invalidate('ui.render')
}

// Après /clear, /resume ou /branch : les choix de la personne reviennent, et suivi.json est relu tout de suite
async function retablir($: EngineInterface): Promise<void> {
  if (planChoisi) await update($, planSuivi, () => planChoisi)
  if (masqueChoisi != null) await update($, masque, () => masqueChoisi)
  await rafraichir($, true).catch(() => undefined)
  await majStatut($)
}

// Le retour de la personne : son premier prompt après ABSENCE_MS de silence
let dernierPrompt: number | null = null
// Les ouvertures du panneau : il dit en tête ce qui a changé depuis la précédente
let derniereOuverture: number | null = null
let visitePrecedente: number | null = null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (e.isInteractive || e.surface !== null) await demarrer($)
    return r
  })

  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    await demarrer($)
    return r
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    const r = await next(e)
    if (demarre) await retablir($)
    return r
  })

  // Au retour après un silence, ce qui a changé depuis le dernier prompt. Le prompt part d'abord, toujours.
  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    const maintenant = await $.clock.now()
    const avant = dernierPrompt
    dernierPrompt = maintenant
    if (avant == null || maintenant - avant < ABSENCE_MS) return r
    const inst = await read($, instantane)
    const l = inst && !inst.demo ? depuis(inst, avant, maintenant) : null
    if (l) $.ui.toast(brut(l), { timeoutMs: DUREE_IMPORTANTE_MS })
    return r
  }).catch(($, e, next) => next(e))

  // /suivi répond tout de suite, même pendant un tour : le panneau, ou l'état en texte
  on('command.run', { command: 'suivi' }, async ($, e) => {
    const mots = e.args.trim().split(/\s+/).filter(Boolean)
    if (mots.includes('son')) {
      son = !son
      await $.store.set('son', son).catch(() => undefined)
      return { text: son ? 'orchestre : son activé quand quelque chose t\'attend (macOS). /suivi son pour le couper.' : 'orchestre : son coupé. /suivi son pour le remettre.' }
    }
    if (mots.includes('demo') || mots.includes('démo')) {
      await lancerDemo($)
      return { text: `Démo lancée : le run d'un plan fictif, ${PLAN_DEMO} (5 tâches, 2 phases), joué en un peu plus d'une minute dans le bandeau et les notifications, marqué DÉMO. /suivi ouvre le panneau ; /suivi auto revient au vrai suivi.` }
    }
    const plan = mots.find(m => m.startsWith('plans/'))
    if (plan) {
      planChoisi = plan.replace(/\/+$/, '')
      await update($, planSuivi, () => planChoisi)
    }
    if (mots.includes('auto')) {
      planChoisi = null
      await update($, planSuivi, () => null)
    }
    if (plan || mots.includes('auto')) await quitterDemo($)
    await rafraichir($, true).catch(() => undefined)
    const inst = await read($, instantane)
    if (!inst) return { text: `orchestre : rien ${RIEN_A_SUIVRE}` }
    const maintenant = await $.clock.now()
    if (mots.includes('texte')) return { text: texteEtat(inst, maintenant) }
    return (await ouvrirPanneau($, inst)) ? { text: `Suivi de ${inst.plan} ouvert dans le panneau.` } : { text: texteEtat(inst, maintenant) }
  })

  // Le bandeau : pendant un run, puis l'état de fin jusqu'à ce qu'on le masque ou qu'un run reparte. La bande est partagée :
  // ce que dessinent les mods suivants (next) reste dessous. « ⤢ Détail » ouvre le panneau, « ✕ Masquer » cache le bandeau
  // de fin : deux boutons à cliquer, au bout de la ligne.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const inst = await read($, instantane)
    if (!inst || !inst.run || e.props.hasSurvey) return next(e)
    const fini = inst.run.statut !== 'en-cours'
    if (fini && (await read($, masque)) === inst.run.numero) return next(e)
    const ligne = bandeau(inst, await $.clock.now(), e.props.bodyColumns, RESERVE_DETAIL + (fini ? RESERVE_MASQUER : 0), true)
    if (!ligne) return next(e)
    const autres = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const numero = inst.run.numero
    return (
      <Box flexDirection="column">
        <Box key="orchestre" flexDirection="row">
          {dessiner($, e, ligne, 'bandeau')}
          <Text>{'   '}</Text>
          <Button key="detail" label="⤢ Détail" plain hover={{ scope: 'orchestre-detail', color: 'inverseText', backgroundColor: 'claude', bold: true }} onPress={() => ouvrirDepuisBandeau($, null)} />
          {fini && <Text> </Text>}
          {fini && <Button key="masquer" label="✕ Masquer" plain dimColor onPress={async () => { masqueChoisi = numero; await update($, masque, () => numero); await majStatut($) }} />}
        </Box>
        {autres}
      </Box>
    )
  })

  // Le spinner : la tâche et l'étape en cours, et le nombre de tâches qui tournent
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const inst = await read($, instantane)
    const s = inst ? suffixe(inst, await $.clock.now()) : null
    return s ? next({ ...e, props: { ...e.props, suffix: s } }) : next(e)
  })

  // Le panneau : une vue en cartes. t, r, b et j font défiler jusqu'à une carte (j montre aussi tout le journal) ; ← et →
  // restent à Claude Code. Les lignes de « À toi » ont les touches 1 à 9, la suite d'un run fini l ou p.
  on('ui.render', { component: 'Pane', requestId: PANNEAU }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const inst = await read($, instantane)
    if (!inst) return <Text dimColor wrap="wrap">{`Rien ${RIEN_A_SUIVRE}`}</Text>
    const maintenant = await $.clock.now()
    const complet = await read($, journalComplet)
    const p = panneau(inst, maintenant, e.props.bodyColumns, { anime: true, journalComplet: complet, depuis: visitePrecedente })
    const aToi = p.cartes.some(c => c.id === 'toi')
    const nav: [Section, string, string][] = [...(aToi ? [['toi', 'à toi', 'r'] as [Section, string, string]] : []), ['run', 'run', 'b'], ['taches', 'tâches', 't'], ['journal', complet ? 'journal (moins)' : 'journal', 'j']]
    return (
      <Box flexDirection="column">
        {p.entete.map((l, i) => (i < 2 ? <Box key={`entete-${i}`} flexDirection="row" justifyContent="center">{dessiner($, e, l, `entete-${i}-l`)}</Box> : dessiner($, e, l, `entete-${i}`)))}
        <Box key="nav" flexDirection="row" marginTop={1}>
          {nav.flatMap(([id, libelle, touche], i) => [
            ...(i ? [<Text key={`nav-entre-${id}`}>{'  '}</Text>] : []),
            <Button key={`nav-${id}`} label={libelle} hotkey={touche} plain {...(i === 0 ? { autoFocus: true as const } : {})} onPress={() => allerA($, id)} />,
          ])}
          <Text key="nav-aide" dimColor wrap="truncate">{'   · 1-9 : agir · Échap : fermer'}</Text>
        </Box>
        {p.cartes.map(c => carte($, e, c, p.bords))}
      </Box>
    )
  })
}

// Une carte : bord de sa couleur (sauf au-dessous de 60 colonnes, ou sans couleur), titre à gauche, compteur à droite
function carte($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], c: Carte, bords: boolean) {
  const { Box } = $.ui.resolve(e)
  const cadre = bords && c.couleur ? { borderStyle: 'round', borderColor: c.couleur, paddingX: 1 } : {}
  return (
    <Box key={`carte-${c.id}`} flexDirection="column" marginTop={1} {...cadre}>
      <Box key={`carte-${c.id}-haut`} flexDirection="row" justifyContent="space-between">
        {dessiner($, e, c.titre, `carte-${c.id}-titre`)}
        {c.meta.length ? dessiner($, e, c.meta, `carte-${c.id}-meta`) : null}
      </Box>
      {c.lignes.map((l, i) => dessiner($, e, l, `carte-${c.id}-${i}`))}
    </Box>
  )
}

// Défile jusqu'à une carte ; j montre aussi tout le journal, ou revient à ses dernières entrées
async function allerA($: EngineInterface, id: Section): Promise<void> {
  if (id === 'journal') await update($, journalComplet, v => !v)
  defiler($, id)
}
// Juste après l'ouverture, la carte peut ne pas être encore dessinée : un second essai un peu plus tard
function defiler($: EngineInterface, id: Section): void {
  const essai = () => $.ui.scroll({ in: PANNEAU, to: { key: `carte-${id}` }, block: 'start' })
  essai().catch(() => { void $.clock.sleep(250).then(essai).catch(() => undefined) })
}

// Le panneau, défilé jusqu'à une carte si on en nomme une. Ouvert pendant la démo, il se fermera avec elle.
async function ouvrirPanneau($: EngineInterface, inst: Instantane, vers: Section | null = null): Promise<boolean> {
  const ouvert = await $.ui.open({ id: PANNEAU, title: `Orchestre · ${inst.plan}${inst.demo ? ' (démo)' : ''}`, focus: true, closeOnEscape: true }).catch(() => null)
  if (!ouvert?.isPlaced) return false
  panneauDemo = inst.demo
  const maintenant = await $.clock.now()
  visitePrecedente = derniereOuverture
  derniereOuverture = maintenant
  if (vers) defiler($, vers)
  return true
}

// Un clic dans le bandeau : « ⤢ Détail », « à relire », « à toi »
async function ouvrirDepuisBandeau($: EngineInterface, vers: Section | null): Promise<void> {
  const inst = await read($, instantane)
  if (inst && !(await ouvrirPanneau($, inst, vers))) $.ui.toast('Le panneau ne s\'ouvre pas ici : /suivi texte donne le même état.')
}

// Une action du panneau : son texte va dans le prompt, après ce qui y est déjà tapé, et rien n'est envoyé. Pendant la
// démo, rien ne va dans le prompt : une notification dit ce que la touche ferait.
async function agir($: EngineInterface, action: Action): Promise<void> {
  const inst = await read($, instantane)
  if (inst?.demo) {
    $.ui.toast(`Démo : cette touche préparerait dans le prompt « ${court(action.prompt, 90)} ».`, { timeoutMs: DUREE_IMPORTANTE_MS })
    return
  }
  const fait = await $.prompt.fill({ text: action.prompt, mode: 'append' })
  $.ui.toast(fait.isFilled ? 'Dans le prompt : relis, complète, puis envoie. Rien n\'est parti.' : 'Le prompt n\'a pas pris le texte.')
}

// Une ligne de morceaux : un Text par morceau, dans une rangée
function dessiner($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], ligne: Ligne, cle: string) {
  const { Box, Button, Text } = $.ui.resolve(e)
  if (!ligne.length) return <Text key={cle}> </Text>
  return (
    <Box key={cle} flexDirection="row">
      {ligne.map((m, i) => {
        const vers = m.a, action = m.x
        // Une mention du bandeau mène à une carte : un bouton, en pastille ambre au survol. Une action du panneau : un
        // bouton à touche (1 à 9, l, p) qui prépare son texte dans le prompt.
        if (vers) return <Button key={`aller-${m.k ?? vers}`} label={m.t} plain hover={{ scope: `orchestre-${m.k ?? vers}`, color: 'inverseText', backgroundColor: 'warning', bold: true }} onPress={() => ouvrirDepuisBandeau($, vers)} />
        if (action) return <Button key={`action-${action.touche ?? `${cle}-${i}`}`} label={m.t} plain {...(action.touche ? { hotkey: action.touche } : {})} onPress={() => agir($, action)} />
        return <Text key={`${cle}-${i}`} color={m.c} backgroundColor={m.f} bold={m.b} dimColor={m.d} wrap="truncate">{m.t}</Text>
      })}
    </Box>
  )
}
