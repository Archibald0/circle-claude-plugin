// @ts-check
// View model of the orchestre progress mod: reads plans/<name>/progress.json (contract orchestre-progress/4 or /3, written by
// scripts/progress.mjs of the orchestre plugin) and draws from it what the mod shows. Pure functions, without `$`:
// register.tsx deals with the engine (files, timer, drawing), tests/mod-progress.test.mjs checks them under Node.

/** @typedef {import('../types/index.d.ts').Snapshot} Snapshot */
/** @typedef {import('../types/index.d.ts').TaskView} TaskView */
/** @typedef {import('../types/index.d.ts').PhaseView} PhaseView */
/** @typedef {import('../types/index.d.ts').RunView} RunView */
/** @typedef {import('../types/index.d.ts').Piece} Piece */
/** @typedef {import('../types/index.d.ts').Line} Line */
/** @typedef {import('../types/index.d.ts').Card} Card */
/** @typedef {import('../types/index.d.ts').YourTurnItem} YourTurnItem */
/** @typedef {import('../types/index.d.ts').IssueView} IssueView */
/** @typedef {import('../types/index.d.ts').IssueOptionView} IssueOptionView */
/** @typedef {import('../types/index.d.ts').LastAction} LastAction */

export const FORMAT = 'orchestre-progress/4'
// The formats this mod reads: /4, which progress.mjs writes since 0.20.0, and /3 (0.12.0 to 0.19), which it converts at its next
// write; the fields read here are the same in both. The French formats of 0.11 and earlier (suivi.json) are converted by
// scripts/migrate.mjs, and progress.mjs converts a progress.json still in one of them at its next write
export const FORMATS = [FORMAT, 'orchestre-progress/3']
// What progress.mjs convertV3 gives a /3 issue: without_actions, and each option invalid for `rule` with this reason (same text as
// INHERITED in scripts/progress.mjs, which a mod does not import)
const INHERITED_V3 = 'inherited from orchestre-progress/3 without its actions: settle it with a free answer'
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

/** Closed by the pilot: done (0.15.1) or moved to tickets (0.16.0); null while it waits. @param {Record<string, any>} x */
const closedAs = x => (x.done ? 'done' : x.ticket ? 'ticket' : null)
/** The text the pilot gave it (0.16.0), or null. @param {Record<string, any>} x */
const labelOf = x => (typeof x.label === 'string' && x.label.trim() ? x.label : null)
/** @param {Record<string, any>} raw @returns {Record<string, any>[]} */
const reviewsOf = raw => (Array.isArray(raw.reviews) ? raw.reviews : []).filter(isObject)
/** @param {Record<string, any>} raw @returns {Record<string, any>[]} */
const decisionsOf = raw => (Array.isArray(raw.auto_decisions) ? raw.auto_decisions : []).filter(isObject)

/** Format declared by a progress.json, or null. @param {unknown} raw */
export const formatOf = raw => (isObject(raw) && typeof raw.format === 'string' ? raw.format : null)

// The ids progress.mjs convertV3 gives the issues of a /3 file: <task>-<n> in the order of the file, settled ones counted,
// an id already there kept. The same ids as the file progress.mjs writes, so that a ruling (rule) can name the issue
const idsV3 = list => { const n = new Map(); return list.map(p => { const t = isObject(p) ? p.task : undefined; n.set(t, (n.get(t) || 0) + 1); return isObject(p) && Object.hasOwn(p, 'id') ? p.id : `${t}-${n.get(t)}` }) }

// The rulings recorded and not applied yet (/4 pending_rulings; absent in /3): { issue, option | null, text | null, at }
const pendingRulings = raw => (Array.isArray(raw.pending_rulings) ? raw.pending_rulings : []).filter(r => isObject(r) && typeof r.issue === 'string').map(r => ({ issue: /** @type {string} */ (r.issue), option: typeof r.option === 'string' ? r.option : null, text: typeof r.text === 'string' ? r.text : null, at: r.at }))

// The entries of the issue register (ISSUES.json, orchestre-issues/1) the mod could read; null: not read (absent from the
// call, or not JSON), then nothing is said of the register
/** @param {unknown} reg @returns {Record<string, unknown>[] | null} */
const registerEntries = reg => (isObject(reg) && Array.isArray(reg.issues) ? reg.issues.filter(isObject) : null)

/**
 * progress.json (orchestre-progress/4 or /3) → what the mod shows; null if the format is not one of these.
 * Unknown fields are ignored, missing fields taken empty: a reader only refuses the format.
 * register (0.21.0): ISSUES.json, read by register.tsx next to progress.json (an absent file: an empty register). It only
 * says which issues have an entry (the options of one without an entry cannot be applied, apply refuses them) and which are
 * settled or dropped; the issues shown still come from progress.json alone, as in status.mjs and progress.mjs status.
 * @param {unknown} raw @param {unknown} [register] @returns {Snapshot | null}
 */
