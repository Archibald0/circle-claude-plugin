// @ts-check
// Demo mode of the mod (/progress demo): a run played in memory, without a repository or a file. Each frame gives an
// orchestre-progress/3 document as scripts/progress.mjs would write it (same fields, same log texts), which the mod passes
// through normalize() like a real progress.json. tests/demo-progress.mjs plays the same scenario with the real progress.mjs,
// and tests/mod-progress.test.mjs checks that both announce the same notifications and that these documents follow the
// schema of the contract.

import { normalize } from './view-model.mjs'

/** @typedef {import('../types/index.d.ts').Snapshot} Snapshot */

export const DEMO_FRAME_MS = 3000
// The real progress comes back a minute after the last frame
export const RETURN_MS = 60000
export const DEMO_PLAN = 'showcase-site'

// The model of each task, as /orchestre:prepare chooses it (0.11.0): haiku for the documentation
export const TASKS = [
  { id: 'T01', title: 'Home page', phase: 1, dep: [], model: 'sonnet' },
  { id: 'T02', title: 'Contact form', phase: 1, dep: [], model: 'sonnet' },
  { id: 'T03', title: 'Sending e-mails', phase: 1, dep: [], model: 'sonnet' },
  { id: 'T04', title: 'End-to-end tests', phase: 2, dep: ['T01', 'T02'], model: 'sonnet' },
  { id: 'T05', title: 'Documentation', phase: 2, dep: ['T03'], model: 'haiku' },
]
const SMTP = { title: 'Test SMTP key', context: 'the sending tests need a test SMTP server', human: true }
export const REJECTION = { attempt: 1, by: 'evaluation', gaps: ['the error message is not shown'] }
// The replanner's choice for the fix of T02 (0.11.0)
export const CHANGE = { from: 'sonnet', to: 'opus', reason: 'the error touches the form and the API' }

/** @typedef {Record<string, any>} Doc */
/** @typedef {(d: Doc, q: string) => void} Frame */

const iso = /** @param {number} ms */ ms => new Date(ms).toISOString()
/** @param {Doc} d @param {string} id */
const task = (d, id) => d.tasks.find(/** @param {Doc} t */ t => t.id === id)
/** @param {Doc} d @param {string} q @param {string} kind @param {string | null} id @param {string} text */
const J = (d, q, kind, id, text) => { d.log.push({ at: q, kind, task: id, text }) }
/** @param {Doc} d */
const currentRun = d => d.runs.find(/** @param {Doc} r */ r => r.status === 'in-progress')

