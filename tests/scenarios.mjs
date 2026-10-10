import fs from 'node:fs'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
const SRC = process.argv[2]
const src = fs.readFileSync(SRC, 'utf8')
for (const bad of ['Date.now', 'Math.random', 'new Date(', 'require(', 'import ']) assert.ok(!src.includes(bad), `interdit : ${bad}`)
const body = src.replace(/^export const meta = /m, 'const meta = ')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const run = new AsyncFunction('args', 'agent', 'phase', 'log', body)
const ARGS = { plan: 'plans/p', phase: 1, mode: 'phase', parallelisme: 4, integration: 'plan/p', corrections_max: 2, escalade: ['sonnet', 'opus'] }
// T00 sans modèle (plan d'avant la 0.11.0) : worker sur sonnet, corrections selon l'échelle, sans choix du replanificateur ;
// les scénarios M* jouent les tâches qui ont un modèle
const T00 = { id: 'T00', titre: 'Outillage', fichier: 'plans/p/taches/T00.md', phase: 1, depend_de: [], ressources: ['base-locale', 'port-3000'], statut: 'à-faire', verification: ['sh scripts/typecheck.sh', 'sh scripts/e2e-local.sh'] }
const T01 = { id: 'T01', titre: 'Fondations', fichier: 'plans/p/taches/T01.md', phase: 1, modele: 'opus', depend_de: ['T00'], ressources: ['base-locale', 'port-3000'], statut: 'à-faire', verification: ['pnpm test'] }
// Copies : le workflow amende verification et depend_de en mémoire
const plan = (...ts) => ({ ok: true, taches: ts.map(t => ({ ...t })) })
const rap = (n, extra = {}) => ({ statut: 'done', resume: `rapport ${n} : 96/96 trois fois`, branche: 'tache/T00', commit: 'c' + n, chemin: '/repo', decouvertes: [{ categorie: 'Commandes vérifiées', contenu: 'routes préchauffées ' + n }], ecarts: [], ...extra })
const ok = (x) => ({ ok: true, resultats: [{ commande: 'sh scripts/typecheck.sh', code: 0, extrait: 'tsc ' + x }, { commande: 'sh scripts/e2e-local.sh', code: 0, extrait: '96 passed ' + x }] })
const SOK = { ok: true, commit: 's1', refuses: [] }
const FOK = { ok: true, fusionne: true, controle_ok: true, commit: 'm1' }
const RIEN = { majeur: false, entrees: [], points: [] }
const ECART = [{ type: 'écart', description: 'isSuperAdmin optionnel dans UpdateUserSchema' }]
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
let dernier = null
async function scenario(name, q, args = {}) {
  const calls = [], logs = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    const k = opts.label
    if (!(k in q) || !q[k].length) throw new Error(`[${name}] appel inattendu : ${k}`)
    const v = q[k].shift()
    return typeof v === 'function' ? v(prompt, opts) : v
  }
  const res = await run({ ...ARGS, ...args }, agent, () => {}, (m) => logs.push(m))
  dernier = res
  return { res, calls, logs, q }
}
const byLabel = (calls, l) => calls.filter(c => c.opts.label === l)
const idx = (calls, l) => calls.findIndex(c => c.opts.label === l)
const vide = (name, q) => { for (const k in q) assert.equal(q[k].length, 0, `${name} : réponse non consommée pour ${k}`) }
let n = 0
async function cas(nom, fn) {
  dernier = null
  try { await fn(); n++; console.log('ok ·', nom) } catch (e) { console.log('ÉCHEC ·', nom, '\n', JSON.stringify(dernier, null, 1)); throw e }
}
// T00 fusionnée sans histoire, avec des écarts éventuels ; T01 idem
const t00 = (ecarts = [], fusion = FOK) => ({ 'T00 · worker': [rap(0, { ecarts })], 'T00 · vérification': [ok(1)], 'T00 · évaluation': [{ verdict: 'ok' }], 'T00 · fusion': [fusion] })
const t01 = () => ({ 'T01 · worker': [rap(1, { branche: 'tache/T01' })], 'T01 · vérification': [ok(2)], 'T01 · évaluation': [{ verdict: 'ok' }], 'T01 · fusion': [FOK], 'T01 · suivi': [SOK] })
const RP_E = { majeur: true, entrees: [{ type: 'écart', gravite: 'majeur', description: 'contrat élargi' }], points: [{ titre: 'Contrat UpdateUserSchema', contexte: 'isSuperAdmin optionnel', options: [
  { id: 'A', description: 'Garder optionnel et tester la règle (d)', impact: 'un test de plus', recommande: true,
    entrees: [{ type: 'dette', gravite: 'mineur', description: 'documenter le contrat' }],
    taches_ajoutees: [{ id: 'T00C', titre: 'Test règle d', phase: 0, contenu: '---\nid: T00C\nphase: 0\nmodele: sonnet\n---\n' }],
    amendements: [{ id: 'T01', verification: ['pnpm test:regle-d'], definition_du_fini: ['la règle (d) est testée'], raison: 'règle de sécurité sans test' }] },
  { id: 'B', description: 'Rendre le champ obligatoire', impact: 'casse les appels partiels', recommande: false } ] }] }

// ——— Non-régression v0.3 ———
await cas('A : T00 bloquée après 2 refus, T01 non lancée', async () => {
  const { res, calls, q } = await scenario('A', {
    'lecteur-plan': [plan(T00, T01)], 'T00 · worker': [rap(0)],
    'T00 · vérification': [ok(1), ok(2), { ok: false, resultats: [{ commande: 'sh scripts/e2e-local.sh', code: 1, extrait: '95 passed, 1 failed' }], echecs: [{ commande: 'sh scripts/e2e-local.sh', extrait: 'ECONNRESET /healthz' }] }],
    'T00 · évaluation': [{ verdict: 'ko', manques: ['A1', 'A2'] }, { verdict: 'ko', manques: ['B1'] }],
    'T00 · correction 1': [rap(1)], 'T00 · correction 2': [rap(2)],
    'T00 · replanification': [RIEN], 'T00 · suivi': [SOK] })
  const t = res.taches.find(x => x.id === 'T00')
  assert.equal(res.statut, 'partiel'); assert.equal(t.statut, 'bloquée'); assert.equal(t.essais, 3)
  assert.deepEqual(t.blocage, ['sh scripts/e2e-local.sh : ECONNRESET /healthz'])
  assert.deepEqual(t.refus, [{ essai: 1, par: 'évaluation', manques: ['A1', 'A2'] }, { essai: 2, par: 'évaluation', manques: ['B1'] }])
  assert.deepEqual(res.non_lancees, ['T01'])
  assert.equal(byLabel(calls, 'T00 · correction 1')[0].opts.model, 'sonnet'); assert.equal(byLabel(calls, 'T00 · correction 2')[0].opts.model, 'opus')
  const ev = byLabel(calls, 'T00 · évaluation')
  assert.ok(ev[0].prompt.includes('96 passed 1') && !ev[0].prompt.includes('96 passed 2'))
  assert.ok(ev[1].prompt.includes('96 passed 2') && ev[1].prompt.includes('rapport 1 : 96/96') && ev[1].prompt.includes('pas une preuve'))
  const rp = byLabel(calls, 'T00 · replanification')[0]
  assert.equal(rp.opts.model, 'opus'); assert.ok(rp.prompt.includes(', dans /repo') && rp.prompt.includes('plans/p/taches/T00.md'), 'replan : chemin du travail non fusionné')
  const sc = byLabel(calls, 'T00 · suivi')[0]
  assert.ok(sc.opts.schema.required.includes('ok'), 'scribe : schéma')
  assert.ok(sc.prompt.includes('refus · mineur') && sc.prompt.includes('"A1"') && sc.prompt.includes('ce blocage') && !sc.prompt.includes('plan-lint.mjs'), 'scribe : refus et blocage, pas de plan-lint sans création')
  vide('A', q)
})
await cas('B : T00 fusionnée après 1 refus + instable, T01 bloquée par son worker', async () => {
  const { res, calls, q } = await scenario('B', {
    'lecteur-plan': [plan(T00, T01)], 'T00 · worker': [rap(0)],
    'T00 · vérification': [ok(1), { ...ok(2), instables: ['journal.spec.ts:53'] }],
    'T00 · évaluation': [{ verdict: 'ko', manques: ['C1'] }, { verdict: 'ok' }],
    'T00 · correction 1': [rap(1)], 'T00 · fusion': [FOK], 'T00 · suivi': [SOK],
    'T01 · worker': [{ statut: 'blocked', resume: 'bloqué', branche: 'tache/T01', chemin: '/repo', blocage: 'schéma ambigu' }],
    'T01 · replanification': [RIEN], 'T01 · suivi': [SOK] })
  const t0 = res.taches.find(x => x.id === 'T00'), t1 = res.taches.find(x => x.id === 'T01')
  assert.equal(res.statut, 'partiel'); assert.equal(t0.statut, 'fusionnée'); assert.equal(t0.essais, 2); assert.ok(!('blocage' in t0))
  assert.deepEqual(t0.refus, [{ essai: 1, par: 'évaluation', manques: ['C1'] }]); assert.deepEqual(t0.instables, ['journal.spec.ts:53'])
  const sc = byLabel(calls, 'T00 · suivi')[0].prompt
  assert.ok(sc.includes('refus · mineur') && sc.includes('Tests instables') && !sc.includes('ce blocage'))
  assert.equal(t1.statut, 'bloquée'); assert.deepEqual(t1.blocage, ['schéma ambigu'])
  vide('B', q)
})
await cas('C : vérificateur sans réponse puis succès ; intégrateur au format v0.3', async () => {
  const { res, q } = await scenario('C', {
    'lecteur-plan': [plan(T00)], 'T00 · worker': [rap(0)],
    'T00 · vérification': [null, ok(2)], 'T00 · évaluation': [{ verdict: 'ok' }],
    'T00 · correction 1': [rap(1)], 'T00 · fusion': [{ ok: true }], 'T00 · suivi': [SOK] })
  assert.equal(res.statut, 'terminé'); assert.equal(res.taches[0].statut, 'fusionnée')
  assert.deepEqual(res.taches[0].refus, [{ essai: 1, par: 'vérification', manques: ['vérificateur sans réponse'] }])
  vide('C', q)
})
await cas('D : critère non vérifiable → angle mort et replanification, sans KO ni doublon', async () => {
  const NV = 'typecheck.sh depuis un worktree : la tâche tourne dans le checkout principal'
  const { res, calls, q } = await scenario('D', {
    'lecteur-plan': [plan(T00)], 'T00 · worker': [rap(0)],
    'T00 · vérification': [{ ...ok(1), instables: ['journal.spec.ts:53'] }, { ...ok(2), instables: ['journal.spec.ts:53'] }],
    'T00 · évaluation': [{ verdict: 'ko', manques: ['M1'], non_verifiables: [NV] }, { verdict: 'ok', non_verifiables: [NV] }],
    'T00 · correction 1': [rap(1)], 'T00 · fusion': [FOK], 'T00 · replanification': [RIEN], 'T00 · suivi': [SOK] })
  const t = res.taches[0]
  assert.equal(res.statut, 'terminé'); assert.equal(t.statut, 'fusionnée'); assert.deepEqual(t.non_verifiables, [NV])
  assert.ok(byLabel(calls, 'T00 · replanification')[0].prompt.includes(NV), 'replan : critère non vérifiable transmis')
  const sc = byLabel(calls, 'T00 · suivi')[0].prompt
  assert.ok(sc.includes('angle-mort · mineur') && sc.split(NV).length === 2 && sc.split('journal.spec.ts:53').length === 2)
  vide('D', q)
})

