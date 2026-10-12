import fs from 'node:fs'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
const SRC = process.argv[2]
const src = fs.readFileSync(SRC, 'utf8')
for (const bad of ['Date.now', 'Math.random', 'new Date(', 'require(', 'import ']) assert.ok(!src.includes(bad), `forbidden: ${bad}`)
const body = src.replace(/^export const meta = /m, 'const meta = ')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const run = new AsyncFunction('args', 'agent', 'phase', 'log', body)
// lint is required since 0.12.0 (/orchestre:run passes it): no default path any more
const ARGS = { plan: 'plans/p', phase: 1, mode: 'phase', parallelism: 4, integration: 'plan/p', max_fixes: 2, escalation: ['sonnet', 'opus'], lint: '/plug/scripts/plan-lint.mjs' }
// T00 without a model (plan from before 0.11.0): worker on sonnet, fixes along the ladder, without the replanner's choice;
// the M* scenarios play tasks that have a model
const T00 = { id: 'T00', title: 'Tooling', file: 'plans/p/tasks/T00.md', phase: 1, depends_on: [], resources: ['local-db', 'port-3000'], status: 'todo', verification: ['sh scripts/typecheck.sh', 'sh scripts/e2e-local.sh'] }
const T01 = { id: 'T01', title: 'Foundations', file: 'plans/p/tasks/T01.md', phase: 1, model: 'opus', depends_on: ['T00'], resources: ['local-db', 'port-3000'], status: 'todo', verification: ['pnpm test'] }
// Copies: the workflow amends verification and depends_on in memory
const plan = (...ts) => ({ ok: true, tasks: ts.map(t => ({ ...t })) })
const report = (n, extra = {}) => ({ status: 'done', summary: `report ${n}: 96/96 three times`, branch: 'task/T00', commit: 'c' + n, path: '/repo', findings: [{ category: 'Verified commands', content: 'routes prewarmed ' + n }], deviations: [], ...extra })
const ok = (x) => ({ ok: true, results: [{ command: 'sh scripts/typecheck.sh', code: 0, excerpt: 'tsc ' + x }, { command: 'sh scripts/e2e-local.sh', code: 0, excerpt: '96 passed ' + x }] })
const SOK = { ok: true, commit: 's1', rejected: [] }
const MOK = { ok: true, merged: true, check_ok: true, commit: 'm1' }
const NOTHING = { major: false, entries: [], issues: [] }
const DEVIATION = [{ type: 'deviation', description: 'isSuperAdmin optional in UpdateUserSchema' }]
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
let last = null
async function scenario(name, q, args = {}) {
  const calls = [], logs = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    const k = opts.label
    if (!(k in q) || !q[k].length) throw new Error(`[${name}] unexpected call: ${k}`)
    const v = q[k].shift()
    return typeof v === 'function' ? v(prompt, opts) : v
  }
  const res = await run({ ...ARGS, ...args }, agent, () => {}, (m) => logs.push(m))
  last = res
  return { res, calls, logs, q }
}
const byLabel = (calls, l) => calls.filter(c => c.opts.label === l)
const idx = (calls, l) => calls.findIndex(c => c.opts.label === l)
const drained = (name, q) => { for (const k in q) assert.equal(q[k].length, 0, `${name}: answer not consumed for ${k}`) }
let n = 0
async function test(name, fn) {
  last = null
  try { await fn(); n++; console.log('ok ·', name) } catch (e) { console.log('FAILED ·', name, '\n', JSON.stringify(last, null, 1)); throw e }
}
// T00 merged without a story, with possible deviations; T01 likewise
const t00 = (deviations = [], merge = MOK) => ({ 'T00 · worker': [report(0, { deviations })], 'T00 · verification': [ok(1)], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [merge] })
const t01 = () => ({ 'T01 · worker': [report(1, { branch: 'task/T01' })], 'T01 · verification': [ok(2)], 'T01 · evaluation': [{ verdict: 'pass' }], 'T01 · merge': [MOK], 'T01 · progress': [SOK] })
const RP_E = { major: true, entries: [{ type: 'deviation', severity: 'major', description: 'contract widened' }], issues: [{ title: 'UpdateUserSchema contract', context: 'isSuperAdmin optional', options: [
  { id: 'A', description: 'Keep optional and test rule (d)', impact: 'one more test', recommended: true,
    entries: [{ type: 'debt', severity: 'minor', description: 'document the contract' }],
    added_tasks: [{ id: 'T00C', title: 'Rule d test', phase: 0, content: '---\nid: T00C\nphase: 0\nmodel: sonnet\n---\n' }],
    amendments: [{ id: 'T01', verification: ['pnpm test:rule-d'], definition_of_done: ['rule (d) is tested'], reason: 'security rule without a test' }] },
  { id: 'B', description: 'Make the field required', impact: 'breaks partial calls', recommended: false } ] }] }

// ——— Non-regression v0.3 ———
await test('A: T00 blocked after 2 rejections, T01 not started', async () => {
  const { res, calls, q } = await scenario('A', {
    'plan-reader': [plan(T00, T01)], 'T00 · worker': [report(0)],
    'T00 · verification': [ok(1), ok(2), { ok: false, results: [{ command: 'sh scripts/e2e-local.sh', code: 1, excerpt: '95 passed, 1 failed' }], failures: [{ command: 'sh scripts/e2e-local.sh', excerpt: 'ECONNRESET /healthz' }] }],
    'T00 · evaluation': [{ verdict: 'fail', gaps: ['A1', 'A2'] }, { verdict: 'fail', gaps: ['B1'] }],
    'T00 · fix 1': [report(1)], 'T00 · fix 2': [report(2)],
    'T00 · replanning': [NOTHING], 'T00 · progress': [SOK] })
  const t = res.tasks.find(x => x.id === 'T00')
  assert.equal(res.status, 'partial'); assert.equal(t.status, 'blocked'); assert.equal(t.attempts, 3)
  assert.deepEqual(t.blocker, ['sh scripts/e2e-local.sh: ECONNRESET /healthz'])
  assert.deepEqual(t.rejections, [{ attempt: 1, by: 'evaluation', gaps: ['A1', 'A2'] }, { attempt: 2, by: 'evaluation', gaps: ['B1'] }])
  assert.deepEqual(res.not_started, ['T01'])
  assert.equal(byLabel(calls, 'T00 · fix 1')[0].opts.model, 'sonnet'); assert.equal(byLabel(calls, 'T00 · fix 2')[0].opts.model, 'opus')
  const ev = byLabel(calls, 'T00 · evaluation')
  assert.ok(ev[0].prompt.includes('96 passed 1') && !ev[0].prompt.includes('96 passed 2'))
  assert.ok(ev[1].prompt.includes('96 passed 2') && ev[1].prompt.includes('report 1: 96/96') && ev[1].prompt.includes('not a proof'))
  const rp = byLabel(calls, 'T00 · replanning')[0]
  assert.equal(rp.opts.model, 'opus'); assert.ok(rp.prompt.includes(', in /repo') && rp.prompt.includes('plans/p/tasks/T00.md'), 'replan: path of the unmerged work')
  const sc = byLabel(calls, 'T00 · progress')[0]
  assert.ok(sc.opts.schema.required.includes('ok'), 'scribe: schema')
  assert.ok(sc.prompt.includes('rejection · minor') && sc.prompt.includes('"A1"') && sc.prompt.includes('this blocker') && !sc.prompt.includes('plan-lint.mjs'), 'scribe: rejections and blocker, no plan-lint without a creation')
  drained('A', q)
})
await test('B: T00 merged after 1 rejection + flaky, T01 blocked by its worker', async () => {
  const { res, calls, q } = await scenario('B', {
    'plan-reader': [plan(T00, T01)], 'T00 · worker': [report(0)],
    'T00 · verification': [ok(1), { ...ok(2), flaky: ['journal.spec.ts:53'] }],
    'T00 · evaluation': [{ verdict: 'fail', gaps: ['C1'] }, { verdict: 'pass' }],
    'T00 · fix 1': [report(1)], 'T00 · merge': [MOK], 'T00 · progress': [SOK],
    'T01 · worker': [{ status: 'blocked', summary: 'blocked', branch: 'task/T01', path: '/repo', blocker: 'ambiguous schema' }],
    'T01 · replanning': [NOTHING], 'T01 · progress': [SOK] })
  const t0 = res.tasks.find(x => x.id === 'T00'), t1 = res.tasks.find(x => x.id === 'T01')
  assert.equal(res.status, 'partial'); assert.equal(t0.status, 'merged'); assert.equal(t0.attempts, 2); assert.ok(!('blocker' in t0))
  assert.deepEqual(t0.rejections, [{ attempt: 1, by: 'evaluation', gaps: ['C1'] }]); assert.deepEqual(t0.flaky, ['journal.spec.ts:53'])
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.ok(sc.includes('rejection · minor') && sc.includes('Flaky tests') && !sc.includes('this blocker'))
  assert.equal(t1.status, 'blocked'); assert.deepEqual(t1.blocker, ['ambiguous schema'])
  drained('B', q)
})
await test('C: verifier without an answer then success; integrator in the v0.3 format', async () => {
  const { res, q } = await scenario('C', {
    'plan-reader': [plan(T00)], 'T00 · worker': [report(0)],
    'T00 · verification': [null, ok(2)], 'T00 · evaluation': [{ verdict: 'pass' }],
    'T00 · fix 1': [report(1)], 'T00 · merge': [{ ok: true }], 'T00 · progress': [SOK] })
  assert.equal(res.status, 'finished'); assert.equal(res.tasks[0].status, 'merged')
  assert.deepEqual(res.tasks[0].rejections, [{ attempt: 1, by: 'verification', gaps: ['verifier without an answer'] }])
  drained('C', q)
})
await test('D: unverifiable criterion → blind spot and replanning, without a fail or a duplicate', async () => {
  const UV = 'typecheck.sh from a worktree: the task runs in the main checkout'
  const { res, calls, q } = await scenario('D', {
    'plan-reader': [plan(T00)], 'T00 · worker': [report(0)],
    'T00 · verification': [{ ...ok(1), flaky: ['journal.spec.ts:53'] }, { ...ok(2), flaky: ['journal.spec.ts:53'] }],
    'T00 · evaluation': [{ verdict: 'fail', gaps: ['M1'], unverifiable: [UV] }, { verdict: 'pass', unverifiable: [UV] }],
    'T00 · fix 1': [report(1)], 'T00 · merge': [MOK], 'T00 · replanning': [NOTHING], 'T00 · progress': [SOK] })
  const t = res.tasks[0]
  assert.equal(res.status, 'finished'); assert.equal(t.status, 'merged'); assert.deepEqual(t.unverifiable, [UV])
  assert.ok(byLabel(calls, 'T00 · replanning')[0].prompt.includes(UV), 'replan: unverifiable criterion passed on')
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.ok(sc.includes('blind-spot · minor') && sc.split(UV).length === 2 && sc.split('journal.spec.ts:53').length === 2)
  drained('D', q)
})

