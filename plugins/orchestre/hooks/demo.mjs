// @ts-check
// Mode démo du mod (/suivi demo) : un run joué en mémoire, sans dépôt ni fichier. Chaque pas donne un document
// orchestre-suivi/2 tel que scripts/suivi.mjs l'écrirait (mêmes champs, mêmes textes de journal), que le mod passe par
// normaliser() comme un vrai suivi.json. tests/demo-suivi.mjs joue le même scénario avec le vrai suivi.mjs, et
// tests/mod-suivi.test.mjs vérifie que les deux annoncent les mêmes notifications et que ces documents
// respectent le schéma du contrat.

import { normalize } from './modele.mjs'

/** @typedef {import('../types/index.d.ts').Snapshot} Snapshot */

export const DEMO_FRAME_MS = 3000
// Le vrai suivi reprend une minute après le dernier pas
export const RETURN_MS = 60000
export const DEMO_PLAN = 'site-vitrine'

// Le modèle de chaque tâche, comme /orchestre:preparer le choisit (0.11.0) : haiku pour la documentation
export const TASKS = [
  { id: 'T01', titre: "Page d'accueil", phase: 1, dep: [], modele: 'sonnet' },
  { id: 'T02', titre: 'Formulaire de contact', phase: 1, dep: [], modele: 'sonnet' },
  { id: 'T03', titre: 'Envoi des e-mails', phase: 1, dep: [], modele: 'sonnet' },
  { id: 'T04', titre: 'Tests de bout en bout', phase: 2, dep: ['T01', 'T02'], modele: 'sonnet' },
  { id: 'T05', titre: 'Documentation', phase: 2, dep: ['T03'], modele: 'haiku' },
]
const SMTP = { titre: 'Clé SMTP de test', contexte: "les tests d'envoi ont besoin d'un serveur SMTP de test", humain: true }
export const REJECTION = { essai: 1, par: 'évaluation', manques: ["le message d'erreur n'est pas affiché"] }
// Le choix du replanificateur pour la correction de T02 (0.11.0)
export const CHANGE = { de: 'sonnet', vers: 'opus', raison: "l'erreur touche le formulaire et l'API" }

/** @typedef {Record<string, any>} Doc */
/** @typedef {(d: Doc, q: string) => void} Pas */

const iso = /** @param {number} ms */ ms => new Date(ms).toISOString()
/** @param {Doc} d @param {string} id */
const task = (d, id) => d.taches.find(/** @param {Doc} t */ t => t.id === id)
/** @param {Doc} d @param {string} q @param {string} kind @param {string | null} id @param {string} text */
const J = (d, q, kind, id, text) => { d.journal.push({ quand: q, genre: kind, tache: id, texte: text }) }
/** @param {Doc} d */
const currentRun = d => d.runs.find(/** @param {Doc} r */ r => r.statut === 'en-cours')