// ——— v0.4 : décisions d'office et garde-fous ———
await cas("E : autonome, option recommandée prise d'office (amendement, tâche ajoutée ramenée en phase courante)", async () => {
  const { res, calls, q } = await scenario('E', { 'lecteur-plan': [plan(T00, T01)], ...t00(ECART), 'T00 · replanification': [RP_E], 'T00 · suivi': [SOK], ...t01() }, { mode: 'auto' })
  assert.equal(res.statut, 'à-relancer')
  assert.deepEqual(res.decisions_office, [{ tache: 'T00', titre: 'Contrat UpdateUserSchema', option: 'A', description: 'Garder optionnel et tester la règle (d)' }])
  const rp = byLabel(calls, 'T00 · replanification')[0]
  assert.equal(rp.opts.model, 'opus'); assert.ok(rp.prompt.includes('Mode autonome') && rp.prompt.includes(', fusionnée dans plan/p'))
  const sc = byLabel(calls, 'T00 · suivi')[0].prompt
  for (const x of ["option A prise d'office (mode autonome)", '"id":"T00C"', 'phase: 1', 'pnpm test:regle-d', 'amendement · majeur', 'plan-lint.mjs plans/p --integration plan/p', 'documenter le contrat', 'contrat élargi', 'git checkout HEAD --'])
    assert.ok(sc.includes(x), 'scribe : ' + x)
  assert.ok(!sc.includes('phase: 0'), 'scribe : phase passée corrigée')
  assert.ok(byLabel(calls, 'T01 · vérification')[0].prompt.includes('pnpm test:regle-d'), 'T01 : vérification amendée')
  assert.ok(byLabel(calls, 'T01 · worker')[0].prompt.includes("Garder optionnel et tester la règle (d) (prise d'office)"), 'T01 : décision transmise')
  assert.deepEqual(res.taches_ajoutees, [{ id: 'T00C', phase: 1, titre: 'Test règle d' }])
  vide('E', q)
})
const pt = i => ({ titre: 'P' + i, contexte: '', options: [{ id: 'A', description: 'a' + i, recommande: true }, { id: 'B', description: 'b' + i }] })
await cas('F : coupe-circuit au 4e point (plafond 3 par défaut)', async () => {
  const { res, calls, q } = await scenario('F', { 'lecteur-plan': [plan(T00, T01)], ...t00(ECART), 'T00 · replanification': [{ majeur: true, entrees: [], points: [pt(1), pt(2), pt(3), pt(4)] }], 'T00 · suivi': [SOK] }, { mode: 'auto' })
  assert.equal(res.statut, 'arbitrage'); assert.equal(res.decisions_office.length, 3)
  assert.equal(res.arbitrage.titre, 'P4'); assert.equal(res.arbitrage.coupe_circuit, true); assert.equal(res.arbitrage.humain, false)
  assert.deepEqual(res.non_lancees, ['T01']); assert.equal(idx(calls, 'T01 · worker'), -1)
  vide('F', q)
})
await cas('F2 : plafond transmis à 0, points suivants gardés', async () => {
  const { res, q } = await scenario('F2', { 'lecteur-plan': [plan(T00, T01)], ...t00(ECART), 'T00 · replanification': [{ majeur: true, entrees: [], points: [pt(1), pt(2)] }], 'T00 · suivi': [SOK] }, { mode: 'auto', decisions_office_max: 0 })
  assert.equal(res.statut, 'arbitrage'); assert.equal(res.decisions_office.length, 0)
  assert.equal(res.arbitrage.titre, 'P1'); assert.equal(res.points_a_trancher.length, 1); assert.equal(res.points_a_trancher[0].coupe_circuit, true)
  vide('F2', q)
})
await cas('G : point humain en autonome → arrêt', async () => {
  const { res, calls, q } = await scenario('G', { 'lecteur-plan': [plan(T00, T01)], ...t00(ECART), 'T00 · replanification': [{ majeur: true, entrees: [], points: [{ titre: 'Accès prod', humain: true, options: [] }] }], 'T00 · suivi': [SOK] }, { mode: 'auto' })
  assert.equal(res.statut, 'arbitrage'); assert.equal(res.arbitrage.humain, true); assert.equal(res.arbitrage.titre, 'Accès prod')
  assert.equal(res.decisions_office.length, 0); assert.equal(idx(calls, 'T01 · worker'), -1)
  vide('G', q)
})
await cas('G2 : écart besoin-humain sans point humain → arrêt quand même', async () => {
  const { res, q } = await scenario('G2', { 'lecteur-plan': [plan(T00, T01)], ...t00([{ type: 'besoin-humain', description: 'clé API requise' }]), 'T00 · replanification': [{ majeur: false, entrees: [{ type: 'besoin-humain', gravite: 'majeur', description: 'clé' }], points: [] }], 'T00 · suivi': [SOK] }, { mode: 'auto' })
  assert.equal(res.statut, 'arbitrage'); assert.equal(res.arbitrage.titre, 'Besoin humain signalé par T00'); assert.ok(res.arbitrage.contexte.includes('clé API requise'))
  vide('G2', q)
})
await cas('H : contrôle post-fusion en échec → fusionnée + besoin-humain + arrêt', async () => {
  const { res, calls, q } = await scenario('H', { 'lecteur-plan': [plan(T00, T01)], ...t00([], { ok: false, fusionne: true, controle_ok: false, detail: 'tsc : 2 erreurs' }), 'T00 · suivi': [SOK] }, { mode: 'auto' })
  assert.equal(res.taches[0].statut, 'fusionnée'); assert.equal(res.statut, 'arbitrage')
  assert.equal(res.arbitrage.humain, true); assert.ok(res.arbitrage.titre.includes('Contrôle post-fusion'))
  const sc = byLabel(calls, 'T00 · suivi')[0].prompt
  assert.ok(sc.includes('besoin-humain') && sc.includes('tsc : 2 erreurs') && sc.includes('statut « fusionnée »'))
  assert.deepEqual(res.non_lancees, ['T01']); assert.equal(idx(calls, 'T00 · replanification'), -1)
  vide('H', q)
})
await cas('H2 : conflit de fusion → bloquée', async () => {
  const { res, q } = await scenario('H2', { 'lecteur-plan': [plan(T00)], ...t00([], { ok: false, fusionne: false, conflit: true, detail: 'conflit src/a.ts' }), 'T00 · replanification': [RIEN], 'T00 · suivi': [SOK] })
  assert.equal(res.statut, 'partiel'); assert.equal(res.taches[0].statut, 'bloquée'); assert.deepEqual(res.taches[0].blocage, ['fusion : conflit src/a.ts'])
  vide('H2', q)
})
await cas('I1 : par phase, le point reste à trancher avec ses actions ; tâche ajoutée en phase 2', async () => {
  const rp = { ...RP_E, taches_ajoutees: [{ id: 'T09', titre: 'Doc', phase: 2, contenu: '---\nid: T09\nphase: 2\n---' }] }
  const { res, calls, q } = await scenario('I1', { 'lecteur-plan': [plan(T00, T01)], ...t00(ECART), 'T00 · replanification': [rp], 'T00 · suivi': [SOK], ...t01() })
  assert.equal(res.statut, 'terminé'); assert.equal(res.points_a_trancher.length, 1); assert.equal(res.decisions_office.length, 0)
  assert.equal(res.points_a_trancher[0].options[0].amendements[0].id, 'T01', 'actions gardées pour args.arbitrages')
  assert.equal(byLabel(calls, 'T00 · replanification')[0].opts.model, 'opus')
  assert.ok(!byLabel(calls, 'T01 · vérification')[0].prompt.includes('pnpm test:regle-d'), 'rien appliqué sans arbitrage')
  assert.deepEqual(res.taches_ajoutees, [{ id: 'T09', phase: 2, titre: 'Doc' }])
  vide('I1', q)
})
await cas('I2 : arrêt sur déviation', async () => {
  const { res, q } = await scenario('I2', { 'lecteur-plan': [plan(T00, T01)], ...t00(ECART), 'T00 · replanification': [RP_E], 'T00 · suivi': [SOK] }, { mode: 'devia' })
  assert.equal(res.statut, 'arbitrage'); assert.equal(res.arbitrage.titre, 'Contrat UpdateUserSchema'); assert.deepEqual(res.non_lancees, ['T01'])
  vide('I2', q)
})
const ARB = [{ tache: 'T02', titre: 'Contrat', option: { id: 'B', description: 'Tester la règle d', entrees: [{ type: 'dette', gravite: 'mineur', description: 'x' }], amendements: [{ id: 'T01', verification: ['pnpm test:d'], raison: 'r' }], taches_ajoutees: [{ id: 'T01B', titre: 'Doc', phase: 0, contenu: '---\nid: T01B\nphase: 0\n---' }] } }]
await cas("J : arbitrage de l'utilisateur appliqué par le scribe avant la lecture du plan", async () => {
  const { res, calls, q } = await scenario('J', { 'arbitrage T02 · suivi': [SOK], 'lecteur-plan': [plan(T00)], ...t00(), 'T00 · suivi': [SOK] }, { arbitrages: ARB })
  assert.equal(idx(calls, 'arbitrage T02 · suivi'), 0); assert.equal(idx(calls, 'lecteur-plan'), 1)
  const sc = byLabel(calls, 'arbitrage T02 · suivi')[0].prompt
  for (const x of ["option B arbitrée par l'utilisateur", 'pnpm test:d', 'phase: 1', '## T02', 'plan-lint.mjs', 'arbitrage B']) assert.ok(sc.includes(x), 'arbitrage : ' + x)
  assert.ok(byLabel(calls, 'T00 · worker')[0].prompt.includes("Tester la règle d (arbitré par l'utilisateur)"))
  assert.deepEqual(res.arbitrages_appliques, [{ tache: 'T02', titre: 'Contrat', option: 'B' }]); assert.equal(res.statut, 'terminé')
  vide('J', q)
})
await cas('J2 : arbitrage refusé par plan-lint → arrêt, rien lu', async () => {
  const { res, calls, q } = await scenario('J2', { 'arbitrage T02 · suivi': [{ ok: true, commit: 'x', refuses: [{ id: 'T01', raison: 'plan-lint : dépendance inconnue' }] }] }, { arbitrages: ARB })
  assert.equal(res.statut, 'arbitrage'); assert.equal(res.arbitrage.humain, true); assert.deepEqual(res.arbitrages_appliques, [{ tache: 'T02', titre: 'Contrat', option: 'B' }])
  assert.equal(res.arbitrage.titre, 'Arbitrage « Contrat » appliqué en partie')
  assert.equal(idx(calls, 'lecteur-plan'), -1)
  vide('J2', q)
})
await cas('J3 : scribe sans réponse sur un arbitrage', async () => {
  const { res, q } = await scenario('J3', { 'arbitrage T02 · suivi': [null] }, { arbitrages: ARB })
  assert.equal(res.statut, 'arbitrage'); assert.deepEqual(res.arbitrages_appliques, []); assert.equal(res.arbitrage.titre, 'Arbitrage « Contrat » non appliqué')
  vide('J3', q)
})
await cas('K : amendement refusé par le scribe en clôture → arrêt', async () => {
  const { res, calls, q } = await scenario('K', { 'lecteur-plan': [plan(T00, T01)], ...t00(ECART), 'T00 · replanification': [RP_E], 'T00 · suivi': [{ ok: true, commit: 's', refuses: [{ id: 'T01', raison: 'plan-lint' }] }] }, { mode: 'auto' })
  assert.equal(res.statut, 'arbitrage'); assert.ok(res.arbitrage.titre.includes('refusés')); assert.equal(idx(calls, 'T01 · worker'), -1)
  vide('K', q)
})
await cas('K2 : scribe sans réponse → arrêt', async () => {
  const { res, q } = await scenario('K2', { 'lecteur-plan': [plan(T00, T01)], ...t00(), 'T00 · suivi': [null] }, { mode: 'auto' })
  assert.equal(res.statut, 'arbitrage'); assert.equal(res.arbitrage.titre, 'Suivi de T00 non commité')
  vide('K2', q)
})
await cas('L : deux options recommandées → arrêt sans décision', async () => {
  const p2 = { titre: 'X', options: [{ id: 'A', description: 'a', recommande: true }, { id: 'B', description: 'b', recommande: true }] }
  const { res, q } = await scenario('L', { 'lecteur-plan': [plan(T00, T01)], ...t00(ECART), 'T00 · replanification': [{ majeur: true, entrees: [], points: [p2] }], 'T00 · suivi': [SOK] }, { mode: 'auto' })
  assert.equal(res.statut, 'arbitrage'); assert.equal(res.arbitrage.titre, 'X'); assert.ok(!res.arbitrage.coupe_circuit); assert.equal(res.decisions_office.length, 0)
  vide('L', q)
})
await cas('L2 : aucune option recommandée → arrêt sans décision', async () => {
  const p0 = { titre: 'Y', options: [{ id: 'A', description: 'a' }, { id: 'B', description: 'b' }] }
  const { res, q } = await scenario('L2', { 'lecteur-plan': [plan(T00, T01)], ...t00(ECART), 'T00 · replanification': [{ majeur: true, entrees: [], points: [p0] }], 'T00 · suivi': [SOK] }, { mode: 'auto' })
  assert.equal(res.statut, 'arbitrage'); assert.equal(res.arbitrage.titre, 'Y'); assert.equal(res.decisions_office.length, 0)
  vide('L2', q)
})
await cas('M : amendements visant une tâche faite ou en cours → écartés et consignés', async () => {
  const rp = { majeur: true, entrees: [], points: [{ titre: 'Z', options: [{ id: 'A', description: 'a', recommande: true, amendements: [{ id: 'T00', verification: ['x'], raison: 'r0' }, { id: 'T01', verification: ['y'], raison: 'r1' }] }] }] }
  const { res, calls, q } = await scenario('M', { 'lecteur-plan': [plan({ ...T00, statut: 'fusionnée' }, T01)], 'T01 · worker': [rap(1, { branche: 'tache/T01', ecarts: ECART })], 'T01 · vérification': [ok(2)], 'T01 · évaluation': [{ verdict: 'ok' }], 'T01 · fusion': [FOK], 'T01 · replanification': [rp], 'T01 · suivi': [SOK] }, { mode: 'auto' })
  assert.equal(res.statut, 'terminé'); assert.equal(res.decisions_office.length, 1)
  assert.deepEqual(res.amendements_ecartes.map(a => [a.tache, a.id]), [['T01', 'T00'], ['T01', 'T01']])
  const sc = byLabel(calls, 'T01 · suivi')[0].prompt
  assert.ok(sc.includes('amendement non appliqué') && !sc.includes('Amendements, pour des tâches pas encore lancées'))
  vide('M', q)
})
await cas('N : nouvelle dépendance vers une tâche ajoutée → tâche reportée au prochain run', async () => {
  const rp = { majeur: true, entrees: [], points: [{ titre: 'Préalable', options: [{ id: 'A', description: 'ajouter T00D', recommande: true, taches_ajoutees: [{ id: 'T00D', titre: 'Préalable', phase: 1, contenu: '---\nid: T00D\nphase: 1\n---' }], amendements: [{ id: 'T01', depend_de: ['T00D'], raison: 'préalable' }] }] }] }
  const { res, calls, q } = await scenario('N', { 'lecteur-plan': [plan(T00, T01)], ...t00(ECART), 'T00 · replanification': [rp], 'T00 · suivi': [SOK] }, { mode: 'auto' })
  assert.equal(res.statut, 'à-relancer'); assert.deepEqual(res.reportees, ['T01']); assert.deepEqual(res.non_lancees, []); assert.equal(idx(calls, 'T01 · worker'), -1)
  vide('N', q)
})
await cas('O : replanificateur sans réponse → écarts notés majeurs, arrêt', async () => {
  const { res, calls, q } = await scenario('O', { 'lecteur-plan': [plan(T00, T01)], ...t00(ECART), 'T00 · replanification': [null], 'T00 · suivi': [SOK] }, { mode: 'auto' })
  assert.equal(res.statut, 'arbitrage'); assert.equal(res.arbitrage.titre, 'Replanification de T00 sans réponse')
  const sc = byLabel(calls, 'T00 · suivi')[0].prompt
  assert.ok(sc.includes('(non classé : replanificateur sans réponse)') && sc.includes('"gravite":"majeur"'))
  assert.deepEqual(res.non_lancees, ['T01'])
  vide('O', q)
})
await cas('P : une tâche amendée attend que le suivi soit commité', async () => {
  const A0 = { ...T00, ressources: [] }, B2 = { ...T00, id: 'T02', titre: 'Autre', fichier: 'plans/p/taches/T02.md', ressources: [], verification: ['pnpm test:t02'] }, C1 = { ...T01, ressources: [], depend_de: ['T02'] }
  const e1 = deferred(), e2 = deferred(), ordre = []
  const rp = { majeur: true, entrees: [], points: [{ titre: 'Course', options: [{ id: 'A', description: 'tester', recommande: true, amendements: [{ id: 'T01', verification: ['pnpm test:course'], raison: 'r' }] }] }] }
  const { res, calls, q } = await scenario('P', {
    'lecteur-plan': [plan(A0, B2, C1)],
    'T00 · worker': [rap(0, { ecarts: ECART, chemin: '/wt/T00' })], 'T00 · vérification': [ok(1)], 'T00 · évaluation': [{ verdict: 'ok' }], 'T00 · fusion': [FOK],
    'T02 · worker': [rap(2, { branche: 'tache/T02', chemin: '/wt/T02' })], 'T02 · vérification': [ok(2)], 'T02 · évaluation': [{ verdict: 'ok' }], 'T02 · fusion': [FOK],
    'T02 · suivi': [async () => { e1.resolve(); await e2.promise; return SOK }],
    'T00 · replanification': [async () => { await e1.promise; setTimeout(() => e2.resolve(), 0); return rp }],
    'T00 · suivi': [async () => { await new Promise(r => setTimeout(r, 20)); ordre.push('fin T00 suivi'); return SOK }],
    'T01 · worker': [() => { ordre.push('T01 worker'); return rap(1, { branche: 'tache/T01' }) }], 'T01 · vérification': [ok(3)], 'T01 · évaluation': [{ verdict: 'ok' }], 'T01 · fusion': [FOK], 'T01 · suivi': [SOK] }, { mode: 'auto' })
  assert.deepEqual(ordre, ['fin T00 suivi', 'T01 worker'])
  assert.ok(byLabel(calls, 'T01 · vérification')[0].prompt.includes('pnpm test:course'))
  assert.equal(res.statut, 'terminé')
  vide('P', q)
})
await cas('Q : tâche annulée comptée comme faite', async () => {
  const { res, q } = await scenario('Q', { 'lecteur-plan': [plan({ ...T00, statut: 'annulée' }, T01)], ...t01() })
  assert.equal(res.statut, 'terminé'); assert.deepEqual(res.taches.map(t => t.id), ['T01'])
  vide('Q', q)
})
await cas('E2 : en phase 2, une tâche proposée en phase 1 est ramenée en phase 2', async () => {
  const P2 = t => ({ ...t, phase: 2 })
  const rp = { majeur: true, entrees: [], points: [{ titre: 'Rattrapage', options: [{ id: 'A', description: 'ajouter T00E', recommande: true, taches_ajoutees: [{ id: 'T00E', titre: 'Rattrapage', phase: 1, contenu: '---\nid: T00E\nphase: 1\n---' }] }] }] }
  const { res, calls, q } = await scenario('E2', { 'lecteur-plan': [plan(P2(T00))], ...t00(ECART), 'T00 · replanification': [rp], 'T00 · suivi': [SOK] }, { mode: 'auto', phase: 2 })
  assert.equal(res.statut, 'à-relancer'); assert.deepEqual(res.taches_ajoutees, [{ id: 'T00E', phase: 2, titre: 'Rattrapage' }])
  const sc = byLabel(calls, 'T00 · suivi')[0].prompt
  assert.ok(sc.includes('phase: 2') && !sc.includes('phase: 1'), 'contenu : phase corrigée')
  vide('E2', q)
})

