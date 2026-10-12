// @ts-check
// View model of the orchestre progress mod: reads plans/<name>/progress.json (contract orchestre-progress/3, written by
// scripts/progress.mjs of the orchestre plugin) and draws from it what the mod shows. Pure functions, without `$`:
// register.tsx deals with the engine (files, timer, drawing), tests/mod-progress.test.mjs checks them under Node.

/** @typedef {import('../types/index.d.ts').Snapshot} Snapshot */
/** @typedef {import('../types/index.d.ts').TaskView} TaskView */
/** @typedef {import('../types/index.d.ts').PhaseView} PhaseView */
/** @typedef {import('../types/index.d.ts').RunView} RunView */
/** @typedef {import('../types/index.d.ts').Piece} Piece */
/** @typedef {import('../types/index.d.ts').Line} Line */
/** @typedef {import('../types/index.d.ts').Card} Card */

export const FORMAT = 'orchestre-progress/3'
// The formats this mod reads: /3 only (0.12.0). The French formats of 0.11 and earlier (suivi.json) are converted by
// scripts/migrate.mjs, and progress.mjs converts a progress.json still in one of them at its next write
export const FORMATS = [FORMAT]
export const LEGACY_FORMATS = ['orchestre-suivi/2', 'orchestre-suivi/1']
export const STATUSES = ['todo', 'added', 'merged', 'blocked', 'failed', 'needs-human', 'cancelled']
// As /orchestre:status and progress.mjs status say them
const ATTENTION = { 'needs-human': 'waits for a human', blocked: 'blocked', failed: 'failed' }
// The whole log of progress.json (200 entries at most): the timeline of the run's steps needs it
const LOG_READ = 200
// A run marked "in-progress" without a write for 45 min is shown "no news": interrupted (Esc, session killed), it stays
// "in-progress" until the next run-start. A single step (a worker) can last; beyond that, better say so.
export const SILENCE_MS = 45 * 60000
// Duration of a notification that asks for someone (4 s by default for the others)
export const IMPORTANT_TOAST_MS = 15000
// The buttons after the banner, to click, and the room they take there: "   ⤢ Details", always, and " ✕ Hide" at the end
// of a run (register.tsx draws them, banner() leaves them the room)
export const DETAILS_GAP = '   ', DETAILS_LABEL = '⤢ Details', HIDE_GAP = ' ', HIDE_LABEL = '✕ Hide'
export const DETAILS_RESERVE = [...DETAILS_GAP + DETAILS_LABEL].length
export const HIDE_RESERVE = [...HIDE_GAP + HIDE_LABEL].length

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

/** Format declared by a progress.json, or null. @param {unknown} raw */
export const formatOf = raw => (isObject(raw) && typeof raw.format === 'string' ? raw.format : null)

/**
 * progress.json (orchestre-progress/3) → what the mod shows; null if the format is not this one.
 * Unknown fields are ignored, missing fields taken empty: a reader only refuses the format.
 * @param {unknown} raw @returns {Snapshot | null}
 */
export function normalize(raw) {
  if (!isObject(raw) || !FORMATS.includes(/** @type {string} */ (raw.format)) || !Array.isArray(raw.tasks)) return null
  const runs = (Array.isArray(raw.runs) ? raw.runs : []).filter(isObject)
  const lastRun = runs.length ? runs[runs.length - 1] : null
  /** @type {TaskView[]} */
  const tasks = raw.tasks.filter(isObject).map(t => ({
    id: text(t.id), title: text(t.title) || text(t.id), phase: integer(t.phase, 1),
    status: STATUSES.includes(t.status) ? t.status : 'todo', attempts: integer(t.attempts, 0),
    step: typeof t.step === 'string' ? t.step : null, isolated: t.isolated === true,
    start: date(t.start), end: date(t.end), waiting: texts(t.waiting), blocker: texts(t.blocker),
    // Model planned by the plan and last model launched (0.11.0)
    model: typeof t.model === 'string' && t.model ? t.model : null, modelUsed: typeof t.model_used === 'string' && t.model_used ? t.model_used : null,
  }))
  const majorCounts = /** @type {Record<string, number>} */ ({})
  let tickets = 0
  if (isObject(raw.handoff)) for (const section of Object.values(raw.handoff)) if (isObject(section)) for (const [type, c] of Object.entries(section)) {
    if (!isObject(c)) continue
    if (type === 'ticket') tickets += integer(c.minor, 0) + integer(c.major, 0)
    const n = integer(c.major, 0)
    if (n > 0) majorCounts[type] = (majorCounts[type] || 0) + n
  }
  return {
    demo: false, legend: null, plan: text(raw.plan), dir: text(raw.dir), updated: date(raw.updated),
    tasks,
    runs: runs.map(runView),
    run: lastRun ? runView(lastRun) : null,
    reviews: (Array.isArray(raw.reviews) ? raw.reviews : []).filter(isObject).map(r => ({ task: r.task == null ? null : text(r.task), phase: Number.isInteger(r.phase) ? r.phase : null, text: text(r.text), at: date(r.at) })),
    decisions: (Array.isArray(raw.auto_decisions) ? raw.auto_decisions : []).filter(isObject).map(d => ({ task: text(d.task), title: text(d.title), option: text(d.option), description: text(d.description) })),
    issues: (Array.isArray(raw.issues) ? raw.issues : []).filter(p => isObject(p) && p.status !== 'settled').map(p => ({ task: text(p.task), title: text(p.title), human: p.human === true, role: text(p.role) })),
    prerequisites: (Array.isArray(raw.prerequisites) ? raw.prerequisites : []).filter(p => isObject(p) && p.status === 'open').map(p => ({ id: text(p.id), type: text(p.type), blocks: texts(p.blocks) })),
    majorCounts, tickets,
    lint: { ok: !isObject(raw.lint) || raw.lint.ok !== false, errors: isObject(raw.lint) ? texts(raw.lint.errors).length : 0 },
    log: (Array.isArray(raw.log) ? raw.log : []).filter(isObject).slice(-LOG_READ).map(j => ({ at: date(j.at), kind: text(j.kind), task: j.task == null ? null : text(j.task), text: text(j.text) })),
  }
}

/** @param {Record<string, unknown>} r @returns {RunView} */
const runView = r => ({
  number: integer(r.number, 0), phase: integer(r.phase, 0), mode: text(r.mode), parallelism: integer(r.parallelism, 0), status: text(r.status), start: date(r.start), end: date(r.end), detail: r.detail == null ? null : text(r.detail),
  ruledTasks: (Array.isArray(r.rulings_applied) ? r.rulings_applied : []).filter(isObject).map(a => text(a.task)).filter(Boolean),
})

