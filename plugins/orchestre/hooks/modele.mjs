// @ts-check
// Modèle du mod de suivi d'orchestre : lit plans/<nom>/suivi.json (contrat orchestre-suivi/2, ou /1 d'avant la 0.11.0, écrit par
// scripts/suivi.mjs du plugin orchestre) et en tire ce que le mod affiche. Fonctions pures, sans `$` :
// register.tsx s'occupe du moteur (fichiers, minuteur, dessin), tests/modele.test.mjs les vérifie sous Node.

/** @typedef {import('../types/index.d.ts').Instantane} Instantane */
/** @typedef {import('../types/index.d.ts').TacheVue} TacheVue */
/** @typedef {import('../types/index.d.ts').PhaseVue} PhaseVue */
/** @typedef {import('../types/index.d.ts').RunVue} RunVue */
/** @typedef {import('../types/index.d.ts').Morceau} Morceau */
/** @typedef {import('../types/index.d.ts').Ligne} Ligne */
/** @typedef {import('../types/index.d.ts').Carte} Carte */

export const FORMAT = 'orchestre-suivi/2'
// Les formats que ce mod lit : /1 (0.10 et avant, sans modèle utilisé) et /2 (0.11.0)
export const FORMATS = ['orchestre-suivi/1', FORMAT]
export const STATUTS = ['à-faire', 'ajoutée', 'fusionnée', 'bloquée', 'échec', 'besoin-humain', 'annulée']
const ATTENTION = { 'besoin-humain': 'attend un humain', bloquée: 'bloquée', échec: 'en échec' }
// Tout le journal de suivi.json (200 entrées au plus) : la frise des étapes du run en a besoin
const JOURNAL_VU = 200
// Un run noté « en-cours » sans écriture depuis 45 min est montré « sans nouvelles » : interrompu (Échap, session tuée),
// il reste « en-cours » jusqu'au debut-run suivant. Une étape seule (un worker) peut durer ; au-delà, mieux vaut le dire.
export const SILENCE_MS = 45 * 60000
// Durée d'une notification qui demande quelqu'un (4 s par défaut pour les autres)
export const DUREE_IMPORTANTE_MS = 15000

/** @param {unknown} x @returns {x is Record<string, any>} */
const estObjet = x => typeof x === 'object' && x !== null && !Array.isArray(x)
/** @param {unknown} x */
const texte = x => (typeof x === 'string' ? x : x == null ? '' : String(x))
/** @param {unknown} x @returns {string[]} */
const textes = x => (Array.isArray(x) ? x.map(texte) : [])
/** @param {unknown} x @returns {number | null} */
const date = x => { if (typeof x !== 'string') return null; const t = Date.parse(x); return Number.isNaN(t) ? null : t }
/** @param {unknown} x @param {number} d */
const entier = (x, d) => (Number.isInteger(x) ? /** @type {number} */ (x) : d)

/** Format déclaré par un suivi.json, ou null. @param {unknown} brut */
export const formatDe = brut => (estObjet(brut) && typeof brut.format === 'string' ? brut.format : null)

/**
 * suivi.json (orchestre-suivi/1 ou /2) → ce que le mod affiche ; null si le format n'est pas l'un d'eux.
 * Les champs inconnus sont ignorés, les champs manquants pris vides : un lecteur ne refuse que le format.
 * @param {unknown} brut @returns {Instantane | null}
 */
export function normaliser(brut) {
  if (!estObjet(brut) || !FORMATS.includes(/** @type {string} */ (brut.format)) || !Array.isArray(brut.taches)) return null
  const runs = (Array.isArray(brut.runs) ? brut.runs : []).filter(estObjet)
  const dernier = runs.length ? runs[runs.length - 1] : null
  /** @type {TacheVue[]} */
  const taches = brut.taches.filter(estObjet).map(t => ({
    id: texte(t.id), titre: texte(t.titre) || texte(t.id), phase: entier(t.phase, 1),
    statut: STATUTS.includes(t.statut) ? t.statut : 'à-faire', essais: entier(t.essais, 0),
    etape: typeof t.etape === 'string' ? t.etape : null, isole: t.isole === true,
    debut: date(t.debut), fin: date(t.fin), attend: textes(t.attend), blocage: textes(t.blocage),
    // Modèle prévu par le plan et dernier modèle lancé (0.11.0) ; un /1 n'a que le prévu
    modele: typeof t.modele === 'string' && t.modele ? t.modele : null, modeleUtilise: typeof t.modele_utilise === 'string' && t.modele_utilise ? t.modele_utilise : null,
  }))
  const majeures = /** @type {Record<string, number>} */ ({})
  let tickets = 0
  if (estObjet(brut.handoff)) for (const section of Object.values(brut.handoff)) if (estObjet(section)) for (const [type, c] of Object.entries(section)) {
    if (!estObjet(c)) continue
    if (type === 'ticket') tickets += entier(c.mineur, 0) + entier(c.majeur, 0)
    const n = entier(c.majeur, 0)
    if (n > 0) majeures[type] = (majeures[type] || 0) + n
  }
  return {
    demo: false, legende: null, plan: texte(brut.plan), dossier: texte(brut.dossier), maj: date(brut.maj),
    taches,
    runs: runs.map(runVue),
    run: dernier ? runVue(dernier) : null,
    relectures: (Array.isArray(brut.relectures) ? brut.relectures : []).filter(estObjet).map(r => ({ tache: r.tache == null ? null : texte(r.tache), phase: Number.isInteger(r.phase) ? r.phase : null, texte: texte(r.texte), quand: date(r.quand) })),
    decisions: (Array.isArray(brut.decisions_office) ? brut.decisions_office : []).filter(estObjet).map(d => ({ tache: texte(d.tache), titre: texte(d.titre), option: texte(d.option), description: texte(d.description) })),
    points: (Array.isArray(brut.points) ? brut.points : []).filter(p => estObjet(p) && p.statut !== 'tranché').map(p => ({ tache: texte(p.tache), titre: texte(p.titre), humain: p.humain === true, role: texte(p.role) })),
    prerequis: (Array.isArray(brut.prerequis) ? brut.prerequis : []).filter(p => estObjet(p) && p.statut === 'ouvert').map(p => ({ id: texte(p.id), type: texte(p.type), bloque: textes(p.bloque) })),
    majeures, tickets,
    lint: { ok: !estObjet(brut.lint) || brut.lint.ok !== false, erreurs: estObjet(brut.lint) ? textes(brut.lint.erreurs).length : 0 },
    journal: (Array.isArray(brut.journal) ? brut.journal : []).filter(estObjet).slice(-JOURNAL_VU).map(j => ({ quand: date(j.quand), genre: texte(j.genre), tache: j.tache == null ? null : texte(j.tache), texte: texte(j.texte) })),
  }
}

/** @param {Record<string, unknown>} r @returns {RunVue} */
const runVue = r => ({
  numero: entier(r.numero, 0), phase: entier(r.phase, 0), mode: texte(r.mode), parallelisme: entier(r.parallelisme, 0), statut: texte(r.statut), debut: date(r.debut), fin: date(r.fin), detail: r.detail == null ? null : texte(r.detail),
  arbitres: (Array.isArray(r.arbitrages_appliques) ? r.arbitrages_appliques : []).filter(estObjet).map(a => texte(a.tache)).filter(Boolean),
})

const fait = /** @param {TacheVue} t */ t => t.statut === 'fusionnée'
/** Le run noté en cours, s'il y en a un. @param {Instantane} inst */
export const runEnCours = inst => (inst.run && inst.run.statut === 'en-cours' ? inst.run : null)
/** Un run en cours sans écriture de suivi.json depuis SILENCE_MS. @param {Instantane} inst @param {number} maintenant */
export const silencieux = (inst, maintenant) => !!runEnCours(inst) && inst.maj != null && maintenant - inst.maj >= SILENCE_MS
/** Le run en cours qui donne des nouvelles. @param {Instantane} inst @param {number} maintenant */
export const runActif = (inst, maintenant) => (silencieux(inst, maintenant) ? null : runEnCours(inst))
/** Une tâche en cours : une étape notée pendant un run actif. @param {Instantane} inst @param {number} maintenant */
export const enCours = (inst, maintenant) => (runActif(inst, maintenant) ? inst.taches.filter(t => t.etape && !fait(t)) : [])
/** Le point de la tâche vient d'être tranché par le run en cours, qui va la relancer. @param {Instantane} inst @param {TacheVue} t */
const arbitree = (inst, t) => { const r = runEnCours(inst); return !!r && r.arbitres.includes(t.id) }
/**
 * Ce qui attend quelqu'un : une tâche qui a besoin d'un humain, bloquée ou en échec, sauf si le run en cours l'a reprise
 * (une étape notée pendant un run actif) ou vient d'en trancher le point. @param {Instantane} inst @param {number} maintenant
 */