// ——— v0.4: auto-decisions and guardrails ———
await test('E: autonomous, recommended option taken automatically (amendment, added task brought back to the current phase)', async () => {
  const { res, calls, q } = await scenario('E', { 'plan-reader': [plan(T00, T01)], ...t00(DEVIATION), 'T00 · replanning': [RP_E], 'T00 · progress': [SOK], ...t01() }, { mode: 'auto' })
  assert.equal(res.status, 'rerun')
  assert.deepEqual(res.auto_decisions, [{ task: 'T00', title: 'UpdateUserSchema contract', option: 'A', description: 'Keep optional and test rule (d)' }])
  const rp = byLabel(calls, 'T00 · replanning')[0]
  assert.equal(rp.opts.model, 'opus'); assert.ok(rp.prompt.includes('Autonomous mode') && rp.prompt.includes(', merged into plan/p'))
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  for (const x of ['option A taken automatically (autonomous mode)', '"id":"T00C"', 'phase: 1', 'pnpm test:rule-d', 'amendment · major', 'plan-lint.mjs plans/p --integration plan/p', 'document the contract', 'contract widened', 'git checkout HEAD --'])
    assert.ok(sc.includes(x), 'scribe: ' + x)
  assert.ok(!sc.includes('phase: 0'), 'scribe: past phase corrected')
  assert.ok(byLabel(calls, 'T01 · verification')[0].prompt.includes('pnpm test:rule-d'), 'T01: verification amended')
  assert.ok(byLabel(calls, 'T01 · worker')[0].prompt.includes('Keep optional and test rule (d) (taken automatically)'), 'T01: decision passed on')
  assert.deepEqual(res.added_tasks, [{ id: 'T00C', phase: 1, title: 'Rule d test' }])
  drained('E', q)
})
const issueN = i => ({ title: 'P' + i, context: '', options: [{ id: 'A', description: 'a' + i, recommended: true }, { id: 'B', description: 'b' + i }] })
await test('F: circuit breaker at the 4th issue (cap of 3 by default)', async () => {
  const { res, calls, q } = await scenario('F', { 'plan-reader': [plan(T00, T01)], ...t00(DEVIATION), 'T00 · replanning': [{ major: true, entries: [], issues: [issueN(1), issueN(2), issueN(3), issueN(4)] }], 'T00 · progress': [SOK] }, { mode: 'auto' })
  assert.equal(res.status, 'awaiting-ruling'); assert.equal(res.auto_decisions.length, 3)
  assert.equal(res.stop_issue.title, 'P4'); assert.equal(res.stop_issue.circuit_breaker, true); assert.equal(res.stop_issue.human, false)
  assert.deepEqual(res.not_started, ['T01']); assert.equal(idx(calls, 'T01 · worker'), -1)
  drained('F', q)
})
await test('F2: cap passed as 0, the following issues kept', async () => {
  const { res, q } = await scenario('F2', { 'plan-reader': [plan(T00, T01)], ...t00(DEVIATION), 'T00 · replanning': [{ major: true, entries: [], issues: [issueN(1), issueN(2)] }], 'T00 · progress': [SOK] }, { mode: 'auto', max_auto_decisions: 0 })
  assert.equal(res.status, 'awaiting-ruling'); assert.equal(res.auto_decisions.length, 0)
  assert.equal(res.stop_issue.title, 'P1'); assert.equal(res.open_issues.length, 1); assert.equal(res.open_issues[0].circuit_breaker, true)
  drained('F2', q)
})
await test('G: human issue in autonomous mode → stop', async () => {
  const { res, calls, q } = await scenario('G', { 'plan-reader': [plan(T00, T01)], ...t00(DEVIATION), 'T00 · replanning': [{ major: true, entries: [], issues: [{ title: 'Prod access', human: true, options: [] }] }], 'T00 · progress': [SOK] }, { mode: 'auto' })
  assert.equal(res.status, 'awaiting-ruling'); assert.equal(res.stop_issue.human, true); assert.equal(res.stop_issue.title, 'Prod access')
  assert.equal(res.auto_decisions.length, 0); assert.equal(idx(calls, 'T01 · worker'), -1)
  drained('G', q)
})
await test('G2: needs-human deviation without a human issue → stop all the same', async () => {
  const { res, q } = await scenario('G2', { 'plan-reader': [plan(T00, T01)], ...t00([{ type: 'needs-human', description: 'API key required' }]), 'T00 · replanning': [{ major: false, entries: [{ type: 'needs-human', severity: 'major', description: 'key' }], issues: [] }], 'T00 · progress': [SOK] }, { mode: 'auto' })
  assert.equal(res.status, 'awaiting-ruling'); assert.equal(res.stop_issue.title, 'Human need reported by T00'); assert.ok(res.stop_issue.context.includes('API key required'))
  drained('G2', q)
})
await test('H: post-merge check failed → merged + needs-human + stop', async () => {
  const { res, calls, q } = await scenario('H', { 'plan-reader': [plan(T00, T01)], ...t00([], { ok: false, merged: true, check_ok: false, detail: 'tsc: 2 errors' }), 'T00 · progress': [SOK] }, { mode: 'auto' })
  assert.equal(res.tasks[0].status, 'merged'); assert.equal(res.status, 'awaiting-ruling')
  assert.equal(res.stop_issue.human, true); assert.ok(res.stop_issue.title.includes('Post-merge check'))
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.ok(sc.includes('needs-human') && sc.includes('tsc: 2 errors') && sc.includes('status "merged"'))
  assert.deepEqual(res.not_started, ['T01']); assert.equal(idx(calls, 'T00 · replanning'), -1)
  drained('H', q)
})
await test('H2: merge conflict → blocked', async () => {
  const { res, q } = await scenario('H2', { 'plan-reader': [plan(T00)], ...t00([], { ok: false, merged: false, conflict: true, detail: 'conflict src/a.ts' }), 'T00 · replanning': [NOTHING], 'T00 · progress': [SOK] })
  assert.equal(res.status, 'partial'); assert.equal(res.tasks[0].status, 'blocked'); assert.deepEqual(res.tasks[0].blocker, ['merge: conflict src/a.ts'])
  drained('H2', q)
})
await test('I1: by phase, the issue stays open with its actions; task added in phase 2', async () => {
  const rp = { ...RP_E, added_tasks: [{ id: 'T09', title: 'Doc', phase: 2, content: '---\nid: T09\nphase: 2\n---' }] }
  const { res, calls, q } = await scenario('I1', { 'plan-reader': [plan(T00, T01)], ...t00(DEVIATION), 'T00 · replanning': [rp], 'T00 · progress': [SOK], ...t01() })
  assert.equal(res.status, 'finished'); assert.equal(res.open_issues.length, 1); assert.equal(res.auto_decisions.length, 0)
  assert.equal(res.open_issues[0].options[0].amendments[0].id, 'T01', 'actions kept for args.rulings')
  assert.equal(byLabel(calls, 'T00 · replanning')[0].opts.model, 'opus')
  assert.ok(!byLabel(calls, 'T01 · verification')[0].prompt.includes('pnpm test:rule-d'), 'nothing applied without a ruling')
  assert.deepEqual(res.added_tasks, [{ id: 'T09', phase: 2, title: 'Doc' }])
  drained('I1', q)
})
await test('I2: stop on deviation', async () => {
  const { res, q } = await scenario('I2', { 'plan-reader': [plan(T00, T01)], ...t00(DEVIATION), 'T00 · replanning': [RP_E], 'T00 · progress': [SOK] }, { mode: 'deviation' })
  assert.equal(res.status, 'awaiting-ruling'); assert.equal(res.stop_issue.title, 'UpdateUserSchema contract'); assert.deepEqual(res.not_started, ['T01'])
  drained('I2', q)
})
const RULING = [{ task: 'T02', title: 'Contract', option: { id: 'B', description: 'Test rule d', entries: [{ type: 'debt', severity: 'minor', description: 'x' }], amendments: [{ id: 'T01', verification: ['pnpm test:d'], reason: 'r' }], added_tasks: [{ id: 'T01B', title: 'Doc', phase: 0, content: '---\nid: T01B\nphase: 0\n---' }] } }]
await test("J: the user's ruling applied by the scribe before the plan is read", async () => {
  const { res, calls, q } = await scenario('J', { 'ruling T02 · progress': [SOK], 'plan-reader': [plan(T00)], ...t00(), 'T00 · progress': [SOK] }, { rulings: RULING })
  assert.equal(idx(calls, 'ruling T02 · progress'), 0); assert.equal(idx(calls, 'plan-reader'), 1)
  const sc = byLabel(calls, 'ruling T02 · progress')[0].prompt
  for (const x of ['option B settled by the user', 'pnpm test:d', 'phase: 1', '## T02', 'plan-lint.mjs', 'ruling B']) assert.ok(sc.includes(x), 'ruling: ' + x)
  assert.ok(byLabel(calls, 'T00 · worker')[0].prompt.includes('Test rule d (settled by the user)'))
  assert.deepEqual(res.rulings_applied, [{ task: 'T02', title: 'Contract', option: 'B' }]); assert.equal(res.status, 'finished')
  drained('J', q)
})
await test('J2: ruling rejected by plan-lint → stop, nothing read', async () => {
  const { res, calls, q } = await scenario('J2', { 'ruling T02 · progress': [{ ok: true, commit: 'x', rejected: [{ id: 'T01', reason: 'plan-lint: unknown dependency' }] }] }, { rulings: RULING })
  assert.equal(res.status, 'awaiting-ruling'); assert.equal(res.stop_issue.human, true); assert.deepEqual(res.rulings_applied, [{ task: 'T02', title: 'Contract', option: 'B' }])
  assert.equal(res.stop_issue.title, 'Ruling "Contract" partly applied')
  assert.equal(idx(calls, 'plan-reader'), -1)
  drained('J2', q)
})
await test('J3: scribe without an answer on a ruling', async () => {
  const { res, q } = await scenario('J3', { 'ruling T02 · progress': [null] }, { rulings: RULING })
  assert.equal(res.status, 'awaiting-ruling'); assert.deepEqual(res.rulings_applied, []); assert.equal(res.stop_issue.title, 'Ruling "Contract" not applied')
  drained('J3', q)
})
await test('K: amendment rejected by the scribe at the close → stop', async () => {
  const { res, calls, q } = await scenario('K', { 'plan-reader': [plan(T00, T01)], ...t00(DEVIATION), 'T00 · replanning': [RP_E], 'T00 · progress': [{ ok: true, commit: 's', rejected: [{ id: 'T01', reason: 'plan-lint' }] }] }, { mode: 'auto' })
  assert.equal(res.status, 'awaiting-ruling'); assert.ok(res.stop_issue.title.includes('rejected')); assert.equal(idx(calls, 'T01 · worker'), -1)
  drained('K', q)
})
await test('K2: scribe without an answer → stop', async () => {
  const { res, q } = await scenario('K2', { 'plan-reader': [plan(T00, T01)], ...t00(), 'T00 · progress': [null] }, { mode: 'auto' })
  assert.equal(res.status, 'awaiting-ruling'); assert.equal(res.stop_issue.title, 'Progress of T00 not committed')
  drained('K2', q)
})
await test('L: two recommended options → stop without a decision', async () => {
  const p2 = { title: 'X', options: [{ id: 'A', description: 'a', recommended: true }, { id: 'B', description: 'b', recommended: true }] }
  const { res, q } = await scenario('L', { 'plan-reader': [plan(T00, T01)], ...t00(DEVIATION), 'T00 · replanning': [{ major: true, entries: [], issues: [p2] }], 'T00 · progress': [SOK] }, { mode: 'auto' })
  assert.equal(res.status, 'awaiting-ruling'); assert.equal(res.stop_issue.title, 'X'); assert.ok(!res.stop_issue.circuit_breaker); assert.equal(res.auto_decisions.length, 0)
  drained('L', q)
})
await test('L2: no recommended option → stop without a decision', async () => {
  const p0 = { title: 'Y', options: [{ id: 'A', description: 'a' }, { id: 'B', description: 'b' }] }
  const { res, q } = await scenario('L2', { 'plan-reader': [plan(T00, T01)], ...t00(DEVIATION), 'T00 · replanning': [{ major: true, entries: [], issues: [p0] }], 'T00 · progress': [SOK] }, { mode: 'auto' })
  assert.equal(res.status, 'awaiting-ruling'); assert.equal(res.stop_issue.title, 'Y'); assert.equal(res.auto_decisions.length, 0)
  drained('L2', q)
})
await test('M: amendments of a task done or running → discarded and recorded', async () => {
  const rp = { major: true, entries: [], issues: [{ title: 'Z', options: [{ id: 'A', description: 'a', recommended: true, amendments: [{ id: 'T00', verification: ['x'], reason: 'r0' }, { id: 'T01', verification: ['y'], reason: 'r1' }] }] }] }
  const { res, calls, q } = await scenario('M', { 'plan-reader': [plan({ ...T00, status: 'merged' }, T01)], 'T01 · worker': [report(1, { branch: 'task/T01', deviations: DEVIATION })], 'T01 · verification': [ok(2)], 'T01 · evaluation': [{ verdict: 'pass' }], 'T01 · merge': [MOK], 'T01 · replanning': [rp], 'T01 · progress': [SOK] }, { mode: 'auto' })
  assert.equal(res.status, 'finished'); assert.equal(res.auto_decisions.length, 1)
  assert.deepEqual(res.discarded_amendments.map(a => [a.task, a.id]), [['T01', 'T00'], ['T01', 'T01']])
  const sc = byLabel(calls, 'T01 · progress')[0].prompt
  assert.ok(sc.includes('amendment not applied') && !sc.includes('Amendments, for tasks not yet started'))
  drained('M', q)
})
await test('N: new dependency on an added task → task deferred to the next run', async () => {
  const rp = { major: true, entries: [], issues: [{ title: 'Prerequisite', options: [{ id: 'A', description: 'add T00D', recommended: true, added_tasks: [{ id: 'T00D', title: 'Prerequisite', phase: 1, content: '---\nid: T00D\nphase: 1\n---' }], amendments: [{ id: 'T01', depends_on: ['T00D'], reason: 'prerequisite' }] }] }] }
  const { res, calls, q } = await scenario('N', { 'plan-reader': [plan(T00, T01)], ...t00(DEVIATION), 'T00 · replanning': [rp], 'T00 · progress': [SOK] }, { mode: 'auto' })
  assert.equal(res.status, 'rerun'); assert.deepEqual(res.deferred, ['T01']); assert.deepEqual(res.not_started, []); assert.equal(idx(calls, 'T01 · worker'), -1)
  drained('N', q)
})
await test('O: replanner without an answer → deviations noted major, stop', async () => {
  const { res, calls, q } = await scenario('O', { 'plan-reader': [plan(T00, T01)], ...t00(DEVIATION), 'T00 · replanning': [null], 'T00 · progress': [SOK] }, { mode: 'auto' })
  assert.equal(res.status, 'awaiting-ruling'); assert.equal(res.stop_issue.title, 'Replanning of T00 without an answer')
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.ok(sc.includes('(not rated: replanner without an answer)') && sc.includes('"severity":"major"'))
  assert.deepEqual(res.not_started, ['T01'])
  drained('O', q)
})
await test('P: an amended task waits until the progress is committed', async () => {
  const A0 = { ...T00, resources: [] }, B2 = { ...T00, id: 'T02', title: 'Other', file: 'plans/p/tasks/T02.md', resources: [], verification: ['pnpm test:t02'] }, C1 = { ...T01, resources: [], depends_on: ['T02'] }
  const e1 = deferred(), e2 = deferred(), order = []
  const rp = { major: true, entries: [], issues: [{ title: 'Race', options: [{ id: 'A', description: 'test', recommended: true, amendments: [{ id: 'T01', verification: ['pnpm test:race'], reason: 'r' }] }] }] }
  const { res, calls, q } = await scenario('P', {
    'plan-reader': [plan(A0, B2, C1)],
    'T00 · worker': [report(0, { deviations: DEVIATION, path: '/wt/T00' })], 'T00 · verification': [ok(1)], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [MOK],
    'T02 · worker': [report(2, { branch: 'task/T02', path: '/wt/T02' })], 'T02 · verification': [ok(2)], 'T02 · evaluation': [{ verdict: 'pass' }], 'T02 · merge': [MOK],
    'T02 · progress': [async () => { e1.resolve(); await e2.promise; return SOK }],
    'T00 · replanning': [async () => { await e1.promise; setTimeout(() => e2.resolve(), 0); return rp }],
    'T00 · progress': [async () => { await new Promise(r => setTimeout(r, 20)); order.push('end of T00 progress'); return SOK }],
    'T01 · worker': [() => { order.push('T01 worker'); return report(1, { branch: 'task/T01' }) }], 'T01 · verification': [ok(3)], 'T01 · evaluation': [{ verdict: 'pass' }], 'T01 · merge': [MOK], 'T01 · progress': [SOK] }, { mode: 'auto' })
  assert.deepEqual(order, ['end of T00 progress', 'T01 worker'])
  assert.ok(byLabel(calls, 'T01 · verification')[0].prompt.includes('pnpm test:race'))
  assert.equal(res.status, 'finished')
  drained('P', q)
})
await test('Q: cancelled task counted as done', async () => {
  const { res, q } = await scenario('Q', { 'plan-reader': [plan({ ...T00, status: 'cancelled' }, T01)], ...t01() })
  assert.equal(res.status, 'finished'); assert.deepEqual(res.tasks.map(t => t.id), ['T01'])
  drained('Q', q)
})
await test('E2: in phase 2, a task proposed in phase 1 is brought back to phase 2', async () => {
  const P2 = t => ({ ...t, phase: 2 })
  const rp = { major: true, entries: [], issues: [{ title: 'Catch-up', options: [{ id: 'A', description: 'add T00E', recommended: true, added_tasks: [{ id: 'T00E', title: 'Catch-up', phase: 1, content: '---\nid: T00E\nphase: 1\n---' }] }] }] }
  const { res, calls, q } = await scenario('E2', { 'plan-reader': [plan(P2(T00))], ...t00(DEVIATION), 'T00 · replanning': [rp], 'T00 · progress': [SOK] }, { mode: 'auto', phase: 2 })
  assert.equal(res.status, 'rerun'); assert.deepEqual(res.added_tasks, [{ id: 'T00E', phase: 2, title: 'Catch-up' }])
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.ok(sc.includes('phase: 2') && !sc.includes('phase: 1'), 'content: phase corrected')
  drained('E2', q)
})

