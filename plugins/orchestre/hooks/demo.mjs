// @ts-check
// Mode démo du mod (/suivi demo) : un run joué en mémoire, sans dépôt ni fichier. Chaque pas donne un document
// orchestre-suivi/2 tel que scripts/suivi.mjs l'écrirait (mêmes champs, mêmes textes de journal), que le mod passe par
// normaliser() comme un vrai suivi.json. tests/demo-suivi.mjs joue le même scénario avec le vrai suivi.mjs, et
// tests/mod-suivi.test.mjs vérifie que les deux annoncent les mêmes notifications et que ces documents
// respectent le schéma du contrat.

import { normaliser } from './modele.mjs'

/** @typedef {import('../types/index.d.ts').Instantane} Instantane */

export const PAS_DEMO_MS = 3000
// Le vrai suivi reprend une minute après le dernier pas
export const RETOUR_MS = 60000
export const PLAN_DEMO = 'site-vitrine'

// Le modèle de chaque tâche, comme /orchestre:preparer le choisit (0.11.0) : haiku pour la documentation
export const TACHES = [
  { id: 'T01', titre: "Page d'accueil", phase: 1, dep: [], modele: 'sonnet' },
  { id: 'T02', titre: 'Formulaire de contact', phase: 1, dep: [], modele: 'sonnet' },
  { id: 'T03', titre: 'Envoi des e-mails', phase: 1, dep: [], modele: 'sonnet' },
  { id: 'T04', titre: 'Tests de bout en bout', phase: 2, dep: ['T01', 'T02'], modele: 'sonnet' },
  { id: 'T05', titre: 'Documentation', phase: 2, dep: ['T03'], modele: 'haiku' },
]
const SMTP = { titre: 'Clé SMTP de test', contexte: "les tests d'envoi ont besoin d'un serveur SMTP de test", humain: true }
export const REFUS = { essai: 1, par: 'évaluation', manques: ["le message d'erreur n'est pas affiché"] }
// Le choix du replanificateur pour la correction de T02 (0.11.0)
export const CHANGEMENT = { de: 'sonnet', vers: 'opus', raison: "l'erreur touche le formulaire et l'API" }

/** @typedef {Record<string, any>} Doc */
/** @typedef {(d: Doc, q: string) => void} Pas */

const iso = /** @param {number} ms */ ms => new Date(ms).toISOString()
/** @param {Doc} d @param {string} id */
const tache = (d, id) => d.taches.find(/** @param {Doc} t */ t => t.id === id)
/** @param {Doc} d @param {string} q @param {string} genre @param {string | null} id @param {string} texte */
const J = (d, q, genre, id, texte) => { d.journal.push({ quand: q, genre, tache: id, texte }) }
/** @param {Doc} d */
const runCourant = d => d.runs.find(/** @param {Doc} r */ r => r.statut === 'en-cours')