export const attendQuelquun = (inst, maintenant) => { const actif = !!runActif(inst, maintenant); return /** @param {TacheVue} t */ t => t.statut in ATTENTION && !(actif && t.etape) && !arbitree(inst, t) }
/**
 * La phase où en est le dernier run : la plus haute des tâches qu'il a démarrées ou closes, au moins celle de son départ.
 * Un run en mode auto passe d'une phase à l'autre, et run.phase reste celle du départ. @param {Instantane} inst
 */
export function phaseDuRun(inst) {
  const r = inst.run
  if (!r) return null
  const d = r.debut
  const touchees = d == null ? [] : inst.taches.filter(t => t.statut !== 'annulée' && ((t.debut != null && t.debut >= d) || (t.fin != null && t.fin >= d)))
  return Math.max(r.phase, ...touchees.map(t => t.phase))
}

/**
 * Les chiffres du bandeau et des en-têtes. @param {Instantane} inst @param {number} maintenant ms
 */
export function resumer(inst, maintenant) {
  const actives = inst.taches.filter(t => t.statut !== 'annulée')
  const faites = actives.filter(fait).length
  const phases = phasesDe(inst, maintenant)
  const courante = phases.find(p => p.faites < p.total) ?? null
  const run = runActif(inst, maintenant)
  const attention = actives.filter(attendQuelquun(inst, maintenant))
  return {
    total: actives.length, faites, enCours: enCours(inst, maintenant), aFaire: actives.filter(t => !fait(t)).length, silence: silencieux(inst, maintenant),
    phases, courante, phaseMax: phases.at(-1)?.numero ?? 0,
    relectures: inst.relectures.length, attention, run,
    duree: inst.run && inst.run.debut != null ? (inst.run.fin ?? (runEnCours(inst) ? (run ? maintenant : inst.maj ?? inst.run.debut) : inst.run.debut)) - inst.run.debut : null,
    termine: actives.length > 0 && faites === actives.length,
  }
}

/** @param {Instantane} inst @param {number} maintenant @returns {PhaseVue[]} */
export function phasesDe(inst, maintenant) {
  // Une phase dont toutes les tâches sont annulées n'est plus une phase du plan, comme pour /orchestre:etat
  const nums = [...new Set(inst.taches.filter(t => t.statut !== 'annulée').map(t => t.phase))].sort((a, b) => a - b)
  const attend = attendQuelquun(inst, maintenant)
  return nums.map(numero => {
    const ts = inst.taches.filter(t => t.phase === numero && t.statut !== 'annulée')
    // Dans chaque run, du premier démarrage au dernier achèvement des tâches de la phase : un run en mode auto en parcourt
    // plusieurs, et l'attente entre deux runs ne compte pas
    let duree = /** @type {number | null} */ (null)
    for (const r of inst.runs) {
      if (r.debut == null) continue
      const d = r.debut, f = r.fin ?? (r.statut === 'en-cours' ? maintenant : d)
      const dans = /** @param {number | null} x */ x => x != null && x >= d && x <= f
      const vues = ts.filter(t => dans(t.debut) || dans(t.fin))
      if (!vues.length) continue
      const a = Math.min(...vues.map(t => (dans(t.debut) ? /** @type {number} */ (t.debut) : d)))
      const b = Math.max(...vues.map(t => (dans(t.fin) ? /** @type {number} */ (t.fin) : f)))
      duree = (duree ?? 0) + Math.max(0, b - a)
    }
    return {
      numero, total: ts.length, faites: ts.filter(fait).length,
      enCours: ts.filter(t => t.etape && !fait(t) && runActif(inst, maintenant)).length,
      attention: ts.filter(attend).length,
      essais: ts.reduce((s, t) => s + Math.max(t.essais, fait(t) ? 1 : 0), 0),
      relances: ts.filter(t => t.essais > 1).map(t => ({ id: t.id, essais: t.essais })),
      duree,
    }
  })
}

// ─── Mise en forme ───────────────────────────────────────────────────────────────────────────────────────────────

