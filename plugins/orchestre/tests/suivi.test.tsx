// Tests du mod sous le moteur (`claude plugin test plugins/orchestre`) : un dépôt en mémoire, servi par les
// hooks du test sous le plugin ($.fs, $.session.cwd), et un suivi.json qui change entre deux lectures.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { bandeau, largeur, normaliser } from '../hooks/modele.mjs'
import { NB_PAS, instantDuPas, instantaneDemo } from '../hooks/demo.mjs'

const RACINE = '/depot'
const SUIVI = `${RACINE}/plans/demo/suivi.json`
const T0 = Date.parse('2026-10-08T12:00:00+02:00')

const tache = (id: string, phase: number, extra: object = {}) => ({ id, titre: `Tâche ${id}`, phase, lot: null, depend_de: [], modele: 'sonnet', statut: 'à-faire', essais: 0, branche: null, estimation_tokens: 1, tokens_reels: null, ajoutee_par: null, etape: null, isole: null, debut: null, fin: null, attend: [], refus: [], instables: [], non_verifiables: [], blocage: [], ...extra })
const doc = (taches: object[], extra: object = {}) => JSON.stringify({
  format: 'orchestre-suivi/1', plan: 'demo', dossier: 'plans/demo', integration: 'plan/demo', base: null, maj: '2026-10-08T11:59:00+02:00',
  taches, runs: [{ numero: 1, run_id: null, phase: 1, mode: 'auto', parallelisme: 2, corrections_max: 2, decisions_office_max: 3, statut: 'en-cours', debut: '2026-10-08T11:30:00+02:00', fin: null, detail: null, arbitrages_appliques: [], amendements_ecartes: [], taches_ajoutees: [], reportees: [], non_lancees: [], en_attente: [], en_attente_prerequis: [] }],
  points: [], decisions_office: [], relectures: [], prerequis: [], handoff: {}, lint: { ok: true, erreurs: [] }, journal: [], journal_omis: 0, ...extra,
})

