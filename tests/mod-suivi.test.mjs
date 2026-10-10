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

const SUIVI = resolve('plugins/orchestre/scripts/suivi.mjs')
const racine = mkdtempSync(join(tmpdir(), 'mod-suivi-'))
const git = (...a) => execFileSync('git', a, { cwd: racine, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const d = join(racine, 'plans', 'demo')
const tache = (id, phase, depend_de = []) => `---\nid: ${id}\ntitre: Tâche ${id} au titre long du frontmatter\nphase: ${phase}\nmodele: sonnet\ndepend_de: [${depend_de.join(', ')}]\nfichiers_possedes:\n  - src/${id}/**\nressources: []\nestimation_tokens: 1.0M\nverification:\n  - "npm test"\ndefinition_du_fini:\n  - "le test passe"\n---\n`
const suivi = (cmd, E) => {
  const r = spawnSync(process.execPath, [SUIVI, cmd, 'plans/demo', '--json', JSON.stringify(E)], { cwd: racine, encoding: 'utf8' })
  assert.equal(r.status, 0, `${cmd} : ${r.stderr}`)
}
const lire = () => M.normaliser(JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8')))
const texte = lignes => lignes.map(M.brut).join('\n')
let n = 0
const cas = (nom, fn) => { fn(); n++; console.log('ok ·', nom) }
/** @type {string[]} */
let notifsScript = []

try {
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(racine, 'README.md'), 'x\n'); git('add', '.'); git('commit', '-qm', 'init')
  mkdirSync(join(d, 'taches'), { recursive: true })
  const T = [['T01', 1], ['T02', 1], ['T03', 2, ['T01']], ['T04', 2, ['T02', 'T03']]]
  for (const [id, ph, dep] of T) writeFileSync(join(d, 'taches', `${id}-x.md`), tache(id, ph, dep))
  writeFileSync(join(d, 'SUIVI.md'), `# SUIVI — demo\n\n| ID | Titre | Phase | Lot | Dépend de | Modèle | Statut | Essais | Branche | Tokens est. / réels |\n|----|----|----|----|----|----|----|----|----|----|\n${T.map(([id, ph]) => `| ${id} | Tâche ${id} | ${ph} | — | — | sonnet | à-faire | 0 | — | 1,0 M / — |`).join('\n')}\n\nStatuts : à-faire · ajoutée · fusionnée · bloquée · échec · besoin-humain · annulée\n`)
  writeFileSync(join(d, 'HANDOFF.md'), '# HANDOFF — demo\n')
  writeFileSync(join(d, 'orchestre.config.json'), JSON.stringify({ branche_integration: 'plan/demo' }))
  git('switch', '-qc', 'plan/demo'); git('add', '.'); git('commit', '-qm', 'plan')

  suivi('debut-run', { phase: 1, mode: 'auto', parallelisme: 2, corrections_max: 2, decisions_office_max: 3 })
  suivi('etape', { tache: 'T01', etape: 'worker', isole: true })
  suivi('etape', { tache: 'T02', etape: 'vérification', isole: true })
  const A = lire()
  const tA = Date.parse(JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8')).maj) + 90000

  cas('format : orchestre-suivi/2 écrit par suivi.mjs, /1 d\'avant la 0.11.0 lu aussi, un autre format refusé sans deviner', () => {
    assert.ok(A); assert.equal(A.plan, 'demo'); assert.equal(A.taches.length, 4)
    assert.equal(JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8')).format, 'orchestre-suivi/2')
    assert.deepEqual(M.FORMATS, ['orchestre-suivi/1', 'orchestre-suivi/2'])
    assert.equal(M.normaliser({ format: 'orchestre-suivi/3', taches: [] }), null)
    assert.equal(M.formatDe({ format: 'orchestre-suivi/3' }), 'orchestre-suivi/3')
    assert.equal(M.normaliser({ format: 'orchestre-suivi/1' }), null, 'sans taches')
    // Un /1 : même lecture, le modèle utilisé inconnu
    const brut = JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8'))
    const v1 = M.normaliser({ ...brut, format: 'orchestre-suivi/1', taches: brut.taches.map(({ modele_utilise, ...t }) => t) })
    assert.deepEqual(v1.taches.map(t => [t.id, t.modele, t.modeleUtilise, t.etape]), A.taches.map(t => [t.id, 'sonnet', null, t.etape]))
    assert.deepEqual({ ...v1, taches: [] }, { ...A, taches: [] }, 'le reste à l\'identique')
  })

  cas('pendant un run : bandeau, suffixe du spinner, tâches en cours et leur frise', () => {
    const b = M.brut(M.bandeau(A, tA, 140))
    assert.match(b, /^▶ demo {2}◉○ {2}█+░+ {2}0\/4 {2}◐ T01 réalisation \+1 +⏱ 1 min$/)
    assert.match(M.brut(M.bandeau(A, tA, 80)), /◐ T01 réalisation \+1 +⏱ 1 min$/, 'l\'étape tient en 80')
    // Cases fixes : la durée reste en place quand l'étape change de nom, « 0/10 » prend la largeur de « 10/10 »
    const fusion = { ...A, taches: A.taches.map(t => (t.id === 'T01' ? { ...t, etape: 'fusion' } : t)) }
    assert.equal(M.brut(M.bandeau(fusion, tA, 140)).indexOf('⏱'), b.indexOf('⏱'), 'la durée ne bouge pas')
    const dix = { ...A, taches: [...A.taches, ...Array.from({ length: 6 }, (_, i) => ({ ...A.taches[3], id: `T1${i}` }))] }
    assert.match(M.brut(M.bandeau(dix, tA, 140)), / {3}0\/10 /)
    // Les mentions viennent juste après l'avancement, avant les tâches en cours : elles ne bougent pas d'une étape à l'autre
    const A2 = { ...A, relectures: [{ tache: 'T01', phase: 1, texte: '.env.example', quand: tA - 1000 }] }
    const A3 = { ...A2, taches: A2.taches.map(t => (t.id === 'T01' ? { ...t, etape: 'evaluateur' } : t)) }
    assert.match(M.brut(M.bandeau(A2, tA, 140)), /^▶ demo {2}◉○ {2}█+░+ {2}0\/4 {2}⚑ 1 à relire {2}◐ T01 réalisation \+1 +⏱ 1 min$/)
    assert.equal(M.brut(M.bandeau(A3, tA, 140)).indexOf('⚑ 1 à relire'), M.brut(M.bandeau(A2, tA, 140)).indexOf('⚑ 1 à relire'), 'même place à l\'étape suivante')
    assert.match(M.brut(M.bandeau(A, tA, 50)), /◐ 2 en cours {2}⏱/, 'sans l\'étape')
    assert.match(M.brut(M.bandeau(A, tA, 44)), /◐ 2 {2}⏱/, 'libellés courts')
    assert.equal(M.suffixe(A, tA), ' · T01 réalisation · 2 tâches en cours…')
    const t = texte(M.lignesTaches(A, tA, 100))
    assert.match(t, /^◉ Phase 1 +■■ {2}0\/2/m); assert.match(t, /◐ T01 +Tâche T01 .*réalisation \(worktree\)/); assert.match(t, /◐ T02 .*vérification/)
    assert.match(t, /^○ Phase 2 +■■ {2}0\/2/m); assert.doesNotMatch(t, /T03/, 'phase suivante repliée')
    // La frise : la réalisation de T01 en lavande, la vérification de T02 en violet, sur le temps du run
    const ligne = id => M.lignesTaches(A, tA, 100).find(l => l.some(m => m.t.trim() === id))
    assert.ok(ligne('T01').some(m => /━/.test(m.t) && m.c === 'suggestion')); assert.ok(ligne('T02').some(m => /━/.test(m.t) && m.c === 'merged'))
  })

  suivi('cloture', { tache: 'T01', statut: 'fusionnée', essais: 2, branche: 'tache/T01', refus: [{ essai: 1, par: 'évaluation', manques: ['texte faux'] }], relectures: ['agents/x/.env.example : ajouter MR_MAX'], decisions_office: [{ titre: 'Seuil de relance', option: 'A', description: 'plafond à 30 s' }] })
  suivi('cloture', { tache: 'T02', statut: 'besoin-humain', essais: 1, branche: 'tache/T02', blocage: ['secret manquant pour les tests'], relectures: ['a.env.example : x', 'b.env.example : y'], points: [{ titre: 'Secret manquant', contexte: '', humain: true, options: [] }] })
  const B = lire()

  cas('notifications : relecture, tâche qui attend un humain ; rien à la première lecture', () => {
    assert.deepEqual(M.changements(null, B), [])
    assert.deepEqual(M.changements(A, B), ['⚑ T02 attend un humain', '⚑ T01 : à relire avant la PR', '⚑ T02 : 2 relectures avant la PR'], 'une notification par tâche')
    assert.deepEqual(M.changements(B, B), [])
  })

  cas('carte « À toi » : une ligne par chose, une action par type ; carte du run, journal, état en texte et brouillon de PR', () => {
    const toi = M.carteAToi(B, tA, 100)
    assert.equal(M.brut(toi.titre), '⚠ À toi'); assert.equal(M.brut(toi.meta), '1 à régler · 3 relectures · 1 décision')
    const tt = texte(toi.lignes)
    assert.match(tt, /^⚑ T02 · Secret manquant \(humain\) {2}→ reprendre le run\n +secret manquant pour les tests$/m)
    assert.match(tt, /^⚑ T01 · agents\/x\/\.env\.example : ajouter MR_MAX {2}→ relire$/m)
    assert.match(tt, /^⇒ T01 · Seuil de relance : A \(plafond à 30 s\) {2}→ revoir$/m)
    const actions = toi.lignes.flat().filter(m => m.x).map(m => m.x)
    assert.deepEqual(actions.map(x => x.touche), ['1', '2', '3', '4', '5'])
    assert.equal(actions[0].prompt, '/orchestre:lancer plans/demo --reprendre', 'un point humain : reprendre le run, qui le pose')
    assert.equal(actions[1].prompt, 'Relis avec moi, avant la PR (relecture de T01) : agents/x/.env.example : ajouter MR_MAX')
    assert.equal(actions[4].prompt, "Revois avec moi la décision prise d'office pour T01 : « Seuil de relance », option A (plafond à 30 s).")
    // Bloquée sans point : on demande au pilote ; prérequis ouvert : /orchestre:pret
    const bloquee = { ...B, points: [], taches: B.taches.map(t => (t.id === 'T02' ? { ...t, statut: 'bloquée' } : t)), prerequis: [{ id: 'D5', type: 'décision', bloque: ['T04'] }] }
    const ab = M.carteAToi(bloquee, tA, 100).lignes.flat().filter(m => m.x).map(m => m.x.prompt)
    assert.deepEqual(ab.slice(0, 2), ['Explique le blocage de T02 (secret manquant pour les tests) et propose une suite.', '/orchestre:pret plans/demo'])
    assert.equal(M.carteAToi(A, tA, 100), null, 'rien à faire : pas de carte')
    // Au-delà de 9 lignes, plus de touche : la ligne reste un bouton
    const beaucoup = { ...B, relectures: Array.from({ length: 10 }, (_, i) => ({ tache: 'T01', phase: 1, texte: `f${i}`, quand: null })) }
    assert.deepEqual(M.carteAToi(beaucoup, tA, 100).lignes.flat().filter(m => m.x).map(m => m.x.touche), ['1', '2', '3', '4', '5', '6', '7', '8', '9', null, null, null])
    const run = texte(M.carteRun(B, tA, 100, false).lignes)
    assert.match(run, /^durée .* · 2 en parallèle · 1 essai de plus · 1 décision d'office$/m); assert.match(run, /^tâches .* 1\/4 /m); assert.doesNotMatch(run, /suite/, 'run en cours : pas de suite')
    const pr = M.textePR(B, tA)
    assert.match(pr, /- T01 : agents\/x\/\.env\.example : ajouter MR_MAX/); assert.match(pr, /- T01, Seuil de relance : option A, plafond à 30 s/); assert.match(pr, /Encore en attente : T02 \(attend un humain\)/)
    const etat = M.texteEtat(B, tA)
    assert.match(etat, /^▶ demo {2}◉○/); assert.match(etat, /\n⚠ À toi {3}1 à régler/); assert.match(etat, /\njournal/)
    const j = M.carteJournal(B, tA, 100, false)
    assert.equal(j.lignes.length, M.JOURNAL_COURT); assert.match(texte(j.lignes), /⚑ /); assert.equal(M.brut(j.meta), `j : tout (${B.journal.length})`)
    assert.equal(M.carteJournal(B, tA, 100, true).lignes.length, B.journal.length)
  })

  suivi('fin-run', { statut: 'arbitrage', phase: 1, mode: 'auto', arbitrage: { tache: 'T02', titre: 'Secret manquant', contexte: '', humain: true, options: [] }, points_a_trancher: [], taches: [], non_lancees: [], reportees: [], taches_ajoutees: [], arbitrages_appliques: [], decisions_office: [], amendements_ecartes: [], en_attente: ['T02'], en_attente_prerequis: [] })
  const C = lire()

  cas('fin de run : notification, bandeau de fin, plus de suffixe ni de tâche en cours', () => {
    assert.deepEqual(B.points.map(p => p.role), ['a-trancher'], 'le scribe note le point à la clôture')
    assert.deepEqual(M.changements(B, C), ['Run 1 (phase 1) : arbitrage', 'Run arrêté : T02, Secret manquant'], 'point devenu point d\'arrêt')
    assert.match(M.brut(M.bandeau(C, tA, 140)), /^■ demo {2}◉○ {2}\S+ {2}1\/4 {2}⚑ 3 à relire {2}⚠ 1 à toi {2}run 1 arbitrage {2}⏱ /)
    assert.equal(M.suffixe(C, tA), null); assert.deepEqual(M.enCours(C, tA), [])
    assert.match(texte(M.carteAToi(C, tA, 100).lignes), /^⚑ T02 · Secret manquant \(humain\) {2}→ reprendre le run$/m)
    // Run fini : la suite en une touche
    const rc = M.carteRun(C, tA, 100, false)
    assert.equal(M.brut(rc.titre), '■ Run 1 · phase 1 · autonome'); assert.equal(rc.couleur, 'warning')
    const suite = rc.lignes.flat().find(m => m.x)
    assert.deepEqual([suite.x.touche, suite.x.prompt], ['l', '/orchestre:lancer plans/demo --reprendre'])
    assert.deepEqual(M.panneau(C, tA, 100).cartes.map(c => c.id), ['toi', 'run', 'taches', 'journal'])
    assert.match(M.brut(M.panneau(C, tA, 100).entete[0]), /^ORCHESTRE · DEMO · RUN 1 ARBITRAGE · {2}⚠ 1 À TOI$/)
    assert.deepEqual([M.panneau(C, tA, 100).bords, M.panneau(C, tA, 50).bords], [true, false], 'sans bord en deçà de 60 colonnes')
    assert.deepEqual(M.panneau(A, tA, 100).cartes.map(c => c.id), ['run', 'taches', 'journal'], 'rien à faire : pas de carte À toi')
    assert.equal(M.ligneEtat(C, tA), 'orchestre ■ 1/4 · ⚑ 3 · ⚠ 1')
  })

  cas('gros plan : les tâches repliées par phase, sans activité, et les tâches à faire bornées', () => {
    const doc = JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8'))
    doc.taches = Array.from({ length: 130 }, (_, i) => ({ ...doc.taches[0], id: `T${String(i + 1).padStart(3, '0')}`, phase: Math.floor(i / 13) + 1, statut: i < 40 ? 'fusionnée' : 'à-faire', etape: null, debut: null, fin: null }))
    const G = M.normaliser(doc)
    const l = M.lignesTaches(G, tA, 100)
    assert.equal(l.filter(x => /Phase/.test(M.brut(x))).length, 10)
    assert.ok(l.length <= 10 + 6 + 1 + 2 + 5, `${l.length} lignes`)
    assert.match(texte(l), /○ 1 autres à faire|○ \d+ autres à faire/)
    assert.equal(M.resumer(G, tA).courante.numero, 4)
  })

  cas('run interrompu (resté « en-cours » sans écriture depuis 45 min) : sans nouvelles, plus d\'étape ni de suffixe', () => {
    const tard = (A.maj ?? 0) + M.SILENCE_MS + 60000
    assert.ok(M.silencieux(A, tard)); assert.ok(!M.silencieux(A, tA))
    assert.match(M.brut(M.bandeau(A, tard, 140)), /^◌ demo {2}◉○ {2}░+ {2}0\/4 {2}sans nouvelles depuis 46 min {2}⏱ /)
    assert.doesNotMatch(M.brut(M.bandeau(A, tard, 140)), /en cours/)
    assert.equal(M.suffixe(A, tard), null); assert.deepEqual(M.enCours(A, tard), [])
    assert.doesNotMatch(texte(M.lignesTaches(A, tard, 100)), /◐ T0/)
  })

  cas('phase dont toutes les tâches sont annulées : plus comptée', () => {
    const doc = JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8'))
    for (const t of doc.taches) if (t.phase === 2) t.statut = 'annulée'
    const X = M.normaliser(doc)
    assert.deepEqual(M.phasesDe(X, tA).map(p => p.numero), [1])
    assert.match(M.brut(M.bandeau(X, tA, 140)), /^■ demo {2}◉ {2}\S+ {2}1\/2 /)
  })

  // Run 2 en mode auto : le premier scribe tranche le point de T02, T02 reprend, puis la phase 2
  suivi('debut-run', { phase: 1, mode: 'auto', parallelisme: 2, corrections_max: 2, decisions_office_max: 3 })
  suivi('arbitrage', { tache: 'T02', titre: 'Secret manquant', option: 'A' })
  const E = lire(), tE = Date.parse(JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8')).maj) + 1000
  suivi('etape', { tache: 'T02', etape: 'worker', isole: true })
  const F = lire()

  cas('reprise après arbitrage : la tâche n\'attend plus personne, ni une fois tranchée, ni pendant sa reprise', () => {
    assert.equal(M.resumer(C, tA).attention.length, 1, 'avant le run 2, T02 attend un humain')
    assert.deepEqual(M.resumer(E, tE).attention, []); assert.doesNotMatch(M.brut(M.bandeau(E, tE, 140)), /à toi/)
    assert.match(texte(M.lignesTaches(E, tE, 100)), /⚑ T02 .*point tranché, reprise à venir/)
    assert.deepEqual(M.resumer(F, tE).attention, []); assert.match(M.brut(M.bandeau(F, tE, 140)), /◐ T02 réalisation/)
    assert.match(texte(M.lignesTaches(F, tE, 100)), /◐ T02 +Tâche T02 .*réalisation \(worktree\)/)
    assert.equal(M.resumer(F, tE).phases[0].attention, 0)
    // Reprise sans arbitrage dans ce run (tâche bloquée relancée, point réglé ailleurs) : l'étape suffit
    const brutF = JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8'))
    brutF.runs.at(-1).arbitrages_appliques = []
    const R = M.normaliser(brutF)
    assert.deepEqual(M.resumer(R, tE).attention, []); assert.equal(M.resumer(R, tE).phases[0].attention, 0)
    assert.equal(M.resumer(R, R.maj + M.SILENCE_MS + 1000).attention.length, 1, 'run silencieux : la tâche attend de nouveau')
  })

  suivi('cloture', { tache: 'T02', statut: 'fusionnée', essais: 2, branche: 'tache/T02' })
  suivi('etape', { tache: 'T03', etape: 'worker', isole: true })
  const G2 = lire()
  suivi('cloture', { tache: 'T03', statut: 'fusionnée', essais: 1, branche: 'tache/T03' })
  suivi('cloture', { tache: 'T04', statut: 'fusionnée', essais: 1, branche: 'tache/T04' })
  suivi('fin-run', { statut: 'terminé', phase: 2, mode: 'auto', points_a_trancher: [], taches: [], non_lancees: [], reportees: [], taches_ajoutees: [], arbitrages_appliques: [], decisions_office: [], amendements_ecartes: [], en_attente: [], en_attente_prerequis: [] })
  const H = lire()

  cas('run en mode auto : le bandeau suit la phase atteinte, la fin de run nomme les phases, chaque phase a sa durée', () => {
    assert.equal(G2.run.phase, 1, 'run.phase reste la phase de départ')
    assert.match(M.brut(M.bandeau(G2, tE, 140)), /^▶ demo {2}●◉ /)
    assert.equal(M.phaseDuRun(E), 1, 'avant toute étape, la phase de départ')
    assert.match(M.brut(M.bandeau(H, tE, 140)), /^✓ demo {2}●● {2}\S+ {2}4\/4 /)
    assert.ok(M.changements(G2, H).includes('Run 2 (phases 1 à 2) : terminé'), M.changements(G2, H).join(' | '))
    assert.ok(M.changements(B, C).includes('Run 1 (phase 1) : arbitrage'), 'un run d\'une phase garde « phase 1 »')
    assert.notEqual(M.phasesDe(H, tE)[1].duree, null, 'la phase 2 a une durée, bien que run.phase vaille 1')
    // Plan fini : la suite est le brouillon de PR ; la ligne d'état reste tant qu'il y a des relectures
    const suite = M.carteRun(H, tE, 100, false).lignes.flat().find(m => m.x)
    assert.deepEqual([suite.x.touche, suite.x.prompt], ['p', M.textePR(H, tE)])
    assert.equal(M.ligneEtat(H, tE), 'orchestre ✓ 4/4 · ⚑ 3'); assert.equal(M.ligneEtat({ ...H, relectures: [] }, tE), null)
  })

  cas('bandeau : tient dans la largeur donnée, place du bouton comprise, en gardant l\'essentiel', () => {
    const tard = (A.maj ?? 0) + M.SILENCE_MS + 60000
    for (const [X, t, reserve] of [[A, tA, 0], [C, tA, 12], [A, tard, 0], [H, tE, 12]]) {
      for (const w of [160, 140, 120, 110, 100, 90, 80, 70, 62, 60, 50, 40, 20]) {
        const l = M.bandeau(X, t, w, reserve)
        // Sur ce petit plan, la forme la plus courte tient en 50 cellules ; en deçà, l'affichage coupe la fin
        if (w - reserve >= 50) assert.ok(M.largeur(l) <= w - reserve, `${w} - ${reserve} : ${M.largeur(l)} « ${M.brut(l)} »`)
        assert.match(M.brut(l), /^[▶■✓◌] demo {2}[●◉○]+ /, 'nom et phases toujours là')
        assert.match(M.brut(l), /\d\/\d+/, 'avancement toujours là')
      }
    }
    assert.match(M.brut(M.bandeau(C, tA, 160, 24)), /⚠ 1 à toi {2}run 1 arbitrage {2}⏱ \d+ (s|min)$/)
    assert.match(M.brut(M.bandeau(C, tA, 62, 12)), /⚠ 1 {2}(run 1 )?arbitrage$/, 'en 50 cellules : ce qui attend et le statut du run, sans la durée')
    const serre = M.bandeau(C, tA, 50, 12)
    assert.ok(M.largeur(serre) <= 38, M.brut(serre)); assert.match(M.brut(serre), /⚠ 1 {2}arbitrage$/, 'en 38 : le statut sans le numéro du run')
  })

  cas('couleurs : barre par statut, une case par tâche, points de phase, pastilles', () => {
    const classes = M.bandeau(C, tA, 140).filter(m => /^[█░▓]+$/.test(m.t))
    assert.deepEqual(classes.map(m => [m.c, [...m.t].length]), [['success', 3], ['warning', 3], ['subtle', 6]], 'T01 fusionnée, T02 attend un humain, T03 et T04 à faire')
    // « à relire » et « à toi » sont des boutons vers la carte « À toi » ; leur glyphe garde la couleur
    const l = M.bandeau(C, tA, 140)
    assert.deepEqual([l.find(m => /à toi/.test(m.t)), l.find(m => /à relire/.test(m.t))].map(m => [m?.a, m?.k]), [['toi', 'toi'], ['toi', 'relire']], 'les deux mènent à la carte À toi')
    assert.deepEqual(l.filter(m => m.t === '⚠ ' || m.t === '⚑ ').map(m => [m.t, m.c, !!m.b]), [['⚑ ', 'warning', false], ['⚠ ', 'warning', true]])
    // Gros plan : en proportion, chaque statut présent garde au moins une case
    const doc = JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8'))
    doc.taches = Array.from({ length: 124 }, (_, i) => ({ ...doc.taches[0], id: `T${i + 1}`, phase: Math.floor(i / 12) + 1, statut: i < 60 ? 'fusionnée' : i === 60 ? 'échec' : 'à-faire', etape: null }))
    const G = M.normaliser(doc)
    const barre = M.barreClasses(G.taches, t => (t.statut === 'fusionnée' ? 0 : t.statut === 'échec' ? 3 : 4), 14, tA, false)
    assert.equal(M.largeur(barre), 14); assert.deepEqual(barre.map(m => m.c), ['success', 'error', 'subtle'])
    assert.equal(M.pointsPhases(M.phasesDe(G, tA), 1), null, '11 phases : pas de points')
    assert.match(M.brut(M.bandeau(G, tA, 140)), /^[■✓] demo {2}phase \d+\/11 /)
    const ph = M.lignesTaches(B, tA, 100).find(l => /Phase 1/.test(M.brut(l)))
    assert.deepEqual(ph.filter(m => /■/.test(m.t)).map(m => [m.c, m.t]), [['success', '■'], ['warning', '■']])
    assert.ok(M.lignesTaches(A, tA, 100).flat().some(m => m.t === 'réalisation' && m.c === 'suggestion' && m.b), 'étape dans sa couleur')
  })

  cas('nouvelle au bout du bandeau : la plus importante de la dernière écriture, vive 5 s, estompée jusqu\'à 10 s', () => {
    const q = Math.max(...B.journal.map(j => j.quand))
    const vive = M.nouvelle(B, q + 1000)
    assert.equal(vive.texte, 'T02 attend un humain', 'le statut l\'emporte sur la relecture et le point notés en même temps')
    assert.match(M.brut(M.bandeau(B, q + 1000, 160)), / {3}⚑ T02 attend un humain$/)
    assert.ok(M.bandeau(B, q + 1000, 160).some(m => m.t === ' T02 attend un humain' && m.b && m.c === 'warning'))
    assert.ok(M.bandeau(B, q + 7000, 160).some(m => m.t === ' T02 attend un humain' && m.d), 'estompée après 5 s')
    assert.equal(M.nouvelle(B, q + 11000), null); assert.doesNotMatch(M.brut(M.bandeau(B, q + 11000, 160)), /T02 attend/)
    // Dates fixées : la clôture de T02 et la fin du run à la même seconde, puis à 3 s d'écart
    const qC = Math.max(...C.journal.map(j => j.quand))
    const C1 = { ...C, journal: C.journal.map(j => ({ ...j, quand: qC })) }
    assert.equal(M.nouvelle(C1, qC).texte, 'T02 attend un humain', 'même seconde que la clôture : le statut l\'emporte')
    const C2 = { ...C, journal: C.journal.map((j, i) => ({ ...j, quand: i === C.journal.length - 1 ? qC + 3000 : qC })) }
    assert.deepEqual([M.nouvelle(C2, qC + 3000).texte, M.nouvelle(C2, qC + 3000).marque.t, M.nouvelle(C2, qC + 3000).marque.c], ['run 1 : arbitrage', '■', 'warning'])
    const qH = Math.max(...H.journal.map(j => j.quand))
    assert.deepEqual([M.nouvelle(H, qH).marque.t, M.nouvelle(H, qH).marque.c], ['✓', 'success'], 'fin de run terminée en vert')
    const fin = texte(M.carteJournal(B, q + 1000, 100, false).lignes)
    assert.match(fin, /T02 : point « Secret manquant »[^\n]*$/, 'la dernière entrée du journal en bas de sa carte')
  })

  cas('animation : la tête tourne, les tâches en cours pulsent et tournent ; rien ne bouge sans anime ni hors d\'un run', () => {
    const tete = t => M.bandeau(A, t, 140, 0, true)[0].t
    assert.notEqual(tete(tA), tete(tA + 100)); assert.match(tete(tA), /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] $/)
    assert.equal(M.bandeau(A, tA, 140)[0].t, '▶ ', 'sans anime, ▶')
    assert.equal(M.bandeau(C, tA, 140, 0, true)[0].t, '■ ', 'run fini : pas de spinner')
    const enCours = t => M.bandeau(A, t, 140, 0, true).find(m => m.c === 'suggestion' && /^[█▓]+$/.test(m.t)).t[0]
    assert.deepEqual(new Set([0, 450, 900, 1350].map(k => enCours(tA + k))), new Set(['█', '▓']), 'les tâches en cours pulsent')
    const g = t => M.lignesTaches(A, t, 100, true).find(l => /T01/.test(M.brut(l)) && !/Phase/.test(M.brut(l)))[1].t
    assert.notEqual(g(tA), g(tA + M.IMAGE_MS)); assert.match(g(tA), /^[◐◓◑◒]$/)
    // Tâche tout juste fusionnée : quelques secondes en vert, avec une pastille
    const T01 = B.taches.find(t => t.id === 'T01')
    const ligne = M.lignesTaches(B, T01.fin + 1000, 100).find(l => /T01/.test(M.brut(l)) && /fusionnée/.test(M.brut(l)))
    assert.ok(ligne && ligne.some(m => m.f === 'success'), 'pastille « fusionnée »')
    assert.ok(!M.lignesTaches(B, T01.fin + 6000, 100).some(l => / fusionnée $/.test(l.at(-1)?.t ?? '')), 'plus après 5 s')
  })

  cas('notifications qui demandent quelqu\'un : affichées plus longtemps', () => {
    for (const m of ['⚑ T02 attend un humain', '✗ T03 bloquée', '✗ T03 en échec', 'Run arrêté : T02, Secret manquant', 'Run 2 (phase 1) : erreur']) assert.ok(M.importante(m), m)
    for (const m of ['⚑ T01 : à relire avant la PR', 'Phase 1 terminée', 'Run 1 lancé : phase 1, mode auto', 'Run 1 (phase 1) : arbitrage', 'Run 2 (phases 1 à 2) : terminé']) assert.ok(!M.importante(m), m)
    assert.ok(M.DUREE_IMPORTANTE_MS > 4000)
  })

  cas('frise des étapes, temps par étape, ce qui a changé pendant ton absence (sur la démo)', () => {
    const T = Date.parse('2026-10-09T10:00:00Z'), t = D.instantDuPas(11, T) + 500, I = D.instantaneDemo(11, T)
    const etapes = id => M.etapesDe(I, I.taches.find(x => x.id === id), t).map(e => e[2])
    assert.deepEqual([etapes('T01'), etapes('T02'), etapes('T03')], [['worker', 'vérification', 'évaluation', 'fusion'], ['worker', 'vérification', 'correction', 'vérification', 'fusion'], ['worker', 'vérification']])
    assert.deepEqual(M.tempsParEtape(I, t).map(e => e[0]), ['worker', 'vérification', 'évaluation', 'correction', 'fusion'])
    const T02 = M.lignesTaches(I, t, 100).find(l => l.some(m => m.t.trim() === 'T02'))
    assert.deepEqual(T02.filter(m => /━/.test(m.t)).map(m => m.c), ['suggestion', 'merged', 'warning', 'merged', 'success'], 'une couleur par étape, dans l\'ordre')
    const T03 = M.lignesTaches(I, t, 100).find(l => l.some(m => m.t.trim() === 'T03'))
    assert.match(T03.filter(m => /^[━·]+$/.test(m.t)).at(-1).t, /^·+$/, 'T03 s\'arrête à sa clôture, avant la fin du run')
    assert.match(texte(M.carteRun(I, t, 100, false).lignes), /^étapes {2}réal \d+:\d\d · vérif \d+:\d\d · éval \d+:\d\d · corr \d+:\d\d · fusion \d+:\d\d$/m)
    const I20 = D.instantaneDemo(20, T), fin = D.instantDuPas(20, T) + 60000
    assert.equal(M.brut(M.depuis(I20, D.instantDuPas(12, T), fin)), '↩ Depuis 1 min : ✓ T03 T05 T04 fusionnées · ⚑ 2 relectures · run 2 terminé')
    assert.equal(M.brut(M.depuis(I, T - 1, D.instantDuPas(11, T) + 60000)), '↩ Depuis 1 min : ✓ T01 T02 fusionnées · ⚠ T03 t\'attend · ⚑ 1 relecture · run 1 arbitrage')
    assert.equal(M.depuis(I20, D.instantDuPas(20, T) - 1000, D.instantDuPas(20, T) + 29000), null, 'moins d\'une minute, même avec du nouveau : rien')
    assert.equal(M.depuis(I20, D.instantDuPas(20, T), fin), null, 'rien de nouveau depuis le dernier pas : rien')
    // La légende de la démo, en tête du panneau
    const en = M.panneau(D.instantaneDemo(10, T), D.instantDuPas(10, T), 100).entete.map(M.brut)
    assert.ok(en.includes('pas 11/21 · T03 attend un humain'), en.join(' | ')); assert.ok(en.some(l => /^→ la carte « À toi » est en tête/.test(l)))
    assert.equal(M.normaliser(D.docDemo(3, T)).legende, null)
  })

  cas('modèle dans les cartes des tâches (0.11.0) : utilisé, « prévu → utilisé » quand ils diffèrent, prévu estompé avant le worker ; journal', () => {
    const T = Date.parse('2026-10-09T10:00:00Z'), t4 = D.instantDuPas(4, T) + 500, I = D.instantaneDemo(4, T)
    // La ligne d'une tâche (« ··◐ T02 … »), pas celle de sa phase
    const ligne = (X, id, w = 100, t = t4) => M.lignesTaches(X, t, w).find(l => M.brut(l).match(/^ {2}\S (\S+)/)?.[1] === id)
    // T02 corrigée sur opus, choisi par le replanificateur ; T01 sur son modèle ; T03 pas encore lancée
    const l2 = ligne(I, 'T02')
    assert.deepEqual(l2.filter(m => /sonnet|opus/.test(m.t)).map(m => [m.t, m.c ?? null, !!m.b, !!m.d]), [['sonnet → ', null, false, true], ['opus', 'merged', true, false]])
    assert.deepEqual(ligne(I, 'T01').filter(m => /sonnet/.test(m.t)).map(m => [m.t, m.c, !!m.d]), [['sonnet', 'subtle', false]])
    const l3 = ligne(I, 'T03')
    assert.deepEqual(l3.filter(m => /sonnet/.test(m.t)).map(m => [m.t, !!m.d]), [['sonnet', true]], 'prévu, estompé')
    assert.equal(M.brut(l3).indexOf('sonnet'), M.brut(ligne(I, 'T01')).indexOf('sonnet'), 'même colonne qu\'une ligne détaillée')
    assert.match(M.brut(l2), /sonnet → opus {2}correction essai 2 \(worktree\)$/)
    // Phase 2 : la documentation sur haiku
    const I16 = D.instantaneDemo(16, T)
    assert.ok(ligne(I16, 'T05', 100, D.instantDuPas(16, T) + 500).some(m => m.t === 'haiku' && m.c === 'subtle'))
    // Le plan ne prévoyait pas de modèle : « — → sonnet »
    const sans = { ...I, taches: I.taches.map(x => (x.id === 'T01' ? { ...x, modele: null } : x)) }
    assert.match(M.brut(ligne(sans, 'T01')), /— → sonnet/)
    // Aucun modèle connu (suivi.json reconstruit d'un plan sans modèles) : pas de colonne, la frise garde sa largeur
    const aucun = { ...I, taches: I.taches.map(x => ({ ...x, modele: null, modeleUtilise: null })) }
    for (const id of ['T01', 'T02', 'T03']) assert.doesNotMatch(M.brut(ligne(aucun, id)), /sonnet|opus|→/)
    const friseDe = l => l.filter(m => /^[━╸·]+$/.test(m.t)).reduce((n, m) => n + [...m.t].length, 0)
    assert.equal(friseDe(ligne(aucun, 'T01')), 26); assert.equal(friseDe(ligne(I, 'T01')), 11, 'à 100 colonnes, la colonne du modèle se prend sur la frise')
    assert.equal(friseDe(ligne(I, 'T01', 160)), 26, 'à 160 colonnes, la frise garde sa largeur')
    // La colonne ne rallonge aucune ligne au-delà de la largeur ; en deçà de 75 colonnes (60 et sa largeur), elle disparaît
    for (const w of [140, 120, 100, 80, 75, 74, 60, 50]) {
      const avec = M.lignesTaches(I, t4, w), sansM = M.lignesTaches(aucun, t4, w)
      avec.forEach((l, i) => assert.ok(M.largeur(l) <= Math.max(w, M.largeur(sansM[i])), `${w} : ${M.largeur(l)} « ${M.brut(l)} »`))
    }
    assert.match(M.brut(ligne(I, 'T02', 75)), /sonnet → opus/); assert.doesNotMatch(M.brut(ligne(I, 'T02', 74)), /sonnet|opus/)
    assert.deepEqual(M.lignesTaches(I, t4, 60).map(M.brut), M.lignesTaches(aucun, t4, 60).map(M.brut), 'trop étroit : comme sans modèle')
    assert.equal(M.brut(ligne(I, 'T02')).length - M.brut(ligne(I, 'T02')).indexOf('correction'), M.brut(ligne(aucun, 'T02')).length - M.brut(ligne(aucun, 'T02')).indexOf('correction'))
    // Le journal : le changement de modèle, son glyphe ; /suivi texte le montre aussi
    const j = M.carteJournal(I, t4, 100, true).lignes.find(l => /sonnet → opus/.test(M.brut(l)))
    assert.ok(j && j.some(m => m.t === '⇄' && m.c === 'merged'), 'glyphe du journal')
    assert.match(M.brut(j), /T02 +⇄ T02 : sonnet → opus \(l'erreur touche le formulaire et l'API\)$/)
    assert.match(M.texteEtat(I, t4), /T02 .*sonnet → opus/)
    assert.equal(M.nouvelle(I, t4)?.genre, 'refus', 'le refus fait la nouvelle, pas le changement de modèle noté à la même seconde')
  })

  cas('mise en forme : durées, âges, barre, coupe', () => {
    assert.deepEqual([M.duree(45000), M.duree(18 * 60000), M.duree(72 * 60000), M.duree(null)], ['45 s', '18 min', '1 h 12', '—'])
    assert.deepEqual([M.chrono(42000), M.chrono(725000), M.chrono(3723000), M.chrono(null)], ['0:42', '12:05', '1:02:03', '—'])
    assert.equal(M.age(0, 3 * 86400000), '3 j'); assert.equal(M.barre(1, 4, 8), '██░░░░░░'); assert.equal(M.court('abcdef', 4), 'abc…')
  })

  cas('démo (tests/demo-suivi.mjs) : deux runs joués par le vrai suivi.mjs, sans pause hors d\'un terminal', () => {
    const r = spawnSync(process.execPath, [resolve('tests/demo-suivi.mjs'), join(racine, 'demo'), '--pas', '0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stdout, /^ 1\. .*\n +bandeau .*\n +notification/m, 'premier suivi.json : rien à notifier')
    for (const attendu of ['notification Run 2 lancé : phase 1, mode auto', 'notification ⚑ T03 attend un humain', 'notification Run arrêté : T03, Clé SMTP de test', 'notification Phase 1 terminée', 'notification Run 2 (phases 1 à 2) : terminé']) assert.ok(r.stdout.includes(attendu), attendu)
    assert.match(r.stdout, /^17\. .*\n +bandeau +▶ demo {2}●◉ /m)
    const Z = M.normaliser(JSON.parse(readFileSync(join(racine, 'demo', 'plans', 'demo', 'suivi.json'), 'utf8')))
    assert.deepEqual([Z.runs.length, Z.run.statut, Z.taches.filter(t => t.statut === 'fusionnée').length, Z.relectures.length, Z.decisions.length], [2, 'terminé', 5, 3, 1])
    const deja = spawnSync(process.execPath, [resolve('tests/demo-suivi.mjs'), join(racine, 'demo')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(deja.status, 1, 'dossier existant refusé'); assert.match(deja.stderr, /existe déjà/)
    notifsScript = [...r.stdout.matchAll(/^ +notification (.*)$/gm)].map(x => x[1])
  })

  cas('/suivi demo : chaque pas suit le schéma du contrat, et annonce les mêmes notifications que le vrai suivi.mjs', () => {
    const T = Date.parse('2026-10-09T10:00:00Z')
    for (let k = 0; k < D.NB_PAS; k++) {
      const f = join(racine, `demo-${k}.json`)
      assert.equal(D.docDemo(k, T).format, 'orchestre-suivi/2', 'au format qu\'écrit suivi.mjs, pas un /1 qu\'il migrerait')
      writeFileSync(f, JSON.stringify(D.docDemo(k, T)))
      const v = spawnSync(process.execPath, [SUIVI, 'valider', '--fichier', f], { encoding: 'utf8' })
      assert.equal(v.status, 0, `pas ${k} : ${v.stderr}`)
    }
    /** @type {string[]} */
    const notifs = []
    let avant = null
    for (let k = 0; k < D.NB_PAS; k++) { const apres = D.instantaneDemo(k, T); notifs.push(...M.changements(avant, apres)); avant = apres }
    assert.ok(notifsScript.length >= 8, notifsScript.join(' | '))
    assert.deepEqual(notifs, notifsScript, 'mêmes notifications que tests/demo-suivi.mjs, joué par le vrai suivi.mjs')
    // Même journal, entrée pour entrée, hors la reconstruction du premier suivi.json
    const vrai = JSON.parse(readFileSync(join(racine, 'demo', 'plans', 'demo', 'suivi.json'), 'utf8')).journal.filter(j => !/^suivi\.json reconstruit/.test(j.texte))
    assert.deepEqual(D.docDemo(D.NB_PAS - 1, T).journal.map(j => `${j.genre} | ${j.texte}`), vrai.map(j => `${j.genre} | ${j.texte}`))
    assert.deepEqual([avant.runs.length, avant.run.statut, avant.taches.filter(t => t.statut === 'fusionnée').length, avant.relectures.length, avant.decisions.length], [2, 'terminé', 5, 3, 1])
    // Le bandeau dit que c'est une démo
    const b = M.bandeau(D.instantaneDemo(3, T), D.instantDuPas(3, T), 140)
    assert.match(M.brut(b), /^▶  DÉMO  site-vitrine {2}◉○ /); assert.ok(b.some(m => m.t === ' DÉMO ' && m.f === 'merged'))
    assert.equal(M.normaliser(D.docDemo(3, T)).demo, false, 'un vrai suivi.json n\'est jamais une démo')
    // Le temps : un pas toutes les 3 s, une pause de 12 s à l'arrêt du run 1, puis une minute avant le retour au vrai suivi
    assert.deepEqual([D.pasA(T - 1, T), D.pasA(T, T), D.pasA(T + 2999, T), D.pasA(T + 3000, T)], [-1, 0, 0, 1])
    assert.equal(D.instantDuPas(12, T) - D.instantDuPas(11, T), 4 * D.PAS_DEMO_MS)
    assert.equal(D.finDemo(T), D.instantDuPas(D.NB_PAS - 1, T) + 60000, 'le vrai suivi reprend une minute après le dernier pas')
    assert.equal(D.pasA(D.finDemo(T), T), D.NB_PAS - 1)
  })

  console.log(`mod de suivi : TOUT EST VERT (${n} cas)`)
} finally {
  rmSync(racine, { recursive: true, force: true })
}
