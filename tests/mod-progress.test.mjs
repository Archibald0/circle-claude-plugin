// Tests of the view model of the orchestre progress mod (plugins/orchestre/hooks/view-model.mjs and demo.mjs) on
// progress.json files written by the real scripts/progress.mjs in a temporary git repository. The hooks themselves are
// tested by `claude plugin test`.
// Usage: node tests/mod-progress.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import * as M from '../plugins/orchestre/hooks/view-model.mjs'
import * as D from '../plugins/orchestre/hooks/demo.mjs'

const PROGRESS = resolve('plugins/orchestre/scripts/progress.mjs')
const repoRoot = mkdtempSync(join(tmpdir(), 'mod-progress-'))
const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const d = join(repoRoot, 'plans', 'demo')
const task = (id, phase, depends_on = []) => `---\nid: ${id}\ntitle: Task ${id} with the long title of the frontmatter\nphase: ${phase}\nmodel: sonnet\nmodel_reason: test\ndepends_on: [${depends_on.join(', ')}]\nowned_files:\n  - src/${id}/**\nresources: []\ntoken_estimate: 1.0M\nverification:\n  - "npm test"\ndefinition_of_done:\n  - "the test passes"\n---\n`
const progress = (cmd, E) => {
  const r = spawnSync(process.execPath, [PROGRESS, cmd, 'plans/demo', '--json', JSON.stringify(E)], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(r.status, 0, `${cmd}: ${r.stderr}`)
}
const rawFile = () => JSON.parse(readFileSync(join(d, 'progress.json'), 'utf8'))
const readFile = () => M.normalize(rawFile())
const text = lines => lines.map(M.plainText).join('\n')
const EMPTY_SUMMARY = { open_issues: [], tasks: [], not_started: [], deferred: [], added_tasks: [], rulings_applied: [], auto_decisions: [], discarded_amendments: [], waiting: [], waiting_on_prerequisites: [] }
const SECRET = { task: 'T02', title: 'Missing secret', context: '', human: true, options: [] }
let n = 0
const testCase = (name, fn) => { fn(); n++; console.log('ok ·', name) }
/** @type {string[]} */
let scriptNotifications = []

try {
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(repoRoot, 'README.md'), 'x\n'); git('add', '.'); git('commit', '-qm', 'init')
  mkdirSync(join(d, 'tasks'), { recursive: true })
  const T = [['T01', 1], ['T02', 1], ['T03', 2, ['T01']], ['T04', 2, ['T02', 'T03']]]
  for (const [id, ph, dep] of T) writeFileSync(join(d, 'tasks', `${id}-x.md`), task(id, ph, dep))
  writeFileSync(join(d, 'PROGRESS.md'), `# PROGRESS — demo\n\n| ID | Title | Phase | Batch | Depends on | Model | Status | Attempts | Branch | Tokens est. / actual |\n|----|----|----|----|----|----|----|----|----|----|\n${T.map(([id, ph]) => `| ${id} | Task ${id} | ${ph} | — | — | sonnet | todo | 0 | — | 1.0M / — |`).join('\n')}\n\nStatuses: todo · added · merged · blocked · failed · needs-human · cancelled\n`)
  writeFileSync(join(d, 'HANDOFF.md'), '# HANDOFF — demo\n')
  writeFileSync(join(d, 'orchestre.config.json'), JSON.stringify({ integration_branch: 'plan/demo' }))
  git('switch', '-qc', 'plan/demo'); git('add', '.'); git('commit', '-qm', 'plan')

  progress('run-start', { phase: 1, mode: 'auto', parallelism: 2, max_fixes: 2, max_auto_decisions: 3 })
  progress('step', { task: 'T01', step: 'worker', isolated: true })
  progress('step', { task: 'T02', step: 'verification', isolated: true })
  const A = readFile()
  const tA = Date.parse(rawFile().updated) + 90000

  testCase('format: orchestre-progress/3 written by progress.mjs; the 0.11 formats (suivi.json) and any other refused without guessing', () => {
    assert.ok(A); assert.equal(A.plan, 'demo'); assert.equal(A.tasks.length, 4)
    assert.equal(rawFile().format, 'orchestre-progress/3')
    assert.deepEqual(M.FORMATS, ['orchestre-progress/3'])
    assert.deepEqual(M.LEGACY_FORMATS, ['orchestre-suivi/2', 'orchestre-suivi/1'])
    assert.equal(M.normalize({ format: 'orchestre-progress/4', tasks: [] }), null)
    assert.equal(M.formatOf({ format: 'orchestre-progress/4' }), 'orchestre-progress/4')
    assert.equal(M.normalize({ format: 'orchestre-progress/3' }), null, 'without tasks')
    // A plan of 0.11: the mod does not read it, /orchestre:ready or /orchestre:run migrates it
    for (const f of M.LEGACY_FORMATS) {
      assert.equal(M.normalize({ format: f, taches: [] }), null, f)
      assert.equal(M.normalize({ ...rawFile(), format: f }), null, `${f}, even with English keys`)
    }
    // Missing fields are taken empty: without model_used, the model used is unknown, the rest is unchanged
    const raw = rawFile()
    const v = M.normalize({ ...raw, tasks: raw.tasks.map(({ model_used, ...t }) => t) })
    assert.deepEqual(v.tasks.map(t => [t.id, t.model, t.modelUsed, t.step]), A.tasks.map(t => [t.id, 'sonnet', null, t.step]))
    assert.deepEqual({ ...v, tasks: [] }, { ...A, tasks: [] }, 'the rest unchanged')
    // HANDOFF counts, open prerequisites only, plan-lint errors, issues not settled yet
    const issue = (title, status) => ({ run: 1, task: 'T02', title, context: '', human: false, role: 'open', status, chosen_option: status === 'settled' ? 'A' : null, options: [] })
    const X = M.normalize({ ...raw, handoff: { 'Phase 1': { ticket: { minor: 1, major: 1 }, deviation: { minor: 3, major: 0 } }, 'Phase 2': { deviation: { minor: 0, major: 2 } } }, prerequisites: [{ id: 'D5', type: 'decision', status: 'open', blocks: ['T04'] }, { id: 'D6', type: 'access', status: 'done', blocks: ['T03'] }], lint: { ok: false, errors: ['a', 'b'] }, issues: [issue('Settled', 'settled'), issue('Open', 'open')] })
    assert.deepEqual([X.tickets, X.majorCounts], [2, { ticket: 1, deviation: 2 }])
    assert.deepEqual(X.prerequisites, [{ id: 'D5', type: 'decision', blocks: ['T04'] }])
    assert.deepEqual([X.lint, X.issues.map(p => p.title)], [{ ok: false, errors: 2 }, ['Open']])
  })

  testCase('during a run: banner, suffix of the spinner, tasks in progress and their timeline', () => {
    const b = M.plainText(M.banner(A, tA, 140))
    assert.match(b, /^▶ demo {2}◉○ {2}█+░+ {2}0\/4 {2}◐ T01 work \+1 +⏱ 1 min$/)
    assert.match(M.plainText(M.banner(A, tA, 80)), /◐ T01 work \+1 +⏱ 1 min$/, 'the step fits in 80')
    // Fixed slots: the duration stays in place when the step changes name, "0/10" takes the width of "10/10"
    const merging = { ...A, tasks: A.tasks.map(t => (t.id === 'T01' ? { ...t, step: 'verification' } : t)) }
    assert.equal(M.plainText(M.banner(merging, tA, 140)).indexOf('⏱'), b.indexOf('⏱'), 'the duration does not move')
    const ten = { ...A, tasks: [...A.tasks, ...Array.from({ length: 6 }, (_, i) => ({ ...A.tasks[3], id: `T1${i}` }))] }
    assert.match(M.plainText(M.banner(ten, tA, 140)), / {3}0\/10 /)
    // The mentions come right after the progress, before the tasks in progress: they do not move from one step to the next
    const A2 = { ...A, reviews: [{ task: 'T01', phase: 1, text: '.env.example', at: tA - 1000 }] }
    const A3 = { ...A2, tasks: A2.tasks.map(t => (t.id === 'T01' ? { ...t, step: 'evaluation' } : t)) }
    assert.match(M.plainText(M.banner(A2, tA, 140)), /^▶ demo {2}◉○ {2}█+░+ {2}0\/4 {2}⚑ 1 to review {2}◐ T01 work \+1 +⏱ 1 min$/)
    assert.equal(M.plainText(M.banner(A3, tA, 140)).indexOf('⚑ 1 to review'), M.plainText(M.banner(A2, tA, 140)).indexOf('⚑ 1 to review'), 'same place at the next step')
    assert.match(M.plainText(M.banner(A, tA, 53)), /◐ 2 in progress {2}⏱/, 'without the step')
    assert.match(M.plainText(M.banner(A, tA, 44)), /◐ 2 {2}⏱/, 'short labels')
    assert.equal(M.suffix(A, tA), ' · T01 work · 2 tasks in progress…')
    const t = text(M.taskLines(A, tA, 100))
    assert.match(t, /^◉ Phase 1 {2}0\/2 {2}■■ /m); assert.match(t, /◐ T01 +Task T01 .*work \(worktree\)/); assert.match(t, /◐ T02 .*verification/)
    assert.match(t, /^○ Phase 2 {2}0\/2 {2}■■ /m); assert.doesNotMatch(t, /T03/, 'next phase folded')
    // The timeline: the work of T01 in lavender, the verification of T02 in purple, over the time of the run
    const line = id => M.taskLines(A, tA, 100).find(l => l.some(m => m.t.trim() === id))
    assert.ok(line('T01').some(m => /━/.test(m.t) && m.c === 'suggestion')); assert.ok(line('T02').some(m => /━/.test(m.t) && m.c === 'merged'))
  })

  progress('close', { task: 'T01', status: 'merged', attempts: 2, branch: 'task/T01', rejections: [{ attempt: 1, by: 'evaluation', gaps: ['wrong text'] }], reviews: ['agents/x/.env.example: add MR_MAX'], auto_decisions: [{ title: 'Retry threshold', option: 'A', description: 'cap at 30 s' }] })
  progress('close', { task: 'T02', status: 'needs-human', attempts: 1, branch: 'task/T02', blocker: ['secret missing for the tests'], reviews: ['a.env.example: x', 'b.env.example: y'], issues: [{ title: 'Missing secret', context: '', human: true, options: [] }] })
  const B = readFile()

  testCase('notifications: review, task that needs a human; nothing at the first read', () => {
    assert.deepEqual(M.changes(null, B), [])
    assert.deepEqual(M.changes(A, B), ['⚑ T02 waits for a human', '⚑ T01: to review before the PR', '⚑ T02: 2 reviews before the PR'], 'one notification per task')
    assert.deepEqual(M.changes(B, B), [])
  })

  testCase('"Your turn" card: one line per thing, one action per type; run card, log, state as text and PR draft', () => {
    const yourTurn = M.yourTurnCard(B, tA, 100)
    assert.equal(M.plainText(yourTurn.title), '⚠ Your turn'); assert.equal(M.plainText(yourTurn.meta), '1 to settle · 3 reviews · 1 auto-decision')
    const tt = text(yourTurn.lines)
    assert.match(tt, /^⚑ T02 · Missing secret \(human\) {2}→ resume the run\n +secret missing for the tests$/m)
    assert.match(tt, /^⚑ T01 · agents\/x\/\.env\.example: add MR_MAX {2}→ review$/m)
    assert.match(tt, /^⇒ T01 · Retry threshold: A \(cap at 30 s\) {2}→ go over$/m)
    const actions = yourTurn.lines.flat().filter(m => m.x).map(m => m.x)
    assert.deepEqual(actions.map(x => x.hotkey), ['1', '2', '3', '4', '5'])
    assert.equal(actions[0].prompt, '/orchestre:run plans/demo --resume', 'an issue for a human: resume the run, which asks it')
    assert.equal(actions[1].prompt, 'Review with me, before the PR (review of T01): agents/x/.env.example: add MR_MAX')
    assert.equal(actions[4].prompt, 'Go over the auto-decision for T01 with me: "Retry threshold", option A (cap at 30 s).')
    // Blocked without an issue: ask the pilot; open prerequisite: /orchestre:ready
    const blocked = { ...B, issues: [], tasks: B.tasks.map(t => (t.id === 'T02' ? { ...t, status: 'blocked' } : t)), prerequisites: [{ id: 'D5', type: 'decision', blocks: ['T04'] }] }
    const ab = M.yourTurnCard(blocked, tA, 100).lines.flat().filter(m => m.x).map(m => m.x.prompt)
    assert.deepEqual(ab.slice(0, 2), ['Explain the blocker of T02 (secret missing for the tests) and propose a way forward.', '/orchestre:ready plans/demo'])
    assert.equal(M.yourTurnCard(A, tA, 100), null, 'nothing to do: no card')
    // plan-lint in error at the last write; tickets of HANDOFF.md, to open after the PR
    const linted = M.yourTurnCard({ ...A, lint: { ok: false, errors: 2 } }, tA, 100)
    assert.match(text(linted.lines), /^✗ plan-lint: 2 errors at the last progress update {2}→ ask the pilot$/m)
    assert.equal(linted.lines.flat().find(m => m.x).x.prompt, 'Show me the plan-lint errors on plans/demo and propose a fix.')
    assert.match(M.prText({ ...B, tickets: 2 }, tA), /\n2 tickets to open after the PR \(HANDOFF\.md, "ticket" entries\)\.\n$/)
    // Beyond 9 lines, no more key: the line stays a button
    const many = { ...B, reviews: Array.from({ length: 10 }, (_, i) => ({ task: 'T01', phase: 1, text: `f${i}`, at: null })) }
    assert.deepEqual(M.yourTurnCard(many, tA, 100).lines.flat().filter(m => m.x).map(m => m.x.hotkey), ['1', '2', '3', '4', '5', '6', '7', '8', '9', null, null, null])
    const run = text(M.runCard(B, tA, 100, false).lines)
    assert.match(run, /^time {4}\S.* · 2 in parallel · 1 more attempt · 1 auto-decision$/m); assert.match(run, /^tasks .* 1\/4 /m); assert.doesNotMatch(run, /next/, 'run in progress: no next')
    const pr = M.prText(B, tA)
    assert.match(pr, /- T01: agents\/x\/\.env\.example: add MR_MAX/); assert.match(pr, /- T01, Retry threshold: option A, cap at 30 s/); assert.match(pr, /Not merged yet: T02 \(waits for a human\)/)
    const state = M.stateText(B, tA)
    assert.match(state, /^▶ demo {2}◉○/); assert.match(state, /\n⚠ Your turn {3}1 to settle/); assert.match(state, /\nlog/)
    const j = M.logCard(B, tA, 100, false)
    assert.equal(j.lines.length, M.SHORT_LOG); assert.match(text(j.lines), /⚑ /); assert.equal(M.plainText(j.meta), `l: all (${B.log.length})`)
    assert.equal(M.logCard(B, tA, 100, true).lines.length, B.log.length)
  })

  progress('run-end', { ...EMPTY_SUMMARY, status: 'awaiting-ruling', phase: 1, mode: 'auto', stop_issue: SECRET, waiting: ['T02'] })
  const C = readFile()

  testCase('end of run: notification, end banner, no more suffix nor task in progress', () => {
    assert.deepEqual(rawFile().issues.map(p => [p.title, p.role]), [['Missing secret', 'stop']], 'the scribe notes the issue at the close, the run end makes it the stop issue')
    assert.deepEqual(M.changes(B, C), ['Run 1 (phase 1): awaiting-ruling', 'Run stopped: T02, Missing secret'], 'issue become the stop issue')
    assert.match(M.plainText(M.banner(C, tA, 140)), /^■ demo {2}◉○ {2}\S+ {2}1\/4 {2}⚑ 3 to review {2}⚠ 1 your turn {2}run 1 awaiting-ruling {2}⏱ /)
    assert.equal(M.suffix(C, tA), null); assert.deepEqual(M.inProgress(C, tA), [])
    assert.match(text(M.yourTurnCard(C, tA, 100).lines), /^⚑ T02 · Missing secret \(human\) {2}→ resume the run$/m)
    // Run finished: what comes next in one key
    const rc = M.runCard(C, tA, 100, false)
    assert.equal(M.plainText(rc.title), '■ Run 1 · phase 1 · autonomous'); assert.equal(rc.color, 'warning')
    const next = rc.lines.flat().find(m => m.x)
    assert.deepEqual([next.x.hotkey, next.x.prompt], ['c', '/orchestre:run plans/demo --resume'])
    assert.match(text(rc.lines), /^next {4}\/orchestre:run plans\/demo --resume {2}in the prompt$/m)
    assert.deepEqual(M.pane(C, tA, 100).cards.map(c => c.id), ['yourTurn', 'run', 'tasks', 'log'])
    assert.match(M.plainText(M.pane(C, tA, 100).header[0]), /^ORCHESTRE · DEMO · RUN 1 AWAITING-RULING · {2}⚠ 1 YOUR TURN$/)
    assert.deepEqual([M.pane(C, tA, 100).borders, M.pane(C, tA, 50).borders], [true, false], 'no border below 60 columns')
    assert.deepEqual(M.pane(A, tA, 100).cards.map(c => c.id), ['run', 'tasks', 'log'], 'nothing to do: no "Your turn" card')
    assert.equal(M.statusLine(C, tA), 'orchestre ■ 1/4 · ⚑ 3 · ⚠ 1')
  })

  testCase('big plan: the tasks folded by phase, without activity, and the tasks to do capped', () => {
    const doc = rawFile()
    doc.tasks = Array.from({ length: 130 }, (_, i) => ({ ...doc.tasks[0], id: `T${String(i + 1).padStart(3, '0')}`, phase: Math.floor(i / 13) + 1, status: i < 40 ? 'merged' : 'todo', step: null, start: null, end: null }))
    const G = M.normalize(doc)
    const l = M.taskLines(G, tA, 100)
    assert.equal(l.filter(x => /Phase/.test(M.plainText(x))).length, 10)
    assert.ok(l.length <= 10 + 6 + 1 + 2 + 5, `${l.length} lines`)
    assert.match(text(l), /^ {2}○ +\d+ more to do$/m)
    assert.equal(M.summarize(G, tA).current.number, 4)
  })

  testCase('interrupted run (left "in-progress" without a write for 45 min): no news, no more step nor suffix', () => {
    const later = (A.updated ?? 0) + M.SILENCE_MS + 60000
    assert.ok(M.silent(A, later)); assert.ok(!M.silent(A, tA))
    assert.match(M.plainText(M.banner(A, later, 140)), /^◌ demo {2}◉○ {2}░+ {2}0\/4 {2}no news for 46 min {2}⏱ /)
    assert.doesNotMatch(M.plainText(M.banner(A, later, 140)), /in progress/)
    assert.equal(M.suffix(A, later), null); assert.deepEqual(M.inProgress(A, later), [])
    assert.doesNotMatch(text(M.taskLines(A, later, 100)), /◐ T0/)
  })

  testCase('pane opened by itself (0.13.0): a run in progress started since the session began; not one started before, finished, nor the demo', () => {
    const start = A.run?.start
    assert.ok(start != null && A.run?.status === 'in-progress')
    assert.equal(M.runStartedSince(A, start), true, 'started at the start of the session')
    assert.equal(M.runStartedSince(A, start - 60000), true, 'started during the session')
    assert.equal(M.runStartedSince(A, start + 1), false, 'started before the session')
    assert.equal(M.runStartedSince(C, 0), false, 'run finished')
    assert.equal(M.runStartedSince(null, 0), false)
    assert.equal(M.runStartedSince({ ...A, run: { ...A.run, start: null } }, 0), false, 'run without a start')
    const demo = D.demoSnapshot(3, 1000, D.DEMO_FRAME_MS)
    assert.deepEqual([demo.demo, demo.run?.status], [true, 'in-progress'])
    assert.equal(M.runStartedSince(demo, 0), false, 'the demo')
  })

  testCase('phase whose tasks are all cancelled: no longer counted', () => {
    const doc = rawFile()
    for (const t of doc.tasks) if (t.phase === 2) t.status = 'cancelled'
    const X = M.normalize(doc)
    assert.deepEqual(M.phasesOf(X, tA).map(p => p.number), [1])
    assert.match(M.plainText(M.banner(X, tA, 140)), /^■ demo {2}◉ {2}\S+ {2}1\/2 /)
  })

  // Run 2 in auto mode: the first scribe settles the issue of T02, T02 starts again, then phase 2
  progress('run-start', { phase: 1, mode: 'auto', parallelism: 2, max_fixes: 2, max_auto_decisions: 3 })
  progress('ruling', { task: 'T02', title: 'Missing secret', option: 'A' })
  const E = readFile(), tE = Date.parse(rawFile().updated) + 1000
  progress('step', { task: 'T02', step: 'worker', isolated: true })
  const F = readFile()

  testCase('resume after a ruling: the task no longer waits for anyone, neither once settled nor during its restart', () => {
    assert.equal(M.summarize(C, tA).attention.length, 1, 'before run 2, T02 needs a human')
    assert.deepEqual([C.issues.length, E.issues], [1, []], 'the ruling settles the issue: no longer read')
    assert.deepEqual(M.summarize(E, tE).attention, []); assert.doesNotMatch(M.plainText(M.banner(E, tE, 140)), /your turn/)
    assert.match(text(M.taskLines(E, tE, 100)), /⚑ T02 .*issue settled, restart pending/)
    assert.deepEqual(M.summarize(F, tE).attention, []); assert.match(M.plainText(M.banner(F, tE, 140)), /◐ T02 work/)
    assert.match(text(M.taskLines(F, tE, 100)), /◐ T02 +Task T02 .*work.* \(worktree\)/)
    assert.equal(M.summarize(F, tE).phases[0].attention, 0)
    // Restart without a ruling in this run (blocked task started again, issue settled elsewhere): the step is enough
    const rawF = rawFile()
    rawF.runs.at(-1).rulings_applied = []
    const R = M.normalize(rawF)
    assert.deepEqual(M.summarize(R, tE).attention, []); assert.equal(M.summarize(R, tE).phases[0].attention, 0)
    assert.equal(M.summarize(R, R.updated + M.SILENCE_MS + 1000).attention.length, 1, 'silent run: the task waits again')
  })

  progress('close', { task: 'T02', status: 'merged', attempts: 2, branch: 'task/T02' })
  progress('step', { task: 'T03', step: 'worker', isolated: true })
  const G2 = readFile()
  progress('close', { task: 'T03', status: 'merged', attempts: 1, branch: 'task/T03' })
  progress('close', { task: 'T04', status: 'merged', attempts: 1, branch: 'task/T04' })
  progress('run-end', { ...EMPTY_SUMMARY, status: 'finished', phase: 2, mode: 'auto' })
  const H = readFile()

  testCase('run in auto mode: the banner follows the phase reached, the run end names the phases, each phase has its duration', () => {
    assert.equal(G2.run.phase, 1, 'run.phase stays the start phase')
    assert.match(M.plainText(M.banner(G2, tE, 140)), /^▶ demo {2}●◉ /)
    assert.equal(M.runPhase(E), 1, 'before any step, the start phase')
    assert.match(M.plainText(M.banner(H, tE, 140)), /^✓ demo {2}●● {2}\S+ {2}4\/4 /)
    assert.ok(M.changes(G2, H).includes('Run 2 (phases 1 to 2): finished'), M.changes(G2, H).join(' | '))
    assert.ok(M.changes(B, C).includes('Run 1 (phase 1): awaiting-ruling'), 'a run of one phase keeps "phase 1"')
    assert.notEqual(M.phasesOf(H, tE)[1].duration, null, 'phase 2 has a duration, though run.phase is 1')
    // Plan finished: what comes next is the PR draft; the status line stays as long as there are reviews
    const next = M.runCard(H, tE, 100, false).lines.flat().find(m => m.x)
    assert.deepEqual([next.x.hotkey, next.x.prompt], ['p', M.prText(H, tE)])
    assert.match(text(M.runCard(H, tE, 100, false).lines), /^next {4}PR draft in the prompt$/m)
    // Phase 2 is the run's: its task to do says what it waits for
    assert.match(text(M.taskLines(G2, tE, 100)), /^ {2}○ T04 .* waits for T03$/m)
    assert.equal(M.statusLine(H, tE), 'orchestre ✓ 4/4 · ⚑ 3'); assert.equal(M.statusLine({ ...H, reviews: [] }, tE), null)
  })

  testCase('banner: fits in the width given, room of the button included, keeping what matters', () => {
    const later = (A.updated ?? 0) + M.SILENCE_MS + 60000
    for (const [X, t, reserve] of [[A, tA, 0], [C, tA, 12], [A, later, 0], [H, tE, 12]]) {
      for (const w of [160, 140, 120, 110, 100, 90, 80, 70, 62, 60, 50, 40, 20]) {
        const l = M.banner(X, t, w, reserve)
        // On this small plan, the shortest shape fits in 44 cells; below, the display cuts the end
        if (w - reserve >= 44) assert.ok(M.width(l) <= w - reserve, `${w} - ${reserve}: ${M.width(l)} "${M.plainText(l)}"`)
        assert.match(M.plainText(l), /^[▶■✓◌] demo {2}[●◉○]+ /, 'name and phases always there')
        assert.match(M.plainText(l), /\d\/\d+/, 'progress always there')
      }
    }
    assert.match(M.plainText(M.banner(C, tA, 160, 24)), /⚠ 1 your turn {2}run 1 awaiting-ruling {2}⏱ \d+ (s|min)$/)
    assert.match(M.plainText(M.banner(C, tA, 62, 12)), /⚠ 1 {2}(run 1 )?awaiting-ruling$/, 'in 50 cells: what waits and the run status, without the duration')
    const tight = M.banner(C, tA, 56, 12)
    assert.ok(M.width(tight) <= 44, M.plainText(tight)); assert.match(M.plainText(tight), /⚠ 1 {2}awaiting-ruling$/, 'in 44: the status without the run number')
  })

  testCase('colors: bar by status, one square per task, phase dots, badges', () => {
    const classes = M.banner(C, tA, 140).filter(m => /^[█░▓]+$/.test(m.t))
    assert.deepEqual(classes.map(m => [m.c, [...m.t].length]), [['success', 3], ['warning', 3], ['subtle', 6]], 'T01 merged, T02 needs a human, T03 and T04 to do')
    // "to review" and "your turn" are buttons to the "Your turn" card; their glyph keeps the color
    const l = M.banner(C, tA, 140)
    assert.deepEqual([l.find(m => /your turn/.test(m.t)), l.find(m => /to review/.test(m.t))].map(m => [m?.a, m?.k]), [['yourTurn', 'your-turn'], ['yourTurn', 'review']], 'both lead to the "Your turn" card')
    assert.deepEqual(l.filter(m => m.t === '⚠ ' || m.t === '⚑ ').map(m => [m.t, m.c, !!m.b]), [['⚑ ', 'warning', false], ['⚠ ', 'warning', true]])
    // Big plan: in proportion, each status present keeps at least one square
    const doc = rawFile()
    doc.tasks = Array.from({ length: 124 }, (_, i) => ({ ...doc.tasks[0], id: `T${i + 1}`, phase: Math.floor(i / 12) + 1, status: i < 60 ? 'merged' : i === 60 ? 'failed' : 'todo', step: null }))
    const G = M.normalize(doc)
    const bar = M.classBar(G.tasks, t => (t.status === 'merged' ? 0 : t.status === 'failed' ? 3 : 4), 14, tA, false)
    assert.equal(M.width(bar), 14); assert.deepEqual(bar.map(m => m.c), ['success', 'error', 'subtle'])
    assert.equal(M.phaseDots(M.phasesOf(G, tA), 1), null, '11 phases: no dots')
    assert.match(M.plainText(M.banner(G, tA, 140)), /^[■✓] demo {2}phase \d+\/11 /)
    const ph = M.taskLines(B, tA, 100).find(l => /Phase 1/.test(M.plainText(l)))
    assert.deepEqual(ph.filter(m => /■/.test(m.t)).map(m => [m.c, m.t]), [['success', '■'], ['warning', '■']])
    assert.ok(M.taskLines(A, tA, 100).flat().some(m => m.t === 'work' && m.c === 'suggestion' && m.b), 'step in its color')
  })

  testCase('news at the end of the banner: the most important of the last write, bright 5 s, dim until 10 s', () => {
    const q = Math.max(...B.log.map(j => j.at))
    const fresh = M.news(B, q + 1000)
    assert.equal(fresh.text, 'T02 waits for a human', 'the status wins over the review and the issue noted at the same time')
    assert.match(M.plainText(M.banner(B, q + 1000, 160)), / {3}⚑ T02 waits for a human$/)
    assert.ok(M.banner(B, q + 1000, 160).some(m => m.t === ' T02 waits for a human' && m.b && m.c === 'warning'))
    assert.ok(M.banner(B, q + 7000, 160).some(m => m.t === ' T02 waits for a human' && m.d), 'dim after 5 s')
    assert.equal(M.news(B, q + 11000), null); assert.doesNotMatch(M.plainText(M.banner(B, q + 11000, 160)), /T02 waits/)
    // Fixed dates: the close of T02 and the run end at the same second, then 3 s apart
    const qC = Math.max(...C.log.map(j => j.at))
    const C1 = { ...C, log: C.log.map(j => ({ ...j, at: qC })) }
    assert.equal(M.news(C1, qC).text, 'T02 waits for a human', 'same second as the close: the status wins')
    const C2 = { ...C, log: C.log.map((j, i) => ({ ...j, at: i === C.log.length - 1 ? qC + 3000 : qC })) }
    assert.deepEqual([M.news(C2, qC + 3000).text, M.news(C2, qC + 3000).mark.t, M.news(C2, qC + 3000).mark.c], ['run 1: awaiting-ruling', '■', 'warning'])
    const qH = Math.max(...H.log.map(j => j.at))
    assert.deepEqual([M.news(H, qH).mark.t, M.news(H, qH).mark.c], ['✓', 'success'], 'run end finished in green')
    const end = text(M.logCard(B, q + 1000, 100, false).lines)
    assert.match(end, /T02: issue "Missing secret"[^\n]*$/, 'the last log entry at the bottom of its card')
  })

  testCase('motion: the head spins, the tasks in progress pulse and spin; nothing moves without animated nor outside a run', () => {
    const head = t => M.banner(A, t, 140, 0, true)[0].t
    assert.notEqual(head(tA), head(tA + 100)); assert.match(head(tA), /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] $/)
    assert.equal(M.banner(A, tA, 140)[0].t, '▶ ', 'without animated, ▶')
    assert.equal(M.banner(C, tA, 140, 0, true)[0].t, '■ ', 'run finished: no spinner')
    const inProgress = t => M.banner(A, t, 140, 0, true).find(m => m.c === 'suggestion' && /^[█▓]+$/.test(m.t)).t[0]
    assert.deepEqual(new Set([0, 450, 900, 1350].map(k => inProgress(tA + k))), new Set(['█', '▓']), 'the tasks in progress pulse')
    const g = t => M.taskLines(A, t, 100, true).find(l => /T01/.test(M.plainText(l)) && !/Phase/.test(M.plainText(l)))[1].t
    assert.notEqual(g(tA), g(tA + M.IMAGE_MS)); assert.match(g(tA), /^[◐◓◑◒]$/)
    // Task just merged: a few seconds in green, with a badge
    const T01 = B.tasks.find(t => t.id === 'T01')
    const line = M.taskLines(B, T01.end + 1000, 100).find(l => /T01/.test(M.plainText(l)) && /merged/.test(M.plainText(l)))
    assert.ok(line && line.some(m => m.f === 'success'), '"merged" badge')
    assert.ok(!M.taskLines(B, T01.end + 6000, 100).some(l => / merged $/.test(l.at(-1)?.t ?? '')), 'no more after 5 s')
  })

  testCase('notifications that ask for someone: shown longer', () => {
    for (const m of ['⚑ T02 waits for a human', '✗ T03 blocked', '✗ T03 failed', 'Run stopped: T02, Missing secret', 'Run 2 (phase 1): error']) assert.ok(M.isImportant(m), m)
    for (const m of ['⚑ T01: to review before the PR', 'Phase 1 finished', 'Run 1 started: phase 1, mode auto', 'Run 1 (phase 1): awaiting-ruling', 'Run 2 (phases 1 to 2): finished']) assert.ok(!M.isImportant(m), m)
    assert.ok(M.IMPORTANT_TOAST_MS > 4000)
  })

  testCase('timeline of the steps, time per step, what changed while you were away (on the demo)', () => {
    const T = Date.parse('2026-10-09T10:00:00Z'), t = D.frameInstant(11, T) + 500, I = D.demoSnapshot(11, T)
    const steps = id => M.stepsOf(I, I.tasks.find(x => x.id === id), t).map(e => e[2])
    assert.deepEqual([steps('T01'), steps('T02'), steps('T03')], [['worker', 'verification', 'evaluation', 'merge'], ['worker', 'verification', 'fix', 'verification', 'merge'], ['worker', 'verification']])
    assert.deepEqual(M.timePerStep(I, t).map(e => e[0]), ['worker', 'verification', 'evaluation', 'fix', 'merge'])
    const T02 = M.taskLines(I, t, 100).find(l => l.some(m => m.t.trim() === 'T02'))
    assert.deepEqual(T02.filter(m => /━/.test(m.t)).map(m => m.c), ['suggestion', 'merged', 'warning', 'merged', 'success'], 'one color per step, in order')
    const T03 = M.taskLines(I, t, 100).find(l => l.some(m => m.t.trim() === 'T03'))
    assert.match(T03.filter(m => /^[━·]+$/.test(m.t)).at(-1).t, /^·+$/, 'T03 stops at its close, before the end of the run')
    assert.match(text(M.runCard(I, t, 100, false).lines), /^steps {3}work \d+:\d\d · verif \d+:\d\d · eval \d+:\d\d · fix \d+:\d\d · merge \d+:\d\d$/m)
    const I20 = D.demoSnapshot(20, T), end = D.frameInstant(20, T) + 60000
    assert.equal(M.plainText(M.since(I20, D.frameInstant(12, T), end)), '↩ While you were away (1 min): ✓ T03 T05 T04 merged · ⚑ 2 reviews · run 2 finished')
    assert.equal(M.plainText(M.since(I, T - 1, D.frameInstant(11, T) + 60000)), '↩ While you were away (1 min): ✓ T01 T02 merged · ⚠ T03 waits for you · ⚑ 1 review · run 1 awaiting-ruling')
    assert.equal(M.since(I20, D.frameInstant(20, T) - 1000, D.frameInstant(20, T) + 29000), null, 'less than a minute, even with news: nothing')
    assert.equal(M.since(I20, D.frameInstant(20, T), end), null, 'nothing new since the last visit: nothing')
    // The legend of the demo, at the top of the pane
    const legend = M.pane(D.demoSnapshot(10, T), D.frameInstant(10, T), 100).header.map(M.plainText)
    assert.ok(legend.includes('frame 11/21 · T03 waits for a human'), legend.join(' | ')); assert.ok(legend.some(l => /^→ the "Your turn" card comes first/.test(l)))
    assert.equal(M.normalize(D.demoDoc(3, T)).legend, null)
  })

  testCase('model in the task lines (0.11.0): used, "planned → used" when they differ, planned dim before the worker; log', () => {
    const T = Date.parse('2026-10-09T10:00:00Z'), t4 = D.frameInstant(4, T) + 500, I = D.demoSnapshot(4, T)
    // The line of a task ("··◐ T02 …"), not the one of its phase
    const line = (X, id, w = 100, t = t4) => M.taskLines(X, t, w).find(l => M.plainText(l).match(/^ {2}\S (\S+)/)?.[1] === id)
    // T02 fixed on opus, chosen by the replanner; T01 on its model; T03 not started yet
    const l2 = line(I, 'T02')
    assert.deepEqual(l2.filter(m => /sonnet|opus/.test(m.t)).map(m => [m.t, m.c ?? null, !!m.b, !!m.d]), [['sonnet → ', null, false, true], ['opus', 'merged', true, false]])
    assert.deepEqual(line(I, 'T01').filter(m => /sonnet/.test(m.t)).map(m => [m.t, m.c, !!m.d]), [['sonnet', 'subtle', false]])
    const l3 = line(I, 'T03')
    assert.deepEqual(l3.filter(m => /sonnet/.test(m.t)).map(m => [m.t, !!m.d]), [['sonnet', true]], 'planned, dim')
    assert.equal(M.plainText(l3).indexOf('sonnet'), M.plainText(line(I, 'T01')).indexOf('sonnet'), 'same column as a detailed line')
    assert.match(M.plainText(l2), /sonnet → opus {2}fix attempt 2 \(worktree\)$/)
    // Phase 2: the documentation on haiku
    const I16 = D.demoSnapshot(16, T)
    assert.ok(line(I16, 'T05', 100, D.frameInstant(16, T) + 500).some(m => m.t === 'haiku' && m.c === 'subtle'))
    // The plan planned no model: "— → sonnet"
    const unplanned = { ...I, tasks: I.tasks.map(x => (x.id === 'T01' ? { ...x, model: null } : x)) }
    assert.match(M.plainText(line(unplanned, 'T01')), /— → sonnet/)
    // No model known (progress.json rebuilt from a plan without models): no column, the timeline keeps its width
    const noModel = { ...I, tasks: I.tasks.map(x => ({ ...x, model: null, modelUsed: null })) }
    for (const id of ['T01', 'T02', 'T03']) assert.doesNotMatch(M.plainText(line(noModel, id)), /sonnet|opus|→/)
    const timelineOf = l => l.filter(m => /^[━╸·]+$/.test(m.t)).reduce((n, m) => n + [...m.t].length, 0)
    assert.equal(timelineOf(line(noModel, 'T01')), 26); assert.equal(timelineOf(line(I, 'T01')), 21, 'at 100 columns, the model column is taken from the timeline')
    assert.equal(timelineOf(line(I, 'T01', 160)), 26, 'at 160 columns, the timeline keeps its width')
    // The column makes no line longer than the width; below 73 columns (the grid's least room and its width), it goes away
    for (const w of [140, 120, 100, 80, 73, 72, 60, 50]) {
      const withModel = M.taskLines(I, t4, w), withoutModel = M.taskLines(noModel, t4, w)
      withModel.forEach((l, i) => assert.ok(M.width(l) <= Math.max(w, M.width(withoutModel[i])), `${w}: ${M.width(l)} "${M.plainText(l)}"`))
    }
    assert.match(M.plainText(line(I, 'T02', 73)), /sonnet → opus/); assert.doesNotMatch(M.plainText(line(I, 'T02', 72)), /sonnet|opus/)
    assert.deepEqual(M.taskLines(I, t4, 60).map(M.plainText), M.taskLines(noModel, t4, 60).map(M.plainText), 'too narrow: as without a model')
    assert.equal(M.plainText(line(I, 'T02')).length - M.plainText(line(I, 'T02')).indexOf('fix attempt'), M.plainText(line(noModel, 'T02')).length - M.plainText(line(noModel, 'T02')).indexOf('fix attempt'))
    // The log: the model change, its glyph; /progress text shows it too
    const j = M.logCard(I, t4, 100, true).lines.find(l => /sonnet → opus/.test(M.plainText(l)))
    assert.ok(j && j.some(m => m.t === '⇄' && m.c === 'merged'), 'glyph of the log')
    assert.match(M.plainText(j), /T02 +⇄ T02: sonnet → opus \(the error touches the form and the API\)$/)
    assert.match(M.stateText(I, t4), /T02 .*sonnet → opus/)
    assert.equal(M.news(I, t4)?.kind, 'rejection', 'the rejection makes the news, not the model change noted at the same second')
  })

  testCase('pane texts: state in the header, legend, counts of the tasks card; empty cards and state as text without a run', () => {
    const header = (X, t) => M.plainText(M.pane(X, t, 100).header[0])
    assert.equal(header(A, tA), 'ORCHESTRE · DEMO · RUN 1 IN PROGRESS · ◐ 2 IN PROGRESS')
    assert.equal(header(H, tE), 'ORCHESTRE · DEMO · PLAN FINISHED · ⚑ 3 TO REVIEW')
    assert.equal(M.plainText(M.pane(A, tA, 100).header[1]), '■ merged  ■ in progress  ■ waits for a human  ■ blocked  ░ to do')
    assert.equal(M.plainText(M.pane(A, tA, 100).cards.find(c => c.id === 'tasks').title), 'tasks · 2 in progress · 4 in total')
    assert.equal(M.plainText(M.logCard(H, tE, 100, true).meta), 'l: less')
    const none = M.normalize({ ...rawFile(), tasks: [], runs: [], log: [], reviews: [], auto_decisions: [], issues: [] })
    assert.equal(header(none, tE), 'ORCHESTRE · DEMO · NO RUN')
    assert.equal(M.banner(none, tE, 100), null)
    assert.equal(text(M.taskLines(none, tE, 100)), 'No task in progress.json.')
    assert.equal(text(M.logCard(none, tE, 100, false).lines), 'Empty log.')
    assert.deepEqual([M.plainText(M.runCard(none, tE, 100, false).title), text(M.runCard(none, tE, 100, false).lines)], ['No run yet', 'The first /orchestre:run plans/demo will open it.'])
    assert.match(M.stateText(none, tE), /^demo: no run noted in progress\.json\n\nNo run yet\n/)
  })

  testCase('log glyphs and news: read from the start of what progress.mjs writes, whatever the blocker or the detail says', () => {
    const entry = (kind, text, task = null) => ({ at: tA - 1000, kind, task, text })
    const log = [
      entry('status', 'T01: blocked (1 attempt) — depends on T02, not merged yet', 'T01'),
      entry('status', 'T02: failed, closed at the run end without a scribe — crash', 'T02'),
      entry('status', 'T03: todo → merged (PROGRESS.md and git)', 'T03'),
      entry('status', 'T04: needs-human (2 attempts) — merged config missing', 'T04'),
      entry('run', 'run 1: partial — T05: finished early'),
      entry('run', 'run 2: finished'),
      entry('run', 'run 3 interrupted: left in progress, without a run end'),
      entry('run', 'run 4: phase 2, mode auto, 2 in parallel'),
    ]
    const X = { ...C, log }
    assert.deepEqual(M.logCard(X, tA, 100, true).lines.map(l => `${l[3].t} ${l[3].c}`), ['✗ error', '✗ error', '✓ success', '⚑ warning', '■ warning', '✓ success', '■ warning', '▶ claude'])
    const newsOf = j => M.news({ ...C, log: [j] }, tA)
    assert.deepEqual([newsOf(log[0]).mark.t, newsOf(log[0]).text], ['✗', 'T01 blocked'])
    assert.equal(newsOf(log[1]).text, 'T02 failed', 'a close at the run end, without a scribe')
    assert.deepEqual([newsOf(log[5]).mark.t, newsOf(log[5]).mark.c], ['✓', 'success'])
    assert.equal(newsOf(log[7]).text, 'run 4 started (phase 2, mode auto)')
  })

  testCase('task lines: within the width, the place then the attempt go before the step is cut', () => {
    const T = Date.parse('2026-10-09T10:00:00Z')
    for (let k = 0; k < D.FRAME_COUNT; k++) {
      const I = D.demoSnapshot(k, T), t = D.frameInstant(k, T) + 500
      for (const w of [160, 120, 100, 80, 70, 60]) for (const l of M.taskLines(I, t, w)) assert.ok(M.width(l) <= w, `frame ${k}, ${w}: ${M.width(l)} "${M.plainText(l)}"`)
    }
    const t7 = D.frameInstant(7, T) + 500, I7 = D.demoSnapshot(7, T)
    const T02 = w => M.plainText(M.taskLines(I7, t7, w).find(l => M.plainText(l).match(/^ {2}\S (\S+)/)?.[1] === 'T02'))
    assert.match(T02(160), /verification attempt 2 \(worktree\)$/)
    assert.match(T02(100), /verification attempt 2$/)
    assert.match(T02(80), /verification attempt 2$/); assert.match(T02(76), / verification$/)
  })

  testCase('task lines on one grid (0.13.1): each column at the same place on every line, the phases aligned among themselves', () => {
    const T = Date.parse('2026-10-09T10:00:00Z')
    const cells = l => [...l.map(m => m.t).join('')]
    const isTask = l => /^ {2}\S \S/.test(M.plainText(l)), isPhase = l => /^\S Phase /.test(M.plainText(l))
    for (const k of [4, 7, 9, 16]) {
      const I = D.demoSnapshot(k, T), t = D.frameInstant(k, T) + 500
      // T03 waits for T02 (a task to do with something to say); the same plan without any model; then with 9 more tasks
      // in phase 2, whose count takes more room ("0/11")
      const W = { ...I, tasks: I.tasks.map(x => (x.id === 'T03' && x.status === 'todo' && !x.step ? { ...x, waiting: ['T02'] } : x)) }
      const T05 = /** @type {any} */ (I.tasks.find(x => x.id === 'T05'))
      const more = { ...W, tasks: [...W.tasks, ...Array.from({ length: 9 }, (_, i) => ({ ...T05, id: `T1${i}`, title: `Extra task ${i}` }))] }
      for (const X of [W, { ...W, tasks: W.tasks.map(x => ({ ...x, model: null, modelUsed: null })) }, more]) for (const w of [160, 118, 100, 80, 60]) {
        const G = M.taskGrid(X, w), ls = M.taskLines(X, t, w), at = `frame ${k}, ${w} columns`
        const tasks = ls.filter(isTask)
        assert.ok(tasks.length, at)
        for (const l of tasks) {
          const c = cells(l), id = c.slice(4).join('').split(' ')[0], task = X.tasks.find(x => x.id === id), s = c.join('')
          assert.equal(c.slice(G.at.title - 2, G.at.title + 1).join('').slice(0, 2), '  ', `${at}: title of ${id}, "${s}"`)
          assert.notEqual(c[G.at.title], ' ', `${at}: title of ${id}, "${s}"`)
          assert.match(c.slice(G.at.timeline - 2, G.at.timeline + 1).join(''), /^ {2}[━╸·─]$/, `${at}: timeline of ${id}, "${s}"`)
          assert.match(c.slice(G.at.time - 2, G.at.time + 9).join(''), /^ {2} *(\d+:\d{2}(:\d{2})?|—)? {2}$/, `${at}: duration of ${id}, "${s}"`)
          const model = M.plainText(M.modelOf(task))
          if (G.model && model) assert.equal(c.slice(G.at.model, G.at.model + [...model].length).join(''), model, `${at}: model of ${id}, "${s}"`)
          if (c.length > G.at.what) assert.match(c.slice(G.at.what - 2).join(''), /^ {2}( merged |\S)/, `${at}: what ${id} does, "${s}"`)
        }
        // The phases: count, squares and duration in the same columns; the retries after them
        const phases = ls.filter(isPhase).map(l => cells(l.at(-1)?.c === 'merged' ? l.slice(0, -2) : l).join(''))
        assert.equal(new Set(phases.map(x => x.length)).size, 1, `${at}: ${JSON.stringify(phases)}`)
        assert.equal(new Set(phases.map(x => x.search(/\d+\/\d+ {2}/) + (x.match(/\d+\/\d+/)?.[0].length ?? 0))).size, 1, `${at}: counts ${JSON.stringify(phases)}`)
        // The legend of the steps: under the timeline when it has room, never wider than the width
        const legend = ls.find(l => /━ work/.test(M.plainText(l)))
        if (legend) {
          assert.ok(M.width(legend) <= w, `${at}: legend ${M.width(legend)}`)
          if (w >= 100) assert.equal(cells(legend).indexOf('━'), G.at.timeline, `${at}: legend`)
        }
      }
    }
    // A title: without the code marks of markdown, cut with "…" right after the last word kept
    assert.equal(M.titleCell('`Clarification` contract and schema', 22), 'Clarification contrac…')
    assert.equal(M.titleCell('Routing: the answer to a vague request', 24), 'Routing: the answer to… ')
    assert.equal(M.titleCell('Docs', 6), 'Docs  ')
  })

  testCase('formatting: durations, ages, bar, cut', () => {
    assert.deepEqual([M.duration(45000), M.duration(18 * 60000), M.duration(72 * 60000), M.duration(null)], ['45 s', '18 min', '1 h 12', '—'])
    assert.deepEqual([M.chrono(42000), M.chrono(725000), M.chrono(3723000), M.chrono(null)], ['0:42', '12:05', '1:02:03', '—'])
    assert.equal(M.age(0, 3 * 86400000), '3 d'); assert.equal(M.bar(1, 4, 8), '██░░░░░░'); assert.equal(M.cut('abcdef', 4), 'abc…')
  })

  testCase('demo (tests/demo-progress.mjs): two runs played by the real progress.mjs, without a pause outside a terminal', () => {
    const r = spawnSync(process.execPath, [resolve('tests/demo-progress.mjs'), join(repoRoot, 'demo'), '--frame', '0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.stdout, /^ 1\. .*\n +banner .*\n +notification/m, 'first progress.json: nothing to notify')
    for (const expected of ['notification Run 2 started: phase 1, mode auto', 'notification ⚑ T03 waits for a human', 'notification Run stopped: T03, Test SMTP key', 'notification Phase 1 finished', 'notification Run 2 (phases 1 to 2): finished']) assert.ok(r.stdout.includes(expected), expected)
    assert.match(r.stdout, /^17\. .*\n +banner +▶ demo {2}●◉ /m)
    const Z = M.normalize(JSON.parse(readFileSync(join(repoRoot, 'demo', 'plans', 'demo', 'progress.json'), 'utf8')))
    assert.deepEqual([Z.runs.length, Z.run.status, Z.tasks.filter(t => t.status === 'merged').length, Z.reviews.length, Z.decisions.length], [2, 'finished', 5, 3, 1])
    const already = spawnSync(process.execPath, [resolve('tests/demo-progress.mjs'), join(repoRoot, 'demo')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(already.status, 1, 'existing folder refused'); assert.match(already.stderr, /already exists/)
    const usage = spawnSync(process.execPath, [resolve('tests/demo-progress.mjs'), join(repoRoot, 'other'), '--frame', 'x'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(usage.status, 2, 'invalid --frame refused'); assert.match(usage.stderr, /^usage: /)
    scriptNotifications = [...r.stdout.matchAll(/^ +notification (.*)$/gm)].map(x => x[1])
  })

  testCase('/progress demo: each frame follows the schema of the contract, and gives the same notifications as the real progress.mjs', () => {
    const T = Date.parse('2026-10-09T10:00:00Z')
    for (let k = 0; k < D.FRAME_COUNT; k++) {
      const f = join(repoRoot, `demo-${k}.json`)
      assert.equal(D.demoDoc(k, T).format, 'orchestre-progress/3', 'in the format progress.mjs writes')
      writeFileSync(f, JSON.stringify(D.demoDoc(k, T)))
      const v = spawnSync(process.execPath, [PROGRESS, 'validate', '--file', f], { encoding: 'utf8' })
      assert.equal(v.status, 0, `frame ${k}: ${v.stderr}`)
    }
    /** @type {string[]} */
    const notifications = []
    let before = null
    for (let k = 0; k < D.FRAME_COUNT; k++) { const after = D.demoSnapshot(k, T); notifications.push(...M.changes(before, after)); before = after }
    assert.ok(scriptNotifications.length >= 8, scriptNotifications.join(' | '))
    assert.deepEqual(notifications, scriptNotifications, 'same notifications as tests/demo-progress.mjs, played by the real progress.mjs')
    // Same log, entry for entry, except the build of the first progress.json
    const real = JSON.parse(readFileSync(join(repoRoot, 'demo', 'plans', 'demo', 'progress.json'), 'utf8')).log.filter(j => !/^progress\.json rebuilt/.test(j.text))
    assert.deepEqual(D.demoDoc(D.FRAME_COUNT - 1, T).log.map(j => `${j.kind} | ${j.text}`), real.map(j => `${j.kind} | ${j.text}`))
    assert.deepEqual([before.runs.length, before.run.status, before.tasks.filter(t => t.status === 'merged').length, before.reviews.length, before.decisions.length], [2, 'finished', 5, 3, 1])
    // The banner says it is a demo
    const b = M.banner(D.demoSnapshot(3, T), D.frameInstant(3, T), 140)
    assert.match(M.plainText(b), /^▶ {2}DEMO {2}showcase-site {2}◉○ /); assert.ok(b.some(m => m.t === ' DEMO ' && m.f === 'merged'))
    assert.equal(M.normalize(D.demoDoc(3, T)).demo, false, 'a real progress.json is never a demo')
    // The time: one frame every 3 s, a pause of 12 s when run 1 stops, then a minute before going back to the real progress
    assert.deepEqual([D.frameAt(T - 1, T), D.frameAt(T, T), D.frameAt(T + 2999, T), D.frameAt(T + 3000, T)], [-1, 0, 0, 1])
    assert.equal(D.frameInstant(12, T) - D.frameInstant(11, T), 4 * D.DEMO_FRAME_MS)
    assert.equal(D.demoEnd(T), D.frameInstant(D.FRAME_COUNT - 1, T) + 60000, 'the real progress comes back a minute after the last frame')
    assert.equal(D.frameAt(D.demoEnd(T), T), D.FRAME_COUNT - 1)
  })

  console.log(`progress mod: ALL GREEN (${n} cases)`)
} finally {
  rmSync(repoRoot, { recursive: true, force: true })
}