export function normalize(raw, register = undefined) {
  if (!isObject(raw) || !FORMATS.includes(/** @type {string} */ (raw.format)) || !Array.isArray(raw.tasks)) return null
  const rulings = pendingRulings(raw)
  const v3 = raw.format === 'orchestre-progress/3'
  const issuesIn = Array.isArray(raw.issues) ? raw.issues : []
  const ids3 = v3 ? idsV3(issuesIn) : []
  const entries = registerEntries(register)
  const listed = issuesIn.map((p, i) => ({ p, id: v3 ? ids3[i] : isObject(p) ? p.id : null }))
  const runs = (Array.isArray(raw.runs) ? raw.runs : []).filter(isObject)
  const lastRun = runs.length ? runs[runs.length - 1] : null
  /** @type {TaskView[]} */
  const tasks = raw.tasks.filter(isObject).map(t => ({
    id: text(t.id), title: text(t.title) || text(t.id), phase: integer(t.phase, 1),
    status: STATUSES.includes(t.status) ? t.status : 'todo', attempts: integer(t.attempts, 0),
    step: typeof t.step === 'string' ? t.step : null, isolated: t.isolated === true,
    // The rejections of the attempts (the challenger's gap is the mutation that went through, 0.22.0)
    rejections: (Array.isArray(t.rejections) ? t.rejections : []).filter(isObject).map(x => ({ attempt: integer(x.attempt, 0), by: text(x.by), gaps: texts(x.gaps) })),
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
    // Closed by the pilot ([ Close the plan ], 0.16.1): nothing shows for it any more, unless it is asked for
    planClosed: date(raw.closed),
    tasks,
    runs: runs.map(runView),
    run: lastRun ? runView(lastRun) : null,
    // Reviews and auto-decisions marked done (/orchestre:done, 0.15.1) or moved to tickets (0.16.0) no longer wait; their
    // text shown is the label the pilot gave, if any (0.16.0)
    reviews: reviewsOf(raw).filter(r => !closedAs(r)).map(r => ({ task: r.task == null ? null : text(r.task), phase: Number.isInteger(r.phase) ? r.phase : null, text: text(r.text), at: date(r.at), label: labelOf(r) })),
    decisions: decisionsOf(raw).filter(d => !closedAs(d)).map(d => ({ task: text(d.task), title: text(d.title), option: text(d.option), description: text(d.description), label: labelOf(d) })),
    closed: [
      ...reviewsOf(raw).filter(closedAs).map(r => ({ kind: /** @type {const} */ ('review'), task: r.task == null ? null : text(r.task), text: text(r.text), shown: labelOf(r) ?? text(r.text), as: /** @type {'done' | 'ticket'} */ (closedAs(r)) })),
      ...decisionsOf(raw).filter(closedAs).map(d => ({ kind: /** @type {const} */ ('decision'), task: text(d.task), text: text(d.title), shown: labelOf(d) ?? `${text(d.title)}: option ${text(d.option)}, ${text(d.description)}`, as: /** @type {'done' | 'ticket'} */ (closedAs(d)) })),
    ],
    // An issue whose ruling is recorded (/4, rule) and not applied yet no longer waits for the user: the same filter as
    // progress.mjs status and status.mjs. /3 has no pending_rulings: nothing is filtered; its ids are those of convertV3
    // 0.21.0: recommended on each option, holds (the tasks the issue holds, emptied by release), until (the deadline of the wait),
    // waiting (the tasks that wait for it now), startedWithout, released and, with the register, entry
    issues: listed.filter(({ p, id }) => isObject(p) && p.status !== 'settled' && !rulings.some(r => r.issue === id)).map(({ p, id }) => ({ id: id == null ? null : text(id), task: text(p.task), title: text(p.title), human: p.human === true, role: text(p.role), withoutActions: v3 || p.without_actions === true, holds: v3 ? [] : texts(p.holds), until: v3 ? null : date(p.until), waiting: v3 ? [] : texts(p.waiting), startedWithout: v3 ? [] : texts(p.started_without), released: !v3 && p.released != null, ...(entries ? { entry: entries.some(e => e.id === id) } : {}), options: (Array.isArray(p.options) ? p.options : []).filter(isObject).map(o => ({ id: text(o.id), description: text(o.description), recommended: o.recommended === true, valid: v3 ? false : typeof o.valid === 'boolean' ? o.valid : null, invalidReason: v3 ? INHERITED_V3 : o.invalid_reason == null ? null : text(o.invalid_reason), effect: text(o.effect), amends: texts(o.amends) })) })),
    pendingRulings: rulings.map(r => ({ issue: r.issue, option: r.option, text: r.text, at: date(r.at) })),
    // The issues settled: their copy in progress.json, or their entry in the register (settled or dropped). What turns
    // "last: <id> · option A recorded" into "applied" once its ruling left pendingRulings (never ruling.commit, null)
    settledIssues: [...new Set([...listed.filter(({ p, id }) => isObject(p) && p.status === 'settled' && id != null).map(({ id }) => text(id)), ...(entries ?? []).filter(e => e.status === 'settled' || e.status === 'dropped').map(e => text(e.id))])],
    // The prerequisites noted done by did (0.21.0, [ ✓ I did it ]) that apply has not written yet; day: the date of at, as
    // progress.mjs says it
    pendingDone: (Array.isArray(raw.pending_done) ? raw.pending_done : []).filter(x => isObject(x) && typeof x.prerequisite === 'string').map(x => ({ prerequisite: /** @type {string} */ (x.prerequisite), day: text(x.at).slice(0, 10) })),
    // Its text, evidence and steps (0.17.0): what the detail card says there is to do
    prerequisites: (Array.isArray(raw.prerequisites) ? raw.prerequisites : []).filter(p => isObject(p) && p.status === 'open').map(p => ({ id: text(p.id), type: text(p.type), text: text(p.text), evidence: text(p.evidence), how: texts(p.how), blocks: texts(p.blocks) })),
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
/**
 * A run in progress that started at or after `since` (the start of the session): the first one opens the pane by itself
 * (0.13.0). A run started before, left in progress by another session or interrupted, does not. @param {Snapshot | null} inst
 * @param {number} since
 */
export const runStartedSince = (inst, since) => { const r = inst && !inst.demo ? runInProgress(inst) : null; return !!r && r.start != null && r.start >= since }
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
    reviews: distinctReviews(inst.reviews).length, attention, run,
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
const plural = (n, word, many = `${word}s`) => `${n} ${n > 1 ? many : word}`
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
const STEP_COLOR = /** @type {Record<string, string>} */ ({ worker: 'suggestion', verification: 'merged', evaluation: 'planMode', challenge: 'claude', fix: 'warning', merge: 'success', replanning: 'subtle', progress: 'subtle' })
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
// Glyph of a log entry, by its kind (contract orchestre-progress/4: the kinds of /3, and wait since 0.21.0)
const KINDS = /** @type {Record<string, Piece>} */ ({
  run: { t: '▶', c: 'claude' }, task: { t: '▶', c: 'suggestion' }, step: { t: '·', d: true }, rejection: { t: '↻', c: 'merged' },
  status: { t: '●', c: 'success' }, added: { t: '+', c: 'suggestion' }, amendment: { t: '~', c: 'merged' }, review: { t: '⚑', c: 'warning' },
  'auto-decision': { t: '⇒', c: 'warning' }, issue: { t: '?', c: 'warning' }, ruling: { t: '✓', c: 'success' }, pilot: { t: '✎', c: 'suggestion' }, error: { t: '✗', c: 'error' },
  model: { t: '⇄', c: 'merged' },
  // A task waits for rulings (0.21.0); "‖", not "⏸", which can be drawn as an emoji
  wait: { t: '‖', c: 'warning' },
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
const NOTABLE_KINDS = ['status', 'run', 'error', 'ruling', 'issue', 'wait', 'rejection', 'auto-decision', 'review', 'pilot', 'added']
/**
 * A rejection by the challenger (0.22.0): "T01: attempt 1 rejected by the challenge: <mutation>", the mutation being the first
 * gap of that rejection. null for another rejection, or when the task carries no such gap: the usual text stays.
 * @param {Snapshot} inst @param {string} id @param {string} attempt @param {string} by @returns {string | null}
 */
function challenged(inst, id, attempt, by) {
  if (by !== 'challenge') return null
  const gap = inst.tasks.find(t => t.id === id)?.rejections.find(r => r.by === 'challenge' && r.attempt === Number(attempt))?.gaps[0]
  return gap ? `${id}: attempt ${attempt} rejected by the challenge: ${gap}` : null
}
/** The news in a few words, from the text progress.mjs writes in the log. @param {{ kind: string, text: string, task?: string | null }} j @param {Snapshot} inst */
function brief(j, inst) {
  const t = j.text
  /** @type {RegExpMatchArray | null} */
  let m
  if (j.kind === 'run' && (m = t.match(/^run (\d+): phase (\d+), mode (\S+?),/))) return `run ${m[1]} started (phase ${m[2]}, mode ${m[3]})`
  if (j.kind === 'status' && (m = t.match(/^(\S+): (merged|needs-human|blocked|failed)(?: \((\d+) attempt|,)/))) {
    const [, id, st, n] = m
    return st === 'merged' ? `${id} merged${Number(n) > 1 ? ` at attempt ${n}` : ''}` : `${id} ${/** @type {Record<string, string>} */ (ATTENTION)[/** @type {string} */ (st)]}`
  }
  if (j.kind === 'rejection' && (m = t.match(/^(\S+): attempt (\d+) rejected \(([^)]+)\)/))) return challenged(inst, m[1], m[2], m[3]) ?? `${m[1]}: attempt ${m[2]} rejected (${m[3]})`
  if (j.kind === 'review' && (m = t.match(/^(\S+): review/))) return `${m[1]}: to review before the PR`
  if (j.kind === 'auto-decision' && (m = t.match(/^(\S+):/))) return `${m[1]}: decision taken automatically`
  if (j.kind === 'ruling' && (m = t.match(/^(\S+): .* settled, option (\S+)/))) return `${m[1]}: issue settled (option ${m[2]})`
  // "T01 waits for 2 rulings (15 min at most)", as progress.mjs wait writes it (0.21.0)
  if (j.kind === 'wait' && (m = t.match(/^(\S+) waits for (\d+) rulings? \((\d+) min at most\)/))) return `${m[1]} waits for your ruling (${m[3]} min at most)`
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
  return { mark: mark(j), text: brief(j, inst), age: Math.max(0, now - at), kind: j.kind }
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
const STEPS = /** @type {Record<string, string>} */ ({ worker: 'work', verification: 'verification', evaluation: 'evaluation', challenge: 'challenge', fix: 'fix', merge: 'merge', replanning: 'replanning', progress: 'progress' })
// The step's slot in the banner: "verification +9"
const STEP_WIDTH = 15

/**
 * What a task waits for (0.19.0): "waits for AH06, AH07", four ids at most. Within `n` cells, whole ids only, the others
 * counted: "waits for AH06 +3". When not even the first id and the count fit: "waits for AH06…". An id is only cut when
 * the room is too small for the first one.
 * @param {string[]} ids @param {number} [n]
 */
export function waitsFor(ids, n = Infinity) {
  const shown = ids.slice(0, 4)
  for (let k = shown.length; k > 0; k--) {
    const s = `waits for ${shown.slice(0, k).join(', ')}${k < ids.length ? ` +${ids.length - k}` : ''}`
    if ([...s].length <= n) return s
  }
  const s = `waits for ${ids[0]}${ids.length > 1 ? '…' : ''}`
  return [...s].length <= n ? s : cut(s, n)
}

/** What a task does, in a few words. @param {TaskView} t @param {boolean} active @param {boolean} [settled] @param {number} [n] the room of the text on the card, for "waits for …" */
export function what(t, active, settled = false, n = Infinity) {
  if (active && t.step) return (STEPS[t.step] || t.step) + (t.attempts > 1 ? `, attempt ${t.attempts}` : '') + (t.isolated ? ' (worktree)' : '')
  if (t.status in ATTENTION && settled) return 'issue settled, restart pending'
  if (t.status in ATTENTION) return /** @type {Record<string, string>} */ (ATTENTION)[t.status] + (t.blocker[0] ? `: ${t.blocker[0]}` : '')
  if (t.status === 'merged') return t.attempts > 1 ? `${t.attempts} attempts` : ''
  return t.waiting.length ? waitsFor(t.waiting, n) : ''
}
/** The same in colors: the step in its color, the attempt in amber, the place dim. @param {TaskView} t @param {boolean} active @param {boolean} settled @param {number} n @param {string | null} [wait] what a task that waits for a ruling says, in place of the step @returns {Line} */
function whatColored(t, active, settled, n, wait = null) {
  // Waits for a ruling (0.21.0): its deadline's time in place of the step, in warning
  if (wait) return [{ t: wait, c: 'warning' }]
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
  const q = cut(what(t, active, settled, n), n)
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
  if (!inst.run || inst.planClosed != null) return null
  const s = summarize(inst, now)
  const place = Math.max(0, columns - reserve)
  // "your turn" counts what is for now: an issue during a run waits for its stop (0.19.0)
  const yours = yourTurnItems(inst, now).urgent
  /** @type {Line | null} */
  let l = null
  for (const shape of BANNER_SHAPES) {
    l = bannerLine(inst, s, now, shape, animated, yours)
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
 * @param {typeof BANNER_SHAPES[number]} f @param {boolean} animated @param {number} yours the items that are for now
 * @returns {Line}
 */
function bannerLine(inst, s, now, f, animated, yours) {
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
  if (yours) l.push({ t: '  ' }, { t: '⚠ ', c: 'warning', b: true }, { t: `${yours}${f.labels ? ' your turn' : ''}`, a: 'yourTurn', k: 'your-turn' })
  const ec = s.inProgress
  // A task that waits for a ruling (0.21.0) asks for someone: it takes the place of the current step
  const rw = rulingWaits(inst, now)
  // Mode deviation: the run itself waits for a ruling before it stops (0.22.0)
  if (runLive && runWaits(inst, now).length) l.push({ t: f.step || f.labels ? '  ‖ run waits for you' : '  ‖ run', c: 'warning', b: true })
  else if (runLive && rw.length) {
    const first = /** @type {{ task: string }} */ (rw[0]), id = Math.min(8, Math.max(3, ...inst.tasks.map(x => [...x.id].length)))
    if (f.step) {
      const plus = rw.length > 1 ? ` +${rw.length - 1}` : '', said = `waits for you${plus}`
      l.push({ t: `  ‖ ${column(first.task, id)} `, c: 'warning', b: true }, { t: said, c: 'warning', b: true }, { t: ' '.repeat(Math.max(0, STEP_WIDTH - [...said].length)) })
    } else l.push({ t: `  ‖ ${rw.length}${f.labels ? ' waits for you' : ''}`, c: 'warning', b: true })
  } else if (runLive && f.step) {
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
// In order: what waits for you (if anything), the run, the tasks as timelines, the log. In the pane, 1 to 9 select a line
// of "Your turn" (its detail card), l switches the log card between its last entries and the whole log. The other actions
// are buttons without a key (0.16.0). Most prepare a text in the prompt, and nothing is sent without the person; Done,
// Ticket, Edit text and Undo, on a review or an auto-decision, write through progress.mjs (register.tsx runs it).

const MODES = /** @type {Record<string, string>} */ ({ auto: 'autonomous', deviation: 'stop on deviation', phase: 'stop at each phase' })
const SHORT_STEP = /** @type {Record<string, string>} */ ({ worker: 'work', verification: 'verif', evaluation: 'eval', challenge: 'chall', fix: 'fix', merge: 'merge', replanning: 'replan', progress: 'prog' })
const STEP_ORDER = ['worker', 'verification', 'evaluation', 'challenge', 'fix', 'merge', 'replanning', 'progress']
// What progress.mjs writes in the log at each step: "T01 starts (worktree)" for the work (kind task), "T01: verification",
// "T01: fix (attempt 2)" for the next ones (kind step)
const RE_STEP = /^(\S+): (verification|evaluation|challenge|fix|merge|replanning|progress)(?: \(|$)/
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

/**
 * The steps of the run card within `room` cells (0.13.1): on one line with " · " between them, or with two spaces, or else
 * over several lines with " · ", never wider than the card. A line wider than its card makes the terminal shorten each of
 * its pieces ("…verif", "merge 2:…").
 * @param {Line[]} items @param {number} room @returns {Line[]}
 */
export function stepLines(items, room) {
  for (const sep of [' · ', '  ']) if (width(joinParts(items, sep)) <= room) return [joinParts(items, sep)]
  /** @type {Line[][]} */
  const rows = [[]]
  for (const item of items) {
    const row = /** @type {Line[]} */ (rows.at(-1))
    if (row.length && width(joinParts([...row, item], ' · ')) > room) rows.push([item])
    else row.push(item)
  }
  return rows.map(r => joinParts(r, ' · '))
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

// Where to act (0.17.0), by kind of item: this session (the pilot, where /progress is open), outside Claude, the PR. During
// a run, the agents work in the main checkout: what changes the plan or the code waits for the run to stop
const WHERE = {
  resume: 'This session: the run is stopped, resume it here',
  pilot: 'This session: the run is stopped, ask the pilot',
  live: 'This session, once the run stops',
  waiting: 'This session: do what it waits for, then resume the run with the others',
  pilotLive: 'This session: ask the pilot, the run goes on meanwhile',
  // An issue answered from its detail card (0.21.0): the ruling is recorded at once, apply reports it into the plan
  answerLive: 'Here, while the run goes on (nothing is sent to the chat)',
  answerStopped: 'Here: applied when the next run starts',
  decision: 'This session, between two runs: /orchestre:ready asks the question',
  manual: 'Outside Claude (a secret stays out of the chat), then this session to mark it done',
  environment: 'Your terminal, then this session: /orchestre:ready checks it',
  lint: 'This session, between two runs',
  review: 'This session once no run is going (the agents work in the main checkout), or the PR on GitHub',
  autoDecision: 'This session, between two runs (reversing it amends the plan)',
}
// ── The moment of an item of "Your turn" (0.19.0) ──────────────────────────────────────────────────────────────────────
// Each item has a label, drawn on the right of its line, and a rank, which sorts the list (stable). The rules, in one place:
//   task that waits for someone (needs-human, blocked, failed) ..... now, rank 0, run or not
//   open issue that has options (also on a waiting task) ............. now, rank 0, run or not: its detail card answers
//                                                                    it during the run (0.21.0, D2)
//   open issue without options, decision to take that holds
//   back a task of the phase in progress, plan-lint in error ......... now, rank 0; the same during a run (they need the
//                                                                    session, D2) ... at run stop, rank 0.2
//   manual or environment prerequisite that holds back a task of the
//   phase in progress ................................................ now, rank 0, run or not
//   prerequisite that holds back a task of a later phase k ........... before phase k, rank k - 0.5
//   prerequisite that holds back no task left ........................ before the next (first) run, rank 98
//   review of a task of phase k ..................................... after phase k, rank k
//   auto-decision of a task of phase k ............................... before phase k + 1, rank k + 0.5
//   auto-decision of the last phase; review or auto-decision of the
//   source plan, or of a plan all merged ............................. before the PR, rank 99
// Only `now` items count in the title, the header badge and the banner: `at run stop` ones wait for the run to stop.
/** @typedef {{ moment: string, rank: number }} Moment */
/** @type {Moment} */
const NOW = { moment: 'now', rank: 0 }
/** @type {Moment} */
const AT_RUN_STOP = { moment: 'at run stop', rank: 0.2 }
/** @type {Moment} */
const BEFORE_THE_PR = { moment: 'before the PR', rank: 99 }
const IDLE_RANK = 98
/** @param {number} k @returns {Moment} */
const afterPhase = k => ({ moment: `after phase ${k}`, rank: k })
/** @param {number} k @returns {Moment} */
const beforePhase = k => ({ moment: `before phase ${k}`, rank: k - 0.5 })
/** The item counts for the title, the badge and the banner. @param {{ moment: string }} it */
export const isNow = it => it.moment === NOW.moment

// ── The wait for a ruling (0.21.0) ─────────────────────────────────────────────────────────────────────────────────────
// A task that an open issue holds waits for its ruling until the issue's deadline (`until`, written by progress.mjs close);
// then it starts without it. Every time shown comes from `until` and the clock given, never from a counter of the mod, and
// never goes below 0:00.
/** The time left before a deadline, 0:00 at the least. @param {number} until @param {number} now */
const timeLeft = (until, now) => chrono(Math.max(0, until - now))
/** The tasks of an issue that wait for it now, those that started without it left out. @param {IssueView} p */
const waitingOn = p => (p.waiting ?? []).filter(id => !(p.startedWithout ?? []).includes(id))
// Mode deviation (0.21.0, D3): the run waits for the issues a close raised, on behalf of that task, already closed. Told apart
// from a held task by its status alone (0.22.0): no field of progress.json says it
const CLOSED_STATUSES = ['merged', 'blocked', 'failed', 'needs-human']
/** @param {Snapshot} inst @param {string} id */
const closedTask = (inst, id) => { const t = inst.tasks.find(x => x.id === id); return !!t && CLOSED_STATUSES.includes(t.status) }
/** The run waits for this issue (mode deviation): a task in its `waiting` is already closed. @param {Snapshot} inst @param {IssueView} p */
const runWaitsFor = (inst, p) => waitingOn(p).some(id => closedTask(inst, id))
/**
 * The issues the run itself waits for before it stops (mode deviation), during an active run. @param {Snapshot} inst
 * @param {number} now @returns {IssueView[]}
 */
export const runWaits = (inst, now) => (activeRun(inst, now) ? inst.issues.filter(p => runWaitsFor(inst, p)) : [])
/**
 * The tasks that wait for a ruling while the run goes on, each with the deadline that ends its wait (the latest of its issues;
 * null when none gives one). A task that started or merged waits no more; an issue with a ruling recorded is no longer open.
 * @param {Snapshot} inst @param {number} now @returns {{ task: string, until: number | null }[]}
 */
export function rulingWaits(inst, now) {
  if (!activeRun(inst, now)) return []
  /** @type {Map<string, number | null>} */
  const by = new Map()
  for (const p of inst.issues) for (const id of waitingOn(p)) {
    const t = inst.tasks.find(x => x.id === id)
    // Started, or closed: the run's wait in mode deviation, not a task's (runWaits)
    if (t && (t.step || CLOSED_STATUSES.includes(t.status))) continue
    const u = p.until ?? null, k = by.get(id)
    by.set(id, k == null ? u : u == null ? k : Math.max(k, u))
  }
  return [...by].map(([task, until]) => ({ task, until }))
}
/**
 * What the tasks card says of a waiting task in `n` cells: "waits for your ruling 14:47", shorter when the room lacks, the
 * time last to go. @param {number | null} until @param {number} now @param {number} n
 */
function waitCell(until, now, n) {
  const t = until == null ? '' : timeLeft(until, now)
  for (const s of [`waits for your ruling${t ? ` ${t}` : ''}`, `waits for you${t ? ` ${t}` : ''}`]) if ([...s].length <= n) return s
  return cut(t || 'waits for you', n)
}
/** "AH05 and AH05B", "A, B and C", "A, B, C and 2 more". @param {string[]} ids */
const andList = ids => (ids.length < 2 ? ids.join('') : ids.length > 4 ? `${ids.slice(0, 3).join(', ')} and ${ids.length - 3} more` : `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`)

// ── Answering an issue from the pane (0.21.0) ─────────────────────────────────────────────────────────────────────────
// What progress.mjs apply says of an option ruling on an issue that has no entry in ISSUES.json (a stop issue raised by
// run-end, known only from progress.json): its actions are unknown, a free answer settles it. The pane says the same, and
// offers no button for it: rule refuses it, and apply would
/** @param {string} option */
export const noEntry = option => `no entry in ISSUES.json: the actions of option ${option} are unknown; answer with a text`
/**
 * Why the pane offers no button for this option, or null when `rule` takes it, by the same two checks: valid false (the
 * dry run, an issue inherited from /3, one raised by run-end: its reason), or an issue without an entry in the register.
 * @param {IssueView} p @param {IssueOptionView} o @returns {string | null}
 */
export function refusalOf(p, o) {
  if (o.valid === false) return o.invalidReason || 'refused by the dry run'
  if (p.entry === false) return noEntry(o.id)
  return null
}
/** The recommended option the pane can record, if any. @param {IssueView} p */
export const recommendedOf = p => (p.options ?? []).find(o => o.recommended && refusalOf(p, o) == null) ?? null
/** The prompt of [ Ask Claude ]. @param {IssueView} p */
const askPrompt = p => `Explain the issue of ${p.task} ("${p.title}") and its options.`

// Two open reviews of the same task (or of the source plan) are the same when their first backquoted passage is identical
// (D5). Merged at display and in the PR draft only: progress.json and HANDOFF.md keep both texts. A review with no
// backquoted passage is never merged. The first one stays.
/** @param {{ task: string | null, text: string }} r @returns {string | null} */
const reviewIdentity = r => { const m = /`([^`]+)`/.exec(r.text); return m ? `${r.task ?? ''}|${m[1]}` : null }
/** @template {{ task: string | null, text: string }} R @param {R[]} reviews @returns {R[]} */
export function distinctReviews(reviews) {
  const seen = new Set()
  return reviews.filter(r => { const k = reviewIdentity(r); if (k == null) return true; if (seen.has(k)) return false; seen.add(k); return true })
}

/**
 * Every open review that D5 merges with the one of `ref`, their original texts (the first is `ref.text`): what Done or
 * Ticket must close, one `progress.mjs ack` each. A review with no backquoted passage, or a decision, stands alone.
 * @param {{ reviews: { task: string | null, text: string }[] }} inst @param {{ kind: string, task: string | null, text: string }} ref @returns {string[]}
 */
export function mergedTexts(inst, ref) {
  if (ref.kind !== 'review') return [ref.text]
  const id = reviewIdentity(ref)
  const same = id == null ? [] : inst.reviews.filter(r => reviewIdentity(r) === id).map(r => r.text)
  return [ref.text, ...same.filter(t => t !== ref.text)]
}

/**
 * What waits behind the tasks a prerequisite holds back, from the phases and the statuses of the plan: the tasks of the
 * phases after the first one held back, not merged nor cancelled. "phases 3 and 4 (10 tasks) wait behind it"; '' if nothing.
 * @param {Snapshot} inst @param {string[]} blocks
 */
export function waitingBehind(inst, blocks) {
  const open = inst.tasks.filter(t => t.status !== 'merged' && t.status !== 'cancelled')
  const held = open.filter(t => blocks.includes(t.id))
  if (!held.length) return ''
  const first = Math.min(...held.map(t => t.phase))
  const behind = open.filter(t => t.phase > first && !blocks.includes(t.id))
  if (!behind.length) return ''
  const phases = [...new Set(behind.map(t => t.phase))].sort((a, b) => a - b)
  const names = phases.length === 1 ? String(phases[0]) : `${phases.slice(0, -1).join(', ')} and ${phases.at(-1)}`
  return `${phases.length > 1 ? 'phases' : 'phase'} ${names} (${plural(behind.length, 'task')}) ${phases.length > 1 ? 'wait' : 'waits'} behind it`
}

// What a prerequisite is, in the title of its detail card
const PREREQUISITE_KINDS = /** @type {Record<string, string>} */ ({ decision: 'decision to take', manual: 'manual action', environment: 'environment to set up' })

/**
 * What waits for you, one item per thing, each with its action: the tasks that need a human, blocked or failed, the
 * issues to settle, the open prerequisites, plan-lint in error, then the reviews and the auto-decisions to check before
 * the PR. Each item has a key that stays the same while the item is there (0.14.0: the detail card follows it, not its
 * place in the list, which changes during a run). A review or an auto-decision has its reference for progress.mjs
 * (0.16.0: the buttons of the detail card mark it done, move it to tickets or change its text). Each item also says what
 * it is, when and where to act (0.17.0), from the state of the plan: no agent writes them.
 * @param {Snapshot} inst @param {number} now
 * @returns {{ items: YourTurnItem[], urgent: number, settle: number }} urgent: the items that are `now`; settle: those to settle
 */
export function yourTurnItems(inst, now) {
  const s = summarize(inst, now), dir = dirOf(inst), resume = `/orchestre:run ${dir} --resume`
  // When to act (0.17.0): the phase the plan is at, the one of the run in progress if there is one
  const live = !!runInProgress(inst), cur = live ? runPhase(inst) : s.current?.number ?? null
  const phaseOf = /** @param {string | null} id */ id => inst.tasks.find(t => t.id === id)?.phase ?? null
  /**
   * When to act on a prerequisite, and its moment: before the phase of the first task it holds back, now if that task is
   * in the phase in progress. @param {string[]} blocks @returns {Moment}
   */
  const beforeTasks = blocks => {
    const held = inst.tasks.filter(t => blocks.includes(t.id) && t.status !== 'merged' && t.status !== 'cancelled')
    const first = held.length ? Math.min(...held.map(t => t.phase)) : null
    const later = first != null && cur != null && first > cur
    // Holding back no task left (plan-lint warns about it): nothing presses
    if (first == null) return { moment: inst.runs.length ? 'before the next run' : 'before the first run', rank: IDLE_RANK }
    return later ? beforePhase(first) : NOW
  }
  // What needs the session (an issue, a decision to take, plan-lint): now, or at the stop of the run in progress (D2)
  const session = live ? AT_RUN_STOP : NOW
  // An issue that has options is answered from its detail card, run or not (0.21.0, D2); one without waits for the session
  const ask = /** @param {IssueView} p @returns {Moment} */ p => ((p.options ?? []).length ? NOW : session)
  const answered = /** @param {IssueView} p */ p => (!live ? WHERE.answerStopped : (p.options ?? []).length ? WHERE.answerLive : WHERE.live)
  /** @type {YourTurnItem[]} */
  const items = []
  const seen = new Set()
  for (const t of s.attention) {
    const p = inst.issues.find(x => x.task === t.id)
    if (p) seen.add(p)
    const reason = /** @type {Record<string, string>} */ (ATTENTION)[t.status]
    const what = `${p ? p.title : reason}${p?.human ? ' (human)' : ''}`
    items.push(p
      ? { key: '', group: 'settle', task: t.id, g: { t: '⚑', c: 'warning', b: true }, text: `${t.id} · ${what}`, detail: t.blocker[0], prompt: askPrompt(p), help: 'ask Claude', kind: !p.human && t.status !== 'needs-human' ? 'issue to settle' : 'waits for you', what, ...ask(p), where: answered(p), issue: p }
      : t.status === 'needs-human'
      ? { key: '', group: 'settle', task: t.id, g: { t: '⚑', c: 'warning', b: true }, text: `${t.id} · ${what}`, detail: t.blocker[0], prompt: resume, help: 'resume the run', kind: 'waits for you', what, ...NOW, where: live ? WHERE.waiting : WHERE.resume }
      : { key: '', group: 'settle', task: t.id, g: { t: '✗', c: 'error', b: true }, text: `${t.id} · ${reason}`, detail: t.blocker[0], prompt: `Explain the blocker of ${t.id}${t.blocker[0] ? ` (${t.blocker[0]})` : ''} and propose a way forward.`, help: 'ask the pilot', kind: `${t.status} task`, what: reason, ...NOW, where: live ? WHERE.pilotLive : WHERE.pilot })
  }
  for (const p of inst.issues) if (!seen.has(p)) { const what = `${p.title}${p.human ? ' (human)' : ''}`; items.push({ key: '', group: 'settle', task: p.task, g: { t: '?', c: 'warning', b: true }, text: `${p.task} · ${what}`, prompt: askPrompt(p), help: 'ask Claude', kind: 'issue to settle', what, ...ask(p), where: answered(p), issue: p }) }
  for (const p of inst.prerequisites) {
    const evidence = (p.evidence ?? '').trim(), at = beforeTasks(p.blocks)
    // A decision to take is asked by the session, like an issue (D2): at the stop of the run in progress
    const { moment, rank } = p.type === 'decision' && isNow(at) ? session : at
    items.push({
      key: '', group: 'settle', task: p.id, g: { t: '◇', c: 'warning', b: true }, text: `${p.id} (${p.type}) open${p.blocks.length ? `, blocks ${p.blocks.slice(0, 4).join(', ')}` : ''}`, prompt: `/orchestre:ready ${dir}`, help: 'settle the prerequisites',
      kind: PREREQUISITE_KINDS[p.type] ?? 'prerequisite', what: p.text?.trim() || `${p.id} (${p.type}) open`, moment, rank, where: p.type === 'decision' ? WHERE.decision : p.type === 'environment' ? WHERE.environment : WHERE.manual,
      blocks: p.blocks, how: p.how ?? [], ...(evidence && !/^[—–-]$/.test(evidence) ? { check: evidence } : {}),
      // [ ✓ I did it ] (0.21.0): progress.mjs did takes a manual action or an environment, not a decision
      ...(p.type === 'manual' || p.type === 'environment' ? { did: true } : {}),
    })
  }
  if (!inst.lint.ok) { const what = `${plural(inst.lint.errors, 'error')} at the last progress update`; items.push({ key: '', group: 'settle', task: 'plan-lint', g: { t: '✗', c: 'error', b: true }, text: `plan-lint: ${what}`, prompt: `Show me the plan-lint errors on ${dir} and propose a fix.`, help: 'ask the pilot', kind: 'plan-lint error', what, ...session, where: WHERE.lint }) }
  const settle = items.length
  // /orchestre:done marks it done (0.15.1), or moves it to tickets (0.16.0): what the pane puts in the prompt when it cannot
  // run progress.mjs itself
  const done = /** @param {'review' | 'decision'} kind @param {string | null} task @param {string} text @param {boolean} [ticket] */ (kind, task, text, ticket = false) => `/orchestre:done ${dir} ${ticket ? 'ticket ' : ''}${kind} ${task ?? '-'} ${text}`
  for (const r of distinctReviews(inst.reviews)) {
    const shown = r.label ?? r.text
    // After the phase of its task; one of the source plan, or a plan all merged: before the PR
    const phase = r.phase ?? phaseOf(r.task)
    const at = s.allMerged || phase == null ? BEFORE_THE_PR : afterPhase(phase)
    items.push({ key: '', group: 'review', ack: done('review', r.task, r.text), toTicket: done('review', r.task, r.text, true), ref: { kind: 'review', task: r.task, text: r.text, shown, original: r.text, edited: r.label != null }, task: r.task ?? 'source plan', g: { t: '⚑', c: 'warning' }, text: `${r.task ?? 'source plan'} · ${shown}`, prompt: `Review with me, before the PR (review of ${r.task ?? 'source plan'}): ${shown}`, help: 'review', kind: 'review', what: shown, ...at, where: WHERE.review })
  }
  for (const d of inst.decisions) {
    const original = `${d.title}: ${d.option}${d.description ? ` (${d.description})` : ''}`, shown = d.label ?? original
    // To reverse it, before the next phase builds on it; in the last phase, before the PR
    const phase = phaseOf(d.task)
    const at = s.allMerged || phase == null || phase >= s.maxPhase ? BEFORE_THE_PR : beforePhase(phase + 1)
    items.push({ key: '', group: 'decision', ack: done('decision', d.task, d.title), toTicket: done('decision', d.task, d.title, true), ref: { kind: 'decision', task: d.task, text: d.title, shown, original, edited: d.label != null }, task: d.task, g: { t: '⇒', c: 'merged' }, text: `${d.task} · ${shown}`, prompt: `Go over the auto-decision for ${d.task} with me: "${d.title}", option ${d.option}${d.description ? ` (${d.description})` : ''}.`, help: 'go over', kind: 'auto-decision', what: shown, ...at, where: WHERE.autoDecision })
  }
  // The key: the group and the text; the same text twice gets its rank
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const it of items) {
    const base = `${it.group}|${it.ref ? `${it.ref.task ?? '-'}|${it.ref.text}` : it.text}`, k = counts.get(base) ?? 0
    counts.set(base, k + 1)
    it.key = k ? `${base}#${k + 1}` : base
  }
  // The `when` of the detail card is the moment of the label, written out: one place decides both
  // 0.21.0: an issue that tasks wait for, while the run goes on: who waits, the time left (from `until`), and what follows
  for (const it of items) {
    it.when = capital(it.moment)
    const p = it.issue, ids = p && activeRun(inst, now) && p.until != null ? waitingOn(p) : []
    if (p && p.until != null && ids.length && runWaitsFor(inst, p)) it.when += `: the run waits for it ${timeLeft(p.until, now)}, then stops`
    else if (p && p.until != null && ids.length) it.when += `: ${ids.join(', ')} ${ids.length > 1 ? 'wait' : 'waits'} for it ${timeLeft(p.until, now)}, then ${ids.length > 1 ? 'start' : 'starts'} without it`
  }
  // By rank, stable: the order above stays at an equal rank
  items.sort((a, b) => a.rank - b.rank)
  return { items, urgent: items.filter(isNow).length, settle }
}

/**
 * The open issues whose recommended option the pane can record, as `rule` takes them ([ Accept the N recommended ], 0.21.0).
 * @param {Snapshot} inst @returns {{ issue: string, option: string }[]}
 */
// A human issue is left out (0.22.0): it is answered from its own card
export const acceptable = inst => inst.issues.flatMap(p => { const o = p.id && !p.human ? recommendedOf(p) : null; return o && p.id ? [{ issue: p.id, option: o.id }] : [] })

/**
 * The line `last: …` of "Your turn", from the last action of the pane and the state of the plan; null: nothing to say.
 * A ruling (0.21.0) reads the plan, not what the pane remembers: while it is in pendingRulings, "<id> · option A recorded"
 * (the issue and the option of that entry) with Undo (unrule); once it has left pendingRulings and its issue is settled
 * (progress.json or ISSUES.json; never ruling.commit, which stays null), "<id> · option A applied", without Undo; withdrawn
 * or refused by apply, nothing. A prerequisite noted done (did): "<id> noted done on <date>" with Undo (undid) while apply
 * has not written it, then without Undo once it is no longer open. The other actions: their text and Undo.
 * @param {Snapshot} inst @param {LastAction | null} last @returns {{ text: string, undo: boolean } | null}
 */
export function lastLine(inst, last) {
  if (!last) return null
  if (last.kind === 'rule') {
    const asked = last.rulings ?? [], ids = asked.map(r => r.issue)
    const pending = (inst.pendingRulings ?? []).filter(r => ids.includes(r.issue))
    const recorded = pending.length > 0, applied = !recorded && ids.length > 0 && ids.every(id => (inst.settledIssues ?? []).includes(id))
    if (!recorded && !applied) return null
    const state = recorded ? 'recorded' : 'applied'
    if (last.bulk) return { text: `${ids.length} recommended options ${state}`, undo: recorded }
    const r = pending[0] ?? asked[0]
    return { text: `${r.issue} · ${r.option != null ? `option ${r.option}` : 'free answer'} ${state}`, undo: recorded }
  }
  if (last.kind === 'did') {
    if (!last.did) return null
    const id = last.did.prerequisite, noted = (inst.pendingDone ?? []).find(x => x.prerequisite === id)
    if (noted) return { text: `${id} noted done on ${noted.day}`, undo: true }
    return inst.prerequisites.some(x => x.id === id) ? null : { text: `${id} noted done on ${last.did.day}`, undo: false }
  }
  return { text: last.text, undo: true }
}

// The lines of "Your turn" by pages of 9, one key each, 1 to 9 (0.16.0); the page shown, kept within the pages there are
export const PAGE_SIZE = 9
/** @param {number} count @param {number} page */
export const pageOf = (count, page) => Math.max(0, Math.min(Math.floor(page) || 0, Math.ceil(count / PAGE_SIZE) - 1))

/**
 * Under an issue that holds tasks (0.21.0), in grey like the blocker: "     holds AH04 · starts without it in 14:47" (the time in
 * warning, from `until`, 0:00 at the least) while the run goes on; "     AH04 started without it: its amendment may come too
 * late" for the tasks that left without its ruling. @param {Snapshot} inst @param {number} now @param {IssueView} p @param {number} inner @returns {Line[]}
 */
function heldLines(inst, now, p, inner) {
  /** @type {Line[]} */
  const out = []
  const gone = p.startedWithout ?? [], held = (p.holds ?? []).filter(id => !gone.includes(id))
  // cut() trims: the indent is added after it
  const room = Math.max(8, inner - 5)
  if (held.length && activeRun(inst, now)) {
    const head = `holds ${held.join(', ')}`
    // Mode deviation: no task starts without the ruling, the run stops at the deadline (the card's `when` says it)
    if (p.until == null || runWaitsFor(inst, p)) out.push([{ t: `     ${cut(head, room)}`, d: true }])
    else {
      const time = timeLeft(p.until, now)
      out.push([{ t: `     ${cut(`${head} · starts without it in`, Math.max(8, room - 1 - time.length))} `, d: true }, { t: time, c: 'warning' }])
    }
  }
  if (gone.length) out.push([{ t: `     ${cut(`${gone.join(', ')} started without it: its amendment may come too late`, room)}`, d: true }])
  return out
}

/**
 * The "Your turn" card: one line per item, cut to the width, 9 per page (0.16.0). The 9 of the page have a key, 1 to 9: a
 * press shows the item in the detail card, a second press on the same line closes it (0.16.0: the actions are buttons of
 * the detail card). The selected line has ▸ and its text in bold. Under the lines, the page and its button, then the last
 * action of the pane and its Undo button. null if there is nothing, neither item nor last action.
 * @param {Snapshot} inst @param {number} now @param {number} columns @param {string | null} [selected]
 * @param {{ page?: number, last?: LastAction | null }} [o]
 * @returns {(Card & { urgent: number }) | null}
 */
export function yourTurnCard(inst, now, columns, selected = null, { page = 0, last = null } = {}) {
  const { items, urgent, settle } = yourTurnItems(inst, now)
  const shownLast = lastLine(inst, last)
  if (!items.length && !shownLast) return null
  const inner = columns - 4
  const p = pageOf(items.length, page), pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))
  /** @type {Line[]} */
  const lines = []
  const shownItems = items.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE)
  // The labels are aligned on the right edge; the text of a line is cut to leave them their room (0.19.0)
  const labelRoom = Math.max(0, ...shownItems.map(it => [...it.moment].length))
  let later = false
  shownItems.forEach((it, i) => {
    const hotkey = String(i + 1), on = it.key === selected
    const mark = it.ref?.edited ? '  ✎ edited' : ''
    // The grey line before the first item that is not for now, on every page that has one; it has no key
    if (!later && it.rank > 0) { later = true; lines.push([{ t: `  ── later ${'─'.repeat(Math.max(3, inner - 11))}`, d: true }]) }
    const room = Math.max(16, inner - mark.length - 5 - labelRoom - 2), text = cut(it.text, room)
    const gap = ' '.repeat(room - [...text].length + 2 + labelRoom - [...it.moment].length)
    lines.push([on ? { t: '▸', c: 'claude', b: true } : it.g, { t: ' ' }, { t: text, ...(on ? { b: true } : {}), x: { hotkey, prompt: it.prompt, help: it.help, key: it.key, mode: 'select' } }, ...(mark ? [{ t: mark, d: true }] : []), { t: gap }, isNow(it) ? { t: it.moment, c: 'suggestion', b: true } : { t: it.moment, d: true }])
    if (it.detail) lines.push([{ t: `     ${cut(it.detail, Math.max(16, inner - 6))}`, d: true }])
    if (it.issue) lines.push(...heldLines(inst, now, it.issue, inner))
  })
  // From two open issues with a recommended option the pane can record (0.21.0): all of them in one write, before the page line
  const recommended = acceptable(inst)
  if (recommended.length >= 2) lines.push([{ t: '  ' }, { t: bracketed(`Accept the ${recommended.length} recommended`), x: { hotkey: null, prompt: '', help: 'accept the recommended options', op: 'acceptAll', rulings: recommended, bracket: true } }])
  if (pages > 1) {
    const rest = items.length - (p + 1) * PAGE_SIZE
    lines.push([{ t: `  page ${p + 1}/${pages}  `, d: true }, { t: bracketed(rest > 0 ? `Next ${Math.min(rest, PAGE_SIZE)} ›` : `‹ First ${PAGE_SIZE}`), x: { hotkey: null, prompt: '', help: 'other page', op: 'page', page: rest > 0 ? p + 1 : 0, bracket: true } }])
  }
  if (shownLast) lines.push([{ t: '  last: ', d: true }, { t: cut(shownLast.text, Math.max(12, inner - 20)), c: last?.kind === 'ticket' ? 'suggestion' : last?.kind === 'edit' ? undefined : 'success' }, ...(shownLast.undo ? [{ t: '  ' }, { t: bracketed(UNDO_LABEL), x: { hotkey: null, prompt: '', help: 'undo', op: /** @type {const} */ ('undo'), bracket: /** @type {const} */ (true) } }] : [])])
  const tickets = (inst.closed ?? []).filter(c => c.as === 'ticket').length, reviews = distinctReviews(inst.reviews).length
  const count = [
    urgent ? `${urgent} now` : '',
    settle ? `${settle} to settle` : '',
    reviews ? plural(reviews, 'review') : '',
    inst.decisions.length ? plural(inst.decisions.length, 'auto-decision') : '',
    tickets ? `${tickets} moved to tickets` : '',
  ].filter(Boolean).join(' · ')
  return {
    id: 'yourTurn', color: !items.length ? 'success' : urgent ? 'warning' : 'subtle', urgent,
    title: [!items.length ? { t: '✓ Nothing left to review', c: 'success', b: true } : urgent ? { t: '⚠ Your turn', c: 'warning', b: true } : { t: '✓ Nothing waits for you now', c: 'success', b: true }],
    meta: [{ t: count, d: true }],
    lines,
  }
}

// The button that closes the detail card (key x), on its top line
export const CLOSE_LABEL = '✕ Close'
// The buttons of the pane (0.16.0): drawn in brackets by Claude Code, "[ ✓ Done ]", without a key
export const DONE_LABEL = '✓ Done', TICKET_LABEL = '→ Ticket', EDIT_LABEL = '✎ Edit text', SAVE_LABEL = 'Save', CANCEL_LABEL = 'Cancel', UNDO_LABEL = 'Undo'
// The plan closed by the pilot (0.16.1)
export const CLOSE_PLAN_LABEL = 'Close the plan', REOPEN_LABEL = 'Reopen'
// Answering an issue, and a manual action done (0.21.0)
export const OTHER_LABEL = 'Other…', ASK_LABEL = 'Ask Claude', LATER_LABEL = 'Decide later', DID_LABEL = '✓ I did it'
// The room of the labels of the detail card ("when     ", "where    "), as in the run card; the indent of what goes under
// its text (blocker, steps, check, command)
const FIELD = 9, INDENT = '  '
// What the first button of the detail card says: the action of the item, with a capital
const capital = /** @param {string} s */ s => s.charAt(0).toUpperCase() + s.slice(1)
/** The label of a button as Claude Code draws it in the terminal: "[ label ]". @param {string} label */
export const bracketed = label => `[ ${label} ]`

/**
 * The detail card (0.14.0), above "Your turn". 0.17.0: on top, when and where to act, in blue, a blank line between them
 * and before a rule; under it, what the item is, wrapped to the width of the card (in bold on two lines at most), its
 * blocker, the tasks it holds back, the steps and the evidence of a prerequisite, the command its action prepares (not the
 * prompt of a review, which repeats its text); then its buttons (0.16.0, no key): the action of the item, which prepares
 * the prompt; for a review or an auto-decision, Done, Ticket and Edit text, which apply at once; and a one-line note.
 * While the text is edited, a field and Save, Cancel. null if nothing is selected or if the item is gone (settled, merged).
 * @param {Snapshot} inst @param {number} now @param {number} columns @param {string | null} selected
 * @param {{ page?: number, editing?: boolean, draft?: string | null }} [o] draft: the text typed in the field so far
 * @returns {Card | null}
 */
export function detailCard(inst, now, columns, selected, { page = 0, editing = false, draft = null } = {}) {
  if (!selected) return null
  const { items } = yourTurnItems(inst, now)
  const i = items.findIndex(it => it.key === selected)
  if (i < 0) return null
  const it = items[i], p = pageOf(items.length, page)
  const hotkey = Math.floor(i / PAGE_SIZE) === p ? String(i - p * PAGE_SIZE + 1) : null
  // Border and padding take 4 columns, as for the other cards
  const inner = Math.max(24, columns - 4)
  /** @param {string} s @returns {Line[]} */
  const note = s => wrap(s, inner).map(t => [{ t, d: true }])
  /** @type {Line[]} */
  const lines = []
  const ref = it.ref, issue = it.issue
  // The field of [ ✎ Edit text ] (0.16.0), also opened by [ Other… ] on an issue (0.21.0): its answer is a free ruling
  if (editing && (ref || issue)) {
    const value = draft ?? ref?.shown ?? ''
    lines.push([{ t: 'Text ', d: true }, { t: cut(value, Math.max(8, inner - 13)), in: { key: 'detail-input', value, submitLabel: 'save' } }])
    lines.push(...buttonLines([
      { t: bracketed(SAVE_LABEL), c: 'success', x: { hotkey: null, prompt: '', help: ref ? 'save the text' : 'record the answer', key: it.key, op: 'save', ...(ref ? { ref } : { issue: issue?.id ?? '' }), bracket: true } },
      { t: bracketed(CANCEL_LABEL), x: { hotkey: null, prompt: '', help: 'cancel', key: it.key, op: 'cancel', bracket: true } },
    ], inner))
    lines.push(...note(ref ? 'HANDOFF.md keeps the original text, so the next run does not bring the item back.' : 'Save records your answer as a free ruling, applied before the next task starts.'))
  } else {
    // When and where first, in the color of what waits for you, a blank line between them and before the rule (0.17.0)
    /** @param {string} label @param {string} value @returns {Line[]} */
    const band = (label, value) => wrap(value, inner - FIELD).map((t, j) => [{ t: (j ? '' : label).padEnd(FIELD), c: 'suggestion', b: true }, { t, c: 'suggestion' }])
    lines.push(...band('when', it.when), [], ...band('where', it.where), [], [{ t: '─'.repeat(inner), d: true }])
    // What it is: in bold when it holds on two lines, a long review stays in normal weight
    const what = wrap(it.what, inner)
    lines.push(...what.map(t => [{ t, ...(what.length <= 2 ? { b: true } : {}) }]))
    /** Dim, under the text: two spaces, then the words wrapped below them. @param {string} s @returns {Line[]} */
    const under = s => wrap(s, inner - INDENT.length).map(t => [{ t: INDENT + t, d: true }])
    if (ref?.edited) lines.push(...under(`original: ${ref.original}`))
    if (it.detail) lines.push(...under(`blocker: ${it.detail}`))
    if (it.blocks?.length) { const behind = waitingBehind(inst, it.blocks); lines.push(...under(`blocks ${it.blocks.join(', ')}${behind ? `; ${behind}` : ''}`)) }
    // The steps of a prerequisite, numbered, the words of a step wrapped under its first word
    for (const [i, step] of (it.how ?? []).entries()) {
      const mark = `${INDENT}${i + 1}. `
      lines.push(...wrap(step, inner - mark.length).map((t, j) => [{ t: j ? ' '.repeat(mark.length) : mark, d: true }, { t }]))
    }
    if (it.check) { const label = `${INDENT}check  `; lines.push(...wrap(it.check, inner - label.length).map((t, j) => [{ t: j ? ' '.repeat(label.length) : label, d: true }, { t, d: true }])) }
    if (issue) {
      // An issue (0.21.0): what its recommended option does, in grey; its options, the recommended one marked; an option that
      // rule refuses (dry run, inherited from /3, no entry in ISSUES.json) in grey, its reason under it, without a button
      const id = issue.id ?? '', options = issue.options ?? [], rec = recommendedOf(issue)
      if (rec?.effect) lines.push(...under(`recommended option: ${rec.effect}`))
      for (const o of options) {
        const no = refusalOf(issue, o), head = `${INDENT}${o.id}  `, tag = !no && o.recommended ? '  recommended' : ''
        if (no) lines.push([{ t: head + cut(o.description, Math.max(8, inner - head.length)), d: true }], ...wrap(no, inner - head.length - 1).map(t => [{ t: `${' '.repeat(head.length + 1)}${t}`, d: true }]))
        else lines.push([{ t: head }, { t: cut(o.description, Math.max(8, inner - head.length - tag.length)) }, ...(tag ? [{ t: tag, c: 'success' }] : [])])
      }
      lines.push([])
      const ok = options.filter(o => refusalOf(issue, o) == null)
      /** @type {Line} */
      const buttons = ok.map(o => ({ t: bracketed(`${o.id}${o.recommended ? ' · recommended' : ''}`), x: { hotkey: null, prompt: '', help: `record option ${o.id}`, key: it.key, op: /** @type {const} */ ('rule'), issue: id, option: o.id, bracket: /** @type {const} */ (true) } }))
      buttons.push(
        { t: bracketed(OTHER_LABEL), x: { hotkey: null, prompt: '', help: 'answer with a text', key: it.key, op: 'other', issue: id, bracket: true } },
        { t: bracketed(ASK_LABEL), c: 'claude', x: { hotkey: null, prompt: it.prompt, help: it.help, key: it.key, bracket: true } },
      )
      // Only when the issue holds a task: it starts without waiting for the ruling, the issue stays open (release)
      if (issue.holds?.length) buttons.push({ t: bracketed(LATER_LABEL), x: { hotkey: null, prompt: '', help: 'let the tasks start without it', key: it.key, op: 'release', issue: id, bracket: true } })
      lines.push(...buttonLines(buttons, inner))
      lines.push(...note(`${ok.length ? ok.map(o => o.id).join(', ') : OTHER_LABEL}: recorded at once, applied before the next task starts. Ask Claude: fills the prompt.`))
    } else {
      // The text the first button prepares, only when it is a command: a review's would repeat its text
      if (it.prompt.startsWith('/')) lines.push(...wrap(it.prompt, inner - INDENT.length - 2).map((t, j) => [{ t: j ? `${INDENT}  ` : `${INDENT}› `, d: true }, { t, d: true }]))
      lines.push([])
      const ask = ref ? (ref.kind === 'review' ? 'Review with Claude' : 'Go over with Claude') : capital(it.help)
      /** @type {Line} */
      const buttons = [{ t: bracketed(ask), c: 'claude', x: { hotkey: null, prompt: it.prompt, help: it.help, key: it.key, bracket: true } }]
      if (ref) buttons.push(
        { t: bracketed(DONE_LABEL), c: 'success', x: { hotkey: null, prompt: it.ack ?? '', help: 'mark done', key: it.key, op: 'done', ref, bracket: true } },
        { t: bracketed(TICKET_LABEL), c: 'suggestion', x: { hotkey: null, prompt: it.toTicket ?? '', help: 'move to tickets', key: it.key, op: 'ticket', ref, bracket: true } },
        { t: bracketed(EDIT_LABEL), x: { hotkey: null, prompt: '', help: 'edit the text', key: it.key, op: 'edit', ref, bracket: true } },
      )
      // A manual action or an environment, not noted done yet (0.21.0): did records it, apply writes PREREQUISITES.md
      const did = it.did && !(inst.pendingDone ?? []).some(x => x.prerequisite === it.task)
      if (did) buttons.push({ t: bracketed(DID_LABEL), c: 'success', x: { hotkey: null, prompt: '', help: 'note it done', key: it.key, op: 'did', prerequisite: it.task, bracket: true } })
      lines.push(...buttonLines(buttons, inner))
      lines.push(...note(ref ? 'First button: fills the prompt, sends nothing. Others: apply at once.' : did ? 'First button: fills the prompt, sends nothing. I did it: recorded at once, PREREQUISITES.md at the run stop.' : 'The button fills the prompt; nothing is sent.'))
    }
  }
  return {
    id: 'detail', color: 'claude',
    title: [{ t: '▸ Detail', c: 'claude', b: true }, { t: ' · ', d: true }, { t: `${hotkey ? `${hotkey} · ` : ''}${cut(it.task, 20)}`, b: true }, { t: ` · ${it.kind}`, d: true }],
    meta: [{ t: CLOSE_LABEL }],
    lines,
  }
}

/**
 * Buttons drawn in brackets, two spaces apart, over as many lines as the width needs (0.16.0): a piece per button, its
 * text in brackets as Claude Code draws it (register.tsx gives the label without them).
 * @param {Line} buttons @param {number} room @returns {Line[]}
 */
export function buttonLines(buttons, room) {
  /** @type {Line[]} */
  const lines = []
  /** @type {Line} */
  let l = [], used = 0
  for (const b of buttons) {
    const w = [...b.t].length
    if (l.length && used + 2 + w > room) { lines.push(l); l = []; used = 0 }
    if (l.length) { l.push({ t: '  ' }); used += 2 }
    l.push(b); used += w
  }
  if (l.length) lines.push(l)
  return lines
}

/** The words of s over lines of n visible characters at most; a word longer than n is cut. @param {string} s @param {number} n @returns {string[]} */
export function wrap(s, n) {
  const w = Math.max(1, n)
  /** @type {string[]} */
  const out = []
  let cur = ''
  for (const word0 of String(s).replace(/\s+/g, ' ').trim().split(' ')) {
    let word = [...word0]
    while (word.length > w) {
      if (cur) { out.push(cur); cur = '' }
      out.push(word.slice(0, w).join(''))
      word = word.slice(w)
    }
    const piece = word.join('')
    if (!piece) continue
    if (!cur) cur = piece
    else if ([...cur].length + 1 + word.length <= w) cur += ` ${piece}`
    else { out.push(cur); cur = piece }
  }
  if (cur) out.push(cur)
  return out.length ? out : ['']
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
  // The time of the run; the parallelism goes first when the card lacks room (0.13.1)
  /** @param {boolean} parallel @returns {Line} */
  const timeLine = parallel => [{ t: 'time    ', d: true }, { t: duration(s.duration) }, ...(parallel && r.parallelism ? [{ t: ` · ${r.parallelism} in parallel`, d: true }] : []), ...(retries ? [{ t: ' · ', d: true }, { t: `${retries} more ${retries > 1 ? 'attempts' : 'attempt'}` }] : []), ...(autoCount ? [{ t: ' · ', d: true }, { t: plural(autoCount, 'auto-decision') }] : [])]
  /** @type {Line[]} */
  const lines = [
    [{ t: 'phases  ', d: true }, ...phaseTimeline(s.phases, cur, Math.max(8, Math.min(40, inner - 24))), ...(s.phases.length <= 10 ? [{ t: `   phase ${cur}/${s.maxPhase}`, d: true }] : [])],
    [{ t: 'tasks   ', d: true }, ...classBar(activeTasks, classOf, Math.max(8, Math.min(30, inner - 36)), now, animated), { t: `  ${s.done}/${s.total}`, b: true },
      ...n.flatMap((k, i) => (k ? [{ t: '   ■', c: /** @type {typeof CLASSES[number]} */ (CLASSES[i]).c }, { t: ` ${k}` }] : []))],
    width(timeLine(true)) <= inner ? timeLine(true) : timeLine(false),
  ]
  const steps = timePerStep(inst, now)
  if (steps.length) lines.push(...stepLines(steps.map(([e, ms]) => [{ t: `${SHORT_STEP[e] || e} ${chrono(ms)}`, c: STEP_COLOR[e] || 'subtle' }]), inner - 8).map((l, i) => [{ t: i ? '        ' : 'steps   ', d: true }, ...l]))
  if (!runLive && r.detail) lines.push([{ t: 'detail  ', d: true }, { t: cut(r.detail, Math.max(16, inner - 10)) }])
  if (!runLive) {
    // A button, without a key (0.16.0); after it the resume command, dim, cut when the card lacks room: the prompt keeps it
    // whole
    const resume = `/orchestre:run ${dir} --resume`, room = inner - 8
    const button = bracketed(s.allMerged ? 'PR draft in the prompt' : 'Resume command in the prompt'), left = room - [...button].length - 2
    // Plan finished, not closed yet: [ Close the plan ] next to the PR draft (0.16.1), over two lines when the card lacks room
    /** @type {Line} */
    const buttons = [{ t: button, x: { hotkey: null, prompt: prText(inst, now), help: 'prepare the PR', bracket: true } }]
    if (inst.planClosed == null) buttons.push({ t: bracketed(CLOSE_PLAN_LABEL), x: { hotkey: null, prompt: '', help: 'close the plan', op: 'closePlan', bracket: true } })
    if (s.allMerged) buttonLines(buttons, room).forEach((l, i) => lines.push([{ t: i ? '        ' : 'next    ', d: true }, ...l]))
    else lines.push([{ t: 'next    ', d: true }, { t: button, x: { hotkey: null, prompt: resume, help: 'resume the run', bracket: true } }, ...(left >= 12 ? [{ t: `  ${cut(resume, left)}`, d: true }] : [])])
  }
  const marker = runLive ? '' : r.status === 'finished' ? '✓ ' : r.status === 'error' ? '✗ ' : '■ '
  // The tasks that wait for a ruling (0.21.0), right of the title
  const waiting = rulingWaits(inst, now), stops = runWaits(inst, now).length > 0
  return {
    id: 'run', color,
    title: [{ t: `${marker}Run ${r.number} · ${phasesLabel(r.phase, cur ?? r.phase)} · ${MODES[r.mode] || r.mode}`, c: color, b: true }],
    meta: runLive
      ? (s.silent ? [{ t: `◌ no news for ${duration(now - /** @type {number} */ (inst.updated))}`, c: 'warning' }] : [...(stops ? [{ t: '‖ run waits for you', c: 'warning', b: true }, { t: '  ' }] : []), ...(waiting.length ? [{ t: `‖ ${waiting.length} ${waiting.length > 1 ? 'wait' : 'waits'} for you`, c: 'warning', b: true }, { t: '  ' }] : []), { t: `◐ ${s.inProgress.length} in progress`, c: 'suggestion' }])
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

// The task lines on a fixed grid (0.13.1): every line puts each thing in the same column, two spaces apart. A task:
// glyph and id, title, timeline of the last run, duration, model, what it does. A phase: glyph and name in the room of
// the glyph and id of a task, then its count, its squares and its duration in columns of their own, the same for every
// phase, then its retries.
const GAP = 2
// The duration of a task: "1:02:03" at most
const TIME_WIDTH = 7
// The least room of the title, the timeline and what the task does. The room left goes first to the title up to 28 cells
// (0.19.0), then to what the task does, up to its longest text on the card and 24 cells at most ("fix attempt 2
// (worktree)"), then to the timeline up to 26, to the title again up to 48, and what remains to what the task does
const MIN_TITLE = 10, MIN_TIMELINE = 8, MIN_WHAT = 16
const TITLE_FIRST = 28, TITLE_LAST = 48
// Below this width the timeline goes: the room goes to the title, the duration and the step stay (0.19.0)
const TIMELINE_COLUMNS = 80
// The model column only stays if the title keeps this many cells with it, or all its text when it is shorter
const TITLE_WITH_MODEL = 24
/** @param {number} n @returns {Piece} */
const spaces = n => ({ t: ' '.repeat(Math.max(0, n)) })
/** A title in its column: without the code marks of markdown, cut with "…" right after the last character kept, padded to n cells. @param {string} s @param {number} n */
export function titleCell(s, n) {
  const c = [...String(s).replace(/`/g, '').replace(/\s+/g, ' ').trim()]
  return column(c.length > n ? c.slice(0, n - 1).join('').trimEnd() + '…' : c.join(''), n)
}

/**
 * The tasks of a phase that needed retries, "AH02 ×3, AH02B ×2…": three entries at most, fewer when the room lacks, never
 * an entry cut in the middle; empty when not even the first fits.
 * @param {{ id: string, attempts: number }[]} retries @param {number} n
 */
function retriesText(retries, n) {
  const all = retries.map(r => `${r.id} ×${r.attempts}`)
  for (let k = Math.min(3, all.length); k > 0; k--) {
    const s = `${all.slice(0, k).join(', ')}${k < all.length ? '…' : ''}`
    if ([...s].length <= n) return s
  }
  return ''
}

/** A task merged a moment ago: a badge in place of what it does. @param {TaskView} t @param {number} now */
const justMerged = (t, now) => isMerged(t) && t.end != null && now - t.end < NEWS_MS / 2
/**
 * What the card shows under each phase: the detailed tasks (touched by the last run, or waiting for someone), and the
 * tasks to do of the phase of the run, 6 at most.
 * @param {Snapshot} inst @param {number} now
 */
function shownTasks(inst, now) {
  const s = summarize(inst, now), live = !!s.run, f = runWindow(inst, now)
  const cur = live ? runPhase(inst) : s.current?.number ?? null
  const touched = /** @param {TaskView} t */ t => !!f && ((t.start != null && t.start >= f.start) || (t.end != null && t.end >= f.start) || (live && !!t.step))
  // A task that waits for a ruling (0.21.0) is detailed: its line says so, whatever the phase
  const waits = new Map(rulingWaits(inst, now).map(w => [w.task, w.until]))
  const phases = s.phases.map(p => {
    const ts = inst.tasks.filter(t => t.phase === p.number && t.status !== 'cancelled')
    const detail = ts.filter(t => touched(t) || t.status in ATTENTION || waits.has(t.id))
    const todo = p.number === cur ? ts.filter(t => !isMerged(t) && !detail.includes(t)) : []
    return { p, ts, detail, todo }
  })
  return { s, live, cur, phases, waits }
}

/**
 * The columns of the task lines in `columns` cells: where each one starts (`at`) and its width. The model column is 0
 * when no model is known, when it leaves the title, the timeline and what the task does less than their least room, or
 * when the title would keep less than 24 cells with it, or less than its longest title when that is shorter (0.19.0).
 * The timeline column is 0 under 80 columns. What the task does takes the width of its longest text on the card
 * (0.13.1): the title gets the rest, and the columns move when that text gets longer during a run. `bare` is the
 * width of the title of a task with neither a timeline nor a duration: it takes the room of both.
 * @param {Snapshot} inst @param {number} now @param {number} columns
 */
export function taskGrid(inst, now, columns) {
  const shown = shownTasks(inst, now)
  const longest = Math.max(0, ...shown.phases.flatMap(x => [
    ...x.detail.map(t => (justMerged(t, now) ? 8 : width(whatColored(t, shown.live, ruled(inst, t), 999, shown.waits.has(t.id) ? waitCell(shown.waits.get(t.id) ?? null, now, 999) : null)))),
    ...x.todo.slice(0, 6).map(t => [...what(t, shown.live)].length),
  ]))
  const tasks = inst.tasks.filter(t => t.status !== 'cancelled')
  const id = Math.min(8, Math.max(3, ...tasks.map(t => [...t.id].length)))
  // "◉ Phase 12" takes the room of "  ◐ T012": the glyph, a space, the id
  const lead = Math.max(4 + id, 8 + Math.max(1, ...tasks.map(t => String(t.phase).length))) + GAP
  const need = Math.max(MIN_TITLE, ...tasks.map(t => [...titleCell(t.title, 999).trimEnd()].length))
  // Under TIMELINE_COLUMNS there is no timeline column: a started task keeps its duration and its step
  const withTimeline = columns >= TIMELINE_COLUMNS
  /** The widths of the title, the timeline and what the task does, with or without a model column of `model` cells. @param {number} model */
  const widths = model => {
    const fixed = lead + GAP + (withTimeline ? GAP : 0) + TIME_WIDTH + GAP + (model ? model + GAP : 0)
    const least = MIN_TITLE + (withTimeline ? MIN_TIMELINE : 0) + MIN_WHAT
    let rest = Math.max(0, columns - fixed - least)
    /** @param {number} v @param {number} to */
    const grow = (v, to) => { const k = Math.max(0, Math.min(rest, to - v)); rest -= k; return v + k }
    let title = grow(MIN_TITLE, Math.min(need, TITLE_FIRST))
    let doing = grow(MIN_WHAT, Math.min(24, longest))
    const timeline = withTimeline ? grow(MIN_TIMELINE, 26) : 0
    title = grow(title, Math.min(need, TITLE_LAST))
    doing += rest
    return { title, timeline, doing, fits: columns - fixed >= least }
  }
  let model = Math.min(MODEL_WIDTH, Math.max(0, ...inst.tasks.map(t => width(modelOf(t)))))
  let w = widths(model)
  // The model column goes when it leaves less than the least room, or less than 24 cells to the title, or less than
  // its longest title when that is shorter (0.19.0)
  if (model && (!w.fits || w.title < Math.min(TITLE_WITH_MODEL, need))) { model = 0; w = widths(0) }
  const { title, timeline, doing } = w
  const atTimeline = lead + title + GAP
  // Without a timeline column, "timeline" and "time" are the same place
  const atTime = timeline ? atTimeline + timeline + GAP : atTimeline
  const atModel = atTime + TIME_WIDTH + GAP
  // A task with neither a timeline nor a duration (not started, waiting) gives its title the room of both (0.19.0)
  const bare = atModel - GAP - lead
  return { id, lead, title, bare, timeline, model, what: doing, at: { title: lead, timeline: atTimeline, time: atTime, model: atModel, what: atModel + (model ? model + GAP : 0) } }
}

/**
 * The tasks: one line per phase (one square per task), then, under the phases where something happens, one line per task
 * with its timeline over the time of the last run, its duration, its model and what it does, on the grid of taskGrid. A
 * task closed in an earlier run keeps a short line; the tasks to do of the current phase are capped at 6.
 * @param {Snapshot} inst @param {number} now @param {number} columns @param {boolean} [animated] @returns {Line[]}
 */
export function taskLines(inst, now, columns, animated = false) {
  const { s, live, cur, phases, waits } = shownTasks(inst, now)
  const classOf = classifier(inst, now)
  const G = taskGrid(inst, now, columns)
  /** The glyph and the id, up to the title. @param {TaskView} t @param {Piece} g @returns {Line} */
  const lead = (t, g) => [{ t: '  ' }, g, { t: ' ' }, { t: column(t.id, G.id), b: true }, spaces(G.lead - 4 - G.id)]
  /** @param {string} x @returns {Piece} */
  const time = x => ({ t: x.padStart(TIME_WIDTH) + ' '.repeat(GAP), d: true })
  /** @param {TaskView} t @returns {Line} */
  const model = t => (G.model ? modelCell(t, G.model) : [])
  // The columns of the phase lines: the count, the squares (a bar of 20 beyond 30 tasks), the duration
  const countWidth = Math.max(0, ...s.phases.map(p => `${p.done}/${p.total}`.length))
  const durationWidth = Math.max(0, ...s.phases.map(p => duration(p.duration).length))
  // The squares keep the line within the width (0.19.0): beyond the room left, a bar of fewer cells
  const squaresRoom = Math.max(4, columns - G.lead - countWidth - GAP - GAP - durationWidth)
  /** @param {TaskView[]} ts */
  const oneEach = ts => ts.length <= Math.min(30, squaresRoom)
  const squaresWidth = Math.max(0, ...phases.map(x => (oneEach(x.ts) ? x.ts.length : Math.min(20, squaresRoom))))
  /** @type {Line[]} */
  const out = []
  let segments = false
  for (const { p, ts, detail, todo } of phases) {
    const finished = p.total > 0 && p.done === p.total
    const g = finished ? { t: '●', c: 'success' } : p.attention ? { t: '⚠', c: 'warning' } : p.number === cur ? { t: '◉', c: 'claude', b: true } : p.done ? { t: '◐', c: 'suggestion' } : { t: '○', c: 'subtle' }
    const sq = oneEach(ts) ? squares(ts, classOf) : classBar(ts, classOf, Math.min(20, squaresRoom), now, animated)
    /** @type {Line} */
    const l = [g, { t: ` Phase ${p.number}`.padEnd(G.lead - 1), b: p.number === cur || finished, c: finished ? 'success' : undefined }]
    l.push({ t: `${p.done}/${p.total}`.padStart(countWidth), c: finished ? 'success' : undefined, b: finished }, spaces(GAP), ...sq, spaces(squaresWidth - width(sq) + GAP))
    l.push({ t: duration(p.duration).padStart(durationWidth), d: true })
    // The retries go after the name, the count, the squares and the duration, cut to the room left: whole entries, then "…"
    const retries = retriesText(p.retries, columns - width(l) - GAP)
    if (retries) l.push(spaces(GAP), { t: retries, c: 'merged' })
    out.push(l)
    for (const t of detail) {
      const segs = stepsOf(inst, t, now)
      if (segs.length && G.timeline) segments = true
      const running = live && !!t.step && !isMerged(t)
      const before = !segs.length && isMerged(t) ? runOf(inst, t) : null
      const elapsed = segs.length ? /** @type {[number, number, string]} */ (segs.at(-1))[1] - /** @type {[number, number, string]} */ (segs[0])[0] : t.start != null && t.end != null ? t.end - t.start : null
      // Neither a timeline nor a duration: the title takes the room of both, no dots (0.19.0)
      const bare = !segs.length && !before && elapsed == null
      const dim = !running && !isMerged(t)
      /** @type {Line} */
      // Waits for a ruling (0.21.0): "‖" in warning, "waits for your ruling 14:47" in place of the step
      const wait = waits.has(t.id) ? waitCell(waits.get(t.id) ?? null, now, G.what) : null
      const line = [...lead(t, wait ? { t: '‖', c: 'warning', b: true } : glyph(t, live, now, animated))]
      if (bare) line.push({ t: titleCell(t.title, G.bare), d: dim }, spaces(GAP), ...model(t))
      else {
        line.push({ t: titleCell(t.title, G.title), d: dim }, spaces(GAP))
        // No timeline column below TIMELINE_COLUMNS
        if (G.timeline) {
          if (segs.length) line.push(...timeline(inst, t, now, G.timeline, animated))
          else if (before) line.push({ t: `── run ${before.number} `.padEnd(G.timeline, '─').slice(0, G.timeline), c: 'subtle' })
          else line.push({ t: '·'.repeat(G.timeline), c: 'subtle' })
          line.push(spaces(GAP))
        }
        line.push(time(chrono(elapsed)), ...model(t))
      }
      if (justMerged(t, now)) line.push({ t: ' merged ', c: 'inverseText', f: 'success', b: true })
      else line.push(...whatColored(t, live, ruled(inst, t), G.what, wait))
      out.push(line)
    }
    // A task to do: its title over the room of the timeline and the duration, then the planned model in the same column as
    // the detailed lines (0.19.0)
    for (const t of todo.slice(0, 6)) out.push([...lead(t, glyph(t, live)), { t: titleCell(t.title, G.bare), d: true }, spaces(GAP), ...model(t), { t: cut(what(t, live, false, G.what), G.what), d: true }])
    if (todo.length > 6) out.push([{ t: '  ' }, { t: '○', d: true }, spaces(G.lead - 3), { t: `${todo.length - 6} more to do`, d: true }])
  }
  if (!out.length) return [[{ t: 'No task in progress.json.', d: true }]]
  if (segments) {
    // The legend of the steps under the timeline; closer together, then further left, when the width lacks room
    const shown = timePerStep(inst, now).some(([e]) => e === 'challenge') ? STEP_ORDER.slice(0, 6) : STEP_ORDER.filter(e => e !== 'challenge').slice(0, 5)
    const legend = /** @param {string} sep */ sep => joinParts(shown.map(e => [{ t: '━', c: STEP_COLOR[e] }, { t: ` ${SHORT_STEP[e]}`, d: true }]), sep)
    const l = G.at.timeline + width(legend('  ')) <= columns ? legend('  ') : legend(' ')
    out.push([spaces(Math.min(G.at.timeline, columns - width(l))), ...l])
  }
  return out
}

/** The text of a log line: a rejection by the challenger names its mutation. @param {Snapshot} inst @param {{ kind: string, text: string }} j */
function logText(inst, j) {
  const m = j.kind === 'rejection' ? j.text.match(/^(\S+): attempt (\d+) rejected \(([^)]+)\)/) : null
  return (m && challenged(inst, /** @type {string} */ (m[1]), /** @type {string} */ (m[2]), /** @type {string} */ (m[3]))) || j.text
}
/** The log in columns: age, colored source, message; the last entries, or all of them with `full`. @param {Snapshot} inst @param {number} now @param {number} columns @param {boolean} full @returns {Card} */
export function logCard(inst, now, columns, full) {
  const inner = columns - 4
  const js = inst.log.slice(-(full ? LONG_LOG : SHORT_LOG))
  const lines = js.length
    ? js.map(j => { const m = mark(j); return [{ t: age(j.at, now).padStart(6), d: true }, { t: '  ' }, { t: column(j.task ?? (j.kind === 'run' || j.kind === 'error' ? 'run' : 'plan'), 6), c: m.c, d: m.d, b: !m.d }, m, { t: ` ${cut(logText(inst, j), Math.max(16, inner - 18))}` }] })
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
 * @param {{ animated?: boolean, fullLog?: boolean, since?: number | null, selected?: string | null, page?: number, editing?: boolean, draft?: string | null, last?: LastAction | null }} [options]
 * page, editing, draft and last: the page of "Your turn", the text of the detail card being edited, what is typed in its
 * field, the last action of the pane (0.16.0)
 * @returns {{ header: Line[], cards: Card[], borders: boolean, selection: string | null }}
 */
export function pane(inst, now, columns, { animated = false, fullLog = false, since: t0 = null, selected = null, page = 0, editing = false, draft = null, last = null } = {}) {
  const s = summarize(inst, now), r = inst.run
  const yourTurn = yourTurnCard(inst, now, columns, selected, { page, last })
  // The detail card of the selected item of "Your turn", right above it (0.14.0); its text being edited (0.16.0)
  const detail = detailCard(inst, now, columns, selected, { page, editing, draft })
  const closed = inst.planClosed != null
  /** @type {Piece} */
  const state = closed ? { t: 'PLAN CLOSED', c: 'success', b: true }
    : !r ? { t: 'NO RUN', d: true }
    : s.allMerged && r.status !== 'in-progress' ? { t: 'PLAN FINISHED', c: 'success', b: true }
    : s.silent ? { t: `RUN ${r.number} NO NEWS`, c: 'warning', b: true }
    : { t: `RUN ${r.number} ${r.status === 'in-progress' ? 'IN PROGRESS' : r.status.toUpperCase()}`, c: r.status === 'in-progress' ? 'claude' : r.status === 'finished' ? 'success' : r.status === 'error' ? 'error' : 'warning', b: true }
  /** @type {Piece | null} */
  const endMark = closed ? null
    : yourTurn && yourTurn.urgent ? { t: ` ⚠ ${yourTurn.urgent} YOUR TURN `, c: 'inverseText', f: 'warning', b: true }
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
  // A closed plan (0.16.1): its card first, instead of "Your turn"
  if (closed) cards.push(closedCard(inst, now, columns))
  else {
    if (detail) cards.push(detail)
    if (yourTurn) cards.push(yourTurn)
  }
  cards.push(runCard(inst, now, columns, animated))
  cards.push({ id: 'tasks', color: null, title: [{ t: 'tasks', b: true }, { t: ` · ${s.inProgress.length} in progress · ${s.total} in total`, d: true }], meta: [], lines: taskLines(inst, now, columns, animated) })
  cards.push(logCard(inst, now, columns, fullLog))
  // selection: the selected item, if still there; register.tsx forgets it otherwise
  return { header, cards, borders: columns >= BORDER_COLUMNS, selection: detail && !closed ? selected : null }
}

/**
 * The card of a plan closed by the pilot (0.16.1): what closing it changed, what is left open, the PR draft and Reopen.
 * @param {Snapshot} inst @param {number} now @param {number} columns @returns {Card}
 */
export function closedCard(inst, now, columns) {
  const inner = Math.max(24, columns - 4), left = inst.reviews.length + inst.decisions.length
  /** @param {string} s @param {boolean} dim @returns {Line[]} */
  const say = (s, dim) => wrap(s, inner).map(t => [{ t, ...(dim ? { d: true } : {}) }])
  /** @type {Line[]} */
  const lines = [
    ...say('Nothing shows for this plan any more, now or in later sessions, until a run starts on it.', false),
    ...(left ? say(`${plural(left, 'item')} of "Your turn" left open: in the PR draft.`, false) : []),
    ...buttonLines([
      { t: bracketed('PR draft in the prompt'), x: { hotkey: null, prompt: prText(inst, now), help: 'prepare the PR', bracket: true } },
      { t: bracketed(REOPEN_LABEL), x: { hotkey: null, prompt: '', help: 'open the plan again', op: 'reopenPlan', bracket: true } },
    ], inner),
    ...say(`The pane closes at your next prompt; /progress ${dirOf(inst)} shows the plan again.`, true),
  ]
  return { id: 'closed', color: 'success', title: [{ t: '✓ Plan closed', c: 'success', b: true }], meta: inst.planClosed != null ? [{ t: `closed ${age(inst.planClosed, now)} ago`, d: true }] : [], lines }
}

/** The status line when the banner is hidden and something is left to do: "orchestre ✓ 5/5 · ⚑ 3". @param {Snapshot} inst @param {number} now */
export function statusLine(inst, now) {
  const s = summarize(inst, now), urgent = yourTurnItems(inst, now).urgent
  if (inst.planClosed != null || (s.allMerged && !s.reviews && !urgent)) return null
  return `orchestre ${s.allMerged ? '✓' : '■'} ${s.done}/${s.total}${s.reviews ? ` · ⚑ ${s.reviews}` : ''}${urgent ? ` · ⚠ ${urgent}` : ''}`
}

/** A line as plain text. @param {Line} l */
export const plainText = l => l.map(m => m.t).join('').replace(/\s+$/, '')

/** The state as text, where nothing is drawn (`/progress text`, pane refused): the banner, then the cards. @param {Snapshot} inst @param {number} now */
export function stateText(inst, now) {
  const b = banner(inst, now, 120)
  const out = [b ? plainText(b) : inst.planClosed != null ? `${inst.plan}: plan closed` : `${inst.plan}: no run noted in progress.json`]
  for (const c of pane(inst, now, 104).cards) {
    out.push('', plainText([...c.title, ...(c.meta.length ? [{ t: '   ' }, ...c.meta] : [])]))
    for (const l of c.lines) out.push(plainText(l))
  }
  return out.join('\n')
}

/**
 * Draft of a PR description, put in the prompt, never sent. The reviews and the auto-decisions as task lists (0.16.0):
 * those done are ticked, to check in the pull request; those moved to tickets join the tickets of HANDOFF.md.
 * @param {Snapshot} inst @param {number} now
 */
export function prText(inst, now) {
  const s = summarize(inst, now), closed = inst.closed ?? []
  const l = [`Plan ${inst.plan}: ${s.done}/${s.total} tasks merged, ${plural(inst.runs.length, 'run')}.`, '']
  const reviewsDone = closed.filter(c => c.kind === 'review' && c.as === 'done'), decisionsDone = closed.filter(c => c.kind === 'decision' && c.as === 'done')
  const reviews = distinctReviews(inst.reviews)
  if (reviews.length || reviewsDone.length) {
    l.push('To review before merging (files and commands forbidden to the agents):')
    for (const r of reviews) l.push(`- [ ] ${r.task ?? 'source plan'}: ${r.label ?? r.text}`)
    for (const r of reviewsDone) l.push(`- [x] ${r.task ?? 'source plan'}: ${r.shown}`)
    l.push('')
  }
  if (inst.decisions.length || decisionsDone.length) {
    l.push('Decisions taken automatically (autonomous mode):')
    for (const d of inst.decisions) l.push(`- [ ] ${d.task}, ${d.label ?? `${d.title}: option ${d.option}, ${d.description}`}`)
    for (const d of decisionsDone) l.push(`- [x] ${d.task}, ${d.shown}`)
    l.push('')
  }
  if (s.attention.length) l.push(`Not merged yet: ${s.attention.map(t => `${t.id} (${ATTENTION[/** @type {keyof typeof ATTENTION} */ (t.status)]})`).join(', ')}.`, '')
  const moved = closed.filter(c => c.as === 'ticket')
  if (moved.length) {
    l.push('Tickets to open after the PR:')
    for (const c of moved) l.push(`- ${c.task ?? 'source plan'}: ${c.shown}`)
    if (inst.tickets) l.push(`- and ${plural(inst.tickets, '"ticket" entry', '"ticket" entries')} of HANDOFF.md.`)
  } else if (inst.tickets) l.push(`${plural(inst.tickets, 'ticket')} to open after the PR (HANDOFF.md, "ticket" entries).`)
  // One end of line at the end, whatever the last part
  return l.join('\n').replace(/\n*$/, '\n')
}

/** A notification that asks for someone: task that needs a human, blocked or failed, run stopped or in error. @param {string} m */
export const isImportant = m => / waits for a human$|^✗ |^Run stopped|\): error|^\? \S+: \d+ issues? to settle now|^▶ \S+ starts without your ruling/.test(m)

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
  // New: not among those of the previous read, compared by task and text (a review marked done leaves the list, 0.15.1),
  // nor among those it had closed (a review open again by Undo, 0.16.0)
  const old = /** @type {Map<string, number>} */ (new Map())
  for (const r of [...before.reviews, ...(before.closed ?? []).filter(c => c.kind === 'review')]) old.set(`${r.task}\u0000${r.text}`, (old.get(`${r.task}\u0000${r.text}`) || 0) + 1)
  const added = after.reviews.filter(r => { const k = `${r.task}\u0000${r.text}`, c = old.get(k) || 0; if (c) old.set(k, c - 1); return !c })
  for (const r of added) newOnes.set(r.task ?? 'source plan', (newOnes.get(r.task ?? 'source plan') || 0) + 1)
  for (const [who, k] of newOnes) m.push(`⚑ ${who}: ${k > 1 ? `${k} reviews` : 'to review'} before the PR`)
  // An issue becomes the stop issue at the end of the run (the run end notes it with the role "stop"): the role is part of the key
  const itemKey = /** @param {{ task: string, title: string, role: string }} p */ p => `${p.task}\u0000${p.title}\u0000${p.role}`
  const seen = new Set(before.issues.map(itemKey))
  for (const p of after.issues) if (p.role === 'stop' && !seen.has(itemKey(p))) m.push(`Run stopped: ${p.task}, ${cut(p.title, 80)}`)
  // 0.21.0, issues that tasks wait for: the arrival of the issues a close raised (one notification per task), then the start of
  // a task without their ruling. An issue whose ruling was withdrawn is not an arrival, and a task released by
  // [ Decide later ] was not left to wait, so its start says nothing
  const known = new Set([...before.issues.map(itemKey), ...(before.pendingRulings ?? []).map(r => r.issue)])
  /** @type {Map<string, IssueView[]>} */
  const arrived = new Map()
  // Mode deviation (0.22.0): the held tasks never start without the ruling, the run waits for it and stops; said once the run
  // waits for them, by the issues that start being waited for by the run
  const deviation = after.run?.mode === 'deviation'
  for (const p of after.issues) {
    if (deviation || p.role === 'stop' || seen.has(itemKey(p)) || (p.id != null && known.has(p.id)) || p.until == null || !(p.holds ?? []).some(id => !(p.startedWithout ?? []).includes(id))) continue
    arrived.set(p.task, [...(arrived.get(p.task) ?? []), p])
  }
  const runWaitedBefore = new Set(before.issues.filter(p => runWaitsFor(before, p)).map(itemKey))
  /** @type {Map<string, IssueView[]>} */
  const stopping = new Map()
  for (const p of after.issues) if (p.role !== 'stop' && p.until != null && runWaitsFor(after, p) && !runWaitedBefore.has(itemKey(p))) stopping.set(p.task, [...(stopping.get(p.task) ?? []), p])
  for (const [who, ps] of stopping) {
    const minutes = Math.round((Math.max(...ps.map(p => /** @type {number} */ (p.until))) - (after.updated ?? 0)) / 60000)
    m.push(`? ${who}: ${plural(ps.length, 'issue')} to settle now — the run waits for ${ps.length > 1 ? 'them' : 'it'}${minutes > 0 ? ` ${minutes} min` : ''}, then stops`)
  }
  for (const [who, ps] of arrived) {
    const holds = [...new Set(ps.flatMap(p => (p.holds ?? []).filter(id => !(p.startedWithout ?? []).includes(id))))]
    const minutes = Math.round((Math.max(...ps.map(p => /** @type {number} */ (p.until))) - (after.updated ?? 0)) / 60000)
    m.push(`? ${who}: ${plural(ps.length, 'issue')} to settle now — ${andList(holds)} ${holds.length > 1 ? 'wait' : 'waits'} for ${ps.length > 1 ? 'them' : 'it'}${minutes > 0 ? ` ${minutes} min` : ''}`)
  }
  const wentBefore = new Set(before.issues.flatMap(p => p.startedWithout ?? []))
  const released = new Set(after.issues.filter(p => p.released).flatMap(p => p.startedWithout ?? []))
  for (const id of new Set(after.issues.flatMap(p => p.startedWithout ?? []))) {
    if (wentBefore.has(id) || released.has(id)) continue
    const minutes = Number(after.log.findLast(j => j.kind === 'wait' && j.task === id)?.text.match(/\((\d+) min at most\)/)?.[1])
    m.push(`▶ ${id} starts without your ruling${minutes > 0 ? `: ${minutes} min passed` : ''}`)
  }
  return m
}