// Ce que le moteur fait sous tout plugin : démarrer la session, dire son dossier, enregistrer une commande, dessiner.
// Sous le bandeau, un autre mod y dessine aussi : il doit rester visible.
function bas(on: On, commande: 'ok' | 'pris' = 'ok') {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.attach', ($, e) => ({ clientId: e.clientId }))
  on('classic.SessionStart', () => ({}))
  on('session.cwd', () => ({ value: RACINE }))
  on('command.register', ($, e) => (commande === 'pris' ? { deny: `"/${e.name}" refused: another plugin registered it` } : { value: { command: e.name } }))
  on('ui.render', ($, e) => { const { Box, Text } = $.ui.resolve(e); return e.component === 'AbovePrompt' ? <Text>bandeau d'un autre mod</Text> : <Box /> })
  on('prompt.submit', ($, e) => ({ text: e.text }))
}

// Le monde sous le plugin : un fichier suivi.json qu'on remplace, les appels d'interface notés
function monde(on: On, commande: 'ok' | 'pris' = 'ok') {
  const fichier = { texte: doc([tache('T01', 1, { etape: 'worker', isole: true, debut: '2026-10-08T11:31:00+02:00' }), tache('T02', 1), tache('T03', 2)]), mtime: 1 }
  const toasts: string[] = [], ouverts: string[] = [], remplis: string[] = [], fermes: string[] = [], statuts: (string | undefined)[] = [], sons: string[] = []
  bas(on, commande)
  on('ui.status', ($, e) => { statuts.push(e.text); return { value: undefined } })
  on('audio.play', ($, e) => { sons.push('asset' in e.clip ? String(e.clip.asset) : '?'); return { value: undefined } })
  on('fs.exists', ($, e) => ({ value: e.path === `${RACINE}/plans` || e.path === SUIVI }))
  on('fs.list', () => ({ value: [{ name: 'demo', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }, { name: 'LISEZMOI.md', kind: 'file' as const, size: 3, mtimeMs: 0, isLink: false }] }))
  on('fs.stat', ($, e) => (e.path === SUIVI ? { value: { kind: 'file' as const, size: fichier.texte.length, mtimeMs: fichier.mtime, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', ($, e) => (e.path === SUIVI ? { value: fichier.texte } : { deny: 'ENOENT' }))
  on('ui.toast', ($, e) => { toasts.push(e.text + (e.timeoutMs ? ` (${e.timeoutMs} ms)` : '')); return { value: undefined } })
  on('ui.open', ($, e) => { ouverts.push(e.id + (e.closeOnEscape ? ' (Échap ferme)' : '')); return { value: { isPlaced: true as const } } })
  on('ui.close', ($, e) => { fermes.push(e.id); return { value: undefined } })
  on('prompt.fill', ($, e) => { remplis.push(`${e.mode}:${e.text}`); return { isFilled: true } })
  return { fichier, toasts, ouverts, remplis, fermes, statuts, sons }
}

// La tête du bandeau pendant un run : une roue qui tourne
const ROUE = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] $/

const BAND = { component: 'AbovePrompt' as const, props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 9 }, view: {} } }
const PANE = { component: 'Pane' as const, requestId: 'orchestre', props: { title: 'Orchestre', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} } }

// Une minute d'animation à 150 ms : quelques secondes de dessins sous le kit
test('bandeau, /suivi et notifications pendant un run, sur le terminal et le bureau', { timeoutMs: 20000 }, async ($, on) => {
  const horloge = mock.clock(on, { now: T0 })
  const w = monde(on)
  await $.session.start({ cwd: RACINE, surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'orchestre', surface, ...BAND })
    expect(await ui.find({ text: ROUE })).toBeDefined()
    expect(await ui.find({ text: /0\/3/ })).toBeDefined()
    expect(await ui.find({ text: /◐ T01 / })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'réalisation' }))?.props.color).toBe('suggestion')
    expect((await ui.find({ type: 'Text', text: /^█+$/ }))?.props.color).toBe('suggestion')
    expect(await ui.find({ text: /⏱ 30 min/ })).toBeDefined()
    expect(await ui.find({ text: /bandeau d'un autre mod/ })).toBeDefined()
    await ui.unmount()
  }
  // Sans écriture de suivi.json, le bandeau déjà affiché se redessine à chaque image : la roue tourne, la durée avance
  const affiche = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  // La roue tourne d'une image à l'autre, sans écriture de suivi.json
  const image = async () => String((await affiche.find({ text: ROUE }))?.children?.[0] ?? '')
  const avant = await image()
  await horloge.advance(150)
  expect(await image()).not.toBe(avant)
  await horloge.advance(60000)
  expect(await affiche.find({ text: /⏱ 31 min/ })).toBeDefined()
  await affiche.unmount()
  const texte = await $.command.run({ command: 'suivi', args: 'texte', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  expect(texte.text ?? '').toMatch(/^▶ demo {2}◉○/)
  // T01 fusionnée, T02 attend un humain : deux notifications à la lecture suivante
  w.fichier.texte = doc([tache('T01', 1, { statut: 'fusionnée', essais: 1 }), tache('T02', 1, { statut: 'besoin-humain', blocage: ['secret'] }), tache('T03', 2)])
  w.fichier.mtime = 2
  await horloge.advance(2100)
  expect(w.toasts).toEqual(['⚑ T02 attend un humain (15000 ms)'])
})

// Run 1 arrêté sur un point humain de T02, une relecture et une décision d'office de T01
const ARRET = doc([tache('T01', 1, { statut: 'fusionnée', essais: 2 }), tache('T02', 1, { statut: 'besoin-humain', blocage: ['secret manquant'] })], {
  runs: [{ numero: 1, run_id: null, phase: 1, mode: 'phase', parallelisme: 2, corrections_max: 2, decisions_office_max: 3, statut: 'arbitrage', debut: '2026-10-08T11:30:00+02:00', fin: '2026-10-08T11:50:00+02:00', detail: null, arbitrages_appliques: [], amendements_ecartes: [], taches_ajoutees: [], reportees: [], non_lancees: [], en_attente: ['T02'], en_attente_prerequis: [] }],
  points: [{ tache: 'T02', titre: 'Secret manquant', humain: true, role: 'arret', statut: 'a-trancher' }],
  relectures: [{ tache: 'T01', phase: 1, texte: '.env.example : ajouter MR_MAX', run: 1, quand: '2026-10-08T11:40:00+02:00' }],
  decisions_office: [{ run: 1, tache: 'T01', titre: 'Seuil', option: 'A', description: 'plafond à 30 s' }],
})

test('panneau /suivi : une vue en cartes, ses touches, ses actions préparées dans le prompt', async ($, on) => {
  const horloge = mock.clock(on, { now: T0 })
  const w = monde(on)
  w.fichier.texte = ARRET
  await $.session.start({ cwd: RACINE, surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'suivi', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
  expect(r.text ?? '').toMatch(/ouvert dans le panneau/)
  expect(w.ouverts).toEqual(['orchestre (Échap ferme)'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'orchestre', surface, ...PANE })
    // En tête, l'état global ; puis les touches qui font défiler, le focus sur la première
    expect(await ui.find({ type: 'Text', text: ' ⚠ 1 À TOI ' })).toBeDefined()
    const nav = (id: string) => ui.find({ type: 'Button', key: `nav-${id}` })
    for (const [id, touche] of [['toi', 'r'], ['run', 'b'], ['taches', 't'], ['journal', 'j']] as const) expect((await nav(id))?.props.hotkey).toBe(touche)
    expect((await nav('toi'))?.props.autoFocus).toBe(true)
    expect(await ui.find({ type: 'Text', text: /· 1-9 : agir · Échap : fermer$/ })).toBeDefined()
    // Les cartes, dans l'ordre, avec leur bord : À toi en ambre, le run arrêté en ambre aussi
    expect((await ui.find({ type: 'Text', text: '⚠ À toi' }))?.props.color).toBe('warning')
    expect(await ui.find({ type: 'Text', text: /^■ Run 1 · phase 1 · arrêt par phase$/ })).toBeDefined()
    expect((await ui.find({ key: 'carte-toi' }))?.props.borderStyle).toBe('round')
    expect((await ui.find({ key: 'carte-run' }))?.props.borderColor).toBe('warning')
    expect((await ui.find({ key: 'carte-taches' }))?.props.borderStyle).toBeUndefined()
    // Une touche par ligne de « À toi » ; la suite du run sur l
    const action = (k: string) => ui.find({ type: 'Button', key: `action-${k}` })
    expect([(await action('1'))?.props.label, (await action('1'))?.props.hotkey]).toEqual(['T02 · Secret manquant (humain)', '1'])
    expect((await action('2'))?.props.label).toBe('T01 · .env.example : ajouter MR_MAX')
    expect((await action('3'))?.props.label).toBe('T01 · Seuil : A (plafond à 30 s)')
    expect((await action('l'))?.props.label).toBe('/orchestre:lancer plans/demo --reprendre')
    await ui.press({ key: 'action-1' })
    await ui.press({ key: 'action-2' })
    // j : tout le journal, et le panneau défile jusqu'à lui
    await ui.press({ key: 'nav-journal' })
    expect((await nav('journal'))?.props.label).toBe('journal (moins)')
    await ui.press({ key: 'nav-journal' })
    await ui.unmount()
  }
  expect(w.remplis).toEqual([
    'append:/orchestre:lancer plans/demo --reprendre', 'append:Relis avec moi, avant la PR (relecture de T01) : .env.example : ajouter MR_MAX',
    'append:/orchestre:lancer plans/demo --reprendre', 'append:Relis avec moi, avant la PR (relecture de T01) : .env.example : ajouter MR_MAX',
  ])
  // Le défilement vers une carte ($.ui.scroll) demande la mise en page du moteur, que le kit de test n'a pas
  expect(w.toasts.filter(t => /^Dans le prompt : relis, complète, puis envoie/.test(t)).length).toBe(4)
  // Étroit : plus de bords
  const etroit = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 50 } })
  expect((await etroit.find({ key: 'carte-run' }))?.props.borderStyle).toBeUndefined()
  await etroit.unmount()
  // Plan terminé : la suite est le brouillon de PR, sur p
  w.fichier.texte = doc([tache('T01', 1, { statut: 'fusionnée', essais: 2 }), tache('T02', 1, { statut: 'fusionnée', essais: 1 })], {
    runs: [{ numero: 2, run_id: null, phase: 1, mode: 'auto', parallelisme: 2, corrections_max: 2, decisions_office_max: 3, statut: 'terminé', debut: '2026-10-08T11:52:00+02:00', fin: '2026-10-08T11:58:00+02:00', detail: null, arbitrages_appliques: [], amendements_ecartes: [], taches_ajoutees: [], reportees: [], non_lancees: [], en_attente: [], en_attente_prerequis: [] }],
    relectures: [{ tache: 'T01', phase: 1, texte: '.env.example : ajouter MR_MAX', run: 1, quand: '2026-10-08T11:40:00+02:00' }],
  })
  w.fichier.mtime = 2
  await horloge.advance(2100)
  const fin = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...PANE })
  expect(await fin.find({ type: 'Text', text: '⚑ À relire avant la PR' })).toBeDefined()
  await fin.press({ key: 'action-p' })
  await fin.unmount()
  expect(w.remplis.at(-1) ?? '').toMatch(/^append:Plan demo : 2\/2 tâches fusionnées[\s\S]*- T01 : \.env\.example : ajouter MR_MAX/)
})