// Les écritures de suivi.mjs, réduites à ce que la démo joue, avec les mêmes textes de journal
/** @param {number} phase @param {string} mode @returns {Pas} */
const runStart = (phase, mode) => (d, q) => {
  const number = d.runs.length + 1
  d.runs.push({ numero: number, run_id: null, phase, mode, parallelisme: 2, corrections_max: 2, decisions_office_max: 3, statut: 'en-cours', debut: q, fin: null, detail: null, arbitrages_appliques: [], amendements_ecartes: [], taches_ajoutees: [], reportees: [], non_lancees: [], en_attente: [], en_attente_prerequis: [] })
  J(d, q, 'run', null, `run ${number} : phase ${phase}, mode ${mode}, 2 en parallèle`)
}
/** @param {Doc} ch */
const changeText = (id, ch) => `${id} : ${ch.de ?? '—'} → ${ch.vers}${ch.raison ? ` (${ch.raison})` : ''}`
/** @param {string} id @param {string} step @param {{ isolated?: boolean, rejection?: Doc, model?: string, change?: Doc }} [o] @returns {Pas} */
const step = (id, step, o = {}) => (d, q) => {
  const t = task(d, id)
  if (o.isolated !== undefined) t.isole = o.isolated
  const model = o.change ? o.change.vers : o.model ?? null
  // La démo ne joue de changement de modèle que sur une correction, comme le workflow
  if (step === 'worker') {
    Object.assign(t, { etape: step, debut: q, fin: null, essais: 1, refus: [], blocage: [], modele_utilise: model })
    J(d, q, 'tache', id, `${id} démarre (${t.isole ? 'worktree' : 'checkout principal'})`)
    return
  }
  t.etape = step
  if (step === 'correction' && o.rejection) {
    t.refus.push(o.rejection)
    t.essais = Math.max(t.essais, o.rejection.essai + 1)
    J(d, q, 'refus', id, `${id} : essai ${o.rejection.essai} refusé (${o.rejection.par}) : ${o.rejection.manques.length} manque(s)`)
  }
  if (model) t.modele_utilise = model
  if (o.change) J(d, q, 'modele', id, changeText(id, o.change))
  J(d, q, 'etape', id, `${id} : ${step}${step === 'correction' ? ` (essai ${t.essais})` : ''}`)
}
/** Le worker d'une tâche, sur son modèle. @param {string} id @param {boolean} isolated */
const worker = (id, isolated) => step(id, 'worker', { isolated, model: /** @type {Doc} */ (TASKS.find(t => t.id === id)).modele })
/** @param {string} id @param {{ status: string, attempts: number, rejection?: Doc[], blocker?: string[], reviews?: string[], decisions?: Doc[], issues?: Doc[] }} o @returns {Pas} */
const close = (id, o) => (d, q) => {
  const t = task(d, id), run = currentRun(d)
  Object.assign(t, { statut: o.status, essais: o.attempts, branche: `tache/${id}`, tokens_reels: 'voir /workflows', fin: q, etape: null, refus: o.rejection ?? t.refus, blocage: o.blocker ?? [] })
  J(d, q, 'statut', id, `${id} : ${o.status} (${o.attempts} essai${o.attempts > 1 ? 's' : ''})${t.blocage.length ? ' — ' + t.blocage[0] : ''}`)
  for (const text of o.reviews ?? []) {
    d.relectures.push({ tache: id, phase: t.phase, texte: text, run: run?.numero ?? null, quand: q })
    J(d, q, 'relecture', id, `${id} : relecture avant la PR — ${text}`)
  }
  for (const x of o.decisions ?? []) {
    d.decisions_office.push({ run: run?.numero ?? null, tache: id, titre: x.titre, option: x.option, description: x.description })
    J(d, q, 'decision-office', id, `${id} : « ${x.titre} », option ${x.option} prise d'office`)
  }
  for (const p of o.issues ?? []) {
    d.points.push({ run: run?.numero ?? null, tache: id, titre: p.titre, contexte: p.contexte, humain: p.humain, options: [], role: 'a-trancher', statut: 'ouvert', option_choisie: null })
    J(d, q, 'point', id, `${id} : point « ${p.titre} »${p.humain ? ' (humain)' : ''}`)
  }
}
/** @param {string} id @param {string} title @param {string} option @returns {Pas} */
const ruling = (id, title, option) => (d, q) => {
  const p = d.points.filter(/** @param {Doc} x */ x => x.tache === id && x.titre === title && x.statut === 'ouvert').pop()
  if (p) Object.assign(p, { statut: 'tranché', option_choisie: option })
  J(d, q, 'arbitrage', id, `${id} : « ${title} » tranché, option ${option}`)
  currentRun(d)?.arbitrages_appliques.push({ tache: id, titre: title, option })
}
/** @param {string} status @param {{ arret?: string, en_attente?: string[] }} [o] @returns {Pas} */
const runEnd = (status, o = {}) => (d, q) => {
  const run = currentRun(d)
  Object.assign(run, { statut: status, fin: q, en_attente: o.en_attente ?? [] })
  if (o.arret) { const p = d.points.find(/** @param {Doc} x */ x => x.tache === o.arret && x.statut === 'ouvert'); if (p) p.role = 'arret' }
  J(d, q, 'run', null, `run ${run.numero} : ${status}`)
}
/** @param {...Pas} frameMs @returns {Pas} */
const together = (...frameMs) => (d, q) => { for (const p of frameMs) p(d, q) }