/** Durée lisible : « 45 s », « 18 min », « 1 h 12 ». @param {number | null} ms */
export function duree(ms) {
  if (ms == null || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}
/** Âge court d'un événement : « 45 s », « 18 min », « 1 h 12 », « 3 j » (pas d'heure : le fuseau du mod n'est pas sûr). @param {number | null} ms @param {number} maintenant */
export function age(ms, maintenant) {
  if (ms == null) return '—'
  const s = Math.max(0, maintenant - ms)
  return s >= 86400000 ? `${Math.floor(s / 86400000)} j` : duree(s)
}
/** @param {number} faites @param {number} total @param {number} largeur */
export function barre(faites, total, largeur) {
  const k = total > 0 ? Math.floor((faites / total) * largeur) : 0
  return '█'.repeat(k) + '░'.repeat(Math.max(0, largeur - k))
}
/** Coupe à n caractères visibles, avec « … ». @param {string} s @param {number} n */
export function court(s, n) {
  const c = [...String(s).replace(/\s+/g, ' ').trim()]
  return c.length > n ? c.slice(0, Math.max(0, n - 1)).join('') + '…' : c.join('')
}
/** Complète à n caractères (après coupe). @param {string} s @param {number} n */
export const colonne = (s, n) => { const c = court(s, n); return c + ' '.repeat(Math.max(0, n - [...c].length)) }
/** @param {number} n @param {string} mot */
const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`
/** « phase 2 », ou « phases 1 à 3 » pour un run qui en a parcouru plusieurs. @param {number} de @param {number} a */
const libellePhases = (de, a) => (a > de ? `phases ${de} à ${a}` : `phase ${de}`)

// ─── Couleurs et mouvement ───────────────────────────────────────────────────────────────────────────────────────
// Les images des animations se déduisent de l'heure : rien à garder d'un dessin à l'autre. register.tsx redessine
// toutes les IMAGE_MS pendant un run actif, et tant qu'un événement a moins de NOUVELLE_MS.
export const IMAGE_MS = 150
export const NOUVELLE_MS = 10000
const ROUE = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏', TOUR = '◐◓◑◒'
/** @param {number} m */ export const roue = m => /** @type {string} */ (ROUE[Math.floor(m / 100) % ROUE.length])
/** @param {number} m */ export const tour = m => /** @type {string} */ (TOUR[Math.floor(m / IMAGE_MS) % TOUR.length])
/** @param {number} m */ const pouls = m => Math.floor(m / 450) % 2 === 1
// Une couleur par étape, du thème de la personne
const COULEUR_ETAPE = /** @type {Record<string, string>} */ ({ worker: 'suggestion', vérification: 'merged', évaluation: 'planMode', correction: 'warning', fusion: 'success', replanification: 'subtle', suivi: 'subtle' })
// Classes d'une tâche, dans l'ordre de la barre : fusionnée, en cours, attend un humain, bloquée ou en échec, le reste
const CLASSES = /** @type {const} */ ([
  { c: 'success', g: '█' }, { c: 'suggestion', g: '█' }, { c: 'warning', g: '█' }, { c: 'error', g: '█' }, { c: 'subtle', g: '░' },
])
/** @param {Instantane} inst @param {number} maintenant @returns {(t: TacheVue) => number} */
function classeur(inst, maintenant) {
  const actif = !!runActif(inst, maintenant), attend = attendQuelquun(inst, maintenant)
  return t => (fait(t) ? 0 : actif && t.etape ? 1 : attend(t) ? (t.statut === 'besoin-humain' ? 2 : 3) : 4)
}

/**
 * Barre empilée par classe de tâche : une ou plusieurs cases par tâche quand elles tiennent, sinon en proportion,
 * chaque classe présente gardant au moins une case. Les tâches en cours pulsent quand `anime`.
 * @param {TacheVue[]} ts @param {(t: TacheVue) => number} classe @param {number} cases @param {number} maintenant @param {boolean} anime @returns {Ligne}
 */
export function barreClasses(ts, classe, cases, maintenant, anime) {
  if (!ts.length || cases <= 0) return cases > 0 ? [{ t: '░'.repeat(cases), c: 'subtle' }] : []
  const n = [0, 0, 0, 0, 0]
  for (const t of ts) { const i = classe(t); n[i] = (n[i] ?? 0) + 1 }
  let k
  if (ts.length <= cases) {
    const par = Math.floor(cases / ts.length)
    k = n.map(x => x * par)
  } else {
    k = n.map(x => (x ? Math.max(1, Math.floor((x / ts.length) * cases)) : 0))
    // Ajuste à `cases` : on prend sur la plus grosse classe, ou on lui rend
    let ecart = cases - k.reduce((a, b) => a + b, 0)
    while (ecart !== 0) {
      const i = k.indexOf(Math.max(...k))
      if (ecart < 0 && /** @type {number} */ (k[i]) <= 1) break
      k[i] = /** @type {number} */ (k[i]) + Math.sign(ecart)
      ecart -= Math.sign(ecart)
    }
  }
  /** @type {Ligne} */
  const l = []
  k.forEach((x, i) => {
    if (!x) return
    const cl = /** @type {typeof CLASSES[number]} */ (CLASSES[i])
    l.push({ t: (i === 1 && anime && pouls(maintenant) ? '▓' : cl.g).repeat(x), c: cl.c })
  })
  return l
}

/** Une case par tâche (■), colorée par classe, dans l'ordre du plan. @param {TacheVue[]} ts @param {(t: TacheVue) => number} classe @returns {Ligne} */
function cases(ts, classe) {
  /** @type {Ligne} */
  const l = []
  for (const t of ts) {
    const c = /** @type {typeof CLASSES[number]} */ (CLASSES[classe(t)]).c
    const der = l[l.length - 1]
    if (der && der.c === c) der.t += '■'
    else l.push({ t: '■', c })
  }
  return l
}

/** Les phases en points : ● faite, ◉ celle du run, ○ ambre une qui attend, ○ à venir ; null au-delà de 10 phases. @param {PhaseVue[]} phases @param {number | null} courante @returns {Ligne | null} */
export function pointsPhases(phases, courante) {
  if (!phases.length || phases.length > 10) return null
  return phases.map(p => (p.total && p.faites === p.total ? { t: '●', c: 'success' } : p.numero === courante ? { t: '◉', c: 'claude', b: true } : p.attention ? { t: '○', c: 'warning', b: true } : { t: '○', c: 'subtle' }))
}

const GENRES = /** @type {Record<string, Morceau>} */ ({
  run: { t: '▶', c: 'claude' }, tache: { t: '▶', c: 'suggestion' }, etape: { t: '·', d: true }, refus: { t: '↻', c: 'merged' },
  statut: { t: '●', c: 'success' }, ajout: { t: '+', c: 'suggestion' }, amendement: { t: '~', c: 'merged' }, relecture: { t: '⚑', c: 'warning' },
  'decision-office': { t: '⇒', c: 'warning' }, point: { t: '?', c: 'warning' }, arbitrage: { t: '✓', c: 'success' }, pilote: { t: '✎', c: 'suggestion' }, erreur: { t: '✗', c: 'error' },
  modele: { t: '⇄', c: 'merged' },
})
/** Glyphe et couleur d'une entrée du journal, d'après son genre et ce qu'elle dit. @param {{ genre: string, texte: string }} j @returns {Morceau} */
function marque(j) {
  if (j.genre === 'statut') return / fusionnée/.test(j.texte) ? { t: '✓', c: 'success' } : / besoin-humain/.test(j.texte) ? { t: '⚑', c: 'warning' } : / (bloquée|échec)/.test(j.texte) ? { t: '✗', c: 'error' } : { t: '●', c: 'subtle' }
  if (j.genre === 'run') return / : terminé/.test(j.texte) ? { t: '✓', c: 'success' } : / : (arbitrage|partiel|à-relancer)| interrompu/.test(j.texte) ? { t: '■', c: 'warning' } : { t: '▶', c: 'claude' }
  return GENRES[j.genre] || { t: '·', d: true }
}
// Ce qui fait une nouvelle au bout du bandeau, du plus important au moins important ; pas les étapes ni les démarrages,
// que le bandeau montre déjà. Une écriture de suivi.json en note souvent plusieurs, à la même seconde : la plus
// importante l'emporte, et la plus récente à importance égale.
const MARQUANTS = ['statut', 'run', 'erreur', 'arbitrage', 'point', 'refus', 'decision-office', 'relecture', 'pilote', 'ajout']
/** La nouvelle en peu de mots, d'après le texte que suivi.mjs écrit au journal. @param {{ genre: string, texte: string }} j */
function enBref(j) {
  const t = j.texte
  /** @type {RegExpMatchArray | null} */
  let m
  if (j.genre === 'run' && (m = t.match(/^run (\d+) : phase (\d+), mode (\S+?),/))) return `run ${m[1]} lancé (phase ${m[2]}, mode ${m[3]})`
  if (j.genre === 'statut' && (m = t.match(/^(\S+) : (fusionnée|besoin-humain|bloquée|échec) \((\d+) essai/))) {
    const [, id, st, n] = m
    return st === 'fusionnée' ? `${id} fusionnée${Number(n) > 1 ? ` au ${n}e essai` : ''}` : `${id} ${/** @type {Record<string, string>} */ (ATTENTION)[/** @type {string} */ (st)]}`
  }
  if (j.genre === 'refus' && (m = t.match(/^(\S+) : essai (\d+) refusé \(([^)]+)\)/))) return `${m[1]} : essai ${m[2]} refusé (${m[3]})`
  if (j.genre === 'relecture' && (m = t.match(/^(\S+) : relecture/))) return `${m[1]} : à relire avant la PR`
  if (j.genre === 'decision-office' && (m = t.match(/^(\S+) :/))) return `${m[1]} : décision prise d'office`
  if (j.genre === 'arbitrage' && (m = t.match(/^(\S+) : .* tranché, option (\S+)/))) return `${m[1]} : point tranché (option ${m[2]})`
  return t
}
/**
 * La dernière nouvelle de moins de NOUVELLE_MS : une tâche close, un run lancé ou fini, un arbitrage, un refus…
 * @param {Instantane} inst @param {number} maintenant @returns {{ marque: Morceau, texte: string, age: number, genre: string } | null}
 */
export function nouvelle(inst, maintenant) {
  const recentes = inst.journal.filter(j => j.quand != null && maintenant - j.quand <= NOUVELLE_MS && MARQUANTS.includes(j.genre))
  if (!recentes.length) return null
  const quand = Math.max(...recentes.map(j => /** @type {number} */ (j.quand)))
  const j = recentes.filter(x => x.quand === quand).reverse().sort((x, y) => MARQUANTS.indexOf(x.genre) - MARQUANTS.indexOf(y.genre))[0]
  if (!j) return null
  return { marque: marque(j), texte: enBref(j), age: Math.max(0, maintenant - quand), genre: j.genre }
}

/** Glyphe et couleur d'une tâche ; une tâche en cours tourne quand `anime`. @param {TacheVue} t @param {boolean} active @param {number} [maintenant] @param {boolean} [anime] @returns {Morceau} */
export function glyphe(t, active, maintenant = 0, anime = false) {
  if (t.statut === 'fusionnée') return { t: '●', c: 'success' }
  if (t.statut === 'annulée') return { t: '–', d: true }
  if (active && t.etape) return { t: anime ? tour(maintenant) : '◐', c: 'suggestion', b: true }
  if (t.statut === 'besoin-humain') return { t: '⚑', c: 'warning', b: true }
  if (t.statut === 'bloquée' || t.statut === 'échec') return { t: '✗', c: 'error', b: true }
  return { t: '○', c: 'subtle' }
}
const ETAPES = /** @type {Record<string, string>} */ ({ worker: 'réalisation', vérification: 'vérification', évaluation: 'évaluation', correction: 'correction', fusion: 'fusion', replanification: 'replanification', suivi: 'suivi' })
// La case de l'étape au bandeau : « vérification +9 » (« replanification », rare, la dépasse)
const LARG_ETAPE = 15

/** Ce que fait une tâche, en quelques mots. @param {TacheVue} t @param {boolean} active @param {boolean} [tranchee] */
export function quoi(t, active, tranchee = false) {
  if (active && t.etape) return (ETAPES[t.etape] || t.etape) + (t.essais > 1 ? `, essai ${t.essais}` : '') + (t.isole ? ' (worktree)' : '')
  if (t.statut in ATTENTION && tranchee) return 'point tranché, reprise à venir'
  if (t.statut in ATTENTION) return /** @type {Record<string, string>} */ (ATTENTION)[t.statut] + (t.blocage[0] ? ` : ${t.blocage[0]}` : '')
  if (t.statut === 'fusionnée') return t.essais > 1 ? `${t.essais} essais` : ''
  return t.attend.length ? `attend ${t.attend.slice(0, 4).join(', ')}${t.attend.length > 4 ? '…' : ''}` : ''
}
/** La même chose en couleurs : l'étape dans sa couleur, l'essai en ambre, le lieu estompé. @param {TacheVue} t @param {boolean} active @param {boolean} tranchee @param {number} n @returns {Ligne} */
function quoiColore(t, active, tranchee, n) {
  if (active && t.etape) {
    /** @type {Ligne} */
    const l = [{ t: court(ETAPES[t.etape] || t.etape, n), c: COULEUR_ETAPE[t.etape] || 'subtle', b: true }]
    if (t.essais > 1) l.push({ t: ` essai ${t.essais}`, c: 'warning' })
    if (t.isole) l.push({ t: ' (worktree)', d: true })
    return l
  }
  const q = court(quoi(t, active, tranchee), n)
  if (!q) return []
  return [{ t: q, c: tranchee ? 'subtle' : t.statut === 'besoin-humain' ? 'warning' : t.statut in ATTENTION ? 'error' : 'subtle' }]
}

/** Largeur affichée d'une ligne, en cellules (tous ses glyphes en occupent une). @param {Ligne} l */
export const largeur = l => l.reduce((n, m) => n + [...m.t].length, 0)

