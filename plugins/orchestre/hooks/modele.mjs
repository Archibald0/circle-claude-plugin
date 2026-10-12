// @ts-check
// Modèle du mod de suivi d'orchestre : lit plans/<nom>/suivi.json (contrat orchestre-suivi/2, ou /1 d'avant la 0.11.0, écrit par
// scripts/suivi.mjs du plugin orchestre) et en tire ce que le mod affiche. Fonctions pures, sans `$` :
// register.tsx s'occupe du moteur (fichiers, minuteur, dessin), tests/modele.test.mjs les vérifie sous Node.

/** @typedef {import('../types/index.d.ts').Snapshot} Snapshot */
/** @typedef {import('../types/index.d.ts').TaskView} TaskView */
/** @typedef {import('../types/index.d.ts').PhaseView} PhaseView */
/** @typedef {import('../types/index.d.ts').RunView} RunView */
/** @typedef {import('../types/index.d.ts').Piece} Piece */
/** @typedef {import('../types/index.d.ts').Line} Line */
/** @typedef {import('../types/index.d.ts').Card} Card */

export const FORMAT = 'orchestre-suivi/2'
// Les formats que ce mod lit : /1 (0.10 et avant, sans modèle utilisé) et /2 (0.11.0)
export const FORMATS = ['orchestre-suivi/1', FORMAT]
export const STATUSES = ['à-faire', 'ajoutée', 'fusionnée', 'bloquée', 'échec', 'besoin-humain', 'annulée']
const ATTENTION = { 'besoin-humain': 'attend un humain', bloquée: 'bloquée', échec: 'en échec' }
// Tout le journal de suivi.json (200 entrées au plus) : la frise des étapes du run en a besoin
const LOG_READ = 200
// Un run noté « en-cours » sans écriture depuis 45 min est montré « sans nouvelles » : interrompu (Échap, session tuée),
// il reste « en-cours » jusqu'au debut-run suivant. Une étape seule (un worker) peut durer ; au-delà, mieux vaut le dire.
export const SILENCE_MS = 45 * 60000
// Durée d'une notification qui demande quelqu'un (4 s par défaut pour les autres)
export const IMPORTANT_TOAST_MS = 15000

/** @param {unknown} x @returns {x is Record<string, any>} */
const isObject = x => typeof x === 'object' && x !== null && !Array.isArray(x)
/** @param {unknown} x */
const text = x => (typeof x === 'string' ? x : x == null ? '' : String(x))
/** @param {unknown} x @returns {string[]} */
const texts = x => (Array.isArray(x) ? x.map(text) : [])
/** @param {unknown} x @returns {number | null} */
const date = x => { if (typeof x !== 'string') return null; const t = Date.parse(x); return Number.isNaN(t) ? null : t }
/** @param {unknown} x @param {number} d */
const integer = (x, d) => (Number.isInteger(x) ? /** @type {number} */ (x) : d)

/** Format déclaré par un suivi.json, ou null. @param {unknown} raw */
export const formatOf = raw => (isObject(raw) && typeof raw.format === 'string' ? raw.format : null)

/**
 * suivi.json (orchestre-suivi/1 ou /2) → ce que le mod affiche ; null si le format n'est pas l'un d'eux.
 * Les champs inconnus sont ignorés, les champs manquants pris vides : un lecteur ne refuse que le format.
 * @param {unknown} raw @returns {Snapshot | null}
 */
export function normalize(raw) {
  if (!isObject(raw) || !FORMATS.includes(/** @type {string} */ (raw.format)) || !Array.isArray(raw.taches)) return null
  const runs = (Array.isArray(raw.runs) ? raw.runs : []).filter(isObject)
  const lastRun = runs.length ? runs[runs.length - 1] : null
  /** @type {TaskView[]} */
  const tasks = raw.taches.filter(isObject).map(t => ({
    id: text(t.id), title: text(t.titre) || text(t.id), phase: integer(t.phase, 1),
    status: STATUSES.includes(t.statut) ? t.statut : 'à-faire', attempts: integer(t.essais, 0),
    step: typeof t.etape === 'string' ? t.etape : null, isolated: t.isole === true,
    start: date(t.debut), end: date(t.fin), waiting: texts(t.attend), blocker: texts(t.blocage),
    // Modèle prévu par le plan et dernier modèle lancé (0.11.0) ; un /1 n'a que le prévu
    model: typeof t.modele === 'string' && t.modele ? t.modele : null, modelUsed: typeof t.modele_utilise === 'string' && t.modele_utilise ? t.modele_utilise : null,
  }))
  const majorCounts = /** @type {Record<string, number>} */ ({})
  let tickets = 0
  if (isObject(raw.handoff)) for (const section of Object.values(raw.handoff)) if (isObject(section)) for (const [type, c] of Object.entries(section)) {
    if (!isObject(c)) continue
    if (type === 'ticket') tickets += integer(c.mineur, 0) + integer(c.majeur, 0)
    const n = integer(c.majeur, 0)
    if (n > 0) majorCounts[type] = (majorCounts[type] || 0) + n
  }
  return {
    demo: false, legend: null, plan: text(raw.plan), dir: text(raw.dossier), updated: date(raw.maj),
    tasks,
    runs: runs.map(runView),
    run: lastRun ? runView(lastRun) : null,
    reviews: (Array.isArray(raw.relectures) ? raw.relectures : []).filter(isObject).map(r => ({ task: r.tache == null ? null : text(r.tache), phase: Number.isInteger(r.phase) ? r.phase : null, text: text(r.texte), at: date(r.quand) })),
    decisions: (Array.isArray(raw.decisions_office) ? raw.decisions_office : []).filter(isObject).map(d => ({ task: text(d.tache), title: text(d.titre), option: text(d.option), description: text(d.description) })),
    issues: (Array.isArray(raw.points) ? raw.points : []).filter(p => isObject(p) && p.statut !== 'tranché').map(p => ({ task: text(p.tache), title: text(p.titre), human: p.humain === true, role: text(p.role) })),
    prerequisites: (Array.isArray(raw.prerequis) ? raw.prerequis : []).filter(p => isObject(p) && p.statut === 'ouvert').map(p => ({ id: text(p.id), type: text(p.type), blocks: texts(p.bloque) })),
    majorCounts, tickets,
    lint: { ok: !isObject(raw.lint) || raw.lint.ok !== false, errors: isObject(raw.lint) ? texts(raw.lint.erreurs).length : 0 },
    log: (Array.isArray(raw.journal) ? raw.journal : []).filter(isObject).slice(-LOG_READ).map(j => ({ at: date(j.quand), kind: text(j.genre), task: j.tache == null ? null : text(j.tache), text: text(j.texte) })),
  }
}

/** @param {Record<string, unknown>} r @returns {RunView} */
const runView = r => ({
  number: integer(r.numero, 0), phase: integer(r.phase, 0), mode: text(r.mode), parallelism: integer(r.parallelisme, 0), status: text(r.statut), start: date(r.debut), end: date(r.fin), detail: r.detail == null ? null : text(r.detail),
  ruledTasks: (Array.isArray(r.arbitrages_appliques) ? r.arbitrages_appliques : []).filter(isObject).map(a => text(a.tache)).filter(Boolean),
})

const isMerged = /** @param {TaskView} t */ t => t.status === 'fusionnée'
/** Le run noté en cours, s'il y en a un. @param {Snapshot} inst */
export const runInProgress = inst => (inst.run && inst.run.status === 'en-cours' ? inst.run : null)
/** Un run en cours sans écriture de suivi.json depuis SILENCE_MS. @param {Snapshot} inst @param {number} now */
export const silent = (inst, now) => !!runInProgress(inst) && inst.updated != null && now - inst.updated >= SILENCE_MS
/** Le run en cours qui donne des nouvelles. @param {Snapshot} inst @param {number} now */
export const activeRun = (inst, now) => (silent(inst, now) ? null : runInProgress(inst))
/** Une tâche en cours : une étape notée pendant un run actif. @param {Snapshot} inst @param {number} now */
export const inProgress = (inst, now) => (activeRun(inst, now) ? inst.tasks.filter(t => t.step && !isMerged(t)) : [])
/** Le point de la tâche vient d'être tranché par le run en cours, qui va la relancer. @param {Snapshot} inst @param {TaskView} t */
const ruled = (inst, t) => { const r = runInProgress(inst); return !!r && r.ruledTasks.includes(t.id) }
/**
 * Ce qui attend quelqu'un : une tâche qui a besoin d'un humain, bloquée ou en échec, sauf si le run en cours l'a reprise
 * (une étape notée pendant un run actif) ou vient d'en trancher le point. @param {Snapshot} inst @param {number} now
 */