// The writes of progress.mjs, reduced to what the demo plays, with the same log texts
/** @param {number} phase @param {string} mode @returns {Frame} */
const runStart = (phase, mode) => (d, q) => {
  const number = d.runs.length + 1
  d.runs.push({ number, run_id: null, phase, mode, parallelism: 2, max_fixes: 2, max_auto_decisions: 3, status: 'in-progress', start: q, end: null, detail: null, rulings_applied: [], discarded_amendments: [], added_tasks: [], deferred: [], not_started: [], waiting: [], waiting_on_prerequisites: [] })
  J(d, q, 'run', null, `run ${number}: phase ${phase}, mode ${mode}, 2 in parallel`)
}
/** @param {string} id @param {Doc} ch */
const changeText = (id, ch) => `${id}: ${ch.from ?? '—'} → ${ch.to}${ch.reason ? ` (${ch.reason})` : ''}`
/** @param {string} id @param {string} step @param {{ isolated?: boolean, rejection?: Doc, model?: string, change?: Doc }} [o] @returns {Frame} */
const step = (id, step, o = {}) => (d, q) => {
  const t = task(d, id)
  if (o.isolated !== undefined) t.isolated = o.isolated
  const model = o.change ? o.change.to : o.model ?? null
  // The demo only plays a model change on a fix, as the workflow does
  if (step === 'worker') {
    Object.assign(t, { step, start: q, end: null, attempts: 1, rejections: [], blocker: [], model_used: model })
    J(d, q, 'task', id, `${id} starts (${t.isolated ? 'worktree' : 'main checkout'})`)
    return
  }
  t.step = step
  if (step === 'fix' && o.rejection) {
    t.rejections.push(o.rejection)
    t.attempts = Math.max(t.attempts, o.rejection.attempt + 1)
    J(d, q, 'rejection', id, `${id}: attempt ${o.rejection.attempt} rejected (${o.rejection.by}): ${o.rejection.gaps.length} gap(s)`)
  }
  if (model) t.model_used = model
  if (o.change) J(d, q, 'model', id, changeText(id, o.change))
  J(d, q, 'step', id, `${id}: ${step}${step === 'fix' ? ` (attempt ${t.attempts})` : ''}`)
}
/** The worker of a task, on its model. @param {string} id @param {boolean} isolated */
const worker = (id, isolated) => step(id, 'worker', { isolated, model: /** @type {Doc} */ (TASKS.find(t => t.id === id)).model })
/** @param {string} id @param {{ status: string, attempts: number, rejections?: Doc[], blocker?: string[], reviews?: string[], decisions?: Doc[], issues?: Doc[] }} o @returns {Frame} */
const close = (id, o) => (d, q) => {
  const t = task(d, id), run = currentRun(d)
  Object.assign(t, { status: o.status, attempts: o.attempts, branch: `task/${id}`, actual_tokens: 'see /workflows', end: q, step: null, rejections: o.rejections ?? t.rejections, blocker: o.blocker ?? [] })
  J(d, q, 'status', id, `${id}: ${o.status} (${o.attempts} attempt${o.attempts > 1 ? 's' : ''})${t.blocker.length ? ' — ' + t.blocker[0] : ''}`)
  for (const text of o.reviews ?? []) {
    d.reviews.push({ task: id, phase: t.phase, text, run: run?.number ?? null, at: q })
    J(d, q, 'review', id, `${id}: review before the PR — ${text}`)
  }
  for (const x of o.decisions ?? []) {
    d.auto_decisions.push({ run: run?.number ?? null, task: id, title: x.title, option: x.option, description: x.description })
    J(d, q, 'auto-decision', id, `${id}: "${x.title}", option ${x.option} taken automatically`)
  }
  for (const p of o.issues ?? []) {
    d.issues.push({ run: run?.number ?? null, task: id, title: p.title, context: p.context, human: p.human, options: [], role: 'open', status: 'open', chosen_option: null })
    J(d, q, 'issue', id, `${id}: issue "${p.title}"${p.human ? ' (human)' : ''}`)
  }
}
/** @param {string} id @param {string} title @param {string} option @returns {Frame} */
const ruling = (id, title, option) => (d, q) => {
  const p = d.issues.filter(/** @param {Doc} x */ x => x.task === id && x.title === title && x.status === 'open').pop()
  if (p) Object.assign(p, { status: 'settled', chosen_option: option })
  J(d, q, 'ruling', id, `${id}: "${title}" settled, option ${option}`)
  currentRun(d)?.rulings_applied.push({ task: id, title, option })
}
/** @param {string} status @param {{ stop?: string, waiting?: string[] }} [o] @returns {Frame} */
const runEnd = (status, o = {}) => (d, q) => {
  const run = currentRun(d)
  Object.assign(run, { status, end: q, waiting: o.waiting ?? [] })
  if (o.stop) { const p = d.issues.find(/** @param {Doc} x */ x => x.task === o.stop && x.status === 'open'); if (p) p.role = 'stop' }
  J(d, q, 'run', null, `run ${run.number}: ${status}`)
}
/** @param {...Frame} frames @returns {Frame} */
const together = (...frames) => (d, q) => { for (const p of frames) p(d, q) }

// The scenario of tests/demo-progress.mjs, frame by frame; the number is the duration of the frame, in frames
/** @type {[string, number, Frame][]} */
export const SCENARIO = [
  ['Run 1 started, phase 1', 1, runStart(1, 'phase')],
  ['T01 and T02 start', 1, together(worker('T01', true), worker('T02', true))],
  ['T01 in verification', 1, step('T01', 'verification')],
  ['T02 in verification, T01 in evaluation', 1, together(step('T02', 'verification'), step('T01', 'evaluation'))],
  ['T02 rejected by the evaluation: fix on opus', 1, step('T02', 'fix', { rejection: REJECTION, model: 'opus', change: CHANGE })],
  ['T01 in merge', 1, step('T01', 'merge')],
  ['T01 merged, with a review', 1, close('T01', { status: 'merged', attempts: 1, reviews: ['.env.example: add DEMO_URL'] })],
  ['T03 starts; T02 in verification', 1, together(worker('T03', true), step('T02', 'verification'))],
  ['T02 in merge; T03 in verification', 1, together(step('T02', 'merge'), step('T03', 'verification'))],
  ['T02 merged at the 2nd attempt, an auto-decision', 1, close('T02', { status: 'merged', attempts: 2, rejections: [REJECTION], decisions: [{ title: 'Maximum length of the message', option: 'B', description: '2,000 characters' }] })],
  ['T03 needs a human', 1, close('T03', { status: 'needs-human', attempts: 1, blocker: ['test SMTP key missing'], issues: [SMTP] })],
  // A pause when run 1 stops: the time to open /progress
  ['End of run 1: awaiting a ruling on T03', 4, runEnd('awaiting-ruling', { stop: 'T03', waiting: ['T03'] })],
  ['Run 2 started, ruling on T03 applied', 1, together(runStart(1, 'auto'), ruling('T03', SMTP.title, 'A'))],
  ['T03 starts again', 1, worker('T03', true)],
  ['T03 in verification', 1, step('T03', 'verification')],
  ['T03 merged: phase 1 finished', 1, close('T03', { status: 'merged', attempts: 2 })],
  ['T04 and T05 start', 1, together(worker('T04', true), worker('T05', false))],
  ['T05 merged, two reviews', 1, close('T05', { status: 'merged', attempts: 1, reviews: ['README.md: read the installation section again', 'docs/smtp.md: check the name of the variable'] })],
  ['T04 in verification', 1, step('T04', 'verification')],
  ['T04 merged: phase 2 finished', 1, close('T04', { status: 'merged', attempts: 1 })],
  ['End of run 2: finished', 1, runEnd('finished')],
]
export const FRAME_COUNT = SCENARIO.length

