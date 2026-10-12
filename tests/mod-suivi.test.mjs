// Tests du modèle du mod de suivi d'orchestre (plugins/orchestre/hooks/modele.mjs et demo.mjs) sur des suivi.json écrits par le
// vrai scripts/suivi.mjs dans un dépôt git temporaire. Les hooks eux-mêmes se testent par `claude plugin test`.
// Usage : node tests/mod-suivi.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import * as M from '../plugins/orchestre/hooks/modele.mjs'
import * as D from '../plugins/orchestre/hooks/demo.mjs'

const PROGRESS = resolve('plugins/orchestre/scripts/suivi.mjs')
const repoRoot = mkdtempSync(join(tmpdir(), 'mod-suivi-'))
const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const d = join(repoRoot, 'plans', 'demo')
const task = (id, phase, depend_de = []) => `---\nid: ${id}\ntitre: Tâche ${id} au titre long du frontmatter\nphase: ${phase}\nmodele: sonnet\ndepend_de: [${depend_de.join(', ')}]\nfichiers_possedes:\n  - src/${id}/**\nressources: []\nestimation_tokens: 1.0M\nverification:\n  - "npm test"\ndefinition_du_fini:\n  - "le test passe"\n---\n`
const suivi = (cmd, E) => {
  const r = spawnSync(process.execPath, [PROGRESS, cmd, 'plans/demo', '--json', JSON.stringify(E)], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(r.status, 0, `${cmd} : ${r.stderr}`)
}
const readFile = () => M.normalize(JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8')))
const text = lines => lines.map(M.plainText).join('\n')
let n = 0
const testCase = (name, fn) => { fn(); n++; console.log('ok ·', name) }
/** @type {string[]} */
let scriptNotifications = []

try {
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(repoRoot, 'README.md'), 'x\n'); git('add', '.'); git('commit', '-qm', 'init')
  mkdirSync(join(d, 'taches'), { recursive: true })
  const T = [['T01', 1], ['T02', 1], ['T03', 2, ['T01']], ['T04', 2, ['T02', 'T03']]]
  for (const [id, ph, dep] of T) writeFileSync(join(d, 'taches', `${id}-x.md`), task(id, ph, dep))
  writeFileSync(join(d, 'SUIVI.md'), `# SUIVI — demo\n\n| ID | Titre | Phase | Lot | Dépend de | Modèle | Statut | Essais | Branche | Tokens est. / réels |\n|----|----|----|----|----|----|----|----|----|----|\n${T.map(([id, ph]) => `| ${id} | Tâche ${id} | ${ph} | — | — | sonnet | à-faire | 0 | — | 1,0 M / — |`).join('\n')}\n\nStatuts : à-faire · ajoutée · fusionnée · bloquée · échec · besoin-humain · annulée\n`)
  writeFileSync(join(d, 'HANDOFF.md'), '# HANDOFF — demo\n')
  writeFileSync(join(d, 'orchestre.config.json'), JSON.stringify({ branche_integration: 'plan/demo' }))
  git('switch', '-qc', 'plan/demo'); git('add', '.'); git('commit', '-qm', 'plan')

  suivi('debut-run', { phase: 1, mode: 'auto', parallelisme: 2, corrections_max: 2, decisions_office_max: 3 })
  suivi('etape', { tache: 'T01', etape: 'worker', isole: true })
  suivi('etape', { tache: 'T02', etape: 'vérification', isole: true })
  const A = readFile()
  const tA = Date.parse(JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8')).maj) + 90000

  testCase('format : orchestre-suivi/2 écrit par suivi.mjs, /1 d\'avant la 0.11.0 lu aussi, un autre format refusé sans deviner', () => {
    assert.ok(A); assert.equal(A.plan, 'demo'); assert.equal(A.tasks.length, 4)
    assert.equal(JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8')).format, 'orchestre-suivi/2')
    assert.deepEqual(M.FORMATS, ['orchestre-suivi/1', 'orchestre-suivi/2'])
    assert.equal(M.normalize({ format: 'orchestre-suivi/3', taches: [] }), null)
    assert.equal(M.formatOf({ format: 'orchestre-suivi/3' }), 'orchestre-suivi/3')
    assert.equal(M.normalize({ format: 'orchestre-suivi/1' }), null, 'sans taches')
    // Un /1 : même lecture, le modèle utilisé inconnu
    const raw = JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8'))
    const v1 = M.normalize({ ...raw, format: 'orchestre-suivi/1', taches: raw.taches.map(({ modele_utilise, ...t }) => t) })
    assert.deepEqual(v1.tasks.map(t => [t.id, t.model, t.modelUsed, t.step]), A.tasks.map(t => [t.id, 'sonnet', null, t.step]))
    assert.deepEqual({ ...v1, tasks: [] }, { ...A, tasks: [] }, 'le reste à l\'identique')
  })

  testCase('pendant un run : bandeau, suffixe du spinner, tâches en cours et leur frise', () => {
    const b = M.plainText(M.banner(A, tA, 140))
    assert.match(b, /^▶ demo {2}◉○ {2}█+░+ {2}0\/4 {2}◐ T01 réalisation \+1 +⏱ 1 min$/)
    assert.match(M.plainText(M.banner(A, tA, 80)), /◐ T01 réalisation \+1 +⏱ 1 min$/, 'l\'étape tient en 80')
    // Cases fixes : la durée reste en place quand l'étape change de nom, « 0/10 » prend la largeur de « 10/10 »
    const fusion = { ...A, tasks: A.tasks.map(t => (t.id === 'T01' ? { ...t, step: 'fusion' } : t)) }
    assert.equal(M.plainText(M.banner(fusion, tA, 140)).indexOf('⏱'), b.indexOf('⏱'), 'la durée ne bouge pas')
    const ten = { ...A, tasks: [...A.tasks, ...Array.from({ length: 6 }, (_, i) => ({ ...A.tasks[3], id: `T1${i}` }))] }
    assert.match(M.plainText(M.banner(ten, tA, 140)), / {3}0\/10 /)
    // Les mentions viennent juste après l'avancement, avant les tâches en cours : elles ne bougent pas d'une étape à l'autre
    const A2 = { ...A, reviews: [{ task: 'T01', phase: 1, text: '.env.example', at: tA - 1000 }] }
    const A3 = { ...A2, tasks: A2.tasks.map(t => (t.id === 'T01' ? { ...t, step: 'evaluateur' } : t)) }
    assert.match(M.plainText(M.banner(A2, tA, 140)), /^▶ demo {2}◉○ {2}█+░+ {2}0\/4 {2}⚑ 1 à relire {2}◐ T01 réalisation \+1 +⏱ 1 min$/)
    assert.equal(M.plainText(M.banner(A3, tA, 140)).indexOf('⚑ 1 à relire'), M.plainText(M.banner(A2, tA, 140)).indexOf('⚑ 1 à relire'), 'même place à l\'étape suivante')
    assert.match(M.plainText(M.banner(A, tA, 50)), /◐ 2 en cours {2}⏱/, 'sans l\'étape')
    assert.match(M.plainText(M.banner(A, tA, 44)), /◐ 2 {2}⏱/, 'libellés courts')
    assert.equal(M.suffix(A, tA), ' · T01 réalisation · 2 tâches en cours…')
    const t = text(M.taskLines(A, tA, 100))
    assert.match(t, /^◉ Phase 1 +■■ {2}0\/2/m); assert.match(t, /◐ T01 +Tâche T01 .*réalisation \(worktree\)/); assert.match(t, /◐ T02 .*vérification/)
    assert.match(t, /^○ Phase 2 +■■ {2}0\/2/m); assert.doesNotMatch(t, /T03/, 'phase suivante repliée')
    // La frise : la réalisation de T01 en lavande, la vérification de T02 en violet, sur le temps du run
    const line = id => M.taskLines(A, tA, 100).find(l => l.some(m => m.t.trim() === id))
    assert.ok(line('T01').some(m => /━/.test(m.t) && m.c === 'suggestion')); assert.ok(line('T02').some(m => /━/.test(m.t) && m.c === 'merged'))
  })

  suivi('cloture', { tache: 'T01', statut: 'fusionnée', essais: 2, branche: 'tache/T01', refus: [{ essai: 1, par: 'évaluation', manques: ['texte faux'] }], relectures: ['agents/x/.env.example : ajouter MR_MAX'], decisions_office: [{ titre: 'Seuil de relance', option: 'A', description: 'plafond à 30 s' }] })
  suivi('cloture', { tache: 'T02', statut: 'besoin-humain', essais: 1, branche: 'tache/T02', blocage: ['secret manquant pour les tests'], relectures: ['a.env.example : x', 'b.env.example : y'], points: [{ titre: 'Secret manquant', contexte: '', humain: true, options: [] }] })
  const B = readFile()

  testCase('notifications : relecture, tâche qui attend un humain ; rien à la première lecture', () => {
    assert.deepEqual(M.changes(null, B), [])
    assert.deepEqual(M.changes(A, B), ['⚑ T02 attend un humain', '⚑ T01 : à relire avant la PR', '⚑ T02 : 2 relectures avant la PR'], 'une notification par tâche')
    assert.deepEqual(M.changes(B, B), [])
  })

  testCase('carte « À toi » : une ligne par chose, une action par type ; carte du run, journal, état en texte et brouillon de PR', () => {
    const yourTurn = M.yourTurnCard(B, tA, 100)
    assert.equal(M.plainText(yourTurn.title), '⚠ À toi'); assert.equal(M.plainText(yourTurn.meta), '1 à régler · 3 relectures · 1 décision')
    const tt = text(yourTurn.lines)
    assert.match(tt, /^⚑ T02 · Secret manquant \(humain\) {2}→ reprendre le run\n +secret manquant pour les tests$/m)
    assert.match(tt, /^⚑ T01 · agents\/x\/\.env\.example : ajouter MR_MAX {2}→ relire$/m)
    assert.match(tt, /^⇒ T01 · Seuil de relance : A \(plafond à 30 s\) {2}→ revoir$/m)
    const actions = yourTurn.lines.flat().filter(m => m.x).map(m => m.x)
    assert.deepEqual(actions.map(x => x.hotkey), ['1', '2', '3', '4', '5'])
    assert.equal(actions[0].prompt, '/orchestre:lancer plans/demo --reprendre', 'un point humain : reprendre le run, qui le pose')
    assert.equal(actions[1].prompt, 'Relis avec moi, avant la PR (relecture de T01) : agents/x/.env.example : ajouter MR_MAX')
    assert.equal(actions[4].prompt, "Revois avec moi la décision prise d'office pour T01 : « Seuil de relance », option A (plafond à 30 s).")
    // Bloquée sans point : on demande au pilote ; prérequis ouvert : /orchestre:pret
    const blocked = { ...B, issues: [], tasks: B.tasks.map(t => (t.id === 'T02' ? { ...t, status: 'bloquée' } : t)), prerequisites: [{ id: 'D5', type: 'décision', blocks: ['T04'] }] }
    const ab = M.yourTurnCard(blocked, tA, 100).lines.flat().filter(m => m.x).map(m => m.x.prompt)
    assert.deepEqual(ab.slice(0, 2), ['Explique le blocage de T02 (secret manquant pour les tests) et propose une suite.', '/orchestre:pret plans/demo'])
    assert.equal(M.yourTurnCard(A, tA, 100), null, 'rien à faire : pas de carte')
    // Au-delà de 9 lignes, plus de touche : la ligne reste un bouton
    const many = { ...B, reviews: Array.from({ length: 10 }, (_, i) => ({ task: 'T01', phase: 1, text: `f${i}`, at: null })) }
    assert.deepEqual(M.yourTurnCard(many, tA, 100).lines.flat().filter(m => m.x).map(m => m.x.hotkey), ['1', '2', '3', '4', '5', '6', '7', '8', '9', null, null, null])
    const run = text(M.runCard(B, tA, 100, false).lines)
    assert.match(run, /^durée .* · 2 en parallèle · 1 essai de plus · 1 décision d'office$/m); assert.match(run, /^tâches .* 1\/4 /m); assert.doesNotMatch(run, /suite/, 'run en cours : pas de suite')
    const pr = M.prText(B, tA)
    assert.match(pr, /- T01 : agents\/x\/\.env\.example : ajouter MR_MAX/); assert.match(pr, /- T01, Seuil de relance : option A, plafond à 30 s/); assert.match(pr, /Encore en attente : T02 \(attend un humain\)/)
    const state = M.stateText(B, tA)
    assert.match(state, /^▶ demo {2}◉○/); assert.match(state, /\n⚠ À toi {3}1 à régler/); assert.match(state, /\njournal/)
    const j = M.logCard(B, tA, 100, false)
    assert.equal(j.lines.length, M.SHORT_LOG); assert.match(text(j.lines), /⚑ /); assert.equal(M.plainText(j.meta), `j : tout (${B.log.length})`)
    assert.equal(M.logCard(B, tA, 100, true).lines.length, B.log.length)
  })

  suivi('fin-run', { statut: 'arbitrage', phase: 1, mode: 'auto', arbitrage: { tache: 'T02', titre: 'Secret manquant', contexte: '', humain: true, options: [] }, points_a_trancher: [], taches: [], non_lancees: [], reportees: [], taches_ajoutees: [], arbitrages_appliques: [], decisions_office: [], amendements_ecartes: [], en_attente: ['T02'], en_attente_prerequis: [] })
  const C = readFile()

  testCase('fin de run : notification, bandeau de fin, plus de suffixe ni de tâche en cours', () => {
    assert.deepEqual(B.issues.map(p => p.role), ['a-trancher'], 'le scribe note le point à la clôture')
    assert.deepEqual(M.changes(B, C), ['Run 1 (phase 1) : arbitrage', 'Run arrêté : T02, Secret manquant'], 'point devenu point d\'arrêt')
    assert.match(M.plainText(M.banner(C, tA, 140)), /^■ demo {2}◉○ {2}\S+ {2}1\/4 {2}⚑ 3 à relire {2}⚠ 1 à toi {2}run 1 arbitrage {2}⏱ /)
    assert.equal(M.suffix(C, tA), null); assert.deepEqual(M.inProgress(C, tA), [])
    assert.match(text(M.yourTurnCard(C, tA, 100).lines), /^⚑ T02 · Secret manquant \(humain\) {2}→ reprendre le run$/m)
    // Run fini : la suite en une touche
    const rc = M.runCard(C, tA, 100, false)
    assert.equal(M.plainText(rc.title), '■ Run 1 · phase 1 · autonome'); assert.equal(rc.color, 'warning')
    const following = rc.lines.flat().find(m => m.x)
    assert.deepEqual([following.x.hotkey, following.x.prompt], ['l', '/orchestre:lancer plans/demo --reprendre'])
    assert.deepEqual(M.pane(C, tA, 100).cards.map(c => c.id), ['toi', 'run', 'taches', 'journal'])
    assert.match(M.plainText(M.pane(C, tA, 100).header[0]), /^ORCHESTRE · DEMO · RUN 1 ARBITRAGE · {2}⚠ 1 À TOI$/)
    assert.deepEqual([M.pane(C, tA, 100).borders, M.pane(C, tA, 50).borders], [true, false], 'sans bord en deçà de 60 colonnes')
    assert.deepEqual(M.pane(A, tA, 100).cards.map(c => c.id), ['run', 'taches', 'journal'], 'rien à faire : pas de carte À toi')
    assert.equal(M.statusLine(C, tA), 'orchestre ■ 1/4 · ⚑ 3 · ⚠ 1')
  })

  testCase('gros plan : les tâches repliées par phase, sans activité, et les tâches à faire bornées', () => {
    const doc = JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8'))
    doc.taches = Array.from({ length: 130 }, (_, i) => ({ ...doc.taches[0], id: `T${String(i + 1).padStart(3, '0')}`, phase: Math.floor(i / 13) + 1, statut: i < 40 ? 'fusionnée' : 'à-faire', etape: null, debut: null, fin: null }))
    const G = M.normalize(doc)
    const l = M.taskLines(G, tA, 100)
    assert.equal(l.filter(x => /Phase/.test(M.plainText(x))).length, 10)
    assert.ok(l.length <= 10 + 6 + 1 + 2 + 5, `${l.length} lignes`)
    assert.match(text(l), /○ 1 autres à faire|○ \d+ autres à faire/)
    assert.equal(M.summarize(G, tA).current.number, 4)
  })

  testCase('run interrompu (resté « en-cours » sans écriture depuis 45 min) : sans nouvelles, plus d\'étape ni de suffixe', () => {
    const later = (A.updated ?? 0) + M.SILENCE_MS + 60000
    assert.ok(M.silent(A, later)); assert.ok(!M.silent(A, tA))
    assert.match(M.plainText(M.banner(A, later, 140)), /^◌ demo {2}◉○ {2}░+ {2}0\/4 {2}sans nouvelles depuis 46 min {2}⏱ /)
    assert.doesNotMatch(M.plainText(M.banner(A, later, 140)), /en cours/)
    assert.equal(M.suffix(A, later), null); assert.deepEqual(M.inProgress(A, later), [])
    assert.doesNotMatch(text(M.taskLines(A, later, 100)), /◐ T0/)
  })

  testCase('phase dont toutes les tâches sont annulées : plus comptée', () => {
    const doc = JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8'))
    for (const t of doc.taches) if (t.phase === 2) t.statut = 'annulée'
    const X = M.normalize(doc)
    assert.deepEqual(M.phasesOf(X, tA).map(p => p.number), [1])
    assert.match(M.plainText(M.banner(X, tA, 140)), /^■ demo {2}◉ {2}\S+ {2}1\/2 /)
  })

  // Run 2 en mode auto : le premier scribe tranche le point de T02, T02 reprend, puis la phase 2
  suivi('debut-run', { phase: 1, mode: 'auto', parallelisme: 2, corrections_max: 2, decisions_office_max: 3 })
  suivi('arbitrage', { tache: 'T02', titre: 'Secret manquant', option: 'A' })
  const E = readFile(), tE = Date.parse(JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8')).maj) + 1000
  suivi('etape', { tache: 'T02', etape: 'worker', isole: true })
  const F = readFile()

  testCase('reprise après arbitrage : la tâche n\'attend plus personne, ni une fois tranchée, ni pendant sa reprise', () => {
    assert.equal(M.summarize(C, tA).attention.length, 1, 'avant le run 2, T02 attend un humain')
    assert.deepEqual(M.summarize(E, tE).attention, []); assert.doesNotMatch(M.plainText(M.banner(E, tE, 140)), /à toi/)
    assert.match(text(M.taskLines(E, tE, 100)), /⚑ T02 .*point tranché, reprise à venir/)
    assert.deepEqual(M.summarize(F, tE).attention, []); assert.match(M.plainText(M.banner(F, tE, 140)), /◐ T02 réalisation/)
    assert.match(text(M.taskLines(F, tE, 100)), /◐ T02 +Tâche T02 .*réalisation \(worktree\)/)
    assert.equal(M.summarize(F, tE).phases[0].attention, 0)
    // Reprise sans arbitrage dans ce run (tâche bloquée relancée, point réglé ailleurs) : l'étape suffit
    const brutF = JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8'))
    brutF.runs.at(-1).arbitrages_appliques = []
    const R = M.normalize(brutF)
    assert.deepEqual(M.summarize(R, tE).attention, []); assert.equal(M.summarize(R, tE).phases[0].attention, 0)
    assert.equal(M.summarize(R, R.updated + M.SILENCE_MS + 1000).attention.length, 1, 'run silencieux : la tâche attend de nouveau')
  })

  suivi('cloture', { tache: 'T02', statut: 'fusionnée', essais: 2, branche: 'tache/T02' })
  suivi('etape', { tache: 'T03', etape: 'worker', isole: true })
  const G2 = readFile()
  suivi('cloture', { tache: 'T03', statut: 'fusionnée', essais: 1, branche: 'tache/T03' })
  suivi('cloture', { tache: 'T04', statut: 'fusionnée', essais: 1, branche: 'tache/T04' })
  suivi('fin-run', { statut: 'terminé', phase: 2, mode: 'auto', points_a_trancher: [], taches: [], non_lancees: [], reportees: [], taches_ajoutees: [], arbitrages_appliques: [], decisions_office: [], amendements_ecartes: [], en_attente: [], en_attente_prerequis: [] })
  const H = readFile()

  testCase('run en mode auto : le bandeau suit la phase atteinte, la fin de run nomme les phases, chaque phase a sa durée', () => {
    assert.equal(G2.run.phase, 1, 'run.phase reste la phase de départ')
    assert.match(M.plainText(M.banner(G2, tE, 140)), /^▶ demo {2}●◉ /)
    assert.equal(M.runPhase(E), 1, 'avant toute étape, la phase de départ')
    assert.match(M.plainText(M.banner(H, tE, 140)), /^✓ demo {2}●● {2}\S+ {2}4\/4 /)
    assert.ok(M.changes(G2, H).includes('Run 2 (phases 1 à 2) : terminé'), M.changes(G2, H).join(' | '))
    assert.ok(M.changes(B, C).includes('Run 1 (phase 1) : arbitrage'), 'un run d\'une phase garde « phase 1 »')
    assert.notEqual(M.phasesOf(H, tE)[1].duration, null, 'la phase 2 a une durée, bien que run.phase vaille 1')
    // Plan fini : la suite est le brouillon de PR ; la ligne d'état reste tant qu'il y a des relectures
    const following = M.runCard(H, tE, 100, false).lines.flat().find(m => m.x)
    assert.deepEqual([following.x.hotkey, following.x.prompt], ['p', M.prText(H, tE)])
    assert.equal(M.statusLine(H, tE), 'orchestre ✓ 4/4 · ⚑ 3'); assert.equal(M.statusLine({ ...H, reviews: [] }, tE), null)
  })

  testCase('bandeau : tient dans la largeur donnée, place du bouton comprise, en gardant l\'essentiel', () => {
    const later = (A.updated ?? 0) + M.SILENCE_MS + 60000
    for (const [X, t, reserve] of [[A, tA, 0], [C, tA, 12], [A, later, 0], [H, tE, 12]]) {
      for (const w of [160, 140, 120, 110, 100, 90, 80, 70, 62, 60, 50, 40, 20]) {
        const l = M.banner(X, t, w, reserve)
        // Sur ce petit plan, la forme la plus courte tient en 50 cellules ; en deçà, l'affichage coupe la fin
        if (w - reserve >= 50) assert.ok(M.width(l) <= w - reserve, `${w} - ${reserve} : ${M.width(l)} « ${M.plainText(l)} »`)
        assert.match(M.plainText(l), /^[▶■✓◌] demo {2}[●◉○]+ /, 'nom et phases toujours là')
        assert.match(M.plainText(l), /\d\/\d+/, 'avancement toujours là')
      }
    }
    assert.match(M.plainText(M.banner(C, tA, 160, 24)), /⚠ 1 à toi {2}run 1 arbitrage {2}⏱ \d+ (s|min)$/)
    assert.match(M.plainText(M.banner(C, tA, 62, 12)), /⚠ 1 {2}(run 1 )?arbitrage$/, 'en 50 cellules : ce qui attend et le statut du run, sans la durée')
    const tight = M.banner(C, tA, 50, 12)
    assert.ok(M.width(tight) <= 38, M.plainText(tight)); assert.match(M.plainText(tight), /⚠ 1 {2}arbitrage$/, 'en 38 : le statut sans le numéro du run')
  })

  testCase('couleurs : barre par statut, une case par tâche, points de phase, pastilles', () => {
    const classes = M.banner(C, tA, 140).filter(m => /^[█░▓]+$/.test(m.t))
    assert.deepEqual(classes.map(m => [m.c, [...m.t].length]), [['success', 3], ['warning', 3], ['subtle', 6]], 'T01 fusionnée, T02 attend un humain, T03 et T04 à faire')
    // « à relire » et « à toi » sont des boutons vers la carte « À toi » ; leur glyphe garde la couleur
    const l = M.banner(C, tA, 140)
    assert.deepEqual([l.find(m => /à toi/.test(m.t)), l.find(m => /à relire/.test(m.t))].map(m => [m?.a, m?.k]), [['toi', 'toi'], ['toi', 'relire']], 'les deux mènent à la carte À toi')
    assert.deepEqual(l.filter(m => m.t === '⚠ ' || m.t === '⚑ ').map(m => [m.t, m.c, !!m.b]), [['⚑ ', 'warning', false], ['⚠ ', 'warning', true]])
    // Gros plan : en proportion, chaque statut présent garde au moins une case
    const doc = JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8'))
    doc.taches = Array.from({ length: 124 }, (_, i) => ({ ...doc.taches[0], id: `T${i + 1}`, phase: Math.floor(i / 12) + 1, statut: i < 60 ? 'fusionnée' : i === 60 ? 'échec' : 'à-faire', etape: null }))
    const G = M.normalize(doc)
    const bar = M.classBar(G.tasks, t => (t.status === 'fusionnée' ? 0 : t.status === 'échec' ? 3 : 4), 14, tA, false)
    assert.equal(M.width(bar), 14); assert.deepEqual(bar.map(m => m.c), ['success', 'error', 'subtle'])
    assert.equal(M.phaseDots(M.phasesOf(G, tA), 1), null, '11 phases : pas de points')
    assert.match(M.plainText(M.banner(G, tA, 140)), /^[■✓] demo {2}phase \d+\/11 /)
    const ph = M.taskLines(B, tA, 100).find(l => /Phase 1/.test(M.plainText(l)))
    assert.deepEqual(ph.filter(m => /■/.test(m.t)).map(m => [m.c, m.t]), [['success', '■'], ['warning', '■']])
    assert.ok(M.taskLines(A, tA, 100).flat().some(m => m.t === 'réalisation' && m.c === 'suggestion' && m.b), 'étape dans sa couleur')
  })

  testCase('nouvelle au bout du bandeau : la plus importante de la dernière écriture, vive 5 s, estompée jusqu\'à 10 s', () => {
    const q = Math.max(...B.log.map(j => j.at))
    const fresh = M.news(B, q + 1000)
    assert.equal(fresh.text, 'T02 attend un humain', 'le statut l\'emporte sur la relecture et le point notés en même temps')
    assert.match(M.plainText(M.banner(B, q + 1000, 160)), / {3}⚑ T02 attend un humain$/)
    assert.ok(M.banner(B, q + 1000, 160).some(m => m.t === ' T02 attend un humain' && m.b && m.c === 'warning'))
    assert.ok(M.banner(B, q + 7000, 160).some(m => m.t === ' T02 attend un humain' && m.d), 'estompée après 5 s')
    assert.equal(M.news(B, q + 11000), null); assert.doesNotMatch(M.plainText(M.banner(B, q + 11000, 160)), /T02 attend/)
    // Dates fixées : la clôture de T02 et la fin du run à la même seconde, puis à 3 s d'écart
    const qC = Math.max(...C.log.map(j => j.at))
    const C1 = { ...C, log: C.log.map(j => ({ ...j, at: qC })) }
    assert.equal(M.news(C1, qC).text, 'T02 attend un humain', 'même seconde que la clôture : le statut l\'emporte')
    const C2 = { ...C, log: C.log.map((j, i) => ({ ...j, at: i === C.log.length - 1 ? qC + 3000 : qC })) }
    assert.deepEqual([M.news(C2, qC + 3000).text, M.news(C2, qC + 3000).mark.t, M.news(C2, qC + 3000).mark.c], ['run 1 : arbitrage', '■', 'warning'])
    const qH = Math.max(...H.log.map(j => j.at))
    assert.deepEqual([M.news(H, qH).mark.t, M.news(H, qH).mark.c], ['✓', 'success'], 'fin de run terminée en vert')
    const end = text(M.logCard(B, q + 1000, 100, false).lines)
    assert.match(end, /T02 : point « Secret manquant »[^\n]*$/, 'la dernière entrée du journal en bas de sa carte')
  })

  testCase('animation : la tête tourne, les tâches en cours pulsent et tournent ; rien ne bouge sans anime ni hors d\'un run', () => {
    const head = t => M.banner(A, t, 140, 0, true)[0].t
    assert.notEqual(head(tA), head(tA + 100)); assert.match(head(tA), /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] $/)
    assert.equal(M.banner(A, tA, 140)[0].t, '▶ ', 'sans anime, ▶')
    assert.equal(M.banner(C, tA, 140, 0, true)[0].t, '■ ', 'run fini : pas de spinner')
    const inProgress = t => M.banner(A, t, 140, 0, true).find(m => m.c === 'suggestion' && /^[█▓]+$/.test(m.t)).t[0]
    assert.deepEqual(new Set([0, 450, 900, 1350].map(k => inProgress(tA + k))), new Set(['█', '▓']), 'les tâches en cours pulsent')
    const g = t => M.taskLines(A, t, 100, true).find(l => /T01/.test(M.plainText(l)) && !/Phase/.test(M.plainText(l)))[1].t
    assert.notEqual(g(tA), g(tA + M.IMAGE_MS)); assert.match(g(tA), /^[◐◓◑◒]$/)
    // Tâche tout juste fusionnée : quelques secondes en vert, avec une pastille
    const T01 = B.tasks.find(t => t.id === 'T01')
    const line = M.taskLines(B, T01.end + 1000, 100).find(l => /T01/.test(M.plainText(l)) && /fusionnée/.test(M.plainText(l)))
    assert.ok(line && line.some(m => m.f === 'success'), 'pastille « fusionnée »')
    assert.ok(!M.taskLines(B, T01.end + 6000, 100).some(l => / fusionnée $/.test(l.at(-1)?.t ?? '')), 'plus après 5 s')
  })

  testCase('notifications qui demandent quelqu\'un : affichées plus longtemps', () => {
    for (const m of ['⚑ T02 attend un humain', '✗ T03 bloquée', '✗ T03 en échec', 'Run arrêté : T02, Secret manquant', 'Run 2 (phase 1) : erreur']) assert.ok(M.isImportant(m), m)
    for (const m of ['⚑ T01 : à relire avant la PR', 'Phase 1 terminée', 'Run 1 lancé : phase 1, mode auto', 'Run 1 (phase 1) : arbitrage', 'Run 2 (phases 1 à 2) : terminé']) assert.ok(!M.isImportant(m), m)
    assert.ok(M.IMPORTANT_TOAST_MS > 4000)
  })

  testCase('frise des étapes, temps par étape, ce qui a changé pendant ton absence (sur la démo)', () => {
    const T = Date.parse('2026-10-09T10:00:00Z'), t = D.frameInstant(11, T) + 500, I = D.demoSnapshot(11, T)
    const steps = id => M.stepsOf(I, I.tasks.find(x => x.id === id), t).map(e => e[2])
    assert.deepEqual([steps('T01'), steps('T02'), steps('T03')], [['worker', 'vérification', 'évaluation', 'fusion'], ['worker', 'vérification', 'correction', 'vérification', 'fusion'], ['worker', 'vérification']])
    assert.deepEqual(M.timePerStep(I, t).map(e => e[0]), ['worker', 'vérification', 'évaluation', 'correction', 'fusion'])
    const T02 = M.taskLines(I, t, 100).find(l => l.some(m => m.t.trim() === 'T02'))
    assert.deepEqual(T02.filter(m => /━/.test(m.t)).map(m => m.c), ['suggestion', 'merged', 'warning', 'merged', 'success'], 'une couleur par étape, dans l\'ordre')
    const T03 = M.taskLines(I, t, 100).find(l => l.some(m => m.t.trim() === 'T03'))
    assert.match(T03.filter(m => /^[━·]+$/.test(m.t)).at(-1).t, /^·+$/, 'T03 s\'arrête à sa clôture, avant la fin du run')
    assert.match(text(M.runCard(I, t, 100, false).lines), /^étapes {2}réal \d+:\d\d · vérif \d+:\d\d · éval \d+:\d\d · corr \d+:\d\d · fusion \d+:\d\d$/m)
    const I20 = D.demoSnapshot(20, T), end = D.frameInstant(20, T) + 60000
    assert.equal(M.plainText(M.since(I20, D.frameInstant(12, T), end)), '↩ Depuis 1 min : ✓ T03 T05 T04 fusionnées · ⚑ 2 relectures · run 2 terminé')
    assert.equal(M.plainText(M.since(I, T - 1, D.frameInstant(11, T) + 60000)), '↩ Depuis 1 min : ✓ T01 T02 fusionnées · ⚠ T03 t\'attend · ⚑ 1 relecture · run 1 arbitrage')
    assert.equal(M.since(I20, D.frameInstant(20, T) - 1000, D.frameInstant(20, T) + 29000), null, 'moins d\'une minute, même avec du nouveau : rien')
    assert.equal(M.since(I20, D.frameInstant(20, T), end), null, 'rien de nouveau depuis le dernier pas : rien')
    // La légende de la démo, en tête du panneau
    const en = M.pane(D.demoSnapshot(10, T), D.frameInstant(10, T), 100).header.map(M.plainText)
    assert.ok(en.includes('pas 11/21 · T03 attend un humain'), en.join(' | ')); assert.ok(en.some(l => /^→ la carte « À toi » est en tête/.test(l)))
    assert.equal(M.normalize(D.demoDoc(3, T)).legend, null)
  })

  testCase('modèle dans les cartes des tâches (0.11.0) : utilisé, « prévu → utilisé » quand ils diffèrent, prévu estompé avant le worker ; journal', () => {
    const T = Date.parse('2026-10-09T10:00:00Z'), t4 = D.frameInstant(4, T) + 500, I = D.demoSnapshot(4, T)
    // La ligne d'une tâche (« ··◐ T02 … »), pas celle de sa phase
    const line = (X, id, w = 100, t = t4) => M.taskLines(X, t, w).find(l => M.plainText(l).match(/^ {2}\S (\S+)/)?.[1] === id)
    // T02 corrigée sur opus, choisi par le replanificateur ; T01 sur son modèle ; T03 pas encore lancée
    const l2 = line(I, 'T02')
    assert.deepEqual(l2.filter(m => /sonnet|opus/.test(m.t)).map(m => [m.t, m.c ?? null, !!m.b, !!m.d]), [['sonnet → ', null, false, true], ['opus', 'merged', true, false]])
    assert.deepEqual(line(I, 'T01').filter(m => /sonnet/.test(m.t)).map(m => [m.t, m.c, !!m.d]), [['sonnet', 'subtle', false]])
    const l3 = line(I, 'T03')
    assert.deepEqual(l3.filter(m => /sonnet/.test(m.t)).map(m => [m.t, !!m.d]), [['sonnet', true]], 'prévu, estompé')
    assert.equal(M.plainText(l3).indexOf('sonnet'), M.plainText(line(I, 'T01')).indexOf('sonnet'), 'même colonne qu\'une ligne détaillée')
    assert.match(M.plainText(l2), /sonnet → opus {2}correction essai 2 \(worktree\)$/)
    // Phase 2 : la documentation sur haiku
    const I16 = D.demoSnapshot(16, T)
    assert.ok(line(I16, 'T05', 100, D.frameInstant(16, T) + 500).some(m => m.t === 'haiku' && m.c === 'subtle'))
    // Le plan ne prévoyait pas de modèle : « — → sonnet »
    const sans = { ...I, tasks: I.tasks.map(x => (x.id === 'T01' ? { ...x, model: null } : x)) }
    assert.match(M.plainText(line(sans, 'T01')), /— → sonnet/)
    // Aucun modèle connu (suivi.json reconstruit d'un plan sans modèles) : pas de colonne, la frise garde sa largeur
    const noModel = { ...I, tasks: I.tasks.map(x => ({ ...x, model: null, modelUsed: null })) }
    for (const id of ['T01', 'T02', 'T03']) assert.doesNotMatch(M.plainText(line(noModel, id)), /sonnet|opus|→/)
    const timelineOf = l => l.filter(m => /^[━╸·]+$/.test(m.t)).reduce((n, m) => n + [...m.t].length, 0)
    assert.equal(timelineOf(line(noModel, 'T01')), 26); assert.equal(timelineOf(line(I, 'T01')), 11, 'à 100 colonnes, la colonne du modèle se prend sur la frise')
    assert.equal(timelineOf(line(I, 'T01', 160)), 26, 'à 160 colonnes, la frise garde sa largeur')
    // La colonne ne rallonge aucune ligne au-delà de la largeur ; en deçà de 75 colonnes (60 et sa largeur), elle disparaît
    for (const w of [140, 120, 100, 80, 75, 74, 60, 50]) {
      const withModel = M.taskLines(I, t4, w), withoutModel = M.taskLines(noModel, t4, w)
      withModel.forEach((l, i) => assert.ok(M.width(l) <= Math.max(w, M.width(withoutModel[i])), `${w} : ${M.width(l)} « ${M.plainText(l)} »`))
    }
    assert.match(M.plainText(line(I, 'T02', 75)), /sonnet → opus/); assert.doesNotMatch(M.plainText(line(I, 'T02', 74)), /sonnet|opus/)
    assert.deepEqual(M.taskLines(I, t4, 60).map(M.plainText), M.taskLines(noModel, t4, 60).map(M.plainText), 'trop étroit : comme sans modèle')
    assert.equal(M.plainText(line(I, 'T02')).length - M.plainText(line(I, 'T02')).indexOf('correction'), M.plainText(line(noModel, 'T02')).length - M.plainText(line(noModel, 'T02')).indexOf('correction'))
    // Le journal : le changement de modèle, son glyphe ; /suivi texte le montre aussi
    const j = M.logCard(I, t4, 100, true).lines.find(l => /sonnet → opus/.test(M.plainText(l)))
    assert.ok(j && j.some(m => m.t === '⇄' && m.c === 'merged'), 'glyphe du journal')
    assert.match(M.plainText(j), /T02 +⇄ T02 : sonnet → opus \(l'erreur touche le formulaire et l'API\)$/)
    assert.match(M.stateText(I, t4), /T02 .*sonnet → opus/)
    assert.equal(M.news(I, t4)?.kind, 'refus', 'le refus fait la nouvelle, pas le changement de modèle noté à la même seconde')
  })

  testCase('mise en forme : durées, âges, barre, coupe', () => {
    assert.deepEqual([M.duration(45000), M.duration(18 * 60000), M.duration(72 * 60000), M.duration(null)], ['45 s', '18 min', '1 h 12', '—'])
    assert.deepEqual([M.chrono(42000), M.chrono(725000), M.chrono(3723000), M.chrono(null)], ['0:42', '12:05', '1:02:03', '—'])
    assert.equal(M.age(0, 3 * 86400000), '3 j'); assert.equal(M.bar(1, 4, 8), '██░░░░░░'); assert.equal(M.cut('abcdef', 4), 'abc…')
  })

  testCase('démo (tests/demo-suivi.mjs) : deux runs joués par le vrai suivi.mjs, sans pause hors d\'un terminal', () => {
    const r = spawnSync(process.execPath, [resolve('tests/demo-suivi.mjs'), join(repoRoot, 'demo'), '--pas', '0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stdout, /^ 1\. .*\n +bandeau .*\n +notification/m, 'premier suivi.json : rien à notifier')
    for (const expected of ['notification Run 2 lancé : phase 1, mode auto', 'notification ⚑ T03 attend un humain', 'notification Run arrêté : T03, Clé SMTP de test', 'notification Phase 1 terminée', 'notification Run 2 (phases 1 à 2) : terminé']) assert.ok(r.stdout.includes(expected), expected)
    assert.match(r.stdout, /^17\. .*\n +bandeau +▶ demo {2}●◉ /m)
    const Z = M.normalize(JSON.parse(readFileSync(join(repoRoot, 'demo', 'plans', 'demo', 'suivi.json'), 'utf8')))
    assert.deepEqual([Z.runs.length, Z.run.status, Z.tasks.filter(t => t.status === 'fusionnée').length, Z.reviews.length, Z.decisions.length], [2, 'terminé', 5, 3, 1])
    const already = spawnSync(process.execPath, [resolve('tests/demo-suivi.mjs'), join(repoRoot, 'demo')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(already.status, 1, 'dossier existant refusé'); assert.match(already.stderr, /existe déjà/)
    scriptNotifications = [...r.stdout.matchAll(/^ +notification (.*)$/gm)].map(x => x[1])
  })

  testCase('/suivi demo : chaque pas suit le schéma du contrat, et annonce les mêmes notifications que le vrai suivi.mjs', () => {
    const T = Date.parse('2026-10-09T10:00:00Z')
    for (let k = 0; k < D.FRAME_COUNT; k++) {
      const f = join(repoRoot, `demo-${k}.json`)
      assert.equal(D.demoDoc(k, T).format, 'orchestre-suivi/2', 'au format qu\'écrit suivi.mjs, pas un /1 qu\'il migrerait')
      writeFileSync(f, JSON.stringify(D.demoDoc(k, T)))
      const v = spawnSync(process.execPath, [PROGRESS, 'valider', '--fichier', f], { encoding: 'utf8' })
      assert.equal(v.status, 0, `pas ${k} : ${v.stderr}`)
    }
    /** @type {string[]} */
    const notifications = []
    let before = null
    for (let k = 0; k < D.FRAME_COUNT; k++) { const after = D.demoSnapshot(k, T); notifications.push(...M.changes(before, after)); before = after }
    assert.ok(scriptNotifications.length >= 8, scriptNotifications.join(' | '))
    assert.deepEqual(notifications, scriptNotifications, 'mêmes notifications que tests/demo-suivi.mjs, joué par le vrai suivi.mjs')
    // Même journal, entrée pour entrée, hors la reconstruction du premier suivi.json
    const real = JSON.parse(readFileSync(join(repoRoot, 'demo', 'plans', 'demo', 'suivi.json'), 'utf8')).journal.filter(j => !/^suivi\.json reconstruit/.test(j.texte))
    assert.deepEqual(D.demoDoc(D.FRAME_COUNT - 1, T).journal.map(j => `${j.genre} | ${j.texte}`), real.map(j => `${j.genre} | ${j.texte}`))
    assert.deepEqual([before.runs.length, before.run.status, before.tasks.filter(t => t.status === 'fusionnée').length, before.reviews.length, before.decisions.length], [2, 'terminé', 5, 3, 1])
    // Le bandeau dit que c'est une démo
    const b = M.banner(D.demoSnapshot(3, T), D.frameInstant(3, T), 140)
    assert.match(M.plainText(b), /^▶  DÉMO  site-vitrine {2}◉○ /); assert.ok(b.some(m => m.t === ' DÉMO ' && m.f === 'merged'))
    assert.equal(M.normalize(D.demoDoc(3, T)).demo, false, 'un vrai suivi.json n\'est jamais une démo')
    // Le temps : un pas toutes les 3 s, une pause de 12 s à l'arrêt du run 1, puis une minute avant le retour au vrai suivi
    assert.deepEqual([D.frameAt(T - 1, T), D.frameAt(T, T), D.frameAt(T + 2999, T), D.frameAt(T + 3000, T)], [-1, 0, 0, 1])
    assert.equal(D.frameInstant(12, T) - D.frameInstant(11, T), 4 * D.DEMO_FRAME_MS)
    assert.equal(D.demoEnd(T), D.frameInstant(D.FRAME_COUNT - 1, T) + 60000, 'le vrai suivi reprend une minute après le dernier pas')
    assert.equal(D.frameAt(D.demoEnd(T), T), D.FRAME_COUNT - 1)
  })

  console.log(`mod de suivi : TOUT EST VERT (${n} cas)`)
} finally {
  rmSync(repoRoot, { recursive: true, force: true })
}