export const needsSomeone = (inst, now) => { const live = !!activeRun(inst, now); return /** @param {TaskView} t */ t => t.status in ATTENTION && !(live && t.step) && !ruled(inst, t) }
/**
 * La phase où en est le dernier run : la plus haute des tâches qu'il a démarrées ou closes, au moins celle de son départ.
 * Un run en mode auto passe d'une phase à l'autre, et run.phase reste celle du départ. @param {Snapshot} inst
 */
export function runPhase(inst) {
  const r = inst.run
  if (!r) return null
  const d = r.start
  const touched = d == null ? [] : inst.tasks.filter(t => t.status !== 'annulée' && ((t.start != null && t.start >= d) || (t.end != null && t.end >= d)))
  return Math.max(r.phase, ...touched.map(t => t.phase))
}

/**
 * Les chiffres du bandeau et des en-têtes. @param {Snapshot} inst @param {number} now ms
 */
export function summarize(inst, now) {
  const activeTasks = inst.tasks.filter(t => t.status !== 'annulée')
  const done = activeTasks.filter(isMerged).length
  const phases = phasesOf(inst, now)
  const current = phases.find(p => p.done < p.total) ?? null
  const run = activeRun(inst, now)
  const attention = activeTasks.filter(needsSomeone(inst, now))
  return {
    total: activeTasks.length, done, inProgress: inProgress(inst, now), todo: activeTasks.filter(t => !isMerged(t)).length, silent: silent(inst, now),
    phases, current, maxPhase: phases.at(-1)?.number ?? 0,
    reviews: inst.reviews.length, attention, run,
    duration: inst.run && inst.run.start != null ? (inst.run.end ?? (runInProgress(inst) ? (run ? now : inst.updated ?? inst.run.start) : inst.run.start)) - inst.run.start : null,
    allMerged: activeTasks.length > 0 && done === activeTasks.length,
  }
}

/** @param {Snapshot} inst @param {number} now @returns {PhaseView[]} */
export function phasesOf(inst, now) {
  // Une phase dont toutes les tâches sont annulées n'est plus une phase du plan, comme pour /orchestre:etat
  const nums = [...new Set(inst.tasks.filter(t => t.status !== 'annulée').map(t => t.phase))].sort((a, b) => a - b)
  const waiting = needsSomeone(inst, now)
  return nums.map(number => {
    const ts = inst.tasks.filter(t => t.phase === number && t.status !== 'annulée')
    // Dans chaque run, du premier démarrage au dernier achèvement des tâches de la phase : un run en mode auto en parcourt
    // plusieurs, et l'attente entre deux runs ne compte pas
    let duration = /** @type {number | null} */ (null)
    for (const r of inst.runs) {
      if (r.start == null) continue
      const d = r.start, f = r.end ?? (r.status === 'en-cours' ? now : d)
      const within = /** @param {number | null} x */ x => x != null && x >= d && x <= f
      const seenTasks = ts.filter(t => within(t.start) || within(t.end))
      if (!seenTasks.length) continue
      const a = Math.min(...seenTasks.map(t => (within(t.start) ? /** @type {number} */ (t.start) : d)))
      const b = Math.max(...seenTasks.map(t => (within(t.end) ? /** @type {number} */ (t.end) : f)))
      duration = (duration ?? 0) + Math.max(0, b - a)
    }
    return {
      number, total: ts.length, done: ts.filter(isMerged).length,
      inProgress: ts.filter(t => t.step && !isMerged(t) && activeRun(inst, now)).length,
      attention: ts.filter(waiting).length,
      attempts: ts.reduce((s, t) => s + Math.max(t.attempts, isMerged(t) ? 1 : 0), 0),
      retries: ts.filter(t => t.attempts > 1).map(t => ({ id: t.id, attempts: t.attempts })),
      duration,
    }
  })
}

// ─── Mise en forme ───────────────────────────────────────────────────────────────────────────────────────────────