/**
 * Le bandeau au-dessus du prompt : une ligne, ou rien (null) quand aucun run n'est à montrer. Il tient dans `colonnes`
 * moins `reserve` (la place des boutons à sa suite) : on retire la dernière nouvelle, le détail de l'étape,
 * puis on raccourcit les libellés et la barre, puis la durée et le numéro du run, jusqu'à ce qu'il tienne. La forme la
 * plus courte fait une quarantaine de cellules sur un petit plan, une soixantaine au plus sur un gros ; en deçà,
 * l'affichage coupe la fin de la ligne. Avec `anime`, la tête tourne et les tâches en cours pulsent dans la barre.
 * @param {Instantane} inst @param {number} maintenant @param {number} colonnes @param {number} [reserve] @param {boolean} [anime] @returns {Ligne | null}
 */
export function bandeau(inst, maintenant, colonnes, reserve = 0, anime = false) {
  if (!inst.run) return null
  const s = resumer(inst, maintenant)
  const place = Math.max(0, colonnes - reserve)
  /** @type {Ligne | null} */
  let l = null
  for (const forme of FORMES_BANDEAU) {
    l = ligneBandeau(inst, s, maintenant, forme, anime)
    if (largeur(l) <= place) return l
  }
  return l
}
// Du plus complet au plus court
const FORMES_BANDEAU = [
  { nouvelle: true, etape: true, libelles: true, barre: 14, nom: 28, duree: true, run: true },
  { nouvelle: false, etape: true, libelles: true, barre: 12, nom: 24, duree: true, run: true },
  { nouvelle: false, etape: false, libelles: true, barre: 10, nom: 20, duree: true, run: true },
  { nouvelle: false, etape: false, libelles: false, barre: 8, nom: 16, duree: true, run: true },
  { nouvelle: false, etape: false, libelles: false, barre: 4, nom: 12, duree: false, run: true },
  { nouvelle: false, etape: false, libelles: false, barre: 0, nom: 8, duree: false, run: true },
  { nouvelle: false, etape: false, libelles: false, barre: 0, nom: 8, duree: false, run: false },
]
/**
 * @param {Instantane} inst @param {ReturnType<typeof resumer>} s @param {number} maintenant
 * @param {typeof FORMES_BANDEAU[number]} f @param {boolean} anime @returns {Ligne}
 */
function ligneBandeau(inst, s, maintenant, f, anime) {
  const run = /** @type {NonNullable<Instantane['run']>} */ (inst.run)
  const enCoursRun = !!s.run
  const tete = s.silence ? { t: '◌ ', c: 'warning' } : enCoursRun ? { t: `${anime ? roue(maintenant) : '▶'} `, c: 'claude' } : run.statut === 'terminé' ? { t: '✓ ', c: 'success' } : { t: '■ ', c: 'warning' }
  const phase = phaseDuRun(inst)
  /** @type {Ligne} */
  const l = [{ ...tete, b: true }, ...(inst.demo ? [{ t: ' DÉMO ', c: 'inverseText', f: 'merged', b: true }, { t: ' ' }] : []), { t: court(inst.plan, f.nom), b: true }, { t: '  ' }]
  const points = pointsPhases(s.phases, phase)
  if (points) l.push(...points)
  else l.push({ t: `phase ${phase}/${s.phaseMax}`, d: true })
  if (f.barre) l.push({ t: '  ' }, ...barreClasses(inst.taches.filter(t => t.statut !== 'annulée'), classeur(inst, maintenant), f.barre, maintenant, anime))
  // Cases de largeur fixe : « 2/5 » prend la place de « 5/5 », l'étape en cours celle de la plus longue ; ce qui suit ne
  // bouge pas quand l'étape change
  l.push({ t: `  ${String(s.faites).padStart(String(s.total).length)}/${s.total}`, b: true })
  // Ce qui demande quelqu'un vient juste après l'avancement, avant les tâches en cours dont le texte change de longueur :
  // les mentions ne bougent pas d'une étape à l'autre. Elles se cliquent (a : la carte du panneau ouverte, k : la clé
  // du bouton) ; le glyphe garde la couleur.
  if (s.relectures) l.push({ t: '  ' }, { t: '⚑ ', c: 'warning' }, { t: `${s.relectures}${f.libelles ? ' à relire' : ''}`, a: 'toi', k: 'relire' })
  if (s.attention.length) l.push({ t: '  ' }, { t: '⚠ ', c: 'warning', b: true }, { t: `${s.attention.length}${f.libelles ? ' à toi' : ''}`, a: 'toi', k: 'toi' })
  const ec = s.enCours
  if (enCoursRun && f.etape) {
    const t = ec[0], id = Math.min(8, Math.max(3, ...inst.taches.map(x => [...x.id].length)))
    if (t) {
      const etape = ETAPES[t.etape || ''] || String(t.etape), plus = ec.length > 1 ? ` +${ec.length - 1}` : ''
      l.push({ t: `  ◐ ${colonne(t.id, id)} `, c: 'suggestion' }, { t: etape, c: COULEUR_ETAPE[t.etape || ''] || 'subtle', b: true })
      if (plus) l.push({ t: plus, c: 'suggestion' })
      l.push({ t: ' '.repeat(Math.max(0, LARG_ETAPE - [...etape].length - plus.length)) })
    } else l.push({ t: ' '.repeat(5 + id + LARG_ETAPE) })
  } else if (ec.length) l.push({ t: `  ◐ ${ec.length}${f.libelles ? ' en cours' : ''}`, c: 'suggestion' })
  if (s.silence) l.push({ t: f.libelles ? `  sans nouvelles depuis ${duree(maintenant - /** @type {number} */ (inst.maj))}` : `  ◌ ${duree(maintenant - /** @type {number} */ (inst.maj))}`, c: 'warning' })
  else if (!enCoursRun) l.push({ t: f.run ? `  run ${run.numero} ${run.statut}` : `  ${run.statut}`, c: run.statut === 'terminé' ? 'success' : 'warning', b: true })
  if (f.duree) l.push({ t: `  ⏱ ${duree(s.duree)}`, d: true })
  const n = f.nouvelle ? nouvelle(inst, maintenant) : null
  // La fin du run est déjà dite par son statut, juste avant
  if (n && !(n.genre === 'run' && !enCoursRun)) {
    const vive = n.age < NOUVELLE_MS / 2
    l.push({ t: '   ' }, { ...n.marque, b: vive, d: !vive }, { t: ` ${court(n.texte, 44)}`, c: vive ? n.marque.c : undefined, b: vive, d: !vive })
  }
  return l
}

/** Le suffixe du spinner pendant un run actif : « · T22 vérification · 3 tâches en cours… ». @param {Instantane} inst @param {number} maintenant */
export function suffixe(inst, maintenant) {
  const ts = enCours(inst, maintenant), t = ts[0]
  if (!t) return null
  return ` · ${t.id} ${ETAPES[t.etape || ''] || t.etape} · ${pluriel(ts.length, 'tâche')} en cours…`
}

// ─── Le panneau : une vue en cartes ──────────────────────────────────────────────────────────────────────────────
// Dans l'ordre : ce qui t'attend (s'il y a quelque chose), le run, les tâches en frise, le journal. Dans le panneau, t, r,
// b et j font défiler jusqu'à une carte ; 1 à 9 agissent sur les lignes de « À toi », l et p sur la suite d'un run fini.
// Une action ne fait que préparer un texte dans le prompt : rien n'est envoyé sans la personne.