// Le scénario de tests/demo-suivi.mjs, pas pour pas ; le second nombre est la durée du pas, en pas
/** @type {[string, number, Pas][]} */
export const SCENARIO = [
  ['Run 1 lancé, phase 1', 1, runStart(1, 'phase')],
  ['T01 et T02 démarrent', 1, together(worker('T01', true), worker('T02', true))],
  ['T01 en vérification', 1, step('T01', 'vérification')],
  ['T02 en vérification, T01 en évaluation', 1, together(step('T02', 'vérification'), step('T01', 'évaluation'))],
  ["T02 refusée par l'évaluation : correction sur opus", 1, step('T02', 'correction', { rejection: REJECTION, model: 'opus', change: CHANGE })],
  ['T01 en fusion', 1, step('T01', 'fusion')],
  ['T01 fusionnée, avec une relecture', 1, close('T01', { status: 'fusionnée', attempts: 1, reviews: ['.env.example : ajouter DEMO_URL'] })],
  ['T03 démarre ; T02 en vérification', 1, together(worker('T03', true), step('T02', 'vérification'))],
  ['T02 en fusion ; T03 en vérification', 1, together(step('T02', 'fusion'), step('T03', 'vérification'))],
  ["T02 fusionnée au 2e essai, une décision d'office", 1, close('T02', { status: 'fusionnée', attempts: 2, rejection: [REJECTION], decisions: [{ titre: 'Longueur maximale du message', option: 'B', description: '2 000 caractères' }] })],
  ['T03 attend un humain', 1, close('T03', { status: 'besoin-humain', attempts: 1, blocker: ['clé SMTP de test absente'], issues: [SMTP] })],
  // Une pause à l'arrêt du run 1 : le temps d'ouvrir /suivi
  ['Fin du run 1 : arbitrage sur T03', 4, runEnd('arbitrage', { arret: 'T03', en_attente: ['T03'] })],
  ["Run 2 lancé, arbitrage de T03 appliqué", 1, together(runStart(1, 'auto'), ruling('T03', SMTP.titre, 'A'))],
  ['T03 reprend', 1, worker('T03', true)],
  ['T03 en vérification', 1, step('T03', 'vérification')],
  ['T03 fusionnée : phase 1 terminée', 1, close('T03', { status: 'fusionnée', attempts: 2 })],
  ['T04 et T05 démarrent', 1, together(worker('T04', true), worker('T05', false))],
  ['T05 fusionnée, deux relectures', 1, close('T05', { status: 'fusionnée', attempts: 1, reviews: ['README.md : relire la section installation', 'docs/smtp.md : vérifier le nom de la variable'] })],
  ['T04 en vérification', 1, step('T04', 'vérification')],
  ['T04 fusionnée : phase 2 terminée', 1, close('T04', { status: 'fusionnée', attempts: 1 })],
  ['Fin du run 2 : terminé', 1, runEnd('terminé')],
]
export const FRAME_COUNT = SCENARIO.length