/** Durée lisible : « 45 s », « 18 min », « 1 h 12 ». @param {number | null} ms */
export function duration(ms) {
  if (ms == null || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}
/** Âge court d'un événement : « 45 s », « 18 min », « 1 h 12 », « 3 j » (pas d'heure : le fuseau du mod n'est pas sûr). @param {number | null} ms @param {number} now */
export function age(ms, now) {
  if (ms == null) return '—'
  const s = Math.max(0, now - ms)
  return s >= 86400000 ? `${Math.floor(s / 86400000)} j` : duration(s)
}
/** @param {number} done @param {number} total @param {number} width */
export function bar(done, total, width) {
  const k = total > 0 ? Math.floor((done / total) * width) : 0
  return '█'.repeat(k) + '░'.repeat(Math.max(0, width - k))
}
/** Coupe à n caractères visibles, avec « … ». @param {string} s @param {number} n */
export function cut(s, n) {
  const c = [...String(s).replace(/\s+/g, ' ').trim()]
  return c.length > n ? c.slice(0, Math.max(0, n - 1)).join('') + '…' : c.join('')
}
/** Complète à n caractères (après coupe). @param {string} s @param {number} n */
export const column = (s, n) => { const c = cut(s, n); return c + ' '.repeat(Math.max(0, n - [...c].length)) }
/** @param {number} n @param {string} word */
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`
/** « phase 2 », ou « phases 1 à 3 » pour un run qui en a parcouru plusieurs. @param {number} de @param {number} a */
const phasesLabel = (de, a) => (a > de ? `phases ${de} à ${a}` : `phase ${de}`)

// ─── Couleurs et mouvement ───────────────────────────────────────────────────────────────────────────────────────
// Les images des animations se déduisent de l'heure : rien à garder d'un dessin à l'autre. register.tsx redessine
// toutes les IMAGE_MS pendant un run actif, et tant qu'un événement a moins de NOUVELLE_MS.
export const IMAGE_MS = 150
export const NEWS_MS = 10000
const WHEEL = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏', SPIN = '◐◓◑◒'
/** @param {number} m */ export const wheel = m => /** @type {string} */ (WHEEL[Math.floor(m / 100) % WHEEL.length])
/** @param {number} m */ export const spin = m => /** @type {string} */ (SPIN[Math.floor(m / IMAGE_MS) % SPIN.length])
/** @param {number} m */ const pulse = m => Math.floor(m / 450) % 2 === 1
// Une couleur par étape, du thème de la personne
const STEP_COLOR = /** @type {Record<string, string>} */ ({ worker: 'suggestion', vérification: 'merged', évaluation: 'planMode', correction: 'warning', fusion: 'success', replanification: 'subtle', suivi: 'subtle' })
// Classes d'une tâche, dans l'ordre de la barre : fusionnée, en cours, attend un humain, bloquée ou en échec, le reste
const CLASSES = /** @type {const} */ ([
  { c: 'success', g: '█' }, { c: 'suggestion', g: '█' }, { c: 'warning', g: '█' }, { c: 'error', g: '█' }, { c: 'subtle', g: '░' },
])
/** @param {Snapshot} inst @param {number} now @returns {(t: TaskView) => number} */
function classifier(inst, now) {
  const live = !!activeRun(inst, now), waiting = needsSomeone(inst, now)
  return t => (isMerged(t) ? 0 : live && t.step ? 1 : waiting(t) ? (t.status === 'besoin-humain' ? 2 : 3) : 4)
}

/**
 * Barre empilée par classe de tâche : une ou plusieurs cases par tâche quand elles tiennent, sinon en proportion,
 * chaque classe présente gardant au moins une case. Les tâches en cours pulsent quand `anime`.
 * @param {TaskView[]} ts @param {(t: TaskView) => number} classOf @param {number} squares @param {number} now @param {boolean} animated @returns {Line}
 */
export function classBar(ts, classOf, squares, now, animated) {
  if (!ts.length || squares <= 0) return squares > 0 ? [{ t: '░'.repeat(squares), c: 'subtle' }] : []
  const n = [0, 0, 0, 0, 0]
  for (const t of ts) { const i = classOf(t); n[i] = (n[i] ?? 0) + 1 }
  let k
  if (ts.length <= squares) {
    const per = Math.floor(squares / ts.length)
    k = n.map(x => x * per)
  } else {
    k = n.map(x => (x ? Math.max(1, Math.floor((x / ts.length) * squares)) : 0))
    // Ajuste à `cases` : on prend sur la plus grosse classe, ou on lui rend
    let gap = squares - k.reduce((a, b) => a + b, 0)
    while (gap !== 0) {
      const i = k.indexOf(Math.max(...k))
      if (gap < 0 && /** @type {number} */ (k[i]) <= 1) break
      k[i] = /** @type {number} */ (k[i]) + Math.sign(gap)
      gap -= Math.sign(gap)
    }
  }
  /** @type {Line} */
  const l = []
  k.forEach((x, i) => {
    if (!x) return
    const cl = /** @type {typeof CLASSES[number]} */ (CLASSES[i])
    l.push({ t: (i === 1 && animated && pulse(now) ? '▓' : cl.g).repeat(x), c: cl.c })
  })
  return l
}

/** Une case par tâche (■), colorée par classe, dans l'ordre du plan. @param {TaskView[]} ts @param {(t: TaskView) => number} classOf @returns {Line} */
function squares(ts, classOf) {
  /** @type {Line} */
  const l = []
  for (const t of ts) {
    const c = /** @type {typeof CLASSES[number]} */ (CLASSES[classOf(t)]).c
    const der = l[l.length - 1]
    if (der && der.c === c) der.t += '■'
    else l.push({ t: '■', c })
  }
  return l
}

/** Les phases en points : ● faite, ◉ celle du run, ○ ambre une qui attend, ○ à venir ; null au-delà de 10 phases. @param {PhaseView[]} phases @param {number | null} current @returns {Line | null} */
export function phaseDots(phases, current) {
  if (!phases.length || phases.length > 10) return null
  return phases.map(p => (p.total && p.done === p.total ? { t: '●', c: 'success' } : p.number === current ? { t: '◉', c: 'claude', b: true } : p.attention ? { t: '○', c: 'warning', b: true } : { t: '○', c: 'subtle' }))
}

const KINDS = /** @type {Record<string, Piece>} */ ({
  run: { t: '▶', c: 'claude' }, tache: { t: '▶', c: 'suggestion' }, etape: { t: '·', d: true }, refus: { t: '↻', c: 'merged' },
  statut: { t: '●', c: 'success' }, ajout: { t: '+', c: 'suggestion' }, amendement: { t: '~', c: 'merged' }, relecture: { t: '⚑', c: 'warning' },
  'decision-office': { t: '⇒', c: 'warning' }, point: { t: '?', c: 'warning' }, arbitrage: { t: '✓', c: 'success' }, pilote: { t: '✎', c: 'suggestion' }, erreur: { t: '✗', c: 'error' },
  modele: { t: '⇄', c: 'merged' },
})
/** Glyphe et couleur d'une entrée du journal, d'après son genre et ce qu'elle dit. @param {{ kind: string, text: string }} j @returns {Piece} */
function mark(j) {
  if (j.kind === 'statut') return / fusionnée/.test(j.text) ? { t: '✓', c: 'success' } : / besoin-humain/.test(j.text) ? { t: '⚑', c: 'warning' } : / (bloquée|échec)/.test(j.text) ? { t: '✗', c: 'error' } : { t: '●', c: 'subtle' }
  if (j.kind === 'run') return / : terminé/.test(j.text) ? { t: '✓', c: 'success' } : / : (arbitrage|partiel|à-relancer)| interrompu/.test(j.text) ? { t: '■', c: 'warning' } : { t: '▶', c: 'claude' }
  return KINDS[j.kind] || { t: '·', d: true }
}
// Ce qui fait une nouvelle au bout du bandeau, du plus important au moins important ; pas les étapes ni les démarrages,
// que le bandeau montre déjà. Une écriture de suivi.json en note souvent plusieurs, à la même seconde : la plus
// importante l'emporte, et la plus récente à importance égale.
const NOTABLE_KINDS = ['statut', 'run', 'erreur', 'arbitrage', 'point', 'refus', 'decision-office', 'relecture', 'pilote', 'ajout']
/** La nouvelle en peu de mots, d'après le texte que suivi.mjs écrit au journal. @param {{ kind: string, text: string }} j */
function brief(j) {
  const t = j.text
  /** @type {RegExpMatchArray | null} */
  let m
  if (j.kind === 'run' && (m = t.match(/^run (\d+) : phase (\d+), mode (\S+?),/))) return `run ${m[1]} lancé (phase ${m[2]}, mode ${m[3]})`
  if (j.kind === 'statut' && (m = t.match(/^(\S+) : (fusionnée|besoin-humain|bloquée|échec) \((\d+) essai/))) {
    const [, id, st, n] = m
    return st === 'fusionnée' ? `${id} fusionnée${Number(n) > 1 ? ` au ${n}e essai` : ''}` : `${id} ${/** @type {Record<string, string>} */ (ATTENTION)[/** @type {string} */ (st)]}`
  }
  if (j.kind === 'refus' && (m = t.match(/^(\S+) : essai (\d+) refusé \(([^)]+)\)/))) return `${m[1]} : essai ${m[2]} refusé (${m[3]})`
  if (j.kind === 'relecture' && (m = t.match(/^(\S+) : relecture/))) return `${m[1]} : à relire avant la PR`
  if (j.kind === 'decision-office' && (m = t.match(/^(\S+) :/))) return `${m[1]} : décision prise d'office`
  if (j.kind === 'arbitrage' && (m = t.match(/^(\S+) : .* tranché, option (\S+)/))) return `${m[1]} : point tranché (option ${m[2]})`
  return t
}
/**
 * La dernière nouvelle de moins de NOUVELLE_MS : une tâche close, un run lancé ou fini, un arbitrage, un refus…
 * @param {Snapshot} inst @param {number} now @returns {{ mark: Piece, text: string, age: number, kind: string } | null}
 */
export function news(inst, now) {
  const recent = inst.log.filter(j => j.at != null && now - j.at <= NEWS_MS && NOTABLE_KINDS.includes(j.kind))
  if (!recent.length) return null
  const at = Math.max(...recent.map(j => /** @type {number} */ (j.at)))
  const j = recent.filter(x => x.at === at).reverse().sort((x, y) => NOTABLE_KINDS.indexOf(x.kind) - NOTABLE_KINDS.indexOf(y.kind))[0]
  if (!j) return null
  return { mark: mark(j), text: brief(j), age: Math.max(0, now - at), kind: j.kind }
}

/** Glyphe et couleur d'une tâche ; une tâche en cours tourne quand `anime`. @param {TaskView} t @param {boolean} active @param {number} [now] @param {boolean} [animated] @returns {Piece} */
export function glyph(t, active, now = 0, animated = false) {
  if (t.status === 'fusionnée') return { t: '●', c: 'success' }
  if (t.status === 'annulée') return { t: '–', d: true }
  if (active && t.step) return { t: animated ? spin(now) : '◐', c: 'suggestion', b: true }
  if (t.status === 'besoin-humain') return { t: '⚑', c: 'warning', b: true }
  if (t.status === 'bloquée' || t.status === 'échec') return { t: '✗', c: 'error', b: true }
  return { t: '○', c: 'subtle' }
}
const STEPS = /** @type {Record<string, string>} */ ({ worker: 'réalisation', vérification: 'vérification', évaluation: 'évaluation', correction: 'correction', fusion: 'fusion', replanification: 'replanification', suivi: 'suivi' })
// La case de l'étape au bandeau : « vérification +9 » (« replanification », rare, la dépasse)
const STEP_WIDTH = 15

/** Ce que fait une tâche, en quelques mots. @param {TaskView} t @param {boolean} active @param {boolean} [settled] */
export function what(t, active, settled = false) {
  if (active && t.step) return (STEPS[t.step] || t.step) + (t.attempts > 1 ? `, essai ${t.attempts}` : '') + (t.isolated ? ' (worktree)' : '')
  if (t.status in ATTENTION && settled) return 'point tranché, reprise à venir'
  if (t.status in ATTENTION) return /** @type {Record<string, string>} */ (ATTENTION)[t.status] + (t.blocker[0] ? ` : ${t.blocker[0]}` : '')
  if (t.status === 'fusionnée') return t.attempts > 1 ? `${t.attempts} essais` : ''
  return t.waiting.length ? `attend ${t.waiting.slice(0, 4).join(', ')}${t.waiting.length > 4 ? '…' : ''}` : ''
}
/** La même chose en couleurs : l'étape dans sa couleur, l'essai en ambre, le lieu estompé. @param {TaskView} t @param {boolean} active @param {boolean} settled @param {number} n @returns {Line} */
function whatColored(t, active, settled, n) {
  if (active && t.step) {
    /** @type {Line} */
    const l = [{ t: cut(STEPS[t.step] || t.step, n), c: STEP_COLOR[t.step] || 'subtle', b: true }]
    if (t.attempts > 1) l.push({ t: ` essai ${t.attempts}`, c: 'warning' })
    if (t.isolated) l.push({ t: ' (worktree)', d: true })
    return l
  }
  const q = cut(what(t, active, settled), n)
  if (!q) return []
  return [{ t: q, c: settled ? 'subtle' : t.status === 'besoin-humain' ? 'warning' : t.status in ATTENTION ? 'error' : 'subtle' }]
}