const isMerged = /** @param {TaskView} t */ t => t.status === 'merged'
/** The run marked in progress, if there is one. @param {Snapshot} inst */
export const runInProgress = inst => (inst.run && inst.run.status === 'in-progress' ? inst.run : null)
/** A run in progress without a write of progress.json for SILENCE_MS. @param {Snapshot} inst @param {number} now */
export const silent = (inst, now) => !!runInProgress(inst) && inst.updated != null && now - inst.updated >= SILENCE_MS
/** The run in progress that gives news. @param {Snapshot} inst @param {number} now */
export const activeRun = (inst, now) => (silent(inst, now) ? null : runInProgress(inst))
/** A task in progress: a step noted during an active run. @param {Snapshot} inst @param {number} now */
export const inProgress = (inst, now) => (activeRun(inst, now) ? inst.tasks.filter(t => t.step && !isMerged(t)) : [])
/** The issue of the task was just settled by the run in progress, which will restart it. @param {Snapshot} inst @param {TaskView} t */
const ruled = (inst, t) => { const r = runInProgress(inst); return !!r && r.ruledTasks.includes(t.id) }
/**
 * What waits for someone: a task that needs a human, blocked or failed, unless the run in progress took it back (a step
 * noted during an active run) or just settled its issue. @param {Snapshot} inst @param {number} now
 */
export const needsSomeone = (inst, now) => { const live = !!activeRun(inst, now); return /** @param {TaskView} t */ t => t.status in ATTENTION && !(live && t.step) && !ruled(inst, t) }
/**
 * The phase the last run is at: the highest of the tasks it started or closed, at least the one it started on.
 * A run in auto mode goes from one phase to the next, and run.phase stays the one it started on. @param {Snapshot} inst
 */
export function runPhase(inst) {
  const r = inst.run
  if (!r) return null
  const d = r.start
  const touched = d == null ? [] : inst.tasks.filter(t => t.status !== 'cancelled' && ((t.start != null && t.start >= d) || (t.end != null && t.end >= d)))
  return Math.max(r.phase, ...touched.map(t => t.phase))
}

/**
 * The figures of the banner and of the headers. @param {Snapshot} inst @param {number} now ms
 */