/** L'heure du pas k (0 pour le premier). @param {number} k @param {number} start @param {number} frameMs */
export function frameInstant(k, start, frameMs = DEMO_FRAME_MS) {
  let t = start
  for (let i = 0; i < k; i++) t += frameMs * /** @type {[string, number, Pas]} */ (SCENARIO[i])[1]
  return t
}
/** Le dernier pas joué à `maintenant` (-1 avant le premier, NB_PAS - 1 après le dernier). @param {number} now @param {number} start @param {number} frameMs */
export function frameAt(now, start, frameMs = DEMO_FRAME_MS) {
  let k = -1
  while (k + 1 < FRAME_COUNT && frameInstant(k + 1, start, frameMs) <= now) k++
  return k
}
/** L'heure où la démo rend la main au vrai suivi. @param {number} start @param {number} frameMs */
export const demoEnd = (start, frameMs = DEMO_FRAME_MS) => frameInstant(FRAME_COUNT - 1, start, frameMs) + RETURN_MS

/**
 * Le document orchestre-suivi/2 après le pas k : les pas 0 à k joués à leur heure, au schéma du contrat.
 * @param {number} k @param {number} start @param {number} [frameMs] @returns {Doc}
 */
export function demoDoc(k, start, frameMs = DEMO_FRAME_MS) {
  /** @type {Doc} */
  const d = {
    format: 'orchestre-suivi/2', plan: DEMO_PLAN, dossier: `plans/${DEMO_PLAN}`, integration: `plan/${DEMO_PLAN}`, base: null, maj: iso(start),
    taches: TASKS.map(t => ({ id: t.id, titre: t.titre, phase: t.phase, lot: null, depend_de: t.dep, modele: t.modele, modele_utilise: null, statut: 'à-faire', essais: 0, branche: null, estimation_tokens: 400000, tokens_reels: null, ajoutee_par: null, etape: null, isole: null, debut: null, fin: null, attend: [], refus: [], instables: [], non_verifiables: [], blocage: [] })),
    runs: [], points: [], decisions_office: [], relectures: [], prerequis: [], handoff: {}, lint: { ok: true, erreurs: [] }, journal: [], journal_omis: 0,
  }
  for (let i = 0; i <= Math.min(k, FRAME_COUNT - 1); i++) {
    const q = iso(frameInstant(i, start, frameMs))
    ;/** @type {[string, number, Pas]} */ (SCENARIO[i])[2](d, q)
    d.maj = q
  }
  return d
}

/** Ce que le mod affiche après le pas k : le document lu comme un suivi.json, marqué démo (« DÉMO » au bandeau). @param {number} k @param {number} start @param {number} [frameMs] @returns {Snapshot} */
export function demoSnapshot(k, start, frameMs = DEMO_FRAME_MS) {
  return { .../** @type {Snapshot} */ (normalize(demoDoc(k, start, frameMs))), demo: true, legend: legend(k) }
}

// Ce qu'il y a à regarder ou à essayer à certains pas, dans l'en-tête du panneau
const MANUAL_ACTIONS = /** @type {Record<number, string>} */ ({
  0: 'clique « ⤢ Détail » au bout du bandeau pour ouvrir le panneau',
  1: 'la frise de chaque tâche se colorie étape par étape',
  4: 'la correction passe en ambre dans la frise de T02, son modèle en « sonnet → opus » (journal : j)',
  6: '« ⚑ 1 à relire » se clique au bandeau',
  10: 'la carte « À toi » est en tête ; sa touche 1 prépare la reprise dans le prompt',
  11: 'le run s\'arrête : la carte du run donne la suite, touche l',
  12: 'le point est tranché : T03 n\'attend plus personne',
  20: 'touche p : le brouillon de PR dans le prompt',
})
/** La légende du pas k : « pas 11/21 · T03 attend un humain », puis, à la ligne, le geste à essayer. @param {number} k */
export function legend(k) {
  const i = Math.min(Math.max(0, k), FRAME_COUNT - 1), manualAction = MANUAL_ACTIONS[i]
  return `pas ${i + 1}/${FRAME_COUNT} · ${/** @type {[string, number, Pas]} */ (SCENARIO[i])[0]}${manualAction ? `\n→ ${manualAction}` : ''}`
}