// 0.11.0 : un suivi.json au format /2, avec le modèle prévu et le modèle utilisé de chaque tâche
const MODELES = doc([
  tache('T01', 1, { etape: 'correction', isole: true, essais: 2, debut: '2026-10-08T11:31:00+02:00', modele_utilise: 'opus' }),
  tache('T02', 1, { etape: 'worker', isole: true, debut: '2026-10-08T11:32:00+02:00', modele_utilise: 'sonnet' }),
  tache('T03', 1, { modele: 'haiku', modele_utilise: null }),
], {
  format: 'orchestre-suivi/2',
  journal: [
    { quand: '2026-10-08T11:31:00+02:00', genre: 'tache', tache: 'T01', texte: 'T01 démarre (worktree)' },
    { quand: '2026-10-08T11:40:00+02:00', genre: 'refus', tache: 'T01', texte: 'T01 : essai 1 refusé (évaluation) : 1 manque(s)' },
    { quand: '2026-10-08T11:40:00+02:00', genre: 'modele', tache: 'T01', texte: "T01 : sonnet → opus (manque d'architecture)" },
    { quand: '2026-10-08T11:40:00+02:00', genre: 'etape', tache: 'T01', texte: 'T01 : correction (essai 2)' },
  ],
})

test('cartes des tâches : le modèle utilisé, « prévu → utilisé » quand ils diffèrent, le prévu avant le worker ; changements au journal (0.11.0)', async ($, on) => {
  mock.clock(on, { now: T0 })
  const w = monde(on)
  w.fichier.texte = MODELES
  await $.session.start({ cwd: RACINE, surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'suivi', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
  expect(r.text ?? '').toMatch(/ouvert dans le panneau/)
  expect(w.toasts.filter(t => /au format/.test(t))).toEqual([])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'orchestre', surface, ...PANE })
    // T01 : prévu sonnet, corrigée sur opus ; T02 : sonnet, comme prévu ; T03 : haiku prévu, pas encore lancée
    const utilise = await ui.find({ type: 'Text', text: /^opus$/ })
    expect([utilise?.props.color, utilise?.props.bold]).toEqual(['merged', true])
    expect((await ui.find({ type: 'Text', text: /^sonnet → $/ }))?.props.dimColor).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^sonnet$/ }))?.props.color).toBe('subtle')
    expect((await ui.find({ type: 'Text', text: /^haiku$/ }))?.props.dimColor).toBe(true)
    // Le journal : le changement de modèle, avec son glyphe
    await ui.press({ key: 'nav-journal' })
    expect((await ui.find({ type: 'Text', text: /^⇄$/ }))?.props.color).toBe('merged')
    expect(await ui.find({ type: 'Text', text: /T01 : sonnet → opus \(manque d'architecture\)/ })).toBeDefined()
    await ui.press({ key: 'nav-journal' })
    await ui.unmount()
  }
  const texte = await $.command.run({ command: 'suivi', args: 'texte', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  expect(texte.text ?? '').toMatch(/T01 .*sonnet → opus/)
  expect(texte.text ?? '').toMatch(/T03 .*haiku/)
  // Un format que ce mod ne lit pas : dit une fois, rien d'autre
  w.fichier.texte = MODELES.replace('"orchestre-suivi/2"', '"orchestre-suivi/3"')
  w.fichier.mtime = 2
  await $.command.run({ command: 'suivi', args: 'texte', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  expect(w.toasts.filter(t => /au format/.test(t))).toEqual(['plans/demo/suivi.json est au format orchestre-suivi/3 ; ce mod lit orchestre-suivi/1 et orchestre-suivi/2. Mets à jour le plugin orchestre. (15000 ms)'])
})

test('rien à suivre : pas de bandeau, /suivi le dit ; une session hébergée attend sa surface, un -p ne lit rien', async ($, on) => {
  mock.clock(on, { now: T0 })
  const lus: string[] = []
  bas(on)
  on('fs.exists', ($, e) => { lus.push(e.path); return { value: false } })
  on('fs.read', ($, e) => { lus.push(e.path); return { deny: 'ENOENT' } })
  await $.session.start({ cwd: RACINE, surface: null, isInteractive: false })
  expect(lus).toEqual([])
  // L'app de bureau héberge la session sans surface au démarrage, puis s'y connecte
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(lus.length).toBeGreaterThan(0)
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /▶/ })).toBeUndefined()
  expect(await ui.find({ text: /bandeau d'un autre mod/ })).toBeDefined()
  await ui.unmount()
  const r = await $.command.run({ command: 'suivi', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never)
  expect(r.text ?? '').toMatch(/aucun plans\/<nom>\/suivi\.json/)
})

test('une session de bureau non interactive au démarrage est suivie', async ($, on) => {
  mock.clock(on, { now: T0 })
  const lus: string[] = []
  bas(on)
  on('fs.exists', ($, e) => { lus.push(e.path); return { value: false } })
  await $.session.start({ cwd: RACINE, surface: 'desktop', isInteractive: false })
  expect(lus.length).toBeGreaterThan(0)
})

// $.state tenu par le test, pour simuler /clear, /resume et /branch : toutes les valeurs reviennent à leur défaut
function etat(on: On) {
  const valeurs = new Map<string, { value: unknown; version: number }>()
  on('state.get', ($, e) => ({ value: valeurs.get(e.key) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', ($, e) => {
    const avant = valeurs.get(e.key)?.version ?? 0
    if (e.ifVersion != null && e.ifVersion !== avant) return { value: { isSet: false, version: avant } } as never
    valeurs.set(e.key, { value: e.value, version: avant + 1 })
    return { value: { isSet: true, version: avant + 1 } } as never
  })
  return { effacer: () => valeurs.clear(), poser: (key: string, value: unknown) => { valeurs.set(key, { value, version: 1 }) } }
}

const FINI = doc([tache('T01', 1, { statut: 'fusionnée', essais: 1 }), tache('T02', 1, { statut: 'besoin-humain', blocage: ['secret'] })], {
  runs: [{ numero: 1, run_id: null, phase: 1, mode: 'phase', parallelisme: 2, corrections_max: 2, decisions_office_max: 3, statut: 'arbitrage', debut: '2026-10-08T11:30:00+02:00', fin: '2026-10-08T11:50:00+02:00', detail: null, arbitrages_appliques: [], amendements_ecartes: [], taches_ajoutees: [], reportees: [], non_lancees: [], en_attente: ['T02'], en_attente_prerequis: [] }],
  relectures: [{ tache: 'T01', phase: 1, texte: '.env.example : ajouter MR_MAX', run: 1, quand: '2026-10-08T11:40:00+02:00' }],
})

test('fin de run : « ✕ Masquer » se clique, sans touche, place des boutons gardée, masqué encore après /clear', async ($, on) => {
  mock.clock(on, { now: T0 })
  const memoire = etat(on)
  const w = monde(on)
  w.fichier.texte = FINI
  await $.session.start({ cwd: RACINE, surface: 'terminal', isInteractive: true })
  // Une largeur où les libellés tiennent avec « ⤢ Détail » seul (11 cellules), pas avec « ✕ Masquer » en plus (21)
  const inst = normaliser(JSON.parse(FINI))!
  const relire = (colonnes: number, reserve: number) => bandeau(inst, T0, colonnes, reserve)!.find(m => m.k === 'relire')?.t
  let colonnes = largeur(bandeau(inst, T0, 1000)!) + 21
  while (colonnes > 40 && !(relire(colonnes, 21) === '1' && relire(colonnes, 11) === '1 à relire')) colonnes--
  expect([relire(colonnes, 21), relire(colonnes, 11)]).toEqual(['1', '1 à relire'])
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: colonnes } })
  expect(await ui.find({ text: /■ / })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'aller-relire' }))?.props.label).toBe('1')
  // Deux boutons à cliquer, avec leur icône, sans touche
  const detail = await ui.find({ key: 'detail' }), bouton = await ui.find({ key: 'masquer' })
  expect([detail?.props.label, detail?.props.hotkey, bouton?.props.label, bouton?.props.hotkey]).toEqual(['⤢ Détail', undefined, '✕ Masquer', undefined])
  expect(w.statuts).toEqual([])
  await ui.press({ key: 'masquer' })
  await ui.unmount()
  // Masqué, le bandeau laisse une trace dans la ligne d'état : il reste une relecture et une tâche qui attend
  expect(w.statuts).toEqual(['orchestre ■ 1/2 · ⚑ 1 · ⚠ 1'])
  const masque = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await masque.find({ text: /■ / })).toBeUndefined()
  expect(await masque.find({ text: /bandeau d'un autre mod/ })).toBeDefined()
  await masque.unmount()
  // /clear remet $.state à zéro sans relancer session.start : le choix revient avec classic.SessionStart
  memoire.effacer()
  await $.classic.SessionStart({ source: 'clear' } as never)
  const apres = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await apres.find({ text: /■ / })).toBeUndefined()
  await apres.unmount()
})

test('bandeau : « à relire » et « à toi » ouvrent le panneau sur la carte « À toi », « Détail » en haut', async ($, on) => {
  mock.clock(on, { now: T0 })
  const w = monde(on)
  w.fichier.texte = FINI
  await $.session.start({ cwd: RACINE, surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'orchestre', surface, ...BAND })
    // Le glyphe garde sa couleur ; la mention est un bouton (le kit ne rend pas le style de survol)
    expect((await ui.find({ type: 'Text', text: '⚠ ' }))?.props.color).toBe('warning')
    expect((await ui.find({ type: 'Button', key: 'aller-toi' }))?.props.label).toBe('1 à toi')
    expect((await ui.find({ type: 'Button', key: 'aller-relire' }))?.props.label).toBe('1 à relire')
    expect((await ui.find({ type: 'Button', key: 'detail' }))?.props.label).toBe('⤢ Détail')
    await ui.press({ key: 'aller-toi' })
    await ui.press({ key: 'aller-relire' })
    await ui.press({ key: 'detail' })
    await ui.unmount()
  }
  expect(w.ouverts).toEqual(Array(6).fill('orchestre (Échap ferme)'))
})

test('notifications : seul ce qui demande quelqu\'un, avec un son après /suivi son', async ($, on) => {
  const horloge = mock.clock(on, { now: T0 })
  mock.store(on)
  const w = monde(on)
  await $.session.start({ cwd: RACINE, surface: 'terminal', isInteractive: true })
  expect((await $.command.run(CMD('son'))).text ?? '').toMatch(/son activé/)
  // T01 fusionnée et une relecture (pas de notification), T02 attend un humain (notification et son)
  w.fichier.texte = doc([tache('T01', 1, { statut: 'fusionnée', essais: 1 }), tache('T02', 1, { statut: 'besoin-humain', blocage: ['secret'] }), tache('T03', 2)], { relectures: [{ tache: 'T01', phase: 1, texte: 'x', run: 1, quand: '2026-10-08T11:59:00+02:00' }] })
  w.fichier.mtime = 2
  await horloge.advance(2100)
  expect(w.toasts).toEqual(['⚑ T02 attend un humain (15000 ms)'])
  expect(w.sons).toEqual(['sons/attend.wav'])
  expect((await $.command.run(CMD('son'))).text ?? '').toMatch(/son coupé/)
  w.fichier.texte = doc([tache('T01', 1, { statut: 'fusionnée', essais: 1 }), tache('T02', 1, { statut: 'besoin-humain', blocage: ['secret'] }), tache('T03', 2, { statut: 'bloquée' })])
  w.fichier.mtime = 3
  await horloge.advance(2100)
  expect(w.toasts.at(-1)).toBe('✗ T03 bloquée (15000 ms)')
  expect(w.sons).toEqual(['sons/attend.wav'])
})

test('retour après 15 min sans prompt : une notification dit ce qui a changé', { timeoutMs: 60000 }, async ($, on) => {
  const horloge = mock.clock(on, { now: T0 })
  const w = monde(on)
  await $.session.start({ cwd: RACINE, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'lance le run' } as never)
  await $.command.run(CMD(''))
  expect(w.toasts).toEqual([])
  // Pendant l'absence : T01 fusionnée, T02 se met à attendre
  const q = (min: number) => new Date(T0 + min * 60000).toISOString()
  // Un run fini : 16 minutes d'horloge sans animation à dessiner
  w.fichier.texte = doc([tache('T01', 1, { statut: 'fusionnée', essais: 1, fin: q(5) }), tache('T02', 1, { statut: 'besoin-humain', blocage: ['secret'], fin: q(9) }), tache('T03', 2)], { runs: [{ numero: 1, run_id: null, phase: 1, mode: 'auto', parallelisme: 2, corrections_max: 2, decisions_office_max: 3, statut: 'arbitrage', debut: q(-30), fin: q(10), detail: null, arbitrages_appliques: [], amendements_ecartes: [], taches_ajoutees: [], reportees: [], non_lancees: [], en_attente: [], en_attente_prerequis: [] }], journal: [
    { quand: q(5), genre: 'statut', tache: 'T01', texte: 'T01 : fusionnée (1 essai)' },
    { quand: q(9), genre: 'statut', tache: 'T02', texte: 'T02 : besoin-humain (1 essai) — secret' },
  ] })
  w.fichier.mtime = 2
  await horloge.advance(16 * 60000)
  const avant = w.toasts.length
  await $.prompt.submit({ text: 'où en est-on ?' } as never)
  expect(w.toasts.slice(avant)).toEqual(['↩ Depuis 16 min : ✓ T01 fusionnée · ⚠ T02 t\'attend (15000 ms)'])
  // Un prompt peu après, même avec du nouveau dans le journal : rien
  w.fichier.texte = w.fichier.texte.replace('"journal":[', `"journal":[{"quand":"${q(16.5)}","genre":"statut","tache":"T03","texte":"T03 : fusionnée (1 essai)"},`)
  w.fichier.mtime = 3
  await horloge.advance(60000)
  await $.prompt.submit({ text: 'merci' } as never)
  expect(w.toasts.length).toBe(avant + 1)
  // Le panneau rouvert dit en tête ce qui a changé depuis sa dernière ouverture
  await $.command.run(CMD(''))
  const p = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...PANE })
  expect(await p.find({ type: 'Text', text: 'Depuis 17 min' })).toBeDefined()
  expect(await p.find({ type: 'Text', text: "⚠ T02 t'attend" })).toBeDefined()
  await p.unmount()
})

