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
import { INHERITED, convertV3 } from '../plugins/orchestre/scripts/progress.mjs'

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

  testCase('format: orchestre-progress/4 written by progress.mjs, /3 of 0.19 read alike; the 0.11 formats (suivi.json) and any other refused without guessing', () => {
    assert.ok(A); assert.equal(A.plan, 'demo'); assert.equal(A.tasks.length, 4)
    assert.equal(rawFile().format, 'orchestre-progress/4')
    assert.deepEqual([M.FORMAT, M.FORMATS], ['orchestre-progress/4', ['orchestre-progress/4', 'orchestre-progress/3']])
    assert.deepEqual(M.LEGACY_FORMATS, ['orchestre-suivi/2', 'orchestre-suivi/1'])
    // The same file in /3 (without pending_rulings nor the ids of the issues) is read as in /4
    const { pending_rulings, ...v3 } = rawFile()
    assert.deepEqual(M.normalize({ ...v3, format: 'orchestre-progress/3' }), A)
    assert.equal(M.normalize({ format: 'orchestre-progress/5', tasks: [] }), null)
    assert.equal(M.normalize({ ...rawFile(), format: 'orchestre-progress/2' }), null)
    assert.equal(M.formatOf({ format: 'orchestre-progress/5' }), 'orchestre-progress/5')
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
    assert.deepEqual(X.prerequisites, [{ id: 'D5', type: 'decision', text: '', evidence: '', how: [], blocks: ['T04'] }])
    assert.deepEqual([X.lint, X.issues.map(p => p.title)], [{ ok: false, errors: 2 }, ['Open']])
  })

  testCase('/4 issues and pending rulings: the fields read as T13 fixed them; an issue with a ruling recorded leaves Your turn; /3 reads the same file without them', () => {
    const raw = rawFile()
    const opt = (id, o = {}) => ({ id, description: `Option ${id}`, valid: null, invalid_reason: null, effect: '', amends: [], ...o })
    const issue = (id, task, o = {}) => ({ id, run: 1, task, title: `Issue ${id}`, context: '', human: false, role: 'open', status: 'open', chosen_option: null, options: [opt('A'), opt('B', { valid: false, invalid_reason: 'amends a task of another phase', effect: 'adds T09', amends: ['T09'] })], ...o })
    const at = new Date(Date.parse(raw.updated) + 1000).toISOString()
    const four = { ...raw, issues: [issue('T02-1', 'T02'), issue('T03-1', 'T03', { without_actions: true })], pending_rulings: [] }
    const waiting = (doc, id) => M.yourTurnItems(M.normalize(doc), tA).items.filter(it => it.kind === 'issue to settle' && it.task === id).length
    const X = M.normalize(four)
    assert.deepEqual(X.issues.map(p => [p.id, p.withoutActions]), [['T02-1', false], ['T03-1', true]])
    assert.deepEqual(X.issues[0].options[1], { id: 'B', description: 'Option B', recommended: false, valid: false, invalidReason: 'amends a task of another phase', effect: 'adds T09', amends: ['T09'] })
    assert.deepEqual(X.issues[0].options[0].valid, null, 'valid stays null until the dry run')
    assert.deepEqual(X.pendingRulings, [])
    assert.deepEqual([waiting(four, 'T02'), waiting(four, 'T03')], [1, 1])
    // A ruling by option, a ruling by text: the issue no longer waits, the ruling is read, the other issue still waits
    const ruled = { ...four, pending_rulings: [{ issue: 'T02-1', option: 'A', text: null, at }, { issue: 'T03-1', option: null, text: 'Free answer', at }] }
    const Y = M.normalize(ruled)
    assert.deepEqual(Y.issues, [], 'both issues have their ruling')
    assert.deepEqual(Y.pendingRulings.map(r => [r.issue, r.option, r.text, r.at]), [['T02-1', 'A', null, Date.parse(at)], ['T03-1', null, 'Free answer', Date.parse(at)]])
    assert.deepEqual([waiting(ruled, 'T02'), waiting(ruled, 'T03')], [0, 0])
    const half = M.normalize({ ...ruled, pending_rulings: ruled.pending_rulings.slice(0, 1) })
    assert.deepEqual(half.issues.map(p => p.id), ['T03-1'])
    assert.deepEqual(M.normalize({ ...four, pending_rulings: [{ issue: 'T09-1', option: null, text: 'x', at }] }).issues.length, 2, 'a ruling on another issue changes nothing')
    assert.deepEqual(M.normalize({ ...four, pending_rulings: [null, { issue: 42, option: 'A', text: null, at }, ...ruled.pending_rulings.slice(0, 1)] }).pendingRulings.map(r => r.issue), ['T02-1'], 'an entry without an issue id is not a ruling')
    // /3: no id, no pending_rulings, no actions; the same issues wait, read as progress.mjs convertV3 converts /3: ids <task>-<n>
    // in the order of the file (a settled issue counts), withoutActions, options invalid
    const doc3 = { ...raw, format: 'orchestre-progress/3', issues: [{ ...four.issues[0], status: 'settled', chosen_option: 'A' }, ...four.issues].map(({ id, without_actions, ...p }) => ({ ...p, options: [{ id: 'A', description: 'Option A' }] })) }
    const three = M.normalize(doc3)
    assert.deepEqual(three.issues.map(p => [p.id, p.withoutActions]), [['T02-2', true], ['T03-1', true]])
    assert.deepEqual(three.issues.map(p => p.id), convertV3(doc3).issues.filter(p => p.status !== 'settled').map(p => p.id), 'the ids progress.mjs writes')
    assert.deepEqual(three.issues[0].options, [{ id: 'A', description: 'Option A', recommended: false, valid: false, invalidReason: INHERITED, effect: '', amends: [] }])
    assert.deepEqual(three.pendingRulings, [])
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
    // D2: during a run, what waits for the session is `at run stop`: nothing is for now, the card stays quiet
    assert.equal(M.plainText(yourTurn.title), '✓ Nothing waits for you now'); assert.equal(M.plainText(yourTurn.meta), '1 to settle · 3 reviews · 1 auto-decision'); assert.equal(yourTurn.color, 'subtle')
    assert.equal(yourTurn.urgent, 0)
    const tt = text(yourTurn.lines)
    // 0.16.0: a line only selects; what it does is a button of its detail card
    assert.match(tt, /^⚑ T02 · Missing secret \(human\) +at run stop\n +secret missing for the tests$/m)
    assert.match(tt, /^⚑ T01 · agents\/x\/\.env\.example: add MR_MAX +after phase 1$/m)
    assert.match(tt, /^⇒ T01 · Retry threshold: A \(cap at 30 s\) +before phase 2$/m)
    const actions = yourTurn.lines.flat().filter(m => m.x).map(m => m.x)
    assert.deepEqual(actions.map(x => x.hotkey), ['1', '2', '3', '4', '5'])
    // 0.21.0: an issue is answered from its detail card; the prompt of the item is the one of [ Ask Claude ]
    assert.equal(actions[0].prompt, 'Explain the issue of T02 ("Missing secret") and its options.', 'an issue for a human: Ask Claude')
    assert.equal(actions[1].prompt, 'Review with me, before the PR (review of T01): agents/x/.env.example: add MR_MAX')
    assert.equal(actions[4].prompt, 'Go over the auto-decision for T01 with me: "Retry threshold", option A (cap at 30 s).')
    // Blocked without an issue: ask the pilot; open prerequisite: /orchestre:ready
    const blocked = { ...B, issues: [], tasks: B.tasks.map(t => (t.id === 'T02' ? { ...t, status: 'blocked' } : t)), prerequisites: [{ id: 'D5', type: 'decision', blocks: ['T04'] }] }
    const ab = M.yourTurnCard(blocked, tA, 100).lines.flat().filter(m => m.x).map(m => m.x.prompt)
    assert.equal(ab[0], 'Explain the blocker of T02 (secret missing for the tests) and propose a way forward.'); assert.ok(ab.includes('/orchestre:ready plans/demo'), 'the prerequisite of phase 2 comes after the reviews of phase 1: sorted by rank')
    assert.equal(M.yourTurnCard(A, tA, 100), null, 'nothing to do: no card')
    // plan-lint in error at the last write; tickets of HANDOFF.md, to open after the PR
    const linted = M.yourTurnCard({ ...A, lint: { ok: false, errors: 2 } }, tA, 100)
    assert.match(text(linted.lines), /^✗ plan-lint: 2 errors at the last progress update +at run stop$/m)
    assert.equal(linted.lines.flat().find(m => m.x).x.prompt, 'Show me the plan-lint errors on plans/demo and propose a fix.')
    assert.match(M.prText({ ...B, tickets: 2 }, tA), /\n2 tickets to open after the PR \(HANDOFF\.md, "ticket" entries\)\.\n$/)
    // Beyond 9 lines, pages of 9 (0.16.0): keys 1 to 9 on each, a button for the other page; a page out of range is brought back
    const many = { ...B, reviews: Array.from({ length: 10 }, (_, i) => ({ task: 'T01', phase: 1, text: `f${i}`, at: null })) }
    const keysOf = c => c.lines.flat().filter(m => m.x?.mode === 'select').map(m => m.x.hotkey)
    const first = M.yourTurnCard(many, tA, 100)
    assert.deepEqual(keysOf(first), ['1', '2', '3', '4', '5', '6', '7', '8', '9'])
    assert.match(text(first.lines), /^ {2}page 1\/2 {2}\[ Next 3 › \]$/m)
    assert.deepEqual(first.lines.flat().filter(m => m.x?.op === 'page').map(m => [m.x.page, m.x.hotkey, m.x.bracket]), [[1, null, true]])
    const second = M.yourTurnCard(many, tA, 100, null, { page: 1 })
    assert.deepEqual(keysOf(second), ['1', '2', '3']); assert.match(text(second.lines), /^ {2}page 2\/2 {2}\[ ‹ First 9 \]$/m)
    assert.deepEqual(keysOf(M.yourTurnCard(many, tA, 100, null, { page: 7 })), ['1', '2', '3'], 'page 8 of 2: the last')
    assert.equal(M.pageOf(12, -1), 0); assert.equal(M.pageOf(0, 3), 0)
    const run = text(M.runCard(B, tA, 100, false).lines)
    assert.match(run, /^time {4}\S.* · 2 in parallel · 1 more attempt · 1 auto-decision$/m); assert.match(run, /^tasks .* 1\/4 /m); assert.doesNotMatch(run, /next/, 'run in progress: no next')
    const pr = M.prText(B, tA)
    assert.match(pr, /^- \[ \] T01: agents\/x\/\.env\.example: add MR_MAX$/m); assert.match(pr, /^- \[ \] T01, Retry threshold: option A, cap at 30 s$/m); assert.match(pr, /Not merged yet: T02 \(waits for a human\)/)
    const state = M.stateText(B, tA)
    assert.match(state, /^▶ demo {2}◉○/); assert.match(state, /\n✓ Nothing waits for you now {3}1 to settle/); assert.match(state, /\nlog/)
    const j = M.logCard(B, tA, 100, false)
    assert.equal(j.lines.length, M.SHORT_LOG); assert.match(text(j.lines), /⚑ /); assert.equal(M.plainText(j.meta), `l: all (${B.log.length})`)
    assert.equal(M.logCard(B, tA, 100, true).lines.length, B.log.length)
  })

  progress('run-end', { ...EMPTY_SUMMARY, status: 'awaiting-ruling', phase: 1, mode: 'auto', stop_issue: SECRET, waiting: ['T02'] })
  const C = readFile()
  // The file itself, for the cases that answer an issue (0.21.0)
  const rawC = rawFile()

  testCase('end of run: notification, end banner, no more suffix nor task in progress', () => {
    assert.deepEqual(rawFile().issues.map(p => [p.title, p.role]), [['Missing secret', 'stop']], 'the scribe notes the issue at the close, the run end makes it the stop issue')
    assert.deepEqual(M.changes(B, C), ['Run 1 (phase 1): awaiting-ruling', 'Run stopped: T02, Missing secret'], 'issue become the stop issue')
    assert.match(M.plainText(M.banner(C, tA, 140)), /^■ demo {2}◉○ {2}\S+ {2}1\/4 {2}⚑ 3 to review {2}⚠ 1 your turn {2}run 1 awaiting-ruling {2}⏱ /)
    assert.equal(M.suffix(C, tA), null); assert.deepEqual(M.inProgress(C, tA), [])
    assert.match(text(M.yourTurnCard(C, tA, 100).lines), /^⚑ T02 · Missing secret \(human\) +now$/m)
    // Run finished: what comes next in one key
    const rc = M.runCard(C, tA, 100, false)
    assert.equal(M.plainText(rc.title), '■ Run 1 · phase 1 · autonomous'); assert.equal(rc.color, 'warning')
    const next = rc.lines.flat().find(m => m.x)
    assert.deepEqual([next.x.hotkey, next.x.prompt, next.x.bracket], [null, '/orchestre:run plans/demo --resume', true], 'a button without a key (0.16.0)')
    assert.match(text(rc.lines), /^next {4}\[ Resume command in the prompt \] {2}\/orchestre:run plans\/demo --resume$/m)
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
    assert.deepEqual([next.x.hotkey, next.x.prompt], [null, M.prText(H, tE)])
    assert.match(text(M.runCard(H, tE, 100, false).lines), /^next {4}\[ PR draft in the prompt \] {2}\[ Close the plan \]$/m)
    assert.deepEqual(M.runCard(H, tE, 100, false).lines.flat().filter(m => m.x?.op === 'closePlan').map(m => [m.x.hotkey, m.x.bracket]), [[null, true]], 'the plan finished can be closed (0.16.1)')
    assert.match(text(M.runCard(H, tE, 40, false).lines), /^next {4}\[ PR draft in the prompt \]\n {8}\[ Close the plan \]$/m, 'narrow: over two lines')
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
    // The column makes no line longer than the width; below 69 columns (the grid's least room, with this plan's short
    // titles), it goes away
    for (const w of [140, 120, 100, 80, 69, 68, 60, 50]) {
      const withModel = M.taskLines(I, t4, w), withoutModel = M.taskLines(noModel, t4, w)
      withModel.forEach((l, i) => assert.ok(M.width(l) <= Math.max(w, M.width(withoutModel[i])), `${w}: ${M.width(l)} "${M.plainText(l)}"`))
    }
    // 0.19.0: no timeline under 80 columns, so the model column holds on down to 69 columns here (the titles are short: 16
    // cells keep all their text)
    assert.match(M.plainText(line(I, 'T02', 69)), /sonnet → opus/); assert.doesNotMatch(M.plainText(line(I, 'T02', 68)), /sonnet|opus/)
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
    // 0.19.0: the title goes first, so at 80 columns (with the timeline) the step is cut before the attempt shows; at 76,
    // without a timeline, the attempt shows again
    assert.match(T02(80), / verification$/); assert.match(T02(76), /verification attempt 2$/); assert.match(T02(58), / verification$/)
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
        const G = M.taskGrid(X, t, w), ls = M.taskLines(X, t, w), at = `frame ${k}, ${w} columns`
        const tasks = ls.filter(isTask)
        assert.ok(tasks.length, at)
        for (const l of tasks) {
          const c = cells(l), id = c.slice(4).join('').split(' ')[0], task = X.tasks.find(x => x.id === id), s = c.join('')
          assert.equal(c.slice(G.at.title - 2, G.at.title + 1).join('').slice(0, 2), '  ', `${at}: title of ${id}, "${s}"`)
          assert.notEqual(c[G.at.title], ' ', `${at}: title of ${id}, "${s}"`)
          // 0.19.0: a task with no segment and no duration (to do, or waiting) draws no dots, its title takes their room; under 80 columns, no task has a timeline
          const bare = !M.stepsOf(X, task, t).length && (task.start == null || task.end == null)
          assert.equal(G.timeline > 0, w >= 80, `${at}: timeline column`)
          if (bare) {
            assert.doesNotMatch(c.slice(G.at.title, G.at.model).join(''), /[━╸·─]/, `${at}: no dot on ${id}, "${s}"`)
            assert.equal([...M.titleCell(task.title, G.bare)].length, G.bare, `${at}: bare title of ${id}`)
          } else {
            if (G.timeline) assert.match(c.slice(G.at.timeline - 2, G.at.timeline + 1).join(''), /^ {2}[━╸·─]$/, `${at}: timeline of ${id}, "${s}"`)
            else assert.doesNotMatch(c.slice(G.at.title, G.at.model).join(''), /[━╸─]/, `${at}: no timeline on ${id}, "${s}"`)
            assert.match(c.slice(G.at.time - 2, G.at.time + 9).join(''), /^ {2} *(\d+:\d{2}(:\d{2})?|—)? {2}$/, `${at}: duration of ${id}, "${s}"`)
          }
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

  testCase('tasks card, readable titles (0.19.0): titles first, no timeline under 80 columns, a task to do draws no dots, "waits for" and the retries within the room', () => {
    const T = Date.parse('2026-10-09T10:00:00Z'), t = D.frameInstant(4, T) + 500, base = D.demoSnapshot(4, T)
    // Frame 4: T01 merged, T02 in its fix (attempt 2, worktree, sonnet → opus), T03 to do. Long titles, tasks to do that
    // wait for ids of another plan, retries on four tasks of the phase
    const T03 = base.tasks.find(x => x.id === 'T03')
    const titles = { T01: 'Fixes after the evaluation of the first batch', T02: 'Server: portfolio loading and its cache', T03: 'Server: contracts of an account and its hotels' }
    const waiting = { T03: ['AH06'], T06: ['AH06'], T07: ['AH06', 'AH07', 'AH08', 'AH09'] }
    const longTitle = 'Routing: the answer to a vague request, with the long title of a real plan'
    const plan = tasks => ({ ...base, tasks })
    const X = plan([
      ...base.tasks.map(x => ({ ...x, title: titles[x.id] ?? x.title, attempts: x.id === 'T01' ? 3 : x.attempts, waiting: waiting[x.id] ?? x.waiting })),
      { ...T03, id: 'T06', title: 'The hub, three readings', waiting: waiting.T06, attempts: 3 },
      { ...T03, id: 'T07', title: longTitle, waiting: waiting.T07, attempts: 2 },
    ])
    const noModel = plan(X.tasks.map(x => ({ ...x, model: null, modelUsed: null })))
    const row = (Y, w, id) => M.taskLines(Y, t, w).find(l => M.plainText(l).match(/^ {2}\S (\S+)/)?.[1] === id)
    const dots = l => /[━╸·─]/.test(M.plainText(l))

    // 58 columns: the title of a started task goes from 10 to 20 cells, that of a task to do to 29; one line per task
    assert.deepEqual(['title', 'bare', 'timeline', 'model'].map(k => M.taskGrid(X, t, 58)[k]), [20, 29, 0, 0])
    assert.match(M.plainText(row(X, 58, 'T03')), /^ {2}○ T03 {4}Server: contracts of an acco… {2}waits for AH06$/)
    assert.match(M.plainText(row(X, 58, 'T02')), /^ {2}◐ T02 {4}Server: portfolio l… {2} *\d+:\d{2} {2}fix attempt 2$/)
    assert.ok(!dots(row(X, 58, 'T03')) && !dots(row(X, 58, 'T02')), 'no dot on a task to do, no timeline on a started task')
    assert.ok(!M.taskLines(X, t, 58).some(l => /━ work/.test(M.plainText(l))), 'no legend of the steps without a timeline')
    // waits for ...: whole ids, the others counted, never an id cut
    assert.match(M.plainText(row(X, 58, 'T07')), / {2}waits for AH06…$/, 'room for the first id and not for its count')
    assert.match(M.plainText(row(X, 70, 'T07')), / {2}waits for AH06 \+3$/)
    assert.equal(M.waitsFor(['AH06', 'AH07', 'AH08', 'AH09'], 23), 'waits for AH06, AH07 +2')
    assert.equal(M.waitsFor(['AH06', 'AH07'], 32), 'waits for AH06, AH07')
    assert.equal(M.waitsFor(['AH06', 'AH07', 'AH08', 'AH09', 'AH10'], 99), 'waits for AH06, AH07, AH08, AH09 +1')
    for (let n = 15; n < 40; n++) assert.ok(M.waitsFor(['AH06', 'AH07', 'AH08', 'AH09', 'AH10'], n).split(/[ ,]+/).every(w => /^(waits|for|AH\d\d…?|\+\d)$/.test(w)), `${n}: ${M.waitsFor(['AH06', 'AH07', 'AH08', 'AH09', 'AH10'], n)}`)
    // The line of a phase fits, whatever the width; its name and its counter stay whole, the retries are cut to the room left
    for (const w of [120, 80, 58, 50]) {
      const ph = M.taskLines(X, t, w).find(l => /Phase 1/.test(M.plainText(l)))
      assert.ok(M.width(ph) <= w, `${w}: ${M.width(ph)} "${M.plainText(ph)}"`)
      assert.match(M.plainText(ph), /^◉ Phase 1 +0\/5 /, `${w}: name and counter whole`)
    }
    assert.match(M.plainText(M.taskLines(X, t, 120).find(l => /Phase 1/.test(M.plainText(l)))), / T01 ×3, T02 ×2, T06 ×3…$/)
    // 28 tasks in the phase: the squares give way to a bar when they would push the line past the width
    const many = plan([...X.tasks, ...Array.from({ length: 23 }, (_, i) => ({ ...T03, id: `T1${i}`, title: `Extra task ${i}` }))])
    for (const w of [58, 50, 44]) for (const l of M.taskLines(many, t, w).filter(x => /^[◉●○◐⚠] Phase/.test(M.plainText(x)))) assert.ok(M.width(l) <= w, `${w}: ${M.width(l)} "${M.plainText(l)}"`)
    const phase1 = w => M.plainText(M.taskLines(X, t, w).find(l => /Phase 1/.test(M.plainText(l))))
    assert.match(phase1(50), / T01 ×3, T02 ×2…$/); assert.match(phase1(40), / T01 ×3…$/, phase1(40)); assert.doesNotMatch(phase1(33), /×|…/, 'no room: no retries')

    // The columns grow title first (28), then what the task does (24), then the timeline (26), then the title (48)
    assert.deepEqual(['title', 'what', 'timeline', 'model'].map(k => M.taskGrid(noModel, t, 100)[k]), [28, 24, 24, 0])
    assert.deepEqual(['title', 'what', 'timeline'].map(k => M.taskGrid(noModel, t, 140)[k]), [48, 42, 26])
    // The timeline goes under 80 columns
    assert.deepEqual([79, 80].map(w => M.taskGrid(noModel, t, w).timeline > 0), [false, true])
    // The model column stays while the title keeps 24 cells with it (87 columns here), and with its own text if shorter
    assert.deepEqual([80, 86, 87, 100, 120].map(w => M.taskGrid(X, t, w).model), [0, 0, 13, 13, 13])
    assert.ok(M.taskGrid(X, t, 87).title >= 24)
    assert.equal(M.taskGrid(plan(X.tasks.map(x => ({ ...x, title: x.title.slice(0, 12) }))), t, 80).model, 13, 'short titles: they keep all their text')
    // 120 columns: a started task keeps its timeline, its duration, its model and its step
    assert.match(M.plainText(row(X, 120, 'T02')), /[━╸]+ +\d+:\d{2} {2}sonnet → opus {2}fix attempt 2 \(worktree\)$/)
    // One line per task: the card does not move when a task starts
    const started = plan(X.tasks.map(x => (x.id === 'T03' ? { ...x, step: 'worker', start: t - 5000, attempts: 1, waiting: [] } : x)))
    for (const w of [58, 80, 120]) assert.equal(M.taskLines(started, t, w).length, M.taskLines(X, t, w).length, `${w}`)
  })

  testCase('pane within its width (0.13.1): no line wider than its card, the steps closer then over two lines, the step column at its content', () => {
    const T = Date.parse('2026-10-09T10:00:00Z')
    // A line wider than its card makes the terminal shorten each of its pieces ("…verif", "merge 2:…")
    for (let k = 0; k < D.FRAME_COUNT; k++) {
      const I = D.demoSnapshot(k, T), t = D.frameInstant(k, T) + 500
      for (const w of [160, 120, 100, 80, 70, 60]) {
        const p = M.pane(I, t, w)
        for (const c of p.cards) for (const l of c.lines) assert.ok(M.width(l) <= (p.borders && c.color ? w - 4 : w), `frame ${k}, ${w}, ${c.id}: ${M.width(l)} "${M.plainText(l)}"`)
      }
    }
    // The steps of a run of 18 min seen at 80 columns (68 cells after "steps   "): two spaces instead of " · "; narrower, two lines
    const items = [['work', '14:36'], ['verif', '3:00'], ['eval', '3:06'], ['fix', '1:12'], ['merge', '1:12'], ['prog', '0:24']].map(([e, d]) => [{ t: `${e} ${d}`, c: 'subtle' }])
    assert.deepEqual(M.stepLines(items, 80).map(M.plainText), ['work 14:36 · verif 3:00 · eval 3:06 · fix 1:12 · merge 1:12 · prog 0:24'])
    assert.deepEqual(M.stepLines(items, 68).map(M.plainText), ['work 14:36  verif 3:00  eval 3:06  fix 1:12  merge 1:12  prog 0:24'])
    const two = M.stepLines(items, 50)
    assert.deepEqual(two.map(M.plainText), ['work 14:36 · verif 3:00 · eval 3:06 · fix 1:12', 'merge 1:12 · prog 0:24'])
    assert.ok(two.every(l => M.width(l) <= 50))
    // What the task does takes the width of its longest text: "work (worktree)" leaves the room to the timeline, "fix attempt 2
    // (worktree)" takes it back
    const I1 = D.demoSnapshot(1, T), t1 = D.frameInstant(1, T) + 500, I4 = D.demoSnapshot(4, T), t4 = D.frameInstant(4, T) + 500
    assert.equal(M.taskGrid(I1, t1, 88).what, 16)
    assert.equal(M.taskGrid(I4, t4, 88).what, 24)
    assert.ok(M.taskGrid(I1, t1, 88).timeline > M.taskGrid(I4, t4, 88).timeline)
    const waits = { ...I1, tasks: I1.tasks.map(x => (x.id === 'T03' ? { ...x, waiting: ['T01', 'T02'] } : x)) }
    assert.equal(M.taskGrid(waits, t1, 88).what, [...'waits for T01, T02'].length, 'a task to do counts too')
    // The resume of a long plan at 60 columns: "in the prompt" goes, then the command is cut; the prompt keeps it whole
    const I11 = D.demoSnapshot(11, T), t11 = D.frameInstant(11, T) + 500, dir = 'plans/checkout-flow-with-saved-cards-and-wallets'
    const next = M.runCard({ ...I11, dir }, t11, 60, false).lines.find(l => /^next/.test(M.plainText(l)))
    assert.ok(next && M.width(next) <= 56, `${next && M.plainText(next)}`)
    assert.equal(next.find(m => m.x)?.x?.prompt, `/orchestre:run ${dir} --resume`)
    assert.match(M.plainText(next), /…$/)
  })

  testCase('detail card (0.14.0): the whole text of the selected item, within its width, above "Your turn"; gone with the item', () => {
    const long = 'The report of re-scored hotels_within_km (geo-poi, geo-class, qa14707, both builds) shows the score drop on geo-class only; confirm it is the expected effect of the rule change and not a regression of the fixtures'
    const L = { ...B, reviews: [...B.reviews, { task: 'T03', phase: 2, text: long, at: null }] }
    const items = M.yourTurnItems(L, tA).items
    assert.equal(new Set(items.map(it => it.key)).size, items.length, 'one key per item')
    assert.deepEqual(M.yourTurnItems(L, tA).items.map(it => it.key), items.map(it => it.key), 'the same keys from one drawing to the next')
    const k = items.find(it => it.text.includes('re-scored')).key, rank = items.findIndex(it => it.key === k) + 1
    // Nothing selected: no detail card, the lines as before, each with a select action
    assert.equal(M.detailCard(L, tA, 100, null), null)
    assert.deepEqual(M.pane(L, tA, 100).cards.map(c => c.id), ['yourTurn', 'run', 'tasks', 'log'])
    assert.ok(M.yourTurnCard(L, tA, 100).lines.flat().filter(m => m.x).every(m => m.x.mode === 'select' && m.x.key))
    for (const columns of [80, 120]) {
      const p = M.pane(L, tA, columns, { selected: k })
      assert.deepEqual(p.cards.map(c => c.id), ['detail', 'yourTurn', 'run', 'tasks', 'log'], 'the detail card right above "Your turn"')
      assert.equal(p.selection, k)
      const d = p.cards[0]
      assert.equal(d.color, 'claude')
      assert.equal(M.plainText(d.title), `▸ Detail · ${rank} · T03 · review`)
      assert.equal(M.plainText(d.meta), M.CLOSE_LABEL)
      assert.ok(M.width(d.title) + M.width(d.meta) + 1 <= columns - 4, 'title and Close on one line')
      for (const l of d.lines) assert.ok(M.width(l) <= columns - 4, `${columns} columns: ${M.plainText(l)}`)
      // The whole text, word for word, over several lines, under the rule (0.17.0); then the buttons, without a key (0.16.0)
      const rule = d.lines.findIndex(l => /^─+$/.test(M.plainText(l)))
      const body = d.lines.slice(rule + 1, d.lines.findIndex((l, i) => i > rule && !l.length)).map(M.plainText).join(' ')
      assert.equal(body, long)
      const whatLines = d.lines.slice(rule + 1, d.lines.findIndex((l, i) => i > rule && !l.length))
      assert.equal(whatLines.every(l => l.every(m => m.b)), whatLines.length <= 2, `${columns} columns: in bold on two lines at most, ${whatLines.length} here`)
      assert.ok(!d.lines.some(l => /^ {2}› /.test(M.plainText(l))), 'no prompt line: it would repeat the text (0.17.0)')
      assert.ok(d.lines.length > 3)
      const act = d.lines.flat().filter(m => m.x)
      assert.deepEqual(act.map(m => [m.t, m.x.hotkey, m.x.op ?? null, m.x.bracket, m.x.key]), [
        ['[ Review with Claude ]', null, null, true, k], ['[ ✓ Done ]', null, 'done', true, k], ['[ → Ticket ]', null, 'ticket', true, k], ['[ ✎ Edit text ]', null, 'edit', true, k],
      ])
      assert.equal(act[0].x.prompt, `Review with me, before the PR (review of T03): ${long}`)
      assert.equal(act[1].x.prompt, `/orchestre:done plans/demo review T03 ${long}`, 'what goes into the prompt without node')
      assert.equal(act[2].x.prompt, `/orchestre:done plans/demo ticket review T03 ${long}`)
      assert.deepEqual(act[1].x.ref, { kind: 'review', task: 'T03', text: long, shown: long, original: long, edited: false })
      // The selected line: ▸ and bold, still cut
      const line = p.cards[1].lines.find(l => l.some(m => m.x?.key === k))
      assert.deepEqual([line[0].t, line[0].c, line[2].b], ['▸', 'claude', true])
      assert.match(line[2].t, /…$/)
    }
    // A blocker: under the text, dim (0.17.0)
    const blocked = M.detailCard(B, tA, 60, M.yourTurnItems(B, tA).items[0].key)
    assert.match(M.plainText(blocked.lines.find(l => /^ {2}blocker/.test(M.plainText(l)))), /^ {2}blocker: secret missing for the tests$/)
    assert.match(M.plainText(blocked.title), /^▸ Detail · 1 · T02 · waits for you$/)
    // The item is gone (review settled): no more detail card, no more selection
    const gone = M.pane(B, tA, 100, { selected: k })
    assert.deepEqual([gone.cards[0].id, gone.selection], ['yourTurn', null])
    // Beyond 9: its rank on its own page only (0.16.0)
    const many = { ...B, reviews: Array.from({ length: 10 }, (_, i) => ({ task: 'T01', phase: 1, text: `f${i}`, at: null })) }
    const tenth = M.yourTurnItems(many, tA).items[10]
    assert.equal(M.plainText(M.detailCard(many, tA, 100, tenth.key).title), '▸ Detail · T01 · review')
    assert.equal(M.plainText(M.detailCard(many, tA, 100, tenth.key, { page: 1 }).title), '▸ Detail · 2 · T01 · review')
    assert.equal(M.detailCard(many, tA, 100, tenth.key).lines.flat().find(m => m.x).t, '[ Review with Claude ]')
    // The same review twice: two keys
    const twice = { ...B, reviews: [B.reviews[0], B.reviews[0]] }
    assert.deepEqual(M.yourTurnItems(twice, tA).items.filter(it => it.group === 'review').map(it => it.key.replace(/^review\|.*?(#\d)?$/, '$1')), ['', '#2'])
  })

  testCase('detail card (0.17.0): when and where on top, aired; what it is; steps, check and command of a prerequisite; one-line note', () => {
    // During run 1 (phase 1, in progress): H1 holds back T04 (phase 2), E1 holds back T02 (phase 1)
    const H1 = { id: 'H1', type: 'manual', text: 'API token in `.env.local`', evidence: '`grep -c TOKEN .env.local`', how: ['Ask the contracts team for a staging token.', 'Add it to `.env.local` as `TOKEN`, never in the repository, and keep a copy in the team vault.'], blocks: ['T04'] }
    const H = { ...B, prerequisites: [H1, { id: 'E1', type: 'environment', text: '', evidence: '—', how: [], blocks: ['T02'] }, { id: 'D5', type: 'decision', blocks: ['T04'] }] }
    const items = M.yourTurnItems(H, tA).items, item = id => items.find(x => x.task === id)
    const MANUAL = 'Outside Claude (a secret stays out of the chat), then this session to mark it done'
    assert.deepEqual([item('H1').kind, item('H1').what, item('H1').when, item('H1').where, item('H1').check], ['manual action', H1.text, 'Before phase 2', MANUAL, H1.evidence])
    assert.deepEqual([item('E1').kind, item('E1').what, item('E1').when, item('E1').where, item('E1').check], ['environment to set up', 'E1 (environment) open', 'Now', 'Your terminal, then this session: /orchestre:ready checks it', undefined], 'T02 is in the phase of the run: now; no text, its id; "—" is no evidence')
    assert.deepEqual([item('D5').kind, item('D5').where, item('D5').how], ['decision to take', 'This session, between two runs: /orchestre:ready asks the question', []])
    assert.deepEqual(items.filter(x => x.group !== 'settle' || x.task === 'T02').map(x => [x.task, x.kind, x.when, x.where]), [
      ['T02', 'waits for you', 'At run stop', 'This session, once the run stops'],
      ['T01', 'review', 'After phase 1', 'This session once no run is going (the agents work in the main checkout), or the PR on GitHub'],
      ['T02', 'review', 'After phase 1', 'This session once no run is going (the agents work in the main checkout), or the PR on GitHub'],
      ['T02', 'review', 'After phase 1', 'This session once no run is going (the agents work in the main checkout), or the PR on GitHub'],
      ['T01', 'auto-decision', 'Before phase 2', 'This session, between two runs (reversing it amends the plan)'],
    ])
    // The card: when, a blank line, where, a blank line, a rule; then what it is, in bold, and under it, dim and indented
    for (const columns of [80, 44]) {
      const inner = columns - 4, d = M.detailCard(H, tA, columns, item('H1').key), L = d.lines.map(M.plainText)
      assert.equal(M.plainText(d.title), `▸ Detail · ${items.indexOf(item('H1')) + 1} · H1 · manual action`)
      for (const l of d.lines) assert.ok(M.width(l) <= inner, `${columns} columns: ${M.plainText(l)}`)
      const where = M.wrap(MANUAL, inner - 9)
      assert.deepEqual(L.slice(0, 5 + where.length), ['when     Before phase 2', '', ...where.map((t, j) => `${j ? '         ' : 'where    '}${t}`), '', '─'.repeat(inner), M.wrap(H1.text, inner)[0]])
      assert.deepEqual([d.lines[0][0].c, d.lines[0][0].b, d.lines[0][1].c], ['suggestion', true, 'suggestion'], 'when and where in the color of what waits for you')
      assert.ok(d.lines[4 + where.length].every(m => m.b), 'what it is: in bold')
      const at = re => L.findIndex(l => re.test(l))
      const order = [/^ {2}blocks T04$/, /^ {2}1\. Ask the contracts team/, /^ {2}2\. Add it to/, /^ {2}check {2}`grep -c TOKEN \.env\.local`$/, /^ {2}› \/orchestre:ready plans\/demo$/, /^\[ Settle the prerequisites \]/, /^First button: fills the prompt, sends/]
      const places = order.map(at)
      assert.ok(places.every((x, i) => x > 0 && (i === 0 || x > places[i - 1])), `${columns} columns, in this order: ${JSON.stringify(places)}\n${L.join('\n')}`)
      // A long step: its words wrapped under its first word
      const step2 = at(/^ {2}2\. /)
      assert.match(L[step2 + 1], /^ {5}\S/)
      assert.equal(L[places[5] - 1], '', 'a blank line before the buttons')
    }
    // A review: no prompt line (it repeats its text), the note of the buttons that apply at once
    const r = M.detailCard(H, tA, 80, items.find(x => x.group === 'review').key).lines.map(M.plainText)
    assert.ok(!r.some(l => /^ {2}› /.test(l)), r.join('\n'))
    assert.equal(r.at(-1), 'First button: fills the prompt, sends nothing. Others: apply at once.')
    // 0.21.0: T02 carries an issue, answered from its card: no command line, the answer buttons
    const t02 = M.detailCard(H, tA, 80, item('T02').key).lines.map(M.plainText)
    assert.ok(!t02.some(l => /^ {2}› /.test(l)) && t02.includes('[ Other… ]  [ Ask Claude ]'), t02.join('\n'))
    // The run stopped: where and when change; no run yet; all merged; a review of the source plan; a decision of the last phase
    const stopped = { ...H, run: { ...H.run, status: 'awaiting-ruling' } }
    const sItems = M.yourTurnItems(stopped, tA).items, sItem = id => sItems.find(x => x.task === id)
    assert.deepEqual([sItem('T02').where, sItem('E1').when, sItem('H1').when], ['Here: applied when the next run starts', 'Now', 'Before phase 2'])
    const blocked = { ...stopped, issues: [], tasks: stopped.tasks.map(t => (t.id === 'T02' ? { ...t, status: 'blocked' } : t)) }
    assert.deepEqual(['kind', 'when', 'where'].map(k => M.yourTurnItems(blocked, tA).items[0][k]), ['blocked task', 'Now', 'This session: the run is stopped, ask the pilot'])
    assert.equal(M.yourTurnItems({ ...H, runs: [], run: null }, tA).items.find(x => x.task === 'H1').when, 'Before phase 2', 'the label says before phase 2: so does the card')
    assert.equal(M.yourTurnItems({ ...H, prerequisites: [{ id: 'H9', type: 'manual', blocks: [] }] }, tA).items.find(x => x.task === 'H9').when, 'Before the next run', 'holding back no task: not "Now", even during a run')
    const merged = { ...H, prerequisites: [], issues: [], tasks: H.tasks.map(t => ({ ...t, status: 'merged', step: null })) }
    assert.deepEqual([...new Set(M.yourTurnItems(merged, tA).items.map(x => x.when))], ['Before the PR'])
    const other = { ...stopped, prerequisites: [], reviews: [{ task: null, phase: null, text: 'README: relire', at: null }], decisions: [{ task: 'T04', title: 'Cap', option: 'A', description: '' }] }
    assert.deepEqual(M.yourTurnItems(other, tA).items.filter(x => x.group !== 'settle').map(x => x.when), ['Before the PR', 'Before the PR'])
    // Read from progress.json: the text, the evidence and the steps of an open prerequisite
    const raw = rawFile()
    assert.deepEqual(M.normalize({ ...raw, prerequisites: [{ ...H1, status: 'open' }, { ...H1, id: 'H2', status: 'done' }] }).prerequisites, [{ id: 'H1', type: 'manual', text: H1.text, evidence: H1.evidence, how: H1.how, blocks: ['T04'] }])
  })

  testCase('your turn by moment (0.19.0): label and rank, sorted, "later" line, counters, badge and banner, what waits behind, reviews in double', () => {
    // C: run 1 stopped, T02 waits for a human (issue), three reviews and one auto-decision. E1 holds back T02 (phase 1), H1 and the
    // decision of T01 point at phase 2, H9 holds nothing back, one review is of the source plan
    const prerequisites = [{ id: 'E1', type: 'environment', text: 'Docker up', blocks: ['T02'] }, { id: 'H1', type: 'manual', text: 'Token', blocks: ['T04'] }, { id: 'H9', type: 'manual', text: 'Old', blocks: [] }]
    const P = { ...C, prerequisites, reviews: [...C.reviews, { task: null, phase: null, text: 'README: reread', at: null }] }
    const moments = I => M.yourTurnItems(I, tA).items.map(x => [x.task, x.moment, x.rank])
    assert.deepEqual(moments(P), [
      ['T02', 'now', 0], ['E1', 'now', 0],
      ['T01', 'after phase 1', 1], ['T02', 'after phase 1', 1], ['T02', 'after phase 1', 1],
      ['H1', 'before phase 2', 1.5], ['T01', 'before phase 2', 1.5],
      ['H9', 'before the next run', 98], ['source plan', 'before the PR', 99],
    ], 'sorted by rank; the order of the list stays at an equal rank')
    assert.deepEqual(M.yourTurnItems({ ...P, runs: [], run: null }, tA).items.filter(x => x.group === 'settle').map(x => [x.task, x.moment]), [['T02', 'now'], ['E1', 'now'], ['H1', 'before phase 2'], ['H9', 'before the first run']], 'no run yet: the first run, not the next one')
    // D2: the same plan with the run going on (B has run 1 in progress): what needs the session is `at run stop`, the prerequisite stays `now`
    const L = { ...B, prerequisites }
    assert.deepEqual(moments(L).slice(0, 2), [['E1', 'now', 0], ['T02', 'at run stop', 0.2]])
    assert.deepEqual([M.yourTurnItems(C, tA).urgent, M.yourTurnItems(B, tA).urgent, M.yourTurnItems(P, tA).urgent, M.yourTurnItems(L, tA).urgent], [1, 0, 2, 1], 'only `now` counts')
    // A blocked task without an issue, a decision to take of the phase in progress, plan-lint in error: all now while no run goes
    const D1 = { id: 'D1', type: 'decision', text: 'Pick a cap', blocks: ['T02'] }, D9 = { id: 'D9', type: 'decision', text: 'Pick a name', blocks: ['T04'] }
    const blocked = { ...P, issues: [], lint: { ok: false, errors: 1 }, prerequisites: [...prerequisites, D1, D9], tasks: P.tasks.map(t => (t.id === 'T02' ? { ...t, status: 'blocked' } : t)) }
    assert.deepEqual(moments(blocked).filter(x => x[2] === 0).map(x => x[0]), ['T02', 'E1', 'D1', 'plan-lint'])
    // During a run: the task that waits for someone and the manual or environment prerequisite stay `now`; the decision to
    // take and plan-lint need the session, like an issue (D2)
    const running = { ...blocked, run: { ...blocked.run, status: 'in-progress' } }
    assert.deepEqual(moments(running).filter(x => x[2] === 0).map(x => x[0]), ['T02', 'E1'])
    assert.deepEqual(moments(running).filter(x => x[2] === 0.2).map(x => x[0]), ['D1', 'plan-lint'])
    assert.deepEqual(moments(running).find(x => x[0] === 'D9'), ['D9', 'before phase 2', 1.5], 'a decision for a later phase keeps its phase')
    for (const status of ['failed', 'needs-human']) {
      const waiting = { ...running, tasks: running.tasks.map(t => (t.id === 'T02' ? { ...t, status } : t)) }
      assert.deepEqual(moments(waiting)[0], ['T02', 'now', 0], `${status} without an issue, during a run`)
    }
    // The card: title, border, counter; the grey line goes before the first item that is not for now, and has no key
    const card = M.yourTurnCard(P, tA, 100), lines = card.lines.map(M.plainText)
    assert.deepEqual([M.plainText(card.title), card.color, card.title[0].c, card.urgent], ['⚠ Your turn', 'warning', 'warning', 2])
    assert.equal(M.plainText(card.meta), '2 now · 4 to settle · 4 reviews · 1 auto-decision')
    const rule = lines.findIndex(l => /^ {2}── later ─+$/.test(l))
    assert.equal(rule, 3, 'after T02 (and its blocker), E1')
    assert.ok(!card.lines[rule].some(m => m.x) && card.lines[rule].every(m => m.d), 'grey, without a key')
    assert.equal(lines.filter(l => /── later/.test(l)).length, 1)
    assert.deepEqual(card.lines.flat().filter(m => m.x?.mode === 'select').map(m => m.x.hotkey), ['1', '2', '3', '4', '5', '6', '7', '8', '9'], 'the line has no key: the others keep 1 to 9')
    // The labels: `now` bold in `suggestion`, the others grey, all ending at the same cell, the text cut to leave them room
    const label = id => card.lines[lines.findIndex(l => l.startsWith(id))].at(-1)
    assert.deepEqual([label('◇ E1'), label('⇒ T01')].map(m => [m.t, m.c, m.b, m.d]), [['now', 'suggestion', true, undefined], ['before phase 2', undefined, undefined, true]])
    const ends = card.lines.filter(l => l.some(m => m.x)).map(l => M.width(l))
    assert.ok(ends.every(w => w === ends[0] && w <= 96), `${ends}`)
    const narrow = M.yourTurnCard({ ...P, reviews: [{ task: 'T01', phase: 1, text: 'x'.repeat(80), at: null }] }, tA, 58)
    for (const l of narrow.lines) assert.ok(M.width(l) <= 54, M.plainText(l))
    assert.match(M.plainText(narrow.lines.find(l => /xxx/.test(M.plainText(l)))), /…\s+after phase 1$/, 'cut to leave the label its room')
    // Only items of rank above 0: the page starts with the grey line; the card says nothing waits now, text in `success`, border `subtle`
    const only = { ...A, reviews: Array.from({ length: 10 }, (_, i) => ({ task: 'T01', phase: 1, text: `f${i}`, at: null })) }
    const o1 = M.yourTurnCard(only, tA, 100), o2 = M.yourTurnCard(only, tA, 100, null, { page: 1 })
    assert.match(M.plainText(o1.lines[0]), /^ {2}── later ─+$/); assert.match(M.plainText(o2.lines[0]), /^ {2}── later ─+$/, 'the second page too')
    assert.deepEqual([M.plainText(o1.title), o1.title[0].c, o1.color, o1.urgent], ['✓ Nothing waits for you now', 'success', 'subtle', 0])
    assert.equal(M.plainText(o1.meta), '10 reviews')
    // Nothing for later: no line; nothing at all: unchanged
    assert.ok(!M.yourTurnCard({ ...C, reviews: [], decisions: [] }, tA, 100).lines.map(M.plainText).some(l => /later/.test(l)))
    assert.equal(M.plainText(M.yourTurnCard({ ...A, reviews: [], decisions: [] }, tA, 100, null, { last: { text: 'x', kind: 'done' } }).title), '✓ Nothing left to review')
    // The header badge and the banner count the `now` items, not only the tasks that wait
    assert.match(M.plainText(M.pane(P, tA, 100).header[0]), /⚠ 2 YOUR TURN$/); assert.equal(M.pane(P, tA, 100).header[0].at(-1).t, ' ⚠ 2 YOUR TURN ')
    assert.doesNotMatch(M.plainText(M.pane(B, tA, 100).header[0]), /YOUR TURN/); assert.match(M.plainText(M.pane(B, tA, 100).header[0]), /⚑ 3 TO REVIEW$/)
    assert.match(M.plainText(M.banner(P, tA, 140)), /⚑ 4 to review {2}⚠ 2 your turn /)
    assert.match(M.plainText(M.banner(L, tA, 140)), /⚑ 3 to review {2}⚠ 1 your turn /, 'during the run: the prerequisite only')
    assert.doesNotMatch(M.plainText(M.banner(B, tA, 140)), /your turn/, 'T02 waits, but for the stop of the run: the banner is silent')
    assert.match(M.plainText(M.banner({ ...C, reviews: [], decisions: [], issues: [], tasks: C.tasks.map(t => (t.id === 'T02' ? { ...t, status: 'todo' } : t)), prerequisites: [prerequisites[0]] }, tA, 140)), /⚠ 1 your turn/, 'an item that is not a task also counts')
    // What waits behind a prerequisite: the tasks of the phases after the first one held back, not merged nor cancelled
    const tk = (id, phase, status = 'todo') => ({ ...C.tasks[0], id, phase, status, step: null })
    const W = { ...P, tasks: [tk('T01', 1, 'merged'), tk('T02', 1, 'needs-human'), tk('T03', 2), tk('T04', 2), tk('T05', 3), tk('T06', 3), tk('T07', 4), tk('T08', 4, 'cancelled'), tk('T09', 4, 'merged')] }
    assert.equal(M.waitingBehind(W, ['T02']), 'phases 2, 3 and 4 (5 tasks) wait behind it')
    assert.equal(M.waitingBehind(W, ['T03']), 'phases 3 and 4 (3 tasks) wait behind it')
    assert.equal(M.waitingBehind(W, ['T05']), 'phase 4 (1 task) waits behind it')
    assert.equal(M.waitingBehind(W, ['T07']), '', 'the last phase: nothing behind it')
    assert.equal(M.waitingBehind(W, ['T01']), '', 'merged: it holds nothing back')
    assert.equal(M.waitingBehind(W, ['T02', 'T06']), 'phases 2, 3 and 4 (4 tasks) wait behind it', 'from the first held back; a task held back is not behind itself')
    const itemOf = id => M.yourTurnItems(W, tA).items.find(x => x.task === id)
    const behind = (id, columns = 100) => M.detailCard(W, tA, columns, itemOf(id).key).lines.map(M.plainText)
    assert.ok(behind('E1').includes('  blocks T02; phases 2, 3 and 4 (5 tasks) wait behind it'), behind('E1').join('\n'))
    assert.ok(behind('H1').includes('  blocks T04; phases 3 and 4 (3 tasks) wait behind it'))
    assert.ok(behind('E1', 60).join(' ').includes('blocks T02; phases 2, 3 and 4'))
    assert.ok(behind('H9').every(l => !/blocks/.test(l)), 'holds nothing back: no line')
    // Two reviews of the same task with the same first backquoted passage: one item, in the list, the counters and the PR draft;
    // progress.json keeps both; no passage, another task or another passage: not the same
    const reviewsIn = [
      { task: 'T02', phase: 1, text: 'Check `.env.example`: add X', at: null }, { task: 'T02', phase: 1, text: 'Again `.env.example` and `b.md`', at: null },
      { task: 'T01', phase: 1, text: 'Check `.env.example`: add X', at: null }, { task: 'T02', phase: 1, text: 'Check `b.md` first', at: null },
      { task: 'T02', phase: 1, text: 'No passage', at: null }, { task: 'T02', phase: 1, text: 'No passage', at: null },
      { task: null, phase: null, text: 'See `plan.md`', at: null }, { task: null, phase: null, text: 'Also `plan.md`', at: null },
    ]
    const dup = { ...A, reviews: reviewsIn }
    assert.deepEqual(M.distinctReviews(reviewsIn).map(r => r.text), ['Check `.env.example`: add X', 'Check `.env.example`: add X', 'Check `b.md` first', 'No passage', 'No passage', 'See `plan.md`'])
    assert.equal(dup.reviews.length, 8)
    assert.equal(M.yourTurnItems(dup, tA).items.filter(x => x.group === 'review').length, 6)
    assert.equal(M.plainText(M.yourTurnCard(dup, tA, 100).meta), '6 reviews'); assert.equal(M.summarize(dup, tA).reviews, 6)
    assert.match(M.plainText(M.banner(dup, tA, 140)), /⚑ 6 to review/)
    const pr = M.prText(dup, tA)
    assert.equal(pr.split('\n').filter(l => /^- \[ \] /.test(l)).length, 6); assert.ok(!pr.includes('Again `.env.example`') && !pr.includes('Also `plan.md`'))
    // From progress.json: both reviews are read, one item shown
    const rawTwo = { ...rawFile(), reviews: [{ ...rawFile().reviews[0], task: 'T02', text: 'Check `x.env`: a' }, { ...rawFile().reviews[0], task: 'T02', text: 'Check `x.env`: b' }] }
    const norm = M.normalize(rawTwo)
    assert.equal(norm.reviews.length, 2); assert.equal(M.yourTurnItems(norm, tA).items.filter(x => x.group === 'review').length, 1)
  })

  testCase('your turn by moment (0.19.0): the first phase held back, tasks merged or cancelled, an issue alone, auto-decisions before the PR, "later" before "at run stop"', () => {
    const at = (I, group = null) => M.yourTurnItems(I, tA).items.filter(x => !group || x.group === group).map(x => [x.task, x.moment, x.rank])
    // A prerequisite takes the phase of the first task it holds back; a task merged or cancelled holds nothing back (C: run 1 stopped at phase 1)
    const tk = (id, phase, status = 'todo') => ({ ...C.tasks[0], id, phase, status, step: null })
    const held = {
      ...C, reviews: [], decisions: [],
      tasks: [tk('T01', 1, 'merged'), tk('T02', 1, 'needs-human'), tk('T03', 2), tk('T04', 2), tk('T05', 3), tk('T06', 3, 'cancelled')],
      prerequisites: [
        { id: 'E2', type: 'environment', text: 'a', blocks: ['T04', 'T02'] }, { id: 'H2', type: 'manual', text: 'b', blocks: ['T05', 'T03'] },
        { id: 'H3', type: 'manual', text: 'c', blocks: ['T01'] }, { id: 'H4', type: 'manual', text: 'd', blocks: ['T06'] },
      ],
    }
    assert.deepEqual(at(held), [['T02', 'now', 0], ['E2', 'now', 0], ['H2', 'before phase 2', 1.5], ['H3', 'before the next run', 98], ['H4', 'before the next run', 98]])
    // An issue on a task that does not wait (T03 to do): at run stop during the run (B), now once it stopped (C) (D2)
    const alone = I => ({ ...I, issues: [...I.issues, { ...I.issues[0], task: 'T03', title: 'Name of the queue', human: false }] })
    assert.deepEqual(at(alone(B)).find(x => x[0] === 'T03'), ['T03', 'at run stop', 0.2])
    assert.deepEqual(at(alone(C)).find(x => x[0] === 'T03'), ['T03', 'now', 0])
    // An auto-decision of the last phase, of a task the plan no longer has, or of a plan all merged: before the PR
    const decisions = [...C.decisions, { ...C.decisions[0], task: 'T03', title: 'Queue size' }, { ...C.decisions[0], task: 'T99', title: 'Gone' }]
    assert.deepEqual(at({ ...C, decisions }, 'decision'), [['T01', 'before phase 2', 1.5], ['T03', 'before the PR', 99], ['T99', 'before the PR', 99]])
    const merged = { ...C, issues: [], tasks: C.tasks.map(t => ({ ...t, status: 'merged' })) }
    assert.deepEqual(at(merged, 'decision'), [['T01', 'before the PR', 99]])
    // A review of a task of the last phase: after that phase while the plan is not all merged, before the PR once it is
    const last = C.tasks.find(t => t.id === 'T03').phase
    const lastReview = I => ({ ...I, reviews: [{ ...C.reviews[0], task: 'T03', phase: undefined, text: 'last phase', label: undefined }] })
    assert.deepEqual(at(lastReview(C), 'review'), [['T03', `after phase ${last}`, last]])
    assert.deepEqual(at(lastReview(merged), 'review'), [['T03', 'before the PR', 99]])
    // During the run (B), nothing is for now: the card starts with the grey line, then T02 at run stop
    const during = M.yourTurnCard(B, tA, 100).lines.map(M.plainText)
    assert.match(during[0], /^ {2}── later ─+$/); assert.match(during[1], /^⚑ T02 · .* at run stop$/)
  })

  testCase('demo (0.19.0): the frame where run 1 stops has an item for now and items for later', () => {
    const T = Date.parse('2026-10-09T10:00:00Z'), I = D.demoSnapshot(11, T), t = D.frameInstant(11, T) + 500
    const at = M.yourTurnItems(I, t).items.map(x => `${x.task}:${x.moment}`)
    assert.ok(at.includes('T03:now'), at.join(' ')); assert.ok(at.some(m => /:after phase 1$/.test(m)), at.join(' '))
    assert.match(text(M.yourTurnCard(I, t, 100).lines), /^ {2}── later ─+$/m)
    // While the run goes on (frame 10), T03 waits for its stop
    const I10 = D.demoSnapshot(10, T), t10 = D.frameInstant(10, T) + 500
    assert.ok(M.yourTurnItems(I10, t10).items.some(x => x.task === 'T03' && x.moment === 'at run stop'))
    // The legend of these two frames names what they show, checked above
    assert.match(D.legend(10), /T03 "at run stop" under the grey "later" line/)
    assert.match(D.legend(11), /T03 is now "now", the review and the auto-decision stay below "later"/)
  })

  testCase('mark done (0.15.1): d on a review or an auto-decision, the items done leave "Your turn", the notifications by key', () => {
    const items = M.yourTurnItems(B, tA).items
    const review = items.find(it => it.group === 'review'), decision = items.find(it => it.group === 'decision'), settle = items.find(it => it.group === 'settle')
    assert.equal(review.ack, `/orchestre:done plans/demo review ${review.task} ${B.reviews.find(r => r.task === review.task).text}`)
    assert.equal(decision.ack, `/orchestre:done plans/demo decision ${decision.task} ${B.decisions[0].title}`)
    assert.equal(settle.ack, undefined)
    // No Done on an item to settle. An issue (0.21.0): no option (SECRET has none), Other… opens the text field, Ask Claude fills the prompt
    const settleButtons = M.detailCard(B, tA, 100, settle.key).lines.flat().filter(m => m.x)
    assert.deepEqual(settleButtons.map(m => [m.t, m.x.op ?? null, m.x.prompt]), [['[ Other… ]', 'other', ''], ['[ Ask Claude ]', null, 'Explain the issue of T02 ("Missing secret") and its options.']])
    // The source plan: "-"
    const source = { ...B, reviews: [{ task: null, phase: null, text: 'README: relire', at: null }] }
    assert.equal(M.yourTurnItems(source, tA).items.find(it => it.group === 'review').ack, '/orchestre:done plans/demo review - README: relire')
    // done in progress.json: neither in the snapshot nor in the list
    const raw = rawFile()
    const marked = { ...raw, reviews: raw.reviews.map((r, i) => (i ? r : { ...r, done: '2026-10-18T10:00:00+02:00' })), auto_decisions: raw.auto_decisions.map(d => ({ ...d, done: '2026-10-18T10:00:00+02:00' })) }
    const before = M.normalize(raw), after = M.normalize(marked)
    assert.deepEqual([after.reviews.length, after.decisions.length], [before.reviews.length - 1, 0])
    // A review done and a new one in the same read: the new one is notified
    const next = { ...after, reviews: [...after.reviews, { task: 'T01', phase: 1, text: 'new one', at: null }] }
    assert.ok(M.changes(before, next).includes('⚑ T01: to review before the PR'), JSON.stringify(M.changes(before, next)))
    assert.deepEqual(M.changes(before, after).filter(m => m.startsWith('⚑')), [])
  })

  testCase('buttons of "Your turn" (0.16.0): ticket and label read, Done, Ticket, Edit text, the field, Undo, the PR draft as task lists', () => {
    const raw = rawFile(), at = '2026-11-02T10:00:00+01:00'
    const R0 = raw.reviews.map(r => r.text)
    const doc = {
      ...raw,
      reviews: raw.reviews.map((r, i) => (i === 0 ? { ...r, done: at } : i === 1 ? { ...r, ticket: at } : { ...r, label: `${r.text} (in GitHub)` })),
      auto_decisions: raw.auto_decisions.map(d => ({ ...d, label: 'Retry threshold: A, kept' })),
    }
    const X = M.normalize(doc)
    // Done and moved to tickets: no longer waiting, kept in "closed"; the label is the text shown, the key does not change
    assert.deepEqual(X.reviews.map(r => [r.text, r.label]), [[R0[2], `${R0[2]} (in GitHub)`]])
    assert.deepEqual(X.closed.map(c => [c.kind, c.task, c.text, c.as]), [['review', 'T01', R0[0], 'done'], ['review', 'T02', R0[1], 'ticket']])
    assert.deepEqual(X.decisions.map(d => d.label), ['Retry threshold: A, kept'])
    const items = M.yourTurnItems(X, tA).items
    const review = items.find(it => it.group === 'review'), decision = items.find(it => it.group === 'decision')
    assert.equal(review.text, `T02 · ${R0[2]} (in GitHub)`)
    assert.deepEqual(review.ref, { kind: 'review', task: 'T02', text: R0[2], shown: `${R0[2]} (in GitHub)`, original: R0[2], edited: true })
    assert.equal(review.key, M.yourTurnItems(B, tA).items.find(it => it.ref?.text === R0[2]).key, 'the same key, edited or not')
    assert.deepEqual([decision.ref.text, decision.ref.shown, decision.ref.original, decision.toTicket], ['Retry threshold', 'Retry threshold: A, kept', 'Retry threshold: A (cap at 30 s)', '/orchestre:done plans/demo ticket decision T01 Retry threshold'])
    assert.match(text(M.yourTurnCard(X, tA, 100).lines), new RegExp(`^⚑ T02 · ${R0[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(in GitHub\\) {2}✎ edited +before the PR$`, 'm'))
    assert.equal(M.plainText(M.yourTurnCard(X, tA, 100).meta), '1 review · 1 auto-decision · 1 moved to tickets')
    // The detail card of an edited item: its original text under it
    const d = M.detailCard(X, tA, 100, review.key)
    assert.match(text(d.lines), new RegExp(`^ {2}original: ${R0[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    // While the text is edited: a field with what is typed so far, Save and Cancel, the note on HANDOFF.md
    const e = M.detailCard(X, tA, 100, review.key, { editing: true, draft: 'new text' })
    const field = e.lines.flat().find(m => m.in)
    assert.deepEqual(field.in, { key: 'detail-input', value: 'new text', submitLabel: 'save' })
    assert.deepEqual(e.lines.flat().filter(m => m.x).map(m => [m.t, m.x.op]), [['[ Save ]', 'save'], ['[ Cancel ]', 'cancel']])
    assert.match(text(e.lines), /HANDOFF\.md keeps the original text/)
    assert.equal(M.detailCard(X, tA, 100, review.key, { editing: true }).lines.flat().find(m => m.in).in.value, `${R0[2]} (in GitHub)`, 'without a draft: the text shown')
    // Narrow: the buttons over two lines, none wider than the card
    const narrow = M.detailCard(X, tA, 44, review.key)
    const rows = narrow.lines.filter(l => l.some(m => m.x))
    assert.ok(rows.length >= 2, `${rows.length} lines of buttons`)
    for (const l of narrow.lines) assert.ok(M.width(l) <= 40, M.plainText(l))
    assert.deepEqual(M.buttonLines([{ t: '[ a ]' }, { t: '[ bb ]' }, { t: '[ c ]' }], 13).map(M.plainText), ['[ a ]  [ bb ]', '[ c ]'])
    // The last action and its Undo; nothing left: the card stays, in green, for Undo
    const last = { text: 'T01 · review done', kind: /** @type {const} */ ('done') }
    const withLast = M.yourTurnCard(X, tA, 100, null, { last })
    assert.match(text(withLast.lines), /^ {2}last: T01 · review done {2}\[ Undo \]$/m)
    assert.deepEqual(withLast.lines.flat().filter(m => m.x?.op === 'undo').map(m => [m.x.hotkey, m.x.bracket]), [[null, true]])
    const empty = { ...A, reviews: [], decisions: [] }
    assert.equal(M.yourTurnCard(empty, tA, 100), null)
    const only = M.yourTurnCard(empty, tA, 100, null, { last })
    assert.deepEqual([M.plainText(only.title), only.color], ['✓ Nothing left to review', 'success'])
    assert.deepEqual(M.pane(empty, tA, 100, { last }).cards.map(c => c.id), ['yourTurn', 'run', 'tasks', 'log'])
    // The PR draft: task lists, done ticked, the label as text, the tickets moved named before those of HANDOFF.md
    const pr = M.prText({ ...X, tickets: 2 }, tA)
    assert.match(pr, new RegExp(`^- \\[ \\] T02: ${R0[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(in GitHub\\)$`, 'm'))
    assert.match(pr, new RegExp(`^- \\[x\\] T01: ${R0[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    assert.match(pr, /^- \[ \] T01, Retry threshold: A, kept$/m)
    assert.match(pr, new RegExp(`\\nTickets to open after the PR:\\n- T02: ${R0[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n- and 2 "ticket" entries of HANDOFF\\.md\\.\\n$`))
    assert.doesNotMatch(pr, new RegExp(`\\[.\\] T02: ${R0[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'a ticket is not to review')
    // A review open again by Undo is not a new review
    const reopened = M.normalize({ ...doc, reviews: doc.reviews.map((r, i) => (i === 0 ? { ...r, done: undefined } : r)) })
    assert.deepEqual(M.changes(X, reopened).filter(m => m.startsWith('⚑')), [])
  })

  testCase('plan closed (0.16.1): no banner nor status line, its card instead of "Your turn", Reopen and the PR draft', () => {
    const raw = rawFile(), closedAt = '2026-11-02T12:00:00+01:00'
    const X = M.normalize({ ...raw, closed: closedAt })
    assert.equal(X.planClosed, Date.parse(closedAt)); assert.equal(M.normalize(raw).planClosed, null)
    assert.equal(M.banner(H, tE, 140) != null, true); assert.equal(M.banner(X, tE, 140), null, 'no banner')
    assert.equal(M.statusLine(X, tE), null, 'no status line, even with reviews left open')
    const p = M.pane(X, tE, 100, { selected: M.yourTurnItems(X, tE).items[0]?.key ?? null })
    assert.deepEqual(p.cards.map(c => c.id), ['closed', 'run', 'tasks', 'log']); assert.equal(p.selection, null)
    assert.match(M.plainText(p.header[0]), /^ORCHESTRE · DEMO · PLAN CLOSED$/)
    const c = p.cards[0]
    assert.deepEqual([M.plainText(c.title), c.color], ['✓ Plan closed', 'success'])
    const t = text(c.lines)
    assert.match(t, /^Nothing shows for this plan any more, now or in later sessions, until a run starts on it\.$/m)
    assert.match(t, new RegExp(`^${X.reviews.length + X.decisions.length} items of "Your turn" left open: in the PR draft\\.$`, 'm'))
    assert.match(t, /^\[ PR draft in the prompt \] {2}\[ Reopen \]$/m)
    assert.match(t, /The pane closes at your next prompt; \/progress plans\/demo shows the plan again\.$/)
    assert.deepEqual(c.lines.flat().filter(m => m.x).map(m => m.x.op ?? 'prompt'), ['prompt', 'reopenPlan'])
    for (const l of c.lines) assert.ok(M.width(l) <= 96, M.plainText(l))
    assert.equal(M.runCard(X, tE, 100, false).lines.flat().filter(m => m.x?.op === 'closePlan').length, 0, 'no Close on a closed plan')
    assert.match(M.stateText(X, tE), /^demo: plan closed\n/)
    // Nothing left open: no line on it
    assert.doesNotMatch(text(M.closedCard({ ...X, reviews: [], decisions: [] }, tE, 100).lines), /left open/)
  })

  testCase('wrap: words over lines of n characters at most, a word too long cut', () => {
    assert.deepEqual(M.wrap('aa bb cc', 5), ['aa bb', 'cc'])
    assert.deepEqual(M.wrap('  aa   bb  ', 10), ['aa bb'])
    assert.deepEqual(M.wrap('abcdefgh ij', 3), ['abc', 'def', 'gh', 'ij'])
    assert.deepEqual(M.wrap('é·ü ab', 4), ['é·ü', 'ab'])
    assert.deepEqual(M.wrap('', 4), [''])
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
      assert.equal(D.demoDoc(k, T).format, 'orchestre-progress/4', 'in the format progress.mjs writes')
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

  testCase('T07B: merged reviews close together, the status line counts the `now` items, the detail card agrees with its label', () => {
    // D5: three reviews of T01, two of them quoting the same passage, one with a different text; one of the source plan
    const R = (task, text) => ({ task, phase: task ? 1 : null, text, at: null })
    const dup = { ...C, reviews: [R('T01', 'Fix `a.js` once'), R('T01', 'Also `a.js` twice'), R('T01', 'Other `b.js`'), R('T02', 'Fix `a.js` once'), R(null, 'no passage'), R(null, 'no passage')] }
    const ref = it => it.ref
    const reviewsOf = I => M.yourTurnItems(I, tA).items.filter(x => x.group === 'review')
    assert.deepEqual(reviewsOf(dup).map(x => [x.task, ref(x).text]), [['T01', 'Fix `a.js` once'], ['T01', 'Other `b.js`'], ['T02', 'Fix `a.js` once'], ['source plan', 'no passage'], ['source plan', 'no passage']])
    // every review the item stands for, each with its original text (progress.mjs ack matches by kind, task and text)
    assert.deepEqual(M.mergedTexts(dup, ref(reviewsOf(dup)[0])), ['Fix `a.js` once', 'Also `a.js` twice'], 'both texts of the merged item')
    assert.deepEqual(M.mergedTexts(dup, ref(reviewsOf(dup)[1])), ['Other `b.js`'], 'alone')
    assert.deepEqual(M.mergedTexts(dup, ref(reviewsOf(dup)[2])), ['Fix `a.js` once'], 'same passage on another task: not merged')
    assert.deepEqual(M.mergedTexts(dup, ref(reviewsOf(dup)[3])), ['no passage'], 'no passage: never merged')
    assert.deepEqual(M.mergedTexts(dup, { kind: 'decision', task: 'T01', text: 'Fix `a.js` once' }), ['Fix `a.js` once'], 'a decision stands alone')
    // the status line: reviews after the D5 merge, `⚠` the `now` items, the same figure as the header badge and the banner
    const urgent = I => M.yourTurnItems(I, tA).urgent
    assert.equal(M.statusLine(dup, tA), `orchestre ■ 1/4 · ⚑ 5${urgent(dup) ? ` · ⚠ ${urgent(dup)}` : ''}`)
    assert.equal(M.statusLine(B, tA), 'orchestre ■ 1/4 · ⚑ 3', 'fixture B, run in progress: T02 waits with an open issue, so no ⚠')
    assert.equal(urgent(B), 0)
    assert.equal(M.statusLine(C, tA), 'orchestre ■ 1/4 · ⚑ 3 · ⚠ 1', 'fixture C, run stopped: the same issue is now')
    const E = { id: 'E1', type: 'environment', text: 'Docker', blocks: ['T02'] }
    assert.equal(M.statusLine({ ...B, prerequisites: [E] }, tA), 'orchestre ■ 1/4 · ⚑ 3 · ⚠ 1', 'a `now` prerequisite counts, as in the badge')
    const hdr = I => (/(\d+) YOUR TURN/.exec(M.plainText(M.pane(I, tA, 100).header[0])) ?? [])[1]
    for (const I of [B, C, { ...B, prerequisites: [E] }]) assert.equal(String(urgent(I) || ''), hdr(I) ?? '', 'status line, badge and banner: one count')
    // the detail card: its `when` is the label, written out; its `where` never says "once the run stops" for a `now` item
    const label = m => m.charAt(0).toUpperCase() + m.slice(1)
    const D1 = { id: 'D1', type: 'decision', text: 'Pick', blocks: ['T02'] }, D9 = { id: 'D9', type: 'decision', text: 'Name', blocks: ['T04'] }, H9 = { id: 'H9', type: 'manual', text: 'Old', blocks: [] }
    const waiting = I => ({ ...I, issues: [], lint: { ok: false, errors: 1 }, prerequisites: [E, D1, D9, H9], tasks: I.tasks.map(t => (t.id === 'T02' ? { ...t, status: 'blocked' } : t)) })
    const sets = { live: { ...waiting(B), issues: B.issues }, liveNoIssue: waiting(B), stopped: waiting(C), stoppedIssue: C, noRun: { ...waiting(C), runs: [], run: null } }
    for (const [name, I] of Object.entries(sets)) {
      for (const it of M.yourTurnItems(I, tA).items) {
        const d = M.detailCard(I, tA, 100, it.key).lines.map(M.plainText)
        assert.equal(d[0], `when     ${label(it.moment)}`, `${name}: ${it.task} ${it.moment}`)
        if (it.moment === 'now') assert.ok(!/once the run stops/.test(d.find(l => l.startsWith('where')) ?? ''), `${name}: ${it.task} is now, its where does not wait for a stop`)
      }
    }
    const whenOf = (I, task, group = 'settle') => M.yourTurnItems(I, tA).items.find(x => x.task === task && x.group === group).when
    assert.deepEqual([whenOf(sets.live, 'T02'), whenOf(sets.live, 'D1'), whenOf(sets.live, 'plan-lint'), whenOf(sets.live, 'E1')], ['At run stop', 'At run stop', 'At run stop', 'Now'], 'an issue, a decision and plan-lint labelled at run stop do not say Now; a prerequisite labelled now does not say Before the next run')
    assert.equal(whenOf(sets.live, 'H9'), 'Before the next run'); assert.equal(whenOf(sets.noRun, 'H9'), 'Before the first run'); assert.equal(whenOf(sets.live, 'D9'), 'Before phase 2')
    assert.equal(whenOf(dup, 'source plan', 'review'), 'Before the PR'); assert.equal(whenOf(dup, 'T01', 'review'), 'After phase 1')
    // a waiting task during a run, `now` (row 17): its where does not say "once the run stops"
    const w = M.yourTurnItems(sets.liveNoIssue, tA).items.find(x => x.task === 'T02' && x.group === 'settle')
    assert.deepEqual([w.moment, /once the run stops/.test(w.where)], ['now', false])
    const nr = M.yourTurnItems({ ...sets.liveNoIssue, tasks: sets.liveNoIssue.tasks.map(t => (t.id === 'T02' ? { ...t, status: 'needs-human' } : t)) }, tA).items.find(x => x.task === 'T02' && x.group === 'settle')
    assert.deepEqual([nr.moment, /once the run stops/.test(nr.where)], ['now', false])
  })

  // ── Answering an issue from the pane (0.21.0, T25) ──
  // rawC: run 1 stopped (awaiting-ruling), T01 merged, T02 needs-human, T03 and T04 to do. The issues are those of T01, which
  // waits for no one: each one is an item of its own
  const opt = (id, o = {}) => ({ id, description: `Option ${id} of the issue`, impact: '', recommended: false, valid: true, invalid_reason: null, effect: '', amends: [], ...o })
  const OPTIONS = [opt('A', { recommended: true, effect: 'amends T03, T04', amends: ['T03', 'T04'] }), opt('B'), opt('C', { valid: false, invalid_reason: 'plan-lint: T09 overlaps T03' })]
  const issueOf = (id, o = {}) => ({ id, run: 1, task: 'T01', title: `Issue ${id}`, context: '', human: false, role: 'open', status: 'open', chosen_option: null, options: OPTIONS, ...o })
  const lastRun = rawC.runs.at(-1)
  const withRun = (doc, status) => ({ ...doc, runs: [...doc.runs.slice(0, -1), { ...lastRun, status, end: status === 'in-progress' ? null : lastRun.end }] })
  const registerOf = (...ids) => ({ format: 'orchestre-issues/1', issues: ids.map(id => ({ id, status: 'open', ruling: null })) })
  const itemOf = (I, id) => M.yourTurnItems(I, tA).items.find(x => x.issue?.id === id)
  const cardOf = (I, id, o) => M.detailCard(I, tA, 100, itemOf(I, id).key, o)
  const buttonsOf = card => card.lines.flat().filter(m => m.x).map(m => [m.t, m.x.op ?? null, m.x.issue ?? null, m.x.option ?? null])

  testCase('answer an issue (0.21.0): its options, the effect of the recommended one, the buttons; an option the dry run refuses in grey with its reason; Decide later only when it holds a task', () => {
    const doc = { ...rawC, issues: [issueOf('T01-1')], pending_rulings: [] }
    const I = M.normalize(doc, registerOf('T01-1'))
    assert.deepEqual(I.issues[0].options.map(o => [o.id, o.recommended, o.valid]), [['A', true, true], ['B', false, true], ['C', false, false]])
    const d = cardOf(I, 'T01-1'), L = d.lines.map(M.plainText)
    for (const l of d.lines) assert.ok(M.width(l) <= 96, M.plainText(l))
    assert.equal(M.plainText(d.title), '▸ Detail · 2 · T01 · issue to settle')
    assert.deepEqual(L.slice(0, 6), ['when     Now', '', 'where    Here: applied when the next run starts', '', '─'.repeat(96), 'Issue T01-1'])
    const at = re => L.findIndex(l => re.test(l))
    // The effect of the recommended option, in grey under the title; the options; C refused: grey, its reason under it
    const effect = at(/^ {2}recommended option: amends T03, T04$/)
    assert.ok(effect === 6 && d.lines[effect].every(m => m.d), L.join('\n'))
    assert.deepEqual(L.slice(7, 11), ['  A  Option A of the issue  recommended', '  B  Option B of the issue', '  C  Option C of the issue', '      plan-lint: T09 overlaps T03'])
    assert.deepEqual(d.lines[7].map(m => [m.t.trim(), m.c ?? null]).at(-1), ['recommended', 'success'])
    assert.ok(d.lines[7].every(m => !m.d) && d.lines[9].every(m => m.d) && d.lines[10].every(m => m.d), 'A in normal weight, C and its reason in grey')
    // The buttons: the valid options, Other…, Ask Claude; no Decide later (it holds no task); C has none
    assert.deepEqual(buttonsOf(d), [['[ A · recommended ]', 'rule', 'T01-1', 'A'], ['[ B ]', 'rule', 'T01-1', 'B'], ['[ Other… ]', 'other', 'T01-1', null], ['[ Ask Claude ]', null, null, null]])
    assert.ok(L.includes('[ A · recommended ]  [ B ]  [ Other… ]  [ Ask Claude ]'), L.join('\n'))
    assert.equal(L.at(-1), 'A, B: recorded at once, applied before the next task starts. Ask Claude: fills the prompt.')
    // Ask Claude fills the prompt and writes nothing: no op, its prompt
    const ask = d.lines.flat().find(m => m.t === '[ Ask Claude ]').x
    assert.deepEqual([ask.op, ask.prompt, ask.bracket], [undefined, 'Explain the issue of T01 ("Issue T01-1") and its options.', true])
    // It holds T03: Decide later, release
    const held = M.normalize({ ...doc, issues: [issueOf('T01-1', { holds: ['T03'] })] }, registerOf('T01-1'))
    assert.deepEqual(buttonsOf(cardOf(held, 'T01-1')).at(-1), ['[ Decide later ]', 'release', 'T01-1', null])
    assert.ok(M.detailCard(held, tA, 100, itemOf(held, 'T01-1').key).lines.map(M.plainText).includes('[ A · recommended ]  [ B ]  [ Other… ]  [ Ask Claude ]  [ Decide later ]'))
    // Released (holds emptied by release): no Decide later
    const released = M.normalize({ ...doc, issues: [issueOf('T01-1', { holds: [], released: rawC.updated })] }, registerOf('T01-1'))
    assert.ok(!buttonsOf(cardOf(released, 'T01-1')).some(b => b[1] === 'release'))
    // A dry run not done yet (valid null) on an issue with an entry: rule takes it, a button
    const pendingDry = M.normalize({ ...doc, issues: [issueOf('T01-1', { options: [opt('A', { valid: null })] })] }, registerOf('T01-1'))
    assert.deepEqual(buttonsOf(cardOf(pendingDry, 'T01-1'))[0], ['[ A ]', 'rule', 'T01-1', 'A'])
  })

  testCase('answer an issue (0.21.0): inherited from /3, or without an entry in ISSUES.json, its options are grey with their reason and without a button; only Other… answers it, a free ruling in the field of Edit text', () => {
    // /3: the options of an inherited issue, valid false with the reason of convertV3
    const doc3 = { ...rawC, format: 'orchestre-progress/3', issues: [{ ...issueOf('T01-1'), id: undefined }].map(({ id, ...p }) => p), pending_rulings: undefined }
    const three = M.normalize(doc3, registerOf())
    assert.equal(three.issues[0].withoutActions, true)
    let d = cardOf(three, 'T01-1'), L = d.lines.map(M.plainText)
    assert.deepEqual(buttonsOf(d), [['[ Other… ]', 'other', 'T01-1', null], ['[ Ask Claude ]', null, null, null]])
    assert.deepEqual([L[6], d.lines[6].every(m => m.d), d.lines[7].every(m => m.d)], ['  A  Option A of the issue', true, true], 'grey, its reason under it')
    assert.ok(L.join('\n').replace(/\n {6}/g, ' ').includes(INHERITED), L.join('\n'))
    assert.ok(!L.some(l => /recommended option:/.test(l)), 'no option it can record: no effect')
    assert.equal(L.at(-1), 'Other…: recorded at once, applied before the next task starts. Ask Claude: fills the prompt.')
    // /4, no entry in ISSUES.json (a stop issue raised by run-end before 0.21.0, valid null): the reason apply gives
    const doc = { ...rawC, issues: [issueOf('T01-1', { options: [opt('A', { valid: null, recommended: true, effect: 'amends T03' }), opt('B', { valid: null })] })], pending_rulings: [] }
    const none = M.normalize(doc, registerOf('T09-1'))
    assert.equal(none.issues[0].entry, false)
    d = cardOf(none, 'T01-1'); L = d.lines.map(M.plainText)
    assert.deepEqual(buttonsOf(d), [['[ Other… ]', 'other', 'T01-1', null], ['[ Ask Claude ]', null, null, null]])
    assert.ok(L.includes('      no entry in ISSUES.json: the actions of option A are unknown; answer with a text'), L.join('\n'))
    assert.ok(L.includes('      no entry in ISSUES.json: the actions of option B are unknown; answer with a text'), L.join('\n'))
    assert.deepEqual(M.acceptable(none), [], 'no recommended option it can record')
    // The reason is the one progress.mjs apply gives (same template, same register name)
    const src = readFileSync(PROGRESS, 'utf8')
    assert.ok(src.includes("export const REGISTER = 'ISSUES.json'") && src.includes('reject(`no entry in ${REGISTER}: the actions of option ${r.option} are unknown; answer with a text`)'), 'apply says the same')
    assert.equal(M.noEntry('A'), 'no entry in ISSUES.json: the actions of option A are unknown; answer with a text')
    // RAISED (0.21.0, run-end): valid false with its reason, as any option refused
    const raised = M.normalize({ ...doc, issues: [issueOf('T01-1', { options: [opt('A', { valid: false, invalid_reason: 'raised without its actions (its close was not written): settle it with a free answer' })] })] }, registerOf())
    assert.ok(cardOf(raised, 'T01-1').lines.map(M.plainText).includes('      raised without its actions (its close was not written): settle it with a free answer'))
    // The register not read (a snapshot of the demo, by hand): nothing said of it, the options as their dry run says
    assert.equal(M.normalize(doc).issues[0].entry, undefined)
    assert.deepEqual(buttonsOf(cardOf(M.normalize(doc), 'T01-1')).map(b => b[0]).slice(0, 2), ['[ A · recommended ]', '[ B ]'])
    // Other…: the text field of Edit text, empty; Save records a free ruling on the issue
    d = cardOf(none, 'T01-1', { editing: true })
    const field = d.lines.flat().find(m => m.in)
    assert.deepEqual([field.in.key, field.in.value], ['detail-input', ''])
    assert.deepEqual(buttonsOf(d), [['[ Save ]', 'save', 'T01-1', null], ['[ Cancel ]', 'cancel', null, null]])
    assert.equal(M.plainText(d.lines.at(-1)), 'Save records your answer as a free ruling, applied before the next task starts.')
    assert.equal(M.plainText(M.detailCard(none, tA, 100, itemOf(none, 'T01-1').key, { editing: true, draft: 'Keep it' }).lines[0]), 'Text Keep it')
  })

  testCase('answer an issue (0.21.0): during a run, an issue that has options is now, answered here; one without options waits for the run to stop (D2)', () => {
    const doc = { ...rawC, issues: [issueOf('T01-1'), issueOf('T01-2', { options: [] })], pending_rulings: [] }
    const live = M.normalize(withRun(doc, 'in-progress'), registerOf('T01-1', 'T01-2'))
    const stopped = M.normalize(doc, registerOf('T01-1', 'T01-2'))
    assert.deepEqual([itemOf(live, 'T01-1').moment, itemOf(live, 'T01-1').where], ['now', 'Here, while the run goes on (nothing is sent to the chat)'])
    assert.deepEqual([itemOf(live, 'T01-2').moment, itemOf(live, 'T01-2').where], ['at run stop', 'This session, once the run stops'])
    assert.deepEqual([itemOf(stopped, 'T01-1').moment, itemOf(stopped, 'T01-1').where, itemOf(stopped, 'T01-2').moment, itemOf(stopped, 'T01-2').where], ['now', 'Here: applied when the next run starts', 'now', 'Here: applied when the next run starts'])
    // It counts in the title, the badge and the banner: the card is not quiet
    const card = M.yourTurnCard(live, tA, 100)
    assert.equal(M.plainText(card.title), '⚠ Your turn')
    assert.ok(card.urgent >= 1)
    // On a waiting task (T02, needs-human) the issue decides: with options now, without at run stop
    const onT02 = o => M.yourTurnItems(M.normalize(withRun({ ...doc, issues: [issueOf('T02-1', { task: 'T02', human: true, ...o })] }, 'in-progress'), registerOf('T02-1')), tA).items.find(x => x.task === 'T02')
    assert.deepEqual([onT02({}).moment, onT02({}).kind, onT02({}).issue.id], ['now', 'waits for you', 'T02-1'])
    assert.equal(onT02({ options: [] }).moment, 'at run stop')
    // A blocked or failed task, a needs-human task with no issue, during a run: now, and a where that is true during a run (T07 review)
    for (const [status, where] of [['blocked', 'This session: ask the pilot, the run goes on meanwhile'], ['failed', 'This session: ask the pilot, the run goes on meanwhile'], ['needs-human', 'This session: do what it waits for, then resume the run with the others']]) {
      const I = M.normalize(withRun({ ...doc, issues: [], tasks: rawC.tasks.map(t => (t.id === 'T02' ? { ...t, status } : t)) }, 'in-progress'))
      const it = M.yourTurnItems(I, tA).items.find(x => x.task === 'T02')
      assert.deepEqual([it.moment, it.where, M.plainText(M.detailCard(I, tA, 100, it.key).lines[2])], ['now', where, `where    ${where}`], status)
    }
  })

  testCase('answer an issue (0.21.0): the last line, recorded with Undo from pendingRulings, then applied once the issue is settled (never ruling.commit); Accept the N recommended', () => {
    const at = rawC.updated
    const doc = { ...rawC, issues: [issueOf('T01-1'), issueOf('T01-2')], pending_rulings: [] }
    const lastOf = (I, last) => { const c = M.yourTurnCard(I, tA, 100, null, { last }); return c ? c.lines.filter(l => M.plainText(l).startsWith('  last: ')) : [] }
    // Recorded: T01-1 is out of issues, its ruling in pendingRulings gives the issue and the option (B there, whatever the pane kept)
    const last = { text: 'T01-1 · option A recorded', kind: 'rule', rulings: [{ issue: 'T01-1', option: 'A' }] }
    const recorded = M.normalize({ ...doc, pending_rulings: [{ issue: 'T01-1', option: 'B', text: null, at }] }, registerOf('T01-1', 'T01-2'))
    assert.deepEqual(recorded.issues.map(p => p.id), ['T01-2'], 'the issue left the list')
    let l = lastOf(recorded, last)
    assert.deepEqual(l.map(M.plainText), ['  last: T01-1 · option B recorded  [ Undo ]'])
    assert.equal(l[0].at(-1).x.op, 'undo')
    // Applied: the ruling left pendingRulings, the copy in progress.json is settled; ISSUES.json gives ruling.commit null
    const settledReg = { format: 'orchestre-issues/1', issues: [{ id: 'T01-1', status: 'settled', ruling: { option: 'A', text: null, author: 'user', at, commit: null } }, { id: 'T01-2', status: 'open', ruling: null }] }
    const applied = M.normalize({ ...doc, issues: [issueOf('T01-1', { status: 'settled', chosen_option: 'A' }), issueOf('T01-2')] }, settledReg)
    assert.deepEqual(applied.settledIssues, ['T01-1'])
    l = lastOf(applied, last)
    assert.deepEqual(l.map(M.plainText), ['  last: T01-1 · option A applied'])
    assert.ok(!l[0].some(m => m.x), 'no Undo once applied')
    // The copy of progress.json alone (no register) says it too; settled only in ISSUES.json (dropped) too
    assert.deepEqual(lastOf(M.normalize({ ...doc, issues: [issueOf('T01-1', { status: 'settled' }), issueOf('T01-2')] }), last).map(M.plainText), ['  last: T01-1 · option A applied'])
    assert.deepEqual(lastOf(M.normalize(doc, { format: 'orchestre-issues/1', issues: [{ id: 'T01-1', status: 'dropped', ruling: null }] }), last).map(M.plainText), ['  last: T01-1 · option A applied'])
    // Withdrawn elsewhere (unrule), or refused by apply (open again): no line
    assert.deepEqual(lastOf(M.normalize(doc, registerOf('T01-1', 'T01-2')), last), [])
    // A free answer
    const free = M.normalize({ ...doc, pending_rulings: [{ issue: 'T01-2', option: null, text: 'Keep it', at }] }, registerOf('T01-1', 'T01-2'))
    assert.deepEqual(lastOf(free, { text: '', kind: 'rule', rulings: [{ issue: 'T01-2', option: null }] }).map(M.plainText), ['  last: T01-2 · free answer recorded  [ Undo ]'])
    // Accept the N recommended: from two open issues with a recommended option the pane can record, before the page line
    const both = M.normalize(doc, registerOf('T01-1', 'T01-2'))
    const card = M.yourTurnCard(both, tA, 100), C2 = card.lines.map(M.plainText)
    const accept = card.lines.flat().find(m => m.x?.op === 'acceptAll')
    assert.deepEqual([accept.t, accept.x.rulings, accept.x.bracket], ['[ Accept the 2 recommended ]', [{ issue: 'T01-1', option: 'A' }, { issue: 'T01-2', option: 'A' }], true])
    assert.ok(C2.includes('  [ Accept the 2 recommended ]'), C2.join('\n'))
    const many = M.normalize({ ...doc, issues: [...doc.issues, ...Array.from({ length: 9 }, (_, i) => issueOf(`T01-${i + 3}`, { options: [] }))] }, registerOf('T01-1', 'T01-2'))
    const ML = M.yourTurnCard(many, tA, 100).lines.map(M.plainText)
    assert.ok(ML.findIndex(x => x.includes('Accept the 2 recommended')) === ML.findIndex(x => /^ {2}page 1\/2/.test(x)) - 1, 'right before the page line')
    // One alone, or a recommended option refused: no button
    for (const I of [M.normalize({ ...doc, issues: [issueOf('T01-1')] }, registerOf('T01-1')), M.normalize({ ...doc, issues: [issueOf('T01-1'), issueOf('T01-2', { options: [opt('A', { recommended: true, valid: false, invalid_reason: 'x' })] })] }, registerOf('T01-1', 'T01-2'))]) {
      assert.ok(!M.yourTurnCard(I, tA, 100).lines.flat().some(m => m.x?.op === 'acceptAll'))
    }
    // Its last line: N recommended options recorded, with Undo; applied once both are settled
    const bulk = { text: '2 recommended options recorded', kind: 'rule', bulk: true, rulings: [{ issue: 'T01-1', option: 'A' }, { issue: 'T01-2', option: 'A' }] }
    const twoPending = M.normalize({ ...doc, pending_rulings: ['T01-1', 'T01-2'].map(issue => ({ issue, option: 'A', text: null, at })) }, registerOf('T01-1', 'T01-2'))
    assert.deepEqual(lastOf(twoPending, bulk).map(M.plainText), ['  last: 2 recommended options recorded  [ Undo ]'])
    assert.equal(M.yourTurnCard(twoPending, tA, 100, null, { last: bulk }).lines.flat().filter(m => m.x?.op === 'acceptAll').length, 0, 'both recorded: no button any more')
    const twoApplied = M.normalize({ ...doc, issues: doc.issues.map(p => ({ ...p, status: 'settled' })) })
    assert.deepEqual(lastOf(twoApplied, bulk).map(M.plainText), ['  last: 2 recommended options applied'])
  })

  testCase('[ ✓ I did it ] (0.21.0): on a manual action or an environment, not on a decision; the last line with Undo while apply has not written it', () => {
    const PRE = [{ id: 'H1', type: 'manual', status: 'open', text: 'API token', evidence: '—', how: [], blocks: ['T04'] }, { id: 'E1', type: 'environment', status: 'open', text: 'Docker', evidence: '—', how: [], blocks: ['T02'] }, { id: 'D5', type: 'decision', status: 'open', text: 'Pick', evidence: '—', how: [], blocks: ['T04'] }]
    const doc = { ...rawC, issues: [], prerequisites: PRE, pending_done: [] }
    const I = M.normalize(doc)
    const card = id => M.detailCard(I, tA, 100, M.yourTurnItems(I, tA).items.find(x => x.task === id).key)
    const H = card('H1'), HL = H.lines.map(M.plainText)
    assert.deepEqual(buttonsOf(H), [['[ Settle the prerequisites ]', null, null, null], ['[ ✓ I did it ]', 'did', null, null]])
    assert.equal(H.lines.flat().find(m => m.x?.op === 'did').x.prerequisite, 'H1')
    assert.ok(HL.includes('[ Settle the prerequisites ]  [ ✓ I did it ]'), HL.join('\n'))
    assert.equal(HL.slice(-2).join(' '), 'First button: fills the prompt, sends nothing. I did it: recorded at once, PREREQUISITES.md at the next apply.')
    assert.ok(buttonsOf(card('E1')).some(b => b[1] === 'did'), 'an environment too')
    assert.deepEqual(buttonsOf(card('D5')), [['[ Settle the prerequisites ]', null, null, null]], 'a decision: did refuses it')
    // Noted done: pendingDone; no second button; the last line, with Undo (undid)
    const noted = M.normalize({ ...doc, pending_done: [{ prerequisite: 'H1', at: '2026-11-18T10:00:00+01:00' }] })
    assert.deepEqual(noted.pendingDone, [{ prerequisite: 'H1', day: '2026-11-18' }])
    assert.ok(!buttonsOf(M.detailCard(noted, tA, 100, M.yourTurnItems(noted, tA).items.find(x => x.task === 'H1').key)).some(b => b[1] === 'did'))
    const last = { text: 'H1 noted done on 2026-11-18', kind: 'did', did: { prerequisite: 'H1', day: '2026-11-18' } }
    const lastOf = (J, l) => M.yourTurnCard(J, tA, 100, null, { last: l }).lines.filter(x => M.plainText(x).startsWith('  last: '))
    const ln = lastOf(noted, last)
    assert.deepEqual(ln.map(M.plainText), ['  last: H1 noted done on 2026-11-18  [ Undo ]'])
    assert.equal(ln[0].at(-1).x.op, 'undo')
    // Written by apply (no longer open, out of pending_done): no Undo; withdrawn (undid) and still open: no line
    assert.deepEqual(lastOf(M.normalize({ ...doc, prerequisites: PRE.slice(1) }), last).map(M.plainText), ['  last: H1 noted done on 2026-11-18'])
    assert.deepEqual(lastOf(I, last), [])
    // The other actions keep their line and Undo
    assert.deepEqual(M.lastLine(I, { text: 'T01 · review done', kind: 'done' }), { text: 'T01 · review done', undo: true })
    assert.equal(M.lastLine(I, null), null)
  })

  // ── The wait for a ruling (0.21.0, T26) ──
  // run 1 in progress, T01-1 (of T01) holds T03 until `until`: T03 waits for it. Times come from `until` and the clock given
  const UNTIL = new Date(tA + 14 * 60000 + 47000).toISOString()
  const waitDoc = (o = {}, status = 'in-progress') => ({ ...withRun(rawC, status), pending_rulings: [], issues: [issueOf('T01-1', { holds: ['T03'], waiting: ['T03'], until: UNTIL, ...o })] })
  const waitOf = (o, status) => M.normalize(waitDoc(o, status), registerOf('T01-1'))
  const taskLine = (I, id, now = tA, columns = 100) => M.taskLines(I, now, columns).find(l => !/Phase/.test(M.plainText(l)) && new RegExp(`^ {2}\\S ${id}\\b`).test(M.plainText(l)))
  const whenOf2 = (I, now = tA) => M.detailCard(I, now, 100, itemOf(I, 'T01-1').key).lines.map(M.plainText)[0]

  testCase('wait for a ruling (0.21.0): what is read from progress.json; the time left comes from `until` and the clock, never below 0:00', () => {
    const I = waitOf()
    const p = I.issues[0]
    assert.deepEqual([p.holds, p.waiting, p.startedWithout, p.released, p.until], [['T03'], ['T03'], [], false, Date.parse(UNTIL)])
    assert.deepEqual(M.rulingWaits(I, tA), [{ task: 'T03', until: Date.parse(UNTIL) }])
    // The clock moves, not a counter: 1 minute later, 1 minute less; after the deadline, 0:00
    assert.equal(whenOf2(I, tA), 'when     Now: T03 waits for it 14:47, then starts without it')
    assert.equal(whenOf2(I, tA + 60000), 'when     Now: T03 waits for it 13:47, then starts without it')
    assert.equal(whenOf2(I, Date.parse(UNTIL) + 5000), 'when     Now: T03 waits for it 0:00, then starts without it')
    assert.equal(whenOf2(waitOf({ waiting: ['T03', 'T04'] }), tA), 'when     Now: T03, T04 wait for it 14:47, then start without it')
    // The run stopped (run-end empties waiting; a stale file too): nothing waits, `when` is Now alone and where says so
    for (const stale of [waitOf({}, 'awaiting-ruling'), waitOf({ waiting: [] })]) {
      assert.equal(whenOf2(stale), 'when     Now')
      assert.deepEqual(M.rulingWaits(stale, tA), [])
    }
    assert.match(M.detailCard(I, tA, 100, itemOf(I, 'T01-1').key).lines.map(M.plainText)[2], /^where {4}Here, while the run goes on \(nothing is sent to the chat\)$/)
    assert.match(M.detailCard(waitOf({}, 'awaiting-ruling'), tA, 100, itemOf(waitOf({}, 'awaiting-ruling'), 'T01-1').key).lines.map(M.plainText)[2], /^where {4}Here: applied when the next run starts$/)
    // The task started without it: it waits no more
    assert.deepEqual(M.rulingWaits(waitOf({ started_without: ['T03'] }), tA), [])
    assert.equal(whenOf2(waitOf({ started_without: ['T03'] })), 'when     Now')
    // An issue with a ruling recorded is no longer open: its tasks no longer wait for it
    assert.deepEqual(M.rulingWaits(M.normalize({ ...waitDoc(), pending_rulings: [{ issue: 'T01-1', option: 'A', text: null, at: UNTIL }] }), tA), [])
    // Two issues for one task: the later deadline
    const two = M.normalize({ ...waitDoc(), issues: [issueOf('T01-1', { holds: ['T03'], waiting: ['T03'], until: UNTIL }), issueOf('T01-2', { holds: ['T03'], waiting: ['T03'], until: new Date(tA + 20 * 60000).toISOString() })] }, registerOf('T01-1', 'T01-2'))
    assert.deepEqual(M.rulingWaits(two, tA), [{ task: 'T03', until: tA + 20 * 60000 }])
  })

  testCase('wait for a ruling (0.21.0): under the issue in Your turn, the grey line with the time in warning; once the task left without it, the other line', () => {
    const lines = (I, now = tA) => M.yourTurnCard(I, now, 100, null).lines
    const find = (I, re, now) => lines(I, now).find(l => re.test(M.plainText(l)))
    const held = find(waitOf(), /holds/)
    assert.equal(M.plainText(held), '     holds T03 · starts without it in 14:47')
    assert.deepEqual(held.map(m => [m.t.trim(), m.c ?? null, !!m.d]), [['holds T03 · starts without it in', null, true], ['14:47', 'warning', false]])
    assert.equal(M.plainText(find(waitOf(), /holds/, tA + 60000)), '     holds T03 · starts without it in 13:47')
    assert.equal(M.plainText(find(waitOf(), /holds/, Date.parse(UNTIL) + 90000)), '     holds T03 · starts without it in 0:00', 'never below 0:00')
    assert.equal(M.plainText(find(waitOf({ holds: ['T03', 'T04'] }), /holds/)), '     holds T03, T04 · starts without it in 14:47')
    // Under its issue: right after the item's line
    const all = lines(waitOf()).map(M.plainText), i = all.findIndex(l => /holds T03/.test(l))
    assert.match(all[i - 1], /T01 · Issue T01-1/)
    // Started without it: its mark by step, in grey; no more holds line
    const gone = waitOf({ started_without: ['T03'] })
    assert.equal(M.plainText(find(gone, /started/)), '     T03 started without it: its amendment may come too late')
    assert.ok(find(gone, /started/).every(m => m.d))
    assert.equal(find(gone, /holds/), undefined)
    // The run stopped, or an issue that holds nothing: no holds line
    assert.equal(find(waitOf({}, 'awaiting-ruling'), /holds/), undefined)
    assert.equal(find(waitOf({ holds: [] }), /holds/), undefined)
    for (const l of lines(waitOf({ holds: ['T03', 'T04', 'T05', 'T06'] }, 'in-progress'))) assert.ok(M.width(l) <= 96, M.plainText(l))
  })

  testCase('wait for a ruling (0.21.0): tasks card (glyph ‖ in warning, "waits for your ruling m:ss" in place of the step), run card, banner', () => {
    const I = waitOf()
    const line = taskLine(I, 'T03')
    assert.ok(line, M.taskLines(I, tA, 100).map(M.plainText).join('\n'))
    assert.match(M.plainText(line), /^ {2}‖ T03 {2}.*waits for your ruling 14:47$/)
    assert.deepEqual([line[1].t, line[1].c], ['‖', 'warning'])
    assert.deepEqual(line.at(-1), { t: 'waits for your ruling 14:47', c: 'warning' })
    assert.match(M.plainText(taskLine(I, 'T03', tA + 60000)), /waits for your ruling 13:47$/)
    assert.match(M.plainText(taskLine(I, 'T03', Date.parse(UNTIL) + 60000)), /waits for your ruling 0:00$/)
    // Not while the run is stopped, nor once the task started without it: the usual line of a task to do
    assert.ok(!/‖|ruling/.test(M.plainText(taskLine(waitOf({}, 'awaiting-ruling'), 'T03') ?? [])))
    assert.ok(!/waits for your ruling/.test(M.taskLines(waitOf({ started_without: ['T03'] }), tA, 100).map(M.plainText).join('\n')))
    // A narrow pane: shorter, the time last to go; whole lines within the width
    for (const w of [50, 58, 70, 100, 140]) {
      for (const l of M.taskLines(I, tA, w)) assert.ok(M.width(l) <= w, `${w}: ${M.plainText(l)}`)
      assert.match(M.plainText(taskLine(I, 'T03', tA, w)), /14:47$/, String(w))
    }
    // Run card: right of the title, singular and plural
    const run = M.runCard(I, tA, 100, false)
    assert.deepEqual(run.meta.map(m => m.t), ['‖ 1 waits for you', '  ', '◐ 0 in progress'])
    assert.equal(run.meta[0].c, 'warning')
    assert.equal(M.plainText(M.runCard(waitOf({ holds: ['T03', 'T04'], waiting: ['T03', 'T04'] }), tA, 100, false).meta), '‖ 2 wait for you  ◐ 0 in progress')
    assert.equal(M.plainText(M.runCard(waitOf({}, 'awaiting-ruling'), tA, 100, false).meta), 'awaiting-ruling')
    // Banner: in place of the current step; +1 with others
    assert.match(M.plainText(M.banner(I, tA, 140)), /1\/4 .*‖ T03 +waits for you +⏱/)
    assert.ok(!/◐/.test(M.plainText(M.banner(I, tA, 140))), 'in place of the step')
    assert.match(M.plainText(M.banner(waitOf({ holds: ['T03', 'T04'], waiting: ['T03', 'T04'] }), tA, 140)), /‖ T03 +waits for you \+1 +⏱/)
    assert.ok(!/‖/.test(M.plainText(M.banner(waitOf({}, 'awaiting-ruling'), tA, 140))))
    for (const w of [60, 80, 100, 140]) assert.ok(M.width(M.banner(I, tA, w)) <= w || w < 70, `${w}`)
    // The slot keeps its width, with or without a waiting task: nothing after it moves
    const b0 = M.plainText(M.banner({ ...I, issues: [] }, tA, 140))
    assert.equal(M.plainText(M.banner(I, tA, 140)).indexOf('⏱'), b0.indexOf('⏱'))
  })

  testCase('wait for a ruling (0.21.0): the log glyphs ‖ and ▶, and the two notifications, which follow /progress sound', () => {
    const log = [
      { at: tA - 3000, kind: 'wait', task: 'T03', text: 'T03 waits for 3 rulings (15 min at most)' },
      { at: tA - 1000, kind: 'task', task: 'T03', text: 'T03 starts (main checkout) without 2 rulings' },
    ]
    const I = M.normalize({ ...waitDoc(), log })
    const rows = M.logCard(I, tA, 100, false).lines.map(l => [M.plainText(l), l.find(m => m.t === '‖' || m.t === '▶')])
    const wait = rows.find(([t]) => /waits for 3 rulings/.test(t)), start = rows.find(([t]) => /without 2 rulings/.test(t))
    assert.deepEqual([wait[1].t, wait[1].c], ['‖', 'warning'])
    assert.equal(start[1].t, '▶')
    assert.match(wait[0], /T03 +‖ T03 waits for 3 rulings \(15 min at most\)$/)
    // Arrival: one notification per task; the minutes from `until` and the write that raised them
    const none = M.normalize({ ...waitDoc(), issues: [] }, registerOf())
    const raised = (o = {}) => M.normalize({ ...waitDoc(), updated: new Date(Date.parse(UNTIL) - 15 * 60000).toISOString(), issues: [issueOf('T01-1', { holds: ['T05'], until: UNTIL }), issueOf('T01-2', { holds: ['T06'], until: UNTIL }), issueOf('T01-3', { holds: ['T05', 'T06', 'T07'], until: UNTIL })], ...o }, registerOf('T01-1', 'T01-2', 'T01-3'))
    assert.deepEqual(M.changes(none, raised()).filter(x => x.startsWith('?')), ['? T01: 3 issues to settle now — T05, T06 and T07 wait for them 15 min'])
    const one = M.normalize({ ...waitDoc(), updated: new Date(Date.parse(UNTIL) - 15 * 60000).toISOString(), issues: [issueOf('T01-1', { holds: ['T03'], until: UNTIL })] }, registerOf('T01-1'))
    assert.deepEqual(M.changes(none, one), ['? T01: 1 issue to settle now — T03 waits for it 15 min'])
    assert.deepEqual(M.changes(one, one), [], 'nothing twice')
    assert.deepEqual(M.changes(null, one), [], 'nothing at the first read')
    // No notification for an issue that holds nothing, for the stop issue, nor for an answer withdrawn (unrule)
    assert.deepEqual(M.changes(none, M.normalize({ ...waitDoc(), issues: [issueOf('T01-1', { holds: [] })] }, registerOf('T01-1'))), [])
    const ruled = M.normalize({ ...waitDoc(), pending_rulings: [{ issue: 'T01-1', option: 'A', text: null, at: UNTIL }] }, registerOf('T01-1'))
    assert.deepEqual(M.changes(ruled, one), [])
    // Start without a ruling: the minutes of the wait, from the log entry of the task
    const went = M.normalize({ ...waitDoc({ started_without: ['T03'] }), log: [{ at: tA - 5000, kind: 'wait', task: 'T03', text: 'T03 waits for 1 ruling (15 min at most)' }] }, registerOf('T01-1'))
    const before = M.normalize({ ...waitDoc(), log: [{ at: tA - 5000, kind: 'wait', task: 'T03', text: 'T03 waits for 1 ruling (15 min at most)' }] }, registerOf('T01-1'))
    assert.deepEqual(M.changes(before, went), ['▶ T03 starts without your ruling: 15 min passed'])
    assert.deepEqual(M.changes(went, went), [])
    // Released by [ Decide later ]: the task was not left waiting, no notification
    assert.deepEqual(M.changes(before, M.normalize({ ...waitDoc({ started_without: ['T03'], released: UNTIL, holds: [] }) }, registerOf('T01-1'))), [])
    // Both ask for someone: toast, and the sound if /progress sound is on
    for (const m of ['? AH04: 3 issues to settle now — AH05 and AH05B wait for them 15 min', '? AH04: 1 issue to settle now — AH05 waits for it 15 min', '▶ AH04 starts without your ruling: 15 min passed']) assert.ok(M.isImportant(m), m)
    for (const m of ['? something else', '▶ T01 starts (main checkout)']) assert.ok(!M.isImportant(m), m)
  })

  // ── Fixes after the acceptance EV3 (0.22.0, T29) ──
  testCase('mode deviation (0.22.0): the run waits for the ruling of an issue whose waiting task is closed — card `when`, run card, banner and arrival notification; the phase-mode texts unchanged', () => {
    // T01 (merged) raised T01-1: in mode deviation, the run waits for it on behalf of T01, then stops
    const devDoc = (o = {}) => ({ ...waitDoc({ waiting: ['T01'], ...o }), runs: [...rawC.runs.slice(0, -1), { ...lastRun, mode: 'deviation', status: 'in-progress', end: null }] })
    const I = M.normalize(devDoc(), registerOf('T01-1'))
    assert.equal(I.tasks.find(t => t.id === 'T01').status, 'merged')
    assert.deepEqual([M.runWaits(I, tA).map(p => p.id), M.rulingWaits(I, tA)], [['T01-1'], []], 'the run waits, no task does')
    assert.equal(whenOf2(I, tA), 'when     Now: the run waits for it 14:47, then stops')
    assert.equal(whenOf2(I, Date.parse(UNTIL) + 5000), 'when     Now: the run waits for it 0:00, then stops')
    const meta = M.runCard(I, tA, 100).meta.map(m => m.t).join('')
    assert.ok(meta.startsWith('‖ run waits for you'), meta)
    assert.deepEqual(M.runCard(I, tA, 100).meta[0].c, 'warning')
    assert.match(M.plainText(M.banner(I, tA, 140)), /‖ run waits for you/)
    assert.doesNotMatch(M.plainText(M.banner(I, tA, 140)), /T01 waits for you/)
    // A blocked closed task is the run's wait too, not a task's
    const B = M.normalize({ ...devDoc({ waiting: ['T02'] }), tasks: rawC.tasks.map(t => (t.id === 'T02' ? { ...t, status: 'blocked' } : t)) }, registerOf('T01-1'))
    assert.deepEqual([M.runWaits(B, tA).length, M.rulingWaits(B, tA)], [1, []])
    // Arrival: once the run waits for them, one notification per task that raised them
    const raisedAt = new Date(Date.parse(UNTIL) - 15 * 60000).toISOString()
    const notYet = M.normalize({ ...devDoc({ waiting: [] }), updated: raisedAt }, registerOf('T01-1'))
    const now1 = M.normalize({ ...devDoc(), updated: raisedAt }, registerOf('T01-1'))
    assert.deepEqual(M.changes(notYet, now1), ['? T01: 1 issue to settle now — the run waits for it 15 min, then stops'])
    const two = M.normalize({ ...devDoc(), updated: raisedAt, issues: [issueOf('T01-1', { holds: ['T03'], waiting: ['T01'], until: UNTIL }), issueOf('T01-2', { holds: [], waiting: ['T01'], until: UNTIL })] }, registerOf('T01-1', 'T01-2'))
    assert.deepEqual(M.changes(notYet, two), ['? T01: 2 issues to settle now — the run waits for them 15 min, then stops'])
    assert.deepEqual(M.changes(now1, now1), [], 'nothing twice')
    assert.ok(M.isImportant('? T01: 1 issue to settle now — the run waits for it 15 min, then stops'))
    // In mode deviation, the close that raises an issue holding T03 says nothing of T03: it never starts without the ruling
    const none = M.normalize({ ...devDoc(), issues: [] }, registerOf())
    assert.deepEqual(M.changes(none, notYet), [])
    // Phase mode: unchanged
    assert.equal(whenOf2(waitOf(), tA), 'when     Now: T03 waits for it 14:47, then starts without it')
  })

  testCase('[ Accept the N recommended ] (0.22.0): human issues are left out, counted nor ruled; a valid recommended option of a human issue keeps its own button', () => {
    const human = issueOf('T01-3', { human: true })
    const I = M.normalize({ ...withRun(rawC, 'in-progress'), pending_rulings: [], issues: [issueOf('T01-1'), issueOf('T01-2'), human] }, registerOf('T01-1', 'T01-2', 'T01-3'))
    assert.deepEqual(M.acceptable(I), [{ issue: 'T01-1', option: 'A' }, { issue: 'T01-2', option: 'A' }])
    assert.ok(M.recommendedOf(I.issues.find(p => p.id === 'T01-3')), 'its own card still offers it')
    const L = M.yourTurnCard(I, tA, 100).lines.map(M.plainText)
    assert.ok(L.some(x => x.includes('[ Accept the 2 recommended ]')), L.join('\n'))
    const one = M.normalize({ ...withRun(rawC, 'in-progress'), pending_rulings: [], issues: [issueOf('T01-1'), human] }, registerOf('T01-1', 'T01-3'))
    assert.ok(!M.yourTurnCard(one, tA, 100).lines.map(M.plainText).some(x => x.includes('Accept the')), 'from two such issues only')
  })

  testCase('ISSUES.json unreadable (0.22.0): no issue gets `entry`, and the register adds nothing to settledIssues', () => {
    const doc = { ...withRun(rawC, 'in-progress'), pending_rulings: [], issues: [issueOf('T01-1'), issueOf('T01-2', { status: 'settled' })] }
    const read = M.normalize(doc, { format: 'orchestre-issues/1', issues: [{ id: 'T01-1', status: 'open' }, { id: 'T01-7', status: 'settled' }] })
    assert.deepEqual([read.issues.map(p => p.entry), read.settledIssues], [[true], ['T01-2', 'T01-7']])
    for (const unread of [null, undefined, 'not JSON', { issues: 'x' }]) {
      const I = M.normalize(doc, unread)
      assert.deepEqual([I.issues.map(p => 'entry' in p), I.settledIssues], [[false], ['T01-2']], String(unread))
    }
  })

  testCase('log written by the real progress.mjs (0.22.0): the wait line has ‖ in warning and a news text, the start without its rulings ▶; an option whose amendments would all be discarded shows invalid with the reason of rule', () => {
    const root = mkdtempSync(join(tmpdir(), 'mod-wait-')), g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false')
      const w = join(root, 'plans', 'demo')
      mkdirSync(join(w, 'tasks'), { recursive: true })
      for (const [id, ph, dep] of T) writeFileSync(join(w, 'tasks', `${id}-x.md`), task(id, ph, dep))
      writeFileSync(join(w, 'HANDOFF.md'), '# HANDOFF — demo\n')
      writeFileSync(join(w, 'orchestre.config.json'), JSON.stringify({ integration_branch: 'plan/demo' }))
      g('add', '.'); g('commit', '-qm', 'init'); g('switch', '-qc', 'plan/demo')
      const run = (cmd, E, env = {}) => { const r = spawnSync(process.execPath, [PROGRESS, cmd, 'plans/demo', '--json', JSON.stringify(E)], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } }); assert.equal(r.status, 0, `${cmd}: ${r.stderr}`); return r.stdout }
      run('run-start', { phase: 1, mode: 'phase', parallelism: 2, max_fixes: 2, max_auto_decisions: 3 })
      run('close', { task: 'T01', status: 'merged', attempts: 1, branch: 'task/T01', issues: [{ title: 'Lint', context: 'c', human: false, options: [{ id: 'A', description: 'Lint T02', amendments: [{ id: 'T02', reason: 'r', verification: ['npm run lint'] }] }] }] })
      assert.equal(JSON.parse(run('wait', { task: 'T02', issues: ['T01-1'] }, { ORCHESTRE_WAIT_SECONDS: '1' })).again, true)
      run('step', { task: 'T02', step: 'worker', isolated: false, without: ['T01-1'] })
      const I = M.normalize(JSON.parse(readFileSync(join(w, 'progress.json'), 'utf8')))
      const rows = M.logCard(I, Date.now(), 100, false).lines.map(l => [M.plainText(l), l.find(m => m.t === '‖' || m.t === '▶')])
      const wait = rows.find(([t]) => /T02 waits for 1 ruling \(15 min at most\)/.test(t)), start = rows.find(([t]) => /T02 starts \(main checkout\) without 1 ruling/.test(t))
      assert.ok(wait && start, JSON.stringify(rows.map(r => r[0])))
      assert.deepEqual([wait[1].t, wait[1].c, start[1].t], ['‖', 'warning', '▶'])
      const at = /** @type {number} */ (I.log.find(j => j.kind === 'wait').at)
      assert.equal(M.news({ ...I, log: I.log.filter(j => j.kind === 'wait') }, at + 1000)?.text, 'T02 waits for your ruling (15 min at most)')
      // Run 9: T02 merged since, the only task option A amends: the pane shows it invalid with the reason rule gives
      run('close', { task: 'T02', status: 'merged', attempts: 1, branch: 'task/T02' })
      const J = M.normalize(JSON.parse(readFileSync(join(w, 'progress.json'), 'utf8')), JSON.parse(readFileSync(join(w, 'ISSUES.json'), 'utf8')))
      const p = J.issues.find(x => x.id === 'T01-1'), A = p.options.find(o => o.id === 'A')
      assert.equal(M.refusalOf(p, A), 'its amendments would all be discarded: T02 merged or cancelled since the issue was raised; answer with a text')
      assert.equal(M.recommendedOf(p), null)
      const r = spawnSync(process.execPath, [PROGRESS, 'rule', 'plans/demo', '--json', JSON.stringify({ issue: 'T01-1', option: 'A' })], { cwd: root, encoding: 'utf8' })
      assert.deepEqual([r.status, r.stderr.trim()], [1, `progress: rule: option A of T01-1 is invalid: ${M.refusalOf(p, A)}`], 'the same reason as rule')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  testCase('step challenge (0.22.0), written by the real progress.mjs: in the timeline, the steps line and the legend; what the task does says it; a rejection by the challenge names its mutation; without it, 0.21 as before', () => {
    const root = mkdtempSync(join(tmpdir(), 'mod-challenge-')), g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false')
      const w = join(root, 'plans', 'demo')
      mkdirSync(join(w, 'tasks'), { recursive: true })
      for (const [id, ph, dep] of T) writeFileSync(join(w, 'tasks', `${id}-x.md`), task(id, ph, dep))
      writeFileSync(join(w, 'HANDOFF.md'), '# HANDOFF — demo\n')
      writeFileSync(join(w, 'orchestre.config.json'), JSON.stringify({ integration_branch: 'plan/demo' }))
      g('add', '.'); g('commit', '-qm', 'init'); g('switch', '-qc', 'plan/demo')
      const run = (cmd, E) => { const r = spawnSync(process.execPath, [PROGRESS, cmd, 'plans/demo', '--json', JSON.stringify(E)], { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, `${cmd}: ${r.stderr}`) }
      // progress.json dates to the second: the log is spread 10 s apart, from the start of the run, so each step lasts
      const base = Date.parse(rawFile().updated || '2026-01-01T00:00:00Z')
      const read = () => {
        const raw = JSON.parse(readFileSync(join(w, 'progress.json'), 'utf8')), at = i => new Date(base + i * 10000).toISOString()
        raw.log.forEach((j, i) => { j.at = at(i) })
        raw.runs[0].start = at(0); raw.updated = at(raw.log.length)
        for (const t of raw.tasks) if (t.start) t.start = at(1)
        return M.normalize(raw)
      }
      const clock = I => base + I.log.length * 10000
      run('run-start', { phase: 1, mode: 'auto', parallelism: 2, max_fixes: 2, max_auto_decisions: 3 })
      for (const st of ['worker', 'verification', 'evaluation']) run('step', { task: 'T01', step: st, isolated: false })
      // Without a challenge: the legend is the one of 0.21
      const before = read(), legendOf = (I, now) => M.taskLines(I, now, 100).map(M.plainText).find(l => /━ work/.test(l))
      assert.match(legendOf(before, clock(before)), /━ work {2}━ verif {2}━ eval {2}━ fix {2}━ merge$/)
      assert.ok(!M.timePerStep(before, clock(before)).some(e => e[0] === 'challenge'))
      run('step', { task: 'T01', step: 'challenge', isolated: false })
      const I = read(), now = clock(I)
      assert.equal(I.tasks[0].step, 'challenge')
      // The timeline: a segment of the step, in its color
      assert.deepEqual(M.stepsOf(I, I.tasks[0], now).map(e => e[2]), ['worker', 'verification', 'evaluation', 'challenge'])
      assert.deepEqual(M.timePerStep(I, now).map(e => e[0]), ['worker', 'verification', 'evaluation', 'challenge'])
      assert.match(legendOf(I, now), /━ eval {2}━ chall {2}━ fix {2}━ merge$/)
      // What the task does
      assert.match(M.plainText(M.banner(I, now, 140)), /◐ T01 challenge/)
      assert.match(M.taskLines(I, now, 100).map(M.plainText).find(l => /^ {2}◐ T01\b/.test(l)), /challenge/)
      // A rejection by the challenge names the mutation that went through
      const MUT = 'src/form.js:42: `if (!valid) return` removed, no test fails'
      run('step', { task: 'T01', step: 'fix', isolated: false, rejection: { attempt: 1, by: 'challenge', gaps: [MUT, 'second gap'] } })
      const R = read(), at = R.log.findLast(j => j.kind === 'rejection').at
      assert.equal(M.news(R, at + 1000)?.text, `T01: attempt 1 rejected by the challenge: ${MUT}`)
      assert.match(M.plainText(M.logCard(R, at + 1000, 160, false).lines.find(l => /rejected/.test(M.plainText(l)))), new RegExp(`T01 +↻ T01: attempt 1 rejected by the challenge: ${MUT.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
      // Another rejection keeps its text, and a challenge rejection without its gap too
      assert.equal(M.news({ ...R, tasks: R.tasks.map(t => ({ ...t, rejections: [] })) }, at + 1000)?.text, 'T01: attempt 1 rejected (challenge)')
      // Each attempt names its own mutation
      run('step', { task: 'T01', step: 'fix', isolated: false, rejection: { attempt: 2, by: 'challenge', gaps: ['other mutation'] } })
      const C = read(), atC = C.log.findLast(j => j.kind === 'rejection').at
      assert.equal(M.news(C, atC + 1000)?.text, 'T01: attempt 2 rejected by the challenge: other mutation')
      // The gap as the workflow writes it, prefix included: the news and the log line show the mutation alone
      const WF = 'src/a.ts:12, if (ok) → if (!ok)'
      run('step', { task: 'T01', step: 'fix', isolated: false, rejection: { attempt: 4, by: 'challenge', gaps: [`mutation not detected by any verification command: ${WF}`] } })
      const P = read(), atP = P.log.findLast(j => j.kind === 'rejection').at
      assert.equal(M.news(P, atP + 1000)?.text, `T01: attempt 4 rejected by the challenge: ${WF}`)
      const logP = M.plainText(M.logCard(P, atP + 1000, 160, false).lines.find(l => /attempt 4 rejected/.test(M.plainText(l))))
      assert.ok(logP.includes(`rejected by the challenge: ${WF}`) && !logP.includes('mutation not detected'), logP)
      run('step', { task: 'T01', step: 'fix', isolated: false, rejection: { attempt: 3, by: 'evaluation', gaps: ['x'] } })
      const E = read(), at2 = E.log.findLast(j => j.kind === 'rejection').at
      assert.equal(M.news(E, at2 + 1000)?.text, 'T01: attempt 3 rejected (evaluation)')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  console.log(`progress mod: ALL GREEN (${n} cases)`)
} finally {
  rmSync(repoRoot, { recursive: true, force: true })
}