// Les écritures de suivi.mjs, réduites à ce que la démo joue, avec les mêmes textes de journal
/** @param {number} phase @param {string} mode @returns {Pas} */
const debutRun = (phase, mode) => (d, q) => {
  const numero = d.runs.length + 1
  d.runs.push({ numero, run_id: null, phase, mode, parallelisme: 2, corrections_max: 2, decisions_office_max: 3, statut: 'en-cours', debut: q, fin: null, detail: null, arbitrages_appliques: [], amendements_ecartes: [], taches_ajoutees: [], reportees: [], non_lancees: [], en_attente: [], en_attente_prerequis: [] })
  J(d, q, 'run', null, `run ${numero} : phase ${phase}, mode ${mode}, 2 en parallèle`)
}
/** @param {Doc} ch */
const texteChangement = (id, ch) => `${id} : ${ch.de ?? '—'} → ${ch.vers}${ch.raison ? ` (${ch.raison})` : ''}`
/** @param {string} id @param {string} etape @param {{ isole?: boolean, refus?: Doc, modele?: string, changement?: Doc }} [o] @returns {Pas} */
const etape = (id, etape, o = {}) => (d, q) => {
  const t = tache(d, id)
  if (o.isole !== undefined) t.isole = o.isole
  const modele = o.changement ? o.changement.vers : o.modele ?? null
  // La démo ne joue de changement de modèle que sur une correction, comme le workflow
  if (etape === 'worker') {
    Object.assign(t, { etape, debut: q, fin: null, essais: 1, refus: [], blocage: [], modele_utilise: modele })
    J(d, q, 'tache', id, `${id} démarre (${t.isole ? 'worktree' : 'checkout principal'})`)
    return
  }
  t.etape = etape
  if (etape === 'correction' && o.refus) {
    t.refus.push(o.refus)
    t.essais = Math.max(t.essais, o.refus.essai + 1)
    J(d, q, 'refus', id, `${id} : essai ${o.refus.essai} refusé (${o.refus.par}) : ${o.refus.manques.length} manque(s)`)
  }
  if (modele) t.modele_utilise = modele
  if (o.changement) J(d, q, 'modele', id, texteChangement(id, o.changement))
  J(d, q, 'etape', id, `${id} : ${etape}${etape === 'correction' ? ` (essai ${t.essais})` : ''}`)
}
/** Le worker d'une tâche, sur son modèle. @param {string} id @param {boolean} isole */
const worker = (id, isole) => etape(id, 'worker', { isole, modele: /** @type {Doc} */ (TACHES.find(t => t.id === id)).modele })
/** @param {string} id @param {{ statut: string, essais: number, refus?: Doc[], blocage?: string[], relectures?: string[], decisions?: Doc[], points?: Doc[] }} o @returns {Pas} */
const cloture = (id, o) => (d, q) => {
  const t = tache(d, id), run = runCourant(d)
  Object.assign(t, { statut: o.statut, essais: o.essais, branche: `tache/${id}`, tokens_reels: 'voir /workflows', fin: q, etape: null, refus: o.refus ?? t.refus, blocage: o.blocage ?? [] })
  J(d, q, 'statut', id, `${id} : ${o.statut} (${o.essais} essai${o.essais > 1 ? 's' : ''})${t.blocage.length ? ' — ' + t.blocage[0] : ''}`)
  for (const texte of o.relectures ?? []) {
    d.relectures.push({ tache: id, phase: t.phase, texte, run: run?.numero ?? null, quand: q })
    J(d, q, 'relecture', id, `${id} : relecture avant la PR — ${texte}`)
  }
  for (const x of o.decisions ?? []) {
    d.decisions_office.push({ run: run?.numero ?? null, tache: id, titre: x.titre, option: x.option, description: x.description })
    J(d, q, 'decision-office', id, `${id} : « ${x.titre} », option ${x.option} prise d'office`)
  }
  for (const p of o.points ?? []) {
    d.points.push({ run: run?.numero ?? null, tache: id, titre: p.titre, contexte: p.contexte, humain: p.humain, options: [], role: 'a-trancher', statut: 'ouvert', option_choisie: null })
    J(d, q, 'point', id, `${id} : point « ${p.titre} »${p.humain ? ' (humain)' : ''}`)
  }
}
/** @param {string} id @param {string} titre @param {string} option @returns {Pas} */
const arbitrage = (id, titre, option) => (d, q) => {
  const p = d.points.filter(/** @param {Doc} x */ x => x.tache === id && x.titre === titre && x.statut === 'ouvert').pop()
  if (p) Object.assign(p, { statut: 'tranché', option_choisie: option })
  J(d, q, 'arbitrage', id, `${id} : « ${titre} » tranché, option ${option}`)
  runCourant(d)?.arbitrages_appliques.push({ tache: id, titre, option })
}
/** @param {string} statut @param {{ arret?: string, en_attente?: string[] }} [o] @returns {Pas} */
const finRun = (statut, o = {}) => (d, q) => {
  const run = runCourant(d)
  Object.assign(run, { statut, fin: q, en_attente: o.en_attente ?? [] })
  if (o.arret) { const p = d.points.find(/** @param {Doc} x */ x => x.tache === o.arret && x.statut === 'ouvert'); if (p) p.role = 'arret' }
  J(d, q, 'run', null, `run ${run.numero} : ${statut}`)
}
/** @param {...Pas} pas @returns {Pas} */
const ensemble = (...pas) => (d, q) => { for (const p of pas) p(d, q) }