test('/suivi déjà pris par un autre plugin : le suivi démarre quand même et le dit', async ($, on) => {
  mock.clock(on, { now: T0 })
  const w = monde(on, 'pris')
  await $.session.start({ cwd: RACINE, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: ROUE })).toBeDefined()
  await ui.unmount()
  expect(w.toasts.some(t => t.startsWith("orchestre : /suivi n'a pas pu être ajoutée"))).toBe(true)
})

test('après /clear : le plan choisi par /suivi plans/<nom> revient, et suivi.json est relu sans attendre', async ($, on) => {
  mock.clock(on, { now: T0 })
  const memoire = etat(on)
  const AUTRE = `${RACINE}/plans/autre/suivi.json`
  const fichiers: Record<string, { texte: string; mtime: number }> = {
    [SUIVI]: { texte: doc([tache('T01', 1, { etape: 'worker', isole: true })]), mtime: 2 },
    [AUTRE]: { texte: doc([tache('A01', 1, { etape: 'worker', isole: true })], { plan: 'autre', dossier: 'plans/autre' }), mtime: 1 },
  }
  bas(on)
  on('fs.exists', ($, e) => ({ value: e.path === `${RACINE}/plans` || e.path in fichiers }))
  on('fs.list', () => ({ value: ['demo', 'autre'].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }))
  on('fs.stat', ($, e) => { const f = fichiers[e.path]; return f ? { value: { kind: 'file' as const, size: f.texte.length, mtimeMs: f.mtime, isLink: false } } : { deny: 'ENOENT' } })
  on('fs.read', ($, e) => { const f = fichiers[e.path]; return f ? { value: f.texte } : { deny: 'ENOENT' } })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: RACINE, surface: 'terminal', isInteractive: true })
  const choix = await $.command.run({ command: 'suivi', args: 'plans/autre texte', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as never)
  expect(choix.text ?? '').toMatch(/^▶ autre /)
  // Ce que /clear laisse : $.state à ses valeurs par défaut, le minuteur toujours là mais pas encore passé
  memoire.effacer()
  await $.classic.SessionStart({ source: 'clear' } as never)
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: ROUE })).toBeDefined()
  expect(await ui.find({ text: /^autre$/ })).toBeDefined()
  await ui.unmount()
})