// ——— v0.5: guardrails seen for real ———
await test('S1: sensitive deviation without an issue → human stop, entry forced to major', async () => {
  const devs = [{ type: 'decision', description: 'the test runs on the dev database mission_space' }]
  const { res, calls, q } = await scenario('S1', { 'plan-reader': [plan(T00, T01)], ...t00(devs), 'T00 · replanning': [{ major: false, entries: [{ type: 'decision', severity: 'minor', description: 'test on the dev database' }], issues: [] }], 'T00 · progress': [SOK] }, { mode: 'auto' })
  assert.equal(res.status, 'awaiting-ruling'); assert.equal(res.stop_issue.human, true); assert.ok(res.stop_issue.title.includes('Sensitive deviation'))
  const rp = byLabel(calls, 'T00 · replanning')[0].prompt
  assert.ok(rp.includes('major automatically') && rp.includes('dev database mission_space'), 'replan: sensitive deviation listed')
  assert.ok(byLabel(calls, 'T00 · progress')[0].prompt.includes('"severity":"major","description":"test on the dev database"'), 'entry forced to major')
  assert.equal(res.tasks[0].status, 'merged')
  drained('S1', q)
})
await test('S1b: sensitive deviation with an issue, by phase → open issue, no stop', async () => {
  const devs = [{ type: 'deviation', description: 'restore of the prod dump to rehearse' }]
  const { res, calls, q } = await scenario('S1b', { 'plan-reader': [plan(T00, T01)], ...t00(devs), 'T00 · replanning': [RP_E], 'T00 · progress': [SOK], ...t01() })
  assert.equal(res.status, 'finished'); assert.equal(res.open_issues.length, 1)
  assert.ok(!byLabel(calls, 'T01 · replanning').length)
  drained('S1b', q)
})
await test('S1c: ordinary deviation → no list of sensitive deviations', async () => {
  const { calls, q } = await scenario('S1c', { 'plan-reader': [plan(T00)], ...t00(DEVIATION), 'T00 · replanning': [NOTHING], 'T00 · progress': [SOK] })
  assert.ok(!byLabel(calls, 'T00 · replanning')[0].prompt.includes('major automatically'))
  drained('S1c', q)
})
await test('S2: auto-decision that cites a task that does not exist → stop, nothing applied', async () => {
  const rp = { major: true, entries: [], issues: [{ title: 'Code 1 accepted', options: [{ id: 'A', description: 'bound the decision; T06B will provide the script', recommended: true, entries: [{ type: 'decision', severity: 'major', description: 'script delivered by T06B' }] }, { id: 'B', description: 'other' }] }] }
  const { res, calls, q } = await scenario('S2', { 'plan-reader': [plan(T00, T01)], ...t00(DEVIATION), 'T00 · replanning': [rp], 'T00 · progress': [SOK] }, { mode: 'auto' })
  assert.equal(res.status, 'awaiting-ruling'); assert.ok((res.stop_issue.inconsistency || '').includes('T06B')); assert.equal(res.auto_decisions.length, 0)
  assert.ok(!byLabel(calls, 'T00 · progress')[0].prompt.includes('taken automatically'))
  drained('S2', q)
})
await test('S2b: cited task of another phase, known to plan-lint → applied, files checked by the scribe', async () => {
  const rp = { major: true, entries: [], issues: [{ title: 'Next', options: [{ id: 'A', description: 'T07 will reread docs/DEPLOY.md', recommended: true }] }] }
  const pl = { ...plan(T00, T01), all: [{ id: 'T00', phase: 1 }, { id: 'T01', phase: 1 }, { id: 'T07', phase: 2 }], max_phase: 2 }
  const { res, calls, q } = await scenario('S2b', { 'plan-reader': [pl], ...t00(DEVIATION), 'T00 · replanning': [rp], 'T00 · progress': [SOK], ...t01() }, { mode: 'auto' })
  assert.equal(res.auto_decisions.length, 1); assert.equal(res.status, 'finished')
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.ok(sc.includes('test -e') && sc.includes('T07 will reread docs/DEPLOY.md'), 'scribe: check of the files cited by the auto-decision')
  assert.ok(!byLabel(calls, 'T00 · replanning')[0].prompt.includes('Last phase'), 'not the last phase')
  drained('S2b', q)
})
await test('S3: blocked task with a human issue → status needs-human', async () => {
  const { res, calls, q } = await scenario('S3', { 'plan-reader': [plan(T00, T01)], 'T00 · worker': [{ status: 'blocked', summary: 'blocked', branch: 'task/T00', path: '/repo', blocker: 'restore refused' }], 'T00 · replanning': [{ major: true, entries: [], issues: [{ title: 'Real data', human: true, options: [] }] }], 'T00 · progress': [SOK] }, { mode: 'auto' })
  assert.equal(res.tasks[0].status, 'needs-human'); assert.equal(res.status, 'awaiting-ruling')
  assert.ok(byLabel(calls, 'T00 · progress')[0].prompt.includes('status "needs-human"'))
  drained('S3', q)
})
await test('S3b: needs-human task not rerun without a decision', async () => {
  const { res, calls, q } = await scenario('S3b', { 'plan-reader': [plan({ ...T00, status: 'needs-human' }, T01)] })
  assert.equal(res.status, 'partial'); assert.deepEqual(res.waiting, ['T00']); assert.deepEqual(res.not_started, ['T01']); assert.equal(calls.length, 1)
  drained('S3b', q)
})
await test("S3c: rerun on the user's decision", async () => {
  const { res, q } = await scenario('S3c', { 'plan-reader': [plan({ ...T00, status: 'needs-human' }, T01)], ...t00(), 'T00 · progress': [SOK], ...t01() }, { rerun: ['T00'] })
  assert.equal(res.status, 'finished'); assert.deepEqual(res.waiting, [])
  drained('S3c', q)
})
await test('S4: last phase → convergence instruction (tickets)', async () => {
  const { calls, q } = await scenario('S4', { 'plan-reader': [{ ...plan(T00), all: [{ id: 'T00', phase: 1 }], max_phase: 1 }], ...t00(DEVIATION), 'T00 · replanning': [NOTHING], 'T00 · progress': [SOK] })
  const rp = byLabel(calls, 'T00 · replanning')[0].prompt
  assert.ok(rp.includes('last phase of the plan') && rp.includes('"ticket"'))
  drained('S4', q)
})
await test('S5: real data (verifier) and truth of the texts (evaluator)', async () => {
  const { calls, q } = await scenario('S5', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · progress': [SOK] })
  assert.ok(byLabel(calls, 'T00 · verification')[0].prompt.includes('real data, an action reserved'))
  assert.ok(byLabel(calls, 'T00 · evaluation')[0].prompt.includes('tell the truth'))
  drained('S5', q)
})
await test('S6: quality first — evaluator and replanner on opus, verifier and scribe on sonnet', async () => {
  const { calls, q } = await scenario('S6', { 'plan-reader': [plan(T00)], ...t00(DEVIATION), 'T00 · replanning': [NOTHING], 'T00 · progress': [SOK] })
  const m = l => byLabel(calls, l)[0].opts.model
  assert.equal(m('T00 · evaluation'), 'opus'); assert.equal(m('T00 · replanning'), 'opus')
  assert.equal(m('T00 · verification'), 'sonnet'); assert.equal(m('T00 · progress'), 'sonnet'); assert.equal(m('plan-reader'), 'haiku')
  drained('S6', q)
})
// ——— v0.6: plugin (namespaced agents, plan-lint shipped with the plugin) ———
const LP = '/Users/x/.claude/plugins/cache/circle/orchestre/0.6.0/scripts/plan-lint.mjs'
await test('P1: plugin — "orchestre:*" agents by default, plan-lint of the plugin passed by args (reading and scribe)', async () => {
  const { res, calls, q } = await scenario('P1', { 'plan-reader': [plan(T00, T01)], ...t00(DEVIATION), 'T00 · replanning': [RP_E], 'T00 · progress': [SOK], ...t01() }, { mode: 'auto', lint: LP })
  assert.equal(res.status, 'rerun')
  const at = l => byLabel(calls, l)[0].opts.agentType
  assert.equal(at('plan-reader'), 'orchestre:plan-reader'); assert.equal(at('T00 · worker'), 'orchestre:worker'); assert.equal(at('T00 · verification'), 'orchestre:verifier')
  assert.equal(at('T00 · evaluation'), 'orchestre:evaluator'); assert.equal(at('T00 · merge'), 'orchestre:integrator'); assert.equal(at('T00 · replanning'), 'orchestre:replanner'); assert.equal(at('T00 · progress'), 'orchestre:scribe')
  assert.ok(byLabel(calls, 'plan-reader')[0].prompt.includes(`node ${LP} plans/p --json --phase 1 --integration plan/p`), 'reading: plan-lint of the plugin')
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.ok(sc.includes(`node ${LP} plans/p --integration plan/p`) && !sc.includes('.claude/orchestre/') && !sc.includes(ARGS.lint), 'scribe: plan-lint of the plugin')
  drained('P1', q)
})
await test('P2: manual install — empty agent_prefix gives unprefixed agent types; without lint (required since 0.12.0), an error and no agent', async () => {
  const { calls, q } = await scenario('P2', { 'plan-reader': [plan(T00)], 'T00 · worker': [report(0)], 'T00 · verification': [ok(1)], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [MOK], 'T00 · progress': [SOK] }, { agent_prefix: '', parallelism: 1 })
  assert.equal(byLabel(calls, 'plan-reader')[0].opts.agentType, 'plan-reader'); assert.equal(byLabel(calls, 'T00 · worker')[0].opts.agentType, 'worker')
  assert.ok(byLabel(calls, 'plan-reader')[0].prompt.includes('node /plug/scripts/plan-lint.mjs plans/p --json'))
  drained('P2', q)
  const b = await scenario('P2b', {}, { agent_prefix: '', lint: undefined })
  assert.deepEqual(b.res, { status: 'error', detail: 'args required: plan, phase, integration, lint' }); assert.equal(b.calls.length, 0)
})
await test('P3: plan-lint path with a space → quoted; parallel tasks → orchestre:isolated-worker', async () => {
  const L = '/Users/x y/.claude/plugins/cache/circle/orchestre/0.6.0/scripts/plan-lint.mjs'
  const T02 = { ...T00, id: 'T02', title: 'Other', file: 'plans/p/tasks/T02.md', resources: [] }
  const T03 = { ...T00, id: 'T03', title: 'Again', file: 'plans/p/tasks/T03.md', resources: [] }
  const tt = id => ({ [`${id} · worker`]: [report(id, { branch: `task/${id}`, path: `/wt/${id}` })], [`${id} · verification`]: [ok(id)], [`${id} · evaluation`]: [{ verdict: 'pass' }], [`${id} · merge`]: [MOK], [`${id} · progress`]: [SOK] })
  const { res, calls, q } = await scenario('P3', { 'plan-reader': [plan(T02, T03)], ...tt('T02'), ...tt('T03') }, { lint: L })
  assert.equal(res.status, 'finished')
  assert.ok(byLabel(calls, 'plan-reader')[0].prompt.includes(`node "${L}" plans/p --json`))
  assert.equal(byLabel(calls, 'T02 · worker')[0].opts.agentType, 'orchestre:isolated-worker'); assert.equal(byLabel(calls, 'T02 · worker')[0].opts.isolation, 'worktree')
  drained('P3', q)
})
// ——— v0.6: fixes from the review ———
await test('Q1: unknown mode → error, no agent launched', async () => {
  const { res, calls } = await scenario('Q1', {}, { mode: 'deviations' })
  assert.equal(res.status, 'error'); assert.ok(res.detail.includes('auto, deviation or phase')); assert.equal(calls.length, 0)
})
await test('Q2: base branch passed to plan-lint (reading and scribe)', async () => {
  const { calls, q } = await scenario('Q2', { 'plan-reader': [plan(T00, T01)], ...t00(DEVIATION), 'T00 · replanning': [RP_E], 'T00 · progress': [SOK], ...t01() }, { mode: 'auto', base: 'develop' })
  assert.ok(byLabel(calls, 'plan-reader')[0].prompt.includes('--integration plan/p --base develop'))
  assert.ok(byLabel(calls, 'T00 · progress')[0].prompt.includes('--integration plan/p --base develop'))
  drained('Q2', q)
})
await test('Q3: ruling whose amendment targets a task merged in the meantime → discarded, the run goes on', async () => {
  const { res, calls, q } = await scenario('Q3', { 'ruling T02 · progress': [{ ok: true, commit: 'x', rejected: [], discarded: [{ id: 'T01', reason: 'merged' }] }], 'plan-reader': [plan(T00)], ...t00(), 'T00 · progress': [SOK] }, { rulings: RULING })
  assert.equal(res.status, 'finished'); assert.deepEqual(res.discarded_amendments, [{ task: 'T02', id: 'T01', reason: 'merged' }])
  const sc = byLabel(calls, 'ruling T02 · progress')[0].prompt
  assert.ok(sc.includes('return it in "discarded", not in "rejected"') && sc.includes('amendment not applied'))
  assert.ok(byLabel(calls, 'ruling T02 · progress')[0].opts.schema.properties.discarded, 'scribe: discarded in the schema')
  drained('Q3', q)
})
await test('Q4: autonomous, amendment of a task of another phase already merged → discarded, not sent to the scribe', async () => {
  const rp = { major: true, entries: [], issues: [{ title: 'W', options: [{ id: 'A', description: 'a', recommended: true, amendments: [{ id: 'T09', verification: ['z'], reason: 'r9' }] }] }] }
  const T00b = { ...T00, phase: 2 }
  const { res, calls, q } = await scenario('Q4', { 'plan-reader': [{ ...plan(T00b), all: [{ id: 'T09', phase: 1, status: 'merged' }, { id: 'T00', phase: 2, status: 'todo' }], max_phase: 2 }], ...t00(DEVIATION), 'T00 · replanning': [rp], 'T00 · progress': [SOK] }, { mode: 'auto', phase: 2 })
  assert.equal(res.status, 'finished'); assert.deepEqual(res.discarded_amendments.map(a => [a.task, a.id]), [['T00', 'T09']])
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.ok(!sc.includes('Amendments, for tasks not yet started') && sc.includes('amendment not applied'))
  drained('Q4', q)
})
await test('Q5: branch taken back — single rule, exact branch returned, in the main checkout as in a worktree', async () => {
  const { calls, q } = await scenario('Q5', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · progress': [SOK] })
  const w = byLabel(calls, 'T00 · worker')[0].prompt
  for (const x of ['git switch -c task/T00', 'for-each-ref', "refs/heads/task/T00-r*", 'git worktree list', 'task/T00-r<n>', 'return its exact name in "branch"', 'main checkout'])
    assert.ok(w.includes(x), 'worker: ' + x)
  assert.ok(!w.includes('Commit all your work on task/T00.'), 'worker: no imposed branch any more')
  drained('Q5', q)
})
await test('Q6: parallelism of 1 → never a worktree, even between independent tasks', async () => {
  const T02 = { ...T00, id: 'T02', file: 'plans/p/tasks/T02.md', resources: [] }, T03 = { ...T00, id: 'T03', file: 'plans/p/tasks/T03.md', resources: [] }
  const tt = id => ({ [`${id} · worker`]: [report(id, { branch: `task/${id}` })], [`${id} · verification`]: [ok(id)], [`${id} · evaluation`]: [{ verdict: 'pass' }], [`${id} · merge`]: [MOK], [`${id} · progress`]: [SOK] })
  const { res, calls, q } = await scenario('Q6', { 'plan-reader': [plan(T02, T03)], ...tt('T02'), ...tt('T03') }, { parallelism: 1 })
  assert.equal(res.status, 'finished')
  for (const id of ['T02', 'T03']) { const o = byLabel(calls, `${id} · worker`)[0].opts; assert.equal(o.agentType, 'orchestre:worker'); assert.equal(o.isolation, undefined) }
  drained('Q6', q)
})
await test('Q7: exception during a task → failed with the reason in "blocker"', async () => {
  const { res, q } = await scenario('Q7', { 'plan-reader': [plan(T00)], 'T00 · worker': [() => { throw new Error('boom') }] })
  assert.equal(res.status, 'partial'); const t = res.tasks.find(x => x.id === 'T00')
  assert.equal(t.status, 'failed'); assert.deepEqual(t.blocker, ['workflow error: Error: boom'])
  drained('Q7', q)
})
// ——— v0.6.1: prerequisites (PREREQUISITES.md) ———
await test('R1: open prerequisite → the task waits, the one that depends on it too; no agent launched', async () => {
  const { res, calls, q } = await scenario('R1', { 'plan-reader': [plan({ ...T00, open_prerequisites: ['D5'] }, T01)] })
  assert.equal(res.status, 'partial'); assert.deepEqual(res.waiting_on_prerequisites, [{ id: 'T00', prerequisites: ['D5'] }])
  assert.deepEqual(res.not_started, ['T01']); assert.deepEqual(res.waiting, []); assert.equal(calls.length, 1)
  const ts = byLabel(calls, 'plan-reader')[0].opts.schema.properties.tasks.items
  assert.ok(ts.properties.open_prerequisites && ts.required.includes('open_prerequisites'), 'plan-reader: schema, required field')
  drained('R1', q)
})
await test('R2: the rest of the phase runs while a task waits for its prerequisite', async () => {
  const T02 = { ...T00, id: 'T02', file: 'plans/p/tasks/T02.md', resources: [], open_prerequisites: ['H1'] }, T03 = { ...T00, id: 'T03', file: 'plans/p/tasks/T03.md', resources: [] }
  const { res, q } = await scenario('R2', { 'plan-reader': [plan(T02, T03)], 'T03 · worker': [report(3, { branch: 'task/T03' })], 'T03 · verification': [ok(3)], 'T03 · evaluation': [{ verdict: 'pass' }], 'T03 · merge': [MOK], 'T03 · progress': [SOK] })
  assert.equal(res.status, 'partial'); assert.deepEqual(res.tasks.map(t => [t.id, t.status]), [['T03', 'merged']])
  assert.deepEqual(res.waiting_on_prerequisites, [{ id: 'T02', prerequisites: ['H1'] }])
  drained('R2', q)
})
await test('R3: a "needs-human" task that is rerun still waits for its open prerequisite', async () => {
  const { res, calls, q } = await scenario('R3', { 'plan-reader': [plan({ ...T00, status: 'needs-human', open_prerequisites: ['D6'] })] }, { rerun: ['T00'] })
  assert.equal(res.status, 'partial'); assert.deepEqual(res.waiting, []); assert.deepEqual(res.waiting_on_prerequisites, [{ id: 'T00', prerequisites: ['D6'] }]); assert.equal(calls.length, 1)
  drained('R3', q)
})
await test('R4: prerequisites done (empty list) → the task starts normally', async () => {
  const { res, q } = await scenario('R4', { 'plan-reader': [plan({ ...T00, open_prerequisites: [] })], ...t00(), 'T00 · progress': [SOK] })
  assert.equal(res.status, 'finished'); assert.deepEqual(res.waiting_on_prerequisites, [])
  drained('R4', q)
})
await test('R5: the replanner reads PREREQUISITES.md; an issue about an open prerequisite is human; an added task cites its prerequisites', async () => {
  const { calls, q } = await scenario('R5', { 'plan-reader': [plan(T00)], ...t00(DEVIATION), 'T00 · replanning': [NOTHING], 'T00 · progress': [SOK] })
  const rp = byLabel(calls, 'T00 · replanning')[0].prompt
  for (const x of ['plans/p/PREREQUISITES.md', 'an issue about an open prerequisite of PREREQUISITES.md', 'cites in "prerequisites"']) assert.ok(rp.includes(x), 'replan: ' + x)
  drained('R5', q)
})
// ——— v0.6.2: files forbidden to the agents → reviews before the PR, without a stop ———
await test('U1: evaluator passes with an unreadable file → "review" entry, no replanning and no stop', async () => {
  const { res, calls, q } = await scenario('U1', { 'plan-reader': [plan(T00)], 'T00 · worker': [report(0)], 'T00 · verification': [ok(1)], 'T00 · evaluation': [{ verdict: 'pass', unreadable: ['agents/x/.env.example'] }], 'T00 · merge': [MOK], 'T00 · progress': [SOK] })
  assert.equal(res.status, 'finished'); assert.equal(idx(calls, 'T00 · replanning'), -1)
  assert.deepEqual(res.reviews, [{ task: 'T00', review: 'agents/x/.env.example: unreadable by the agents, to review by the human before the PR' }])
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.ok(sc.includes('"type":"review"') && sc.includes('agents/x/.env.example'), 'scribe: review entry')
  const ev = byLabel(calls, 'T00 · evaluation')[0]
  assert.ok(ev.prompt.includes('"unreadable"') && ev.prompt.includes('never get around') && ev.opts.schema.properties.unreadable, 'evaluator: instruction and schema')
  assert.ok(byLabel(calls, 'T00 · worker')[0].prompt.includes('deviation of type "review"'), 'worker: instruction')
  assert.ok(byLabel(calls, 'T00 · worker')[0].opts.schema.properties.deviations.items.properties.type.enum.includes('review'), 'worker: review type in the schema')
  drained('U1', q)
})
await test('U2: "review" deviation that cites a .env → neither a sensitive deviation, nor an issue, nor a stop', async () => {
  const REV = [{ type: 'review', description: 'add MR_REVIEW_MODEL_MAX_ATTEMPTS to agents/mr_review/.env.example (file forbidden to the agents)' }]
  const { res, calls, q } = await scenario('U2', { 'plan-reader': [plan(T00, T01)], ...t00(REV), 'T00 · progress': [SOK], ...t01() }, { mode: 'deviation' })
  assert.equal(res.status, 'finished'); assert.equal(idx(calls, 'T00 · replanning'), -1)
  assert.equal(res.reviews.length, 1); assert.ok(byLabel(calls, 'T00 · progress')[0].prompt.includes('MR_REVIEW_MODEL_MAX_ATTEMPTS'))
  drained('U2', q)
})
await test('U3: ordinary deviation + review → the replanner only sees the ordinary deviation, without a sensitive deviation', async () => {
  const MIX = [{ type: 'review', description: 'reread .env.example' }, ...DEVIATION]
  const { res, calls, q } = await scenario('U3', { 'plan-reader': [plan(T00)], ...t00(MIX), 'T00 · replanning': [NOTHING], 'T00 · progress': [SOK] })
  const rp = byLabel(calls, 'T00 · replanning')[0].prompt
  assert.ok(rp.includes('isSuperAdmin') && !rp.includes('reread .env.example') && !rp.includes('Sensitive deviations'), 'replan: deviations filtered')
  assert.ok(rp.includes('is never an issue nor an entry: return it in "reviews"') && byLabel(calls, 'T00 · replanning')[0].opts.schema.properties.reviews, 'replan: instruction and schema')
  assert.equal(res.status, 'finished'); assert.equal(res.reviews.length, 1)
  drained('U3', q)
})
await test('U4: deviations of the first attempt kept after a fix that does not repeat them; findings handed to the fix', async () => {
  const REV = [{ type: 'review', description: 'add X to agents/x/.env.example' }, ...DEVIATION]
  const { res, calls, q } = await scenario('U4', { 'plan-reader': [plan(T00)], 'T00 · worker': [report(0, { deviations: REV })], 'T00 · verification': [ok(1), ok(2)],
    'T00 · evaluation': [{ verdict: 'fail', gaps: ['M1'] }, { verdict: 'pass' }], 'T00 · fix 1': [report(1, { deviations: [...DEVIATION] })], 'T00 · merge': [MOK], 'T00 · replanning': [NOTHING], 'T00 · progress': [SOK] })
  assert.equal(res.status, 'finished'); assert.equal(res.reviews.length, 1)
  const fx = byLabel(calls, 'T00 · fix 1')[0]
  assert.ok(fx.prompt.includes('Deviations already reported') && fx.prompt.includes('isSuperAdmin'), 'fix: earlier deviations')
  assert.ok(fx.prompt.includes('routes prewarmed 0') && fx.prompt.includes('updated list'), 'fix: earlier findings')
  assert.ok(fx.opts.schema.properties.deviations.items.properties.type.enum.includes('review'), 'fix: review type in the schema')
  assert.ok(byLabel(calls, 'T00 · evaluation')[1].prompt.includes('isSuperAdmin'), 'evaluation 2: deviations accumulated')
  const rp = byLabel(calls, 'T00 · replanning')[0].prompt
  assert.ok(rp.includes('isSuperAdmin') && !rp.includes('agents/x/.env.example'), 'replan: deviation of the first attempt, without the review')
  assert.equal(rp.split('isSuperAdmin optional').length - 1, 1, 'replan: deviation repeated only once')
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.ok(sc.includes('routes prewarmed 1') && !sc.includes('routes prewarmed 0'), 'scribe: findings of the fix, which returned the updated list')
  drained('U4', q)
})
await test('U5: file unreadable at the first evaluation only → review kept', async () => {
  const { res, calls, q } = await scenario('U5', { 'plan-reader': [plan(T00)], 'T00 · worker': [report(0)], 'T00 · verification': [ok(1), ok(2)],
    'T00 · evaluation': [{ verdict: 'fail', gaps: ['M1'], unreadable: ['a/.env.example'] }, { verdict: 'pass' }], 'T00 · fix 1': [report(1)], 'T00 · merge': [MOK], 'T00 · progress': [SOK] })
  assert.equal(res.status, 'finished'); assert.equal(idx(calls, 'T00 · replanning'), -1)
  assert.deepEqual(res.reviews.map(x => x.review), ['a/.env.example: unreadable by the agents, to review by the human before the PR'])
  drained('U5', q)
})
await test('U6: fix without an answer → failed with the report of the first attempt (deviations, review, branch)', async () => {
  const REV = [{ type: 'review', description: 'add X to agents/x/.env.example' }, ...DEVIATION]
  const { res, calls, q } = await scenario('U6', { 'plan-reader': [plan(T00, T01)], 'T00 · worker': [report(0, { deviations: REV })], 'T00 · verification': [ok(1)],
    'T00 · evaluation': [{ verdict: 'fail', gaps: ['M1'] }], 'T00 · fix 1': [null], 'T00 · replanning': [NOTHING], 'T00 · progress': [SOK] })
  const t = res.tasks.find(x => x.id === 'T00')
  assert.equal(t.status, 'failed'); assert.equal(t.branch, 'task/T00'); assert.equal(t.attempts, 2)
  assert.ok(t.blocker[0].includes('fix without an answer'))
  assert.ok(byLabel(calls, 'T00 · replanning')[0].prompt.includes('isSuperAdmin'), 'replan: deviation of the first attempt')
  assert.deepEqual(t.reviews, ['add X to agents/x/.env.example'])
  assert.ok(byLabel(calls, 'T00 · progress')[0].prompt.includes('branch task/T00'), 'scribe: branch kept')
  assert.ok(res.not_started.includes('T01'))
  drained('U6', q)
})
await test('U7: verification command refused by the permissions → neither a failure nor a fix; review; post-merge check on the next one', async () => {
  const FORBID = 'grep -q MR_MAX agents/x/.env.example'
  const T = { ...T00, verification: [FORBID, 'sh scripts/e2e-local.sh'] }
  const V = { ok: true, results: [{ command: 'sh scripts/e2e-local.sh', code: 0, excerpt: '96 passed' }], forbidden: ['cd "/repo" && ' + FORBID + ' ; echo "code=$?"'] }
  const { res, calls, q } = await scenario('U7', { 'plan-reader': [plan(T)], 'T00 · worker': [report(0)], 'T00 · verification': [V], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [MOK], 'T00 · progress': [SOK] })
  assert.equal(res.status, 'finished'); assert.equal(idx(calls, 'T00 · fix 1'), -1); assert.equal(idx(calls, 'T00 · replanning'), -1)
  const ve = byLabel(calls, 'T00 · verification')[0]
  assert.ok(ve.prompt.includes('"forbidden"') && ve.prompt.includes('never get around it') && ve.opts.schema.properties.forbidden, 'verifier: instruction and schema')
  assert.ok(byLabel(calls, 'T00 · evaluation')[0].prompt.includes(FORBID), 'evaluator: refused command reported')
  const mg = byLabel(calls, 'T00 · merge')[0].prompt
  assert.ok(mg.includes('check command, without a pipe (add `; echo "code=$?"`): sh scripts/e2e-local.sh'), 'check: first allowed command')
  assert.deepEqual(res.reviews.map(x => x.review), ["command `" + FORBID + "` refused to the agents: to run by the human before the PR"])
  drained('U7', q)
})
await test('U8: ban reported as an ordinary deviation → reclassified as a review by the replanner, without a stop; not if the deviation also concerns prod', async () => {
  const D = 'read of agents/x/.env.example refused: variable MR_MAX not added'
  const RP = { major: false, entries: [], issues: [], reviews: [{ deviation: D, review: 'agents/x/.env.example: add MR_MAX' }] }
  const { res, calls, q } = await scenario('U8', { 'plan-reader': [plan(T00, T01)], ...t00([{ type: 'deviation', description: D }]), 'T00 · replanning': [RP], 'T00 · progress': [SOK], ...t01() }, { mode: 'deviation' })
  assert.equal(res.status, 'finished'); assert.deepEqual(res.reviews.map(x => x.review), ['agents/x/.env.example: add MR_MAX'])
  const rp = byLabel(calls, 'T00 · replanning')[0].prompt
  assert.ok(rp.includes('Sensitive deviations') && rp.includes('except for a deviation that only concerns a file forbidden to the agents'), 'replan: exception to the sensitive deviations')
  drained('U8', q)
  const D2 = 'read of agents/x/.env.example refused; the script also reads the prod database'
  const RP2 = { major: false, entries: [], issues: [], reviews: [{ deviation: D2, review: 'agents/x/.env.example: reread' }] }
  const b = await scenario('U8b', { 'plan-reader': [plan(T00, T01)], ...t00([{ type: 'deviation', description: D2 }]), 'T00 · replanning': [RP2], 'T00 · progress': [SOK] }, { mode: 'deviation' })
  assert.equal(b.res.status, 'awaiting-ruling'); assert.ok(b.res.stop_issue.human && b.res.stop_issue.title.includes('Sensitive deviation'), 'reclassification refused: prod stays sensitive')
  assert.equal(b.res.reviews.length, 1)
  drained('U8b', b.q)
})
await test('U9: same file cited by the worker, the evaluator and the replanner → a single review', async () => {
  const R0 = 'add X to agents/x/.env.example'
  const RP = { major: false, entries: [{ type: 'review', severity: 'major', description: R0 }], issues: [], reviews: [{ review: R0 }] }
  const { res, calls, q } = await scenario('U9', { 'plan-reader': [plan(T00)], 'T00 · worker': [report(0, { deviations: [{ type: 'review', description: R0 }, ...DEVIATION] })], 'T00 · verification': [ok(1)],
    'T00 · evaluation': [{ verdict: 'pass', unreadable: ['agents/x/.env.example'] }], 'T00 · merge': [MOK], 'T00 · replanning': [RP], 'T00 · progress': [SOK] })
  assert.deepEqual(res.reviews.map(x => x.review), [R0])
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.equal(sc.split(R0).length - 1, 1, 'scribe: a single entry')
  drained('U9', q)
})
await test('U7b: all the verification commands refused → blocked without a fix or a merge', async () => {
  const FORBID = 'grep -q MR_MAX agents/x/.env.example'
  const T = { ...T00, verification: [FORBID] }
  const { res, calls, q } = await scenario('U7b', { 'plan-reader': [plan(T, T01)], 'T00 · worker': [report(0)], 'T00 · verification': [{ ok: true, results: [], forbidden: [FORBID] }], 'T00 · replanning': [NOTHING], 'T00 · progress': [SOK] })
  const t = res.tasks.find(x => x.id === 'T00')
  assert.equal(t.status, 'blocked'); assert.ok(t.blocker[0].includes('no verification command allowed'))
  for (const l of ['T00 · evaluation', 'T00 · fix 1', 'T00 · merge']) assert.equal(idx(calls, l), -1, l)
  assert.equal(t.reviews.length, 1); assert.ok(res.not_started.includes('T01'))
  drained('U7b', q)
})
await test('U7c: "forbidden" command that is not a command of the task → failure, fix', async () => {
  const { res, calls, q } = await scenario('U7c', { 'plan-reader': [plan(T00)], 'T00 · worker': [report(0)], 'T00 · verification': [{ ...ok(1), forbidden: ['cat secrets/x'] }, ok(2)],
    'T00 · fix 1': [report(1)], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [MOK], 'T00 · progress': [SOK] })
  assert.equal(res.status, 'finished'); assert.equal(res.tasks[0].attempts, 2)
  assert.ok(byLabel(calls, 'T00 · fix 1')[0].prompt.includes('cat secrets/x: refused according to the verifier'))
  assert.equal(res.reviews.length, 0)
  drained('U7c', q)
})
await test('U8c: reclassification of a deviation that also concerns prod → human stop, even with another issue', async () => {
  const D = 'read of agents/x/.env.example refused; the script also reads the prod database'
  const PT = { title: 'Contract', context: '', options: [{ id: 'A', description: 'keep', recommended: true }, { id: 'B', description: 'change' }] }
  const RP = { major: true, entries: [], issues: [PT], reviews: [{ deviation: D, review: 'agents/x/.env.example: reread' }] }
  const { res, q } = await scenario('U8c', { 'plan-reader': [plan(T00, T01)], ...t00([{ type: 'deviation', description: D }, ...DEVIATION]), 'T00 · replanning': [RP], 'T00 · progress': [SOK] }, { mode: 'auto' })
  assert.equal(res.status, 'awaiting-ruling'); assert.ok(res.stop_issue.human && res.stop_issue.title.includes('reclassified as a review'))
  drained('U8c', q)
})
await test('U9b: .env.example of the root unreadable, review of another .env.example → two reviews', async () => {
  const R0 = 'agents/x/.env.example: add MR_MAX'
  const { res, q } = await scenario('U9b', { 'plan-reader': [plan(T00)], 'T00 · worker': [report(0, { deviations: [{ type: 'review', description: R0 }] })], 'T00 · verification': [ok(1)],
    'T00 · evaluation': [{ verdict: 'pass', unreadable: ['.env.example'] }], 'T00 · merge': [MOK], 'T00 · progress': [SOK] })
  assert.deepEqual(res.reviews.map(x => x.review), [R0, '.env.example: unreadable by the agents, to review by the human before the PR'])
  drained('U9b', q)
})
await test('U4b: fix that returns no findings → those of the earlier attempt stay', async () => {
  const C = { status: 'done', summary: 'fixed', branch: 'task/T00', commit: 'c1', path: '/repo' }
  const { calls, q } = await scenario('U4b', { 'plan-reader': [plan(T00)], 'T00 · worker': [report(0)], 'T00 · verification': [ok(1), ok(2)],
    'T00 · evaluation': [{ verdict: 'fail', gaps: ['M1'] }, { verdict: 'pass' }], 'T00 · fix 1': [C], 'T00 · merge': [MOK], 'T00 · progress': [SOK] })
  assert.ok(byLabel(calls, 'T00 · progress')[0].prompt.includes('routes prewarmed 0'))
  drained('U4b', q)
})
await test('U7d: two commands that only differ by their leading cd → only the refused one is forbidden', async () => {
  const A = 'cd api && pnpm test', W = 'cd web && pnpm test'
  const T = { ...T00, verification: [A, W] }
  const V = { ok: true, results: [{ command: W, code: 0, excerpt: 'ok' }], forbidden: ['cd "/repo" && ' + A + ' ; echo "code=$?"'] }
  const { res, calls, q } = await scenario('U7d', { 'plan-reader': [plan(T)], 'T00 · worker': [report(0)], 'T00 · verification': [V], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [MOK], 'T00 · progress': [SOK] })
  assert.equal(res.status, 'finished')
  assert.deepEqual(res.reviews.map(x => x.review), ["command `" + A + "` refused to the agents: to run by the human before the PR"])
  assert.ok(byLabel(calls, 'T00 · merge')[0].prompt.includes(': ' + W + '.'), 'check: the web command')
  drained('U7d', q)
})
// ——— 0.8.0: progress.json by scripts/progress.mjs, which the agents run on instruction ———
const PROG = '/plug/scripts/progress.mjs'
const AP = { progress: PROG }
const withProgress = x => ({ ...x, progress_ok: true })
const planOpened = (...ts) => ({ ...plan(...ts), run_start_ok: true })
const COK = { progress_ok: true, commit: 'g1', detail: '' }
// Progress commands of an instruction: between backticks, JSON object in single quotes (neither ' nor ` inside)
const progressCommands = prompt => [...prompt.matchAll(/`(node "?[^`"]*progress\.mjs"? [^`]*)`/g)].map(m => m[1])
const parse = c => { const m = c.match(/progress\.mjs"? (\S+) (\S+) --json '([^']*)'$/); assert.ok(m, 'malformed progress command: ' + c); return { cmd: m[1], plan: m[2], E: JSON.parse(m[3]) } }
const progressOf = (calls, label, i = 0) => progressCommands(byLabel(calls, label)[i].prompt).map(parse)
const HEADER = 'Plan progress: your first command, before any other'
const s00 = (extra = {}) => ({ 'T00 · worker': [withProgress(report(0))], 'T00 · verification': [withProgress(ok(1))], 'T00 · evaluation': [withProgress({ verdict: 'pass' })], 'T00 · merge': [withProgress(MOK)], 'T00 · progress': [withProgress(SOK)], ...extra })
const s01 = () => ({ 'T01 · worker': [withProgress(report(1, { branch: 'task/T01' }))], 'T01 · verification': [withProgress(ok(2))], 'T01 · evaluation': [withProgress({ verdict: 'pass' })], 'T01 · merge': [withProgress(MOK)], 'T01 · progress': [withProgress(SOK)] })
const ISSUE_E = { task: 'T00', title: 'UpdateUserSchema contract', context: 'isSuperAdmin optional', human: false, options: [{ id: 'A', description: 'Keep optional and test rule (d)', impact: 'one more test', recommended: true }, { id: 'B', description: 'Make the field required', impact: 'breaks partial calls', recommended: false }] }

await test('V1: progress — the plan reader opens the run, each agent first runs its step, the scribe closes before its commit, the clerk closes the run', async () => {
  const { res, calls, q } = await scenario('V1', { 'plan-reader': [planOpened(T00)], ...s00(), 'run end · progress': [COK] }, AP)
  assert.equal(res.status, 'finished'); assert.deepEqual(res.progress_failures, [])
  const lp = byLabel(calls, 'plan-reader')[0].prompt
  assert.ok(lp.startsWith(HEADER + ', opens the run'))
  assert.deepEqual(progressOf(calls, 'plan-reader'), [{ cmd: 'run-start', plan: 'plans/p', E: { phase: 1, mode: 'phase', parallelism: 4, max_fixes: 2, max_auto_decisions: 3 } }])
  assert.ok(lp.includes('plan-lint.mjs plans/p --json --phase 1') && lp.includes('with run_start_ok'))
  for (const [l, E] of [['T00 · worker', { task: 'T00', step: 'worker', isolated: false, model: 'sonnet' }], ['T00 · verification', { task: 'T00', step: 'verification' }], ['T00 · evaluation', { task: 'T00', step: 'evaluation' }], ['T00 · merge', { task: 'T00', step: 'merge' }]]) {
    assert.ok(byLabel(calls, l)[0].prompt.startsWith(HEADER), l + ': step first')
    assert.deepEqual(progressOf(calls, l), [{ cmd: 'step', plan: 'plans/p', E }], l)
  }
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.deepEqual(progressOf(calls, 'T00 · progress'), [{ cmd: 'step', plan: 'plans/p', E: { task: 'T00', step: 'progress' } }, { cmd: 'close', plan: 'plans/p', E: { task: 'T00', status: 'merged', attempts: 1, branch: 'task/T00' } }])
  assert.ok(!sc.includes('- PROGRESS.md: row') && sc.includes('never touch it yourself') && sc.includes('commit PROGRESS.md, HANDOFF.md and DISCOVERY.md'))
  assert.ok(sc.indexOf('progress.mjs close') > sc.indexOf('DISCOVERY.md: integrate'), 'close written after the rest')
  const clerk = byLabel(calls, 'run end · progress')
  assert.equal(clerk.length, 1); assert.equal(idx(calls, 'run end · progress'), calls.length - 1, 'the clerk comes last')
  assert.deepEqual([clerk[0].opts.agentType, clerk[0].opts.model, clerk[0].opts.schema.required], ['orchestre:clerk', 'haiku', ['progress_ok']])
  const [re] = progressOf(calls, 'run end · progress')
  assert.deepEqual([re.cmd, re.E.status, re.E.not_started, re.E.open_issues], ['run-end', 'finished', [], []])
  assert.deepEqual(re.E.tasks, [{ id: 'T00', status: 'merged', attempts: 1, branch: 'task/T00' }], 'summary without the workers\' summaries')
  for (const x of ['1. `git switch plan/p`', '`git diff --quiet HEAD -- plans/p/PROGRESS.md`', '`git commit -m "progress: end of the run of phase 1" -- plans/p/PROGRESS.md`']) assert.ok(clerk[0].prompt.includes(x), 'clerk: ' + x)
  assert.ok(!clerk[0].prompt.includes('git add'), 'the clerk only commits PROGRESS.md')
  assert.deepEqual([byLabel(calls, 'plan-reader')[0].opts.schema.required, byLabel(calls, 'T00 · progress')[0].opts.schema.required, byLabel(calls, 'T00 · worker')[0].opts.schema.required], [['ok', 'tasks', 'run_start_ok'], ['ok', 'progress_ok'], ['status', 'summary', 'branch', 'path']], 'result required only where it decides what follows')
  drained('V1', q)
})
await test('V2: progress — fix and its rejection, escaped text; full close in autonomous mode (auto-decision, added task, amendment, replanning)', async () => {
  const M = "the option's `--force` costs $5", LONG = 'npm test: 2 failures\n  at a.test.ts:12\n' + 'x'.repeat(400)
  const { res, calls, q } = await scenario('V2', {
    'plan-reader': [planOpened(T00, T01)], 'T00 · worker': [withProgress(report(0, { deviations: DEVIATION }))], 'T00 · verification': [withProgress(ok(1)), withProgress(ok(2))],
    'T00 · evaluation': [withProgress({ verdict: 'fail', gaps: [M, LONG] }), withProgress({ verdict: 'pass' })], 'T00 · fix 1': [withProgress(report(1))],
    'T00 · merge': [withProgress(MOK)], 'T00 · replanning': [RP_E], 'T00 · progress': [withProgress(SOK)], ...s01(), 'run end · progress': [COK] }, { ...AP, mode: 'auto' })
  const LONG1 = 'npm test: 2 failures at a.test.ts:12 ' + 'x'.repeat(202) + '…'
  assert.equal(LONG1.length, 240)
  assert.equal(res.status, 'rerun'); assert.deepEqual(res.progress_failures, [])
  const fix = byLabel(calls, 'T00 · fix 1')[0].prompt
  assert.deepEqual(progressOf(calls, 'T00 · fix 1'), [{ cmd: 'step', plan: 'plans/p', E: { task: 'T00', step: 'fix', rejection: { attempt: 1, by: 'evaluation', gaps: [M, LONG1] }, model: 'sonnet' } }], 'long text on one line and cut')
  assert.ok(fix.includes(LONG), 'the fix worker gets the whole gap')
  assert.ok(progressCommands(fix).every(c => !c.includes('\n')), 'command on one line')
  assert.ok(fix.includes('the option\\u0027s \\u0060--force\\u0060 costs \\u00245'), 'apostrophe, backtick and dollar escaped')
  const D = { task: 'T00', title: 'UpdateUserSchema contract', option: 'A', description: 'Keep optional and test rule (d)' }
  assert.deepEqual(progressOf(calls, 'T00 · progress')[1].E, {
    task: 'T00', status: 'merged', attempts: 2, branch: 'task/T00', rejections: [{ attempt: 1, by: 'evaluation', gaps: [M, LONG1] }], auto_decisions: [D],
    added_tasks: [{ id: 'T00C', title: 'Rule d test', phase: 1 }], amendments: [{ id: 'T01', reason: 'security rule without a test' }], replanning: true })
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.ok(sc.includes('do not touch PROGRESS.md: the progress command below adds their row') && sc.includes('remove its file).') && !sc.includes('its row of PROGRESS.md'))
  assert.ok(sc.indexOf('progress.mjs close') > sc.indexOf('plan-lint.mjs plans/p --integration'), 'close after plan-lint')
  assert.ok(sc.includes(JSON.stringify(LONG).slice(1, -1)), 'HANDOFF gets the whole rejection')
  assert.deepEqual(progressOf(calls, 'T01 · progress')[1].E, { task: 'T01', status: 'merged', attempts: 1, branch: 'task/T01' }, 'nothing of T00 in the close of T01')
  const re = progressOf(calls, 'run end · progress')[0].E
  assert.deepEqual([re.status, re.auto_decisions, re.added_tasks], ['rerun', [D], [{ id: 'T00C', phase: 1, title: 'Rule d test', added_by: 'T00' }]])
  assert.deepEqual(res.added_tasks, [{ id: 'T00C', phase: 1, title: 'Rule d test' }], 'summary of the pilot unchanged')
  drained('V2', q)
})
await test('V3: progress — parallel tasks → worker step with isolated=true; script path with a space quoted', async () => {
  const T02 = { ...T00, id: 'T02', title: 'Other', file: 'plans/p/tasks/T02.md', resources: [] }
  const T03 = { ...T00, id: 'T03', title: 'Again', file: 'plans/p/tasks/T03.md', resources: [] }
  const tt = id => ({ [`${id} · worker`]: [withProgress(report(id, { branch: `task/${id}`, path: `/wt/${id}` }))], [`${id} · verification`]: [withProgress(ok(id))], [`${id} · evaluation`]: [withProgress({ verdict: 'pass' })], [`${id} · merge`]: [withProgress(MOK)], [`${id} · progress`]: [withProgress(SOK)] })
  const PROG_SPACE = '/Users/x y/.claude/plugins/cache/circle/orchestre/0.8.0/scripts/progress.mjs'
  // Args values as strings or negative: integers valid for the progress schema
  const { res, calls, q } = await scenario('V3', { 'plan-reader': [planOpened(T02, T03)], ...tt('T02'), ...tt('T03'), 'run end · progress': [COK] }, { progress: PROG_SPACE, max_fixes: '2', max_auto_decisions: -1 })
  assert.equal(res.status, 'finished')
  assert.deepEqual(progressOf(calls, 'plan-reader')[0].E, { phase: 1, mode: 'phase', parallelism: 4, max_fixes: 2, max_auto_decisions: 0 })
  for (const id of ['T02', 'T03']) assert.deepEqual(progressOf(calls, `${id} · worker`)[0].E, { task: id, step: 'worker', isolated: true, model: 'sonnet' })
  assert.ok(byLabel(calls, 'T02 · worker')[0].prompt.includes(`\`node "${PROG_SPACE}" step plans/p --json '`))
  drained('V3', q)
})
await test('V4: progress — issues of the close passed without their actions; the stop issue goes to the clerk', async () => {
  // Fresh answers for each scenario: the queues drain
  const withDev = () => ({ 'T00 · worker': [withProgress(report(0, { deviations: DEVIATION }))], 'T00 · replanning': [RP_E] })
  let { res, calls, q } = await scenario('V4a', { 'plan-reader': [planOpened(T00, T01)], ...s00(withDev()), ...s01(), 'run end · progress': [COK] }, AP)
  assert.equal(res.status, 'finished')
  assert.deepEqual(progressOf(calls, 'T00 · progress')[1].E.issues, [ISSUE_E])
  assert.equal(res.open_issues[0].options[0].amendments[0].id, 'T01', 'the summary of the pilot keeps the actions')
  let re = progressOf(calls, 'run end · progress')[0].E
  assert.deepEqual(re.open_issues, [ISSUE_E]); assert.ok(!('stop_issue' in re))
  drained('V4a', q)
  ;({ res, calls, q } = await scenario('V4b', { 'plan-reader': [planOpened(T00, T01)], ...s00(withDev()), 'run end · progress': [COK] }, { ...AP, mode: 'deviation' }))
  assert.equal(res.status, 'awaiting-ruling'); assert.deepEqual(res.not_started, ['T01'])
  assert.deepEqual(progressOf(calls, 'T00 · progress')[1].E.issues, [ISSUE_E])
  re = progressOf(calls, 'run end · progress')[0].E
  assert.deepEqual([re.status, re.stop_issue, re.open_issues, re.not_started], ['awaiting-ruling', ISSUE_E, [], ['T01']])
  drained('V4b', q)
})
await test('V5: progress — with rulings, the first scribe opens the run; each notes its own just before its commit', async () => {
  const RULING2 = [RULING[0], { task: 'T00', title: 'Threshold', option: { id: 'A', description: "Cap at 30 s, today's safe option" } }]
  const { res, calls, q } = await scenario('V5', { 'ruling T02 · progress': [{ ...withProgress(SOK), run_start_ok: true }], 'ruling T00 · progress': [withProgress(SOK)], 'plan-reader': [plan(T00)], ...s00(), 'run end · progress': [COK] }, { ...AP, rulings: RULING2 })
  assert.equal(res.status, 'finished'); assert.deepEqual(res.progress_failures, [])
  const a1 = progressOf(calls, 'ruling T02 · progress'), a2 = progressOf(calls, 'ruling T00 · progress')
  assert.deepEqual([a1.map(x => x.cmd), a2.map(x => x.cmd)], [['run-start', 'ruling'], ['ruling']])
  assert.ok(byLabel(calls, 'ruling T02 · progress')[0].prompt.startsWith(HEADER + ', opens the run'))
  assert.deepEqual(a1[1].E, { task: 'T02', title: 'Contract', option: 'B', added_tasks: [{ id: 'T01B', title: 'Doc', phase: 1 }], amendments: [{ id: 'T01', reason: 'r' }] })
  assert.deepEqual(a2[0].E, { task: 'T00', title: 'Threshold', option: 'A' })
  const lp = byLabel(calls, 'plan-reader')[0].prompt
  assert.ok(!lp.includes('progress.mjs') && !lp.includes('run_start_ok'), 'the plan reader does not open a second time')
  const sa = byLabel(calls, 'ruling T02 · progress')[0].prompt
  assert.ok(sa.includes('the progress command below adds their row') && !sa.includes('its row of PROGRESS.md') && sa.indexOf('progress.mjs ruling') > sa.indexOf('plan-lint.mjs plans/p --integration'))
  assert.deepEqual(progressOf(calls, 'run end · progress')[0].E.rulings_applied, [{ task: 'T02', title: 'Contract', option: 'B' }, { task: 'T00', title: 'Threshold', option: 'A' }])
  drained('V5', q)
})
await test('V6: progress — run start refused by the script → error, no task and no clerk', async () => {
  const E1 = 'progress: PROGRESS.md, row 5: unknown status "in-progress" for T00'
  let { res, calls, q } = await scenario('V6a', { 'plan-reader': [{ ok: false, tasks: [], run_start_ok: false, progress_error: E1 }] }, AP)
  assert.equal(res.status, 'error'); assert.ok(res.detail.startsWith('progress: run not opened') && res.detail.includes(E1))
  assert.deepEqual(res.progress_failures, [{ task: null, step: 'run-start', error: E1 }]); assert.equal(calls.length, 1)
  drained('V6a', q)
  ;({ res, calls, q } = await scenario('V6b', { 'ruling T02 · progress': [{ ok: false, run_start_ok: false, progress_error: E1 }] }, { ...AP, rulings: RULING }))
  assert.equal(res.status, 'error'); assert.deepEqual(res.rulings_applied, [], 'ruling to replay'); assert.equal(calls.length, 1)
  drained('V6b', q)
  ;({ res, calls, q } = await scenario('V6c', { 'plan-reader': [plan(T00)] }, AP))
  assert.equal(res.status, 'error'); assert.deepEqual(res.progress_failures, [{ task: null, step: 'run-start', error: 'result not reported' }])
  drained('V6c', q)
  // First agent without an answer: we do not know if the run is opened, no clerk
  ;({ res, calls, q } = await scenario('V6d', { 'ruling T02 · progress': [null] }, { ...AP, rulings: RULING }))
  assert.deepEqual([res.status, res.stop_issue.context, calls.length], ['awaiting-ruling', 'scribe without an answer', 1])
  drained('V6d', q)
  ;({ res, calls, q } = await scenario('V6e', { 'plan-reader': [null] }, AP))
  assert.deepEqual([res.status, calls.length], ['error', 1])
  drained('V6e', q)
})
await test('V7: progress — step failed or not reported → the run goes on, progress_failures cites it', async () => {
  const { res, q } = await scenario('V7', { 'plan-reader': [planOpened(T00)], ...s00({ 'T00 · worker': [report(0)], 'T00 · verification': [{ ...ok(1), progress_ok: false, progress_error: 'progress: lock held' }] }), 'run end · progress': [{ progress_ok: false, progress_error: 'progress: no run in progress' }] }, AP)
  assert.equal(res.status, 'finished')
  assert.deepEqual(res.progress_failures, [{ task: 'T00', step: 'worker', error: 'result not reported' }, { task: 'T00', step: 'verification', error: 'progress: lock held' }, { task: null, step: 'run-end', error: 'progress: no run in progress' }])
  drained('V7', q)
  // Clerk that could not switch to the integration branch: PROGRESS.md not committed, reported
  const r2 = await scenario('V7b', { 'plan-reader': [planOpened(T00)], ...s00(), 'run end · progress': [{ progress_ok: true, commit: '', detail: 'git switch refused: local changes' }] }, AP)
  assert.deepEqual(r2.res.progress_failures, [{ task: null, step: 'run-end', error: 'PROGRESS.md not committed: git switch refused: local changes' }])
  drained('V7b', r2.q)
  // Clerk without an answer, or that throws (usage limit): the summary comes back to the pilot all the same
  for (const [name, answer, error] of [['V7c', null, 'clerk without an answer'], ['V7d', () => { throw new Error('usage limit') }, 'clerk failed: Error: usage limit']]) {
    const r3 = await scenario(name, { 'plan-reader': [planOpened(T00, T01)], ...s00({ 'T00 · worker': [withProgress(report(0, { deviations: DEVIATION }))], 'T00 · replanning': [RP_E] }), ...s01(), 'run end · progress': [answer] }, AP)
    assert.equal(r3.res.status, 'finished'); assert.equal(r3.res.open_issues[0].options[0].amendments[0].id, 'T01', 'actions kept')
    assert.deepEqual(r3.res.progress_failures, [{ task: null, step: 'run-end', error }])
    drained(name, r3.q)
  }
})
await test('V8: progress — close not written → human stop; ruling not noted → status awaiting-ruling; the clerk runs all the same', async () => {
  let { res, calls, q } = await scenario('V8a', { 'plan-reader': [planOpened(T00, T01)], ...s00({ 'T00 · progress': [{ ...SOK, progress_ok: false, progress_error: 'progress: write refused' }] }), 'run end · progress': [COK] }, AP)
  assert.deepEqual([res.status, res.stop_issue.title, res.stop_issue.human, res.not_started], ['awaiting-ruling', 'Progress of T00: close not written in progress.json', true, ['T01']])
  assert.ok(res.stop_issue.context.startsWith('progress: write refused'))
  assert.deepEqual(res.progress_failures, [{ task: 'T00', step: 'close', error: 'progress: write refused' }])
  const re = progressOf(calls, 'run end · progress')[0].E
  assert.deepEqual([re.status, re.stop_issue.title, re.tasks], ['awaiting-ruling', 'Progress of T00: close not written in progress.json', [{ id: 'T00', status: 'merged', attempts: 1, branch: 'task/T00' }]])
  drained('V8a', q)
  ;({ res, calls, q } = await scenario('V8b', { 'ruling T02 · progress': [{ ...SOK, run_start_ok: true, progress_ok: false, progress_error: 'progress: task unknown to progress: T02' }], 'run end · progress': [COK] }, { ...AP, rulings: RULING }))
  assert.deepEqual([res.status, res.stop_issue.title], ['awaiting-ruling', 'Ruling "Contract" partly applied'])
  assert.ok(res.stop_issue.context.includes('progress.json and PROGRESS.md not written: progress: task unknown to progress: T02'))
  assert.deepEqual(res.rulings_applied, [{ task: 'T02', title: 'Contract', option: 'B' }], 'applied in HANDOFF: not to replay')
  assert.equal(byLabel(calls, 'run end · progress').length, 1)
  assert.deepEqual(res.progress_failures, [{ task: 'T02', step: 'ruling', error: 'progress: task unknown to progress: T02' }])
  drained('V8b', q)
  // Post-merge check failed: its issue goes with the close
  ;({ res, calls, q } = await scenario('V8c', { 'plan-reader': [planOpened(T00)], ...s00({ 'T00 · merge': [withProgress({ ok: false, merged: true, check_ok: false, detail: 'typecheck failed' })] }), 'run end · progress': [COK] }, AP))
  assert.equal(res.status, 'awaiting-ruling')
  assert.deepEqual(progressOf(calls, 'T00 · progress')[1].E.issues.map(p => [p.title, p.human]), [['Post-merge check failed after T00', true]])
  drained('V8c', q)
  // Authorization rule of progress missing: the verifier cites the progress command among the refused ones; it is not a failure of the task
  ;({ res, calls, q } = await scenario('V8d', { 'plan-reader': [planOpened(T00)], ...s00({ 'T00 · verification': [{ ...ok(1), progress_ok: false, progress_error: 'permission refused', forbidden: [`node ${PROG} step plans/p --json '{}'`] }] }), 'run end · progress': [COK] }, AP))
  assert.equal(res.status, 'finished'); assert.equal(byLabel(calls, 'T00 · evaluation').length, 1); assert.deepEqual(res.reviews, [])
  drained('V8d', q)
})
await test("V9: progress — plan unreadable after the run start → clerk; exception of a task → summary for run-end", async () => {
  let { res, calls, q } = await scenario('V9a', { 'plan-reader': [{ ok: false, errors: ['T09: unknown dependency'], tasks: [], run_start_ok: true }], 'run end · progress': [COK] }, AP)
  assert.equal(res.status, 'error'); assert.deepEqual(progressOf(calls, 'run end · progress')[0].E.detail, 'T09: unknown dependency')
  drained('V9a', q)
  ;({ res, calls, q } = await scenario('V9b', { 'plan-reader': [planOpened(T00)], 'T00 · worker': [() => { throw new Error("the agent's process crashed") }], 'run end · progress': [COK] }, AP))
  assert.equal(res.status, 'partial')
  assert.deepEqual(progressOf(calls, 'run end · progress')[0].E.tasks, [{ id: 'T00', status: 'failed', blocker: ["workflow error: Error: the agent's process crashed"] }], 'attempts and branch unknown: progress keeps its own')
  drained('V9b', q)
})
await test('V13: progress — close with flaky tests, unverifiable criterion and review; in autonomous mode, issue without a single recommendation in the close', async () => {
  const UV = 'behavior in a worktree: the task runs in the main checkout'
  const R = { type: 'review', description: '.env.example: add MR_MAX' }
  let { res, calls, q } = await scenario('V13a', { 'plan-reader': [planOpened(T00)], ...s00({ 'T00 · worker': [withProgress(report(0, { deviations: [R] }))], 'T00 · verification': [withProgress({ ...ok(1), flaky: ['journal.spec.ts:53'] })], 'T00 · evaluation': [withProgress({ verdict: 'pass', unverifiable: [UV] })], 'T00 · replanning': [NOTHING] }), 'run end · progress': [COK] }, AP)
  assert.equal(res.status, 'finished')
  assert.deepEqual(progressOf(calls, 'T00 · progress')[1].E, { task: 'T00', status: 'merged', attempts: 1, branch: 'task/T00', flaky: ['journal.spec.ts:53'], unverifiable: [UV], reviews: ['.env.example: add MR_MAX'], replanning: true })
  drained('V13a', q)
  const P2 = { title: 'Two recommended', context: '', options: [{ id: 'A', description: 'a', recommended: true }, { id: 'B', description: 'b', recommended: true }] }
  ;({ res, calls, q } = await scenario('V13b', { 'plan-reader': [planOpened(T00, T01)], ...s00({ 'T00 · worker': [withProgress(report(0, { deviations: DEVIATION }))], 'T00 · replanning': [{ major: true, entries: [], issues: [P2] }] }), 'run end · progress': [COK] }, { ...AP, mode: 'auto' }))
  assert.equal(res.status, 'awaiting-ruling')
  const cl = progressOf(calls, 'T00 · progress')[1].E
  assert.deepEqual(cl.issues, [{ task: 'T00', title: 'Two recommended', context: '', human: false, options: [{ id: 'A', description: 'a', recommended: true }, { id: 'B', description: 'b', recommended: true }] }])
  assert.ok(!('auto_decisions' in cl))
  drained('V13b', q)
  // Recommended option that cites a task nothing creates; cap of auto-decisions at 0: circuit breaker
  const P3 = { title: 'Code 1 accepted', options: [{ id: 'A', description: 'T06B will provide the script', recommended: true }, { id: 'B', description: 'other' }] }
  ;({ res, calls, q } = await scenario('V13c', { 'plan-reader': [planOpened(T00, T01)], ...s00({ 'T00 · worker': [withProgress(report(0, { deviations: DEVIATION }))], 'T00 · replanning': [{ major: true, entries: [], issues: [P3, issueN(1)] }] }), 'run end · progress': [COK] }, { ...AP, mode: 'auto', max_auto_decisions: 0 }))
  const [p3, p1] = progressOf(calls, 'T00 · progress')[1].E.issues
  assert.deepEqual([p3.title, p3.inconsistency, p1.title, p1.circuit_breaker], ['Code 1 accepted', 'cited tasks that do not exist and that the option does not create: T06B', 'P1', true])
  assert.equal(progressOf(calls, 'plan-reader')[0].E.max_auto_decisions, 0)
  drained('V13c', q)
})
await test('V10: without args.progress, instructions of 0.6.3: no progress command, no clerk', async () => {
  const { res, calls, q } = await scenario('V10', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · progress': [SOK] })
  assert.equal(res.status, 'finished'); assert.ok(!('progress_failures' in res))
  assert.ok(calls.every(c => !c.prompt.includes('progress.mjs') && !c.prompt.includes('Plan progress')))
  assert.ok(byLabel(calls, 'T00 · progress')[0].prompt.includes('- PROGRESS.md: row T00 → status "merged", attempts 1, branch task/T00'))
  drained('V10', q)
})

// ——— 0.8.0: the workflow played with the real progress.mjs, in a temporary repository; the simulated agents run the commands of their instruction ———
const PROGRESS_SCRIPT = join(resolve(dirname(SRC), '..'), 'scripts', 'progress.mjs')
// A plan in the 0.12 format (tasks/, PROGRESS.md, English keys): plan-lint refuses a French plan (taches/)
function toyRepo() {
  const root = fs.mkdtempSync(join(tmpdir(), 'scenarios-progress-'))
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  fs.writeFileSync(join(root, 'README.md'), 'x\n'); git('add', '.'); git('commit', '-qm', 'init')
  const d = join(root, 'plans', 'p')
  fs.mkdirSync(join(d, 'tasks'), { recursive: true })
  const writeTask = (id, dep) => fs.writeFileSync(join(d, 'tasks', `${id}-x.md`), `---\nid: ${id}\ntitle: Task ${id}\nphase: 1\nmodel: sonnet\ndepends_on: [${dep.join(', ')}]\nparallel_batch: 1A\nowned_files:\n  - src/${id}/**\nresources: []\ntoken_estimate: 1.0M\nverification:\n  - "npm test"\ndefinition_of_done:\n  - "the test passes"\n---\n\n## Launch prompt\nYou carry out ${id}.\n`)
  writeTask('T00', []); writeTask('T01', ['T00'])
  fs.writeFileSync(join(d, 'PROGRESS.md'), '# PROGRESS — p\n\n| ID | Title | Phase | Batch | Depends on | Model | Status | Attempts | Branch | Tokens est. / actual |\n|---|---|---|---|---|---|---|---|---|---|\n| T00 | Task T00 | 1 | 1A | — | sonnet | todo | 0 | — | 1.0M / — |\n| T01 | Task T01 | 1 | 1A | T00 | sonnet | todo | 0 | — | 1.0M / — |\n\nStatuses: todo · added · merged · blocked · failed · needs-human · cancelled\n')
  fs.writeFileSync(join(d, 'HANDOFF.md'), '# HANDOFF — p\n\nEntries: `deviation`, `blind-spot`, `decision`, `debt`, `needs-human`, `ticket`, `review`, rated `minor` or `major`.\n')
  fs.writeFileSync(join(d, 'DISCOVERY.md'), '# DISCOVERY — p\n\n## Existing context\n\n## Verified commands\n\n## Quick map\n\n## Observed conventions\n\n## Pitfalls and fixes\n\n## Context recommendations (end of run)\n')
  fs.writeFileSync(join(d, 'orchestre.config.json'), JSON.stringify({ integration_branch: 'plan/p' }))
  git('switch', '-qc', 'plan/p'); git('add', '.'); git('commit', '-qm', 'plan')
  return { root, git, writeTask, doc: () => JSON.parse(fs.readFileSync(join(d, 'progress.json'), 'utf8')), row: id => fs.readFileSync(join(d, 'PROGRESS.md'), 'utf8').split('\n').find(l => l.startsWith(`| ${id} `)) }
}
// Each progress command of the instruction goes through the shell, in order; the report carries their exit codes
async function play(name, D, q, args = {}) {
  const launched = []
  const agent = async (prompt, opts = {}) => {
    const k = opts.label
    if (!(k in q) || !q[k].length) throw new Error(`[${name}] unexpected call: ${k}`)
    const v0 = q[k].shift(), cs = progressCommands(prompt)
    // { before, answer }: what the agent does before its progress commands (the scribe writes the created tasks)
    const v = v0 && typeof v0 === 'object' && 'before' in v0 ? (v0.before(), v0.answer) : v0
    const codes = cs.map(c => { const r = spawnSync('sh', ['-c', c], { cwd: D.root, encoding: 'utf8' }); launched.push({ label: k, code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }); return r.status })
    const answer = typeof v === 'function' ? v(prompt, opts) : v
    // The clerk also runs the cleaning of the worktrees: its last line goes in "worktrees"
    const wt = [...prompt.matchAll(/`(node "?[^`"]*worktrees\.mjs"? clean [^`]*)`/g)].map(m => m[1])
    const cleaning = wt.map(c => { const r = spawnSync('sh', ['-c', c], { cwd: D.root, encoding: 'utf8' }); launched.push({ label: k, code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }); return r.stdout.trim() || r.stderr.trim() }).pop()
    if (!cs.length) return answer
    return { ...answer, ...(cs[0].includes('progress.mjs" run-start') || cs[0].includes('progress.mjs run-start') ? { run_start_ok: codes[0] === 0 } : {}), progress_ok: codes[codes.length - 1] === 0, ...(cleaning ? { worktrees: cleaning } : {}) }
  }
  last = null
  const res = await run({ ...ARGS, progress: PROGRESS_SCRIPT, ...args }, agent, () => {}, () => {})
  last = { res, launched }
  return { res, launched }
}
const T0 = { ...T00, resources: [], file: 'plans/p/tasks/T00-x.md', verification: ['npm test'] }
const T1 = { ...T01, model: 'sonnet', resources: [], file: 'plans/p/tasks/T01-x.md', verification: ['npm test'] }
await test('V11: real progress.mjs — T00 merged after a rejection, T01 blocked: progress.json valid, log in order, PROGRESS.md regenerated', async () => {
  const D = toyRepo()
  try {
    const M = "false comment on the option's `--force` ($HOME)"
    const { res, launched } = await play('V11', D, {
      'plan-reader': [plan(T0, T1)], 'T00 · worker': [report(0)], 'T00 · verification': [ok(1), ok(2)], 'T00 · evaluation': [{ verdict: 'fail', gaps: [M] }, { verdict: 'pass' }],
      'T00 · fix 1': [report(1)], 'T00 · merge': [MOK], 'T00 · progress': [SOK],
      'T01 · worker': [{ status: 'blocked', summary: 'blocked', branch: 'task/T01', path: D.root, blocker: 'ambiguous schema' }], 'T01 · replanning': [NOTHING], 'T01 · progress': [SOK],
      'run end · progress': [{ commit: '', detail: '' }] })
    assert.deepEqual(launched.filter(l => l.code !== 0), [], 'all the progress commands pass')
    assert.equal(launched.length, 15, '14 progress commands and the cleaning of the worktrees')
    assert.equal(res.status, 'partial'); assert.deepEqual(res.progress_failures, [])
    const doc = D.doc(), t = id => doc.tasks.find(x => x.id === id)
    assert.deepEqual(doc.runs.map(r => [r.number, r.status, r.phase, r.mode, r.parallelism, r.end !== null]), [[1, 'partial', 1, 'phase', 4, true]])
    assert.deepEqual([t('T00').status, t('T00').attempts, t('T00').branch, t('T00').step, t('T00').isolated], ['merged', 2, 'task/T00', null, false])
    assert.deepEqual(t('T00').rejections, [{ attempt: 1, by: 'evaluation', gaps: [M] }])
    assert.deepEqual([t('T01').status, t('T01').attempts, t('T01').blocker, t('T01').step], ['blocked', 1, ['ambiguous schema'], null])
    assert.deepEqual(doc.log.filter(e => e.task === 'T00').map(e => e.text), ['T00 starts (main checkout)', 'T00: verification', 'T00: evaluation', 'T00: attempt 1 rejected (evaluation): 1 gap(s)', 'T00: fix (attempt 2)', 'T00: verification', 'T00: evaluation', 'T00: merge', 'T00: progress', 'T00: merged (2 attempts)'])
    assert.deepEqual(doc.log.filter(e => e.task === 'T01').map(e => e.text), ['T01 starts (main checkout)', 'T01: progress', 'T01: replanning finished', 'T01: blocked (1 attempt) — ambiguous schema'])
    assert.match(D.row('T00'), /\| merged  \| 2 +\| task\/T00 \| 1\.0M \/ see \/workflows \|$/)
    assert.match(D.row('T01'), /\| blocked +\| 1 +\| task\/T01 \|/)
    assert.equal(launched.find(l => l.label === 'run end · progress').out, 'progress: run 1 partial', 'nothing to commit for the clerk')
    assert.equal(launched[launched.length - 1].out, 'worktrees plans/p: 0 removed, 0 kept')
    assert.equal(spawnSync(process.execPath, [PROGRESS_SCRIPT, 'validate', 'plans/p'], { cwd: D.root }).status, 0)
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
await test('V12: real progress.mjs — exception of a task: run-end closes it as failed and regenerates PROGRESS.md, which the clerk will commit', async () => {
  const D = toyRepo()
  try {
    const { res, launched } = await play('V12', D, { 'plan-reader': [plan(T0)], 'T00 · worker': [() => { throw new Error('boom') }], 'run end · progress': [{ commit: '', detail: '' }] })
    assert.equal(res.status, 'partial'); assert.deepEqual(res.progress_failures, [])
    assert.equal(launched.find(l => l.label === 'run end · progress').out, 'progress: run 1 partial; PROGRESS.md regenerated, to commit')
    const t = D.doc().tasks.find(x => x.id === 'T00')
    assert.deepEqual([t.status, t.step, t.blocker], ['failed', null, ['workflow error: Error: boom']])
    assert.match(D.row('T00'), /\| failed +\| 1 +\|/, 'attempts of progress (worker step), not the 0 of the summary')
    assert.equal(D.git('status', '--porcelain'), ' M plans/p/PROGRESS.md\n', 'only PROGRESS.md, progress.json outside git')
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
await test('V14: real progress.mjs — full close in autonomous mode (auto-decision, added task, stop issue, review), then ruling at the next run', async () => {
  const D = toyRepo()
  try {
    const P2 = { title: 'Two recommended', context: "either one, the user's call", options: [{ id: 'A', description: 'a', recommended: true, entries: [{ type: 'debt', severity: 'minor', description: 'x' }] }, { id: 'B', description: 'b', recommended: true }] }
    const R = { type: 'review', description: '.env.example: add MR_MAX' }
    const run1 = await play('V14a', D, {
      'plan-reader': [plan(T0, T1)], 'T00 · worker': [report(0, { deviations: [...DEVIATION, R] })], 'T00 · verification': [ok(1)], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [MOK],
      'T00 · replanning': [{ ...RP_E, issues: [...RP_E.issues, P2] }],
      'T00 · progress': [{ before: () => D.writeTask('T00C', ['T00']), answer: SOK }], 'run end · progress': [{ commit: '', detail: '' }] }, { mode: 'auto' })
    assert.deepEqual(run1.launched.filter(l => l.code !== 0), [])
    assert.equal(run1.res.status, 'awaiting-ruling'); assert.deepEqual(run1.res.progress_failures, [])
    let doc = D.doc()
    assert.deepEqual(doc.tasks.map(x => [x.id, x.status, x.added_by]), [['T00', 'merged', null], ['T00C', 'added', 'T00'], ['T01', 'todo', null]])
    assert.deepEqual(doc.auto_decisions, [{ run: 1, task: 'T00', title: 'UpdateUserSchema contract', option: 'A', description: 'Keep optional and test rule (d)' }])
    assert.deepEqual(doc.issues.map(p => [p.run, p.task, p.title, p.role, p.status, p.options.length]), [[1, 'T00', 'Two recommended', 'stop', 'open', 2]])
    assert.deepEqual(doc.reviews.map(r => [r.task, r.text, r.run]), [['T00', '.env.example: add MR_MAX', 1]])
    assert.deepEqual([doc.runs[0].status, doc.runs[0].added_tasks, doc.runs[0].not_started], ['awaiting-ruling', [{ id: 'T00C', phase: 1, title: 'Rule d test' }], ['T01']])
    assert.ok(doc.log.some(e => e.kind === 'amendment' && e.task === 'T01'))
    assert.ok(/\| T00C \| Rule d test /.test(D.row('T00C')), 'row added by the script, title from the replanner')
    D.git('add', '-A'); D.git('commit', '-qm', 'progress(T00): merged')
    // Run 2: the user settles "Two recommended"; the scribe opens the run and notes the ruling
    const run2 = await play('V14b', D, {
      'ruling T00 · progress': [SOK], 'plan-reader': [plan({ ...T0, status: 'merged' })], 'run end · progress': [{ commit: '', detail: '' }] },
      { rulings: [{ task: 'T00', title: 'Two recommended', option: P2.options[0] }] })
    assert.deepEqual(run2.launched.filter(l => l.code !== 0), [])
    assert.deepEqual(run2.launched.map(l => l.out.split(';')[0]), ['progress: run 2 opened (phase 1, mode phase)', 'progress: ruling T00 option A', 'progress: run 2 finished', 'worktrees plans/p: 0 removed, 0 kept'])
    doc = D.doc()
    assert.deepEqual([doc.issues[0].status, doc.issues[0].chosen_option], ['settled', 'A'])
    assert.deepEqual(doc.runs.map(r => [r.number, r.status]), [[1, 'awaiting-ruling'], [2, 'finished']])
    assert.deepEqual(doc.runs[1].rulings_applied, [{ task: 'T00', title: 'Two recommended', option: 'A' }])
    assert.equal(spawnSync(process.execPath, [PROGRESS_SCRIPT, 'validate', 'plans/p'], { cwd: D.root }).status, 0)
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
await test('V15: real progress.mjs — task added by a ruling kept in the run despite the run-end summary, which does not know it', async () => {
  const D = toyRepo()
  try {
    const A = { task: 'T00', title: 'Contract', option: { id: 'B', description: 'Test', added_tasks: [{ id: 'T00D', title: 'Contract test', phase: 1, content: '---\nid: T00D\n---' }] } }
    const r = await play('V15', D, { 'ruling T00 · progress': [{ before: () => D.writeTask('T00D', ['T00']), answer: SOK }], 'plan-reader': [plan({ ...T0, status: 'merged' })], 'run end · progress': [{ commit: '', detail: '' }] }, { rulings: [A] })
    assert.deepEqual(r.launched.filter(l => l.code !== 0), [])
    const doc = D.doc()
    assert.deepEqual(doc.runs[0].added_tasks, [{ id: 'T00D', phase: 1, title: 'Contract test' }])
    assert.deepEqual(doc.tasks.find(x => x.id === 'T00D').added_by, 'T00')
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
// ——— Batch A (0.8.0): environment of the working folders, branch taken back, cleaning of the worktrees ———
const SETUP = { setup: ['pnpm install --frozen-lockfile', 'pnpm prisma generate'], shared_setup: { 'test-db': ['pnpm db:test:prepare'], unused: ['make x'] } }
await test('A1: setup run by each worker on its branch and by the integrator before the check; shared setup only under the declared resource', async () => {
  const TB = { ...T00, resources: ['test-db'] }, TN = { ...T01, depends_on: [], resources: [] }
  const { res, calls, q } = await scenario('A1', { 'plan-reader': [plan(TB, TN)], ...t00(), 'T00 · progress': [SOK], 'T01 · worker': [report(1, { branch: 'task/T01', path: '/wt/T01' })], 'T01 · verification': [ok(2)], 'T01 · evaluation': [{ verdict: 'pass' }], 'T01 · merge': [MOK], 'T01 · progress': [SOK] }, SETUP)
  assert.equal(res.status, 'finished')
  const w0 = byLabel(calls, 'T00 · worker')[0].prompt, w1 = byLabel(calls, 'T01 · worker')[0].prompt
  assert.ok(w0.includes('Environment setup, once on your branch, before any other work: run one by one, as they are, these project commands: `pnpm install --frozen-lockfile`, `pnpm prisma generate`, `pnpm db:test:prepare`.'))
  assert.ok(w1.includes('these project commands: `pnpm install --frozen-lockfile`, `pnpm prisma generate`.'), 'T01 does not declare test-db')
  assert.ok(w0.indexOf('Environment setup') > w0.indexOf('Branch:'), 'after the branch')
  assert.ok(!w0.includes('make x') && !w1.includes('make x'))
  const f0 = byLabel(calls, 'T00 · merge')[0].prompt
  assert.ok(f0.indexOf('`pnpm db:test:prepare`') > f0.indexOf('return merged=true') && f0.indexOf('`pnpm db:test:prepare`') < f0.indexOf('this check command'), 'integrator: between the merge and the check')
  assert.ok(f0.includes('do not run the check: return check_ok=false'))
  assert.ok(!byLabel(calls, 'T01 · merge')[0].prompt.includes('db:test:prepare'))
  assert.ok(!/setup/i.test(byLabel(calls, 'T00 · verification')[0].prompt), 'the verifier sets up nothing')
  drained('A1', q)
})
await test('A2: without setup, or malformed, no instruction; branch taken back by a merge, never a rebase; guard recalled to the isolated worker only', async () => {
  let { calls, q } = await scenario('A2', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · progress': [SOK] }, { setup: 'pnpm install', shared_setup: [['x']] })
  const w = byLabel(calls, 'T00 · worker')[0].prompt
  assert.ok(calls.every(c => !c.prompt.includes('Environment setup')))
  for (const x of ['git merge-base --is-ancestor plan/p HEAD', 'git merge --no-edit plan/p', 'git merge --abort', 'Never a rebase or a reset']) assert.ok(w.includes(x), 'taken back: ' + x)
  assert.ok(!w.includes('isolation guard'), 'main checkout: no guard')
  drained('A2', q)
  const T02 = { ...T00, id: 'T02', title: 'Other', file: 'plans/p/tasks/T02.md', resources: [] }, T03 = { ...T02, id: 'T03', file: 'plans/p/tasks/T03.md' }
  const tt = id => ({ [`${id} · worker`]: [report(id, { branch: `task/${id}`, path: `/wt/${id}` })], [`${id} · verification`]: [ok(id)], [`${id} · evaluation`]: [{ verdict: 'pass' }], [`${id} · merge`]: [MOK], [`${id} · progress`]: [SOK] })
  ;({ calls, q } = await scenario('A2b', { 'plan-reader': [plan(T02, T03)], ...tt('T02'), ...tt('T03') }))
  assert.ok(byLabel(calls, 'T02 · worker')[0].prompt.includes("You are in an isolated worktree: Claude Code's isolation guard only accepts simple commands there"))
  drained('A2b', q)
})
await test('A3: the clerk cleans the worktrees after the commit of PROGRESS.md; its line comes back to the pilot', async () => {
  const { res, calls, q } = await scenario('A3', { 'plan-reader': [planOpened(T00)], ...s00(), 'run end · progress': [{ ...COK, worktrees: 'worktrees plans/p: 1 removed, 0 kept' }] }, AP)
  assert.equal(res.worktrees, 'worktrees plans/p: 1 removed, 0 kept')
  const g = byLabel(calls, 'run end · progress')[0]
  assert.ok(g.prompt.includes('4. `node /plug/scripts/worktrees.mjs clean plans/p`') && g.prompt.indexOf('worktrees.mjs') > g.prompt.indexOf('git commit'))
  assert.ok(g.prompt.includes('skip steps 3 and 4'))
  assert.ok('worktrees' in g.opts.schema.properties)
  drained('A3', q)
})
await test('A4: real worktrees.mjs — at the end of the run, the clean worktree of an earlier attempt is removed, its branch kept', async () => {
  const D = toyRepo()
  try {
    const W = join(D.root, '..', `wt-${process.pid}`)
    D.git('worktree', 'add', '-q', '-b', 'task/T01', W, 'plan/p')
    const r = await play('A4', D, { 'plan-reader': [plan(T0)], 'T00 · worker': [report(0)], 'T00 · verification': [ok(1)], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [MOK], 'T00 · progress': [SOK], 'run end · progress': [{ commit: '', detail: '' }] })
    assert.deepEqual(r.launched.filter(l => l.code !== 0), [])
    assert.match(r.res.worktrees, /^removed task\/T01 \(.*\), branch kept\nworktrees plans\/p: 1 removed, 0 kept$/)
    assert.ok(!fs.existsSync(W))
    assert.ok(D.git('branch', '--list', 'task/T01').includes('task/T01'), 'branch kept')
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
await test('A5: fix — the setup runs again if needed; integrator — nothing changed after the setup; stop that names it', async () => {
  const TB = { ...T00, resources: ['test-db'] }
  const { res, calls, q } = await scenario('A5', { 'plan-reader': [plan(TB)], 'T00 · worker': [report(0)], 'T00 · verification': [ok(1), ok(2)], 'T00 · evaluation': [{ verdict: 'fail', gaps: ['M1'] }, { verdict: 'pass' }], 'T00 · fix 1': [report(1)], 'T00 · merge': [{ ok: false, merged: true, check_ok: false, detail: 'setup: changed files src/generated/client.ts' }], 'T00 · progress': [SOK] }, SETUP)
  const c = byLabel(calls, 'T00 · fix 1')[0].prompt
  assert.ok(c.includes('If your fix changes the dependencies or what is generated, first run again') && c.includes('`pnpm db:test:prepare`'))
  const f = byLabel(calls, 'T00 · merge')[0].prompt
  assert.ok(f.includes('`git status --porcelain` must be empty') && f.includes('"setup: changed files"'))
  assert.equal(res.status, 'awaiting-ruling'); assert.ok(res.stop_issue.context.startsWith('setup or post-merge check failed on plan/p'))
  drained('A5', q)
})
// ——— 0.11.0: the model of each task, and the choice of the model of the fixes ———
const TM = (model, extra = {}) => ({ id: 'T05', title: 'Model', file: 'plans/p/tasks/T05.md', phase: 1, ...(model ? { model } : {}), model_reason: 'routine implementation', depends_on: [], resources: [], status: 'todo', verification: ['npm test'], ...extra })
const report5 = (n, extra = {}) => withProgress(report(n, { branch: 'task/T05', ...extra }))
const ok5 = x => withProgress({ ok: true, results: [{ command: 'npm test', code: 0, excerpt: 'ok ' + x }] })
const fail5 = g => withProgress({ verdict: 'fail', gaps: [g] })
const end5 = () => ({ 'T05 · merge': [withProgress(MOK)], 'T05 · progress': [withProgress(SOK)], 'run end · progress': [COK] })
const steps = (calls, l) => byLabel(calls, l).map(c => progressCommands(c.prompt).map(parse)[0].E)
await test('M1: the worker runs on the task\'s model, as is, and passes it to progress; without a rejection, no model choice', async () => {
  for (const m of ['haiku', 'opus', 'fable']) {
    const { res, calls, q } = await scenario('M1 ' + m, { 'plan-reader': [planOpened(TM(m))], 'T05 · worker': [report5(0)], 'T05 · verification': [ok5(1)], 'T05 · evaluation': [withProgress({ verdict: 'pass' })], ...end5() }, AP)
    assert.equal(res.status, 'finished')
    assert.equal(byLabel(calls, 'T05 · worker')[0].opts.model, m)
    assert.deepEqual(steps(calls, 'T05 · worker'), [{ task: 'T05', step: 'worker', isolated: false, model: m }])
    assert.ok(!calls.some(c => /model choice/.test(c.opts.label)))
    drained('M1 ' + m, q)
  }
})
await test('M2: after each rejected attempt, the replanner chooses the model of the fix; change in progress; down to the floor; no choice after the last attempt', async () => {
  const A1 = 'module architecture to rework', A2 = 'typo in the message'
  const { res, calls, logs, q } = await scenario('M2', {
    'plan-reader': [planOpened(TM('sonnet'))], 'T05 · worker': [report5(0)],
    'T05 · verification': [ok5(1), ok5(2), withProgress({ ok: false, results: [{ command: 'npm test', code: 1, excerpt: '1 failed' }], failures: [{ command: 'npm test', excerpt: '1 failed' }] })],
    'T05 · evaluation': [fail5(A1), fail5(A2)],
    'T05 · model choice 1': [{ model: 'opus', reason: "gap in the module's architecture" }], 'T05 · model choice 2': [{ model: 'haiku', reason: 'text typo' }],
    'T05 · fix 1': [report5(1)], 'T05 · fix 2': [report5(2)],
    'T05 · replanning': [NOTHING], 'T05 · progress': [withProgress(SOK)], 'run end · progress': [COK] }, AP)
  const t = res.tasks[0]
  assert.deepEqual([t.status, t.attempts], ['blocked', 3])
  const [c1, c2] = [1, 2].map(i => byLabel(calls, `T05 · model choice ${i}`)[0])
  assert.deepEqual([c1.opts.agentType, c1.opts.model, c1.opts.schema.required, c1.opts.schema.properties.model.enum], ['orchestre:replanner', 'opus', ['model', 'reason'], ['haiku', 'sonnet', 'opus']])
  for (const x of ['Model planned by the plan: sonnet ("routine implementation")', 'floor', 'Attempt 1, on sonnet, was rejected by the evaluation', JSON.stringify([A1]), 'plans/p/tasks/T05.md']) assert.ok(c1.prompt.includes(x), 'choice 1: ' + x)
  assert.ok(!c1.prompt.includes('Attempts rejected before it') && !c1.prompt.includes('progress.mjs'), 'choice 1: no history, no progress command')
  assert.ok(c2.prompt.includes('Attempt 2, on opus') && c2.prompt.includes(`Attempts rejected before it: ${JSON.stringify([{ attempt: 1, model: 'sonnet', by: 'evaluation', gaps: [A1] }])}`), 'choice 2: earlier rejections and their models')
  assert.ok(idx(calls, 'T05 · model choice 1') > idx(calls, 'T05 · evaluation') && idx(calls, 'T05 · model choice 1') < idx(calls, 'T05 · fix 1'))
  assert.deepEqual(['T05 · fix 1', 'T05 · fix 2'].map(l => byLabel(calls, l)[0].opts.model), ['opus', 'sonnet'], 'opus, then sonnet: the haiku choice is raised to the floor')
  assert.deepEqual(steps(calls, 'T05 · fix 1')[0], { task: 'T05', step: 'fix', rejection: { attempt: 1, by: 'evaluation', gaps: [A1] }, model: 'opus', change: { from: 'sonnet', to: 'opus', reason: "gap in the module's architecture" } })
  assert.deepEqual(steps(calls, 'T05 · fix 2')[0].change, { from: 'opus', to: 'sonnet', reason: "text typo; raised to the task's model (sonnet)" })
  assert.ok(logs.includes("T05: fix 1 on opus (instead of sonnet): gap in the module's architecture"), logs.join('\n'))
  assert.ok(logs.includes("T05: fix 2 on sonnet (instead of opus): text typo; raised to the task's model (sonnet)"), logs.join('\n'))
  drained('M2', q)
})
await test('M3: floor — a choice weaker than the task runs on the task, without a change; fable stays the floor', async () => {
  for (const [m, choice] of [['opus', 'haiku'], ['fable', 'opus']]) {
    const { res, calls, logs, q } = await scenario('M3 ' + m, { 'plan-reader': [planOpened(TM(m))], 'T05 · worker': [report5(0)], 'T05 · verification': [ok5(1), ok5(2)], 'T05 · evaluation': [fail5('M'), withProgress({ verdict: 'pass' })], 'T05 · model choice 1': [{ model: choice, reason: 'r' }], 'T05 · fix 1': [report5(1)], ...end5() }, AP)
    assert.equal(res.status, 'finished')
    assert.equal(byLabel(calls, 'T05 · fix 1')[0].opts.model, m)
    const E = steps(calls, 'T05 · fix 1')[0]
    assert.deepEqual([E.model, 'change' in E], [m, false], 'same model as the attempt: no change')
    assert.ok(logs.includes(`T05: fix 1 on ${m}: r; raised to the task's model (${m})`), 'the raised choice stays traced in the log: ' + logs.join(' | '))
    drained('M3 ' + m, q)
  }
})
await test('M4: choice missing or invalid — the escalation ladder applies, above the floor, and the change says so', async () => {
  const { res, calls, logs, q } = await scenario('M4', {
    'plan-reader': [planOpened(TM('haiku'))], 'T05 · worker': [report5(0)], 'T05 · verification': [ok5(1), ok5(2), ok5(3)],
    'T05 · evaluation': [fail5('M1'), fail5('M2'), withProgress({ verdict: 'pass' })],
    'T05 · model choice 1': [null], 'T05 · model choice 2': [{ model: 'gpt-5', reason: 'x' }],
    'T05 · fix 1': [report5(1)], 'T05 · fix 2': [report5(2)], ...end5() }, AP)
  assert.deepEqual([res.status, res.tasks[0].attempts], ['finished', 3])
  assert.equal(byLabel(calls, 'T05 · worker')[0].opts.model, 'haiku')
  assert.deepEqual(['T05 · fix 1', 'T05 · fix 2'].map(l => byLabel(calls, l)[0].opts.model), ['sonnet', 'opus'])
  assert.deepEqual(steps(calls, 'T05 · fix 1')[0].change, { from: 'haiku', to: 'sonnet', reason: 'model choice without an answer: escalation ladder, fix 1' })
  assert.deepEqual(steps(calls, 'T05 · fix 2')[0].change, { from: 'sonnet', to: 'opus', reason: 'invalid choice (gpt-5): escalation ladder, fix 2' })
  assert.ok(logs.includes('T05: model choice without an answer: escalation ladder, fix 1'))
  drained('M4', q)
  // Ladder of the project: that of args.escalation
  const r2 = await scenario('M4b', { 'plan-reader': [planOpened(TM('sonnet'))], 'T05 · worker': [report5(0)], 'T05 · verification': [ok5(1), ok5(2)], 'T05 · evaluation': [fail5('M1'), withProgress({ verdict: 'pass' })], 'T05 · model choice 1': [null], 'T05 · fix 1': [report5(1)], ...end5() }, { ...AP, escalation: ['opus'] })
  assert.equal(byLabel(r2.calls, 'T05 · fix 1')[0].opts.model, 'opus')
  drained('M4b', r2.q)
})
await test('M5: task without a model — behavior of 0.10: sonnet, then the ladder, without a call to the replanner; the ladder change goes to progress', async () => {
  const { res, calls, q } = await scenario('M5', {
    'plan-reader': [planOpened(TM(null))], 'T05 · worker': [report5(0)], 'T05 · verification': [ok5(1), ok5(2), ok5(3)],
    'T05 · evaluation': [fail5('M1'), fail5('M2'), withProgress({ verdict: 'pass' })], 'T05 · fix 1': [report5(1)], 'T05 · fix 2': [report5(2)], ...end5() }, AP)
  assert.equal(res.status, 'finished')
  assert.ok(!calls.some(c => /model choice/.test(c.opts.label) || c.opts.agentType === 'orchestre:replanner'))
  assert.deepEqual(['T05 · worker', 'T05 · fix 1', 'T05 · fix 2'].map(l => byLabel(calls, l)[0].opts.model), ['sonnet', 'sonnet', 'opus'])
  assert.deepEqual(steps(calls, 'T05 · worker')[0].model, 'sonnet')
  const [e1, e2] = [steps(calls, 'T05 · fix 1')[0], steps(calls, 'T05 · fix 2')[0]]
  assert.deepEqual([e1.model, 'change' in e1], ['sonnet', false])
  assert.deepEqual([e2.model, e2.change], ['opus', { from: 'sonnet', to: 'opus', reason: 'no model in the plan: escalation ladder, fix 2' }])
  drained('M5', q)
  // Without progress: no command, same models
  const r2 = await scenario('M5b', { 'plan-reader': [plan(TM(null))], 'T05 · worker': [report(0, { branch: 'task/T05' })], 'T05 · verification': [ok(1), ok(2)], 'T05 · evaluation': [{ verdict: 'fail', gaps: ['M'] }, { verdict: 'pass' }], 'T05 · fix 1': [report(1, { branch: 'task/T05' })], 'T05 · merge': [MOK], 'T05 · progress': [SOK] })
  assert.ok(r2.calls.every(c => !c.prompt.includes('progress.mjs')))
  assert.equal(byLabel(r2.calls, 'T05 · fix 1')[0].opts.model, 'sonnet')
  drained('M5b', r2.q)
})
await test('M6: real progress.mjs — model used and change noted in progress.json, in the log between the rejection and the fix; PROGRESS.md keeps the model of the plan', async () => {
  const D = toyRepo()
  try {
    const { res, launched } = await play('M6', D, {
      'plan-reader': [plan({ ...T1, depends_on: [], model_reason: 'routine implementation' })], 'T01 · worker': [report(1, { branch: 'task/T01' })], 'T01 · verification': [ok(1), ok(2)],
      'T01 · evaluation': [{ verdict: 'fail', gaps: ['architecture'] }, { verdict: 'pass' }], 'T01 · model choice 1': [{ model: 'opus', reason: "gap in the module's architecture" }],
      'T01 · fix 1': [report(2, { branch: 'task/T01' })], 'T01 · merge': [MOK], 'T01 · progress': [SOK], 'run end · progress': [{ commit: '', detail: '' }] })
    assert.deepEqual(launched.filter(l => l.code !== 0), [], 'all the progress commands pass')
    assert.equal(res.status, 'finished'); assert.deepEqual(res.progress_failures, [])
    const doc = D.doc(), t = doc.tasks.find(x => x.id === 'T01')
    assert.deepEqual([doc.format, t.model, t.model_used, t.status], ['orchestre-progress/3', 'sonnet', 'opus', 'merged'])
    assert.deepEqual(doc.log.filter(e => e.task === 'T01').map(e => e.text).slice(3, 6), ['T01: attempt 1 rejected (evaluation): 1 gap(s)', "T01: sonnet → opus (gap in the module's architecture)", 'T01: fix (attempt 2)'])
    assert.equal(doc.log.filter(e => e.kind === 'model').length, 1)
    assert.match(D.row('T01'), /\| sonnet +\| merged \|/)
    assert.equal(spawnSync(process.execPath, [PROGRESS_SCRIPT, 'validate', 'plans/p'], { cwd: D.root }).status, 0)
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
// ——— 0.12.0: required lint, mode "deviation", language of the free text, English branches and commits ———
await test('W1: without lint (required since 0.12.0) → error, no agent launched', async () => {
  for (const lint of [undefined, '']) {
    const { res, calls } = await scenario('W1 ' + JSON.stringify(lint), {}, { lint })
    assert.deepEqual(res, { status: 'error', detail: 'args required: plan, phase, integration, lint' }); assert.equal(calls.length, 0)
  }
})
await test('W2: mode "devia" of 0.11 → error, no agent launched; mode "deviation" stops on the first issue', async () => {
  const { res, calls } = await scenario('W2', {}, { mode: 'devia' })
  assert.deepEqual(res, { status: 'error', detail: 'unknown mode: devia (auto, deviation or phase)' }); assert.equal(calls.length, 0)
  const b = await scenario('W2b', { 'plan-reader': [plan(T00, T01)], ...t00(DEVIATION), 'T00 · replanning': [{ major: true, entries: [], issues: [issueN(1), issueN(2)] }], 'T00 · progress': [SOK] }, { mode: 'deviation' })
  assert.equal(b.res.status, 'awaiting-ruling'); assert.equal(b.res.mode, 'deviation'); assert.equal(b.res.stop_issue.title, 'P1')
  assert.deepEqual(b.res.open_issues.map(p => p.title), ['P2']); assert.equal(b.res.auto_decisions.length, 0)
  assert.deepEqual(b.res.not_started, ['T01']); assert.equal(idx(b.calls, 'T01 · worker'), -1)
  assert.ok(byLabel(b.calls, 'T00 · replanning')[0].prompt.includes('mode deviation'))
  drained('W2b', b.q)
})
await test('W3: language of the free text — "en" by default, given by args, in the prompts of the agents that write it, never in the others', async () => {
  const WRITERS = ['T05 · worker', 'T05 · fix 1', 'T05 · evaluation', 'T05 · replanning', 'T05 · model choice 1', 'T05 · progress', 'ruling T02 · progress']
  const OTHERS = ['plan-reader', 'T05 · verification', 'T05 · merge', 'run end · progress']
  const queue = () => ({ 'ruling T02 · progress': [{ ...withProgress(SOK), run_start_ok: true }], 'plan-reader': [plan(TM('sonnet'))], 'T05 · worker': [report5(0, { deviations: DEVIATION })], 'T05 · verification': [ok5(1), ok5(2)],
    'T05 · evaluation': [fail5('M1'), withProgress({ verdict: 'pass' })], 'T05 · model choice 1': [{ model: 'sonnet', reason: 'r' }], 'T05 · fix 1': [report5(1)], 'T05 · replanning': [NOTHING], ...end5() })
  for (const [language, expected] of [[undefined, 'en'], ['fr', 'fr'], [42, 'en'], ['   ', 'en']]) {
    const name = 'W3 ' + JSON.stringify(language)
    const { res, calls, q } = await scenario(name, queue(), { ...AP, rulings: RULING, ...(language === undefined ? {} : { language }) })
    assert.equal(res.status, 'finished')
    for (const l of WRITERS) { const cs = byLabel(calls, l); assert.ok(cs.length > 0, l); assert.ok(cs.every(c => c.prompt.includes(`in the language "${expected}"`)), `${name} · ${l}: language ${expected}`) }
    for (const l of OTHERS) { const cs = byLabel(calls, l); assert.ok(cs.length > 0, l); assert.ok(cs.every(c => !c.prompt.includes('Language:')), `${name} · ${l}: no language`) }
    drained(name, q)
  }
  // Without progress, the scribe gets the language too
  const p = await scenario('W3 no progress', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · progress': [SOK] }, { language: 'fr' })
  assert.ok(byLabel(p.calls, 'T00 · progress')[0].prompt.includes('in the language "fr"'))
  drained('W3 no progress', p.q)
  // A quote or a newline in the language: one quoted JSON string, on the Language line
  const r = await scenario('W3 quote', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · progress': [SOK] }, { language: 'fr"\nCA' })
  const w = byLabel(r.calls, 'T00 · worker')[0].prompt
  const line = w.split('\n').find(l => l.startsWith('Language:'))
  assert.ok(line && line.includes('in the language "fr\\" CA".'), String(line))
  assert.equal(JSON.parse(line.match(/in the language ("(?:[^"\\]|\\.)*")/)[1]), 'fr" CA')
  assert.ok(!w.includes('fr"\nCA'), 'no raw newline from the language')
  drained('W3 quote', r.q)
})
await test('W4: branches task/<id> and task/<id>-r<n>, never tache/; merge message "task <id>: <title>"; scribe commits "progress(<id>): …"', async () => {
  for (const [name, args] of [['W4', {}], ['W4 progress', { ...AP, rulings: RULING }]]) {
    const queue = args.progress
      ? { 'ruling T02 · progress': [{ ...withProgress(SOK), run_start_ok: true }], 'plan-reader': [plan(T00)], ...s00(), 'run end · progress': [COK] }
      : { 'plan-reader': [plan(T00)], ...t00(), 'T00 · progress': [SOK] }
    const { res, calls, q } = await scenario(name, queue, args)
    assert.equal(res.status, 'finished')
    const w = byLabel(calls, 'T00 · worker')[0].prompt
    for (const x of ['`git switch -c task/T00`', 'refs/heads/task/T00 ', "'refs/heads/task/T00-r*'", 'task/T00-r<n>', '`git switch -c task/T00-r<n> <branch>`']) assert.ok(w.includes(x), `${name} · worker: ${x}`)
    assert.ok(calls.every(c => !c.prompt.includes('tache/')), `${name}: no prompt names tache/`)
    assert.ok(byLabel(calls, 'T00 · merge')[0].prompt.includes('`git merge --no-ff task/T00 -m "task T00: Tooling"`'), `${name}: merge message`)
    assert.ok(byLabel(calls, 'T00 · progress')[0].prompt.includes('with the message "progress(T00): merged"'), `${name}: scribe commit`)
    if (args.rulings) assert.ok(byLabel(calls, 'ruling T02 · progress')[0].prompt.includes('with the message "progress(T02): ruling B"'), `${name}: ruling commit`)
    // HANDOFF entries copied word for word, whatever the language: progress.mjs matches the reviews with them
    assert.ok(byLabel(calls, 'T00 · progress')[0].prompt.includes('add these entries, word for word: ['), `${name}: entries word for word`)
    if (args.rulings) assert.ok(byLabel(calls, 'ruling T02 · progress')[0].prompt.includes('add these entries, word for word: ['), `${name}: ruling entries word for word`)
    drained(name, q)
  }
})
await test('W5: max_fixes and max_auto_decisions read from args, under their 0.12 names; run-start gets them as integers', async () => {
  // max_fixes 0: the first rejection blocks the task, no fix, no model choice
  const a = await scenario('W5', { 'plan-reader': [plan(T00)], 'T00 · worker': [report(0)], 'T00 · verification': [ok(1)], 'T00 · evaluation': [{ verdict: 'fail', gaps: ['G1'] }], 'T00 · replanning': [NOTHING], 'T00 · progress': [SOK] }, { max_fixes: 0 })
  assert.equal(a.res.tasks[0].status, 'blocked'); assert.equal(a.res.tasks[0].attempts, 1); assert.deepEqual(a.res.tasks[0].blocker, ['G1'])
  assert.equal(idx(a.calls, 'T00 · fix 1'), -1)
  drained('W5', a.q)
  // With progress: run-start carries the values of args, strings made integers
  const b = await scenario('W5 progress', { 'plan-reader': [planOpened(T00)], ...s00(), 'run end · progress': [COK] }, { ...AP, max_fixes: '1', max_auto_decisions: 5, parallelism: 2 })
  const start = progressOf(b.calls, 'plan-reader')[0]
  assert.equal(start.cmd, 'run-start'); assert.deepEqual(start.E, { phase: 1, mode: 'phase', parallelism: 2, max_fixes: 1, max_auto_decisions: 5 })
  drained('W5 progress', b.q)
})
await test('W6: run end — the tasks waiting on a prerequisite and the needs-human tasks waiting for a rerun reach run-end', async () => {
  const T02 = { ...T00, id: 'T02', file: 'plans/p/tasks/T02.md', resources: [], status: 'needs-human' }
  const { res, calls, q } = await scenario('W6', { 'plan-reader': [planOpened({ ...T00, open_prerequisites: ['D5'] }, T02)], 'run end · progress': [COK] }, AP)
  assert.equal(res.status, 'partial')
  assert.deepEqual(res.waiting_on_prerequisites, [{ id: 'T00', prerequisites: ['D5'] }]); assert.deepEqual(res.waiting, ['T02'])
  const end = progressOf(calls, 'run end · progress')[0]
  assert.equal(end.cmd, 'run-end'); assert.equal(end.E.status, 'partial')
  assert.deepEqual(end.E.waiting_on_prerequisites, [{ id: 'T00', prerequisites: ['D5'] }]); assert.deepEqual(end.E.waiting, ['T02']); assert.deepEqual(end.E.not_started, [])
  drained('W6', q)
})
await test('W7: integrator — check_ok decides over ok (0.12 name of controle_ok): a failed check stops the run, the task stays merged', async () => {
  const { res, calls, q } = await scenario('W7', { 'plan-reader': [plan(T00)], ...t00([], { ok: true, merged: true, check_ok: false, detail: 'tsc: 2 errors' }), 'T00 · progress': [SOK] })
  assert.equal(res.status, 'awaiting-ruling'); assert.equal(res.tasks[0].status, 'merged')
  assert.equal(res.stop_issue.title, 'Post-merge check failed after T00'); assert.match(res.stop_issue.context, /tsc: 2 errors$/)
  const schema = byLabel(calls, 'T00 · merge')[0].opts.schema
  assert.ok(schema.properties.check_ok && schema.properties.merged && !schema.properties.controle_ok, 'integrator: schema in English')
  drained('W7', q)
})
await test('W8: sensitive deviations spotted in English and in French (free text of a plan in "fr"); a db: script name is not one', async () => {
  const sensitive = ['le test tourne sur la base de dev', 'copie des données réelles pour la recette', 'the test writes to the dev db', 'seeded with real user data', 'copied live customer data into fixtures', 'uses the staging DBs']
  for (const [i, d] of sensitive.entries()) {
    const name = `W8 ${i}`
    const { res, calls, q } = await scenario(name, { 'plan-reader': [plan(T00, T01)], ...t00([{ type: 'decision', description: d }]), 'T00 · replanning': [{ major: false, entries: [{ type: 'decision', severity: 'minor', description: d }], issues: [] }], 'T00 · progress': [SOK] }, { mode: 'auto' })
    assert.equal(res.status, 'awaiting-ruling', `${name}: ${d}`); assert.equal(res.stop_issue.title, 'Sensitive deviation of T00 without a decision issue'); assert.equal(res.stop_issue.context, d)
    assert.ok(byLabel(calls, 'T00 · replanning')[0].prompt.includes('major automatically'), `${name}: listed as sensitive`)
    assert.ok(byLabel(calls, 'T00 · progress')[0].prompt.includes(`"severity":"major","description":${JSON.stringify(d)}`), `${name}: entry forced to major`)
    drained(name, q)
  }
  const plain = 'pnpm db:test:prepare added to the verification of T01'
  const { res, calls, q } = await scenario('W8 plain', { 'plan-reader': [plan(T00, T01)], ...t00([{ type: 'decision', description: plain }]), 'T00 · replanning': [{ major: false, entries: [{ type: 'decision', severity: 'minor', description: plain }], issues: [] }], 'T00 · progress': [SOK], ...t01() }, { mode: 'auto' })
  assert.equal(res.status, 'finished'); assert.ok(!byLabel(calls, 'T00 · replanning')[0].prompt.includes('major automatically'))
  assert.ok(byLabel(calls, 'T00 · progress')[0].prompt.includes(`"severity":"minor","description":${JSON.stringify(plain)}`))
  drained('W8 plain', q)
})
await test('W9: shell — plan path with a space quoted in the plan-lint and clerk commands; task title made safe in the merge message', async () => {
  const P = 'plans/my plan', T = { ...T00, title: 'Add `--json` "flag" for $HOME \\ paths', file: 'plans/my plan/tasks/T00.md' }
  const { res, calls, q } = await scenario('W9', { 'plan-reader': [planOpened(T)], ...s00(), 'run end · progress': [COK] }, { ...AP, plan: P })
  assert.equal(res.status, 'finished')
  assert.ok(byLabel(calls, 'plan-reader')[0].prompt.includes('`node /plug/scripts/plan-lint.mjs "plans/my plan" --json --phase 1 --integration plan/p`'))
  const g = byLabel(calls, 'run end · progress')[0].prompt
  assert.ok(g.includes('`git diff --quiet HEAD -- "plans/my plan/PROGRESS.md"`') && g.includes('-- "plans/my plan/PROGRESS.md"`, which only commits'))
  assert.ok(g.includes('worktrees.mjs clean "plans/my plan"`'))
  const m = byLabel(calls, 'T00 · merge')[0].prompt
  assert.ok(m.includes(`-m "task T00: Add '--json' 'flag' for HOME  paths"\``), m.split('\n')[0])
  drained('W9', q)
})
await test('W10: blank lint → error; language cut at 40 characters; a forbidden project command named progress.mjs is still forbidden', async () => {
  const blank = await scenario('W10 lint', {}, { lint: '   ' })
  assert.deepEqual(blank.res, { status: 'error', detail: 'args required: plan, phase, integration, lint' }); assert.equal(blank.calls.length, 0)
  const long = 'x'.repeat(60)
  const l = await scenario('W10 language', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · progress': [SOK] }, { language: long })
  assert.ok(byLabel(l.calls, 'T00 · worker')[0].prompt.includes(`in the language "${'x'.repeat(39)}…"`))
  drained('W10 language', l.q)
  // A verification command of the project that runs its own progress.mjs, refused by the permissions: a review for the human, not hidden
  const T = { ...T00, verification: ['node scripts/progress.mjs --check', 'sh scripts/e2e-local.sh'] }
  const f = await scenario('W10 forbidden', { 'plan-reader': [planOpened(T)], 'T00 · worker': [withProgress(report(0))],
    'T00 · verification': [withProgress({ ok: true, results: [{ command: 'sh scripts/e2e-local.sh', code: 0, excerpt: '96 passed' }], forbidden: ['node scripts/progress.mjs --check', `node ${PROG} step plans/p --json '{}'`] })],
    'T00 · evaluation': [withProgress({ verdict: 'pass' })], 'T00 · merge': [withProgress(MOK)], 'T00 · progress': [withProgress(SOK)], 'run end · progress': [COK] }, AP)
  assert.equal(f.res.status, 'finished')
  assert.deepEqual(f.res.reviews, [{ task: 'T00', review: 'command `node scripts/progress.mjs --check` refused to the agents: to run by the human before the PR' }])
  assert.ok(byLabel(f.calls, 'T00 · merge')[0].prompt.includes('this check command, without a pipe (add `; echo "code=$?"`): sh scripts/e2e-local.sh.'))
  drained('W10 forbidden', f.q)
})
console.log(`scenarios: ALL GREEN (${n} cases)`)