/** Largeur affichée d'une ligne, en cellules (tous ses glyphes en occupent une). @param {Line} l */
export const width = l => l.reduce((n, m) => n + [...m.t].length, 0)

/**
 * Le bandeau au-dessus du prompt : une ligne, ou rien (null) quand aucun run n'est à montrer. Il tient dans `colonnes`
 * moins `reserve` (la place des boutons à sa suite) : on retire la dernière nouvelle, le détail de l'étape,
 * puis on raccourcit les libellés et la barre, puis la durée et le numéro du run, jusqu'à ce qu'il tienne. La forme la
 * plus courte fait une quarantaine de cellules sur un petit plan, une soixantaine au plus sur un gros ; en deçà,
 * l'affichage coupe la fin de la ligne. Avec `anime`, la tête tourne et les tâches en cours pulsent dans la barre.
 * @param {Snapshot} inst @param {number} now @param {number} columns @param {number} [reserve] @param {boolean} [animated] @returns {Line | null}
 */
export function banner(inst, now, columns, reserve = 0, animated = false) {
  if (!inst.run) return null
  const s = summarize(inst, now)
  const place = Math.max(0, columns - reserve)
  /** @type {Line | null} */
  let l = null
  for (const shape of BANNER_SHAPES) {
    l = bannerLine(inst, s, now, shape, animated)
    if (width(l) <= place) return l
  }
  return l
}
// Du plus complet au plus court
const BANNER_SHAPES = [
  { news: true, step: true, labels: true, bar: 14, name: 28, duration: true, run: true },
  { news: false, step: true, labels: true, bar: 12, name: 24, duration: true, run: true },
  { news: false, step: false, labels: true, bar: 10, name: 20, duration: true, run: true },
  { news: false, step: false, labels: false, bar: 8, name: 16, duration: true, run: true },
  { news: false, step: false, labels: false, bar: 4, name: 12, duration: false, run: true },
  { news: false, step: false, labels: false, bar: 0, name: 8, duration: false, run: true },
  { news: false, step: false, labels: false, bar: 0, name: 8, duration: false, run: false },
]
/**
 * @param {Snapshot} inst @param {ReturnType<typeof summarize>} s @param {number} now
 * @param {typeof BANNER_SHAPES[number]} f @param {boolean} animated @returns {Line}
 */
function bannerLine(inst, s, now, f, animated) {
  const run = /** @type {NonNullable<Snapshot['run']>} */ (inst.run)
  const runLive = !!s.run
  const head = s.silent ? { t: '◌ ', c: 'warning' } : runLive ? { t: `${animated ? wheel(now) : '▶'} `, c: 'claude' } : run.status === 'terminé' ? { t: '✓ ', c: 'success' } : { t: '■ ', c: 'warning' }
  const phase = runPhase(inst)
  /** @type {Line} */
  const l = [{ ...head, b: true }, ...(inst.demo ? [{ t: ' DÉMO ', c: 'inverseText', f: 'merged', b: true }, { t: ' ' }] : []), { t: cut(inst.plan, f.name), b: true }, { t: '  ' }]
  const dots = phaseDots(s.phases, phase)
  if (dots) l.push(...dots)
  else l.push({ t: `phase ${phase}/${s.maxPhase}`, d: true })
  if (f.bar) l.push({ t: '  ' }, ...classBar(inst.tasks.filter(t => t.status !== 'annulée'), classifier(inst, now), f.bar, now, animated))
  // Cases de largeur fixe : « 2/5 » prend la place de « 5/5 », l'étape en cours celle de la plus longue ; ce qui suit ne
  // bouge pas quand l'étape change
  l.push({ t: `  ${String(s.done).padStart(String(s.total).length)}/${s.total}`, b: true })
  // Ce qui demande quelqu'un vient juste après l'avancement, avant les tâches en cours dont le texte change de longueur :
  // les mentions ne bougent pas d'une étape à l'autre. Elles se cliquent (a : la carte du panneau ouverte, k : la clé
  // du bouton) ; le glyphe garde la couleur.
  if (s.reviews) l.push({ t: '  ' }, { t: '⚑ ', c: 'warning' }, { t: `${s.reviews}${f.labels ? ' à relire' : ''}`, a: 'toi', k: 'relire' })
  if (s.attention.length) l.push({ t: '  ' }, { t: '⚠ ', c: 'warning', b: true }, { t: `${s.attention.length}${f.labels ? ' à toi' : ''}`, a: 'toi', k: 'toi' })
  const ec = s.inProgress
  if (runLive && f.step) {
    const t = ec[0], id = Math.min(8, Math.max(3, ...inst.tasks.map(x => [...x.id].length)))
    if (t) {
      const step = STEPS[t.step || ''] || String(t.step), plus = ec.length > 1 ? ` +${ec.length - 1}` : ''
      l.push({ t: `  ◐ ${column(t.id, id)} `, c: 'suggestion' }, { t: step, c: STEP_COLOR[t.step || ''] || 'subtle', b: true })
      if (plus) l.push({ t: plus, c: 'suggestion' })
      l.push({ t: ' '.repeat(Math.max(0, STEP_WIDTH - [...step].length - plus.length)) })
    } else l.push({ t: ' '.repeat(5 + id + STEP_WIDTH) })
  } else if (ec.length) l.push({ t: `  ◐ ${ec.length}${f.labels ? ' en cours' : ''}`, c: 'suggestion' })
  if (s.silent) l.push({ t: f.labels ? `  sans nouvelles depuis ${duration(now - /** @type {number} */ (inst.updated))}` : `  ◌ ${duration(now - /** @type {number} */ (inst.updated))}`, c: 'warning' })
  else if (!runLive) l.push({ t: f.run ? `  run ${run.number} ${run.status}` : `  ${run.status}`, c: run.status === 'terminé' ? 'success' : 'warning', b: true })
  if (f.duration) l.push({ t: `  ⏱ ${duration(s.duration)}`, d: true })
  const n = f.news ? news(inst, now) : null
  // La fin du run est déjà dite par son statut, juste avant
  if (n && !(n.kind === 'run' && !runLive)) {
    const fresh = n.age < NEWS_MS / 2
    l.push({ t: '   ' }, { ...n.mark, b: fresh, d: !fresh }, { t: ` ${cut(n.text, 44)}`, c: fresh ? n.mark.c : undefined, b: fresh, d: !fresh })
  }
  return l
}

/** Le suffixe du spinner pendant un run actif : « · T22 vérification · 3 tâches en cours… ». @param {Snapshot} inst @param {number} now */
export function suffix(inst, now) {
  const ts = inProgress(inst, now), t = ts[0]
  if (!t) return null
  return ` · ${t.id} ${STEPS[t.step || ''] || t.step} · ${plural(ts.length, 'tâche')} en cours…`
}

// ─── Le panneau : une vue en cartes ──────────────────────────────────────────────────────────────────────────────
// Dans l'ordre : ce qui t'attend (s'il y a quelque chose), le run, les tâches en frise, le journal. Dans le panneau, t, r,
// b et j font défiler jusqu'à une carte ; 1 à 9 agissent sur les lignes de « À toi », l et p sur la suite d'un run fini.
// Une action ne fait que préparer un texte dans le prompt : rien n'est envoyé sans la personne.