test('run resté « en-cours » sans nouvelles : plus d\'animation, mais son âge avance toutes les 30 s', async ($, on) => {
  const horloge = mock.clock(on, { now: T0 })
  const w = monde(on)
  w.fichier.texte = doc([tache('T01', 1, { etape: 'worker', isole: true, debut: '2026-10-08T11:05:00+02:00' })], { maj: '2026-10-08T11:10:00+02:00' })
  await $.session.start({ cwd: RACINE, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /^◌ $/ })).toBeDefined()
  expect(await ui.find({ text: /sans nouvelles depuis 50 min/ })).toBeDefined()
  await horloge.advance(61000)
  expect(await ui.find({ text: /sans nouvelles depuis 51 min/ })).toBeDefined()
  await ui.unmount()
})

const CMD = (args: string) => ({ command: 'suivi', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as never

test('/suivi demo, sans dépôt : un run joué en mémoire, marqué DÉMO, ses notifications, puis retour au vrai suivi', { timeoutMs: 30000 }, async ($, on) => {
  const horloge = mock.clock(on, { now: T0 })
  const toasts: string[] = [], lus: string[] = [], ouverts: string[] = [], fermes: string[] = [], remplis: string[] = []
  bas(on)
  on('prompt.fill', ($, e) => { remplis.push(e.text); return { isFilled: true } })
  on('fs.exists', ($, e) => { lus.push(e.path); return { value: false } })
  on('ui.toast', ($, e) => { toasts.push(e.text + (e.timeoutMs ? ` (${e.timeoutMs} ms)` : '')); return { value: undefined } })
  on('ui.open', ($, e) => { ouverts.push(e.title ?? ''); return { value: { isPlaced: true as const } } })
  on('ui.close', ($, e) => { fermes.push(e.id); return { value: undefined } })
  await $.session.start({ cwd: RACINE, surface: 'terminal', isInteractive: true })
  const r = await $.command.run(CMD('demo'))
  expect(r.text ?? '').toMatch(/^Démo lancée/)
  expect((await $.command.run(CMD(''))).text ?? '').toMatch(/ouvert dans le panneau/)
  expect(ouverts).toEqual(['Orchestre · site-vitrine (démo)'])
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect((await ui.find({ type: 'Text', text: ' DÉMO ' }))?.props.backgroundColor).toBe('merged')
  expect(await ui.find({ text: /^site-vitrine$/ })).toBeDefined()
  expect(await ui.find({ text: ROUE })).toBeDefined()
  expect((await $.command.run(CMD('texte'))).text ?? '').toMatch(/^▶  DÉMO  site-vitrine/)
  // Pendant la démo, aucun suivi.json n'est cherché
  const avant = lus.length
  await horloge.advance(instantDuPas(NB_PAS - 1, 0) + 500)
  expect(lus.length).toBe(avant)
  expect(await ui.find({ text: /^✓ $/ })).toBeDefined()
  // Seul ce qui demande quelqu'un devient une notification
  expect(toasts).toContain('⚑ T03 attend un humain (15000 ms)')
  expect(toasts).toContain('Run arrêté : T03, Clé SMTP de test (15000 ms)')
  expect(toasts).not.toContain('Phase 1 terminée')
  expect(toasts.some(t => t.startsWith('Run 2 (phases 1 à 2) : terminé'))).toBe(false)
  expect(toasts.at(-1) ?? '').toMatch(/^Démo terminée/)
  await ui.unmount()
  // Dans la démo, une action du panneau dit ce qu'elle ferait, sans rien mettre dans le prompt
  const p = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...PANE })
  expect(await p.find({ type: 'Text', text: /^pas 21\/21 · Fin du run 2 : terminé$/ })).toBeDefined()
  expect((await p.find({ type: 'Text', text: ' DÉMO ' }))?.props.backgroundColor).toBe('merged')
  await p.press({ key: 'action-p' })
  await p.unmount()
  expect(remplis).toEqual([])
  expect(toasts.at(-1) ?? '').toMatch(/^Démo : cette touche préparerait dans le prompt « Plan site-vitrine : 5\/5 tâches fusionnées/)
  // Une minute après la fin, le vrai suivi reprend : ici, rien à suivre ; le panneau de la démo se ferme
  expect(fermes).toEqual([])
  await horloge.advance(60000)
  expect(lus.length).toBeGreaterThan(avant)
  expect(fermes).toEqual(['orchestre'])
  const vide = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...PANE })
  expect(await vide.find({ type: 'Text', text: /^Rien à suivre dans ce dépôt : aucun plans\/<nom>\/suivi\.json\. .*\/suivi demo joue la démo\.$/ })).toBeDefined()
  await vide.unmount()
  const apres = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await apres.find({ type: 'Text', text: ' DÉMO ' })).toBeUndefined()
  await apres.unmount()
})