/** The time of frame k (0 for the first). @param {number} k @param {number} start @param {number} frameMs */
export function frameInstant(k, start, frameMs = DEMO_FRAME_MS) {
  let t = start
  for (let i = 0; i < k; i++) t += frameMs * /** @type {[string, number, Frame]} */ (SCENARIO[i])[1]
  return t
}
/** The last frame played at `now` (-1 before the first, FRAME_COUNT - 1 after the last). @param {number} now @param {number} start @param {number} frameMs */
export function frameAt(now, start, frameMs = DEMO_FRAME_MS) {
  let k = -1
  while (k + 1 < FRAME_COUNT && frameInstant(k + 1, start, frameMs) <= now) k++
  return k
}
/** The time at which the demo hands back to the real progress. @param {number} start @param {number} frameMs */
export const demoEnd = (start, frameMs = DEMO_FRAME_MS) => frameInstant(FRAME_COUNT - 1, start, frameMs) + RETURN_MS

/**
 * The orchestre-progress/3 document after frame k: frames 0 to k played at their time, following the schema of the contract.
 * @param {number} k @param {number} start @param {number} [frameMs] @returns {Doc}
 */
export function demoDoc(k, start, frameMs = DEMO_FRAME_MS) {
  /** @type {Doc} */
  const d = {
    format: 'orchestre-progress/3', plan: DEMO_PLAN, dir: `plans/${DEMO_PLAN}`, integration: `plan/${DEMO_PLAN}`, base: null, updated: iso(start),
    tasks: TASKS.map(t => ({ id: t.id, title: t.title, phase: t.phase, batch: null, depends_on: t.dep, model: t.model, model_used: null, status: 'todo', attempts: 0, branch: null, token_estimate: 400000, actual_tokens: null, added_by: null, step: null, isolated: null, start: null, end: null, waiting: [], rejections: [], flaky: [], unverifiable: [], blocker: [] })),
    runs: [], issues: [], auto_decisions: [], reviews: [], prerequisites: [], handoff: {}, lint: { ok: true, errors: [] }, log: [], log_omitted: 0,
  }
  for (let i = 0; i <= Math.min(k, FRAME_COUNT - 1); i++) {
    const q = iso(frameInstant(i, start, frameMs))
    ;/** @type {[string, number, Frame]} */ (SCENARIO[i])[2](d, q)
    d.updated = q
  }
  return d
}

/** What the mod shows after frame k: the document read as a progress.json, marked demo ("DEMO" in the banner). @param {number} k @param {number} start @param {number} [frameMs] @returns {Snapshot} */
export function demoSnapshot(k, start, frameMs = DEMO_FRAME_MS) {
  return { .../** @type {Snapshot} */ (normalize(demoDoc(k, start, frameMs))), demo: true, legend: legend(k) }
}

// What to look at or to try at some frames, in the header of the pane
const TO_TRY = /** @type {Record<number, string>} */ ({
  0: 'click "⤢ Details" at the end of the banner to open the pane',
  1: "each task's timeline fills in step by step",
  4: 'the fix turns amber in the timeline of T02, its model shows "sonnet → opus" (log: l)',
  6: '"⚑ 1 to review" can be clicked in the banner',
  10: 'the "Your turn" card comes first; its key 1 prepares the resume in the prompt',
  11: 'the run stops: the run card gives what comes next, key c',
  12: 'the issue is settled: T03 no longer waits for anyone',
  20: 'key p: the PR draft in the prompt',
})
/** The legend of frame k: "frame 11/21 · T03 needs a human", then, on the next line, what to try. @param {number} k */
export function legend(k) {
  const i = Math.min(Math.max(0, k), FRAME_COUNT - 1), toTry = TO_TRY[i]
  return `frame ${i + 1}/${FRAME_COUNT} · ${/** @type {[string, number, Frame]} */ (SCENARIO[i])[0]}${toTry ? `\n→ ${toTry}` : ''}`
}