const MODES = /** @type {Record<string, string>} */ ({ auto: 'autonome', devia: 'arrêt sur déviation', phase: 'arrêt par phase' })
const ETAPE_COURTE = /** @type {Record<string, string>} */ ({ worker: 'réal', vérification: 'vérif', évaluation: 'éval', correction: 'corr', fusion: 'fusion', replanification: 'replan', suivi: 'suivi' })
const ORDRE_ETAPES = ['worker', 'vérification', 'évaluation', 'correction', 'fusion', 'replanification', 'suivi']
// Ce que suivi.mjs écrit au journal à chaque étape : « T01 démarre (worktree) » pour la réalisation (genre tache),
// « T01 : vérification », « T01 : correction (essai 2) » pour les suivantes (genre etape)
const RE_ETAPE = /^(\S+) : (vérification|évaluation|correction|fusion|replanification|suivi)(?: \(|$)/
const RE_DEMARRE = /^(\S+) démarre \(/
export const JOURNAL_COURT = 6
const JOURNAL_LONG = 60
// Le panneau perd ses bords en deçà
const COLONNES_BORDS = 60

/** Chrono : « 0:42 », « 12:05 », « 1:02:03 ». @param {number | null} ms */
export function chrono(ms) {
  if (ms == null || ms < 0) return '—'
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}
/** Le dossier du plan, pour les commandes proposées. @param {Instantane} inst */
const dossierDe = inst => inst.dossier || `plans/${inst.plan}`
/** @param {Ligne[]} parts @param {string} sep @returns {Ligne} */
const joindre = (parts, sep) => parts.flatMap((p, i) => (i ? [{ t: sep, d: true }, ...p] : p))

/** Le temps du dernier run : de son début à sa fin, ou à maintenant pendant un run actif. @param {Instantane} inst @param {number} maintenant */
function fenetre(inst, maintenant) {
  const r = inst.run
  if (!r || r.debut == null) return null
  const fin = r.fin ?? (runActif(inst, maintenant) ? maintenant : Math.max(r.debut, inst.maj ?? r.debut))
  return { debut: r.debut, fin: Math.max(fin, r.debut + 1000) }
}
/** Le run où une tâche a été close. @param {Instantane} inst @param {TacheVue} t */
const runDe = (inst, t) => (t.fin == null ? null : inst.runs.find(r => r.debut != null && /** @type {number} */ (t.fin) >= r.debut && (r.fin == null || /** @type {number} */ (t.fin) <= r.fin)) ?? null)

/**
 * Les étapes d'une tâche pendant le dernier run, datées par le journal : chacune court jusqu'à la suivante, la dernière
 * jusqu'à la clôture de la tâche, ou jusqu'à maintenant si elle tourne encore.
 * @param {Instantane} inst @param {TacheVue} t @param {number} maintenant @returns {[number, number, string][]}
 */
export function etapesDe(inst, t, maintenant) {
  const f = fenetre(inst, maintenant)
  if (!f) return []
  /** @type {{ quand: number, etape: string }[]} */
  const reperes = []
  for (const j of inst.journal) {
    if (j.tache !== t.id || j.quand == null || j.quand < f.debut || j.quand > f.fin) continue
    const m = j.genre === 'etape' ? j.texte.match(RE_ETAPE) : null
    if (m) reperes.push({ quand: j.quand, etape: /** @type {string} */ (m[2]) })
    else if (j.genre === 'tache' && RE_DEMARRE.test(j.texte)) reperes.push({ quand: j.quand, etape: 'worker' })
  }
  const close = t.fin != null && t.fin >= f.debut && t.fin <= f.fin
  const bout = close ? /** @type {number} */ (t.fin) : runActif(inst, maintenant) && t.etape && !fait(t) ? maintenant : f.fin
  /** @type {[number, number, string][]} */
  const out = []
  reperes.forEach((r, i) => {
    const b = i + 1 < reperes.length ? /** @type {{ quand: number }} */ (reperes[i + 1]).quand : bout
    if (b > r.quand) out.push([r.quand, b, r.etape])
  })
  return out
}

/** Le temps passé dans chaque étape pendant le dernier run, toutes tâches comprises. @param {Instantane} inst @param {number} maintenant @returns {[string, number][]} */
export function tempsParEtape(inst, maintenant) {
  const tot = /** @type {Record<string, number>} */ ({})
  for (const t of inst.taches) for (const [a, b, e] of etapesDe(inst, t, maintenant)) tot[e] = (tot[e] || 0) + (b - a)
  return ORDRE_ETAPES.filter(e => tot[e]).map(e => [e, /** @type {number} */ (tot[e])])
}

/**
 * La frise d'une tâche sur le temps du dernier run : une case par tranche de temps, coloriée par étape ; le reste en
 * pointillés. La tête d'une tâche en cours pulse quand `anime`.
 * @param {Instantane} inst @param {TacheVue} t @param {number} maintenant @param {number} W @param {boolean} anime @returns {Ligne}
 */
function frise(inst, t, maintenant, W, anime) {
  const f = fenetre(inst, maintenant)
  /** @type {(string | null)[]} */
  const cells = Array(W).fill(null)
  if (f) {
    const x = /** @param {number} q */ q => ((q - f.debut) / (f.fin - f.debut)) * W
    for (const [a, b, e] of etapesDe(inst, t, maintenant)) {
      const i0 = Math.min(W - 1, Math.max(0, Math.floor(x(a)))), i1 = Math.min(W - 1, Math.max(i0, Math.ceil(x(b)) - 1))
      for (let i = i0; i <= i1; i++) cells[i] = e
    }
  }
  const tete = anime && !!runActif(inst, maintenant) && !!t.etape && !fait(t) && pouls(maintenant) ? cells.findLastIndex(c => c != null) : -1
  /** @type {Ligne} */
  const l = []
  cells.forEach((e, i) => {
    const m = e == null ? { t: '·', c: 'subtle' } : { t: i === tete ? '╸' : '━', c: COULEUR_ETAPE[e] || 'subtle' }
    const der = l[l.length - 1]
    if (der && der.c === m.c && !(i === tete || i === tete + 1)) der.t += m.t
    else l.push(m)
  })
  return l
}

/** Les phases en frise : ● faite, ◉ en cours, ○ à venir, reliées par des traits. @param {PhaseVue[]} phases @param {number | null} cur @param {number} w @returns {Ligne} */
function frisePhases(phases, cur, w) {
  const pts = pointsPhases(phases, cur)
  if (!pts) return [{ t: `phase ${cur ?? '—'}/${phases.length}`, b: true }]
  const n = pts.length, k = n > 1 ? Math.max(1, Math.floor((w - n) / (n - 1))) : 0
  /** @type {Ligne} */
  const l = []
  phases.forEach((p, i) => {
    l.push(/** @type {Morceau} */ (pts[i]))
    if (i < n - 1) l.push({ t: '━'.repeat(k), c: p.total && p.faites === p.total ? 'success' : p.numero === cur ? 'claude' : 'subtle' })
  })
  return l
}

/**
 * Ce qui t'attend, une ligne par chose, chacune avec son action : les tâches qui attendent un humain, bloquées ou en échec,
 * les points à trancher, les prérequis ouverts, plan-lint en erreur, puis les relectures et les décisions d'office à revoir
 * avant la PR. Les 9 premières ont une touche (1 à 9). null s'il n'y a rien.
 * @param {Instantane} inst @param {number} maintenant @param {number} colonnes
 * @returns {(Carte & { urgent: number }) | null}
 */
export function carteAToi(inst, maintenant, colonnes) {
  const s = resumer(inst, maintenant), dossier = dossierDe(inst), reprendre = `/orchestre:lancer ${dossier} --reprendre`
  /** @type {{ g: Morceau, texte: string, detail?: string, prompt: string, aide: string }[]} */
  const items = []
  const vus = new Set()
  for (const t of s.attention) {
    const p = inst.points.find(x => x.tache === t.id)
    if (p) vus.add(p)
    const raison = /** @type {Record<string, string>} */ (ATTENTION)[t.statut]
    items.push(p || t.statut === 'besoin-humain'
      ? { g: { t: '⚑', c: 'warning', b: true }, texte: `${t.id} · ${p ? p.titre : raison}${p?.humain ? ' (humain)' : ''}`, detail: t.blocage[0], prompt: reprendre, aide: 'reprendre le run' }
      : { g: { t: '✗', c: 'error', b: true }, texte: `${t.id} · ${raison}`, detail: t.blocage[0], prompt: `Explique le blocage de ${t.id}${t.blocage[0] ? ` (${t.blocage[0]})` : ''} et propose une suite.`, aide: 'demander au pilote' })
  }
  for (const p of inst.points) if (!vus.has(p)) items.push({ g: { t: '?', c: 'warning', b: true }, texte: `${p.tache} · ${p.titre}${p.humain ? ' (humain)' : ''}`, prompt: reprendre, aide: 'trancher au lancement' })
  for (const p of inst.prerequis) items.push({ g: { t: '◇', c: 'warning', b: true }, texte: `${p.id} (${p.type}) ouvert${p.bloque.length ? `, bloque ${p.bloque.slice(0, 4).join(', ')}` : ''}`, prompt: `/orchestre:pret ${dossier}`, aide: 'régler les prérequis' })
  if (!inst.lint.ok) items.push({ g: { t: '✗', c: 'error', b: true }, texte: `plan-lint : ${pluriel(inst.lint.erreurs, 'erreur')} au dernier suivi`, prompt: `Montre-moi les erreurs de plan-lint sur ${dossier} et propose une correction.`, aide: 'demander au pilote' })
  const urgent = items.length
  for (const r of inst.relectures) items.push({ g: { t: '⚑', c: 'warning' }, texte: `${r.tache ?? 'plan source'} · ${r.texte}`, prompt: `Relis avec moi, avant la PR (relecture de ${r.tache ?? 'plan source'}) : ${r.texte}`, aide: 'relire' })
  for (const d of inst.decisions) items.push({ g: { t: '⇒', c: 'merged' }, texte: `${d.tache} · ${d.titre} : ${d.option}${d.description ? ` (${d.description})` : ''}`, prompt: `Revois avec moi la décision prise d'office pour ${d.tache} : « ${d.titre} », option ${d.option}${d.description ? ` (${d.description})` : ''}.`, aide: 'revoir' })
  if (!items.length) return null
  const inner = colonnes - 4
  /** @type {Ligne[]} */
  const lignes = []
  items.forEach((it, i) => {
    const touche = i < 9 ? String(i + 1) : null
    const aide = `  → ${it.aide}`
    lignes.push([it.g, { t: ' ' }, { t: court(it.texte, Math.max(16, inner - aide.length - 6)), x: { touche, prompt: it.prompt, aide: it.aide } }, { t: aide, d: true }])
    if (it.detail) lignes.push([{ t: `     ${court(it.detail, Math.max(16, inner - 6))}`, d: true }])
  })
  const compte = [
    urgent ? `${urgent} à régler` : '',
    inst.relectures.length ? pluriel(inst.relectures.length, 'relecture') : '',
    inst.decisions.length ? pluriel(inst.decisions.length, 'décision') : '',
  ].filter(Boolean).join(' · ')
  return {
    id: 'toi', couleur: 'warning', urgent,
    titre: [{ t: urgent ? '⚠ À toi' : '⚑ À relire avant la PR', c: 'warning', b: true }],
    meta: [{ t: compte, d: true }],
    lignes,
  }
}

/**
 * Le dernier run : phases en frise, barre par statut avec ses comptes, durée, temps par étape, et la suite quand il est
 * fini (reprendre, ou le brouillon de PR quand le plan est terminé).
 * @param {Instantane} inst @param {number} maintenant @param {number} colonnes @param {boolean} anime @returns {Carte}
 */
export function carteRun(inst, maintenant, colonnes, anime) {
  const s = resumer(inst, maintenant), r = inst.run, inner = colonnes - 4, dossier = dossierDe(inst)
  if (!r) return { id: 'run', couleur: 'subtle', titre: [{ t: 'Aucun run noté', b: true }], meta: [], lignes: [[{ t: `Le premier /orchestre:lancer ${dossier} l'ouvrira.`, d: true }]] }
  const cur = phaseDuRun(inst), enCoursRun = r.statut === 'en-cours'
  const couleur = enCoursRun ? (s.silence ? 'warning' : 'claude') : r.statut === 'terminé' ? 'success' : r.statut === 'erreur' ? 'error' : 'warning'
  const actives = inst.taches.filter(t => t.statut !== 'annulée'), classe = classeur(inst, maintenant)
  const n = [0, 0, 0, 0, 0]
  for (const t of actives) { const i = classe(t); n[i] = (n[i] ?? 0) + 1 }
  const dans = /** @param {{ quand: number | null }} j */ j => j.quand != null && r.debut != null && j.quand >= r.debut && (r.fin == null || j.quand <= r.fin)
  // Les essais de plus des tâches démarrées dans ce run (un refus d'évaluation ou de vérification en vaut un)
  const relances = inst.taches.filter(t => t.debut != null && r.debut != null && t.debut >= r.debut).reduce((k, t) => k + Math.max(0, t.essais - 1), 0)
  const office = inst.journal.filter(j => j.genre === 'decision-office' && dans(j)).length
  /** @type {Ligne[]} */
  const lignes = [
    [{ t: 'phases  ', d: true }, ...frisePhases(s.phases, cur, Math.max(8, Math.min(40, inner - 24))), ...(s.phases.length <= 10 ? [{ t: `   phase ${cur}/${s.phaseMax}`, d: true }] : [])],
    [{ t: 'tâches  ', d: true }, ...barreClasses(actives, classe, Math.max(8, Math.min(30, inner - 36)), maintenant, anime), { t: `  ${s.faites}/${s.total}`, b: true },
      ...n.flatMap((k, i) => (k ? [{ t: '   ■', c: /** @type {typeof CLASSES[number]} */ (CLASSES[i]).c }, { t: ` ${k}` }] : []))],
    [{ t: 'durée   ', d: true }, { t: duree(s.duree) }, ...(r.parallelisme ? [{ t: ` · ${r.parallelisme} en parallèle`, d: true }] : []), ...(relances ? [{ t: ' · ', d: true }, { t: `${relances} ${relances > 1 ? 'essais' : 'essai'} de plus` }] : []), ...(office ? [{ t: ' · ', d: true }, { t: `${pluriel(office, 'décision')} d'office` }] : [])],
  ]
  const etapes = tempsParEtape(inst, maintenant)
  if (etapes.length) lignes.push([{ t: 'étapes  ', d: true }, ...joindre(etapes.map(([e, ms]) => [{ t: `${ETAPE_COURTE[e] || e} ${chrono(ms)}`, c: COULEUR_ETAPE[e] || 'subtle' }]), ' · ')])
  if (!enCoursRun && r.detail) lignes.push([{ t: 'détail  ', d: true }, { t: court(r.detail, Math.max(16, inner - 10)) }])
  if (!enCoursRun) {
    lignes.push(s.termine
      ? [{ t: 'suite   ', d: true }, { t: 'Brouillon de PR dans le prompt', x: { touche: 'p', prompt: textePR(inst, maintenant), aide: 'préparer la PR' } }]
      : [{ t: 'suite   ', d: true }, { t: `/orchestre:lancer ${dossier} --reprendre`, x: { touche: 'l', prompt: `/orchestre:lancer ${dossier} --reprendre`, aide: 'reprendre le run' } }, { t: '  dans le prompt', d: true }])
  }
  const marqueur = enCoursRun ? '' : r.statut === 'terminé' ? '✓ ' : r.statut === 'erreur' ? '✗ ' : '■ '
  return {
    id: 'run', couleur,
    titre: [{ t: `${marqueur}Run ${r.numero} · ${libellePhases(r.phase, cur ?? r.phase)} · ${MODES[r.mode] || r.mode}`, c: couleur, b: true }],
    meta: enCoursRun
      ? (s.silence ? [{ t: `◌ sans nouvelles depuis ${duree(maintenant - /** @type {number} */ (inst.maj))}`, c: 'warning' }] : [{ t: `◐ ${s.enCours.length} en cours`, c: 'suggestion' }])
      : [{ t: r.statut, c: couleur, b: true }],
    lignes,
  }
}

// La colonne du modèle, dans les lignes de tâches : 14 cellules tiennent « haiku → sonnet »
const LARG_MODELE = 14
/**
 * Le modèle d'une tâche (0.11.0) : le modèle utilisé, ou « prévu → utilisé » quand ils diffèrent (« — » si le plan n'en
 * prévoit pas) ; avant le worker, le modèle prévu, estompé. Vide si rien n'est connu.
 * @param {TacheVue} t @returns {Ligne}
 */
export function modeleDe(t) {
  if (!t.modeleUtilise) return t.modele ? [{ t: t.modele, d: true }] : []
  if (t.modeleUtilise === t.modele) return [{ t: t.modeleUtilise, c: 'subtle' }]
  return [{ t: `${t.modele ?? '—'} → `, d: true }, { t: t.modeleUtilise, c: 'merged', b: true }]
}
/** La cellule du modèle, coupée et complétée à n cellules, suivie de deux espaces ; rien si n vaut 0. @param {TacheVue} t @param {number} n @returns {Ligne} */
function celluleModele(t, n) {
  if (!n) return []
  /** @type {Ligne} */
  const l = []
  let reste = n
  // Coupé seulement s'il dépasse : court() retirerait l'espace qui suit la flèche
  for (const m of modeleDe(t)) { if (reste <= 0) break; const x = [...m.t].length > reste ? court(m.t, reste) : m.t; l.push({ ...m, t: x }); reste -= [...x].length }
  return [...l, { t: ' '.repeat(Math.max(0, reste) + 2) }]
}

/**
 * Les tâches : une ligne par phase (une case par tâche), puis, sous les phases où il se passe quelque chose, une ligne
 * par tâche avec sa frise sur le temps du dernier run, sa durée et ce qu'elle fait. Une tâche close dans un run
 * précédent garde une ligne courte ; les tâches à faire de la phase en cours sont bornées à 6.
 * @param {Instantane} inst @param {number} maintenant @param {number} colonnes @param {boolean} [anime] @returns {Ligne[]}
 */
export function lignesTaches(inst, maintenant, colonnes, anime = false) {
  const s = resumer(inst, maintenant), actif = !!s.run, f = fenetre(inst, maintenant)
  const cur = actif ? phaseDuRun(inst) : s.courante?.numero ?? null
  const classe = classeur(inst, maintenant)
  // Colonne du modèle (0.11.0) : à la largeur du plus long des modèles connus, prise sur la frise puis sur le titre, pour que
  // ce que fait la tâche garde sa place (30 cellules quand la largeur le permet, 20 au moins) ; absente si aucun modèle n'est
  // connu, ou si elle ne tient pas. La frise retrouve ses 26 cellules dès que la place le permet
  const MW0 = Math.min(LARG_MODELE, Math.max(0, ...inst.taches.map(t => largeur(modeleDe(t)))))
  const MW = MW0 && colonnes >= 60 + MW0 + 2 ? MW0 : 0
  const MC = MW ? MW + 2 : 0
  const larg = Math.max(10, Math.min(22, colonnes - 60 - MC)), W = Math.max(8, Math.min(26, colonnes - larg - 42 - (MC ? MC + 10 : 0)))
  const QW = Math.max(10, colonnes - larg - W - 22 - MC)
  const touchee = /** @param {TacheVue} t */ t => !!f && ((t.debut != null && t.debut >= f.debut) || (t.fin != null && t.fin >= f.debut) || (actif && !!t.etape))
  const vient = /** @param {TacheVue} t */ t => fait(t) && t.fin != null && maintenant - t.fin < NOUVELLE_MS / 2
  /** @type {Ligne[]} */
  const out = []
  let segments = false
  for (const p of s.phases) {
    const finie = p.total > 0 && p.faites === p.total
    const g = finie ? { t: '●', c: 'success' } : p.attention ? { t: '⚠', c: 'warning' } : p.numero === cur ? { t: '◉', c: 'claude', b: true } : p.faites ? { t: '◐', c: 'suggestion' } : { t: '○', c: 'subtle' }
    const ts = inst.taches.filter(t => t.phase === p.numero && t.statut !== 'annulée')
    /** @type {Ligne} */
    const l = [g, { t: ` Phase ${String(p.numero).padEnd(3)}`, b: p.numero === cur || finie, c: finie ? 'success' : undefined }, { t: ' ' }]
    l.push(...(ts.length <= 30 ? cases(ts, classe) : barreClasses(ts, classe, 20, maintenant, anime)))
    l.push({ t: `  ${p.faites}/${p.total}`, c: finie ? 'success' : undefined, b: finie }, { t: `  ${duree(p.duree)}`, d: true })
    if (p.relances.length) l.push({ t: `   ${p.relances.slice(0, 3).map(r => `${r.id} ×${r.essais}`).join(', ')}${p.relances.length > 3 ? '…' : ''}`, c: 'merged' })
    out.push(l)
    const detail = ts.filter(t => touchee(t) || t.statut in ATTENTION)
    const aFaire = p.numero === cur ? ts.filter(t => !fait(t) && !detail.includes(t)) : []
    for (const t of detail) {
      const segs = etapesDe(inst, t, maintenant)
      if (segs.length) segments = true
      const enMarche = actif && !!t.etape && !fait(t)
      const avant = !segs.length && fait(t) ? runDe(inst, t) : null
      const temps = segs.length ? /** @type {[number, number, string]} */ (segs.at(-1))[1] - /** @type {[number, number, string]} */ (segs[0])[0] : t.debut != null && t.fin != null ? t.fin - t.debut : null
      /** @type {Ligne} */
      const ligne = [{ t: '  ' }, glyphe(t, actif, maintenant, anime), { t: ` ${colonne(t.id, 6)}`, b: true }, { t: `${colonne(t.titre, larg)} `, d: !enMarche && !fait(t) }]
      if (segs.length) ligne.push(...frise(inst, t, maintenant, W, anime))
      else if (avant) ligne.push({ t: `── run ${avant.numero} `.padEnd(W, '─').slice(0, W), c: 'subtle' })
      else ligne.push({ t: '·'.repeat(W), c: 'subtle' })
      ligne.push({ t: `  ${chrono(temps).padStart(7)}  `, d: true }, ...celluleModele(t, MW))
      if (vient(t)) ligne.push({ t: ' fusionnée ', c: 'inverseText', f: 'success', b: true })
      else ligne.push(...quoiColore(t, actif, arbitree(inst, t), QW))
      out.push(ligne)
    }
    // Le modèle prévu, dans la même colonne que les lignes détaillées (à la place de la durée, vide)
    for (const t of aFaire.slice(0, 6)) out.push([{ t: '  ' }, glyphe(t, actif), { t: ` ${colonne(t.id, 6)}${colonne(t.titre, larg)} `, d: true }, { t: '·'.repeat(W), c: 'subtle' }, ...(MW ? [{ t: ' '.repeat(11) }, ...celluleModele(t, MW)] : [{ t: '  ' }]), { t: court(quoi(t, actif), MW ? QW : Math.max(10, colonnes - larg - W - 14)), d: true }])
    if (aFaire.length > 6) out.push([{ t: `    ○ ${aFaire.length - 6} autres à faire`, d: true }])
  }
  if (!out.length) return [[{ t: 'Aucune tâche dans suivi.json.', d: true }]]
  if (segments) out.push([{ t: ' '.repeat(10 + larg) }, ...joindre(ORDRE_ETAPES.slice(0, 5).map(e => [{ t: '━', c: COULEUR_ETAPE[e] }, { t: ` ${ETAPE_COURTE[e]}`, d: true }]), ' ')])
  return out
}

/** Le journal en colonnes : âge, source colorée, message ; les dernières entrées, ou tout avec `complet`. @param {Instantane} inst @param {number} maintenant @param {number} colonnes @param {boolean} complet @returns {Carte} */
export function carteJournal(inst, maintenant, colonnes, complet) {
  const inner = colonnes - 4
  const js = inst.journal.slice(-(complet ? JOURNAL_LONG : JOURNAL_COURT))
  const lignes = js.length
    ? js.map(j => { const m = marque(j); return [{ t: age(j.quand, maintenant).padStart(6), d: true }, { t: '  ' }, { t: colonne(j.tache ?? (j.genre === 'run' || j.genre === 'erreur' ? 'run' : 'plan'), 6), c: m.c, d: m.d, b: !m.d }, m, { t: ` ${court(j.texte, Math.max(16, inner - 18))}` }] })
    : [[{ t: 'Journal vide.', d: true }]]
  const reste = inst.journal.length - js.length
  return { id: 'journal', couleur: 'subtle', titre: [{ t: 'journal', b: true }], meta: [{ t: complet ? 'j : moins' : reste > 0 ? `j : tout (${inst.journal.length})` : '', d: true }], lignes }
}

/**
 * Ce qui a changé depuis `t0` (ton dernier passage), d'après le journal : tâches fusionnées, tâches qui se sont mises à
 * t'attendre, fins de run, relectures. null s'il ne s'est rien passé, ou s'il y a moins d'une minute.
 * @param {Instantane} inst @param {number | null} t0 @param {number} maintenant @returns {Ligne | null}
 */
export function depuis(inst, t0, maintenant) {
  if (t0 == null || maintenant - t0 < 60000) return null
  const att = new Set(resumer(inst, maintenant).attention.map(t => t.id))
  /** @type {string[]} */
  const fusions = []
  /** @type {string[]} */
  const attend = []
  /** @type {string[]} */
  const runs = []
  let relectures = 0
  for (const j of inst.journal) {
    if (j.quand == null || j.quand <= t0) continue
    /** @type {RegExpMatchArray | null} */
    let m
    if (j.genre === 'statut' && (m = j.texte.match(/^(\S+) : (fusionnée|besoin-humain|bloquée|échec)/))) {
      if (m[2] === 'fusionnée') fusions.push(/** @type {string} */ (m[1]))
      else if (att.has(/** @type {string} */ (m[1])) && !attend.includes(/** @type {string} */ (m[1]))) attend.push(/** @type {string} */ (m[1]))
    }
    if ((j.genre === 'run' || j.genre === 'erreur') && (m = j.texte.match(/^run (\d+) : (terminé|arbitrage|partiel|à-relancer|erreur)/))) runs.push(`run ${m[1]} ${m[2]}`)
    if (j.genre === 'relecture') relectures++
  }
  /** @type {Ligne[]} */
  const parts = []
  if (fusions.length) parts.push([{ t: `✓ ${fusions.slice(0, 6).join(' ')}${fusions.length > 6 ? '…' : ''} ${fusions.length > 1 ? 'fusionnées' : 'fusionnée'}`, c: 'success' }])
  if (attend.length) parts.push([{ t: `⚠ ${attend.slice(0, 4).join(' ')} ${attend.length > 1 ? "t'attendent" : "t'attend"}`, c: 'warning', b: true }])
  if (relectures) parts.push([{ t: `⚑ ${pluriel(relectures, 'relecture')}`, c: 'warning' }])
  if (runs.length) parts.push([{ t: /** @type {string} */ (runs.at(-1)) }])
  if (!parts.length) return null
  return [{ t: '↩ ', c: 'claude', b: true }, { t: `Depuis ${duree(maintenant - t0)}`, b: true }, { t: ' : ' }, ...joindre(parts, ' · ')]
}

/**
 * Le panneau entier : un en-tête (état global, légende, légende de la démo, ce qui a changé depuis le dernier passage),
 * puis les cartes. Sous COLONNES_BORDS colonnes, les cartes perdent leur bord.
 * @param {Instantane} inst @param {number} maintenant @param {number} colonnes
 * @param {{ anime?: boolean, journalComplet?: boolean, depuis?: number | null }} [options]
 * @returns {{ entete: Ligne[], cartes: Carte[], bords: boolean }}
 */
export function panneau(inst, maintenant, colonnes, { anime = false, journalComplet = false, depuis: t0 = null } = {}) {
  const s = resumer(inst, maintenant), r = inst.run
  const toi = carteAToi(inst, maintenant, colonnes)
  /** @type {Morceau} */
  const etat = !r ? { t: 'AUCUN RUN', d: true }
    : s.termine && r.statut !== 'en-cours' ? { t: 'PLAN TERMINÉ', c: 'success', b: true }
    : s.silence ? { t: `RUN ${r.numero} SANS NOUVELLES`, c: 'warning', b: true }
    : { t: `RUN ${r.numero} ${r.statut === 'en-cours' ? 'EN COURS' : r.statut.toUpperCase()}`, c: r.statut === 'en-cours' ? 'claude' : r.statut === 'terminé' ? 'success' : r.statut === 'erreur' ? 'error' : 'warning', b: true }
  /** @type {Morceau | null} */
  const fin = toi && toi.urgent ? { t: ` ⚠ ${toi.urgent} À TOI `, c: 'inverseText', f: 'warning', b: true }
    : s.relectures ? { t: `⚑ ${s.relectures} À RELIRE`, c: 'warning', b: true }
    : s.enCours.length ? { t: `◐ ${s.enCours.length} EN COURS`, c: 'suggestion' } : null
  /** @type {Ligne[]} */
  const entete = [
    [...(inst.demo ? [{ t: ' DÉMO ', c: 'inverseText', f: 'merged', b: true }, { t: ' ' }] : []), { t: 'ORCHESTRE', c: 'claude', b: true }, { t: ' · ', d: true }, { t: court(inst.plan.toUpperCase(), 30), b: true }, { t: ' · ', d: true }, etat, ...(fin ? [{ t: ' · ', d: true }, fin] : [])],
    [{ t: '■', c: 'success' }, { t: ' fusionnée  ', d: true }, { t: '■', c: 'suggestion' }, { t: ' en cours  ', d: true }, { t: '■', c: 'warning' }, { t: ' attend  ', d: true }, { t: '■', c: 'error' }, { t: ' bloquée  ', d: true }, { t: '░', c: 'subtle' }, { t: ' à faire', d: true }],
  ]
  // La légende de la démo : le pas, puis ce qu'il y a à essayer
  if (inst.legende) for (const [i, ligne] of inst.legende.split('\n').entries()) entete.push([{ t: court(ligne, Math.max(20, colonnes - 2)), c: 'merged', b: i === 0 }])
  const absent = depuis(inst, t0, maintenant)
  if (absent) entete.push(absent)
  /** @type {Carte[]} */
  const cartes = []
  if (toi) cartes.push(toi)
  cartes.push(carteRun(inst, maintenant, colonnes, anime))
  cartes.push({ id: 'taches', couleur: null, titre: [{ t: 'tâches', b: true }, { t: ` · ${s.enCours.length} en cours · ${s.total} au total`, d: true }], meta: [], lignes: lignesTaches(inst, maintenant, colonnes, anime) })
  cartes.push(carteJournal(inst, maintenant, colonnes, journalComplet))
  return { entete, cartes, bords: colonnes >= COLONNES_BORDS }
}

/** La ligne d'état quand le bandeau est masqué et qu'il reste quelque chose à faire : « orchestre ✓ 5/5 · ⚑ 3 ». @param {Instantane} inst @param {number} maintenant */
export function ligneEtat(inst, maintenant) {
  const s = resumer(inst, maintenant)
  if (s.termine && !s.relectures && !s.attention.length) return null
  return `orchestre ${s.termine ? '✓' : '■'} ${s.faites}/${s.total}${s.relectures ? ` · ⚑ ${s.relectures}` : ''}${s.attention.length ? ` · ⚠ ${s.attention.length}` : ''}`
}

/** Une ligne en texte brut. @param {Ligne} l */
export const brut = l => l.map(m => m.t).join('').replace(/\s+$/, '')

/** L'état en texte, là où rien ne se dessine (`/suivi texte`, panneau refusé) : le bandeau, puis les cartes. @param {Instantane} inst @param {number} maintenant */
export function texteEtat(inst, maintenant) {
  const b = bandeau(inst, maintenant, 120)
  const out = [b ? brut(b) : `${inst.plan} : aucun run noté dans suivi.json`]
  for (const c of panneau(inst, maintenant, 104).cartes) {
    out.push('', brut([...c.titre, ...(c.meta.length ? [{ t: '   ' }, ...c.meta] : [])]))
    for (const l of c.lignes) out.push(brut(l))
  }
  return out.join('\n')
}

/** Brouillon de description de PR, mis dans le prompt, jamais envoyé. @param {Instantane} inst @param {number} maintenant */
export function textePR(inst, maintenant) {
  const s = resumer(inst, maintenant)
  const l = [`Plan ${inst.plan} : ${s.faites}/${s.total} tâches fusionnées, ${pluriel(inst.runs.length, 'run')}.`, '']
  if (inst.relectures.length) {
    l.push('À relire avant de fusionner (fichiers et commandes interdits aux agents) :')
    for (const r of inst.relectures) l.push(`- ${r.tache ?? 'plan source'} : ${r.texte}`)
    l.push('')
  }
  if (inst.decisions.length) {
    l.push('Décisions prises d\'office (mode autonome) :')
    for (const d of inst.decisions) l.push(`- ${d.tache}, ${d.titre} : option ${d.option}, ${d.description}`)
    l.push('')
  }
  if (s.attention.length) l.push(`Encore en attente : ${s.attention.map(t => `${t.id} (${ATTENTION[/** @type {keyof typeof ATTENTION} */ (t.statut)]})`).join(', ')}.`, '')
  if (inst.tickets) l.push(`${pluriel(inst.tickets, 'ticket')} à ouvrir après la PR (HANDOFF.md, entrées « ticket »).`)
  return l.join('\n').replace(/\n+$/, '\n')
}

/** Une notification qui demande quelqu'un : tâche qui attend un humain, bloquée ou en échec, run arrêté ou en erreur. @param {string} m */
export const importante = m => / attend un humain$|^✗ |^Run arrêté|\) : erreur/.test(m)

/**
 * Ce qui mérite une notification entre deux lectures : run lancé ou fini, phase finie, tâche qui attend un humain,
 * bloquée ou en échec, nouvelle relecture, point d'arrêt. Rien à la première lecture.
 * @param {Instantane | null} avant @param {Instantane} apres @returns {string[]}
 */
export function changements(avant, apres) {
  if (!avant || avant.plan !== apres.plan) return []
  /** @type {string[]} */
  const m = []
  const ra = avant.run, rb = apres.run
  if (rb && (!ra || rb.numero !== ra.numero)) m.push(`Run ${rb.numero} lancé : phase ${rb.phase}, mode ${rb.mode}`)
  if (rb && ra && rb.numero === ra.numero && ra.statut === 'en-cours' && rb.statut !== 'en-cours') m.push(`Run ${rb.numero} (${libellePhases(rb.phase, phaseDuRun(apres) ?? rb.phase)}) : ${rb.statut}${rb.detail ? `, ${court(rb.detail, 80)}` : ''}`)
  const av = new Map(avant.taches.map(t => [t.id, t]))
  for (const t of apres.taches) {
    const a = av.get(t.id)
    if (a && a.statut !== t.statut && t.statut in ATTENTION) m.push(`${t.statut === 'besoin-humain' ? '⚑' : '✗'} ${t.id} ${ATTENTION[/** @type {keyof typeof ATTENTION} */ (t.statut)]}`)
  }
  const fini = /** @param {Instantane} i @param {number} n */ (i, n) => { const ts = i.taches.filter(t => t.phase === n && t.statut !== 'annulée'); return ts.length > 0 && ts.every(fait) }
  for (const n of [...new Set(apres.taches.map(t => t.phase))]) if (fini(apres, n) && !fini(avant, n)) m.push(`Phase ${n} terminée`)
  // Une notification par tâche, quel que soit le nombre de relectures qu'une clôture apporte
  const nouvelles = /** @type {Map<string, number>} */ (new Map())
  for (const r of apres.relectures.slice(avant.relectures.length)) nouvelles.set(r.tache ?? 'plan source', (nouvelles.get(r.tache ?? 'plan source') || 0) + 1)
  for (const [qui, k] of nouvelles) m.push(`⚑ ${qui} : ${k > 1 ? `${k} relectures` : 'à relire'} avant la PR`)
  // Un point devient point d'arrêt à la fin du run (le scribe l'a noté « a-trancher ») : le rôle fait partie de la clé
  const cle = /** @param {{ tache: string, titre: string, role: string }} p */ p => `${p.tache}\u0000${p.titre}\u0000${p.role}`
  const vus = new Set(avant.points.map(cle))
  for (const p of apres.points) if (p.role === 'arret' && !vus.has(cle(p))) m.push(`Run arrêté : ${p.tache}, ${court(p.titre, 80)}`)
  return m
}