test('/suivi demo dans un dépôt suivi : le vrai plan attend, /suivi auto y revient', async ($, on) => {
  const horloge = mock.clock(on, { now: T0 })
  const w = monde(on)
  await $.session.start({ cwd: RACINE, surface: 'terminal', isInteractive: true })
  await $.command.run(CMD('demo'))
  // suivi.json change pendant la démo : rien n'est lu, aucune notification du vrai plan
  w.fichier.texte = doc([tache('T01', 1, { statut: 'fusionnée', essais: 1 }), tache('T02', 1, { statut: 'besoin-humain', blocage: ['secret'] }), tache('T03', 2)])
  w.fichier.mtime = 2
  await horloge.advance(2100)
  expect(w.toasts.some(t => t.includes('T02 attend'))).toBe(false)
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /^site-vitrine$/ })).toBeDefined()
  await ui.unmount()
  // Le panneau ouvert pendant la démo se ferme quand on revient au vrai suivi ; un panneau ouvert hors démo, non
  await $.command.run(CMD(''))
  expect(w.fermes).toEqual([])
  expect((await $.command.run(CMD('auto texte'))).text ?? '').toMatch(/^▶ demo {2}/)
  expect(w.fermes).toEqual(['orchestre'])
  await $.command.run(CMD(''))
  await $.command.run(CMD('auto'))
  expect(w.fermes).toEqual(['orchestre'])
  const vrai = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await vrai.find({ type: 'Text', text: ' DÉMO ' })).toBeUndefined()
  expect(await vrai.find({ text: /^demo$/ })).toBeDefined()
  await vrai.unmount()
})