// ——— v0.5 : garde-fous vus en réel ———
await cas('S1 : écart sensible sans point → arrêt humain, entrée forcée en majeur', async () => {
  const ec = [{ type: 'décision', description: 'le test tourne sur la base de dev mission_space' }]
  const { res, calls, q } = await scenario('S1', { 'lecteur-plan': [plan(T00, T01)], ...t00(ec), 'T00 · replanification': [{ majeur: false, entrees: [{ type: 'décision', gravite: 'mineur', description: 'test sur la base de dev' }], points: [] }], 'T00 · suivi': [SOK] }, { mode: 'auto' })
  assert.equal(res.statut, 'arbitrage'); assert.equal(res.arbitrage.humain, true); assert.ok(res.arbitrage.titre.includes('Écart sensible'))
  const rp = byLabel(calls, 'T00 · replanification')[0].prompt
  assert.ok(rp.includes("majeurs d'office") && rp.includes('base de dev mission_space'), 'replan : écart sensible listé')
  assert.ok(byLabel(calls, 'T00 · suivi')[0].prompt.includes('"gravite":"majeur","description":"test sur la base de dev"'), 'entrée forcée en majeur')
  assert.equal(res.taches[0].statut, 'fusionnée')
  vide('S1', q)
})
await cas('S1b : écart sensible avec un point, par phase → point à trancher, pas d\'arrêt', async () => {
  const ec = [{ type: 'écart', description: 'restauration du dump prod à répéter' }]
  const { res, calls, q } = await scenario('S1b', { 'lecteur-plan': [plan(T00, T01)], ...t00(ec), 'T00 · replanification': [RP_E], 'T00 · suivi': [SOK], ...t01() })
  assert.equal(res.statut, 'terminé'); assert.equal(res.points_a_trancher.length, 1)
  assert.ok(!byLabel(calls, 'T01 · replanification').length)
  vide('S1b', q)
})
await cas('S1c : écart ordinaire → pas de liste d\'écarts sensibles', async () => {
  const { calls, q } = await scenario('S1c', { 'lecteur-plan': [plan(T00)], ...t00(ECART), 'T00 · replanification': [RIEN], 'T00 · suivi': [SOK] })
  assert.ok(!byLabel(calls, 'T00 · replanification')[0].prompt.includes("majeurs d'office"))
  vide('S1c', q)
})
await cas("S2 : décision d'office qui cite une tâche inexistante → arrêt, rien appliqué", async () => {
  const rp = { majeur: true, entrees: [], points: [{ titre: 'Code 1 accepté', options: [{ id: 'A', description: 'borner la décision ; T06B fournira le script', recommande: true, entrees: [{ type: 'décision', gravite: 'majeur', description: 'script livré par T06B' }] }, { id: 'B', description: 'autre' }] }] }
  const { res, calls, q } = await scenario('S2', { 'lecteur-plan': [plan(T00, T01)], ...t00(ECART), 'T00 · replanification': [rp], 'T00 · suivi': [SOK] }, { mode: 'auto' })
  assert.equal(res.statut, 'arbitrage'); assert.ok((res.arbitrage.incoherence || '').includes('T06B')); assert.equal(res.decisions_office.length, 0)
  assert.ok(!byLabel(calls, 'T00 · suivi')[0].prompt.includes("prise d'office"))
  vide('S2', q)
})
await cas("S2b : tâche citée d'une autre phase, connue de plan-lint → appliquée, fichiers vérifiés par le scribe", async () => {
  const rp = { majeur: true, entrees: [], points: [{ titre: 'Suite', options: [{ id: 'A', description: 'T07 relira docs/DEPLOY.md', recommande: true }] }] }
  const pl = { ...plan(T00, T01), tous: [{ id: 'T00', phase: 1 }, { id: 'T01', phase: 1 }, { id: 'T07', phase: 2 }], phase_max: 2 }
  const { res, calls, q } = await scenario('S2b', { 'lecteur-plan': [pl], ...t00(ECART), 'T00 · replanification': [rp], 'T00 · suivi': [SOK], ...t01() }, { mode: 'auto' })
  assert.equal(res.decisions_office.length, 1); assert.equal(res.statut, 'terminé')
  const sc = byLabel(calls, 'T00 · suivi')[0].prompt
  assert.ok(sc.includes('test -e') && sc.includes('T07 relira docs/DEPLOY.md'), "scribe : contrôle des fichiers cités par la décision d'office")
  assert.ok(!byLabel(calls, 'T00 · replanification')[0].prompt.includes('Dernière phase'), 'pas la dernière phase')
  vide('S2b', q)
})
await cas('S3 : tâche bloquée avec point humain → statut besoin-humain', async () => {
  const { res, calls, q } = await scenario('S3', { 'lecteur-plan': [plan(T00, T01)], 'T00 · worker': [{ statut: 'blocked', resume: 'bloqué', branche: 'tache/T00', chemin: '/repo', blocage: 'restauration refusée' }], 'T00 · replanification': [{ majeur: true, entrees: [], points: [{ titre: 'Données réelles', humain: true, options: [] }] }], 'T00 · suivi': [SOK] }, { mode: 'auto' })
  assert.equal(res.taches[0].statut, 'besoin-humain'); assert.equal(res.statut, 'arbitrage')
  assert.ok(byLabel(calls, 'T00 · suivi')[0].prompt.includes('statut « besoin-humain »'))
  vide('S3', q)
})
await cas('S3b : tâche besoin-humain non relancée sans décision', async () => {
  const { res, calls, q } = await scenario('S3b', { 'lecteur-plan': [plan({ ...T00, statut: 'besoin-humain' }, T01)] })
  assert.equal(res.statut, 'partiel'); assert.deepEqual(res.en_attente, ['T00']); assert.deepEqual(res.non_lancees, ['T01']); assert.equal(calls.length, 1)
  vide('S3b', q)
})
await cas("S3c : relancée sur décision de l'utilisateur", async () => {
  const { res, q } = await scenario('S3c', { 'lecteur-plan': [plan({ ...T00, statut: 'besoin-humain' }, T01)], ...t00(), 'T00 · suivi': [SOK], ...t01() }, { relancer: ['T00'] })
  assert.equal(res.statut, 'terminé'); assert.deepEqual(res.en_attente, [])
  vide('S3c', q)
})
await cas('S4 : dernière phase → consigne de convergence (tickets)', async () => {
  const { calls, q } = await scenario('S4', { 'lecteur-plan': [{ ...plan(T00), tous: [{ id: 'T00', phase: 1 }], phase_max: 1 }], ...t00(ECART), 'T00 · replanification': [RIEN], 'T00 · suivi': [SOK] })
  const rp = byLabel(calls, 'T00 · replanification')[0].prompt
  assert.ok(rp.includes('dernière phase du plan') && rp.includes('« ticket »'))
  vide('S4', q)
})
await cas('S5 : données réelles (vérificateur) et véracité des textes (évaluateur)', async () => {
  const { calls, q } = await scenario('S5', { 'lecteur-plan': [plan(T00)], ...t00(), 'T00 · suivi': [SOK] })
  assert.ok(byLabel(calls, 'T00 · vérification')[0].prompt.includes('données réelles, geste réservé'))
  assert.ok(byLabel(calls, 'T00 · évaluation')[0].prompt.includes('disent vrai'))
  vide('S5', q)
})
await cas('S6 : qualité d\'abord — évaluateur et replanificateur sur opus, vérificateur et scribe sur sonnet', async () => {
  const { calls, q } = await scenario('S6', { 'lecteur-plan': [plan(T00)], ...t00(ECART), 'T00 · replanification': [RIEN], 'T00 · suivi': [SOK] })
  const m = l => byLabel(calls, l)[0].opts.model
  assert.equal(m('T00 · évaluation'), 'opus'); assert.equal(m('T00 · replanification'), 'opus')
  assert.equal(m('T00 · vérification'), 'sonnet'); assert.equal(m('T00 · suivi'), 'sonnet'); assert.equal(m('lecteur-plan'), 'haiku')
  vide('S6', q)
})
// ——— v0.6 : plugin (agents namespacés, plan-lint livré avec le plugin) ———
const LP = '/Users/x/.claude/plugins/cache/circle/orchestre/0.6.0/scripts/plan-lint.mjs'
await cas('P1 : plugin — agents « orchestre:* » par défaut, plan-lint du plugin passé par args (lecture et scribe)', async () => {
  const { res, calls, q } = await scenario('P1', { 'lecteur-plan': [plan(T00, T01)], ...t00(ECART), 'T00 · replanification': [RP_E], 'T00 · suivi': [SOK], ...t01() }, { mode: 'auto', lint: LP })
  assert.equal(res.statut, 'à-relancer')
  const at = l => byLabel(calls, l)[0].opts.agentType
  assert.equal(at('lecteur-plan'), 'orchestre:lecteur-plan'); assert.equal(at('T00 · worker'), 'orchestre:worker'); assert.equal(at('T00 · vérification'), 'orchestre:verificateur')
  assert.equal(at('T00 · évaluation'), 'orchestre:evaluateur'); assert.equal(at('T00 · fusion'), 'orchestre:integrateur'); assert.equal(at('T00 · replanification'), 'orchestre:replanificateur'); assert.equal(at('T00 · suivi'), 'orchestre:scribe')
  assert.ok(byLabel(calls, 'lecteur-plan')[0].prompt.includes(`node ${LP} plans/p --json --phase 1 --integration plan/p`), 'lecture : plan-lint du plugin')
  const sc = byLabel(calls, 'T00 · suivi')[0].prompt
  assert.ok(sc.includes(`node ${LP} plans/p --integration plan/p`) && !sc.includes('.claude/orchestre/'), 'scribe : plan-lint du plugin')
  vide('P1', q)
})
await cas('P2 : installation manuelle — prefixe_agents vide, plan-lint par défaut', async () => {
  const { calls, q } = await scenario('P2', { 'lecteur-plan': [plan(T00)], 'T00 · worker': [rap(0)], 'T00 · vérification': [ok(1)], 'T00 · évaluation': [{ verdict: 'ok' }], 'T00 · fusion': [FOK], 'T00 · suivi': [SOK] }, { prefixe_agents: '', parallelisme: 1 })
  assert.equal(byLabel(calls, 'lecteur-plan')[0].opts.agentType, 'lecteur-plan'); assert.equal(byLabel(calls, 'T00 · worker')[0].opts.agentType, 'worker')
  assert.ok(byLabel(calls, 'lecteur-plan')[0].prompt.includes('node .claude/orchestre/plan-lint.mjs plans/p --json'))
  vide('P2', q)
})
await cas('P3 : chemin de plan-lint avec espace → entre guillemets ; tâches parallèles → orchestre:worker-isole', async () => {
  const L = '/Users/x y/.claude/plugins/cache/circle/orchestre/0.6.0/scripts/plan-lint.mjs'
  const T02 = { ...T00, id: 'T02', titre: 'Autre', fichier: 'plans/p/taches/T02.md', ressources: [] }
  const T03 = { ...T00, id: 'T03', titre: 'Encore', fichier: 'plans/p/taches/T03.md', ressources: [] }
  const tt = id => ({ [`${id} · worker`]: [rap(id, { branche: `tache/${id}`, chemin: `/wt/${id}` })], [`${id} · vérification`]: [ok(id)], [`${id} · évaluation`]: [{ verdict: 'ok' }], [`${id} · fusion`]: [FOK], [`${id} · suivi`]: [SOK] })
  const { res, calls, q } = await scenario('P3', { 'lecteur-plan': [plan(T02, T03)], ...tt('T02'), ...tt('T03') }, { lint: L })
  assert.equal(res.statut, 'terminé')
  assert.ok(byLabel(calls, 'lecteur-plan')[0].prompt.includes(`node "${L}" plans/p --json`))
  assert.equal(byLabel(calls, 'T02 · worker')[0].opts.agentType, 'orchestre:worker-isole'); assert.equal(byLabel(calls, 'T02 · worker')[0].opts.isolation, 'worktree')
  vide('P3', q)
})
// ——— v0.6 : corrections de la relecture ———
await cas('Q1 : mode inconnu → erreur, aucun agent lancé', async () => {
  const { res, calls } = await scenario('Q1', {}, { mode: 'deviation' })
  assert.equal(res.statut, 'erreur'); assert.ok(res.detail.includes('auto, devia ou phase')); assert.equal(calls.length, 0)
})
await cas('Q2 : branche de base transmise à plan-lint (lecture et scribe)', async () => {
  const { calls, q } = await scenario('Q2', { 'lecteur-plan': [plan(T00, T01)], ...t00(ECART), 'T00 · replanification': [RP_E], 'T00 · suivi': [SOK], ...t01() }, { mode: 'auto', base: 'develop' })
  assert.ok(byLabel(calls, 'lecteur-plan')[0].prompt.includes('--integration plan/p --base develop'))
  assert.ok(byLabel(calls, 'T00 · suivi')[0].prompt.includes('--integration plan/p --base develop'))
  vide('Q2', q)
})
await cas("Q3 : arbitrage dont l'amendement vise une tâche fusionnée entre-temps → écarté, le run continue", async () => {
  const { res, calls, q } = await scenario('Q3', { 'arbitrage T02 · suivi': [{ ok: true, commit: 'x', refuses: [], ecartes: [{ id: 'T01', raison: 'fusionnée' }] }], 'lecteur-plan': [plan(T00)], ...t00(), 'T00 · suivi': [SOK] }, { arbitrages: ARB })
  assert.equal(res.statut, 'terminé'); assert.deepEqual(res.amendements_ecartes, [{ tache: 'T02', id: 'T01', raison: 'fusionnée' }])
  const sc = byLabel(calls, 'arbitrage T02 · suivi')[0].prompt
  assert.ok(sc.includes('rends-la dans « ecartes », pas dans « refuses »') && sc.includes('amendement non appliqué'))
  assert.ok(byLabel(calls, 'arbitrage T02 · suivi')[0].opts.schema.properties.ecartes, 'scribe : schéma ecartes')
  vide('Q3', q)
})
await cas("Q4 : autonome, amendement d'une tâche d'une autre phase déjà fusionnée → écarté, pas envoyé au scribe", async () => {
  const rp = { majeur: true, entrees: [], points: [{ titre: 'W', options: [{ id: 'A', description: 'a', recommande: true, amendements: [{ id: 'T09', verification: ['z'], raison: 'r9' }] }] }] }
  const T00b = { ...T00, phase: 2 }
  const { res, calls, q } = await scenario('Q4', { 'lecteur-plan': [{ ...plan(T00b), tous: [{ id: 'T09', phase: 1, statut: 'fusionnée' }, { id: 'T00', phase: 2, statut: 'à-faire' }], phase_max: 2 }], ...t00(ECART), 'T00 · replanification': [rp], 'T00 · suivi': [SOK] }, { mode: 'auto', phase: 2 })
  assert.equal(res.statut, 'terminé'); assert.deepEqual(res.amendements_ecartes.map(a => [a.tache, a.id]), [['T00', 'T09']])
  const sc = byLabel(calls, 'T00 · suivi')[0].prompt
  assert.ok(!sc.includes('Amendements, pour des tâches pas encore lancées') && sc.includes('amendement non appliqué'))
  vide('Q4', q)
})
await cas('Q5 : reprise de branche — règle unique, branche exacte rendue, dans le checkout principal comme en worktree', async () => {
  const { calls, q } = await scenario('Q5', { 'lecteur-plan': [plan(T00)], ...t00(), 'T00 · suivi': [SOK] })
  const w = byLabel(calls, 'T00 · worker')[0].prompt
  for (const x of ['git switch -c tache/T00', 'for-each-ref', "refs/heads/tache/T00-r*", 'git worktree list', 'tache/T00-r<n>', 'rends son nom exact dans « branche »', 'checkout principal'])
    assert.ok(w.includes(x), 'worker : ' + x)
  assert.ok(!w.includes('Commite tout ton travail sur tache/T00.'), 'worker : plus de branche imposée')
  vide('Q5', q)
})
await cas('Q6 : parallélisme de 1 → jamais de worktree, même entre tâches indépendantes', async () => {
  const T02 = { ...T00, id: 'T02', fichier: 'plans/p/taches/T02.md', ressources: [] }, T03 = { ...T00, id: 'T03', fichier: 'plans/p/taches/T03.md', ressources: [] }
  const tt = id => ({ [`${id} · worker`]: [rap(id, { branche: `tache/${id}` })], [`${id} · vérification`]: [ok(id)], [`${id} · évaluation`]: [{ verdict: 'ok' }], [`${id} · fusion`]: [FOK], [`${id} · suivi`]: [SOK] })
  const { res, calls, q } = await scenario('Q6', { 'lecteur-plan': [plan(T02, T03)], ...tt('T02'), ...tt('T03') }, { parallelisme: 1 })
  assert.equal(res.statut, 'terminé')
  for (const id of ['T02', 'T03']) { const o = byLabel(calls, `${id} · worker`)[0].opts; assert.equal(o.agentType, 'orchestre:worker'); assert.equal(o.isolation, undefined) }
  vide('Q6', q)
})
await cas("Q7 : exception pendant une tâche → échec avec la raison dans « blocage »", async () => {
  const { res, q } = await scenario('Q7', { 'lecteur-plan': [plan(T00)], 'T00 · worker': [() => { throw new Error('boom') }] })
  assert.equal(res.statut, 'partiel'); const t = res.taches.find(x => x.id === 'T00')
  assert.equal(t.statut, 'échec'); assert.deepEqual(t.blocage, ['erreur du workflow : Error: boom'])
  vide('Q7', q)
})
// ——— v0.6.1 : prérequis (PREREQUIS.md) ———
await cas('R1 : prérequis ouvert → la tâche attend, celle qui en dépend aussi ; aucun agent lancé', async () => {
  const { res, calls, q } = await scenario('R1', { 'lecteur-plan': [plan({ ...T00, prerequis_ouverts: ['D5'] }, T01)] })
  assert.equal(res.statut, 'partiel'); assert.deepEqual(res.en_attente_prerequis, [{ id: 'T00', prerequis: ['D5'] }])
  assert.deepEqual(res.non_lancees, ['T01']); assert.deepEqual(res.en_attente, []); assert.equal(calls.length, 1)
  const ts = byLabel(calls, 'lecteur-plan')[0].opts.schema.properties.taches.items
  assert.ok(ts.properties.prerequis_ouverts && ts.required.includes('prerequis_ouverts'), 'lecteur-plan : schéma, champ requis')
  vide('R1', q)
})
await cas('R2 : le reste de la phase tourne pendant qu’une tâche attend son prérequis', async () => {
  const T02 = { ...T00, id: 'T02', fichier: 'plans/p/taches/T02.md', ressources: [], prerequis_ouverts: ['H1'] }, T03 = { ...T00, id: 'T03', fichier: 'plans/p/taches/T03.md', ressources: [] }
  const { res, q } = await scenario('R2', { 'lecteur-plan': [plan(T02, T03)], 'T03 · worker': [rap(3, { branche: 'tache/T03' })], 'T03 · vérification': [ok(3)], 'T03 · évaluation': [{ verdict: 'ok' }], 'T03 · fusion': [FOK], 'T03 · suivi': [SOK] })
  assert.equal(res.statut, 'partiel'); assert.deepEqual(res.taches.map(t => [t.id, t.statut]), [['T03', 'fusionnée']])
  assert.deepEqual(res.en_attente_prerequis, [{ id: 'T02', prerequis: ['H1'] }])
  vide('R2', q)
})
await cas('R3 : une tâche « besoin-humain » relancée attend quand même son prérequis ouvert', async () => {
  const { res, calls, q } = await scenario('R3', { 'lecteur-plan': [plan({ ...T00, statut: 'besoin-humain', prerequis_ouverts: ['D6'] })] }, { relancer: ['T00'] })
  assert.equal(res.statut, 'partiel'); assert.deepEqual(res.en_attente, []); assert.deepEqual(res.en_attente_prerequis, [{ id: 'T00', prerequis: ['D6'] }]); assert.equal(calls.length, 1)
  vide('R3', q)
})
await cas('R4 : prérequis faits (liste vide) → la tâche part normalement', async () => {
  const { res, q } = await scenario('R4', { 'lecteur-plan': [plan({ ...T00, prerequis_ouverts: [] })], ...t00(), 'T00 · suivi': [SOK] })
  assert.equal(res.statut, 'terminé'); assert.deepEqual(res.en_attente_prerequis, [])
  vide('R4', q)
})
await cas('R5 : le replanificateur lit PREREQUIS.md ; un point sur un prérequis ouvert est humain ; une tâche ajoutée cite ses prérequis', async () => {
  const { calls, q } = await scenario('R5', { 'lecteur-plan': [plan(T00)], ...t00(ECART), 'T00 · replanification': [RIEN], 'T00 · suivi': [SOK] })
  const rp = byLabel(calls, 'T00 · replanification')[0].prompt
  for (const x of ['plans/p/PREREQUIS.md', 'un point qui porte sur un prérequis ouvert de PREREQUIS.md', 'cite dans « prerequis »']) assert.ok(rp.includes(x), 'replan : ' + x)
  vide('R5', q)
})
// ——— v0.6.2 : fichiers interdits aux agents → relectures avant la PR, sans arrêt ———
await cas("U1 : évaluateur OK avec un fichier illisible → entrée « relecture », pas de replanification ni d'arrêt", async () => {
  const { res, calls, q } = await scenario('U1', { 'lecteur-plan': [plan(T00)], 'T00 · worker': [rap(0)], 'T00 · vérification': [ok(1)], 'T00 · évaluation': [{ verdict: 'ok', illisibles: ['agents/x/.env.example'] }], 'T00 · fusion': [FOK], 'T00 · suivi': [SOK] })
  assert.equal(res.statut, 'terminé'); assert.equal(idx(calls, 'T00 · replanification'), -1)
  assert.deepEqual(res.relectures, [{ tache: 'T00', relecture: "agents/x/.env.example : illisible par les agents, à relire par l'humain avant la PR" }])
  const sc = byLabel(calls, 'T00 · suivi')[0].prompt
  assert.ok(sc.includes('"type":"relecture"') && sc.includes('agents/x/.env.example'), 'scribe : entrée relecture')
  const ev = byLabel(calls, 'T00 · évaluation')[0]
  assert.ok(ev.prompt.includes('« illisibles »') && ev.prompt.includes('ne contourne jamais') && ev.opts.schema.properties.illisibles, 'évaluateur : consigne et schéma')
  assert.ok(byLabel(calls, 'T00 · worker')[0].prompt.includes('écart de type « relecture »'), 'worker : consigne')
  assert.ok(byLabel(calls, 'T00 · worker')[0].opts.schema.properties.ecarts.items.properties.type.enum.includes('relecture'), 'worker : type relecture dans le schéma')
  vide('U1', q)
})
await cas('U2 : écart « relecture » qui cite un .env → ni écart sensible, ni point, ni arrêt', async () => {
  const REL = [{ type: 'relecture', description: 'ajouter MR_REVIEW_MODEL_MAX_ATTEMPTS à agents/mr_review/.env.example (fichier interdit aux agents)' }]
  const { res, calls, q } = await scenario('U2', { 'lecteur-plan': [plan(T00, T01)], ...t00(REL), 'T00 · suivi': [SOK], ...t01() }, { mode: 'devia' })
  assert.equal(res.statut, 'terminé'); assert.equal(idx(calls, 'T00 · replanification'), -1)
  assert.equal(res.relectures.length, 1); assert.ok(byLabel(calls, 'T00 · suivi')[0].prompt.includes('MR_REVIEW_MODEL_MAX_ATTEMPTS'))
  vide('U2', q)
})
await cas('U3 : écart ordinaire + relecture → le replanificateur ne voit que l’écart ordinaire, sans écart sensible', async () => {
  const MIX = [{ type: 'relecture', description: 'relire .env.example' }, ...ECART]
  const { res, calls, q } = await scenario('U3', { 'lecteur-plan': [plan(T00)], ...t00(MIX), 'T00 · replanification': [RIEN], 'T00 · suivi': [SOK] })
  const rp = byLabel(calls, 'T00 · replanification')[0].prompt
  assert.ok(rp.includes('isSuperAdmin') && !rp.includes('relire .env.example') && !rp.includes('Écarts sensibles'), 'replan : écarts filtrés')
  assert.ok(rp.includes('n\'est jamais un point ni une entrée : rends-le dans « relectures »') && byLabel(calls, 'T00 · replanification')[0].opts.schema.properties.relectures, 'replan : consigne et schéma')
  assert.equal(res.statut, 'terminé'); assert.equal(res.relectures.length, 1)
  vide('U3', q)
})
await cas('U4 : écarts du premier essai gardés après une correction qui ne les répète pas ; découvertes remises à la correction', async () => {
  const REL = [{ type: 'relecture', description: 'ajouter X à agents/x/.env.example' }, ...ECART]
  const { res, calls, q } = await scenario('U4', { 'lecteur-plan': [plan(T00)], 'T00 · worker': [rap(0, { ecarts: REL })], 'T00 · vérification': [ok(1), ok(2)],
    'T00 · évaluation': [{ verdict: 'ko', manques: ['M1'] }, { verdict: 'ok' }], 'T00 · correction 1': [rap(1, { ecarts: [...ECART] })], 'T00 · fusion': [FOK], 'T00 · replanification': [RIEN], 'T00 · suivi': [SOK] })
  assert.equal(res.statut, 'terminé'); assert.equal(res.relectures.length, 1)
  const co = byLabel(calls, 'T00 · correction 1')[0]
  assert.ok(co.prompt.includes('Écarts déjà remontés') && co.prompt.includes('isSuperAdmin'), 'correction : écarts précédents')
  assert.ok(co.prompt.includes('routes préchauffées 0') && co.prompt.includes('liste à jour'), 'correction : découvertes précédentes')
  assert.ok(co.opts.schema.properties.ecarts.items.properties.type.enum.includes('relecture'), 'correction : type relecture dans le schéma')
  assert.ok(byLabel(calls, 'T00 · évaluation')[1].prompt.includes('isSuperAdmin'), 'évaluation 2 : écarts cumulés')
  const rp = byLabel(calls, 'T00 · replanification')[0].prompt
  assert.ok(rp.includes('isSuperAdmin') && !rp.includes('agents/x/.env.example'), 'replan : écart du premier essai, sans la relecture')
  assert.equal(rp.split('isSuperAdmin optionnel').length - 1, 1, 'replan : écart répété une seule fois')
  const sc = byLabel(calls, 'T00 · suivi')[0].prompt
  assert.ok(sc.includes('routes préchauffées 1') && !sc.includes('routes préchauffées 0'), 'scribe : découvertes de la correction, qui a rendu la liste à jour')
  vide('U4', q)
})
await cas('U5 : fichier illisible à la première évaluation seulement → relecture gardée', async () => {
  const { res, calls, q } = await scenario('U5', { 'lecteur-plan': [plan(T00)], 'T00 · worker': [rap(0)], 'T00 · vérification': [ok(1), ok(2)],
    'T00 · évaluation': [{ verdict: 'ko', manques: ['M1'], illisibles: ['a/.env.example'] }, { verdict: 'ok' }], 'T00 · correction 1': [rap(1)], 'T00 · fusion': [FOK], 'T00 · suivi': [SOK] })
  assert.equal(res.statut, 'terminé'); assert.equal(idx(calls, 'T00 · replanification'), -1)
  assert.deepEqual(res.relectures.map(x => x.relecture), ["a/.env.example : illisible par les agents, à relire par l'humain avant la PR"])
  vide('U5', q)
})
await cas('U6 : correction sans réponse → échec avec le rapport du premier essai (écarts, relecture, branche)', async () => {
  const REL = [{ type: 'relecture', description: 'ajouter X à agents/x/.env.example' }, ...ECART]
  const { res, calls, q } = await scenario('U6', { 'lecteur-plan': [plan(T00, T01)], 'T00 · worker': [rap(0, { ecarts: REL })], 'T00 · vérification': [ok(1)],
    'T00 · évaluation': [{ verdict: 'ko', manques: ['M1'] }], 'T00 · correction 1': [null], 'T00 · replanification': [RIEN], 'T00 · suivi': [SOK] })
  const t = res.taches.find(x => x.id === 'T00')
  assert.equal(t.statut, 'échec'); assert.equal(t.branche, 'tache/T00'); assert.equal(t.essais, 2)
  assert.ok(t.blocage[0].includes('correction sans réponse'))
  assert.ok(byLabel(calls, 'T00 · replanification')[0].prompt.includes('isSuperAdmin'), 'replan : écart du premier essai')
  assert.deepEqual(t.relectures, ['ajouter X à agents/x/.env.example'])
  assert.ok(byLabel(calls, 'T00 · suivi')[0].prompt.includes('branche tache/T00'), 'scribe : branche gardée')
  assert.ok(res.non_lancees.includes('T01'))
  vide('U6', q)
})
await cas('U7 : commande de vérification refusée par les permissions → ni échec ni correction ; relecture ; contrôle post-fusion sur la suivante', async () => {
  const REF = 'grep -q MR_MAX agents/x/.env.example'
  const T = { ...T00, verification: [REF, 'sh scripts/e2e-local.sh'] }
  const V = { ok: true, resultats: [{ commande: 'sh scripts/e2e-local.sh', code: 0, extrait: '96 passed' }], interdites: ['cd "/repo" && ' + REF + ' ; echo "code=$?"'] }
  const { res, calls, q } = await scenario('U7', { 'lecteur-plan': [plan(T)], 'T00 · worker': [rap(0)], 'T00 · vérification': [V], 'T00 · évaluation': [{ verdict: 'ok' }], 'T00 · fusion': [FOK], 'T00 · suivi': [SOK] })
  assert.equal(res.statut, 'terminé'); assert.equal(idx(calls, 'T00 · correction 1'), -1); assert.equal(idx(calls, 'T00 · replanification'), -1)
  const ve = byLabel(calls, 'T00 · vérification')[0]
  assert.ok(ve.prompt.includes('« interdites »') && ve.prompt.includes('ne la contourne jamais') && ve.opts.schema.properties.interdites, 'vérificateur : consigne et schéma')
  assert.ok(byLabel(calls, 'T00 · évaluation')[0].prompt.includes(REF), 'évaluateur : commande refusée signalée')
  const fu = byLabel(calls, 'T00 · fusion')[0].prompt
  assert.ok(fu.includes('commande de contrôle, sans pipe (ajoute `; echo "code=$?"`) : sh scripts/e2e-local.sh'), 'contrôle : première commande permise')
  assert.deepEqual(res.relectures.map(x => x.relecture), ["commande `" + REF + "` refusée aux agents : à lancer par l'humain avant la PR"])
  vide('U7', q)
})
await cas('U8 : interdiction remontée comme écart ordinaire → reclassée en relecture par le replanificateur, sans arrêt ; pas si l’écart touche aussi la prod', async () => {
  const D = 'lecture de agents/x/.env.example refusée : variable MR_MAX non ajoutée'
  const RP = { majeur: false, entrees: [], points: [], relectures: [{ ecart: D, relecture: 'agents/x/.env.example : ajouter MR_MAX' }] }
  const { res, calls, q } = await scenario('U8', { 'lecteur-plan': [plan(T00, T01)], ...t00([{ type: 'écart', description: D }]), 'T00 · replanification': [RP], 'T00 · suivi': [SOK], ...t01() }, { mode: 'devia' })
  assert.equal(res.statut, 'terminé'); assert.deepEqual(res.relectures.map(x => x.relecture), ['agents/x/.env.example : ajouter MR_MAX'])
  const rp = byLabel(calls, 'T00 · replanification')[0].prompt
  assert.ok(rp.includes('Écarts sensibles') && rp.includes('sauf pour un écart qui ne porte que sur un fichier interdit aux agents'), 'replan : exception aux écarts sensibles')
  vide('U8', q)
  const D2 = 'lecture de agents/x/.env.example refusée ; le script lit aussi la base de prod'
  const RP2 = { majeur: false, entrees: [], points: [], relectures: [{ ecart: D2, relecture: 'agents/x/.env.example : relire' }] }
  const b = await scenario('U8b', { 'lecteur-plan': [plan(T00, T01)], ...t00([{ type: 'écart', description: D2 }]), 'T00 · replanification': [RP2], 'T00 · suivi': [SOK] }, { mode: 'devia' })
  assert.equal(b.res.statut, 'arbitrage'); assert.ok(b.res.arbitrage.humain && b.res.arbitrage.titre.includes('Écart sensible'), 'reclassement refusé : la prod reste sensible')
  assert.equal(b.res.relectures.length, 1)
  vide('U8b', b.q)
})
await cas('U9 : même fichier cité par le worker, l’évaluateur et le replanificateur → une seule relecture', async () => {
  const R0 = 'ajouter X à agents/x/.env.example'
  const RP = { majeur: false, entrees: [{ type: 'relecture', gravite: 'majeur', description: R0 }], points: [], relectures: [{ relecture: R0 }] }
  const { res, calls, q } = await scenario('U9', { 'lecteur-plan': [plan(T00)], 'T00 · worker': [rap(0, { ecarts: [{ type: 'relecture', description: R0 }, ...ECART] })], 'T00 · vérification': [ok(1)],
    'T00 · évaluation': [{ verdict: 'ok', illisibles: ['agents/x/.env.example'] }], 'T00 · fusion': [FOK], 'T00 · replanification': [RP], 'T00 · suivi': [SOK] })
  assert.deepEqual(res.relectures.map(x => x.relecture), [R0])
  const sc = byLabel(calls, 'T00 · suivi')[0].prompt
  assert.equal(sc.split(R0).length - 1, 1, 'scribe : une seule entrée')
  vide('U9', q)
})
await cas('U7b : toutes les commandes de vérification refusées → bloquée sans correction ni fusion', async () => {
  const REF = 'grep -q MR_MAX agents/x/.env.example'
  const T = { ...T00, verification: [REF] }
  const { res, calls, q } = await scenario('U7b', { 'lecteur-plan': [plan(T, T01)], 'T00 · worker': [rap(0)], 'T00 · vérification': [{ ok: true, resultats: [], interdites: [REF] }], 'T00 · replanification': [RIEN], 'T00 · suivi': [SOK] })
  const t = res.taches.find(x => x.id === 'T00')
  assert.equal(t.statut, 'bloquée'); assert.ok(t.blocage[0].includes('aucune commande de vérification permise'))
  for (const l of ['T00 · évaluation', 'T00 · correction 1', 'T00 · fusion']) assert.equal(idx(calls, l), -1, l)
  assert.equal(t.relectures.length, 1); assert.ok(res.non_lancees.includes('T01'))
  vide('U7b', q)
})
await cas('U7c : commande « interdite » qui n’est pas une commande de la tâche → échec, correction', async () => {
  const { res, calls, q } = await scenario('U7c', { 'lecteur-plan': [plan(T00)], 'T00 · worker': [rap(0)], 'T00 · vérification': [{ ...ok(1), interdites: ['cat secrets/x'] }, ok(2)],
    'T00 · correction 1': [rap(1)], 'T00 · évaluation': [{ verdict: 'ok' }], 'T00 · fusion': [FOK], 'T00 · suivi': [SOK] })
  assert.equal(res.statut, 'terminé'); assert.equal(res.taches[0].essais, 2)
  assert.ok(byLabel(calls, 'T00 · correction 1')[0].prompt.includes('cat secrets/x : refusée selon le vérificateur'))
  assert.equal(res.relectures.length, 0)
  vide('U7c', q)
})
await cas('U8c : reclassement d’un écart qui touche aussi la prod → arrêt humain, même avec un autre point', async () => {
  const D = 'lecture de agents/x/.env.example refusée ; le script lit aussi la base de prod'
  const PT = { titre: 'Contrat', contexte: '', options: [{ id: 'A', description: 'garder', recommande: true }, { id: 'B', description: 'changer' }] }
  const RP = { majeur: true, entrees: [], points: [PT], relectures: [{ ecart: D, relecture: 'agents/x/.env.example : relire' }] }
  const { res, q } = await scenario('U8c', { 'lecteur-plan': [plan(T00, T01)], ...t00([{ type: 'écart', description: D }, ...ECART]), 'T00 · replanification': [RP], 'T00 · suivi': [SOK] }, { mode: 'auto' })
  assert.equal(res.statut, 'arbitrage'); assert.ok(res.arbitrage.humain && res.arbitrage.titre.includes('reclassé en relecture'))
  vide('U8c', q)
})
await cas('U9b : .env.example de la racine illisible, relecture d’un autre .env.example → deux relectures', async () => {
  const R0 = 'agents/x/.env.example : ajouter MR_MAX'
  const { res, q } = await scenario('U9b', { 'lecteur-plan': [plan(T00)], 'T00 · worker': [rap(0, { ecarts: [{ type: 'relecture', description: R0 }] })], 'T00 · vérification': [ok(1)],
    'T00 · évaluation': [{ verdict: 'ok', illisibles: ['.env.example'] }], 'T00 · fusion': [FOK], 'T00 · suivi': [SOK] })
  assert.deepEqual(res.relectures.map(x => x.relecture), [R0, ".env.example : illisible par les agents, à relire par l'humain avant la PR"])
  vide('U9b', q)
})
await cas('U4b : correction qui ne rend pas de découvertes → celles de l’essai précédent restent', async () => {
  const C = { statut: 'done', resume: 'corrigé', branche: 'tache/T00', commit: 'c1', chemin: '/repo' }
  const { calls, q } = await scenario('U4b', { 'lecteur-plan': [plan(T00)], 'T00 · worker': [rap(0)], 'T00 · vérification': [ok(1), ok(2)],
    'T00 · évaluation': [{ verdict: 'ko', manques: ['M1'] }, { verdict: 'ok' }], 'T00 · correction 1': [C], 'T00 · fusion': [FOK], 'T00 · suivi': [SOK] })
  assert.ok(byLabel(calls, 'T00 · suivi')[0].prompt.includes('routes préchauffées 0'))
  vide('U4b', q)
})
await cas('U7d : deux commandes qui ne diffèrent que par leur cd de tête → seule la refusée est interdite', async () => {
  const A = 'cd api && pnpm test', W = 'cd web && pnpm test'
  const T = { ...T00, verification: [A, W] }
  const V = { ok: true, resultats: [{ commande: W, code: 0, extrait: 'ok' }], interdites: ['cd "/repo" && ' + A + ' ; echo "code=$?"'] }
  const { res, calls, q } = await scenario('U7d', { 'lecteur-plan': [plan(T)], 'T00 · worker': [rap(0)], 'T00 · vérification': [V], 'T00 · évaluation': [{ verdict: 'ok' }], 'T00 · fusion': [FOK], 'T00 · suivi': [SOK] })
  assert.equal(res.statut, 'terminé')
  assert.deepEqual(res.relectures.map(x => x.relecture), ["commande `" + A + "` refusée aux agents : à lancer par l'humain avant la PR"])
  assert.ok(byLabel(calls, 'T00 · fusion')[0].prompt.includes(': ' + W + '.'), 'contrôle : la commande web')
  vide('U7d', q)
})
// ——— 0.8.0 : suivi.json par scripts/suivi.mjs, que les agents lancent sur consigne ———
const SV = '/plug/scripts/suivi.mjs'
const AS = { suivi: SV }
const avecSuivi = x => ({ ...x, suivi_ok: true })
const planS = (...ts) => ({ ...plan(...ts), ouverture_ok: true })
const GOK = { suivi_ok: true, commit: 'g1', detail: '' }
// Commandes de suivi d'une consigne : entre accents graves, objet JSON entre guillemets simples (ni ' ni ` dedans)
const commandes = prompt => [...prompt.matchAll(/`(node "?[^`"]*suivi\.mjs"? [^`]*)`/g)].map(m => m[1])
const lire = c => { const m = c.match(/suivi\.mjs"? (\S+) (\S+) --json '([^']*)'$/); assert.ok(m, 'commande de suivi mal formée : ' + c); return { cmd: m[1], plan: m[2], E: JSON.parse(m[3]) } }
const suiviDe = (calls, label, i = 0) => commandes(byLabel(calls, label)[i].prompt).map(lire)
const ENTETE = 'Suivi du plan : ta première commande, avant toute autre'
const s00 = (extra = {}) => ({ 'T00 · worker': [avecSuivi(rap(0))], 'T00 · vérification': [avecSuivi(ok(1))], 'T00 · évaluation': [avecSuivi({ verdict: 'ok' })], 'T00 · fusion': [avecSuivi(FOK)], 'T00 · suivi': [avecSuivi(SOK)], ...extra })
const s01 = () => ({ 'T01 · worker': [avecSuivi(rap(1, { branche: 'tache/T01' }))], 'T01 · vérification': [avecSuivi(ok(2))], 'T01 · évaluation': [avecSuivi({ verdict: 'ok' })], 'T01 · fusion': [avecSuivi(FOK)], 'T01 · suivi': [avecSuivi(SOK)] })
const POINT_E = { tache: 'T00', titre: 'Contrat UpdateUserSchema', contexte: 'isSuperAdmin optionnel', humain: false, options: [{ id: 'A', description: 'Garder optionnel et tester la règle (d)', impact: 'un test de plus', recommande: true }, { id: 'B', description: 'Rendre le champ obligatoire', impact: 'casse les appels partiels', recommande: false }] }

await cas("V1 : suivi — le lecteur-plan ouvre le run, chaque agent lance d'abord son étape, le scribe clôt avant son commit, le greffier clôt le run", async () => {
  const { res, calls, q } = await scenario('V1', { 'lecteur-plan': [planS(T00)], ...s00(), 'fin de run · suivi': [GOK] }, AS)
  assert.equal(res.statut, 'terminé'); assert.deepEqual(res.suivi_echecs, [])
  const lp = byLabel(calls, 'lecteur-plan')[0].prompt
  assert.ok(lp.startsWith(ENTETE + ', ouvre le run'))
  assert.deepEqual(suiviDe(calls, 'lecteur-plan'), [{ cmd: 'debut-run', plan: 'plans/p', E: { phase: 1, mode: 'phase', parallelisme: 4, corrections_max: 2, decisions_office_max: 3 } }])
  assert.ok(lp.includes('plan-lint.mjs plans/p --json --phase 1') && lp.includes('avec ouverture_ok'))
  for (const [l, E] of [['T00 · worker', { tache: 'T00', etape: 'worker', isole: false, modele: 'sonnet' }], ['T00 · vérification', { tache: 'T00', etape: 'vérification' }], ['T00 · évaluation', { tache: 'T00', etape: 'évaluation' }], ['T00 · fusion', { tache: 'T00', etape: 'fusion' }]]) {
    assert.ok(byLabel(calls, l)[0].prompt.startsWith(ENTETE), l + ' : étape en tête')
    assert.deepEqual(suiviDe(calls, l), [{ cmd: 'etape', plan: 'plans/p', E }], l)
  }
  const sc = byLabel(calls, 'T00 · suivi')[0].prompt
  assert.deepEqual(suiviDe(calls, 'T00 · suivi'), [{ cmd: 'etape', plan: 'plans/p', E: { tache: 'T00', etape: 'suivi' } }, { cmd: 'cloture', plan: 'plans/p', E: { tache: 'T00', statut: 'fusionnée', essais: 1, branche: 'tache/T00' } }])
  assert.ok(!sc.includes('- SUIVI.md : ligne') && sc.includes("n'y touche jamais toi-même") && sc.includes('commite SUIVI.md, HANDOFF.md et DISCOVERY.md'))
  assert.ok(sc.indexOf('suivi.mjs cloture') > sc.indexOf('DISCOVERY.md : intègre'), 'clôture écrite après le reste')
  const g = byLabel(calls, 'fin de run · suivi')
  assert.equal(g.length, 1); assert.equal(idx(calls, 'fin de run · suivi'), calls.length - 1, 'le greffier passe en dernier')
  assert.deepEqual([g[0].opts.agentType, g[0].opts.model, g[0].opts.schema.required], ['orchestre:greffier', 'haiku', ['suivi_ok']])
  const [fr] = suiviDe(calls, 'fin de run · suivi')
  assert.deepEqual([fr.cmd, fr.E.statut, fr.E.non_lancees, fr.E.points_a_trancher], ['fin-run', 'terminé', [], []])
  assert.deepEqual(fr.E.taches, [{ id: 'T00', statut: 'fusionnée', essais: 1, branche: 'tache/T00' }], 'bilan sans les résumés des workers')
  for (const x of ['1. `git switch plan/p`', '`git diff --quiet HEAD -- plans/p/SUIVI.md`', '`git commit -m "suivi : fin du run de la phase 1" -- plans/p/SUIVI.md`']) assert.ok(g[0].prompt.includes(x), 'greffier : ' + x)
  assert.ok(!g[0].prompt.includes('git add'), 'le greffier ne commite que SUIVI.md')
  assert.deepEqual([byLabel(calls, 'lecteur-plan')[0].opts.schema.required, byLabel(calls, 'T00 · suivi')[0].opts.schema.required, byLabel(calls, 'T00 · worker')[0].opts.schema.required], [['ok', 'taches', 'ouverture_ok'], ['ok', 'suivi_ok'], ['statut', 'resume', 'branche', 'chemin']], 'résultat requis seulement là où il décide de la suite')
  vide('V1', q)
})
await cas("V2 : suivi — correction et son refus, texte échappé ; clôture complète en autonome (décision d'office, tâche ajoutée, amendement, replanification)", async () => {
  const M = "l'option `--force` coûte $5", LONG = 'npm test : 2 échecs\n  at a.test.ts:12\n' + 'x'.repeat(400)
  const { res, calls, q } = await scenario('V2', {
    'lecteur-plan': [planS(T00, T01)], 'T00 · worker': [avecSuivi(rap(0, { ecarts: ECART }))], 'T00 · vérification': [avecSuivi(ok(1)), avecSuivi(ok(2))],
    'T00 · évaluation': [avecSuivi({ verdict: 'ko', manques: [M, LONG] }), avecSuivi({ verdict: 'ok' })], 'T00 · correction 1': [avecSuivi(rap(1))],
    'T00 · fusion': [avecSuivi(FOK)], 'T00 · replanification': [RP_E], 'T00 · suivi': [avecSuivi(SOK)], ...s01(), 'fin de run · suivi': [GOK] }, { ...AS, mode: 'auto' })
  const LONG1 = 'npm test : 2 échecs at a.test.ts:12 ' + 'x'.repeat(203) + '…'
  assert.equal(LONG1.length, 240)
  assert.equal(res.statut, 'à-relancer'); assert.deepEqual(res.suivi_echecs, [])
  const corr = byLabel(calls, 'T00 · correction 1')[0].prompt
  assert.deepEqual(suiviDe(calls, 'T00 · correction 1'), [{ cmd: 'etape', plan: 'plans/p', E: { tache: 'T00', etape: 'correction', refus: { essai: 1, par: 'évaluation', manques: [M, LONG1] }, modele: 'sonnet' } }], 'texte long sur une ligne et coupé')
  assert.ok(corr.includes(LONG), 'le worker de correction reçoit le manque entier')
  assert.ok(commandes(corr).every(c => !c.includes('\n')), 'commande sur une ligne')
  assert.ok(corr.includes('l\\u0027option \\u0060--force\\u0060 coûte \\u00245'), 'apostrophe, accent grave et dollar échappés')
  const D = { tache: 'T00', titre: 'Contrat UpdateUserSchema', option: 'A', description: 'Garder optionnel et tester la règle (d)' }
  assert.deepEqual(suiviDe(calls, 'T00 · suivi')[1].E, {
    tache: 'T00', statut: 'fusionnée', essais: 2, branche: 'tache/T00', refus: [{ essai: 1, par: 'évaluation', manques: [M, LONG1] }], decisions_office: [D],
    taches_ajoutees: [{ id: 'T00C', titre: 'Test règle d', phase: 1 }], amendements: [{ id: 'T01', raison: 'règle de sécurité sans test' }], replanification: true })
  const sc = byLabel(calls, 'T00 · suivi')[0].prompt
  assert.ok(sc.includes('ne touche pas à SUIVI.md : la commande de suivi ci-dessous y ajoute leur ligne') && sc.includes('retire son fichier).') && !sc.includes('sa ligne de SUIVI.md'))
  assert.ok(sc.indexOf('suivi.mjs cloture') > sc.indexOf('plan-lint.mjs plans/p --integration'), 'clôture après plan-lint')
  assert.ok(sc.includes(JSON.stringify(LONG).slice(1, -1)), 'HANDOFF reçoit le refus entier')
  assert.deepEqual(suiviDe(calls, 'T01 · suivi')[1].E, { tache: 'T01', statut: 'fusionnée', essais: 1, branche: 'tache/T01' }, 'rien de T00 dans la clôture de T01')
  const fr = suiviDe(calls, 'fin de run · suivi')[0].E
  assert.deepEqual([fr.statut, fr.decisions_office, fr.taches_ajoutees], ['à-relancer', [D], [{ id: 'T00C', phase: 1, titre: 'Test règle d', ajoutee_par: 'T00' }]])
  assert.deepEqual(res.taches_ajoutees, [{ id: 'T00C', phase: 1, titre: 'Test règle d' }], 'bilan du pilote inchangé')
  vide('V2', q)
})
await cas('V3 : suivi — tâches en parallèle → étape worker avec isole=true ; chemin du script avec espace entre guillemets', async () => {
  const T02 = { ...T00, id: 'T02', titre: 'Autre', fichier: 'plans/p/taches/T02.md', ressources: [] }
  const T03 = { ...T00, id: 'T03', titre: 'Encore', fichier: 'plans/p/taches/T03.md', ressources: [] }
  const tt = id => ({ [`${id} · worker`]: [avecSuivi(rap(id, { branche: `tache/${id}`, chemin: `/wt/${id}` }))], [`${id} · vérification`]: [avecSuivi(ok(id))], [`${id} · évaluation`]: [avecSuivi({ verdict: 'ok' })], [`${id} · fusion`]: [avecSuivi(FOK)], [`${id} · suivi`]: [avecSuivi(SOK)] })
  const SVE = '/Users/x y/.claude/plugins/cache/circle/orchestre/0.8.0/scripts/suivi.mjs'
  // Valeurs d'args en chaîne ou négatives : entiers valides pour le schéma du suivi
  const { res, calls, q } = await scenario('V3', { 'lecteur-plan': [planS(T02, T03)], ...tt('T02'), ...tt('T03'), 'fin de run · suivi': [GOK] }, { suivi: SVE, corrections_max: '2', decisions_office_max: -1 })
  assert.equal(res.statut, 'terminé')
  assert.deepEqual(suiviDe(calls, 'lecteur-plan')[0].E, { phase: 1, mode: 'phase', parallelisme: 4, corrections_max: 2, decisions_office_max: 0 })
  for (const id of ['T02', 'T03']) assert.deepEqual(suiviDe(calls, `${id} · worker`)[0].E, { tache: id, etape: 'worker', isole: true, modele: 'sonnet' })
  assert.ok(byLabel(calls, 'T02 · worker')[0].prompt.includes(`\`node "${SVE}" etape plans/p --json '`))
  vide('V3', q)
})
await cas("V4 : suivi — points de la clôture transmis sans leurs actions ; le point d'arrêt va au greffier", async () => {
  // Réponses neuves à chaque scénario : les files se vident
  const avecE = () => ({ 'T00 · worker': [avecSuivi(rap(0, { ecarts: ECART }))], 'T00 · replanification': [RP_E] })
  let { res, calls, q } = await scenario('V4a', { 'lecteur-plan': [planS(T00, T01)], ...s00(avecE()), ...s01(), 'fin de run · suivi': [GOK] }, AS)
  assert.equal(res.statut, 'terminé')
  assert.deepEqual(suiviDe(calls, 'T00 · suivi')[1].E.points, [POINT_E])
  assert.equal(res.points_a_trancher[0].options[0].amendements[0].id, 'T01', 'le bilan du pilote garde les actions')
  let fr = suiviDe(calls, 'fin de run · suivi')[0].E
  assert.deepEqual(fr.points_a_trancher, [POINT_E]); assert.ok(!('arbitrage' in fr))
  vide('V4a', q)
  ;({ res, calls, q } = await scenario('V4b', { 'lecteur-plan': [planS(T00, T01)], ...s00(avecE()), 'fin de run · suivi': [GOK] }, { ...AS, mode: 'devia' }))
  assert.equal(res.statut, 'arbitrage'); assert.deepEqual(res.non_lancees, ['T01'])
  assert.deepEqual(suiviDe(calls, 'T00 · suivi')[1].E.points, [POINT_E])
  fr = suiviDe(calls, 'fin de run · suivi')[0].E
  assert.deepEqual([fr.statut, fr.arbitrage, fr.points_a_trancher, fr.non_lancees], ['arbitrage', POINT_E, [], ['T01']])
  vide('V4b', q)
})
await cas('V5 : suivi — avec des arbitrages, le premier scribe ouvre le run ; chacun note le sien juste avant son commit', async () => {
  const ARB2 = [ARB[0], { tache: 'T00', titre: 'Seuil', option: { id: 'A', description: "Plafond à 30 s, l'option sûre" } }]
  const { res, calls, q } = await scenario('V5', { 'arbitrage T02 · suivi': [{ ...avecSuivi(SOK), ouverture_ok: true }], 'arbitrage T00 · suivi': [avecSuivi(SOK)], 'lecteur-plan': [plan(T00)], ...s00(), 'fin de run · suivi': [GOK] }, { ...AS, arbitrages: ARB2 })
  assert.equal(res.statut, 'terminé'); assert.deepEqual(res.suivi_echecs, [])
  const a1 = suiviDe(calls, 'arbitrage T02 · suivi'), a2 = suiviDe(calls, 'arbitrage T00 · suivi')
  assert.deepEqual([a1.map(x => x.cmd), a2.map(x => x.cmd)], [['debut-run', 'arbitrage'], ['arbitrage']])
  assert.ok(byLabel(calls, 'arbitrage T02 · suivi')[0].prompt.startsWith(ENTETE + ', ouvre le run'))
  assert.deepEqual(a1[1].E, { tache: 'T02', titre: 'Contrat', option: 'B', taches_ajoutees: [{ id: 'T01B', titre: 'Doc', phase: 1 }], amendements: [{ id: 'T01', raison: 'r' }] })
  assert.deepEqual(a2[0].E, { tache: 'T00', titre: 'Seuil', option: 'A' })
  const lp = byLabel(calls, 'lecteur-plan')[0].prompt
  assert.ok(!lp.includes('suivi.mjs') && !lp.includes('ouverture_ok'), "le lecteur-plan n'ouvre pas une seconde fois")
  const sa = byLabel(calls, 'arbitrage T02 · suivi')[0].prompt
  assert.ok(sa.includes('la commande de suivi ci-dessous y ajoute leur ligne') && !sa.includes('sa ligne de SUIVI.md') && sa.indexOf('suivi.mjs arbitrage') > sa.indexOf('plan-lint.mjs plans/p --integration'))
  assert.deepEqual(suiviDe(calls, 'fin de run · suivi')[0].E.arbitrages_appliques, [{ tache: 'T02', titre: 'Contrat', option: 'B' }, { tache: 'T00', titre: 'Seuil', option: 'A' }])
  vide('V5', q)
})
await cas('V6 : suivi — ouverture refusée par le script → erreur, aucune tâche ni greffier', async () => {
  const E1 = 'suivi : SUIVI.md, ligne 5 : statut inconnu « en-cours » pour T00'
  let { res, calls, q } = await scenario('V6a', { 'lecteur-plan': [{ ok: false, taches: [], ouverture_ok: false, suivi_erreur: E1 }] }, AS)
  assert.equal(res.statut, 'erreur'); assert.ok(res.detail.startsWith('suivi : run non ouvert') && res.detail.includes(E1))
  assert.deepEqual(res.suivi_echecs, [{ tache: null, etape: 'debut-run', erreur: E1 }]); assert.equal(calls.length, 1)
  vide('V6a', q)
  ;({ res, calls, q } = await scenario('V6b', { 'arbitrage T02 · suivi': [{ ok: false, ouverture_ok: false, suivi_erreur: E1 }] }, { ...AS, arbitrages: ARB }))
  assert.equal(res.statut, 'erreur'); assert.deepEqual(res.arbitrages_appliques, [], 'arbitrage à repasser'); assert.equal(calls.length, 1)
  vide('V6b', q)
  ;({ res, calls, q } = await scenario('V6c', { 'lecteur-plan': [plan(T00)] }, AS))
  assert.equal(res.statut, 'erreur'); assert.deepEqual(res.suivi_echecs, [{ tache: null, etape: 'debut-run', erreur: 'résultat non rapporté' }])
  vide('V6c', q)
  // Premier agent sans réponse : on ne sait pas si le run est ouvert, pas de greffier
  ;({ res, calls, q } = await scenario('V6d', { 'arbitrage T02 · suivi': [null] }, { ...AS, arbitrages: ARB }))
  assert.deepEqual([res.statut, res.arbitrage.contexte, calls.length], ['arbitrage', 'scribe sans réponse', 1])
  vide('V6d', q)
  ;({ res, calls, q } = await scenario('V6e', { 'lecteur-plan': [null] }, AS))
  assert.deepEqual([res.statut, calls.length], ['erreur', 1])
  vide('V6e', q)
})
await cas('V7 : suivi — étape ratée ou non rapportée → le run continue, suivi_echecs la cite', async () => {
  const { res, q } = await scenario('V7', { 'lecteur-plan': [planS(T00)], ...s00({ 'T00 · worker': [rap(0)], 'T00 · vérification': [{ ...ok(1), suivi_ok: false, suivi_erreur: 'suivi : verrou tenu' }] }), 'fin de run · suivi': [{ suivi_ok: false, suivi_erreur: 'suivi : aucun run en cours' }] }, AS)
  assert.equal(res.statut, 'terminé')
  assert.deepEqual(res.suivi_echecs, [{ tache: 'T00', etape: 'worker', erreur: 'résultat non rapporté' }, { tache: 'T00', etape: 'vérification', erreur: 'suivi : verrou tenu' }, { tache: null, etape: 'fin-run', erreur: 'suivi : aucun run en cours' }])
  vide('V7', q)
  // Greffier qui n'a pas pu se placer sur la branche d'intégration : SUIVI.md non commité, signalé
  const r2 = await scenario('V7b', { 'lecteur-plan': [planS(T00)], ...s00(), 'fin de run · suivi': [{ suivi_ok: true, commit: '', detail: 'git switch refusé : modifications locales' }] }, AS)
  assert.deepEqual(r2.res.suivi_echecs, [{ tache: null, etape: 'fin-run', erreur: 'SUIVI.md non commité : git switch refusé : modifications locales' }])
  vide('V7b', r2.q)
  // Greffier sans réponse, ou qui lève (limite d'usage) : le bilan revient quand même au pilote
  for (const [nom, rep, erreur] of [['V7c', null, 'greffier sans réponse'], ['V7d', () => { throw new Error('usage limit') }, 'greffier en erreur : Error: usage limit']]) {
    const r3 = await scenario(nom, { 'lecteur-plan': [planS(T00, T01)], ...s00({ 'T00 · worker': [avecSuivi(rap(0, { ecarts: ECART }))], 'T00 · replanification': [RP_E] }), ...s01(), 'fin de run · suivi': [rep] }, AS)
    assert.equal(r3.res.statut, 'terminé'); assert.equal(r3.res.points_a_trancher[0].options[0].amendements[0].id, 'T01', 'actions gardées')
    assert.deepEqual(r3.res.suivi_echecs, [{ tache: null, etape: 'fin-run', erreur }])
    vide(nom, r3.q)
  }
})
await cas('V8 : suivi — clôture non écrite → arrêt humain ; arbitrage non noté → statut arbitrage ; le greffier passe quand même', async () => {
  let { res, calls, q } = await scenario('V8a', { 'lecteur-plan': [planS(T00, T01)], ...s00({ 'T00 · suivi': [{ ...SOK, suivi_ok: false, suivi_erreur: 'suivi : écriture refusée' }] }), 'fin de run · suivi': [GOK] }, AS)
  assert.deepEqual([res.statut, res.arbitrage.titre, res.arbitrage.humain, res.non_lancees], ['arbitrage', 'Suivi de T00 : clôture non écrite dans suivi.json', true, ['T01']])
  assert.ok(res.arbitrage.contexte.startsWith('suivi : écriture refusée'))
  assert.deepEqual(res.suivi_echecs, [{ tache: 'T00', etape: 'cloture', erreur: 'suivi : écriture refusée' }])
  const fr = suiviDe(calls, 'fin de run · suivi')[0].E
  assert.deepEqual([fr.statut, fr.arbitrage.titre, fr.taches], ['arbitrage', 'Suivi de T00 : clôture non écrite dans suivi.json', [{ id: 'T00', statut: 'fusionnée', essais: 1, branche: 'tache/T00' }]])
  vide('V8a', q)
  ;({ res, calls, q } = await scenario('V8b', { 'arbitrage T02 · suivi': [{ ...SOK, ouverture_ok: true, suivi_ok: false, suivi_erreur: 'suivi : tâche inconnue du suivi : T02' }], 'fin de run · suivi': [GOK] }, { ...AS, arbitrages: ARB }))
  assert.deepEqual([res.statut, res.arbitrage.titre], ['arbitrage', 'Arbitrage « Contrat » appliqué en partie'])
  assert.ok(res.arbitrage.contexte.includes('suivi.json et SUIVI.md non écrits : suivi : tâche inconnue du suivi : T02'))
  assert.deepEqual(res.arbitrages_appliques, [{ tache: 'T02', titre: 'Contrat', option: 'B' }], 'appliqué dans HANDOFF : à ne pas repasser')
  assert.equal(byLabel(calls, 'fin de run · suivi').length, 1)
  assert.deepEqual(res.suivi_echecs, [{ tache: 'T02', etape: 'arbitrage', erreur: 'suivi : tâche inconnue du suivi : T02' }])
  vide('V8b', q)
  // Contrôle post-fusion en échec : son point part avec la clôture
  ;({ res, calls, q } = await scenario('V8c', { 'lecteur-plan': [planS(T00)], ...s00({ 'T00 · fusion': [avecSuivi({ ok: false, fusionne: true, controle_ok: false, detail: 'typecheck KO' })] }), 'fin de run · suivi': [GOK] }, AS))
  assert.equal(res.statut, 'arbitrage')
  assert.deepEqual(suiviDe(calls, 'T00 · suivi')[1].E.points.map(p => [p.titre, p.humain]), [['Contrôle post-fusion en échec après T00', true]])
  vide('V8c', q)
  // Règle d'autorisation du suivi absente : le vérificateur cite la commande de suivi parmi les refusées ; ce n'est pas un échec de la tâche
  ;({ res, calls, q } = await scenario('V8d', { 'lecteur-plan': [planS(T00)], ...s00({ 'T00 · vérification': [{ ...ok(1), suivi_ok: false, suivi_erreur: 'permission refusée', interdites: [`node ${SV} etape plans/p --json '{}'`] }] }), 'fin de run · suivi': [GOK] }, AS))
  assert.equal(res.statut, 'terminé'); assert.equal(byLabel(calls, 'T00 · évaluation').length, 1); assert.deepEqual(res.relectures, [])
  vide('V8d', q)
})
await cas("V9 : suivi — plan illisible après l'ouverture → greffier ; exception d'une tâche → bilan pour fin-run", async () => {
  let { res, calls, q } = await scenario('V9a', { 'lecteur-plan': [{ ok: false, erreurs: ['T09 : dépendance inconnue'], taches: [], ouverture_ok: true }], 'fin de run · suivi': [GOK] }, AS)
  assert.equal(res.statut, 'erreur'); assert.deepEqual(suiviDe(calls, 'fin de run · suivi')[0].E.detail, 'T09 : dépendance inconnue')
  vide('V9a', q)
  ;({ res, calls, q } = await scenario('V9b', { 'lecteur-plan': [planS(T00)], 'T00 · worker': [() => { throw new Error("l'agent a planté") }], 'fin de run · suivi': [GOK] }, AS))
  assert.equal(res.statut, 'partiel')
  assert.deepEqual(suiviDe(calls, 'fin de run · suivi')[0].E.taches, [{ id: 'T00', statut: 'échec', blocage: ["erreur du workflow : Error: l'agent a planté"] }], 'essais et branche inconnus : le suivi garde les siens')
  vide('V9b', q)
})
await cas("V13 : suivi — clôture avec tests instables, critère non vérifiable et relecture ; en autonome, point sans recommandation unique dans la clôture", async () => {
  const NV = 'comportement en worktree : la tâche tourne dans le checkout principal'
  const R = { type: 'relecture', description: '.env.example : ajouter MR_MAX' }
  let { res, calls, q } = await scenario('V13a', { 'lecteur-plan': [planS(T00)], ...s00({ 'T00 · worker': [avecSuivi(rap(0, { ecarts: [R] }))], 'T00 · vérification': [avecSuivi({ ...ok(1), instables: ['journal.spec.ts:53'] })], 'T00 · évaluation': [avecSuivi({ verdict: 'ok', non_verifiables: [NV] })], 'T00 · replanification': [RIEN] }), 'fin de run · suivi': [GOK] }, AS)
  assert.equal(res.statut, 'terminé')
  assert.deepEqual(suiviDe(calls, 'T00 · suivi')[1].E, { tache: 'T00', statut: 'fusionnée', essais: 1, branche: 'tache/T00', instables: ['journal.spec.ts:53'], non_verifiables: [NV], relectures: ['.env.example : ajouter MR_MAX'], replanification: true })
  vide('V13a', q)
  const P2 = { titre: 'Deux recos', contexte: '', options: [{ id: 'A', description: 'a', recommande: true }, { id: 'B', description: 'b', recommande: true }] }
  ;({ res, calls, q } = await scenario('V13b', { 'lecteur-plan': [planS(T00, T01)], ...s00({ 'T00 · worker': [avecSuivi(rap(0, { ecarts: ECART }))], 'T00 · replanification': [{ majeur: true, entrees: [], points: [P2] }] }), 'fin de run · suivi': [GOK] }, { ...AS, mode: 'auto' }))
  assert.equal(res.statut, 'arbitrage')
  const cl = suiviDe(calls, 'T00 · suivi')[1].E
  assert.deepEqual(cl.points, [{ tache: 'T00', titre: 'Deux recos', contexte: '', humain: false, options: [{ id: 'A', description: 'a', recommande: true }, { id: 'B', description: 'b', recommande: true }] }])
  assert.ok(!('decisions_office' in cl))
  vide('V13b', q)
  // Option recommandée qui cite une tâche que rien ne crée ; plafond de décisions d'office à 0 : coupe-circuit
  const P3 = { titre: 'Code 1 accepté', options: [{ id: 'A', description: 'T06B fournira le script', recommande: true }, { id: 'B', description: 'autre' }] }
  ;({ res, calls, q } = await scenario('V13c', { 'lecteur-plan': [planS(T00, T01)], ...s00({ 'T00 · worker': [avecSuivi(rap(0, { ecarts: ECART }))], 'T00 · replanification': [{ majeur: true, entrees: [], points: [P3, pt(1)] }] }), 'fin de run · suivi': [GOK] }, { ...AS, mode: 'auto', decisions_office_max: 0 }))
  const [p3, p1] = suiviDe(calls, 'T00 · suivi')[1].E.points
  assert.deepEqual([p3.titre, p3.incoherence, p1.titre, p1.coupe_circuit], ['Code 1 accepté', "tâches citées qui n'existent pas et que l'option ne crée pas : T06B", 'P1', true])
  assert.equal(suiviDe(calls, 'lecteur-plan')[0].E.decisions_office_max, 0)
  vide('V13c', q)
})
await cas('V10 : sans args.suivi, consignes de la 0.6.3 : aucune commande de suivi, pas de greffier', async () => {
  const { res, calls, q } = await scenario('V10', { 'lecteur-plan': [plan(T00)], ...t00(), 'T00 · suivi': [SOK] })
  assert.equal(res.statut, 'terminé'); assert.ok(!('suivi_echecs' in res))
  assert.ok(calls.every(c => !c.prompt.includes('suivi.mjs') && !c.prompt.includes('Suivi du plan')))
  assert.ok(byLabel(calls, 'T00 · suivi')[0].prompt.includes('- SUIVI.md : ligne T00 → statut « fusionnée », essais 1, branche tache/T00'))
  vide('V10', q)
})

// ——— 0.8.0 : le workflow joué avec le vrai suivi.mjs, dans un dépôt temporaire ; les agents simulés lancent les commandes de leur consigne ———
const SUIVI_VRAI = join(resolve(dirname(SRC), '..'), 'scripts', 'suivi.mjs')
function depotJouet() {
  const racine = fs.mkdtempSync(join(tmpdir(), 'scenarios-suivi-'))
  const git = (...a) => execFileSync('git', a, { cwd: racine, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  fs.writeFileSync(join(racine, 'README.md'), 'x\n'); git('add', '.'); git('commit', '-qm', 'init')
  const d = join(racine, 'plans', 'p')
  fs.mkdirSync(join(d, 'taches'), { recursive: true })
  const ecrireTache = (id, dep) => fs.writeFileSync(join(d, 'taches', `${id}-x.md`), `---\nid: ${id}\ntitre: Tâche ${id}\nphase: 1\nmodele: sonnet\ndepend_de: [${dep.join(', ')}]\nlot_parallele: 1A\nfichiers_possedes:\n  - src/${id}/**\nressources: []\nestimation_tokens: 1.0M\nverification:\n  - "npm test"\ndefinition_du_fini:\n  - "le test passe"\n---\n\n## Prompt de lancement\nTu réalises ${id}.\n`)
  ecrireTache('T00', []); ecrireTache('T01', ['T00'])
  fs.writeFileSync(join(d, 'SUIVI.md'), '# SUIVI — p\n\n| ID | Titre | Phase | Lot | Dépend de | Modèle | Statut | Essais | Branche | Tokens est. / réels |\n|---|---|---|---|---|---|---|---|---|---|\n| T00 | Tâche T00 | 1 | 1A | — | sonnet | à-faire | 0 | — | 1,0 M / — |\n| T01 | Tâche T01 | 1 | 1A | T00 | sonnet | à-faire | 0 | — | 1,0 M / — |\n\nStatuts : à-faire · ajoutée · fusionnée · bloquée · échec · besoin-humain · annulée\n')
  fs.writeFileSync(join(d, 'HANDOFF.md'), '# HANDOFF — p\n')
  fs.writeFileSync(join(d, 'orchestre.config.json'), JSON.stringify({ branche_integration: 'plan/p' }))
  git('switch', '-qc', 'plan/p'); git('add', '.'); git('commit', '-qm', 'plan')
  return { racine, git, ecrireTache, doc: () => JSON.parse(fs.readFileSync(join(d, 'suivi.json'), 'utf8')), ligne: id => fs.readFileSync(join(d, 'SUIVI.md'), 'utf8').split('\n').find(l => l.startsWith(`| ${id} `)) }
}
// Chaque commande de suivi de la consigne passe par le shell, dans l'ordre ; le rapport porte leurs codes de sortie
async function joue(nom, D, q, args = {}) {
  const lances = []
  const agent = async (prompt, opts = {}) => {
    const k = opts.label
    if (!(k in q) || !q[k].length) throw new Error(`[${nom}] appel inattendu : ${k}`)
    const v0 = q[k].shift(), cs = commandes(prompt)
    // { avant, rep } : ce que l'agent fait avant ses commandes de suivi (le scribe écrit les tâches créées)
    const v = v0 && typeof v0 === 'object' && 'avant' in v0 ? (v0.avant(), v0.rep) : v0
    const codes = cs.map(c => { const r = spawnSync('sh', ['-c', c], { cwd: D.racine, encoding: 'utf8' }); lances.push({ label: k, code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }); return r.status })
    const rep = typeof v === 'function' ? v(prompt, opts) : v
    // Le greffier lance aussi le nettoyage des worktrees : sa dernière ligne va dans « worktrees »
    const wt = [...prompt.matchAll(/`(node "?[^`"]*worktrees\.mjs"? nettoyer [^`]*)`/g)].map(m => m[1])
    const nettoyage = wt.map(c => { const r = spawnSync('sh', ['-c', c], { cwd: D.racine, encoding: 'utf8' }); lances.push({ label: k, code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }); return r.stdout.trim() || r.stderr.trim() }).pop()
    if (!cs.length) return rep
    return { ...rep, ...(cs[0].includes('suivi.mjs" debut-run') || cs[0].includes('suivi.mjs debut-run') ? { ouverture_ok: codes[0] === 0 } : {}), suivi_ok: codes[codes.length - 1] === 0, ...(nettoyage ? { worktrees: nettoyage } : {}) }
  }
  dernier = null
  const res = await run({ ...ARGS, suivi: SUIVI_VRAI, ...args }, agent, () => {}, () => {})
  dernier = { res, lances }
  return { res, lances }
}
const T0 = { ...T00, ressources: [], fichier: 'plans/p/taches/T00-x.md', verification: ['npm test'] }
const T1 = { ...T01, modele: 'sonnet', ressources: [], fichier: 'plans/p/taches/T01-x.md', verification: ['npm test'] }
await cas('V11 : vrai suivi.mjs — T00 fusionnée après un refus, T01 bloquée : suivi.json valide, journal dans l\'ordre, SUIVI.md régénéré', async () => {
  const D = depotJouet()
  try {
    const M = "commentaire faux sur l'option `--force` ($HOME)"
    const { res, lances } = await joue('V11', D, {
      'lecteur-plan': [plan(T0, T1)], 'T00 · worker': [rap(0)], 'T00 · vérification': [ok(1), ok(2)], 'T00 · évaluation': [{ verdict: 'ko', manques: [M] }, { verdict: 'ok' }],
      'T00 · correction 1': [rap(1)], 'T00 · fusion': [FOK], 'T00 · suivi': [SOK],
      'T01 · worker': [{ statut: 'blocked', resume: 'bloqué', branche: 'tache/T01', chemin: D.racine, blocage: 'schéma ambigu' }], 'T01 · replanification': [RIEN], 'T01 · suivi': [SOK],
      'fin de run · suivi': [{ commit: '', detail: '' }] })
    assert.deepEqual(lances.filter(l => l.code !== 0), [], 'toutes les commandes de suivi passent')
    assert.equal(lances.length, 15, '14 commandes de suivi et le nettoyage des worktrees')
    assert.equal(res.statut, 'partiel'); assert.deepEqual(res.suivi_echecs, [])
    const doc = D.doc(), t = id => doc.taches.find(x => x.id === id)
    assert.deepEqual(doc.runs.map(r => [r.numero, r.statut, r.phase, r.mode, r.parallelisme, r.fin !== null]), [[1, 'partiel', 1, 'phase', 4, true]])
    assert.deepEqual([t('T00').statut, t('T00').essais, t('T00').branche, t('T00').etape, t('T00').isole], ['fusionnée', 2, 'tache/T00', null, false])
    assert.deepEqual(t('T00').refus, [{ essai: 1, par: 'évaluation', manques: [M] }])
    assert.deepEqual([t('T01').statut, t('T01').essais, t('T01').blocage, t('T01').etape], ['bloquée', 1, ['schéma ambigu'], null])
    assert.deepEqual(doc.journal.filter(e => e.tache === 'T00').map(e => e.texte), ['T00 démarre (checkout principal)', 'T00 : vérification', 'T00 : évaluation', 'T00 : essai 1 refusé (évaluation) : 1 manque(s)', 'T00 : correction (essai 2)', 'T00 : vérification', 'T00 : évaluation', 'T00 : fusion', 'T00 : suivi', 'T00 : fusionnée (2 essais)'])
    assert.deepEqual(doc.journal.filter(e => e.tache === 'T01').map(e => e.texte), ['T01 démarre (checkout principal)', 'T01 : suivi', 'T01 : replanification terminée', 'T01 : bloquée (1 essai) — schéma ambigu'])
    assert.match(D.ligne('T00'), /\| fusionnée \| 2 +\| tache\/T00 \| 1,0 M \/ voir \/workflows \|$/)
    assert.match(D.ligne('T01'), /\| bloquée +\| 1 +\| tache\/T01 \|/)
    assert.equal(lances.find(l => l.label === 'fin de run · suivi').out, 'suivi : run 1 partiel', 'rien à commiter pour le greffier')
    assert.equal(lances[lances.length - 1].out, 'worktrees plans/p : 0 retiré, 0 gardé')
    assert.equal(spawnSync(process.execPath, [SUIVI_VRAI, 'valider', 'plans/p'], { cwd: D.racine }).status, 0)
  } finally { fs.rmSync(D.racine, { recursive: true, force: true }) }
})
await cas("V12 : vrai suivi.mjs — exception d'une tâche : fin-run la clôt en échec et régénère SUIVI.md, que le greffier commitera", async () => {
  const D = depotJouet()
  try {
    const { res, lances } = await joue('V12', D, { 'lecteur-plan': [plan(T0)], 'T00 · worker': [() => { throw new Error('boom') }], 'fin de run · suivi': [{ commit: '', detail: '' }] })
    assert.equal(res.statut, 'partiel'); assert.deepEqual(res.suivi_echecs, [])
    assert.equal(lances.find(l => l.label === 'fin de run · suivi').out, 'suivi : run 1 partiel ; SUIVI.md régénéré, à commiter')
    const t = D.doc().taches.find(x => x.id === 'T00')
    assert.deepEqual([t.statut, t.etape, t.blocage], ['échec', null, ['erreur du workflow : Error: boom']])
    assert.match(D.ligne('T00'), /\| échec +\| 1 +\|/, 'essais du suivi (étape worker), pas le 0 du bilan')
    assert.equal(D.git('status', '--porcelain'), ' M plans/p/SUIVI.md\n', 'seul SUIVI.md, suivi.json hors de git')
  } finally { fs.rmSync(D.racine, { recursive: true, force: true }) }
})
await cas("V14 : vrai suivi.mjs — clôture complète en autonome (décision d'office, tâche ajoutée, point d'arrêt, relecture), puis arbitrage au run suivant", async () => {
  const D = depotJouet()
  try {
    const P2 = { titre: 'Deux recos', contexte: "l'un ou l'autre", options: [{ id: 'A', description: 'a', recommande: true, entrees: [{ type: 'dette', gravite: 'mineur', description: 'x' }] }, { id: 'B', description: 'b', recommande: true }] }
    const R = { type: 'relecture', description: '.env.example : ajouter MR_MAX' }
    const run1 = await joue('V14a', D, {
      'lecteur-plan': [plan(T0, T1)], 'T00 · worker': [rap(0, { ecarts: [...ECART, R] })], 'T00 · vérification': [ok(1)], 'T00 · évaluation': [{ verdict: 'ok' }], 'T00 · fusion': [FOK],
      'T00 · replanification': [{ ...RP_E, points: [...RP_E.points, P2] }],
      'T00 · suivi': [{ avant: () => D.ecrireTache('T00C', ['T00']), rep: SOK }], 'fin de run · suivi': [{ commit: '', detail: '' }] }, { mode: 'auto' })
    assert.deepEqual(run1.lances.filter(l => l.code !== 0), [])
    assert.equal(run1.res.statut, 'arbitrage'); assert.deepEqual(run1.res.suivi_echecs, [])
    let doc = D.doc()
    const t = id => doc.taches.find(x => x.id === id)
    assert.deepEqual(doc.taches.map(x => [x.id, x.statut, x.ajoutee_par]), [['T00', 'fusionnée', null], ['T00C', 'ajoutée', 'T00'], ['T01', 'à-faire', null]])
    assert.deepEqual(doc.decisions_office, [{ run: 1, tache: 'T00', titre: 'Contrat UpdateUserSchema', option: 'A', description: 'Garder optionnel et tester la règle (d)' }])
    assert.deepEqual(doc.points.map(p => [p.run, p.tache, p.titre, p.role, p.statut, p.options.length]), [[1, 'T00', 'Deux recos', 'arret', 'ouvert', 2]])
    assert.deepEqual(doc.relectures.map(r => [r.tache, r.texte, r.run]), [['T00', '.env.example : ajouter MR_MAX', 1]])
    assert.deepEqual([doc.runs[0].statut, doc.runs[0].taches_ajoutees, doc.runs[0].non_lancees], ['arbitrage', [{ id: 'T00C', phase: 1, titre: 'Test règle d' }], ['T01']])
    assert.ok(doc.journal.some(e => e.genre === 'amendement' && e.tache === 'T01'))
    assert.ok(/\| T00C \| Test règle d /.test(D.ligne('T00C')), 'ligne ajoutée par le script, titre du replanificateur')
    D.git('add', '-A'); D.git('commit', '-qm', 'suivi(T00) : fusionnée')
    // Run 2 : l'utilisateur tranche « Deux recos » ; le scribe ouvre le run et note l'arbitrage
    const run2 = await joue('V14b', D, {
      'arbitrage T00 · suivi': [SOK], 'lecteur-plan': [plan({ ...T0, statut: 'fusionnée' })], 'fin de run · suivi': [{ commit: '', detail: '' }] },
      { arbitrages: [{ tache: 'T00', titre: 'Deux recos', option: P2.options[0] }] })
    assert.deepEqual(run2.lances.filter(l => l.code !== 0), [])
    assert.deepEqual(run2.lances.map(l => l.out.split(' ;')[0]), ['suivi : run 2 ouvert (phase 1, mode phase)', 'suivi : arbitrage T00 option A', 'suivi : run 2 terminé', 'worktrees plans/p : 0 retiré, 0 gardé'])
    doc = D.doc()
    assert.deepEqual([doc.points[0].statut, doc.points[0].option_choisie], ['tranché', 'A'])
    assert.deepEqual(doc.runs.map(r => [r.numero, r.statut]), [[1, 'arbitrage'], [2, 'terminé']])
    assert.deepEqual(doc.runs[1].arbitrages_appliques, [{ tache: 'T00', titre: 'Deux recos', option: 'A' }])
    assert.equal(spawnSync(process.execPath, [SUIVI_VRAI, 'valider', 'plans/p'], { cwd: D.racine }).status, 0)
  } finally { fs.rmSync(D.racine, { recursive: true, force: true }) }
})
await cas("V15 : vrai suivi.mjs — tâche ajoutée par un arbitrage gardée dans le run malgré le bilan de fin, qui ne la connaît pas", async () => {
  const D = depotJouet()
  try {
    const A = { tache: 'T00', titre: 'Contrat', option: { id: 'B', description: 'Tester', taches_ajoutees: [{ id: 'T00D', titre: 'Test du contrat', phase: 1, contenu: '---\nid: T00D\n---' }] } }
    const r = await joue('V15', D, { 'arbitrage T00 · suivi': [{ avant: () => D.ecrireTache('T00D', ['T00']), rep: SOK }], 'lecteur-plan': [plan({ ...T0, statut: 'fusionnée' })], 'fin de run · suivi': [{ commit: '', detail: '' }] }, { arbitrages: [A] })
    assert.deepEqual(r.lances.filter(l => l.code !== 0), [])
    const doc = D.doc()
    assert.deepEqual(doc.runs[0].taches_ajoutees, [{ id: 'T00D', phase: 1, titre: 'Test du contrat' }])
    assert.deepEqual(doc.taches.find(x => x.id === 'T00D').ajoutee_par, 'T00')
  } finally { fs.rmSync(D.racine, { recursive: true, force: true }) }
})
// ——— Lot A (0.8.0) : environnement des dossiers de travail, reprise de branche, nettoyage des worktrees ———
const PREP = { preparation: ['pnpm install --frozen-lockfile', 'pnpm prisma generate'], preparation_partagee: { 'base-test': ['pnpm db:test:prepare'], inutilisee: ['make x'] } }
await cas('A1 : préparation lancée par chaque worker sur sa branche et par l’intégrateur avant le contrôle ; partagée seulement sous la ressource déclarée', async () => {
  const TB = { ...T00, ressources: ['base-test'] }, TS = { ...T01, depend_de: [], ressources: [] }
  const { res, calls, q } = await scenario('A1', { 'lecteur-plan': [plan(TB, TS)], ...t00(), 'T00 · suivi': [SOK], 'T01 · worker': [rap(1, { branche: 'tache/T01', chemin: '/wt/T01' })], 'T01 · vérification': [ok(2)], 'T01 · évaluation': [{ verdict: 'ok' }], 'T01 · fusion': [FOK], 'T01 · suivi': [SOK] }, PREP)
  assert.equal(res.statut, 'terminé')
  const w0 = byLabel(calls, 'T00 · worker')[0].prompt, w1 = byLabel(calls, 'T01 · worker')[0].prompt
  assert.ok(w0.includes('Préparation de l\'environnement, une fois sur ta branche, avant tout autre travail : lance une à une, telles quelles, ces commandes du projet : `pnpm install --frozen-lockfile`, `pnpm prisma generate`, `pnpm db:test:prepare`.'))
  assert.ok(w1.includes('ces commandes du projet : `pnpm install --frozen-lockfile`, `pnpm prisma generate`.'), 'T01 ne déclare pas base-test')
  assert.ok(w0.indexOf('Préparation') > w0.indexOf('Branche :'), 'après la branche')
  assert.ok(!w0.includes('make x') && !w1.includes('make x'))
  const f0 = byLabel(calls, 'T00 · fusion')[0].prompt
  assert.ok(f0.indexOf('`pnpm db:test:prepare`') > f0.indexOf('rends fusionne=true') && f0.indexOf('`pnpm db:test:prepare`') < f0.indexOf('cette commande de contrôle'), 'intégrateur : entre la fusion et le contrôle')
  assert.ok(f0.includes('ne lance pas le contrôle : rends controle_ok=false'))
  assert.ok(!byLabel(calls, 'T01 · fusion')[0].prompt.includes('db:test:prepare'))
  assert.ok(!byLabel(calls, 'T00 · vérification')[0].prompt.includes('Préparation'), 'le vérificateur ne prépare rien')
  vide('A1', q)
})
await cas('A2 : sans préparation, ou mal formée, aucune consigne ; reprise de branche par fusion, jamais de rebase ; garde rappelée au seul worker isolé', async () => {
  let { calls, q } = await scenario('A2', { 'lecteur-plan': [plan(T00)], ...t00(), 'T00 · suivi': [SOK] }, { preparation: 'pnpm install', preparation_partagee: [['x']] })
  const w = byLabel(calls, 'T00 · worker')[0].prompt
  assert.ok(calls.every(c => !c.prompt.includes('Préparation de l\'environnement')))
  for (const x of ['git merge-base --is-ancestor plan/p HEAD', 'git merge --no-edit plan/p', 'git merge --abort', 'Jamais de rebase ni de reset']) assert.ok(w.includes(x), 'reprise : ' + x)
  assert.ok(!w.includes("garde d'isolement"), 'checkout principal : pas de garde')
  vide('A2', q)
  const T02 = { ...T00, id: 'T02', titre: 'Autre', fichier: 'plans/p/taches/T02.md', ressources: [] }, T03 = { ...T02, id: 'T03', fichier: 'plans/p/taches/T03.md' }
  const tt = id => ({ [`${id} · worker`]: [rap(id, { branche: `tache/${id}`, chemin: `/wt/${id}` })], [`${id} · vérification`]: [ok(id)], [`${id} · évaluation`]: [{ verdict: 'ok' }], [`${id} · fusion`]: [FOK], [`${id} · suivi`]: [SOK] })
  ;({ calls, q } = await scenario('A2b', { 'lecteur-plan': [plan(T02, T03)], ...tt('T02'), ...tt('T03') }))
  assert.ok(byLabel(calls, 'T02 · worker')[0].prompt.includes("Tu es dans un worktree isolé : la garde d'isolement de Claude Code n'y accepte que des commandes simples"))
  vide('A2b', q)
})
await cas('A3 : le greffier nettoie les worktrees après le commit de SUIVI.md ; sa ligne revient au pilote', async () => {
  const { res, calls, q } = await scenario('A3', { 'lecteur-plan': [planS(T00)], ...s00(), 'fin de run · suivi': [{ ...GOK, worktrees: 'worktrees plans/p : 1 retiré, 0 gardé' }] }, AS)
  assert.equal(res.worktrees, 'worktrees plans/p : 1 retiré, 0 gardé')
  const g = byLabel(calls, 'fin de run · suivi')[0]
  assert.ok(g.prompt.includes('4. `node /plug/scripts/worktrees.mjs nettoyer plans/p`') && g.prompt.indexOf('worktrees.mjs') > g.prompt.indexOf('git commit'))
  assert.ok(g.prompt.includes('saute les points 3 et 4'))
  assert.ok('worktrees' in g.opts.schema.properties)
  vide('A3', q)
})
await cas('A4 : vrai worktrees.mjs — en fin de run, le worktree propre d’un essai précédent est retiré, sa branche gardée', async () => {
  const D = depotJouet()
  try {
    const W = join(D.racine, '..', `wt-${process.pid}`)
    D.git('worktree', 'add', '-q', '-b', 'tache/T01', W, 'plan/p')
    const r = await joue('A4', D, { 'lecteur-plan': [plan(T0)], 'T00 · worker': [rap(0)], 'T00 · vérification': [ok(1)], 'T00 · évaluation': [{ verdict: 'ok' }], 'T00 · fusion': [FOK], 'T00 · suivi': [SOK], 'fin de run · suivi': [{ commit: '', detail: '' }] })
    assert.deepEqual(r.lances.filter(l => l.code !== 0), [])
    assert.match(r.res.worktrees, /^retiré tache\/T01 \(.*\), branche gardée\nworktrees plans\/p : 1 retiré, 0 gardé$/)
    assert.ok(!fs.existsSync(W))
    assert.ok(D.git('branch', '--list', 'tache/T01').includes('tache/T01'), 'branche gardée')
  } finally { fs.rmSync(D.racine, { recursive: true, force: true }) }
})
await cas('A5 : correction — la préparation se relance si besoin ; intégrateur — rien de modifié après la préparation ; arrêt qui la nomme', async () => {
  const TB = { ...T00, ressources: ['base-test'] }
  const { res, calls, q } = await scenario('A5', { 'lecteur-plan': [plan(TB)], 'T00 · worker': [rap(0)], 'T00 · vérification': [ok(1), ok(2)], 'T00 · évaluation': [{ verdict: 'ko', manques: ['M1'] }, { verdict: 'ok' }], 'T00 · correction 1': [rap(1)], 'T00 · fusion': [{ ok: false, fusionne: true, controle_ok: false, detail: 'préparation : fichiers modifiés src/generated/client.ts' }], 'T00 · suivi': [SOK] }, PREP)
  const c = byLabel(calls, 'T00 · correction 1')[0].prompt
  assert.ok(c.includes('Si ta correction change les dépendances ou ce qui se génère, relance d’abord'.replace('’', "'")) && c.includes('`pnpm db:test:prepare`'))
  const f = byLabel(calls, 'T00 · fusion')[0].prompt
  assert.ok(f.includes('`git status --porcelain` doit être vide') && f.includes('« préparation : fichiers modifiés »'))
  assert.equal(res.statut, 'arbitrage'); assert.ok(res.arbitrage.contexte.startsWith('préparation ou contrôle post-fusion en échec sur plan/p'))
  vide('A5', q)
})
// ——— 0.11.0 : le modèle de chaque tâche, et le choix du modèle des corrections ———
const TM = (modele, extra = {}) => ({ id: 'T05', titre: 'Modèle', fichier: 'plans/p/taches/T05.md', phase: 1, ...(modele ? { modele } : {}), raison_modele: 'implémentation courante', depend_de: [], ressources: [], statut: 'à-faire', verification: ['npm test'], ...extra })
const rap5 = (n, extra = {}) => avecSuivi(rap(n, { branche: 'tache/T05', ...extra }))
const ok5 = x => avecSuivi({ ok: true, resultats: [{ commande: 'npm test', code: 0, extrait: 'ok ' + x }] })
const ko5 = m => avecSuivi({ verdict: 'ko', manques: [m] })
const fin5 = () => ({ 'T05 · fusion': [avecSuivi(FOK)], 'T05 · suivi': [avecSuivi(SOK)], 'fin de run · suivi': [GOK] })
const etapes = (calls, l) => byLabel(calls, l).map(c => commandes(c.prompt).map(lire)[0].E)
await cas('M1 : le worker tourne sur le modèle de la tâche, tel quel, et le passe au suivi ; sans refus, aucun choix du modèle', async () => {
  for (const m of ['haiku', 'opus', 'fable']) {
    const { res, calls, q } = await scenario('M1 ' + m, { 'lecteur-plan': [planS(TM(m))], 'T05 · worker': [rap5(0)], 'T05 · vérification': [ok5(1)], 'T05 · évaluation': [avecSuivi({ verdict: 'ok' })], ...fin5() }, AS)
    assert.equal(res.statut, 'terminé')
    assert.equal(byLabel(calls, 'T05 · worker')[0].opts.model, m)
    assert.deepEqual(etapes(calls, 'T05 · worker'), [{ tache: 'T05', etape: 'worker', isole: false, modele: m }])
    assert.ok(!calls.some(c => /choix du modèle/.test(c.opts.label)))
    vide('M1 ' + m, q)
  }
})
await cas('M2 : après chaque essai refusé, le replanificateur choisit le modèle de la correction ; changement au suivi ; descente jusqu’au plancher ; pas de choix après le dernier essai', async () => {
  const A1 = 'architecture du module à revoir', A2 = 'faute dans le message'
  const { res, calls, logs, q } = await scenario('M2', {
    'lecteur-plan': [planS(TM('sonnet'))], 'T05 · worker': [rap5(0)],
    'T05 · vérification': [ok5(1), ok5(2), avecSuivi({ ok: false, resultats: [{ commande: 'npm test', code: 1, extrait: '1 failed' }], echecs: [{ commande: 'npm test', extrait: '1 failed' }] })],
    'T05 · évaluation': [ko5(A1), ko5(A2)],
    'T05 · choix du modèle 1': [{ modele: 'opus', raison: "manque d'architecture" }], 'T05 · choix du modèle 2': [{ modele: 'haiku', raison: 'faute de texte' }],
    'T05 · correction 1': [rap5(1)], 'T05 · correction 2': [rap5(2)],
    'T05 · replanification': [RIEN], 'T05 · suivi': [avecSuivi(SOK)], 'fin de run · suivi': [GOK] }, AS)
  const t = res.taches[0]
  assert.deepEqual([t.statut, t.essais], ['bloquée', 3])
  const [c1, c2] = [1, 2].map(i => byLabel(calls, `T05 · choix du modèle ${i}`)[0])
  assert.deepEqual([c1.opts.agentType, c1.opts.model, c1.opts.schema.required, c1.opts.schema.properties.modele.enum], ['orchestre:replanificateur', 'opus', ['modele', 'raison'], ['haiku', 'sonnet', 'opus']])
  for (const x of ['Modèle prévu par le plan : sonnet (« implémentation courante »)', 'plancher', "L'essai 1, sur sonnet, a été refusé par l'évaluation", JSON.stringify([A1]), 'plans/p/taches/T05.md']) assert.ok(c1.prompt.includes(x), 'choix 1 : ' + x)
  assert.ok(!c1.prompt.includes('Essais refusés avant lui') && !c1.prompt.includes('suivi.mjs'), 'choix 1 : pas d’historique, pas de commande de suivi')
  assert.ok(c2.prompt.includes("L'essai 2, sur opus") && c2.prompt.includes(`Essais refusés avant lui : ${JSON.stringify([{ essai: 1, modele: 'sonnet', par: 'évaluation', manques: [A1] }])}`), 'choix 2 : refus précédents et leurs modèles')
  assert.ok(idx(calls, 'T05 · choix du modèle 1') > idx(calls, 'T05 · évaluation') && idx(calls, 'T05 · choix du modèle 1') < idx(calls, 'T05 · correction 1'))
  assert.deepEqual(['T05 · correction 1', 'T05 · correction 2'].map(l => byLabel(calls, l)[0].opts.model), ['opus', 'sonnet'], 'opus, puis sonnet : le choix haiku est relevé au plancher')
  assert.deepEqual(etapes(calls, 'T05 · correction 1')[0], { tache: 'T05', etape: 'correction', refus: { essai: 1, par: 'évaluation', manques: [A1] }, modele: 'opus', changement: { de: 'sonnet', vers: 'opus', raison: "manque d'architecture" } })
  assert.deepEqual(etapes(calls, 'T05 · correction 2')[0].changement, { de: 'opus', vers: 'sonnet', raison: 'faute de texte ; relevé au modèle de la tâche (sonnet)' })
  assert.ok(logs.includes("T05 : correction 1 sur opus (au lieu de sonnet) : manque d'architecture"), logs.join('\n'))
  assert.ok(logs.includes('T05 : correction 2 sur sonnet (au lieu de opus) : faute de texte ; relevé au modèle de la tâche (sonnet)'), logs.join('\n'))
  vide('M2', q)
})
await cas('M3 : plancher — un choix plus faible que la tâche tourne sur la tâche, sans changement ; fable reste plancher', async () => {
  for (const [m, choix] of [['opus', 'haiku'], ['fable', 'opus']]) {
    const { res, calls, logs, q } = await scenario('M3 ' + m, { 'lecteur-plan': [planS(TM(m))], 'T05 · worker': [rap5(0)], 'T05 · vérification': [ok5(1), ok5(2)], 'T05 · évaluation': [ko5('M'), avecSuivi({ verdict: 'ok' })], 'T05 · choix du modèle 1': [{ modele: choix, raison: 'r' }], 'T05 · correction 1': [rap5(1)], ...fin5() }, AS)
    assert.equal(res.statut, 'terminé')
    assert.equal(byLabel(calls, 'T05 · correction 1')[0].opts.model, m)
    const E = etapes(calls, 'T05 · correction 1')[0]
    assert.deepEqual([E.modele, 'changement' in E], [m, false], 'même modèle que l’essai : pas de changement')
    assert.ok(logs.includes(`T05 : correction 1 sur ${m} : r ; relevé au modèle de la tâche (${m})`), 'le choix relevé reste tracé au log : ' + logs.join(' | '))
    vide('M3 ' + m, q)
  }
})
await cas('M4 : choix absent ou invalide — l’échelle escalade s’applique, au-dessus du plancher, et le changement le dit', async () => {
  const { res, calls, logs, q } = await scenario('M4', {
    'lecteur-plan': [planS(TM('haiku'))], 'T05 · worker': [rap5(0)], 'T05 · vérification': [ok5(1), ok5(2), ok5(3)],
    'T05 · évaluation': [ko5('M1'), ko5('M2'), avecSuivi({ verdict: 'ok' })],
    'T05 · choix du modèle 1': [null], 'T05 · choix du modèle 2': [{ modele: 'gpt-5', raison: 'x' }],
    'T05 · correction 1': [rap5(1)], 'T05 · correction 2': [rap5(2)], ...fin5() }, AS)
  assert.deepEqual([res.statut, res.taches[0].essais], ['terminé', 3])
  assert.equal(byLabel(calls, 'T05 · worker')[0].opts.model, 'haiku')
  assert.deepEqual(['T05 · correction 1', 'T05 · correction 2'].map(l => byLabel(calls, l)[0].opts.model), ['sonnet', 'opus'])
  assert.deepEqual(etapes(calls, 'T05 · correction 1')[0].changement, { de: 'haiku', vers: 'sonnet', raison: "choix du modèle sans réponse : échelle d'escalade, correction 1" })
  assert.deepEqual(etapes(calls, 'T05 · correction 2')[0].changement, { de: 'sonnet', vers: 'opus', raison: "choix invalide (gpt-5) : échelle d'escalade, correction 2" })
  assert.ok(logs.includes("T05 : choix du modèle sans réponse : échelle d'escalade, correction 1"))
  vide('M4', q)
  // Échelle du projet : celle de args.escalade
  const r2 = await scenario('M4b', { 'lecteur-plan': [planS(TM('sonnet'))], 'T05 · worker': [rap5(0)], 'T05 · vérification': [ok5(1), ok5(2)], 'T05 · évaluation': [ko5('M1'), avecSuivi({ verdict: 'ok' })], 'T05 · choix du modèle 1': [null], 'T05 · correction 1': [rap5(1)], ...fin5() }, { ...AS, escalade: ['opus'] })
  assert.equal(byLabel(r2.calls, 'T05 · correction 1')[0].opts.model, 'opus')
  vide('M4b', r2.q)
})
await cas('M5 : tâche sans modèle — comportement de la 0.10 : sonnet, puis l’échelle, sans appel au replanificateur ; le changement d’échelle va au suivi', async () => {
  const { res, calls, q } = await scenario('M5', {
    'lecteur-plan': [planS(TM(null))], 'T05 · worker': [rap5(0)], 'T05 · vérification': [ok5(1), ok5(2), ok5(3)],
    'T05 · évaluation': [ko5('M1'), ko5('M2'), avecSuivi({ verdict: 'ok' })], 'T05 · correction 1': [rap5(1)], 'T05 · correction 2': [rap5(2)], ...fin5() }, AS)
  assert.equal(res.statut, 'terminé')
  assert.ok(!calls.some(c => /choix du modèle/.test(c.opts.label) || c.opts.agentType === 'orchestre:replanificateur'))
  assert.deepEqual(['T05 · worker', 'T05 · correction 1', 'T05 · correction 2'].map(l => byLabel(calls, l)[0].opts.model), ['sonnet', 'sonnet', 'opus'])
  assert.deepEqual(etapes(calls, 'T05 · worker')[0].modele, 'sonnet')
  const [e1, e2] = [etapes(calls, 'T05 · correction 1')[0], etapes(calls, 'T05 · correction 2')[0]]
  assert.deepEqual([e1.modele, 'changement' in e1], ['sonnet', false])
  assert.deepEqual([e2.modele, e2.changement], ['opus', { de: 'sonnet', vers: 'opus', raison: "pas de modèle dans le plan : échelle d'escalade, correction 2" }])
  vide('M5', q)
  // Sans suivi : aucune commande, mêmes modèles
  const r2 = await scenario('M5b', { 'lecteur-plan': [plan(TM(null))], 'T05 · worker': [rap(0, { branche: 'tache/T05' })], 'T05 · vérification': [ok(1), ok(2)], 'T05 · évaluation': [{ verdict: 'ko', manques: ['M'] }, { verdict: 'ok' }], 'T05 · correction 1': [rap(1, { branche: 'tache/T05' })], 'T05 · fusion': [FOK], 'T05 · suivi': [SOK] })
  assert.ok(r2.calls.every(c => !c.prompt.includes('suivi.mjs')))
  assert.equal(byLabel(r2.calls, 'T05 · correction 1')[0].opts.model, 'sonnet')
  vide('M5b', r2.q)
})
await cas('M6 : vrai suivi.mjs — modèle utilisé et changement notés dans suivi.json, au journal entre le refus et la correction ; SUIVI.md garde le modèle du plan', async () => {
  const D = depotJouet()
  try {
    const { res, lances } = await joue('M6', D, {
      'lecteur-plan': [plan({ ...T1, depend_de: [], raison_modele: 'implémentation courante' })], 'T01 · worker': [rap(1, { branche: 'tache/T01' })], 'T01 · vérification': [ok(1), ok(2)],
      'T01 · évaluation': [{ verdict: 'ko', manques: ['architecture'] }, { verdict: 'ok' }], 'T01 · choix du modèle 1': [{ modele: 'opus', raison: "manque d'architecture" }],
      'T01 · correction 1': [rap(2, { branche: 'tache/T01' })], 'T01 · fusion': [FOK], 'T01 · suivi': [SOK], 'fin de run · suivi': [{ commit: '', detail: '' }] })
    assert.deepEqual(lances.filter(l => l.code !== 0), [], 'toutes les commandes de suivi passent')
    assert.equal(res.statut, 'terminé'); assert.deepEqual(res.suivi_echecs, [])
    const doc = D.doc(), t = doc.taches.find(x => x.id === 'T01')
    assert.deepEqual([doc.format, t.modele, t.modele_utilise, t.statut], ['orchestre-suivi/2', 'sonnet', 'opus', 'fusionnée'])
    assert.deepEqual(doc.journal.filter(e => e.tache === 'T01').map(e => e.texte).slice(3, 6), ['T01 : essai 1 refusé (évaluation) : 1 manque(s)', "T01 : sonnet → opus (manque d'architecture)", 'T01 : correction (essai 2)'])
    assert.equal(doc.journal.filter(e => e.genre === 'modele').length, 1)
    assert.match(D.ligne('T01'), /\| sonnet +\| fusionnée \|/)
    assert.equal(spawnSync(process.execPath, [SUIVI_VRAI, 'valider', 'plans/p'], { cwd: D.racine }).status, 0)
  } finally { fs.rmSync(D.racine, { recursive: true, force: true }) }
})
console.log(`TOUT EST VERT (${n} cas)`)