export function summarize(inst, now) {
  const activeTasks = inst.tasks.filter(t => t.status !== 'cancelled')
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
  // A phase whose tasks are all cancelled is no longer a phase of the plan, as for /orchestre:status
  const nums = [...new Set(inst.tasks.filter(t => t.status !== 'cancelled').map(t => t.phase))].sort((a, b) => a - b)
  const waiting = needsSomeone(inst, now)
  return nums.map(number => {
    const ts = inst.tasks.filter(t => t.phase === number && t.status !== 'cancelled')
    // In each run, from the first start to the last end of the phase's tasks: a run in auto mode goes through several,
    // and the wait between two runs does not count
    let duration = /** @type {number | null} */ (null)
    for (const r of inst.runs) {
      if (r.start == null) continue
      const d = r.start, f = r.end ?? (r.status === 'in-progress' ? now : d)
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

// ─── Formatting ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Readable duration: "45 s", "18 min", "1 h 12". @param {number | null} ms */
export function duration(ms) {
  if (ms == null || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`
}
/** Short age of an event: "45 s", "18 min", "1 h 12", "3 d" (no clock time: the mod's time zone is not sure). @param {number | null} ms @param {number} now */
export function age(ms, now) {
  if (ms == null) return '—'
  const s = Math.max(0, now - ms)
  return s >= 86400000 ? `${Math.floor(s / 86400000)} d` : duration(s)
}
/** @param {number} done @param {number} total @param {number} width */
export function bar(done, total, width) {
  const k = total > 0 ? Math.floor((done / total) * width) : 0
  return '█'.repeat(k) + '░'.repeat(Math.max(0, width - k))
}
/** Cuts to n visible characters, with "…". @param {string} s @param {number} n */
export function cut(s, n) {
  const c = [...String(s).replace(/\s+/g, ' ').trim()]
  return c.length > n ? c.slice(0, Math.max(0, n - 1)).join('') + '…' : c.join('')
}
/** Pads to n characters (after cutting). @param {string} s @param {number} n */
export const column = (s, n) => { const c = cut(s, n); return c + ' '.repeat(Math.max(0, n - [...c].length)) }
/** @param {number} n @param {string} word */
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`
/** "phase 2", or "phases 1 to 3" for a run that went through several. @param {number} from @param {number} a */
const phasesLabel = (from, a) => (a > from ? `phases ${from} to ${a}` : `phase ${from}`)

// ─── Colors and motion ────────────────────────────────────────────────────────────────────────────────────────────
// The frames of the animations follow from the clock: nothing to keep from one drawing to the next. register.tsx redraws
// every IMAGE_MS during an active run, and as long as an event is less than NEWS_MS old.
export const IMAGE_MS = 150
export const NEWS_MS = 10000
const WHEEL = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏', SPIN = '◐◓◑◒'
/** @param {number} m */ export const wheel = m => /** @type {string} */ (WHEEL[Math.floor(m / 100) % WHEEL.length])
/** @param {number} m */ export const spin = m => /** @type {string} */ (SPIN[Math.floor(m / IMAGE_MS) % SPIN.length])
/** @param {number} m */ const pulse = m => Math.floor(m / 450) % 2 === 1
// One color per step, from the person's theme
const STEP_COLOR = /** @type {Record<string, string>} */ ({ worker: 'suggestion', verification: 'merged', evaluation: 'planMode', fix: 'warning', merge: 'success', replanning: 'subtle', progress: 'subtle' })
// Classes of a task, in the order of the bar: merged, in progress, needs a human, blocked or failed, the rest
const CLASSES = /** @type {const} */ ([
  { c: 'success', g: '█' }, { c: 'suggestion', g: '█' }, { c: 'warning', g: '█' }, { c: 'error', g: '█' }, { c: 'subtle', g: '░' },
])
/** @param {Snapshot} inst @param {number} now @returns {(t: TaskView) => number} */
function classifier(inst, now) {
  const live = !!activeRun(inst, now), waiting = needsSomeone(inst, now)
  return t => (isMerged(t) ? 0 : live && t.step ? 1 : waiting(t) ? (t.status === 'needs-human' ? 2 : 3) : 4)
}

/**
 * Bar stacked by task class: one or more squares per task when they fit, otherwise in proportion, each class present
 * keeping at least one square. The tasks in progress pulse when `animated`.
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
    // Adjusts to `squares`: takes from the biggest class, or gives back to it
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

/** One square per task (■), colored by class, in the order of the plan. @param {TaskView[]} ts @param {(t: TaskView) => number} classOf @returns {Line} */
function squares(ts, classOf) {
  /** @type {Line} */
  const l = []
  for (const t of ts) {
    const c = /** @type {typeof CLASSES[number]} */ (CLASSES[classOf(t)]).c
    const last = l[l.length - 1]
    if (last && last.c === c) last.t += '■'
    else l.push({ t: '■', c })
  }
  return l
}

/** The phases as dots: ● done, ◉ the run's, ○ amber one that waits, ○ to come; null beyond 10 phases. @param {PhaseView[]} phases @param {number | null} current @returns {Line | null} */
export function phaseDots(phases, current) {
  if (!phases.length || phases.length > 10) return null
  return phases.map(p => (p.total && p.done === p.total ? { t: '●', c: 'success' } : p.number === current ? { t: '◉', c: 'claude', b: true } : p.attention ? { t: '○', c: 'warning', b: true } : { t: '○', c: 'subtle' }))
}

// The status of a task closed, as progress.mjs writes it: "T01: merged (2 attempts)", "T02: failed, closed at the run end
// without a scribe — …", "T03: todo → merged (PROGRESS.md and git)" when it follows git again
const RE_STATUS = /^(\S+): (?:\S+ → )?(merged|needs-human|blocked|failed)\b/
// Glyph of a log entry, by its kind (contract orchestre-progress/3)
const KINDS = /** @type {Record<string, Piece>} */ ({
  run: { t: '▶', c: 'claude' }, task: { t: '▶', c: 'suggestion' }, step: { t: '·', d: true }, rejection: { t: '↻', c: 'merged' },
  status: { t: '●', c: 'success' }, added: { t: '+', c: 'suggestion' }, amendment: { t: '~', c: 'merged' }, review: { t: '⚑', c: 'warning' },
  'auto-decision': { t: '⇒', c: 'warning' }, issue: { t: '?', c: 'warning' }, ruling: { t: '✓', c: 'success' }, pilot: { t: '✎', c: 'suggestion' }, error: { t: '✗', c: 'error' },
  model: { t: '⇄', c: 'merged' },
})
/** Glyph and color of a log entry, from its kind and what it says. @param {{ kind: string, text: string }} j @returns {Piece} */
function mark(j) {
  // Anchored on what progress.mjs writes: the blocker, after "—", may say "merged" too
  if (j.kind === 'status') {
    const st = j.text.match(RE_STATUS)?.[2]
    return st === 'merged' ? { t: '✓', c: 'success' } : st === 'needs-human' ? { t: '⚑', c: 'warning' } : st ? { t: '✗', c: 'error' } : { t: '●', c: 'subtle' }
  }
  if (j.kind === 'run') return /^run \d+: finished\b/.test(j.text) ? { t: '✓', c: 'success' } : /^run \d+: (awaiting-ruling|partial|rerun)\b|^run \d+ interrupted\b/.test(j.text) ? { t: '■', c: 'warning' } : { t: '▶', c: 'claude' }
  return KINDS[j.kind] || { t: '·', d: true }
}
// What makes news at the end of the banner, from the most important to the least; not the steps nor the starts, which the
// banner already shows. A write of progress.json often notes several, at the same second: the most important wins, and
// the most recent at equal importance.
const NOTABLE_KINDS = ['status', 'run', 'error', 'ruling', 'issue', 'rejection', 'auto-decision', 'review', 'pilot', 'added']
/** The news in a few words, from the text progress.mjs writes in the log. @param {{ kind: string, text: string }} j */
function brief(j) {
  const t = j.text
  /** @type {RegExpMatchArray | null} */
  let m
  if (j.kind === 'run' && (m = t.match(/^run (\d+): phase (\d+), mode (\S+?),/))) return `run ${m[1]} started (phase ${m[2]}, mode ${m[3]})`
  if (j.kind === 'status' && (m = t.match(/^(\S+): (merged|needs-human|blocked|failed)(?: \((\d+) attempt|,)/))) {
    const [, id, st, n] = m
    return st === 'merged' ? `${id} merged${Number(n) > 1 ? ` at attempt ${n}` : ''}` : `${id} ${/** @type {Record<string, string>} */ (ATTENTION)[/** @type {string} */ (st)]}`
  }
  if (j.kind === 'rejection' && (m = t.match(/^(\S+): attempt (\d+) rejected \(([^)]+)\)/))) return `${m[1]}: attempt ${m[2]} rejected (${m[3]})`
  if (j.kind === 'review' && (m = t.match(/^(\S+): review/))) return `${m[1]}: to review before the PR`
  if (j.kind === 'auto-decision' && (m = t.match(/^(\S+):/))) return `${m[1]}: decision taken automatically`
  if (j.kind === 'ruling' && (m = t.match(/^(\S+): .* settled, option (\S+)/))) return `${m[1]}: issue settled (option ${m[2]})`
  return t
}
/**
 * The last news less than NEWS_MS old: a task closed, a run started or finished, a ruling, a rejection…
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

/** Glyph and color of a task; a task in progress spins when `animated`. @param {TaskView} t @param {boolean} active @param {number} [now] @param {boolean} [animated] @returns {Piece} */
export function glyph(t, active, now = 0, animated = false) {
  if (t.status === 'merged') return { t: '●', c: 'success' }
  if (t.status === 'cancelled') return { t: '–', d: true }
  if (active && t.step) return { t: animated ? spin(now) : '◐', c: 'suggestion', b: true }
  if (t.status === 'needs-human') return { t: '⚑', c: 'warning', b: true }
  if (t.status === 'blocked' || t.status === 'failed') return { t: '✗', c: 'error', b: true }
  return { t: '○', c: 'subtle' }
}
const STEPS = /** @type {Record<string, string>} */ ({ worker: 'work', verification: 'verification', evaluation: 'evaluation', fix: 'fix', merge: 'merge', replanning: 'replanning', progress: 'progress' })
// The step's slot in the banner: "verification +9"
const STEP_WIDTH = 15

/** What a task does, in a few words. @param {TaskView} t @param {boolean} active @param {boolean} [settled] */
export function what(t, active, settled = false) {
  if (active && t.step) return (STEPS[t.step] || t.step) + (t.attempts > 1 ? `, attempt ${t.attempts}` : '') + (t.isolated ? ' (worktree)' : '')
  if (t.status in ATTENTION && settled) return 'issue settled, restart pending'
  if (t.status in ATTENTION) return /** @type {Record<string, string>} */ (ATTENTION)[t.status] + (t.blocker[0] ? `: ${t.blocker[0]}` : '')
  if (t.status === 'merged') return t.attempts > 1 ? `${t.attempts} attempts` : ''
  return t.waiting.length ? `waits for ${t.waiting.slice(0, 4).join(', ')}${t.waiting.length > 4 ? '…' : ''}` : ''
}
/** The same in colors: the step in its color, the attempt in amber, the place dim. @param {TaskView} t @param {boolean} active @param {boolean} settled @param {number} n @returns {Line} */
function whatColored(t, active, settled, n) {
  if (active && t.step) {
    // Within n cells: the place goes first, then the attempt, then the step is cut
    const step = STEPS[t.step] || t.step, attempt = t.attempts > 1 ? ` attempt ${t.attempts}` : '', place = t.isolated ? ' (worktree)' : ''
    const fits = /** @param {string} x */ x => [...x].length <= n
    const shownPlace = fits(step + attempt + place) ? place : ''
    const shownAttempt = fits(step + attempt + shownPlace) ? attempt : ''
    /** @type {Line} */
    const l = [{ t: cut(step, n), c: STEP_COLOR[t.step] || 'subtle', b: true }]
    if (shownAttempt) l.push({ t: shownAttempt, c: 'warning' })
    if (shownPlace) l.push({ t: shownPlace, d: true })
    return l
  }
  const q = cut(what(t, active, settled), n)
  if (!q) return []
  return [{ t: q, c: settled ? 'subtle' : t.status === 'needs-human' ? 'warning' : t.status in ATTENTION ? 'error' : 'subtle' }]
}

/** Displayed width of a line, in cells (each of its glyphs takes one). @param {Line} l */
export const width = l => l.reduce((n, m) => n + [...m.t].length, 0)

/**
 * The banner above the prompt: one line, or nothing (null) when no run is to show. It fits in `columns` minus `reserve`
 * (the room of the buttons after it): the last news goes, then the detail of the step, then the labels and the bar get
 * shorter, then the duration and the run number, until it fits. The shortest shape takes about forty cells on a small
 * plan, about sixty at most on a big one; below that, the display cuts the end of the line. With `animated`, the head
 * spins and the tasks in progress pulse in the bar.
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
// From the fullest to the shortest
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
  const head = s.silent ? { t: '◌ ', c: 'warning' } : runLive ? { t: `${animated ? wheel(now) : '▶'} `, c: 'claude' } : run.status === 'finished' ? { t: '✓ ', c: 'success' } : { t: '■ ', c: 'warning' }
  const phase = runPhase(inst)
  /** @type {Line} */
  const l = [{ ...head, b: true }, ...(inst.demo ? [{ t: ' DEMO ', c: 'inverseText', f: 'merged', b: true }, { t: ' ' }] : []), { t: cut(inst.plan, f.name), b: true }, { t: '  ' }]
  const dots = phaseDots(s.phases, phase)
  if (dots) l.push(...dots)
  else l.push({ t: `phase ${phase}/${s.maxPhase}`, d: true })
  if (f.bar) l.push({ t: '  ' }, ...classBar(inst.tasks.filter(t => t.status !== 'cancelled'), classifier(inst, now), f.bar, now, animated))
  // Slots of fixed width: "2/5" takes the room of "5/5", the step in progress that of the longest; what follows does not
  // move when the step changes
  l.push({ t: `  ${String(s.done).padStart(String(s.total).length)}/${s.total}`, b: true })
  // What asks for someone comes right after the progress, before the tasks in progress whose text changes length: the
  // mentions do not move from one step to the next. They can be clicked (a: the pane card opened, k: the key of the
  // button); the glyph keeps the color.
  if (s.reviews) l.push({ t: '  ' }, { t: '⚑ ', c: 'warning' }, { t: `${s.reviews}${f.labels ? ' to review' : ''}`, a: 'yourTurn', k: 'review' })
  if (s.attention.length) l.push({ t: '  ' }, { t: '⚠ ', c: 'warning', b: true }, { t: `${s.attention.length}${f.labels ? ' your turn' : ''}`, a: 'yourTurn', k: 'your-turn' })
  const ec = s.inProgress
  if (runLive && f.step) {
    const t = ec[0], id = Math.min(8, Math.max(3, ...inst.tasks.map(x => [...x.id].length)))
    if (t) {
      const step = STEPS[t.step || ''] || String(t.step), plus = ec.length > 1 ? ` +${ec.length - 1}` : ''
      l.push({ t: `  ◐ ${column(t.id, id)} `, c: 'suggestion' }, { t: step, c: STEP_COLOR[t.step || ''] || 'subtle', b: true })
      if (plus) l.push({ t: plus, c: 'suggestion' })
      l.push({ t: ' '.repeat(Math.max(0, STEP_WIDTH - [...step].length - plus.length)) })
    } else l.push({ t: ' '.repeat(5 + id + STEP_WIDTH) })
  } else if (ec.length) l.push({ t: `  ◐ ${ec.length}${f.labels ? ' in progress' : ''}`, c: 'suggestion' })
  if (s.silent) l.push({ t: f.labels ? `  no news for ${duration(now - /** @type {number} */ (inst.updated))}` : `  ◌ ${duration(now - /** @type {number} */ (inst.updated))}`, c: 'warning' })
  else if (!runLive) l.push({ t: f.run ? `  run ${run.number} ${run.status}` : `  ${run.status}`, c: run.status === 'finished' ? 'success' : 'warning', b: true })
  if (f.duration) l.push({ t: `  ⏱ ${duration(s.duration)}`, d: true })
  const n = f.news ? news(inst, now) : null
  // The end of the run is already said by its status, just before
  if (n && !(n.kind === 'run' && !runLive)) {
    const fresh = n.age < NEWS_MS / 2
    l.push({ t: '   ' }, { ...n.mark, b: fresh, d: !fresh }, { t: ` ${cut(n.text, 44)}`, c: fresh ? n.mark.c : undefined, b: fresh, d: !fresh })
  }
  return l
}

/** The suffix of the spinner during an active run: " · T22 verification · 3 tasks in progress…". @param {Snapshot} inst @param {number} now */
export function suffix(inst, now) {
  const ts = inProgress(inst, now), t = ts[0]
  if (!t) return null
  return ` · ${t.id} ${STEPS[t.step || ''] || t.step} · ${plural(ts.length, 'task')} in progress…`
}

// ─── The pane: a view in cards ────────────────────────────────────────────────────────────────────────────────────
// In order: what waits for you (if anything), the run, the tasks as timelines, the log. In the pane, y, r, t and l scroll
// to a card; 1 to 9 act on the lines of "Your turn", c and p on what comes next after a finished run. An action only
// prepares a text in the prompt: nothing is sent without the person.

const MODES = /** @type {Record<string, string>} */ ({ auto: 'autonomous', deviation: 'stop on deviation', phase: 'stop at each phase' })
const SHORT_STEP = /** @type {Record<string, string>} */ ({ worker: 'work', verification: 'verif', evaluation: 'eval', fix: 'fix', merge: 'merge', replanning: 'replan', progress: 'prog' })
const STEP_ORDER = ['worker', 'verification', 'evaluation', 'fix', 'merge', 'replanning', 'progress']
// What progress.mjs writes in the log at each step: "T01 starts (worktree)" for the work (kind task), "T01: verification",
// "T01: fix (attempt 2)" for the next ones (kind step)
const RE_STEP = /^(\S+): (verification|evaluation|fix|merge|replanning|progress)(?: \(|$)/
const RE_STARTS = /^(\S+) starts \(/
export const SHORT_LOG = 6
const LONG_LOG = 60
// The pane loses its borders below this
const BORDER_COLUMNS = 60

/** Stopwatch: "0:42", "12:05", "1:02:03". @param {number | null} ms */
export function chrono(ms) {
  if (ms == null || ms < 0) return '—'
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}
/** The plan folder, for the commands offered. @param {Snapshot} inst */
const dirOf = inst => inst.dir || `plans/${inst.plan}`
/** @param {Line[]} parts @param {string} sep @returns {Line} */
const joinParts = (parts, sep) => parts.flatMap((p, i) => (i ? [{ t: sep, d: true }, ...p] : p))

/** The time of the last run: from its start to its end, or to now during an active run. @param {Snapshot} inst @param {number} now */
function runWindow(inst, now) {
  const r = inst.run
  if (!r || r.start == null) return null
  const endMark = r.end ?? (activeRun(inst, now) ? now : Math.max(r.start, inst.updated ?? r.start))
  return { start: r.start, end: Math.max(endMark, r.start + 1000) }
}
/** The run in which a task was closed. @param {Snapshot} inst @param {TaskView} t */
const runOf = (inst, t) => (t.end == null ? null : inst.runs.find(r => r.start != null && /** @type {number} */ (t.end) >= r.start && (r.end == null || /** @type {number} */ (t.end) <= r.end)) ?? null)

/**
 * The steps of a task during the last run, dated by the log: each lasts until the next one, the last one until the close
 * of the task, or until now if it still runs.
 * @param {Snapshot} inst @param {TaskView} t @param {number} now @returns {[number, number, string][]}
 */
export function stepsOf(inst, t, now) {
  const f = runWindow(inst, now)
  if (!f) return []
  /** @type {{ at: number, step: string }[]} */
  const marks = []
  for (const j of inst.log) {
    if (j.task !== t.id || j.at == null || j.at < f.start || j.at > f.end) continue
    const m = j.kind === 'step' ? j.text.match(RE_STEP) : null
    if (m) marks.push({ at: j.at, step: /** @type {string} */ (m[2]) })
    else if (j.kind === 'task' && RE_STARTS.test(j.text)) marks.push({ at: j.at, step: 'worker' })
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

/** The time spent in each step during the last run, all tasks included. @param {Snapshot} inst @param {number} now @returns {[string, number][]} */
export function timePerStep(inst, now) {
  const tot = /** @type {Record<string, number>} */ ({})
  for (const t of inst.tasks) for (const [a, b, e] of stepsOf(inst, t, now)) tot[e] = (tot[e] || 0) + (b - a)
  return STEP_ORDER.filter(e => tot[e]).map(e => [e, /** @type {number} */ (tot[e])])
}

/**
 * The timeline of a task over the time of the last run: one cell per slice of time, colored by step; the rest dotted.
 * The head of a task in progress pulses when `animated`.
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
    const last = l[l.length - 1]
    if (last && last.c === m.c && !(i === head || i === head + 1)) last.t += m.t
    else l.push(m)
  })
  return l
}

/** The phases as a timeline: ● done, ◉ in progress, ○ to come, joined by lines. @param {PhaseView[]} phases @param {number | null} cur @param {number} w @returns {Line} */
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
 * What waits for you, one line per thing, each with its action: the tasks that need a human, blocked or failed, the
 * issues to settle, the open prerequisites, plan-lint in error, then the reviews and the auto-decisions to check before
 * the PR. The first 9 have a key (1 to 9). null if there is nothing.
 * @param {Snapshot} inst @param {number} now @param {number} columns
 * @returns {(Card & { urgent: number }) | null}
 */
export function yourTurnCard(inst, now, columns) {
  const s = summarize(inst, now), dir = dirOf(inst), resume = `/orchestre:run ${dir} --resume`
  /** @type {{ g: Piece, text: string, detail?: string, prompt: string, help: string }[]} */
  const items = []
  const seen = new Set()
  for (const t of s.attention) {
    const p = inst.issues.find(x => x.task === t.id)
    if (p) seen.add(p)
    const reason = /** @type {Record<string, string>} */ (ATTENTION)[t.status]
    items.push(p || t.status === 'needs-human'
      ? { g: { t: '⚑', c: 'warning', b: true }, text: `${t.id} · ${p ? p.title : reason}${p?.human ? ' (human)' : ''}`, detail: t.blocker[0], prompt: resume, help: 'resume the run' }
      : { g: { t: '✗', c: 'error', b: true }, text: `${t.id} · ${reason}`, detail: t.blocker[0], prompt: `Explain the blocker of ${t.id}${t.blocker[0] ? ` (${t.blocker[0]})` : ''} and propose a way forward.`, help: 'ask the pilot' })
  }
  for (const p of inst.issues) if (!seen.has(p)) items.push({ g: { t: '?', c: 'warning', b: true }, text: `${p.task} · ${p.title}${p.human ? ' (human)' : ''}`, prompt: resume, help: 'settle when resuming' })
  for (const p of inst.prerequisites) items.push({ g: { t: '◇', c: 'warning', b: true }, text: `${p.id} (${p.type}) open${p.blocks.length ? `, blocks ${p.blocks.slice(0, 4).join(', ')}` : ''}`, prompt: `/orchestre:ready ${dir}`, help: 'settle the prerequisites' })
  if (!inst.lint.ok) items.push({ g: { t: '✗', c: 'error', b: true }, text: `plan-lint: ${plural(inst.lint.errors, 'error')} at the last progress update`, prompt: `Show me the plan-lint errors on ${dir} and propose a fix.`, help: 'ask the pilot' })
  const urgent = items.length
  for (const r of inst.reviews) items.push({ g: { t: '⚑', c: 'warning' }, text: `${r.task ?? 'source plan'} · ${r.text}`, prompt: `Review with me, before the PR (review of ${r.task ?? 'source plan'}): ${r.text}`, help: 'review' })
  for (const d of inst.decisions) items.push({ g: { t: '⇒', c: 'merged' }, text: `${d.task} · ${d.title}: ${d.option}${d.description ? ` (${d.description})` : ''}`, prompt: `Go over the auto-decision for ${d.task} with me: "${d.title}", option ${d.option}${d.description ? ` (${d.description})` : ''}.`, help: 'go over' })
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
    urgent ? `${urgent} to settle` : '',
    inst.reviews.length ? plural(inst.reviews.length, 'review') : '',
    inst.decisions.length ? plural(inst.decisions.length, 'auto-decision') : '',
  ].filter(Boolean).join(' · ')
  return {
    id: 'yourTurn', color: 'warning', urgent,
    title: [{ t: urgent ? '⚠ Your turn' : '⚑ To review before the PR', c: 'warning', b: true }],
    meta: [{ t: count, d: true }],
    lines,
  }
}

/**
 * The last run: phases as a timeline, bar by status with its counts, duration, time per step, and what comes next when it
 * is finished (resume, or the PR draft when the plan is finished).
 * @param {Snapshot} inst @param {number} now @param {number} columns @param {boolean} animated @returns {Card}
 */
export function runCard(inst, now, columns, animated) {
  const s = summarize(inst, now), r = inst.run, inner = columns - 4, dir = dirOf(inst)
  if (!r) return { id: 'run', color: 'subtle', title: [{ t: 'No run yet', b: true }], meta: [], lines: [[{ t: `The first /orchestre:run ${dir} will open it.`, d: true }]] }
  const cur = runPhase(inst), runLive = r.status === 'in-progress'
  const color = runLive ? (s.silent ? 'warning' : 'claude') : r.status === 'finished' ? 'success' : r.status === 'error' ? 'error' : 'warning'
  const activeTasks = inst.tasks.filter(t => t.status !== 'cancelled'), classOf = classifier(inst, now)
  const n = [0, 0, 0, 0, 0]
  for (const t of activeTasks) { const i = classOf(t); n[i] = (n[i] ?? 0) + 1 }
  const within = /** @param {{ at: number | null }} j */ j => j.at != null && r.start != null && j.at >= r.start && (r.end == null || j.at <= r.end)
  // The extra attempts of the tasks started in this run (a rejection by the evaluation or the verification is worth one)
  const retries = inst.tasks.filter(t => t.start != null && r.start != null && t.start >= r.start).reduce((k, t) => k + Math.max(0, t.attempts - 1), 0)
  const autoCount = inst.log.filter(j => j.kind === 'auto-decision' && within(j)).length
  /** @type {Line[]} */
  const lines = [
    [{ t: 'phases  ', d: true }, ...phaseTimeline(s.phases, cur, Math.max(8, Math.min(40, inner - 24))), ...(s.phases.length <= 10 ? [{ t: `   phase ${cur}/${s.maxPhase}`, d: true }] : [])],
    [{ t: 'tasks   ', d: true }, ...classBar(activeTasks, classOf, Math.max(8, Math.min(30, inner - 36)), now, animated), { t: `  ${s.done}/${s.total}`, b: true },
      ...n.flatMap((k, i) => (k ? [{ t: '   ■', c: /** @type {typeof CLASSES[number]} */ (CLASSES[i]).c }, { t: ` ${k}` }] : []))],
    [{ t: 'time    ', d: true }, { t: duration(s.duration) }, ...(r.parallelism ? [{ t: ` · ${r.parallelism} in parallel`, d: true }] : []), ...(retries ? [{ t: ' · ', d: true }, { t: `${retries} more ${retries > 1 ? 'attempts' : 'attempt'}` }] : []), ...(autoCount ? [{ t: ' · ', d: true }, { t: plural(autoCount, 'auto-decision') }] : [])],
  ]
  const steps = timePerStep(inst, now)
  if (steps.length) lines.push([{ t: 'steps   ', d: true }, ...joinParts(steps.map(([e, ms]) => [{ t: `${SHORT_STEP[e] || e} ${chrono(ms)}`, c: STEP_COLOR[e] || 'subtle' }]), ' · ')])
  if (!runLive && r.detail) lines.push([{ t: 'detail  ', d: true }, { t: cut(r.detail, Math.max(16, inner - 10)) }])
  if (!runLive) {
    lines.push(s.allMerged
      ? [{ t: 'next    ', d: true }, { t: 'PR draft in the prompt', x: { hotkey: 'p', prompt: prText(inst, now), help: 'prepare the PR' } }]
      : [{ t: 'next    ', d: true }, { t: `/orchestre:run ${dir} --resume`, x: { hotkey: 'c', prompt: `/orchestre:run ${dir} --resume`, help: 'resume the run' } }, { t: '  in the prompt', d: true }])
  }
  const marker = runLive ? '' : r.status === 'finished' ? '✓ ' : r.status === 'error' ? '✗ ' : '■ '
  return {
    id: 'run', color,
    title: [{ t: `${marker}Run ${r.number} · ${phasesLabel(r.phase, cur ?? r.phase)} · ${MODES[r.mode] || r.mode}`, c: color, b: true }],
    meta: runLive
      ? (s.silent ? [{ t: `◌ no news for ${duration(now - /** @type {number} */ (inst.updated))}`, c: 'warning' }] : [{ t: `◐ ${s.inProgress.length} in progress`, c: 'suggestion' }])
      : [{ t: r.status, c: color, b: true }],
    lines,
  }
}

// The model column, in the task lines: 14 cells hold "haiku → sonnet"
const MODEL_WIDTH = 14
/**
 * The model of a task (0.11.0): the model used, or "planned → used" when they differ ("—" if the plan plans none); before
 * the worker, the planned model, dim. Empty if nothing is known.
 * @param {TaskView} t @returns {Line}
 */
export function modelOf(t) {
  if (!t.modelUsed) return t.model ? [{ t: t.model, d: true }] : []
  if (t.modelUsed === t.model) return [{ t: t.modelUsed, c: 'subtle' }]
  return [{ t: `${t.model ?? '—'} → `, d: true }, { t: t.modelUsed, c: 'merged', b: true }]
}
/** The model cell, cut and padded to n cells, followed by two spaces; nothing if n is 0. @param {TaskView} t @param {number} n @returns {Line} */
function modelCell(t, n) {
  if (!n) return []
  /** @type {Line} */
  const l = []
  let rest = n
  // Cut only if it is too long: cut() would remove the space after the arrow
  for (const m of modelOf(t)) { if (rest <= 0) break; const x = [...m.t].length > rest ? cut(m.t, rest) : m.t; l.push({ ...m, t: x }); rest -= [...x].length }
  return [...l, { t: ' '.repeat(Math.max(0, rest) + 2) }]
}

/**
 * The tasks: one line per phase (one square per task), then, under the phases where something happens, one line per task
 * with its timeline over the time of the last run, its duration and what it does. A task closed in an earlier run keeps a
 * short line; the tasks to do of the current phase are capped at 6.
 * @param {Snapshot} inst @param {number} now @param {number} columns @param {boolean} [animated] @returns {Line[]}
 */
export function taskLines(inst, now, columns, animated = false) {
  const s = summarize(inst, now), live = !!s.run, f = runWindow(inst, now)
  const cur = live ? runPhase(inst) : s.current?.number ?? null
  const classOf = classifier(inst, now)
  // Model column (0.11.0): as wide as the longest known model, taken from the timeline then from the title, so that what
  // the task does keeps its room (30 cells when the width allows it, 20 at least); absent if no model is known, or if it
  // does not fit. The timeline gets its 26 cells back as soon as there is room
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
    const ts = inst.tasks.filter(t => t.phase === p.number && t.status !== 'cancelled')
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
      if (justMerged(t)) line.push({ t: ' merged ', c: 'inverseText', f: 'success', b: true })
      else line.push(...whatColored(t, live, ruled(inst, t), QW))
      out.push(line)
    }
    // The planned model, in the same column as the detailed lines (in place of the duration, empty)
    for (const t of todo.slice(0, 6)) out.push([{ t: '  ' }, glyph(t, live), { t: ` ${column(t.id, 6)}${column(t.title, titleWidth)} `, d: true }, { t: '·'.repeat(W), c: 'subtle' }, ...(MW ? [{ t: ' '.repeat(11) }, ...modelCell(t, MW)] : [{ t: '  ' }]), { t: cut(what(t, live), MW ? QW : Math.max(10, columns - titleWidth - W - 14)), d: true }])
    if (todo.length > 6) out.push([{ t: `    ○ ${todo.length - 6} more to do`, d: true }])
  }
  if (!out.length) return [[{ t: 'No task in progress.json.', d: true }]]
  if (segments) out.push([{ t: ' '.repeat(10 + titleWidth) }, ...joinParts(STEP_ORDER.slice(0, 5).map(e => [{ t: '━', c: STEP_COLOR[e] }, { t: ` ${SHORT_STEP[e]}`, d: true }]), ' ')])
  return out
}

/** The log in columns: age, colored source, message; the last entries, or all of them with `full`. @param {Snapshot} inst @param {number} now @param {number} columns @param {boolean} full @returns {Card} */
export function logCard(inst, now, columns, full) {
  const inner = columns - 4
  const js = inst.log.slice(-(full ? LONG_LOG : SHORT_LOG))
  const lines = js.length
    ? js.map(j => { const m = mark(j); return [{ t: age(j.at, now).padStart(6), d: true }, { t: '  ' }, { t: column(j.task ?? (j.kind === 'run' || j.kind === 'error' ? 'run' : 'plan'), 6), c: m.c, d: m.d, b: !m.d }, m, { t: ` ${cut(j.text, Math.max(16, inner - 18))}` }] })
    : [[{ t: 'Empty log.', d: true }]]
  const rest = inst.log.length - js.length
  return { id: 'log', color: 'subtle', title: [{ t: 'log', b: true }], meta: [{ t: full ? 'l: less' : rest > 0 ? `l: all (${inst.log.length})` : '', d: true }], lines }
}

/**
 * What changed since `t0` (your last visit), from the log: tasks merged, tasks that started to wait for you, run ends,
 * reviews. null if nothing happened, or if it was less than a minute ago.
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
    if (j.kind === 'status' && (m = j.text.match(/^(\S+): (merged|needs-human|blocked|failed)/))) {
      if (m[2] === 'merged') merges.push(/** @type {string} */ (m[1]))
      else if (waitingIds.has(/** @type {string} */ (m[1])) && !waiting.includes(/** @type {string} */ (m[1]))) waiting.push(/** @type {string} */ (m[1]))
    }
    if ((j.kind === 'run' || j.kind === 'error') && (m = j.text.match(/^run (\d+): (finished|awaiting-ruling|partial|rerun|error)/))) runs.push(`run ${m[1]} ${m[2]}`)
    if (j.kind === 'review') reviews++
  }
  /** @type {Line[]} */
  const parts = []
  if (merges.length) parts.push([{ t: `✓ ${merges.slice(0, 6).join(' ')}${merges.length > 6 ? '…' : ''} merged`, c: 'success' }])
  if (waiting.length) parts.push([{ t: `⚠ ${waiting.slice(0, 4).join(' ')} ${waiting.length > 1 ? 'wait for you' : 'waits for you'}`, c: 'warning', b: true }])
  if (reviews) parts.push([{ t: `⚑ ${plural(reviews, 'review')}`, c: 'warning' }])
  if (runs.length) parts.push([{ t: /** @type {string} */ (runs.at(-1)) }])
  if (!parts.length) return null
  return [{ t: '↩ ', c: 'claude', b: true }, { t: `While you were away (${duration(now - t0)})`, b: true }, { t: ': ' }, ...joinParts(parts, ' · ')]
}

/**
 * The whole pane: a header (overall state, legend, legend of the demo, what changed since the last visit), then the
 * cards. Below BORDER_COLUMNS columns, the cards lose their border.
 * @param {Snapshot} inst @param {number} now @param {number} columns
 * @param {{ animated?: boolean, fullLog?: boolean, since?: number | null }} [options]
 * @returns {{ header: Line[], cards: Card[], borders: boolean }}
 */
export function pane(inst, now, columns, { animated = false, fullLog = false, since: t0 = null } = {}) {
  const s = summarize(inst, now), r = inst.run
  const yourTurn = yourTurnCard(inst, now, columns)
  /** @type {Piece} */
  const state = !r ? { t: 'NO RUN', d: true }
    : s.allMerged && r.status !== 'in-progress' ? { t: 'PLAN FINISHED', c: 'success', b: true }
    : s.silent ? { t: `RUN ${r.number} NO NEWS`, c: 'warning', b: true }
    : { t: `RUN ${r.number} ${r.status === 'in-progress' ? 'IN PROGRESS' : r.status.toUpperCase()}`, c: r.status === 'in-progress' ? 'claude' : r.status === 'finished' ? 'success' : r.status === 'error' ? 'error' : 'warning', b: true }
  /** @type {Piece | null} */
  const endMark = yourTurn && yourTurn.urgent ? { t: ` ⚠ ${yourTurn.urgent} YOUR TURN `, c: 'inverseText', f: 'warning', b: true }
    : s.reviews ? { t: `⚑ ${s.reviews} TO REVIEW`, c: 'warning', b: true }
    : s.inProgress.length ? { t: `◐ ${s.inProgress.length} IN PROGRESS`, c: 'suggestion' } : null
  /** @type {Line[]} */
  const header = [
    [...(inst.demo ? [{ t: ' DEMO ', c: 'inverseText', f: 'merged', b: true }, { t: ' ' }] : []), { t: 'ORCHESTRE', c: 'claude', b: true }, { t: ' · ', d: true }, { t: cut(inst.plan.toUpperCase(), 30), b: true }, { t: ' · ', d: true }, state, ...(endMark ? [{ t: ' · ', d: true }, endMark] : [])],
    [{ t: '■', c: 'success' }, { t: ' merged  ', d: true }, { t: '■', c: 'suggestion' }, { t: ' in progress  ', d: true }, { t: '■', c: 'warning' }, { t: ' waits for a human  ', d: true }, { t: '■', c: 'error' }, { t: ' blocked  ', d: true }, { t: '░', c: 'subtle' }, { t: ' to do', d: true }],
  ]
  // The legend of the demo: the frame, then what to try
  if (inst.legend) for (const [i, line] of inst.legend.split('\n').entries()) header.push([{ t: cut(line, Math.max(20, columns - 2)), c: 'merged', b: i === 0 }])
  const away = since(inst, t0, now)
  if (away) header.push(away)
  /** @type {Card[]} */
  const cards = []
  if (yourTurn) cards.push(yourTurn)
  cards.push(runCard(inst, now, columns, animated))
  cards.push({ id: 'tasks', color: null, title: [{ t: 'tasks', b: true }, { t: ` · ${s.inProgress.length} in progress · ${s.total} in total`, d: true }], meta: [], lines: taskLines(inst, now, columns, animated) })
  cards.push(logCard(inst, now, columns, fullLog))
  return { header, cards, borders: columns >= BORDER_COLUMNS }
}

/** The status line when the banner is hidden and something is left to do: "orchestre ✓ 5/5 · ⚑ 3". @param {Snapshot} inst @param {number} now */
export function statusLine(inst, now) {
  const s = summarize(inst, now)
  if (s.allMerged && !s.reviews && !s.attention.length) return null
  return `orchestre ${s.allMerged ? '✓' : '■'} ${s.done}/${s.total}${s.reviews ? ` · ⚑ ${s.reviews}` : ''}${s.attention.length ? ` · ⚠ ${s.attention.length}` : ''}`
}

/** A line as plain text. @param {Line} l */
export const plainText = l => l.map(m => m.t).join('').replace(/\s+$/, '')

/** The state as text, where nothing is drawn (`/progress text`, pane refused): the banner, then the cards. @param {Snapshot} inst @param {number} now */
export function stateText(inst, now) {
  const b = banner(inst, now, 120)
  const out = [b ? plainText(b) : `${inst.plan}: no run noted in progress.json`]
  for (const c of pane(inst, now, 104).cards) {
    out.push('', plainText([...c.title, ...(c.meta.length ? [{ t: '   ' }, ...c.meta] : [])]))
    for (const l of c.lines) out.push(plainText(l))
  }
  return out.join('\n')
}

/** Draft of a PR description, put in the prompt, never sent. @param {Snapshot} inst @param {number} now */
export function prText(inst, now) {
  const s = summarize(inst, now)
  const l = [`Plan ${inst.plan}: ${s.done}/${s.total} tasks merged, ${plural(inst.runs.length, 'run')}.`, '']
  if (inst.reviews.length) {
    l.push('To review before merging (files and commands forbidden to the agents):')
    for (const r of inst.reviews) l.push(`- ${r.task ?? 'source plan'}: ${r.text}`)
    l.push('')
  }
  if (inst.decisions.length) {
    l.push('Decisions taken automatically (autonomous mode):')
    for (const d of inst.decisions) l.push(`- ${d.task}, ${d.title}: option ${d.option}, ${d.description}`)
    l.push('')
  }
  if (s.attention.length) l.push(`Not merged yet: ${s.attention.map(t => `${t.id} (${ATTENTION[/** @type {keyof typeof ATTENTION} */ (t.status)]})`).join(', ')}.`, '')
  if (inst.tickets) l.push(`${plural(inst.tickets, 'ticket')} to open after the PR (HANDOFF.md, "ticket" entries).`)
  // One end of line at the end, whatever the last part
  return l.join('\n').replace(/\n*$/, '\n')
}

/** A notification that asks for someone: task that needs a human, blocked or failed, run stopped or in error. @param {string} m */
export const isImportant = m => / waits for a human$|^✗ |^Run stopped|\): error/.test(m)

/**
 * What deserves a notification between two reads: run started or finished, phase finished, task that needs a human,
 * blocked or failed, new review, stop issue. Nothing at the first read.
 * @param {Snapshot | null} before @param {Snapshot} after @returns {string[]}
 */
export function changes(before, after) {
  if (!before || before.plan !== after.plan) return []
  /** @type {string[]} */
  const m = []
  const ra = before.run, rb = after.run
  if (rb && (!ra || rb.number !== ra.number)) m.push(`Run ${rb.number} started: phase ${rb.phase}, mode ${rb.mode}`)
  if (rb && ra && rb.number === ra.number && ra.status === 'in-progress' && rb.status !== 'in-progress') m.push(`Run ${rb.number} (${phasesLabel(rb.phase, runPhase(after) ?? rb.phase)}): ${rb.status}${rb.detail ? `, ${cut(rb.detail, 80)}` : ''}`)
  const beforeById = new Map(before.tasks.map(t => [t.id, t]))
  for (const t of after.tasks) {
    const a = beforeById.get(t.id)
    if (a && a.status !== t.status && t.status in ATTENTION) m.push(`${t.status === 'needs-human' ? '⚑' : '✗'} ${t.id} ${ATTENTION[/** @type {keyof typeof ATTENTION} */ (t.status)]}`)
  }
  const finished = /** @param {Snapshot} i @param {number} n */ (i, n) => { const ts = i.tasks.filter(t => t.phase === n && t.status !== 'cancelled'); return ts.length > 0 && ts.every(isMerged) }
  for (const n of [...new Set(after.tasks.map(t => t.phase))]) if (finished(after, n) && !finished(before, n)) m.push(`Phase ${n} finished`)
  // One notification per task, whatever the number of reviews a close brings
  const newOnes = /** @type {Map<string, number>} */ (new Map())
  for (const r of after.reviews.slice(before.reviews.length)) newOnes.set(r.task ?? 'source plan', (newOnes.get(r.task ?? 'source plan') || 0) + 1)
  for (const [who, k] of newOnes) m.push(`⚑ ${who}: ${k > 1 ? `${k} reviews` : 'to review'} before the PR`)
  // An issue becomes the stop issue at the end of the run (the run end notes it with the role "stop"): the role is part of the key
  const itemKey = /** @param {{ task: string, title: string, role: string }} p */ p => `${p.task}\u0000${p.title}\u0000${p.role}`
  const seen = new Set(before.issues.map(itemKey))
  for (const p of after.issues) if (p.role === 'stop' && !seen.has(itemKey(p))) m.push(`Run stopped: ${p.task}, ${cut(p.title, 80)}`)
  return m
}