const MODES = /** @type {Record<string, string>} */ ({ auto: 'autonome', devia: 'arrêt sur déviation', phase: 'arrêt par phase' })
const SHORT_STEP = /** @type {Record<string, string>} */ ({ worker: 'réal', vérification: 'vérif', évaluation: 'éval', correction: 'corr', fusion: 'fusion', replanification: 'replan', suivi: 'suivi' })
const STEP_ORDER = ['worker', 'vérification', 'évaluation', 'correction', 'fusion', 'replanification', 'suivi']
// Ce que suivi.mjs écrit au journal à chaque étape : « T01 démarre (worktree) » pour la réalisation (genre tache),
// « T01 : vérification », « T01 : correction (essai 2) » pour les suivantes (genre etape)
const RE_STEP = /^(\S+) : (vérification|évaluation|correction|fusion|replanification|suivi)(?: \(|$)/
const RE_STARTS = /^(\S+) démarre \(/
export const SHORT_LOG = 6
const LONG_LOG = 60
// Le panneau perd ses bords en deçà
const BORDER_COLUMNS = 60

/** Chrono : « 0:42 », « 12:05 », « 1:02:03 ». @param {number | null} ms */
export function chrono(ms) {
  if (ms == null || ms < 0) return '—'
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}
/** Le dossier du plan, pour les commandes proposées. @param {Snapshot} inst */
const dirOf = inst => inst.dir || `plans/${inst.plan}`
/** @param {Line[]} parts @param {string} sep @returns {Line} */
const joinParts = (parts, sep) => parts.flatMap((p, i) => (i ? [{ t: sep, d: true }, ...p] : p))

/** Le temps du dernier run : de son début à sa fin, ou à maintenant pendant un run actif. @param {Snapshot} inst @param {number} now */
function runWindow(inst, now) {
  const r = inst.run
  if (!r || r.start == null) return null
  const endMark = r.end ?? (activeRun(inst, now) ? now : Math.max(r.start, inst.updated ?? r.start))
  return { start: r.start, end: Math.max(endMark, r.start + 1000) }
}
/** Le run où une tâche a été close. @param {Snapshot} inst @param {TaskView} t */
const runOf = (inst, t) => (t.end == null ? null : inst.runs.find(r => r.start != null && /** @type {number} */ (t.end) >= r.start && (r.end == null || /** @type {number} */ (t.end) <= r.end)) ?? null)

/**
 * Les étapes d'une tâche pendant le dernier run, datées par le journal : chacune court jusqu'à la suivante, la dernière
 * jusqu'à la clôture de la tâche, ou jusqu'à maintenant si elle tourne encore.
 * @param {Snapshot} inst @param {TaskView} t @param {number} now @returns {[number, number, string][]}
 */
export function stepsOf(inst, t, now) {
  const f = runWindow(inst, now)
  if (!f) return []
  /** @type {{ at: number, step: string }[]} */
  const marks = []
  for (const j of inst.log) {
    if (j.task !== t.id || j.at == null || j.at < f.start || j.at > f.end) continue
    const m = j.kind === 'etape' ? j.text.match(RE_STEP) : null
    if (m) marks.push({ at: j.at, step: /** @type {string} */ (m[2]) })
    else if (j.kind === 'tache' && RE_STARTS.test(j.text)) marks.push({ at: j.at, step: 'worker' })
  }
  const close = t.end != null && t.end >= f.start && t.end <= f.end
  const endAt = close ? /** @type {number} */ (t.end) : activeRun(inst, now) && t.step && !isMerged(t) ? now : f.end
  /** @type {[number, number, string][]} */
  const out = []
  marks.forEach((r, i) => {
    const b = i + 1 < marks.length ? /** @type {{ at: number }} */ (marks[i + 1]).at : endAt
    if (b > r.at) out.push([r.at, b, r.step])
  })
  return out
}

/** Le temps passé dans chaque étape pendant le dernier run, toutes tâches comprises. @param {Snapshot} inst @param {number} now @returns {[string, number][]} */
export function timePerStep(inst, now) {
  const tot = /** @type {Record<string, number>} */ ({})
  for (const t of inst.tasks) for (const [a, b, e] of stepsOf(inst, t, now)) tot[e] = (tot[e] || 0) + (b - a)
  return STEP_ORDER.filter(e => tot[e]).map(e => [e, /** @type {number} */ (tot[e])])
}

/**
 * La frise d'une tâche sur le temps du dernier run : une case par tranche de temps, coloriée par étape ; le reste en
 * pointillés. La tête d'une tâche en cours pulse quand `anime`.
 * @param {Snapshot} inst @param {TaskView} t @param {number} now @param {number} W @param {boolean} animated @returns {Line}
 */
function timeline(inst, t, now, W, animated) {
  const f = runWindow(inst, now)
  /** @type {(string | null)[]} */
  const cells = Array(W).fill(null)
  if (f) {
    const x = /** @param {number} q */ q => ((q - f.start) / (f.end - f.start)) * W
    for (const [a, b, e] of stepsOf(inst, t, now)) {
      const i0 = Math.min(W - 1, Math.max(0, Math.floor(x(a)))), i1 = Math.min(W - 1, Math.max(i0, Math.ceil(x(b)) - 1))
      for (let i = i0; i <= i1; i++) cells[i] = e
    }
  }
  const head = animated && !!activeRun(inst, now) && !!t.step && !isMerged(t) && pulse(now) ? cells.findLastIndex(c => c != null) : -1
  /** @type {Line} */
  const l = []
  cells.forEach((e, i) => {
    const m = e == null ? { t: '·', c: 'subtle' } : { t: i === head ? '╸' : '━', c: STEP_COLOR[e] || 'subtle' }
    const der = l[l.length - 1]
    if (der && der.c === m.c && !(i === head || i === head + 1)) der.t += m.t
    else l.push(m)
  })
  return l
}

/** Les phases en frise : ● faite, ◉ en cours, ○ à venir, reliées par des traits. @param {PhaseView[]} phases @param {number | null} cur @param {number} w @returns {Line} */
function phaseTimeline(phases, cur, w) {
  const pts = phaseDots(phases, cur)
  if (!pts) return [{ t: `phase ${cur ?? '—'}/${phases.length}`, b: true }]
  const n = pts.length, k = n > 1 ? Math.max(1, Math.floor((w - n) / (n - 1))) : 0
  /** @type {Line} */
  const l = []
  phases.forEach((p, i) => {
    l.push(/** @type {Piece} */ (pts[i]))
    if (i < n - 1) l.push({ t: '━'.repeat(k), c: p.total && p.done === p.total ? 'success' : p.number === cur ? 'claude' : 'subtle' })
  })
  return l
}

/**
 * Ce qui t'attend, une ligne par chose, chacune avec son action : les tâches qui attendent un humain, bloquées ou en échec,
 * les points à trancher, les prérequis ouverts, plan-lint en erreur, puis les relectures et les décisions d'office à revoir
 * avant la PR. Les 9 premières ont une touche (1 à 9). null s'il n'y a rien.
 * @param {Snapshot} inst @param {number} now @param {number} columns
 * @returns {(Card & { urgent: number }) | null}
 */
export function yourTurnCard(inst, now, columns) {
  const s = summarize(inst, now), dir = dirOf(inst), resume = `/orchestre:lancer ${dir} --reprendre`
  /** @type {{ g: Piece, text: string, detail?: string, prompt: string, help: string }[]} */
  const items = []
  const seen = new Set()
  for (const t of s.attention) {
    const p = inst.issues.find(x => x.task === t.id)
    if (p) seen.add(p)
    const reason = /** @type {Record<string, string>} */ (ATTENTION)[t.status]
    items.push(p || t.status === 'besoin-humain'
      ? { g: { t: '⚑', c: 'warning', b: true }, text: `${t.id} · ${p ? p.title : reason}${p?.human ? ' (humain)' : ''}`, detail: t.blocker[0], prompt: resume, help: 'reprendre le run' }
      : { g: { t: '✗', c: 'error', b: true }, text: `${t.id} · ${reason}`, detail: t.blocker[0], prompt: `Explique le blocage de ${t.id}${t.blocker[0] ? ` (${t.blocker[0]})` : ''} et propose une suite.`, help: 'demander au pilote' })
  }
  for (const p of inst.issues) if (!seen.has(p)) items.push({ g: { t: '?', c: 'warning', b: true }, text: `${p.task} · ${p.title}${p.human ? ' (humain)' : ''}`, prompt: resume, help: 'trancher au lancement' })
  for (const p of inst.prerequisites) items.push({ g: { t: '◇', c: 'warning', b: true }, text: `${p.id} (${p.type}) ouvert${p.blocks.length ? `, bloque ${p.blocks.slice(0, 4).join(', ')}` : ''}`, prompt: `/orchestre:pret ${dir}`, help: 'régler les prérequis' })
  if (!inst.lint.ok) items.push({ g: { t: '✗', c: 'error', b: true }, text: `plan-lint : ${plural(inst.lint.errors, 'erreur')} au dernier suivi`, prompt: `Montre-moi les erreurs de plan-lint sur ${dir} et propose une correction.`, help: 'demander au pilote' })
  const urgent = items.length
  for (const r of inst.reviews) items.push({ g: { t: '⚑', c: 'warning' }, text: `${r.task ?? 'plan source'} · ${r.text}`, prompt: `Relis avec moi, avant la PR (relecture de ${r.task ?? 'plan source'}) : ${r.text}`, help: 'relire' })
  for (const d of inst.decisions) items.push({ g: { t: '⇒', c: 'merged' }, text: `${d.task} · ${d.title} : ${d.option}${d.description ? ` (${d.description})` : ''}`, prompt: `Revois avec moi la décision prise d'office pour ${d.task} : « ${d.title} », option ${d.option}${d.description ? ` (${d.description})` : ''}.`, help: 'revoir' })
  if (!items.length) return null
  const inner = columns - 4
  /** @type {Line[]} */
  const lines = []
  items.forEach((it, i) => {
    const hotkey = i < 9 ? String(i + 1) : null
    const help = `  → ${it.help}`
    lines.push([it.g, { t: ' ' }, { t: cut(it.text, Math.max(16, inner - help.length - 6)), x: { hotkey, prompt: it.prompt, help: it.help } }, { t: help, d: true }])
    if (it.detail) lines.push([{ t: `     ${cut(it.detail, Math.max(16, inner - 6))}`, d: true }])
  })
  const count = [
    urgent ? `${urgent} à régler` : '',
    inst.reviews.length ? plural(inst.reviews.length, 'relecture') : '',
    inst.decisions.length ? plural(inst.decisions.length, 'décision') : '',
  ].filter(Boolean).join(' · ')
  return {
    id: 'toi', color: 'warning', urgent,
    title: [{ t: urgent ? '⚠ À toi' : '⚑ À relire avant la PR', c: 'warning', b: true }],
    meta: [{ t: count, d: true }],
    lines,
  }
}

/**
 * Le dernier run : phases en frise, barre par statut avec ses comptes, durée, temps par étape, et la suite quand il est
 * fini (reprendre, ou le brouillon de PR quand le plan est terminé).
 * @param {Snapshot} inst @param {number} now @param {number} columns @param {boolean} animated @returns {Card}
 */
export function runCard(inst, now, columns, animated) {
  const s = summarize(inst, now), r = inst.run, inner = columns - 4, dir = dirOf(inst)
  if (!r) return { id: 'run', color: 'subtle', title: [{ t: 'Aucun run noté', b: true }], meta: [], lines: [[{ t: `Le premier /orchestre:lancer ${dir} l'ouvrira.`, d: true }]] }
  const cur = runPhase(inst), runLive = r.status === 'en-cours'
  const color = runLive ? (s.silent ? 'warning' : 'claude') : r.status === 'terminé' ? 'success' : r.status === 'erreur' ? 'error' : 'warning'
  const activeTasks = inst.tasks.filter(t => t.status !== 'annulée'), classOf = classifier(inst, now)
  const n = [0, 0, 0, 0, 0]
  for (const t of activeTasks) { const i = classOf(t); n[i] = (n[i] ?? 0) + 1 }
  const within = /** @param {{ at: number | null }} j */ j => j.at != null && r.start != null && j.at >= r.start && (r.end == null || j.at <= r.end)
  // Les essais de plus des tâches démarrées dans ce run (un refus d'évaluation ou de vérification en vaut un)
  const retries = inst.tasks.filter(t => t.start != null && r.start != null && t.start >= r.start).reduce((k, t) => k + Math.max(0, t.attempts - 1), 0)
  const autoCount = inst.log.filter(j => j.kind === 'decision-office' && within(j)).length
  /** @type {Line[]} */
  const lines = [
    [{ t: 'phases  ', d: true }, ...phaseTimeline(s.phases, cur, Math.max(8, Math.min(40, inner - 24))), ...(s.phases.length <= 10 ? [{ t: `   phase ${cur}/${s.maxPhase}`, d: true }] : [])],
    [{ t: 'tâches  ', d: true }, ...classBar(activeTasks, classOf, Math.max(8, Math.min(30, inner - 36)), now, animated), { t: `  ${s.done}/${s.total}`, b: true },
      ...n.flatMap((k, i) => (k ? [{ t: '   ■', c: /** @type {typeof CLASSES[number]} */ (CLASSES[i]).c }, { t: ` ${k}` }] : []))],
    [{ t: 'durée   ', d: true }, { t: duration(s.duration) }, ...(r.parallelism ? [{ t: ` · ${r.parallelism} en parallèle`, d: true }] : []), ...(retries ? [{ t: ' · ', d: true }, { t: `${retries} ${retries > 1 ? 'essais' : 'essai'} de plus` }] : []), ...(autoCount ? [{ t: ' · ', d: true }, { t: `${plural(autoCount, 'décision')} d'office` }] : [])],
  ]
  const steps = timePerStep(inst, now)
  if (steps.length) lines.push([{ t: 'étapes  ', d: true }, ...joinParts(steps.map(([e, ms]) => [{ t: `${SHORT_STEP[e] || e} ${chrono(ms)}`, c: STEP_COLOR[e] || 'subtle' }]), ' · ')])
  if (!runLive && r.detail) lines.push([{ t: 'détail  ', d: true }, { t: cut(r.detail, Math.max(16, inner - 10)) }])
  if (!runLive) {
    lines.push(s.allMerged
      ? [{ t: 'suite   ', d: true }, { t: 'Brouillon de PR dans le prompt', x: { hotkey: 'p', prompt: prText(inst, now), help: 'préparer la PR' } }]
      : [{ t: 'suite   ', d: true }, { t: `/orchestre:lancer ${dir} --reprendre`, x: { hotkey: 'l', prompt: `/orchestre:lancer ${dir} --reprendre`, help: 'reprendre le run' } }, { t: '  dans le prompt', d: true }])
  }
  const marker = runLive ? '' : r.status === 'terminé' ? '✓ ' : r.status === 'erreur' ? '✗ ' : '■ '
  return {
    id: 'run', color,
    title: [{ t: `${marker}Run ${r.number} · ${phasesLabel(r.phase, cur ?? r.phase)} · ${MODES[r.mode] || r.mode}`, c: color, b: true }],
    meta: runLive
      ? (s.silent ? [{ t: `◌ sans nouvelles depuis ${duration(now - /** @type {number} */ (inst.updated))}`, c: 'warning' }] : [{ t: `◐ ${s.inProgress.length} en cours`, c: 'suggestion' }])
      : [{ t: r.status, c: color, b: true }],
    lines,
  }
}

// La colonne du modèle, dans les lignes de tâches : 14 cellules tiennent « haiku → sonnet »
const MODEL_WIDTH = 14
/**
 * Le modèle d'une tâche (0.11.0) : le modèle utilisé, ou « prévu → utilisé » quand ils diffèrent (« — » si le plan n'en
 * prévoit pas) ; avant le worker, le modèle prévu, estompé. Vide si rien n'est connu.
 * @param {TaskView} t @returns {Line}
 */
export function modelOf(t) {
  if (!t.modelUsed) return t.model ? [{ t: t.model, d: true }] : []
  if (t.modelUsed === t.model) return [{ t: t.modelUsed, c: 'subtle' }]
  return [{ t: `${t.model ?? '—'} → `, d: true }, { t: t.modelUsed, c: 'merged', b: true }]
}
/** La cellule du modèle, coupée et complétée à n cellules, suivie de deux espaces ; rien si n vaut 0. @param {TaskView} t @param {number} n @returns {Line} */
function modelCell(t, n) {
  if (!n) return []
  /** @type {Line} */
  const l = []
  let rest = n
  // Coupé seulement s'il dépasse : court() retirerait l'espace qui suit la flèche
  for (const m of modelOf(t)) { if (rest <= 0) break; const x = [...m.t].length > rest ? cut(m.t, rest) : m.t; l.push({ ...m, t: x }); rest -= [...x].length }
  return [...l, { t: ' '.repeat(Math.max(0, rest) + 2) }]
}

/**
 * Les tâches : une ligne par phase (une case par tâche), puis, sous les phases où il se passe quelque chose, une ligne
 * par tâche avec sa frise sur le temps du dernier run, sa durée et ce qu'elle fait. Une tâche close dans un run
 * précédent garde une ligne courte ; les tâches à faire de la phase en cours sont bornées à 6.
 * @param {Snapshot} inst @param {number} now @param {number} columns @param {boolean} [animated] @returns {Line[]}
 */
export function taskLines(inst, now, columns, animated = false) {
  const s = summarize(inst, now), live = !!s.run, f = runWindow(inst, now)
  const cur = live ? runPhase(inst) : s.current?.number ?? null
  const classOf = classifier(inst, now)
  // Colonne du modèle (0.11.0) : à la largeur du plus long des modèles connus, prise sur la frise puis sur le titre, pour que
  // ce que fait la tâche garde sa place (30 cellules quand la largeur le permet, 20 au moins) ; absente si aucun modèle n'est
  // connu, ou si elle ne tient pas. La frise retrouve ses 26 cellules dès que la place le permet
  const MW0 = Math.min(MODEL_WIDTH, Math.max(0, ...inst.tasks.map(t => width(modelOf(t)))))
  const MW = MW0 && columns >= 60 + MW0 + 2 ? MW0 : 0
  const MC = MW ? MW + 2 : 0
  const titleWidth = Math.max(10, Math.min(22, columns - 60 - MC)), W = Math.max(8, Math.min(26, columns - titleWidth - 42 - (MC ? MC + 10 : 0)))
  const QW = Math.max(10, columns - titleWidth - W - 22 - MC)
  const touched = /** @param {TaskView} t */ t => !!f && ((t.start != null && t.start >= f.start) || (t.end != null && t.end >= f.start) || (live && !!t.step))
  const justMerged = /** @param {TaskView} t */ t => isMerged(t) && t.end != null && now - t.end < NEWS_MS / 2
  /** @type {Line[]} */
  const out = []
  let segments = false
  for (const p of s.phases) {
    const finished = p.total > 0 && p.done === p.total
    const g = finished ? { t: '●', c: 'success' } : p.attention ? { t: '⚠', c: 'warning' } : p.number === cur ? { t: '◉', c: 'claude', b: true } : p.done ? { t: '◐', c: 'suggestion' } : { t: '○', c: 'subtle' }
    const ts = inst.tasks.filter(t => t.phase === p.number && t.status !== 'annulée')
    /** @type {Line} */
    const l = [g, { t: ` Phase ${String(p.number).padEnd(3)}`, b: p.number === cur || finished, c: finished ? 'success' : undefined }, { t: ' ' }]
    l.push(...(ts.length <= 30 ? squares(ts, classOf) : classBar(ts, classOf, 20, now, animated)))
    l.push({ t: `  ${p.done}/${p.total}`, c: finished ? 'success' : undefined, b: finished }, { t: `  ${duration(p.duration)}`, d: true })
    if (p.retries.length) l.push({ t: `   ${p.retries.slice(0, 3).map(r => `${r.id} ×${r.attempts}`).join(', ')}${p.retries.length > 3 ? '…' : ''}`, c: 'merged' })
    out.push(l)
    const detail = ts.filter(t => touched(t) || t.status in ATTENTION)
    const todo = p.number === cur ? ts.filter(t => !isMerged(t) && !detail.includes(t)) : []
    for (const t of detail) {
      const segs = stepsOf(inst, t, now)
      if (segs.length) segments = true
      const running = live && !!t.step && !isMerged(t)
      const before = !segs.length && isMerged(t) ? runOf(inst, t) : null
      const elapsed = segs.length ? /** @type {[number, number, string]} */ (segs.at(-1))[1] - /** @type {[number, number, string]} */ (segs[0])[0] : t.start != null && t.end != null ? t.end - t.start : null
      /** @type {Line} */
      const line = [{ t: '  ' }, glyph(t, live, now, animated), { t: ` ${column(t.id, 6)}`, b: true }, { t: `${column(t.title, titleWidth)} `, d: !running && !isMerged(t) }]
      if (segs.length) line.push(...timeline(inst, t, now, W, animated))
      else if (before) line.push({ t: `── run ${before.number} `.padEnd(W, '─').slice(0, W), c: 'subtle' })
      else line.push({ t: '·'.repeat(W), c: 'subtle' })
      line.push({ t: `  ${chrono(elapsed).padStart(7)}  `, d: true }, ...modelCell(t, MW))
      if (justMerged(t)) line.push({ t: ' fusionnée ', c: 'inverseText', f: 'success', b: true })
      else line.push(...whatColored(t, live, ruled(inst, t), QW))
      out.push(line)
    }
    // Le modèle prévu, dans la même colonne que les lignes détaillées (à la place de la durée, vide)
    for (const t of todo.slice(0, 6)) out.push([{ t: '  ' }, glyph(t, live), { t: ` ${column(t.id, 6)}${column(t.title, titleWidth)} `, d: true }, { t: '·'.repeat(W), c: 'subtle' }, ...(MW ? [{ t: ' '.repeat(11) }, ...modelCell(t, MW)] : [{ t: '  ' }]), { t: cut(what(t, live), MW ? QW : Math.max(10, columns - titleWidth - W - 14)), d: true }])
    if (todo.length > 6) out.push([{ t: `    ○ ${todo.length - 6} autres à faire`, d: true }])
  }
  if (!out.length) return [[{ t: 'Aucune tâche dans suivi.json.', d: true }]]
  if (segments) out.push([{ t: ' '.repeat(10 + titleWidth) }, ...joinParts(STEP_ORDER.slice(0, 5).map(e => [{ t: '━', c: STEP_COLOR[e] }, { t: ` ${SHORT_STEP[e]}`, d: true }]), ' ')])
  return out
}

/** Le journal en colonnes : âge, source colorée, message ; les dernières entrées, ou tout avec `complet`. @param {Snapshot} inst @param {number} now @param {number} columns @param {boolean} full @returns {Card} */
export function logCard(inst, now, columns, full) {
  const inner = columns - 4
  const js = inst.log.slice(-(full ? LONG_LOG : SHORT_LOG))
  const lines = js.length
    ? js.map(j => { const m = mark(j); return [{ t: age(j.at, now).padStart(6), d: true }, { t: '  ' }, { t: column(j.task ?? (j.kind === 'run' || j.kind === 'erreur' ? 'run' : 'plan'), 6), c: m.c, d: m.d, b: !m.d }, m, { t: ` ${cut(j.text, Math.max(16, inner - 18))}` }] })
    : [[{ t: 'Journal vide.', d: true }]]
  const rest = inst.log.length - js.length
  return { id: 'journal', color: 'subtle', title: [{ t: 'journal', b: true }], meta: [{ t: full ? 'j : moins' : rest > 0 ? `j : tout (${inst.log.length})` : '', d: true }], lines }
}

/**
 * Ce qui a changé depuis `t0` (ton dernier passage), d'après le journal : tâches fusionnées, tâches qui se sont mises à
 * t'attendre, fins de run, relectures. null s'il ne s'est rien passé, ou s'il y a moins d'une minute.
 * @param {Snapshot} inst @param {number | null} t0 @param {number} now @returns {Line | null}
 */
export function since(inst, t0, now) {
  if (t0 == null || now - t0 < 60000) return null
  const waitingIds = new Set(summarize(inst, now).attention.map(t => t.id))
  /** @type {string[]} */
  const merges = []
  /** @type {string[]} */
  const waiting = []
  /** @type {string[]} */
  const runs = []
  let reviews = 0
  for (const j of inst.log) {
    if (j.at == null || j.at <= t0) continue
    /** @type {RegExpMatchArray | null} */
    let m
    if (j.kind === 'statut' && (m = j.text.match(/^(\S+) : (fusionnée|besoin-humain|bloquée|échec)/))) {
      if (m[2] === 'fusionnée') merges.push(/** @type {string} */ (m[1]))
      else if (waitingIds.has(/** @type {string} */ (m[1])) && !waiting.includes(/** @type {string} */ (m[1]))) waiting.push(/** @type {string} */ (m[1]))
    }
    if ((j.kind === 'run' || j.kind === 'erreur') && (m = j.text.match(/^run (\d+) : (terminé|arbitrage|partiel|à-relancer|erreur)/))) runs.push(`run ${m[1]} ${m[2]}`)
    if (j.kind === 'relecture') reviews++
  }
  /** @type {Line[]} */
  const parts = []
  if (merges.length) parts.push([{ t: `✓ ${merges.slice(0, 6).join(' ')}${merges.length > 6 ? '…' : ''} ${merges.length > 1 ? 'fusionnées' : 'fusionnée'}`, c: 'success' }])
  if (waiting.length) parts.push([{ t: `⚠ ${waiting.slice(0, 4).join(' ')} ${waiting.length > 1 ? "t'attendent" : "t'attend"}`, c: 'warning', b: true }])
  if (reviews) parts.push([{ t: `⚑ ${plural(reviews, 'relecture')}`, c: 'warning' }])
  if (runs.length) parts.push([{ t: /** @type {string} */ (runs.at(-1)) }])
  if (!parts.length) return null
  return [{ t: '↩ ', c: 'claude', b: true }, { t: `Depuis ${duration(now - t0)}`, b: true }, { t: ' : ' }, ...joinParts(parts, ' · ')]
}

/**
 * Le panneau entier : un en-tête (état global, légende, légende de la démo, ce qui a changé depuis le dernier passage),
 * puis les cartes. Sous COLONNES_BORDS colonnes, les cartes perdent leur bord.
 * @param {Snapshot} inst @param {number} now @param {number} columns
 * @param {{ animated?: boolean, fullLog?: boolean, since?: number | null }} [options]
 * @returns {{ header: Line[], cards: Card[], borders: boolean }}
 */
export function pane(inst, now, columns, { animated = false, fullLog = false, since: t0 = null } = {}) {
  const s = summarize(inst, now), r = inst.run
  const yourTurn = yourTurnCard(inst, now, columns)
  /** @type {Piece} */
  const state = !r ? { t: 'AUCUN RUN', d: true }
    : s.allMerged && r.status !== 'en-cours' ? { t: 'PLAN TERMINÉ', c: 'success', b: true }
    : s.silent ? { t: `RUN ${r.number} SANS NOUVELLES`, c: 'warning', b: true }
    : { t: `RUN ${r.number} ${r.status === 'en-cours' ? 'EN COURS' : r.status.toUpperCase()}`, c: r.status === 'en-cours' ? 'claude' : r.status === 'terminé' ? 'success' : r.status === 'erreur' ? 'error' : 'warning', b: true }
  /** @type {Piece | null} */
  const endMark = yourTurn && yourTurn.urgent ? { t: ` ⚠ ${yourTurn.urgent} À TOI `, c: 'inverseText', f: 'warning', b: true }
    : s.reviews ? { t: `⚑ ${s.reviews} À RELIRE`, c: 'warning', b: true }
    : s.inProgress.length ? { t: `◐ ${s.inProgress.length} EN COURS`, c: 'suggestion' } : null
  /** @type {Line[]} */
  const header = [
    [...(inst.demo ? [{ t: ' DÉMO ', c: 'inverseText', f: 'merged', b: true }, { t: ' ' }] : []), { t: 'ORCHESTRE', c: 'claude', b: true }, { t: ' · ', d: true }, { t: cut(inst.plan.toUpperCase(), 30), b: true }, { t: ' · ', d: true }, state, ...(endMark ? [{ t: ' · ', d: true }, endMark] : [])],
    [{ t: '■', c: 'success' }, { t: ' fusionnée  ', d: true }, { t: '■', c: 'suggestion' }, { t: ' en cours  ', d: true }, { t: '■', c: 'warning' }, { t: ' attend  ', d: true }, { t: '■', c: 'error' }, { t: ' bloquée  ', d: true }, { t: '░', c: 'subtle' }, { t: ' à faire', d: true }],
  ]
  // La légende de la démo : le pas, puis ce qu'il y a à essayer
  if (inst.legend) for (const [i, line] of inst.legend.split('\n').entries()) header.push([{ t: cut(line, Math.max(20, columns - 2)), c: 'merged', b: i === 0 }])
  const away = since(inst, t0, now)
  if (away) header.push(away)
  /** @type {Card[]} */
  const cards = []
  if (yourTurn) cards.push(yourTurn)
  cards.push(runCard(inst, now, columns, animated))
  cards.push({ id: 'taches', color: null, title: [{ t: 'tâches', b: true }, { t: ` · ${s.inProgress.length} en cours · ${s.total} au total`, d: true }], meta: [], lines: taskLines(inst, now, columns, animated) })
  cards.push(logCard(inst, now, columns, fullLog))
  return { header, cards, borders: columns >= BORDER_COLUMNS }
}

/** La ligne d'état quand le bandeau est masqué et qu'il reste quelque chose à faire : « orchestre ✓ 5/5 · ⚑ 3 ». @param {Snapshot} inst @param {number} now */
export function statusLine(inst, now) {
  const s = summarize(inst, now)
  if (s.allMerged && !s.reviews && !s.attention.length) return null
  return `orchestre ${s.allMerged ? '✓' : '■'} ${s.done}/${s.total}${s.reviews ? ` · ⚑ ${s.reviews}` : ''}${s.attention.length ? ` · ⚠ ${s.attention.length}` : ''}`
}

/** Une ligne en texte brut. @param {Line} l */
export const plainText = l => l.map(m => m.t).join('').replace(/\s+$/, '')

/** L'état en texte, là où rien ne se dessine (`/suivi texte`, panneau refusé) : le bandeau, puis les cartes. @param {Snapshot} inst @param {number} now */
export function stateText(inst, now) {
  const b = banner(inst, now, 120)
  const out = [b ? plainText(b) : `${inst.plan} : aucun run noté dans suivi.json`]
  for (const c of pane(inst, now, 104).cards) {
    out.push('', plainText([...c.title, ...(c.meta.length ? [{ t: '   ' }, ...c.meta] : [])]))
    for (const l of c.lines) out.push(plainText(l))
  }
  return out.join('\n')
}

/** Brouillon de description de PR, mis dans le prompt, jamais envoyé. @param {Snapshot} inst @param {number} now */
export function prText(inst, now) {
  const s = summarize(inst, now)
  const l = [`Plan ${inst.plan} : ${s.done}/${s.total} tâches fusionnées, ${plural(inst.runs.length, 'run')}.`, '']
  if (inst.reviews.length) {
    l.push('À relire avant de fusionner (fichiers et commandes interdits aux agents) :')
    for (const r of inst.reviews) l.push(`- ${r.task ?? 'plan source'} : ${r.text}`)
    l.push('')
  }
  if (inst.decisions.length) {
    l.push('Décisions prises d\'office (mode autonome) :')
    for (const d of inst.decisions) l.push(`- ${d.task}, ${d.title} : option ${d.option}, ${d.description}`)
    l.push('')
  }
  if (s.attention.length) l.push(`Encore en attente : ${s.attention.map(t => `${t.id} (${ATTENTION[/** @type {keyof typeof ATTENTION} */ (t.status)]})`).join(', ')}.`, '')
  if (inst.tickets) l.push(`${plural(inst.tickets, 'ticket')} à ouvrir après la PR (HANDOFF.md, entrées « ticket »).`)
  return l.join('\n').replace(/\n+$/, '\n')
}

/** Une notification qui demande quelqu'un : tâche qui attend un humain, bloquée ou en échec, run arrêté ou en erreur. @param {string} m */
export const isImportant = m => / attend un humain$|^✗ |^Run arrêté|\) : erreur/.test(m)

/**
 * Ce qui mérite une notification entre deux lectures : run lancé ou fini, phase finie, tâche qui attend un humain,
 * bloquée ou en échec, nouvelle relecture, point d'arrêt. Rien à la première lecture.
 * @param {Snapshot | null} before @param {Snapshot} after @returns {string[]}
 */
export function changes(before, after) {
  if (!before || before.plan !== after.plan) return []
  /** @type {string[]} */
  const m = []
  const ra = before.run, rb = after.run
  if (rb && (!ra || rb.number !== ra.number)) m.push(`Run ${rb.number} lancé : phase ${rb.phase}, mode ${rb.mode}`)
  if (rb && ra && rb.number === ra.number && ra.status === 'en-cours' && rb.status !== 'en-cours') m.push(`Run ${rb.number} (${phasesLabel(rb.phase, runPhase(after) ?? rb.phase)}) : ${rb.status}${rb.detail ? `, ${cut(rb.detail, 80)}` : ''}`)
  const beforeById = new Map(before.tasks.map(t => [t.id, t]))
  for (const t of after.tasks) {
    const a = beforeById.get(t.id)
    if (a && a.status !== t.status && t.status in ATTENTION) m.push(`${t.status === 'besoin-humain' ? '⚑' : '✗'} ${t.id} ${ATTENTION[/** @type {keyof typeof ATTENTION} */ (t.status)]}`)
  }
  const finished = /** @param {Snapshot} i @param {number} n */ (i, n) => { const ts = i.tasks.filter(t => t.phase === n && t.status !== 'annulée'); return ts.length > 0 && ts.every(isMerged) }
  for (const n of [...new Set(after.tasks.map(t => t.phase))]) if (finished(after, n) && !finished(before, n)) m.push(`Phase ${n} terminée`)
  // Une notification par tâche, quel que soit le nombre de relectures qu'une clôture apporte
  const newOnes = /** @type {Map<string, number>} */ (new Map())
  for (const r of after.reviews.slice(before.reviews.length)) newOnes.set(r.task ?? 'plan source', (newOnes.get(r.task ?? 'plan source') || 0) + 1)
  for (const [who, k] of newOnes) m.push(`⚑ ${who} : ${k > 1 ? `${k} relectures` : 'à relire'} avant la PR`)
  // Un point devient point d'arrêt à la fin du run (le scribe l'a noté « a-trancher ») : le rôle fait partie de la clé
  const itemKey = /** @param {{ task: string, title: string, role: string }} p */ p => `${p.task}\u0000${p.title}\u0000${p.role}`
  const seen = new Set(before.issues.map(itemKey))
  for (const p of after.issues) if (p.role === 'arret' && !seen.has(itemKey(p))) m.push(`Run arrêté : ${p.task}, ${cut(p.title, 80)}`)
  return m
}