// Le scénario de tests/demo-suivi.mjs, pas pour pas ; le second nombre est la durée du pas, en pas
/** @type {[string, number, Pas][]} */
export const SCENARIO = [
  ['Run 1 lancé, phase 1', 1, debutRun(1, 'phase')],
  ['T01 et T02 démarrent', 1, ensemble(worker('T01', true), worker('T02', true))],
  ['T01 en vérification', 1, etape('T01', 'vérification')],
  ['T02 en vérification, T01 en évaluation', 1, ensemble(etape('T02', 'vérification'), etape('T01', 'évaluation'))],
  ["T02 refusée par l'évaluation : correction sur opus", 1, etape('T02', 'correction', { refus: REFUS, modele: 'opus', changement: CHANGEMENT })],
  ['T01 en fusion', 1, etape('T01', 'fusion')],
  ['T01 fusionnée, avec une relecture', 1, cloture('T01', { statut: 'fusionnée', essais: 1, relectures: ['.env.example : ajouter DEMO_URL'] })],
  ['T03 démarre ; T02 en vérification', 1, ensemble(worker('T03', true), etape('T02', 'vérification'))],
  ['T02 en fusion ; T03 en vérification', 1, ensemble(etape('T02', 'fusion'), etape('T03', 'vérification'))],
  ["T02 fusionnée au 2e essai, une décision d'office", 1, cloture('T02', { statut: 'fusionnée', essais: 2, refus: [REFUS], decisions: [{ titre: 'Longueur maximale du message', option: 'B', description: '2 000 caractères' }] })],
  ['T03 attend un humain', 1, cloture('T03', { statut: 'besoin-humain', essais: 1, blocage: ['clé SMTP de test absente'], points: [SMTP] })],
  // Une pause à l'arrêt du run 1 : le temps d'ouvrir /suivi
  ['Fin du run 1 : arbitrage sur T03', 4, finRun('arbitrage', { arret: 'T03', en_attente: ['T03'] })],
  ["Run 2 lancé, arbitrage de T03 appliqué", 1, ensemble(debutRun(1, 'auto'), arbitrage('T03', SMTP.titre, 'A'))],
  ['T03 reprend', 1, worker('T03', true)],
  ['T03 en vérification', 1, etape('T03', 'vérification')],
  ['T03 fusionnée : phase 1 terminée', 1, cloture('T03', { statut: 'fusionnée', essais: 2 })],
  ['T04 et T05 démarrent', 1, ensemble(worker('T04', true), worker('T05', false))],
  ['T05 fusionnée, deux relectures', 1, cloture('T05', { statut: 'fusionnée', essais: 1, relectures: ['README.md : relire la section installation', 'docs/smtp.md : vérifier le nom de la variable'] })],
  ['T04 en vérification', 1, etape('T04', 'vérification')],
  ['T04 fusionnée : phase 2 terminée', 1, cloture('T04', { statut: 'fusionnée', essais: 1 })],
  ['Fin du run 2 : terminé', 1, finRun('terminé')],
]
export const NB_PAS = SCENARIO.length

/** L'heure du pas k (0 pour le premier). @param {number} k @param {number} debut @param {number} pas */
export function instantDuPas(k, debut, pas = PAS_DEMO_MS) {
  let t = debut
  for (let i = 0; i < k; i++) t += pas * /** @type {[string, number, Pas]} */ (SCENARIO[i])[1]
  return t
}
/** Le dernier pas joué à `maintenant` (-1 avant le premier, NB_PAS - 1 après le dernier). @param {number} maintenant @param {number} debut @param {number} pas */
export function pasA(maintenant, debut, pas = PAS_DEMO_MS) {
  let k = -1
  while (k + 1 < NB_PAS && instantDuPas(k + 1, debut, pas) <= maintenant) k++
  return k
}
/** L'heure où la démo rend la main au vrai suivi. @param {number} debut @param {number} pas */
export const finDemo = (debut, pas = PAS_DEMO_MS) => instantDuPas(NB_PAS - 1, debut, pas) + RETOUR_MS

/**
 * Le document orchestre-suivi/2 après le pas k : les pas 0 à k joués à leur heure, au schéma du contrat.
 * @param {number} k @param {number} debut @param {number} [pas] @returns {Doc}
 */
export function docDemo(k, debut, pas = PAS_DEMO_MS) {
  /** @type {Doc} */
  const d = {
    format: 'orchestre-suivi/2', plan: PLAN_DEMO, dossier: `plans/${PLAN_DEMO}`, integration: `plan/${PLAN_DEMO}`, base: null, maj: iso(debut),
    taches: TACHES.map(t => ({ id: t.id, titre: t.titre, phase: t.phase, lot: null, depend_de: t.dep, modele: t.modele, modele_utilise: null, statut: 'à-faire', essais: 0, branche: null, estimation_tokens: 400000, tokens_reels: null, ajoutee_par: null, etape: null, isole: null, debut: null, fin: null, attend: [], refus: [], instables: [], non_verifiables: [], blocage: [] })),
    runs: [], points: [], decisions_office: [], relectures: [], prerequis: [], handoff: {}, lint: { ok: true, erreurs: [] }, journal: [], journal_omis: 0,
  }
  for (let i = 0; i <= Math.min(k, NB_PAS - 1); i++) {
    const q = iso(instantDuPas(i, debut, pas))
    ;/** @type {[string, number, Pas]} */ (SCENARIO[i])[2](d, q)
    d.maj = q
  }
  return d
}

/** Ce que le mod affiche après le pas k : le document lu comme un suivi.json, marqué démo (« DÉMO » au bandeau). @param {number} k @param {number} debut @param {number} [pas] @returns {Instantane} */
export function instantaneDemo(k, debut, pas = PAS_DEMO_MS) {
  return { .../** @type {Instantane} */ (normaliser(docDemo(k, debut, pas))), demo: true, legende: legende(k) }
}

// Ce qu'il y a à regarder ou à essayer à certains pas, dans l'en-tête du panneau
const GESTES = /** @type {Record<number, string>} */ ({
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
export function legende(k) {
  const i = Math.min(Math.max(0, k), NB_PAS - 1), geste = GESTES[i]
  return `pas ${i + 1}/${NB_PAS} · ${/** @type {[string, number, Pas]} */ (SCENARIO[i])[0]}${geste ? `\n→ ${geste}` : ''}`
}