test('« Masquer » pendant la démo ne masque pas le vrai run de même numéro', async ($, on) => {
  const horloge = mock.clock(on, { now: T0 })
  const w = monde(on)
  w.fichier.texte = FINI
  await $.session.start({ cwd: RACINE, surface: 'terminal', isInteractive: true })
  // Un panneau ouvert avant la démo reste ouvert quand elle rend la main
  await $.command.run(CMD(''))
  await $.command.run(CMD('demo'))
  // Le run 1 de la démo s'arrête sur son arbitrage : on le masque
  await horloge.advance(instantDuPas(11, 0) + 100)
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /^site-vitrine$/ })).toBeDefined()
  await ui.press({ key: 'masquer' })
  await ui.unmount()
  await $.command.run(CMD('auto'))
  expect(w.fermes).toEqual([])
  const vrai = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await vrai.find({ text: /^■ $/ })).toBeDefined()
  expect(await vrai.find({ text: /^demo$/ })).toBeDefined()
  await vrai.unmount()
})

test('rechargement du mod en pleine démo, sans rien à suivre : la démo figée s\'efface', async ($, on) => {
  mock.clock(on, { now: T0 })
  const memoire = etat(on)
  bas(on)
  on('fs.exists', () => ({ value: false }))
  // Ce que $.state garde d'avant le rechargement : la dernière image de la démo
  memoire.poser('instantane', instantaneDemo(5, T0 - 20000))
  await $.session.start({ cwd: RACINE, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: ' DÉMO ' })).toBeUndefined()
  await ui.unmount()
})
