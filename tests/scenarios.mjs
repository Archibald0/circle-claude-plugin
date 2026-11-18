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
// Fingerprint of the plan-lint output the plan-reader copies (0.18.1), taken from the workflow itself. An answer of the
// plan-reader without a "digest" key gets the right one: the scenarios play a faithful copy unless they say otherwise
// (a digest of another plan, or the key present without a value)
const planDigest = new Function(src.match(/\nfunction planDigest\(p\) \{\n[\s\S]*?\n\}/)[0] + '\nreturn planDigest')()
// Likewise (0.19.0): an answer of the verifier without a "scope" key gets a faithful copy of plan-lint --scope for the task and
// the branch of its instruction, nothing outside the owned files; a pass of the evaluator without a "proofs" key gets a proof
// by the diff. A scenario that plays something else gives the key, even without a value
const scopeDigest = new Function(src.match(/\nfunction scopeDigest\(p\) \{\n[\s\S]*?\n\}/)[0] + '\nreturn scopeDigest')()
const sealScope = s => ({ ...s, digest: scopeDigest(s) })
const scopeIn = prompt => {
  const m = String(prompt).match(/ --scope (\S+) --branch (\S+) --integration /)
  assert.ok(m, 'verifier without a scope command: ' + String(prompt).slice(0, 200))
  return sealScope({ task: m[1], branch: m[2], files: [], outside: [], tests_removed: [], skips_added: [] })
}
const PROOFS = [{ criterion: 'every criterion of the definition of done', by: 'diff', ref: 'src/a.ts:1' }]
// Likewise (0.20.0): every JSON of a progress command carries "_digest", checked by parse below; a close agent that reports
// progress_ok=true without a "close" key gets a faithful copy of the output of close, from the input of its instruction and
// the commit, rejected and discarded of its answer
const payloadDigest = new Function(src.match(/\nfunction payloadDigest\(p, skip = '_digest'\) \{\n[\s\S]*?\n\}/)[0] + '\nreturn payloadDigest')()
const closeIn = prompt => { const c = progressCommands(prompt).map(parse).find(x => x.cmd === 'close'); return c && c.E }
const sealClose = (E, a) => { const o = { task: E.task, status: E.status, commit: a.commit ?? 'p1', rejected: a.rejected || [], discarded: a.discarded || [], issues: [], pending: [], message: `${E.task} ${E.status}` }; return { ...o, digest: payloadDigest(o, 'digest') } }
// Likewise (0.20.0): a plan-reader that opens the run (run_start_ok=true) with neither an "apply" nor an "apply_ok" key gets a
// faithful output of apply without a ruling, when its instruction has the apply command
const sealApply = o => ({ ...o, digest: payloadDigest(o, 'digest') })
const NO_RULING = sealApply({ applied: [], rejected: [], discarded: [], amended: [], added_tasks: [], commit: null, message: 'no ruling to apply' })
const applyCmdIn = prompt => (String(prompt).match(/~~~sh\n(node "?[^\n"]*progress\.mjs"? apply [^\n]*)\n~~~/) || [])[1] || null
const sealed = (k, a, prompt) => {
  if (!a || typeof a !== 'object') return a
  if (k.startsWith('plan-reader')) {
    const b = 'digest' in a ? a : { ...a, digest: planDigest(a) }
    return a.run_start_ok === true && !('apply' in a) && !('apply_ok' in a) && applyCmdIn(prompt) ? { ...b, apply_ok: true, apply: NO_RULING } : b
  }
  if (k.endsWith(' · verification') && !('scope' in a)) return { ...a, scope: scopeIn(prompt) }
  if (k.endsWith(' · evaluation') && a.verdict === 'pass' && !('proofs' in a)) return { ...a, proofs: PROOFS }
  if (k.endsWith(' · progress') && a.progress_ok === true && !('close' in a) && closeIn(prompt)) return { ...a, close: sealClose(closeIn(prompt), a) }
  return a
}
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
  const calls = [], logs = [], unexpected = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    const k = opts.label
    if (!(k in q) || !q[k].length) { unexpected.push(k); throw new Error(`[${name}] unexpected call: ${k}`) }
    const v = q[k].shift()
    return sealed(k, typeof v === 'function' ? await v(prompt, opts) : v, prompt)
  }
  const res = await run({ ...ARGS, ...args }, agent, () => {}, (m) => logs.push(m))
  last = res
  // The workflow catches an agent that throws where only the display is at stake (the clerk of a task start, of the run end):
  // a call without an answer must not pass for such a failure
  assert.deepEqual(unexpected, [], `[${name}] call without an answer`)
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
  assert.equal(res.open_issues[0].options[0].amendments[0].id, 'T01', 'actions kept in the summary of the pilot')
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
// 0.20.0: no args.rulings any more. An arg rulings is ignored: no ruling scribe, the plan reader first
const RULING = [{ task: 'T02', title: 'Contract', option: { id: 'B', description: 'Test rule d', entries: [{ type: 'debt', severity: 'minor', description: 'x' }], amendments: [{ id: 'T01', verification: ['pnpm test:d'], reason: 'r' }], added_tasks: [{ id: 'T01B', title: 'Doc', phase: 0, content: '---\nid: T01B\nphase: 0\n---' }] } }]
await test('J: an arg rulings (0.19) is no longer read: no scribe applies a ruling, the plan reader comes first, no option reaches an agent', async () => {
  const { res, calls, q } = await scenario('J', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · progress': [SOK] }, { rulings: RULING })
  assert.equal(idx(calls, 'plan-reader'), 0); assert.ok(calls.every(c => !c.opts.label.startsWith('ruling ')))
  assert.ok(calls.every(c => !c.prompt.includes('Test rule d') && !c.prompt.includes('pnpm test:d')), 'nothing of the option in a prompt')
  assert.deepEqual(res.rulings_applied, []); assert.equal(res.status, 'finished')
  drained('J', q)
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
  assert.ok(byLabel(calls, 'plan-reader')[0].prompt.includes(`node ${LP} plans/p --reader --phase 1 --integration plan/p`), 'reading: plan-lint of the plugin, --reader (0.18.1)')
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.ok(sc.includes(`node ${LP} plans/p --integration plan/p`) && !sc.includes('.claude/orchestre/') && !sc.includes(ARGS.lint), 'scribe: plan-lint of the plugin')
  drained('P1', q)
})
await test('P2: manual install — empty agent_prefix gives unprefixed agent types; without lint (required since 0.12.0), an error and no agent', async () => {
  const { calls, q } = await scenario('P2', { 'plan-reader': [plan(T00)], 'T00 · worker': [report(0)], 'T00 · verification': [ok(1)], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [MOK], 'T00 · progress': [SOK] }, { agent_prefix: '', parallelism: 1 })
  assert.equal(byLabel(calls, 'plan-reader')[0].opts.agentType, 'plan-reader'); assert.equal(byLabel(calls, 'T00 · worker')[0].opts.agentType, 'worker')
  assert.ok(byLabel(calls, 'plan-reader')[0].prompt.includes('node /plug/scripts/plan-lint.mjs plans/p --reader'))
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
  assert.ok(byLabel(calls, 'plan-reader')[0].prompt.includes(`node "${L}" plans/p --reader`))
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
// Progress commands of an instruction (0.18.0): a block between ~~~ lines, the JSON object on its own line in a heredoc
// whose delimiter is quoted (a declaration, hoisted: sealed uses it from the first scenarios on)
function progressCommands(prompt) { return [...prompt.matchAll(/~~~sh\n(node "?[^\n"]*progress\.mjs"? [^\n]*<<'ORCHESTRE_JSON'\n[^\n]*\nORCHESTRE_JSON)\n~~~/g)].map(m => m[1]) }
// Each JSON carries its "_digest" (0.20.0), which must match: parse checks it and gives the object without it
function parse(c) {
  const m = c.match(/progress\.mjs"? (\S+) ("[^"]*"|\S+) <<'ORCHESTRE_JSON'\n([^\n]*)\nORCHESTRE_JSON$/)
  assert.ok(m, 'malformed progress command: ' + c)
  const { _digest, ...E } = JSON.parse(m[3])
  assert.equal(_digest, payloadDigest(E), `${m[1]}: _digest missing or wrong`)
  return { cmd: m[1], plan: m[2], E }
}
// The Bash tool of Claude Code decodes the \uXXXX sequences of a command before the shell reads it (issue #1); the agents
// played by play() go through the same decoding when BASH_TOOL.decodes is on
const BASH_TOOL = { decodes: false }
const bashTool = c => (BASH_TOOL.decodes ? c.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : c)
const progressOf = (calls, label, i = 0) => progressCommands(byLabel(calls, label)[i].prompt).map(parse)
const HEADER = 'Plan progress: your first command, before any other'
const s00 = (extra = {}) => ({ 'T00 · worker': [withProgress(report(0))], 'T00 · verification': [withProgress(ok(1))], 'T00 · evaluation': [withProgress({ verdict: 'pass' })], 'T00 · merge': [withProgress(MOK)], 'T00 · progress': [withProgress(SOK)], ...extra })
const s01 = () => ({ 'T01 · worker': [withProgress(report(1, { branch: 'task/T01' }))], 'T01 · verification': [withProgress(ok(2))], 'T01 · evaluation': [withProgress({ verdict: 'pass' })], 'T01 · merge': [withProgress(MOK)], 'T01 · progress': [withProgress(SOK)] })
const ISSUE_E = { task: 'T00', title: 'UpdateUserSchema contract', context: 'isSuperAdmin optional', human: false, options: [{ id: 'A', description: 'Keep optional and test rule (d)', impact: 'one more test', recommended: true }, { id: 'B', description: 'Make the field required', impact: 'breaks partial calls', recommended: false }] }
// The issue of RP_E as close gets it (0.20.0): whole, its options with their actions, the task added brought back to phase 1
const ISSUE_WHOLE = { ...ISSUE_E, options: [{ ...RP_E.issues[0].options[0], added_tasks: [{ id: 'T00C', title: 'Rule d test', phase: 1, content: '---\nid: T00C\nphase: 1\nmodel: sonnet\n---\n' }] }, RP_E.issues[0].options[1]] }

await test('V1: progress — the plan reader opens the run, each agent first runs its step, the scribe closes before its commit, the clerk closes the run', async () => {
  const { res, calls, q } = await scenario('V1', { 'plan-reader': [planOpened(T00)], ...s00(), 'run end · progress': [COK] }, AP)
  assert.equal(res.status, 'finished'); assert.deepEqual(res.progress_failures, [])
  const lp = byLabel(calls, 'plan-reader')[0].prompt
  assert.ok(lp.startsWith(HEADER + ', opens the run'))
  assert.deepEqual(progressOf(calls, 'plan-reader'), [{ cmd: 'run-start', plan: 'plans/p', E: { phase: 1, mode: 'phase', parallelism: 4, max_fixes: 2, max_auto_decisions: 3 } }])
  assert.ok(lp.includes('plan-lint.mjs plans/p --reader --phase 1') && lp.includes('with run_start_ok'))
  for (const [l, E] of [['T00 · worker', { task: 'T00', step: 'worker', isolated: false, model: 'sonnet' }], ['T00 · verification', { task: 'T00', step: 'verification' }], ['T00 · evaluation', { task: 'T00', step: 'evaluation' }], ['T00 · merge', { task: 'T00', step: 'merge' }]]) {
    assert.ok(byLabel(calls, l)[0].prompt.startsWith(HEADER), l + ': step first')
    assert.deepEqual(progressOf(calls, l), [{ cmd: 'step', plan: 'plans/p', E }], l)
  }
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.deepEqual(progressOf(calls, 'T00 · progress'), [{ cmd: 'step', plan: 'plans/p', E: { task: 'T00', step: 'progress' } }, { cmd: 'close', plan: 'plans/p', E: { task: 'T00', status: 'merged', attempts: 1, branch: 'task/T00' } }])
  // 0.20.0: a task with findings closes through the scribe, which writes DISCOVERY.md only, then runs close, which commits
  assert.ok(!sc.includes('- PROGRESS.md: row') && sc.includes('Never write HANDOFF.md, PROGRESS.md, a task or an amendment yourself, and make no commit') && sc.includes('commits them with DISCOVERY.md, with the message "progress(T00): merged"'))
  assert.ok(sc.indexOf('progress.mjs close') > sc.indexOf('DISCOVERY.md: integrate'), 'close written after the rest')
  assert.deepEqual([byLabel(calls, 'T00 · progress')[0].opts.agentType, byLabel(calls, 'T00 · progress')[0].opts.model], ['orchestre:scribe', 'sonnet'])
  const clerk = byLabel(calls, 'run end · progress')
  assert.equal(clerk.length, 1); assert.equal(idx(calls, 'run end · progress'), calls.length - 1, 'the clerk comes last')
  assert.deepEqual([clerk[0].opts.agentType, clerk[0].opts.model, clerk[0].opts.schema.required], ['orchestre:clerk', 'haiku', ['progress_ok']])
  const [re] = progressOf(calls, 'run end · progress')
  assert.deepEqual([re.cmd, re.E.status, re.E.not_started, re.E.open_issues], ['run-end', 'finished', [], []])
  assert.deepEqual(re.E.tasks, [{ id: 'T00', status: 'merged', attempts: 1, branch: 'task/T00' }], 'summary without the workers\' summaries')
  for (const x of ['1. `git switch plan/p`', '`git diff --quiet HEAD -- plans/p/PROGRESS.md`', '`git commit -m "progress: end of the run of phase 1" -- plans/p/PROGRESS.md`']) assert.ok(clerk[0].prompt.includes(x), 'clerk: ' + x)
  assert.ok(!clerk[0].prompt.includes('git add'), 'the clerk only commits PROGRESS.md')
  assert.deepEqual([byLabel(calls, 'plan-reader')[0].opts.schema.required, byLabel(calls, 'T00 · progress')[0].opts.schema.required, byLabel(calls, 'T00 · worker')[0].opts.schema.required], [['ok', 'tasks', 'digest', 'run_start_ok', 'apply_ok'], ['progress_ok'], ['status', 'summary', 'branch', 'path']], 'result required only where it decides what follows')
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
  assert.ok(progressCommands(fix).every(c => c.split('\n').length === 3), 'the JSON on one line, between the command and the delimiter')
  assert.ok(fix.includes("the option's `--force` costs $5") && !fix.includes('\\u0027'), 'apostrophe, backtick and dollar as they are, in the quoted heredoc')
  const D = { task: 'T00', title: 'UpdateUserSchema contract', option: 'A', description: 'Keep optional and test rule (d)' }
  // 0.20.0: the whole close goes to close: the replanner's entries, the rejection uncut, the decided issue whole with auto (close
  // applies its option: its entries, its task brought back to phase 1, its amendment); nothing of it in the scribe's instruction
  const [A, B] = RP_E.issues[0].options
  assert.deepEqual(progressOf(calls, 'T00 · progress')[1].E, {
    task: 'T00', status: 'merged', attempts: 2, branch: 'task/T00', entries: [{ type: 'deviation', severity: 'major', description: 'contract widened' }],
    rejections: [{ attempt: 1, by: 'evaluation', gaps: [M, 'npm test: 2 failures at a.test.ts:12 ' + 'x'.repeat(400)] }],
    issues: [{ task: 'T00', title: 'UpdateUserSchema contract', context: 'isSuperAdmin optional', human: false, auto: 'A', options: [
      { ...A, added_tasks: [{ id: 'T00C', title: 'Rule d test', phase: 1, content: '---\nid: T00C\nphase: 1\nmodel: sonnet\n---\n' }] }, B] }],
    replanning: true })
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.ok(sc.includes('Decisions taken automatically in this close: ["UpdateUserSchema contract: Keep optional and test rule (d)"]') && sc.includes('(`test -e <path>`)') && sc.includes('Return in "missing" each path'))
  assert.ok(!sc.includes('plan-lint.mjs') && !sc.includes('- HANDOFF.md') && !sc.includes('New tasks: create them'), 'neither plan-lint, nor HANDOFF.md, nor a task for the scribe')
  assert.deepEqual(progressOf(calls, 'T01 · progress')[1].E, { task: 'T01', status: 'merged', attempts: 1, branch: 'task/T01' }, 'nothing of T00 in the close of T01')
  const re = progressOf(calls, 'run end · progress')[0].E
  assert.deepEqual([re.status, re.auto_decisions, re.added_tasks], ['rerun', [D], [{ id: 'T00C', phase: 1, title: 'Rule d test', added_by: 'T00' }]])
  assert.deepEqual(res.added_tasks, [{ id: 'T00C', phase: 1, title: 'Rule d test' }], 'summary of the pilot unchanged')
  drained('V2', q)
})
await test('V3: progress — parallel tasks → worker step with isolated=true, run by the clerk (0.18.2); script path with a space quoted', async () => {
  const T02 = { ...T00, id: 'T02', title: 'Other', file: 'plans/p/tasks/T02.md', resources: [] }
  const T03 = { ...T00, id: 'T03', title: 'Again', file: 'plans/p/tasks/T03.md', resources: [] }
  const tt = id => ({ [`${id} · start`]: [COK], [`${id} · worker`]: [report(id, { branch: `task/${id}`, path: `/wt/${id}` })], [`${id} · verification`]: [withProgress(ok(id))], [`${id} · evaluation`]: [withProgress({ verdict: 'pass' })], [`${id} · merge`]: [withProgress(MOK)], [`${id} · progress`]: [withProgress(SOK)] })
  const PROG_SPACE = '/Users/x y/.claude/plugins/cache/circle/orchestre/0.8.0/scripts/progress.mjs'
  // Args values as strings or negative: integers valid for the progress schema
  const { res, calls, q } = await scenario('V3', { 'plan-reader': [planOpened(T02, T03)], ...tt('T02'), ...tt('T03'), 'run end · progress': [COK] }, { progress: PROG_SPACE, max_fixes: '2', max_auto_decisions: -1 })
  assert.equal(res.status, 'finished')
  assert.deepEqual(progressOf(calls, 'plan-reader')[0].E, { phase: 1, mode: 'phase', parallelism: 4, max_fixes: 2, max_auto_decisions: 0 })
  assert.deepEqual(res.progress_failures, [])
  for (const id of ['T02', 'T03']) assert.deepEqual(progressOf(calls, `${id} · start`), [{ cmd: 'step', plan: 'plans/p', E: { task: id, step: 'worker', isolated: true, model: 'sonnet' } }])
  assert.ok(byLabel(calls, 'T02 · start')[0].prompt.includes(`~~~sh\nnode "${PROG_SPACE}" step plans/p <<'ORCHESTRE_JSON'\n`))
  drained('V3', q)
})
await test('V4: progress — issues of the close passed whole, with their actions (0.20.0); run-end gets them without; the stop issue goes to the clerk', async () => {
  // Fresh answers for each scenario: the queues drain
  const withDev = () => ({ 'T00 · worker': [withProgress(report(0, { deviations: DEVIATION }))], 'T00 · replanning': [RP_E] })
  let { res, calls, q } = await scenario('V4a', { 'plan-reader': [planOpened(T00, T01)], ...s00(withDev()), ...s01(), 'run end · progress': [COK] }, AP)
  assert.equal(res.status, 'finished')
  assert.deepEqual(progressOf(calls, 'T00 · progress')[1].E.issues, [ISSUE_WHOLE])
  assert.equal(res.open_issues[0].options[0].amendments[0].id, 'T01', 'the summary of the pilot keeps the actions')
  let re = progressOf(calls, 'run end · progress')[0].E
  assert.deepEqual(re.open_issues, [ISSUE_E]); assert.ok(!('stop_issue' in re))
  drained('V4a', q)
  ;({ res, calls, q } = await scenario('V4b', { 'plan-reader': [planOpened(T00, T01)], ...s00(withDev()), 'run end · progress': [COK] }, { ...AP, mode: 'deviation' }))
  assert.equal(res.status, 'awaiting-ruling'); assert.deepEqual(res.not_started, ['T01'])
  assert.deepEqual(progressOf(calls, 'T00 · progress')[1].E.issues, [ISSUE_WHOLE])
  re = progressOf(calls, 'run end · progress')[0].E
  assert.deepEqual([re.status, re.stop_issue, re.open_issues, re.not_started], ['awaiting-ruling', ISSUE_E, [], ['T01']])
  drained('V4b', q)
})
await test('V6: progress — run start refused by the script → error, no task and no clerk', async () => {
  const E1 = 'progress: PROGRESS.md, row 5: unknown status "in-progress" for T00'
  let { res, calls, q } = await scenario('V6a', { 'plan-reader': [{ ok: false, tasks: [], run_start_ok: false, progress_error: E1 }] }, AP)
  assert.equal(res.status, 'error'); assert.ok(res.detail.startsWith('progress: run not opened') && res.detail.includes(E1))
  assert.deepEqual(res.progress_failures, [{ task: null, step: 'run-start', error: E1 }]); assert.equal(calls.length, 1)
  drained('V6a', q)
  // 0.20.0: a run start refused runs no apply: the rulings stay recorded
  assert.ok(byLabel(calls, 'plan-reader')[0].prompt.includes('Otherwise, stop there without doing anything else'))
  assert.deepEqual(res.rulings_applied, [])
  ;({ res, calls, q } = await scenario('V6c', { 'plan-reader': [plan(T00)] }, AP))
  assert.equal(res.status, 'error'); assert.deepEqual(res.progress_failures, [{ task: null, step: 'run-start', error: 'result not reported' }])
  drained('V6c', q)
  // First agent without an answer: we do not know if the run is opened, no clerk
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
await test('V8: progress — close not written → human stop; the clerk runs all the same', async () => {
  // 0.20.0: close writes everything or nothing; refused for another reason than an altered payload, it is not run again
  let { res, calls, q } = await scenario('V8a', { 'plan-reader': [planOpened(T00, T01)], ...s00({ 'T00 · worker': [withProgress(report(0, { deviations: DEVIATION }))], 'T00 · replanning': [{ major: false, entries: [{ type: 'deviation', severity: 'minor', description: 'isSuperAdmin optional' }], issues: [] }], 'T00 · progress': [{ progress_ok: false, progress_error: 'progress: write refused' }] }), 'run end · progress': [COK] }, AP)
  assert.deepEqual([res.status, res.stop_issue.title, res.stop_issue.human, res.not_started], ['awaiting-ruling', 'Progress of T00 not committed', true, ['T01']])
  assert.equal(res.stop_issue.context, 'close refused: progress: write refused. Nothing of the close is written (HANDOFF.md, tasks, amendments, ISSUES.json); the run end closes T00 in progress.json from the summary. HANDOFF entries not written: ["deviation · minor · isSuperAdmin optional"]')
  assert.deepEqual(res.progress_failures, [{ task: 'T00', step: 'close', error: 'progress: write refused' }])
  assert.equal(byLabel(calls, 'T00 · progress').length, 1, 'not run again')
  const re = progressOf(calls, 'run end · progress')[0].E
  assert.deepEqual([re.status, re.stop_issue.title, re.tasks], ['awaiting-ruling', 'Progress of T00 not committed', [{ id: 'T00', status: 'merged', attempts: 1, branch: 'task/T00' }]])
  drained('V8a', q)
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
  assert.deepEqual(progressOf(calls, 'T00 · progress')[1].E, { task: 'T00', status: 'merged', attempts: 1, branch: 'task/T00', entries: [{ type: 'review', severity: 'major', description: '.env.example: add MR_MAX' }], flaky: ['journal.spec.ts:53'], unverifiable: [UV], reviews: ['.env.example: add MR_MAX'], replanning: true })
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
// A task file that plan-lint accepts, and that close writes from the content of an added task (0.20.0)
const taskText = (id, dep, phase = 1) => `---\nid: ${id}\ntitle: Task ${id}\nphase: ${phase}\nmodel: sonnet\ndepends_on: [${dep.join(', ')}]\nparallel_batch: 1A\nowned_files:\n  - src/${id}/**\nresources: []\ntoken_estimate: 1.0M\nverification:\n  - "npm test"\ndefinition_of_done:\n  - "the test passes"\n---\n\n## Launch prompt\nYou carry out ${id}.\n`
// A plan in the 0.12 format (tasks/, PROGRESS.md, English keys): plan-lint refuses a French plan (taches/)
function toyRepo() {
  const root = fs.mkdtempSync(join(tmpdir(), 'scenarios-progress-'))
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  fs.writeFileSync(join(root, 'README.md'), 'x\n'); git('add', '.'); git('commit', '-qm', 'init')
  const d = join(root, 'plans', 'p')
  fs.mkdirSync(join(d, 'tasks'), { recursive: true })
  const writeTask = (id, dep) => fs.writeFileSync(join(d, 'tasks', `${id}-x.md`), taskText(id, dep))
  writeTask('T00', []); writeTask('T01', ['T00'])
  fs.writeFileSync(join(d, 'PROGRESS.md'), '# PROGRESS — p\n\n| ID | Title | Phase | Batch | Depends on | Model | Status | Attempts | Branch | Tokens est. / actual |\n|---|---|---|---|---|---|---|---|---|---|\n| T00 | Task T00 | 1 | 1A | — | sonnet | todo | 0 | — | 1.0M / — |\n| T01 | Task T01 | 1 | 1A | T00 | sonnet | todo | 0 | — | 1.0M / — |\n\nStatuses: todo · added · merged · blocked · failed · needs-human · cancelled\n')
  fs.writeFileSync(join(d, 'HANDOFF.md'), '# HANDOFF — p\n\nEntries: `deviation`, `blind-spot`, `decision`, `debt`, `needs-human`, `ticket`, `review`, rated `minor` or `major`.\n')
  fs.writeFileSync(join(d, 'DISCOVERY.md'), '# DISCOVERY — p\n\n## Existing context\n\n## Verified commands\n\n## Quick map\n\n## Observed conventions\n\n## Pitfalls and fixes\n\n## Context recommendations (end of run)\n')
  fs.writeFileSync(join(d, 'orchestre.config.json'), JSON.stringify({ integration_branch: 'plan/p' }))
  git('switch', '-qc', 'plan/p'); git('add', '.'); git('commit', '-qm', 'plan')
  return { root, git, writeTask, doc: () => JSON.parse(fs.readFileSync(join(d, 'progress.json'), 'utf8')), row: id => fs.readFileSync(join(d, 'PROGRESS.md'), 'utf8').split('\n').find(l => l.startsWith(`| ${id} `)) }
}
// The refusal of Claude Code's isolation guard, as an isolated worker reported it on a real run
const GUARD = 'This agent is isolated in a worktree, but this command is in a form too complex to verify that it stays inside the worktree. Refusing to run it.'
// Each progress command of the instruction goes through the shell, in order; the report carries their exit codes
async function play(name, D, q, args = {}) {
  const launched = [], unexpected = [], calls = []
  const agent = async (prompt, opts = {}) => {
    const k = opts.label
    calls.push({ label: k, prompt })
    if (!(k in q) || !q[k].length) { unexpected.push(k); throw new Error(`[${name}] unexpected call: ${k}`) }
    const v0 = q[k].shift(), cs = progressCommands(prompt)
    // null: an agent that did not answer (expired login, usage limit) ran nothing either (0.19.0)
    if (v0 === null) return null
    // { before, answer }: what the agent does before its progress commands (the scribe writes DISCOVERY.md)
    // { tamper, answer } (0.20.0): the agent changes the command it runs, as a copy altered on the way
    const v = v0 && typeof v0 === 'object' && 'before' in v0 ? (v0.before(), v0.answer) : v0 && typeof v0 === 'object' && 'tamper' in v0 ? v0.answer : v0
    const tamper = v0 && typeof v0 === 'object' && 'tamper' in v0 ? v0.tamper : c => c
    // An agent isolated in a worktree is refused its progress commands by Claude Code's isolation guard (0.18.2): none is launched
    const codes = cs.map(c => {
      if (opts.isolation === 'worktree') { launched.push({ label: k, code: 1, out: '', err: GUARD }); return 1 }
      const r = spawnSync('sh', ['-c', bashTool(tamper(c))], { cwd: D.root, encoding: 'utf8' }); launched.push({ label: k, code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }); return r.status
    })
    // The output of close, copied as printed (0.20.0), and the first line of the error of the last command
    const lastRun = launched[launched.length - 1]
    const closeOutput = cs.length && /progress\.mjs"? close /.test(cs[cs.length - 1]) && codes[codes.length - 1] === 0 ? JSON.parse(lastRun.out) : null
    const answer = sealed(k, typeof v === 'function' ? await v(prompt, opts) : v, prompt)
    // The clerk also runs the cleaning of the worktrees: its last line goes in "worktrees"
    const wt = [...prompt.matchAll(/`(node "?[^`"]*worktrees\.mjs"? clean [^`]*)`/g)].map(m => m[1])
    const cleaning = wt.map(c => { const r = spawnSync('sh', ['-c', c], { cwd: D.root, encoding: 'utf8' }); launched.push({ label: k, code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }); return r.stdout.trim() || r.stderr.trim() }).pop()
    if (!cs.length) return answer
    const failed = codes[codes.length - 1] !== 0 && opts.isolation !== 'worktree' ? { progress_error: lastRun.err.split('\n')[0] } : {}
    const opens = cs[0].includes('progress.mjs" run-start') || cs[0].includes('progress.mjs run-start')
    // apply (0.20.0), after a run-start that passed: its output copied as printed, or its error
    let applied = {}
    if (opens && codes[0] === 0 && applyCmdIn(prompt) && !('apply' in answer)) {
      const r = spawnSync('sh', ['-c', applyCmdIn(prompt)], { cwd: D.root, encoding: 'utf8' }); launched.push({ label: k, code: r.status, out: r.stdout.trim(), err: r.stderr.trim() })
      applied = r.status === 0 ? { apply_ok: true, apply: JSON.parse(r.stdout) } : { apply_ok: false, apply_error: r.stderr.trim().split('\n')[0] }
    }
    return { ...answer, ...(opens ? { run_start_ok: codes[0] === 0 } : {}), ...applied, progress_ok: codes[codes.length - 1] === 0, ...failed, ...(closeOutput && !('close' in answer) ? { close: closeOutput } : {}), ...(cleaning ? { worktrees: cleaning } : {}) }
  }
  last = null
  const res = await run({ ...ARGS, progress: PROGRESS_SCRIPT, ...args }, agent, () => {}, () => {})
  last = { res, launched }
  assert.deepEqual(unexpected, [], `[${name}] call without an answer`)
  return { res, launched, calls }
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
    assert.equal(launched.length, 15, '13 progress commands, apply (0.20.0, without a ruling) and the cleaning of the worktrees: T01, without a finding, closes through the clerk, without a step')
    assert.equal(res.status, 'partial'); assert.deepEqual(res.progress_failures, [])
    const doc = D.doc(), t = id => doc.tasks.find(x => x.id === id)
    assert.deepEqual(doc.runs.map(r => [r.number, r.status, r.phase, r.mode, r.parallelism, r.end !== null]), [[1, 'partial', 1, 'phase', 4, true]])
    assert.deepEqual([t('T00').status, t('T00').attempts, t('T00').branch, t('T00').step, t('T00').isolated], ['merged', 2, 'task/T00', null, false])
    assert.deepEqual(t('T00').rejections, [{ attempt: 1, by: 'evaluation', gaps: [M] }])
    assert.deepEqual([t('T01').status, t('T01').attempts, t('T01').blocker, t('T01').step], ['blocked', 1, ['ambiguous schema'], null])
    assert.deepEqual(doc.log.filter(e => e.task === 'T00').map(e => e.text), ['T00 starts (main checkout)', 'T00: verification', 'T00: evaluation', 'T00: attempt 1 rejected (evaluation): 1 gap(s)', 'T00: fix (attempt 2)', 'T00: verification', 'T00: evaluation', 'T00: merge', 'T00: progress', 'T00: merged (2 attempts)'])
    assert.deepEqual(doc.log.filter(e => e.task === 'T01').map(e => e.text), ['T01 starts (main checkout)', 'T01: replanning finished', 'T01: blocked (1 attempt) — ambiguous schema'])
    assert.match(D.row('T00'), /\| merged  \| 2 +\| task\/T00 \| 1\.0M \/ see \/workflows \|$/)
    assert.match(D.row('T01'), /\| blocked +\| 1 +\| task\/T01 \|/)
    // 0.20.0: close wrote HANDOFF.md and committed the plan, one commit per close; the scribe wrote DISCOVERY.md only
    const handoff = fs.readFileSync(join(D.root, 'plans', 'p', 'HANDOFF.md'), 'utf8')
    assert.ok(handoff.includes(`## T00\n\n- rejection · minor · attempt 1, evaluation: ${M}\n`) && handoff.includes('## T01\n\n- blocker · major · ambiguous schema\n'), handoff)
    assert.deepEqual(D.git('log', '--format=%s', '-2').trim().split('\n'), ['progress(T01): blocked', 'progress(T00): merged'])
    assert.equal(launched.find(l => l.label === 'run end · progress').out, 'progress: run 1 partial', 'nothing to commit for the clerk')
    assert.equal(launched[launched.length - 1].out, 'worktrees plans/p: 0 removed, 0 kept')
    assert.equal(spawnSync(process.execPath, [PROGRESS_SCRIPT, 'validate', 'plans/p'], { cwd: D.root }).status, 0)
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
await test('V11b (issue #1): real progress.mjs through the Bash tool that decodes \\uXXXX — apostrophes, backticks, $, globs and a literal \\u0027 reach progress.json as written', async () => {
  const D = toyRepo()
  BASH_TOOL.decodes = true
  try {
    // The texts of the issue: French free text, code names in Markdown, a variable, an issue title
    const GAP = "l'hôte de `bodyStrippedPathPrefixes` ignore $bodyStrippedPathPrefixes (phase 3), *.ts, et le texte \\u0027 tel quel"
    const REVIEW = "relire `src/l'hôte.ts` d'un œil (phase 3), $HOME"
    const BLOCKER = "d'un `run-end` qui casse : $(echo boom) (phase 3), *"
    const { res, launched } = await play('V11b', D, {
      'plan-reader': [plan(T0, T1)], 'T00 · worker': [report(0, { deviations: [{ type: 'review', description: REVIEW }] })], 'T00 · verification': [ok(1), ok(2)],
      'T00 · evaluation': [{ verdict: 'fail', gaps: [GAP] }, { verdict: 'pass' }], 'T00 · fix 1': [report(1)], 'T00 · merge': [MOK], 'T00 · replanning': [NOTHING], 'T00 · progress': [SOK],
      'T01 · worker': [{ status: 'blocked', summary: 'blocked', branch: 'task/T01', path: D.root, blocker: BLOCKER }], 'T01 · replanning': [NOTHING], 'T01 · progress': [SOK],
      'run end · progress': [{ commit: '', detail: '' }] })
    assert.deepEqual(launched.filter(l => l.code !== 0), [], 'every progress command passes the decoding')
    assert.deepEqual(res.progress_failures, [])
    const doc = D.doc(), t = id => doc.tasks.find(x => x.id === id)
    assert.deepEqual(t('T00').rejections, [{ attempt: 1, by: 'evaluation', gaps: [GAP] }], 'the gap as written, its literal \\u0027 included')
    assert.ok(doc.reviews.some(r => r.task === 'T00' && r.text === REVIEW), JSON.stringify(doc.reviews))
    assert.deepEqual(t('T01').blocker, [BLOCKER])
    assert.equal(doc.runs[0].status, 'partial', 'run-end written: the run no longer stays in progress')
    // The form of 0.17, through the same decoding: the \u0027 becomes a quote again and the shell breaks
    const E = { task: 'T01', status: 'cancelled', reason: "l'hôte `x` $y" }
    const old = `"${process.execPath}" "${PROGRESS_SCRIPT}" pilot plans/p --json '${JSON.stringify(E).replace(/'/g, '\\u0027').replace(/`/g, '\\u0060').replace(/\$/g, '\\u0024')}'`
    assert.notEqual(spawnSync('sh', ['-c', bashTool(old)], { cwd: D.root, encoding: 'utf8' }).status, 0, 'the 0.17 form breaks under the decoding')
    const now = `"${process.execPath}" "${PROGRESS_SCRIPT}" pilot plans/p <<'ORCHESTRE_JSON'\n${JSON.stringify(E)}\nORCHESTRE_JSON`
    const r = spawnSync('sh', ['-c', bashTool(now)], { cwd: D.root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(D.doc().log.some(e => e.kind === 'pilot' && e.text.includes("l'hôte `x` $y")))
  } finally { BASH_TOOL.decodes = false; fs.rmSync(D.root, { recursive: true, force: true }) }
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
// The real progress.mjs run directly in a toy repository, as the pilot does between two runs (0.20.0): rule records the user's
// rulings; seed raises issues through a close of T00 in a run of its own, as a stopped run leaves them
const script = (D, cmd, E) => { const r = spawnSync(process.execPath, [PROGRESS_SCRIPT, cmd, 'plans/p', ...(E ? ['--json', JSON.stringify(E)] : [])], { cwd: D.root, encoding: 'utf8' }); assert.equal(r.status, 0, `${cmd}: ${r.stderr}`); return r.stdout.trim() }
const seed = (D, issues) => {
  script(D, 'run-start', { phase: 1, mode: 'phase', parallelism: 4, max_fixes: 2, max_auto_decisions: 3 })
  const out = JSON.parse(script(D, 'close', { task: 'T00', status: 'needs-human', attempts: 1, branch: 'task/T00', issues }))
  script(D, 'run-end', { status: 'awaiting-ruling', tasks: [], open_issues: [] })
  if (D.git('status', '--porcelain').trim()) D.git('commit', '-qam', 'progress: end of run 1')
  return out.issues
}
const register = D => JSON.parse(fs.readFileSync(join(D.root, 'plans', 'p', 'ISSUES.json'), 'utf8'))
await test('V14: real progress.mjs — full close in autonomous mode (auto-decision, added task, stop issue, review), then ruling at the next run', async () => {
  const D = toyRepo()
  try {
    const P2 = { title: 'Two recommended', context: "either one, the user's call", options: [{ id: 'A', description: 'a', recommended: true, entries: [{ type: 'debt', severity: 'minor', description: 'x' }] }, { id: 'B', description: 'b', recommended: true }] }
    const R = { type: 'review', description: '.env.example: add MR_MAX' }
    // 0.20.0: the option's task carries a content plan-lint accepts (phase 0, brought back to 1); close writes it, the scribe no longer does
    const [A, B] = RP_E.issues[0].options
    const RP = { ...RP_E, issues: [{ ...RP_E.issues[0], options: [{ ...A, added_tasks: [{ id: 'T00C', title: 'Rule d test', phase: 0, content: taskText('T00C', ['T00'], 0) }] }, B] }, P2] }
    const run1 = await play('V14a', D, {
      'plan-reader': [plan(T0, T1)], 'T00 · worker': [report(0, { deviations: [...DEVIATION, R] })], 'T00 · verification': [ok(1)], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [MOK],
      'T00 · replanning': [RP], 'T00 · progress': [SOK], 'run end · progress': [{ commit: '', detail: '' }] }, { mode: 'auto' })
    assert.deepEqual(run1.launched.filter(l => l.code !== 0), [])
    assert.equal(run1.res.status, 'awaiting-ruling'); assert.deepEqual(run1.res.progress_failures, [])
    let doc = D.doc()
    assert.deepEqual(doc.tasks.map(x => [x.id, x.status, x.added_by]), [['T00', 'merged', null], ['T00C', 'added', 'T00'], ['T01', 'todo', null]])
    assert.deepEqual(doc.auto_decisions, [{ run: 1, task: 'T00', title: 'UpdateUserSchema contract', option: 'A', description: 'Keep optional and test rule (d)' }])
    assert.deepEqual(doc.issues.map(p => [p.run, p.task, p.title, p.role, p.status, p.options.length]), [[1, 'T00', 'Two recommended', 'stop', 'open', 2], [1, 'T00', 'UpdateUserSchema contract', 'open', 'settled', 2]])
    assert.deepEqual(doc.reviews.map(r => [r.task, r.text, r.run]), [['T00', '.env.example: add MR_MAX', 1]])
    assert.deepEqual([doc.runs[0].status, doc.runs[0].added_tasks, doc.runs[0].not_started], ['awaiting-ruling', [{ id: 'T00C', phase: 1, title: 'Rule d test' }], ['T01']])
    assert.ok(doc.log.some(e => e.kind === 'amendment' && e.task === 'T01'))
    assert.ok(/\| T00C \| Rule d test /.test(D.row('T00C')), 'row added by the script, title from the replanner')
    // close applied the decided option and committed it: the task file, the amendment, HANDOFF.md and ISSUES.json, nothing left over
    const P = join(D.root, 'plans', 'p')
    assert.ok(fs.readFileSync(join(P, 'tasks', 'T00C-rule-d-test.md'), 'utf8').startsWith('---\nid: T00C\ntitle: Task T00C\nphase: 1\n'))
    assert.ok(fs.readFileSync(join(P, 'tasks', 'T01-x.md'), 'utf8').includes('  - "pnpm test:rule-d"'))
    assert.ok(fs.readFileSync(join(P, 'HANDOFF.md'), 'utf8').includes('- decision · major · UpdateUserSchema contract: option A taken automatically (autonomous mode) — Keep optional and test rule (d)\n- debt · minor · document the contract\n'))
    const reg = JSON.parse(fs.readFileSync(join(P, 'ISSUES.json'), 'utf8'))
    assert.deepEqual(reg.issues.map(p => [p.title, p.status, p.ruling ? p.ruling.author : null]), [['Two recommended', 'open', null], ['UpdateUserSchema contract', 'settled', 'auto']])
    assert.equal(D.git('status', '--porcelain'), '', 'close committed the whole close')
    // Run 2 (0.20.0): the user settles "Two recommended" with rule, between the runs; the plan reader opens the run and applies it
    const id = reg.issues.find(p => p.title === 'Two recommended').id
    script(D, 'rule', { issue: id, option: 'A' })
    const run2 = await play('V14b', D, { 'plan-reader': [plan({ ...T0, status: 'merged' })], 'run end · progress': [{ commit: '', detail: '' }] })
    assert.deepEqual(run2.launched.filter(l => l.code !== 0), [])
    const out = JSON.parse(run2.launched[1].out)
    assert.deepEqual([run2.launched[0].out.split(';')[0], out.applied, out.rejected, out.message.split(';')[0]], ['progress: run 2 opened (phase 1, mode phase)', [{ issue: id, task: 'T00', option: 'A', text: null }], [], `1 ruling applied (${id})`])
    assert.deepEqual(run2.launched.slice(2).map(l => l.out.split(';')[0]), ['progress: run 2 finished', 'worktrees plans/p: 0 removed, 0 kept'])
    assert.equal(run2.res.status, 'finished'); assert.deepEqual(run2.res.rulings_applied, [{ issue: id, task: 'T00', option: 'A', text: null }])
    doc = D.doc()
    assert.deepEqual([doc.issues[0].status, doc.issues[0].chosen_option], ['settled', 'A'])
    assert.deepEqual(doc.runs.map(r => [r.number, r.status]), [[1, 'awaiting-ruling'], [2, 'finished']])
    assert.deepEqual(doc.runs[1].rulings_applied, [{ task: 'T00', title: 'Two recommended', option: 'A' }], 'kept by run-end: the summary no longer carries rulings_applied')
    assert.ok(fs.readFileSync(join(P, 'HANDOFF.md'), 'utf8').includes('- decision · major · Two recommended: option A settled by the user — a\n- debt · minor · x\n'))
    assert.deepEqual(register(D).issues.find(p => p.id === id).ruling.author, 'user')
    assert.equal(D.git('log', '--format=%s', '-1').trim(), `progress: rulings ${id}`)
    assert.equal(spawnSync(process.execPath, [PROGRESS_SCRIPT, 'validate', 'plans/p'], { cwd: D.root }).status, 0)
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
await test('V15: real progress.mjs — task added by a ruling (apply) kept in the run despite the run-end summary, which does not know it', async () => {
  const D = toyRepo()
  try {
    const [id] = seed(D, [{ title: 'Contract', context: 'c', human: false, options: [{ id: 'B', description: 'Test', recommended: true, added_tasks: [{ id: 'T00D', title: 'Contract test', phase: 1, content: taskText('T00D', ['T00']) }] }, { id: 'C', description: 'Leave it' }] }])
    script(D, 'rule', { issue: id, option: 'B' })
    const r = await play('V15', D, { 'plan-reader': [plan({ ...T0, status: 'needs-human' })], 'run end · progress': [{ commit: '', detail: '' }] })
    assert.deepEqual(r.launched.filter(l => l.code !== 0), [])
    assert.deepEqual(JSON.parse(r.launched[1].out).added_tasks, [{ id: 'T00D', title: 'Contract test', phase: 1 }])
    const doc = D.doc()
    assert.deepEqual(doc.runs[1].added_tasks, [{ id: 'T00D', phase: 1, title: 'Contract test' }])
    assert.deepEqual(doc.tasks.find(x => x.id === 'T00D').added_by, 'T00')
    assert.deepEqual(r.res.added_tasks, [], 'not an added task of the run: the plan read after apply already has it')
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
  assert.deepEqual([c1.opts.agentType, c1.opts.model, c1.opts.effort, c1.opts.schema.required, c1.opts.schema.properties.model.enum], ['orchestre:replanner', 'opus', 'low', ['model', 'reason'], ['haiku', 'sonnet', 'opus']])
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
    assert.deepEqual([doc.format, t.model, t.model_used, t.status], ['orchestre-progress/4', 'sonnet', 'opus', 'merged'])
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
  const WRITERS = ['T05 · worker', 'T05 · fix 1', 'T05 · evaluation', 'T05 · replanning', 'T05 · model choice 1', 'T05 · progress']
  const OTHERS = ['plan-reader', 'T05 · verification', 'T05 · merge', 'run end · progress']
  const queue = () => ({ 'plan-reader': [planOpened(TM('sonnet'))], 'T05 · worker': [report5(0, { deviations: DEVIATION })], 'T05 · verification': [ok5(1), ok5(2)],
    'T05 · evaluation': [fail5('M1'), withProgress({ verdict: 'pass' })], 'T05 · model choice 1': [{ model: 'sonnet', reason: 'r' }], 'T05 · fix 1': [report5(1)], 'T05 · replanning': [NOTHING], ...end5() })
  for (const [language, expected] of [[undefined, 'en'], ['fr', 'fr'], [42, 'en'], ['   ', 'en']]) {
    const name = 'W3 ' + JSON.stringify(language)
    const { res, calls, q } = await scenario(name, queue(), { ...AP, ...(language === undefined ? {} : { language }) })
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
  for (const [name, args] of [['W4', {}], ['W4 progress', AP]]) {
    const queue = args.progress
      ? { 'plan-reader': [planOpened(T00)], ...s00(), 'run end · progress': [COK] }
      : { 'plan-reader': [plan(T00)], ...t00(), 'T00 · progress': [SOK] }
    const { res, calls, q } = await scenario(name, queue, args)
    assert.equal(res.status, 'finished')
    const w = byLabel(calls, 'T00 · worker')[0].prompt
    for (const x of ['`git switch -c task/T00`', 'refs/heads/task/T00 ', "'refs/heads/task/T00-r*'", 'task/T00-r<n>', '`git switch -c task/T00-r<n> <branch>`']) assert.ok(w.includes(x), `${name} · worker: ${x}`)
    assert.ok(calls.every(c => !c.prompt.includes('tache/')), `${name}: no prompt names tache/`)
    assert.ok(byLabel(calls, 'T00 · merge')[0].prompt.includes('`git merge --no-ff task/T00 -m "task T00: Tooling"`'), `${name}: merge message`)
    assert.ok(byLabel(calls, 'T00 · progress')[0].prompt.includes('with the message "progress(T00): merged"'), `${name}: scribe commit`)
    // HANDOFF entries copied word for word, whatever the language: progress.mjs matches the reviews with them. With progress
    // (0.20.0), close writes them from its input: the scribe's instruction no longer carries them
    assert.equal(byLabel(calls, 'T00 · progress')[0].prompt.includes('add these entries, word for word: ['), !args.progress, `${name}: entries word for word`)
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
  assert.ok(byLabel(calls, 'plan-reader')[0].prompt.includes('`node /plug/scripts/plan-lint.mjs "plans/my plan" --reader --phase 1 --integration plan/p`'))
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
await test('W11: a worktree is never removed by force (0.18.0) — kept by git, a review; uncommitted work seen by the verifier', async () => {
  assert.ok(!src.includes('remove --force'), 'run-phase.js asks for a forced removal of a worktree')
  const T02 = { ...T00, id: 'T02', title: 'Other', file: 'plans/p/tasks/T02.md', resources: [] }
  const T03 = { ...T00, id: 'T03', title: 'Again', file: 'plans/p/tasks/T03.md', resources: [] }
  const KEPT = "fatal: '/wt/T02' contains modified or untracked files, use --force to delete it"
  const tt = (id, verif = ok(id), merge = MOK) => ({ [`${id} · worker`]: [report(id, { branch: `task/${id}`, path: `/wt/${id}` })], [`${id} · verification`]: [verif], [`${id} · evaluation`]: [{ verdict: 'pass' }], [`${id} · merge`]: [merge], [`${id} · progress`]: [SOK] })
  const { res, calls, logs, q } = await scenario('W11', { 'plan-reader': [plan(T02, T03)], ...tt('T02', ok('T02'), { ...MOK, worktree_kept: KEPT }), ...tt('T03', { ...ok('T03'), uncommitted: ['dist/bundle.js'] }) })
  assert.equal(res.status, 'finished')
  const mg = byLabel(calls, 'T02 · merge')[0].prompt
  assert.ok(mg.includes('`git worktree remove "/wt/T02"`') && mg.includes('never with --force') && mg.includes('worktree_kept'), 'merge: removal without force')
  const vf = byLabel(calls, 'T02 · verification')[0].prompt
  assert.ok(vf.includes('`cd "/wt/T02" && git status --porcelain --untracked-files=all`') && vf.includes('owned_files, in plans/p/tasks/T02.md') && vf.includes('"uncommitted"'), 'verification: uncommitted work first')
  assert.deepEqual(res.reviews.map(x => x.task), ['T02'])
  assert.ok(res.reviews[0].review.startsWith(`worktree /wt/T02 kept after the merge of T02 (${KEPT})`), res.reviews[0].review)
  assert.ok(byLabel(calls, 'T02 · progress')[0].prompt.includes('worktree /wt/T02 kept after the merge'), 'scribe: the review in HANDOFF.md')
  assert.ok(logs.some(l => l === 'T02: worktree /wt/T02 kept, uncommitted work'))
  assert.ok(logs.some(l => l === "T03: uncommitted in /wt/T03, outside the task's files: dist/bundle.js"))
  assert.ok(!byLabel(calls, 'T03 · progress')[0].prompt.includes('kept after the merge'), 'T03: no review')
  drained('W11', q)
})
// ——— 0.18.1: the copy of the plan-reader checked against the digest of plan-lint --reader ———
const SECOND = 'plan-reader · second reading'
await test('R1: a copy that does not match its digest (status of T00 changed) → second reading, without run-start; the faithful copy runs', async () => {
  const wrong = { ...plan({ ...T00, status: 'merged' }), digest: planDigest(plan(T00)) }
  const { res, calls, logs, q } = await scenario('R1', { 'plan-reader': [wrong], [SECOND]: [plan(T00)], ...t00(), 'T00 · progress': [SOK] })
  assert.equal(res.status, 'finished'); assert.deepEqual(res.tasks.map(t => [t.id, t.status]), [['T00', 'merged']], 'T00 runs: the second copy says todo')
  assert.deepEqual(calls.slice(0, 3).map(c => c.opts.label), ['plan-reader', SECOND, 'T00 · worker'])
  const p2 = byLabel(calls, SECOND)[0]
  assert.ok(p2.prompt.startsWith('Your first copy of this output did not match its digest. Run `node /plug/scripts/plan-lint.mjs plans/p --reader --phase 1 --integration plan/p`'), p2.prompt)
  assert.equal(p2.opts.agentType, 'orchestre:plan-reader'); assert.equal(p2.opts.model, 'haiku'); assert.deepEqual(p2.opts.schema.required, ['ok', 'tasks', 'digest'])
  assert.ok(logs.some(l => l.startsWith(`plan-reader: copy of plan-lint that does not match its digest (${planDigest(plan(T00))}, ${planDigest(wrong)} computed); second reading`)), JSON.stringify(logs))
  drained('R1', q)
})
await test('R2: progress — two copies that do not match (a verification rephrased, then no digest) → error, no task started, a single run-start, the clerk closes the run', async () => {
  const rephrased = { ...planOpened({ ...T00, verification: ['typecheck', 'e2e'] }), digest: planDigest(plan(T00)) }
  const { res, calls, q } = await scenario('R2', { 'plan-reader': [rephrased], [SECOND]: [{ ...plan(T00), digest: undefined }], 'run end · progress': [COK] }, AP)
  assert.equal(res.status, 'error')
  assert.equal(res.detail, "plan-reader: two copies of plan-lint's output that do not match its digest; no task started. Launch a new run.")
  assert.deepEqual(calls.map(c => c.opts.label), ['plan-reader', SECOND, 'run end · progress'], 'no worker')
  assert.deepEqual(progressOf(calls, 'plan-reader').map(c => c.cmd), ['run-start'])
  assert.deepEqual(progressOf(calls, SECOND), [], 'the run is already open: no second run-start')
  assert.ok(!byLabel(calls, SECOND)[0].prompt.includes('run_start_ok'))
  assert.deepEqual(progressOf(calls, 'run end · progress').map(c => [c.cmd, c.E.status]), [['run-end', 'error']])
  drained('R2', q)
})
await test('R3: a copy that turns a plan in error into a valid plan → second reading; the errors of plan-lint stop the run, no task started', async () => {
  const truth = { ok: false, errors: ['T09: unknown dependency'], tasks: [] }
  const { res, calls, q } = await scenario('R3', { 'plan-reader': [{ ok: true, errors: [], tasks: [{ ...T00 }], digest: planDigest(truth) }], [SECOND]: [truth] })
  assert.equal(res.status, 'error'); assert.deepEqual(res.detail, ['T09: unknown dependency'])
  assert.deepEqual(calls.map(c => c.opts.label), ['plan-reader', SECOND])
  // Two copies that do not match, the second one of a plan in error: its errors, as copied, in the detail
  const r = await scenario('R3b', { 'plan-reader': [{ ...truth, digest: '00000000' }], [SECOND]: [{ ...truth, digest: '00000000' }] })
  assert.equal(r.res.detail, "plan-reader: two copies of plan-lint's output that do not match its digest; no task started. Launch a new run. plan-lint, as copied: T09: unknown dependency")
  drained('R3', q); drained('R3b', r.q)
})
await test('R4: the digest reads a field left out, empty or null alike, and changes with each field the workflow reads', () => {
  const base = { ok: true, errors: [], tasks: [{ ...T01, title: 'Foundations', model_reason: 'contract', effort: 'high', open_prerequisites: ['D1'] }], all: [{ id: 'T01', phase: 1, status: 'todo' }], max_phase: 2 }
  const d = planDigest(base)
  assert.match(d, /^[0-9a-f]{8}$/)
  assert.equal(planDigest({ ...base, errors: undefined }), d); assert.equal(planDigest({ ...base, tasks: [{ ...base.tasks[0], resources: null }] }), planDigest({ ...base, tasks: [{ ...base.tasks[0], resources: [] }] }))
  assert.equal(planDigest({ ...base, tasks: [{ ...base.tasks[0], model: undefined }] }), planDigest({ ...base, tasks: [{ ...base.tasks[0], model: '' }] }))
  assert.equal(planDigest({ ...base, digest: 'x', run_start_ok: true, progress_error: 'y', warnings: ['w'] }), d, 'only the fields the workflow reads')
  const t = base.tasks[0]
  const changes = [{ ok: false }, { errors: ['e'] }, { max_phase: 3 }, { all: [{ id: 'T01', phase: 1, status: 'merged' }] }, { all: [] },
    ...['id', 'title', 'file', 'model', 'model_reason', 'effort', 'status'].map(k => ({ tasks: [{ ...t, [k]: t[k] + 'x' }] })), { tasks: [{ ...t, phase: 2 }] },
    ...['depends_on', 'resources', 'verification', 'open_prerequisites'].map(k => ({ tasks: [{ ...t, [k]: [...t[k], 'x'] }] })), { tasks: [] }, { tasks: [t, t] }]
  for (const c of changes) assert.notEqual(planDigest({ ...base, ...c }), d, JSON.stringify(c))
  // Robust to a copy of any shape: never an exception
  for (const x of [{}, { tasks: [null, 3, 'T01'] }, { tasks: 'T01', all: {} }]) assert.match(planDigest(x), /^[0-9a-f]{8}$/)
})
await test('R5: real plan-lint --reader read by a plan-reader that copies its output → digest that matches, a single reading, the run goes on', async () => {
  const D = toyRepo()
  const LINT_SCRIPT = join(resolve(dirname(SRC), '..'), 'scripts', 'plan-lint.mjs')
  try {
    let printed = null
    const reader = prompt => {
      const cmd = prompt.match(/[Rr]un `([^`]*--reader[^`]*)`/)[1]
      const r = spawnSync('sh', ['-c', cmd], { cwd: D.root, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout.trim().split('\n').length, 1, 'one line of JSON, no warning')
      printed = JSON.parse(r.stdout)
      return printed
    }
    const { res } = await play('R5', D, {
      'plan-reader': [reader], 'T00 · worker': [report(0, { branch: 'task/T00' })], 'T00 · verification': [ok(1)], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [MOK], 'T00 · progress': [SOK],
      'T01 · worker': [{ status: 'blocked', summary: 'blocked', branch: 'task/T01', path: D.root, blocker: 'ambiguous schema' }], 'T01 · replanning': [NOTHING], 'T01 · progress': [SOK],
      'run end · progress': [{ commit: '', detail: '' }] }, { lint: LINT_SCRIPT })
    assert.deepEqual(Object.keys(printed), ['ok', 'errors', 'tasks', 'all', 'max_phase', 'digest'])
    assert.deepEqual(Object.keys(printed.tasks[0]), ['id', 'title', 'file', 'phase', 'model', 'effort', 'depends_on', 'resources', 'status', 'verification', 'open_prerequisites'])
    assert.equal(printed.digest, planDigest(printed), 'plan-lint and the workflow compute the same digest')
    assert.equal(res.status, 'partial'); assert.deepEqual(res.tasks.map(t => [t.id, t.status]), [['T00', 'merged'], ['T01', 'blocked']])
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
// ——— 0.18.2: the start of a task that works in a worktree is noted by the clerk, from the main checkout ———
// Claude Code's isolation guard refuses a progress command to an agent isolated in a worktree: the worker step was never
// written, and the task showed as not started for the whole of its worker
const P2 = { ...T00, id: 'T02', title: 'Other', file: 'plans/p/tasks/T02.md', resources: [] }
const P3 = { ...T00, id: 'T03', title: 'Again', file: 'plans/p/tasks/T03.md', model: 'opus', resources: [] }
const iso = (id, extra = {}) => ({ [`${id} · start`]: [COK], [`${id} · worker`]: [report(id, { branch: `task/${id}`, path: `/wt/${id}` })], [`${id} · verification`]: [withProgress(ok(id))], [`${id} · evaluation`]: [withProgress({ verdict: 'pass' })], [`${id} · merge`]: [withProgress(MOK)], [`${id} · progress`]: [withProgress(SOK)], ...extra })
const starts = calls => calls.filter(c => / · start$/.test(c.opts.label))
await test('X1: progress — a task in a worktree: the clerk notes its start before the worker, which carries no progress command; its fix keeps its step; nothing changes in the main checkout nor without progress', async () => {
  const { res, calls, q } = await scenario('X1', { 'plan-reader': [planOpened(P2, P3)],
    ...iso('T02', { 'T02 · verification': [withProgress(ok(1)), withProgress(ok(2))], 'T02 · evaluation': [withProgress({ verdict: 'fail', gaps: ['G1'] }), withProgress({ verdict: 'pass' })], 'T02 · fix 1': [withProgress(report('fix', { branch: 'task/T02', path: '/wt/T02' }))] }),
    ...iso('T03'), 'run end · progress': [COK] }, AP)
  assert.equal(res.status, 'finished')
  // The isolated worker returns no progress_ok: nothing is expected from it any more
  assert.deepEqual(res.progress_failures, [])
  assert.equal(starts(calls).length, 2)
  for (const [id, model] of [['T02', 'sonnet'], ['T03', 'opus']]) {
    const st = byLabel(calls, `${id} · start`)[0], w = byLabel(calls, `${id} · worker`)[0]
    assert.ok(idx(calls, `${id} · start`) < idx(calls, `${id} · worker`), id + ': the start before the worker')
    assert.deepEqual([st.opts.agentType, st.opts.model, st.opts.isolation, st.opts.schema.required], ['orchestre:clerk', 'haiku', undefined, ['progress_ok']])
    assert.deepEqual(progressOf(calls, `${id} · start`), [{ cmd: 'step', plan: 'plans/p', E: { task: id, step: 'worker', isolated: true, model } }])
    for (const x of ['git ', 'worktrees.mjs', 'run-end']) assert.ok(!st.prompt.includes(x), `${id} · start: no "${x}"`)
    assert.ok(st.prompt.includes('Your only command is the one below') && st.prompt.includes('Run nothing else and change no file'))
    assert.deepEqual([w.opts.agentType, w.opts.isolation, w.opts.model], ['orchestre:isolated-worker', 'worktree', model])
    assert.ok(w.prompt.startsWith(`Task ${id} of the plan plans/p.`) && !w.prompt.includes('progress.mjs') && !w.prompt.includes('ORCHESTRE_JSON'), id + ': the isolated worker carries no progress command')
    assert.ok(!('progress_ok' in w.opts.schema.properties) && !('progress_error' in w.opts.schema.properties) && 'deviations' in w.opts.schema.properties, id + ': no progress result in the report of the isolated worker')
    assert.deepEqual(w.opts.schema.required, ['status', 'summary', 'branch', 'path'])
  }
  // The fix of a task in a worktree is not isolated (it works there by cd): it keeps its step, as the agents that follow
  const fx = byLabel(calls, 'T02 · fix 1')[0]
  assert.deepEqual([fx.opts.agentType, fx.opts.isolation], ['orchestre:worker', undefined])
  assert.deepEqual(progressOf(calls, 'T02 · fix 1').map(c => [c.cmd, c.E.step]), [['step', 'fix']])
  assert.ok('progress_ok' in fx.opts.schema.properties, 'the fix reports the result of its step')
  for (const l of ['T02 · fix 1', 'T02 · verification', 'T02 · evaluation', 'T02 · merge']) assert.ok(byLabel(calls, l)[0].prompt.startsWith(HEADER), l + ': step first')
  drained('X1', q)
  // Parallelism of 1: main checkout, where the guard does not apply; the worker runs its step itself, no clerk at the start
  const main = id => ({ [`${id} · worker`]: [withProgress(report(id, { branch: `task/${id}` }))], [`${id} · verification`]: [withProgress(ok(id))], [`${id} · evaluation`]: [withProgress({ verdict: 'pass' })], [`${id} · merge`]: [withProgress(MOK)], [`${id} · progress`]: [withProgress(SOK)] })
  const m = await scenario('X1 main checkout', { 'plan-reader': [planOpened(P2, P3)], ...main('T02'), ...main('T03'), 'run end · progress': [COK] }, { ...AP, parallelism: 1 })
  assert.equal(m.res.status, 'finished'); assert.deepEqual(m.res.progress_failures, []); assert.equal(starts(m.calls).length, 0)
  assert.ok(byLabel(m.calls, 'T03 · worker')[0].prompt.startsWith(HEADER) && 'progress_ok' in byLabel(m.calls, 'T03 · worker')[0].opts.schema.properties)
  assert.deepEqual(progressOf(m.calls, 'T03 · worker'), [{ cmd: 'step', plan: 'plans/p', E: { task: 'T03', step: 'worker', isolated: false, model: 'opus' } }])
  drained('X1 main checkout', m.q)
  // Without progress: no clerk at the start, in a worktree as elsewhere
  const bare = id => ({ [`${id} · worker`]: [report(id, { branch: `task/${id}`, path: `/wt/${id}` })], [`${id} · verification`]: [ok(id)], [`${id} · evaluation`]: [{ verdict: 'pass' }], [`${id} · merge`]: [MOK], [`${id} · progress`]: [SOK] })
  const w = await scenario('X1 without progress', { 'plan-reader': [plan(P2, P3)], ...bare('T02'), ...bare('T03') })
  assert.equal(w.res.status, 'finished'); assert.ok(!('progress_failures' in w.res)); assert.equal(starts(w.calls).length, 0)
  assert.equal(byLabel(w.calls, 'T02 · worker')[0].opts.isolation, 'worktree')
  drained('X1 without progress', w.q)
})
await test('X2: progress — the clerk of a task start fails, does not answer or throws: only the display suffers, the worker starts and the failure goes to progress_failures', async () => {
  const cases = [
    ['X2a', { progress_ok: false, progress_error: 'progress: lock held' }, 'progress: lock held'], ['X2b', { progress_ok: false }, 'failure without a message'], ['X2c', {}, 'result not reported'],
    ['X2d', null, 'clerk without an answer'], ['X2e', () => { throw new Error('usage limit') }, 'clerk failed: Error: usage limit'],
  ]
  for (const [name, answer, error] of cases) {
    const { res, calls, q } = await scenario(name, { 'plan-reader': [planOpened(P2, P3)], ...iso('T02', { 'T02 · start': [answer] }), ...iso('T03'), 'run end · progress': [COK] }, AP)
    assert.equal(res.status, 'finished', name); assert.deepEqual(res.tasks.map(t => [t.id, t.status]), [['T02', 'merged'], ['T03', 'merged']], name)
    assert.deepEqual(res.progress_failures, [{ task: 'T02', step: 'worker', error }], name)
    assert.ok(idx(calls, 'T02 · start') < idx(calls, 'T02 · worker'), name + ': the worker starts all the same, after the clerk')
    drained(name, q)
  }
  // An isolated worker that still reports a progress result (rules of an earlier version loaded): nothing is read from it
  const { res, q } = await scenario('X2f', { 'plan-reader': [planOpened(P2, P3)], ...iso('T02', { 'T02 · worker': [{ ...report('T02', { branch: 'task/T02', path: '/wt/T02' }), progress_ok: false, progress_error: GUARD }] }), ...iso('T03'), 'run end · progress': [COK] }, AP)
  assert.equal(res.status, 'finished'); assert.deepEqual(res.progress_failures, [])
  drained('X2f', q)
  // The start is awaited: the worker is launched once the clerk has answered, so that its step is written before the next ones
  const order = []
  const g = await scenario('X2g', { 'plan-reader': [planOpened(P2, P3)], ...iso('T02', { 'T02 · start': [async () => { await new Promise(r => setTimeout(r, 20)); order.push('T02 clerk'); return COK }], 'T02 · worker': [() => { order.push('T02 worker'); return report('T02', { branch: 'task/T02', path: '/wt/T02' }) }] }), ...iso('T03'), 'run end · progress': [COK] }, AP)
  assert.deepEqual(order, ['T02 clerk', 'T02 worker']); assert.deepEqual(g.res.progress_failures, [])
  drained('X2g', g.q)
})
await test('X3: real progress.mjs, under an isolation guard that refuses the progress commands of an isolated agent — while each worker runs in its worktree, progress.json holds its worker step', async () => {
  const D = toyRepo()
  try {
    D.writeTask('T02', []); D.writeTask('T03', [])
    const R2 = { ...T0, id: 'T02', title: 'Task T02', file: 'plans/p/tasks/T02-x.md' }, R3 = { ...T0, id: 'T03', title: 'Task T03', file: 'plans/p/tasks/T03-x.md' }
    // What progress.json holds of the task when its worker starts: the mod shows a task in progress from its step
    const during = {}
    const worker = id => () => { const t = D.doc().tasks.find(x => x.id === id); during[id] = [t.step, t.isolated, t.model_used, D.doc().runs[0].status]; return report(id, { branch: `task/${id}`, path: D.root }) }
    const real = id => ({ [`${id} · start`]: [{}], [`${id} · worker`]: [worker(id)], [`${id} · verification`]: [ok(id)], [`${id} · evaluation`]: [{ verdict: 'pass' }], [`${id} · merge`]: [MOK], [`${id} · progress`]: [SOK] })
    const { res, launched } = await play('X3', D, { 'plan-reader': [plan(R2, R3)], ...real('T02'), ...real('T03'), 'run end · progress': [{ commit: '', detail: '' }] })
    assert.deepEqual(launched.filter(l => l.code !== 0), [], 'nothing for the guard to refuse: no progress command goes to an isolated agent')
    assert.equal(res.status, 'finished'); assert.deepEqual(res.progress_failures, [])
    assert.deepEqual(during, { T02: ['worker', true, 'sonnet', 'in-progress'], T03: ['worker', true, 'sonnet', 'in-progress'] })
    assert.deepEqual(launched.filter(l => / · start$/.test(l.label)).map(l => [l.label, l.out]), [['T02 · start', 'progress: T02 → worker (sonnet)'], ['T03 · start', 'progress: T03 → worker (sonnet)']])
    const doc = D.doc()
    for (const id of ['T02', 'T03']) {
      assert.deepEqual(doc.log.filter(e => e.task === id && e.kind !== 'added').map(e => e.text), [`${id} starts (worktree)`, `${id}: verification`, `${id}: evaluation`, `${id}: merge`, `${id}: progress`, `${id}: merged (1 attempt)`], id)
      const t = doc.tasks.find(x => x.id === id)
      assert.deepEqual([t.status, t.step, t.isolated], ['merged', null, true], id)
    }
    assert.equal(spawnSync(process.execPath, [PROGRESS_SCRIPT, 'validate', 'plans/p'], { cwd: D.root }).status, 0)
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
// ——— 0.19.0: circuit breaker, agents not answering ———
// On a real run (0.18.1) the login expired: every agent came back without an answer, and each close turned that into issues
// ("Replanning without an answer", "Progress not committed"); the run stayed in progress for hours
const SILENT = 'agents not answering: 2 calls in a row without an answer'
const silentDetail = (labels, ids) => `${SILENT} (${labels}). Login expired, usage limit or network. ${ids} interrupted, their branches kept. Launch a new run once claude answers again.`
// T02 in the main checkout (parallelism 1), T03 independent and ready: the verifier then the fix do not answer
const y1 = (extra = {}) => ({ 'plan-reader': [planOpened(P2, P3)], 'T02 · worker': [withProgress(report('T02', { branch: 'task/T02' }))], 'T02 · verification': [null], 'T02 · fix 1': [null], 'run end · progress': [COK], ...extra })
await test('Y1: circuit breaker — two calls in a row without an answer → error, the task interrupted without a close (neither replanner, nor scribe, nor issue), no task starts any more', async () => {
  const { res, calls, q } = await scenario('Y1', y1(), { ...AP, parallelism: 1 })
  assert.equal(res.status, 'error')
  assert.equal(res.detail, silentDetail('T02 · verification, T02 · fix 1', 'T02'))
  assert.deepEqual(res.interrupted, ['T02']); assert.deepEqual(res.tasks, []); assert.deepEqual(res.not_started, ['T03'])
  assert.ok(!('stop_issue' in res)); assert.deepEqual(res.open_issues, []); assert.deepEqual(res.progress_failures, [])
  for (const l of ['T02 · replanning', 'T02 · progress', 'T03 · worker']) assert.equal(idx(calls, l), -1, l)
  // run-end: the run in error, no task closed (run-end clears the step of T02), no issue; "interrupted" is not for it
  const [end] = progressOf(calls, 'run end · progress')
  assert.deepEqual([end.cmd, end.E.status, end.E.detail, end.E.tasks, end.E.open_issues, end.E.not_started], ['run-end', 'error', res.detail, [], [], ['T03']])
  assert.ok(!('interrupted' in end.E) && !('stop_issue' in end.E))
  drained('Y1', q)
  // The second call without an answer throws (API error): the same
  const t = await scenario('Y1 throws', y1({ 'T02 · fix 1': [() => { throw new Error('401 authentication_error') }] }), { ...AP, parallelism: 1 })
  assert.deepEqual([t.res.status, t.res.detail, t.res.interrupted, t.res.tasks], ['error', res.detail, ['T02'], []])
  drained('Y1 throws', t.q)
})
await test('Y2: circuit breaker — the run end clerk does not answer either, or throws: the return stays error with the same detail', async () => {
  for (const [name, answer, error] of [['Y2 null', null, 'clerk without an answer'], ['Y2 throws', () => { throw new Error('401') }, 'clerk failed: Error: 401']]) {
    const { res, calls, q } = await scenario(name, y1({ 'run end · progress': [answer] }), { ...AP, parallelism: 1 })
    assert.deepEqual([res.status, res.detail, res.interrupted, res.tasks], ['error', silentDetail('T02 · verification, T02 · fix 1', 'T02'), ['T02'], []], name)
    assert.deepEqual(res.progress_failures, [{ task: null, step: 'run-end', error }], name)
    assert.equal(byLabel(calls, 'run end · progress').length, 1, name + ': the clerk is called after the breaker')
    drained(name, q)
  }
})
await test('Y3: circuit breaker — a task in flight at the threshold is not closed: it stops at its next call and comes out in "interrupted"', async () => {
  const e = deferred()
  const { res, calls, q } = await scenario('Y3', { 'plan-reader': [plan(P2, P3)],
    'T02 · worker': [null],
    // Second call in a row without an answer: the threshold; the worker of T03 answers afterwards
    'T02 · progress': [() => { setTimeout(() => e.resolve(), 0); return null }],
    'T03 · worker': [async () => { await e.promise; return report('T03', { branch: 'task/T03', path: '/wt/T03' }) }] })
  assert.equal(res.status, 'error'); assert.equal(res.detail, silentDetail('T02 · worker, T02 · progress', 'T02, T03'))
  assert.deepEqual(res.interrupted, ['T02', 'T03']); assert.deepEqual(res.tasks, [])
  assert.equal(byLabel(calls, 'T03 · worker')[0].opts.isolation, 'worktree', 'T03 runs in parallel')
  for (const l of ['T03 · verification', 'T03 · replanning', 'T03 · progress', 'T02 · replanning']) assert.equal(idx(calls, l), -1, l)
  drained('Y3', q)
  // The clerks of both task starts do not answer: the start that trips the breaker is not a failure of the clerk, and no worker starts
  const s = await scenario('Y3 starts', { 'plan-reader': [planOpened(P2, P3)], 'T02 · start': [null], 'T03 · start': [null], 'run end · progress': [COK] }, AP)
  assert.equal(s.res.status, 'error'); assert.equal(s.res.detail.split(' (')[1].split(')')[0], 'T02 · start, T03 · start')
  assert.deepEqual([...s.res.interrupted].sort(), ['T02', 'T03']); assert.deepEqual(s.res.tasks, [])
  assert.deepEqual(s.res.progress_failures, [{ task: 'T02', step: 'worker', error: 'clerk without an answer' }])
  drained('Y3 starts', s.q)
})
await test('Y3r: real progress.mjs — circuit breaker: the interrupted tasks keep their status and branch, their step is cleared, the run is in error', async () => {
  const D = toyRepo()
  try {
    D.writeTask('T02', []); D.writeTask('T03', [])
    const R2 = { ...T0, id: 'T02', title: 'Task T02', file: 'plans/p/tasks/T02-x.md' }, R3 = { ...T0, id: 'T03', title: 'Task T03', file: 'plans/p/tasks/T03-x.md' }
    const e = deferred()
    const { res, launched } = await play('Y3r', D, { 'plan-reader': [plan(R2, R3)], 'T02 · start': [{}], 'T03 · start': [{}],
      'T02 · worker': [() => { setTimeout(() => e.resolve(), 0); return null }], 'T02 · progress': [null],
      'T03 · worker': [async () => { await e.promise; return report('T03', { branch: 'task/T03', path: D.root }) }],
      'run end · progress': [{ commit: '', detail: '' }] })
    assert.deepEqual(launched.filter(l => l.code !== 0), [])
    assert.equal(res.status, 'error'); assert.deepEqual(res.interrupted, ['T02', 'T03']); assert.deepEqual(res.progress_failures, [])
    const doc = D.doc(), t = id => doc.tasks.find(x => x.id === id)
    for (const id of ['T02', 'T03']) assert.deepEqual([t(id).status, t(id).branch, t(id).step, t(id).blocker], ['todo', null, null, []], id)
    assert.deepEqual(launched.filter(l => l.label === 'T02 · progress'), [], 'T02: no close command')
    assert.deepEqual(doc.issues, [])
    assert.deepEqual(doc.runs.map(r => [r.status, r.detail]), [['error', res.detail]])
    assert.ok(doc.log.some(x => x.task === 'T03' && x.text === 'T03: step "worker" without a close at the end of the run'))
    assert.equal(spawnSync(process.execPath, [PROGRESS_SCRIPT, 'validate', 'plans/p'], { cwd: D.root }).status, 0)
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
await test('Y4: circuit breaker — an answer resets the count: without an answer, an answer, without an answer again → the task goes on as in 0.18.2', async () => {
  const { res, q } = await scenario('Y4', { 'plan-reader': [plan(T00)], 'T00 · worker': [report(0)],
    'T00 · verification': [null, null, ok(3)], 'T00 · fix 1': [report(1)], 'T00 · fix 2': [report(2)], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [MOK], 'T00 · progress': [SOK] })
  assert.equal(res.status, 'finished'); assert.ok(!('interrupted' in res)); assert.equal(res.tasks[0].status, 'merged')
  assert.deepEqual(res.tasks[0].rejections.map(x => x.gaps), [['verifier without an answer'], ['verifier without an answer']])
  drained('Y4', q)
})
await test('Y5: circuit breaker — a single call without an answer keeps the behavior of 0.18.2: failed, replanning, scribe', async () => {
  const { res, calls, q } = await scenario('Y5', { 'plan-reader': [plan(T00)], 'T00 · worker': [report(0)], 'T00 · verification': [ok(1)],
    'T00 · evaluation': [{ verdict: 'fail', gaps: ['M1'] }], 'T00 · fix 1': [null], 'T00 · replanning': [NOTHING], 'T00 · progress': [SOK] })
  assert.equal(res.status, 'partial'); assert.ok(!('interrupted' in res))
  assert.deepEqual([res.tasks[0].status, res.tasks[0].blocker], ['failed', ['fix without an answer (usage limit or API error)']])
  assert.ok(idx(calls, 'T00 · replanning') < idx(calls, 'T00 · progress'))
  drained('Y5', q)
})
await test('Y6: circuit breaker — a close interrupted at its scribe leaves nothing in the summary (issues, auto-decision, discarded amendment, added task); a failed post-merge check stays', async () => {
  const RP = { major: true, entries: [], issues: [
    { title: 'Contract', options: [{ id: 'A', description: 'add T02B', recommended: true, added_tasks: [{ id: 'T02B', title: 'Contract test', phase: 1, content: '---\nid: T02B\nphase: 1\n---' }], amendments: [{ id: 'T03', verification: ['pnpm test:x'], reason: 'r' }] }, { id: 'B', description: 'b' }] },
    { title: 'Prod access', human: true, options: [] }] }
  // T02 reaches its scribe, which does not answer; just before, the worker of T03 did not answer either
  const play2 = (name, extra) => {
    const e = deferred()
    return scenario(name, { 'plan-reader': [planOpened(P2, P3)], ...iso('T02', { 'T02 · worker': [report('T02', { branch: 'task/T02', path: '/wt/T02', deviations: DEVIATION })],
      'T02 · progress': [async () => { e.resolve(); await new Promise(r => setTimeout(r, 10)); return null }], ...extra }),
    'T03 · start': [COK], 'T03 · worker': [async () => { await e.promise; return null }], 'run end · progress': [COK] }, { ...AP, mode: 'auto' })
  }
  const { res, calls, q } = await play2('Y6', { 'T02 · replanning': [RP] })
  assert.equal(res.status, 'error'); assert.equal(res.detail.split(' (')[1].split(')')[0], 'T03 · worker, T02 · progress')
  assert.deepEqual([...res.interrupted].sort(), ['T02', 'T03']); assert.deepEqual(res.tasks, [])
  assert.deepEqual([res.stop_issue, res.open_issues, res.auto_decisions, res.discarded_amendments, res.added_tasks], [undefined, [], [], [], []])
  assert.equal(idx(calls, 'T03 · progress'), -1, 'T03: no close either')
  const [end] = progressOf(calls, 'run end · progress')
  assert.deepEqual([end.E.status, end.E.open_issues, end.E.auto_decisions, end.E.discarded_amendments, end.E.added_tasks, 'stop_issue' in end.E], ['error', [], [], [], [], false])
  drained('Y6', q)
  // Merge done, post-merge check failed: that issue belongs to the merge, not to the close, and stays
  const k = await play2('Y6 check', { 'T02 · worker': [report('T02', { branch: 'task/T02', path: '/wt/T02' })], 'T02 · merge': [withProgress({ ok: false, merged: true, check_ok: false, detail: 'tsc: 2 errors' })] })
  assert.equal(k.res.status, 'error'); assert.deepEqual([...k.res.interrupted].sort(), ['T02', 'T03'])
  assert.equal(k.res.stop_issue.title, 'Post-merge check failed after T02'); assert.deepEqual(k.res.open_issues, [])
  drained('Y6 check', k.q)
})
await test('Z1: post-merge check skipped (0.19.0) — a task of the main checkout whose merged tree is the verified branch\'s closes as merged without an issue', async () => {
  const SKIP = 'post-merge check skipped, same tree as the verified branch'
  const { res, calls, logs, q } = await scenario('Z1', { 'plan-reader': [plan(T00)], ...t00([], { ...MOK, check_skipped: true }), 'T00 · progress': [SOK] })
  assert.equal(res.status, 'finished'); assert.equal(res.tasks[0].status, 'merged')
  assert.equal(res.stop_issue, undefined); assert.deepEqual(res.open_issues, [])
  const m = byLabel(calls, 'T00 · merge')[0]
  assert.ok(m.opts.schema.properties.check_skipped, 'integrator: check_skipped in the schema')
  const at = m.prompt.indexOf('`git diff --quiet task/T00 HEAD`')
  assert.ok(at > m.prompt.indexOf('return merged=true') && at < m.prompt.indexOf('this check command'), 'comparison after the merge, before the check')
  assert.ok(m.prompt.includes('run neither the setup nor the check below, and return check_skipped=true, check_ok=true and ok=true'))
  assert.ok(logs.includes(`T00: ${SKIP}`), logs.join('\n'))
  assert.ok(!byLabel(calls, 'T00 · progress')[0].prompt.includes('needs-human'), 'scribe: no needs-human entry')
  drained('Z1', q)
  // Tree differs: the check runs and is reported as before, without the log line
  const d = await scenario('Z1 checked', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · progress': [SOK] })
  assert.equal(d.res.status, 'finished'); assert.ok(!d.logs.some(l => l.includes(SKIP)))
  drained('Z1 checked', d.q)
  // Skipped, but the check reported failed: a failure, as before
  const f = await scenario('Z1 failed', { 'plan-reader': [plan(T00)], ...t00([], { ok: false, merged: true, check_ok: false, check_skipped: true, detail: 'x' }), 'T00 · progress': [SOK] })
  assert.equal(f.res.stop_issue.title, 'Post-merge check failed after T00'); assert.ok(!f.logs.some(l => l.includes(SKIP)))
  drained('Z1 failed', f.q)
})
await test('Z2: post-merge check of a task in a worktree — never offered to skip; skipped all the same, it is a check not done: stop, human issue', async () => {
  const T02 = { ...T00, id: 'T02', title: 'Other', file: 'plans/p/tasks/T02.md', resources: [] }
  const T03 = { ...T00, id: 'T03', title: 'Again', file: 'plans/p/tasks/T03.md', resources: [] }
  const tt = (id, merge = MOK) => ({ [`${id} · worker`]: [report(id, { branch: `task/${id}`, path: `/wt/${id}` })], [`${id} · verification`]: [ok(id)], [`${id} · evaluation`]: [{ verdict: 'pass' }], [`${id} · merge`]: [merge], [`${id} · progress`]: [SOK] })
  const { res, calls, logs, q } = await scenario('Z2', { 'plan-reader': [plan(T02, T03)], ...tt('T02', { ...MOK, check_skipped: true }), ...tt('T03') })
  for (const id of ['T02', 'T03']) {
    const mg = byLabel(calls, `${id} · merge`)[0].prompt
    assert.ok(mg.includes(`git worktree remove "/wt/${id}"`), `${id}: in a worktree`)
    assert.ok(!mg.includes('git diff --quiet') && !mg.includes('check_skipped'), `${id}: no offer to skip the check`)
  }
  assert.equal(res.status, 'awaiting-ruling'); assert.equal(res.tasks.find(t => t.id === 'T02').status, 'merged')
  assert.equal(res.stop_issue.title, 'Post-merge check failed after T02'); assert.equal(res.stop_issue.human, true)
  assert.match(res.stop_issue.context, /^post-merge check not run on plan\/p \(sh scripts\/typecheck\.sh\): skipped by the integrator for a task in a worktree/)
  assert.ok(byLabel(calls, 'T02 · progress')[0].prompt.includes('"type":"needs-human","severity":"major","description":"post-merge check not run'), 'scribe: needs-human entry')
  assert.ok(!logs.some(l => l.includes('post-merge check skipped')), logs.join('\n'))
  drained('Z2', q)
})
// ——— 0.19.0: scope of the branch (plan-lint --scope) and proofs of the evaluator ———
const scopeFor = (task, branch, extra = {}) => sealScope({ task, branch, files: [], outside: [], tests_removed: [], skips_added: [], ...extra })
const SCOPE_CMD = 'node /plug/scripts/plan-lint.mjs plans/p --scope T00 --branch task/T00 --integration plan/p'
const OUT = scopeFor('T00', 'task/T00', { files: ['docs/x.md', 'src/a.ts', 'src/b.ts'], outside: ['docs/x.md', 'src/b.ts'] })
const OUT_GAP = 'files changed outside owned_files: docs/x.md, src/b.ts'
const UNREAD = 'could not be read: check yourself, in the diff, that it touches no file outside owned_files'
await test('SC1: scope — a file changed outside owned_files is rejected by the verification, without an evaluation of that attempt; the fix gets the gap', async () => {
  const { res, calls, logs, q } = await scenario('SC1', { 'plan-reader': [plan(T00)], 'T00 · worker': [report(0)], 'T00 · verification': [{ ...ok(1), scope: OUT }, ok(2)],
    'T00 · fix 1': [report(1)], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [MOK], 'T00 · progress': [SOK] })
  assert.equal(res.status, 'finished'); assert.equal(res.tasks[0].status, 'merged')
  assert.deepEqual(res.tasks[0].rejections, [{ attempt: 1, by: 'verification', gaps: [OUT_GAP] }])
  assert.equal(byLabel(calls, 'T00 · evaluation').length, 1, 'no evaluation of the rejected attempt')
  assert.ok(idx(calls, 'T00 · fix 1') < idx(calls, 'T00 · evaluation') && byLabel(calls, 'T00 · fix 1')[0].prompt.includes(OUT_GAP))
  const vf = byLabel(calls, 'T00 · verification')[0]
  assert.ok(vf.prompt.includes(`First, from the folder you start in (the main checkout), without a \`cd\`: \`${SCOPE_CMD}\`.`), vf.prompt.slice(0, 400))
  assert.ok(vf.prompt.includes('return it in "scope" exactly as printed') && vf.prompt.includes('cite it neither among the failures nor in "forbidden"'))
  assert.ok(vf.prompt.indexOf('--scope') < vf.prompt.indexOf('git status --porcelain'), 'the scope first, then the status')
  assert.deepEqual(vf.opts.schema.properties.scope.required, ['task', 'branch', 'files', 'outside', 'tests_removed', 'skips_added', 'digest'])
  assert.equal(idx(calls, 'T00 · scope · second reading'), -1, 'a faithful copy is read once')
  assert.ok(!logs.some(l => l.includes('--scope')), logs.join('\n'))
  drained('SC1', q)
  // The verification fails as well: its failure, then the scope gap
  const f = await scenario('SC1 failed', { 'plan-reader': [plan(T00)], 'T00 · worker': [report(0)],
    'T00 · verification': [{ ok: false, results: ok(1).results, failures: [{ command: 'sh scripts/e2e-local.sh', excerpt: '2 failed' }], scope: OUT }], 'T00 · replanning': [NOTHING], 'T00 · progress': [SOK] }, { max_fixes: 0 })
  assert.deepEqual([f.res.tasks[0].status, f.res.tasks[0].blocker], ['blocked', ['sh scripts/e2e-local.sh: 2 failed', OUT_GAP]])
  drained('SC1 failed', f.q)
})
await test('SC2: scope — a copy that does not match its digest is read again by the plan-reader; unfaithful twice, the task goes on without these facts, with a blind-spot · minor entry, never a rejection', async () => {
  // The verifier leaves a file out of "outside": the digest no longer matches; the plan-reader copies it faithfully → the facts of the second reading
  const COPY = { ...OUT, outside: ['src/b.ts'] }
  const a = await scenario('SC2 second reading', { 'plan-reader': [plan(T00)], 'T00 · worker': [report(0)], 'T00 · verification': [{ ...ok(1), scope: COPY }], 'T00 · scope · second reading': [OUT],
    'T00 · replanning': [NOTHING], 'T00 · progress': [SOK] }, { max_fixes: 0 })
  assert.deepEqual(a.res.tasks[0].blocker, [OUT_GAP], 'the faithful copy of the second reading decides')
  const sr = byLabel(a.calls, 'T00 · scope · second reading')[0]
  assert.deepEqual([sr.opts.agentType, sr.opts.model, sr.opts.schema.required.at(-1)], ['orchestre:plan-reader', 'haiku', 'digest'])
  assert.ok(sr.prompt.includes(`Run \`${SCOPE_CMD}\``) && sr.prompt.includes('`digest` included, character for character') && !sr.prompt.includes('--reader'))
  assert.ok(a.logs.includes('T00: copy of plan-lint --scope that does not match its digest; second reading'), a.logs.join('\n'))
  drained('SC2 second reading', a.q)
  // Unfaithful twice: no rejection, evaluation without the facts (it checks the scope itself), merged, blind spot in HANDOFF.md
  const BLIND = 'scope of T00 not checked: two copies of plan-lint --scope that do not match its digest (verifier, plan-reader); the files outside owned_files and the tests removed or skipped were left to the evaluator, from the diff'
  const b = await scenario('SC2 twice', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · verification': [{ ...ok(1), scope: COPY }], 'T00 · scope · second reading': [COPY], 'T00 · progress': [SOK] })
  assert.equal(b.res.status, 'finished'); assert.deepEqual([b.res.tasks[0].status, b.res.tasks[0].attempts, b.res.tasks[0].rejections], ['merged', 1, undefined])
  const ev = byLabel(b.calls, 'T00 · evaluation')[0].prompt
  assert.ok(ev.includes(UNREAD) && !ev.includes('tests_removed'), 'evaluation without the facts')
  assert.ok(byLabel(b.calls, 'T00 · progress')[0].prompt.includes(JSON.stringify({ type: 'blind-spot', severity: 'minor', description: BLIND })), 'blind-spot · minor entry for HANDOFF.md')
  assert.ok(b.logs.includes(`T00: ${BLIND}`))
  assert.equal(idx(b.calls, 'T00 · replanning'), -1, 'a blind spot of the scope alone needs no replanning')
  drained('SC2 twice', b.q)
  // The scope command refused to the verifier (no scope, cited in forbidden), the plan-reader without an answer: neither a failure, nor a fix; blind spot
  const c = await scenario('SC2 refused', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · verification': [{ ...ok(1), scope: undefined, forbidden: [`cd "/repo" && ${SCOPE_CMD}`] }], 'T00 · scope · second reading': [null], 'T00 · progress': [SOK] })
  assert.deepEqual([c.res.status, c.res.tasks[0].status, c.res.tasks[0].rejections, c.res.tasks[0].reviews], ['finished', 'merged', undefined, undefined])
  assert.ok(byLabel(c.calls, 'T00 · progress')[0].prompt.includes('"type":"blind-spot","severity":"minor","description":"scope of T00 not checked'))
  drained('SC2 refused', c.q)
  // A copy faithful to its digest, but of another branch or another task: read again
  for (const [name, other] of [['branch', scopeFor('T00', 'task/T09')], ['task', scopeFor('T09', 'task/T00')]]) {
    const d = await scenario('SC2 other ' + name, { 'plan-reader': [plan(T00)], ...t00(), 'T00 · verification': [{ ...ok(1), scope: other }], 'T00 · scope · second reading': [scopeFor('T00', 'task/T00')], 'T00 · progress': [SOK] })
    assert.equal(d.res.tasks[0].status, 'merged'); assert.ok(!byLabel(d.calls, 'T00 · evaluation')[0].prompt.includes(UNREAD), name)
    drained('SC2 other ' + name, d.q)
  }
  // The verification fails anyway: no second reading, no blind spot
  const e = await scenario('SC2 failed', { 'plan-reader': [plan(T00)], 'T00 · worker': [report(0)], 'T00 · verification': [{ ok: false, results: [], failures: [{ command: 'sh scripts/typecheck.sh' }], scope: COPY }], 'T00 · replanning': [NOTHING], 'T00 · progress': [SOK] }, { max_fixes: 0 })
  assert.deepEqual(e.res.tasks[0].blocker, ['sh scripts/typecheck.sh: failure'])
  assert.ok(!byLabel(e.calls, 'T00 · progress')[0].prompt.includes('blind-spot'))
  drained('SC2 failed', e.q)
})
await test('SC3: scope — tests_removed and skips_added are passed in the evaluator\'s instruction, with the rule and the path heuristic; the evaluator does not read the scope itself', async () => {
  const S = scopeFor('T00', 'task/T00', { files: ['docs/latest.md', 'src/a.ts', 'tests/a.test.mjs', 'tests/b.test.mjs'], tests_removed: ['docs/latest.md', 'tests/a.test.mjs'], skips_added: [{ file: 'tests/b.test.mjs', line: 4, marker: '.skip(' }] })
  const { res, calls, q } = await scenario('SC3', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · verification': [{ ...ok(1), scope: S }], 'T00 · progress': [SOK] })
  assert.equal(res.tasks[0].status, 'merged', 'the workflow rejects nothing for a removed test: the evaluator judges')
  const ev = byLabel(calls, 'T00 · evaluation')[0].prompt
  for (const x of ['Test files deleted or renamed (tests_removed): ["docs/latest.md","tests/a.test.mjs"]', 'Skipped-test markers added (skips_added): [{"file":"tests/b.test.mjs","line":4,"marker":".skip("}]',
    'A test deleted or skipped is a gap, unless the definition of done asks for it.', 'the files outside owned_files are already checked, do not read the scope yourself',
    'tests_removed lists the paths containing `test` or `spec` (case-insensitive), which can include files that are not tests (such as `docs/latest.md`): such a file is not a gap by itself.']) assert.ok(ev.includes(x), x)
  assert.ok(!ev.includes(UNREAD))
  drained('SC3', q)
})
await test('SC4: proofs — a pass without proofs is sent back once with the reason; invalid again, an evaluation without an answer; a command proof needs a verifier result of code 0', async () => {
  const P = (by, ref) => ({ criterion: 'the test passes', by, ref })
  // Sent back once, with the reason, without a progress command; the second pass holds: merged on the first attempt
  const a = await scenario('SC4 sent back', { 'plan-reader': [planOpened(T00)], ...s00(), 'T00 · evaluation': [withProgress({ verdict: 'pass', proofs: [] })], 'T00 · evaluation · proofs': [{ verdict: 'pass', proofs: [P('diff', 'src/a.ts:3')] }], 'run end · progress': [COK] }, AP)
  assert.equal(a.res.status, 'finished'); assert.deepEqual([a.res.tasks[0].status, a.res.tasks[0].attempts], ['merged', 1]); assert.deepEqual(a.res.progress_failures, [])
  const back = byLabel(a.calls, 'T00 · evaluation · proofs')[0]
  assert.ok(back.prompt.startsWith('Your first evaluation of this attempt of the task T00 returned pass, refused by the workflow: pass without proofs. Evaluate again, from the start.'), back.prompt.slice(0, 200))
  assert.deepEqual(progressCommands(back.prompt), [], 'no second step command')
  assert.deepEqual([back.opts.agentType, back.opts.model, back.opts.schema.properties.proofs.items.properties.by.enum], ['orchestre:evaluator', 'opus', ['diff', 'test', 'command', 'report']])
  assert.ok(a.logs.includes('T00: pass refused, pass without proofs; evaluation sent back'), a.logs.join('\n'))
  const first = byLabel(a.calls, 'T00 · evaluation')[0].prompt
  assert.ok(first.includes('On a pass, return "proofs": one entry per criterion of the definition of done, with "criterion" (its text), "by" and "ref"'))
  drained('SC4 sent back', a.q)
  // Invalid twice: treated as an evaluation without an answer → rejected attempt, fix
  const b = await scenario('SC4 twice', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · evaluation': [{ verdict: 'pass', proofs: undefined }, { verdict: 'pass' }], 'T00 · evaluation · proofs': [{ verdict: 'pass', proofs: [] }], 'T00 · verification': [ok(1), ok(2)], 'T00 · fix 1': [report(1)], 'T00 · progress': [SOK] })
  assert.deepEqual(b.res.tasks[0].rejections, [{ attempt: 1, by: 'evaluation', gaps: ['evaluator without an answer: pass refused twice, pass without proofs'] }])
  assert.equal(b.res.tasks[0].status, 'merged'); drained('SC4 twice', b.q)
  // A command proof: accepted on a result of code 0 (leading cd and echo of the code aside), refused on code 1 or on a command the verifier did not run
  const V = { ok: true, results: [{ command: 'cd "/repo" && sh scripts/typecheck.sh; echo "code=$?"', code: 0, excerpt: 'ok' }, { command: 'sh scripts/e2e-local.sh', code: 1, excerpt: '1 failed' }] }
  const c = await scenario('SC4 command ok', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · verification': [V], 'T00 · evaluation': [{ verdict: 'pass', proofs: [P('command', 'sh scripts/typecheck.sh'), P('test', 'tests/a.test.mjs: case x'), P('report', 'mutations named')] }], 'T00 · progress': [SOK] })
  assert.equal(c.res.tasks[0].status, 'merged'); assert.equal(idx(c.calls, 'T00 · evaluation · proofs'), -1); drained('SC4 command ok', c.q)
  for (const [name, ref, reason] of [['code 1', 'sh scripts/e2e-local.sh', 'sh scripts/e2e-local.sh'], ['not run', 'npm test', 'npm test']]) {
    const d = await scenario('SC4 ' + name, { 'plan-reader': [plan(T00)], ...t00(), 'T00 · verification': [V], 'T00 · evaluation': [{ verdict: 'pass', proofs: [P('diff', 'src/a.ts:1'), P('command', ref)] }], 'T00 · evaluation · proofs': [{ verdict: 'pass', proofs: [P('diff', 'src/a.ts:1')] }], 'T00 · progress': [SOK] })
    assert.ok(byLabel(d.calls, 'T00 · evaluation · proofs')[0].prompt.includes(`refused by the workflow: command proofs that match no result of code 0 of the verifier: ${reason}.`), name)
    assert.equal(d.res.tasks[0].status, 'merged'); drained('SC4 ' + name, d.q)
  }
  // A proof without a ref, or with a "by" outside the four: refused
  for (const [name, proof] of [['ref', P('diff', ' ')], ['by', P('trust', 'me')]]) {
    const g = await scenario('SC4 ' + name, { 'plan-reader': [plan(T00)], ...t00(), 'T00 · evaluation': [{ verdict: 'pass', proofs: [proof] }], 'T00 · evaluation · proofs': [{ verdict: 'pass' , proofs: [P('diff', 'src/a.ts:1')] }], 'T00 · progress': [SOK] })
    assert.ok(byLabel(g.calls, 'T00 · evaluation · proofs')[0].prompt.includes('refused by the workflow: proofs without a criterion, a "by" among diff, test, command, report or a ref:'), name)
    drained('SC4 ' + name, g.q)
  }
  // A fail needs no proofs
  const h = await scenario('SC4 fail', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · evaluation': [{ verdict: 'fail', gaps: ['M1'] }, { verdict: 'pass' }], 'T00 · verification': [ok(1), ok(2)], 'T00 · fix 1': [report(1)], 'T00 · progress': [SOK] })
  assert.deepEqual(h.res.tasks[0].rejections, [{ attempt: 1, by: 'evaluation', gaps: ['M1'] }]); assert.equal(idx(h.calls, 'T00 · evaluation · proofs'), -1)
  drained('SC4 fail', h.q)
})
await test('SC5: real plan-lint --scope run by a verifier that copies its output → digest that matches; outside rejected, then skips_added passed to the evaluator', async () => {
  const D = toyRepo()
  const LINT_SCRIPT = join(resolve(dirname(SRC), '..'), 'scripts', 'plan-lint.mjs')
  try {
    D.git('switch', '-qc', 'task/T00')
    fs.mkdirSync(join(D.root, 'src', 'T00'), { recursive: true }); fs.mkdirSync(join(D.root, 'docs'))
    fs.writeFileSync(join(D.root, 'src', 'T00', 'a.test.js'), "it.skip('later', () => {})\n"); fs.writeFileSync(join(D.root, 'docs', 'x.md'), 'x\n')
    D.git('add', 'src', 'docs'); D.git('commit', '-qm', 'work'); D.git('switch', '-q', 'plan/p')
    const printed = []
    const verifier = n => prompt => {
      const cmd = prompt.match(/without a `cd`: `([^`]*--scope[^`]*)`/)[1]
      const r = spawnSync('sh', ['-c', cmd], { cwd: D.root, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      printed.push(JSON.parse(r.stdout))
      return { ok: true, results: [{ command: 'npm test', code: 0, excerpt: 'ok ' + n }], scope: printed.at(-1) }
    }
    const fix = () => { D.git('switch', '-q', 'task/T00'); D.git('rm', '-q', 'docs/x.md'); D.git('commit', '-qm', 'fix'); D.git('switch', '-q', 'plan/p'); return report(1) }
    const { res } = await play('SC5', D, { 'plan-reader': [plan(T0)], 'T00 · worker': [report(0)], 'T00 · verification': [verifier(1), verifier(2)], 'T00 · fix 1': [fix],
      'T00 · evaluation': [prompt => { assert.ok(prompt.includes('[{"file":"src/T00/a.test.js","line":1,"marker":".skip("}]'), prompt); return { verdict: 'pass' } }], 'T00 · merge': [MOK], 'T00 · progress': [SOK],
      'run end · progress': [{ commit: '', detail: '' }] }, { lint: LINT_SCRIPT, parallelism: 1 })
    assert.deepEqual(printed[0].outside, ['docs/x.md']); assert.equal(printed[0].digest, scopeDigest(printed[0]), 'plan-lint and the workflow compute the same digest')
    assert.deepEqual([printed[1].outside, printed[1].tests_removed], [[], []])
    assert.deepEqual(res.tasks.map(t => [t.id, t.status, t.rejections]), [['T00', 'merged', [{ attempt: 1, by: 'verification', gaps: ['files changed outside owned_files: docs/x.md'] }]]])
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
await test('SC6: circuit breaker — a task merged then interrupted at its scribe or at its replanning comes out in merged_unclosed with what its close did not record; one interrupted before its merge does not', async () => {
  const RP = { major: true, entries: [], issues: [
    { title: 'Contract', options: [{ id: 'A', description: 'add T02B', recommended: true, added_tasks: [{ id: 'T02B', title: 'Contract test', phase: 1, content: '---\nid: T02B\nphase: 1\n---' }] }, { id: 'B', description: 'b' }] },
    { title: 'Prod access', human: true, options: [] }] }
  const R = { type: 'review', description: '.env.example: add MR_MAX' }
  const UV = 'behavior in a worktree: the task runs in the main checkout'
  // T02 merged, then its call at `at` does not answer; just before, the worker of T03 did not answer either
  const trip = (name, at, extra) => {
    const e = deferred()
    return scenario(name, { 'plan-reader': [planOpened(P2, P3)], ...iso('T02', { 'T02 · worker': [report('T02', { branch: 'task/T02', path: '/wt/T02', deviations: [...DEVIATION, R] })],
      'T02 · evaluation': [withProgress({ verdict: 'pass', unverifiable: [UV] })], [at]: [async () => { e.resolve(); await new Promise(r => setTimeout(r, 10)); return null }], ...extra }),
    'T03 · start': [COK], 'T03 · worker': [async () => { await e.promise; return null }], 'run end · progress': [COK] }, { ...AP, mode: 'auto' })
  }
  const SENTENCE = 'T02 merged before the trip: their deviations were not recorded, see merged_unclosed.'
  const s = await trip('SC6 scribe', 'T02 · progress', { 'T02 · replanning': [RP] })
  assert.equal(s.res.status, 'error'); assert.deepEqual([...s.res.interrupted].sort(), ['T02', 'T03'])
  assert.ok(s.res.detail.startsWith('agents not answering: ') && s.res.detail.endsWith(` interrupted, their branches kept. Launch a new run once claude answers again. ${SENTENCE}`), s.res.detail)
  assert.equal(s.res.merged_unclosed.length, 1, 'T03, interrupted before its merge, is not there')
  const [u] = s.res.merged_unclosed
  assert.deepEqual([u.id, u.branch, u.deviations, u.reviews, u.unverifiable], ['T02', 'task/T02', DEVIATION, [R.description], [UV]])
  assert.deepEqual(u.issues.map(p => [p.task, p.title, p.human]), [['T02', 'Prod access', true], ['T02', 'Contract', false]], 'the human issue and the auto-decision never written')
  assert.equal(u.issues[1].options[0].added_tasks[0].id, 'T02B', 'options with their actions')
  assert.deepEqual([s.res.stop_issue, s.res.open_issues, s.res.auto_decisions, s.res.added_tasks], [undefined, [], [], []], 'forget still clears the summary')
  const [end] = progressOf(s.calls, 'run end · progress')
  assert.ok(!('merged_unclosed' in end.E) && end.E.detail.endsWith(SENTENCE), 'merged_unclosed is not for run-end')
  drained('SC6 scribe', s.q)
  // Interrupted at its own merge call (T11C): the integrator was launched, so git merge may have run. T02 comes out in
  // merged_unclosed with merge: 'unknown', besides interrupted, with what its close would have recorded
  const m = await trip('SC6 merge', 'T02 · merge', { 'T02 · progress': [] })
  assert.equal(m.res.status, 'error'); assert.deepEqual([...m.res.interrupted].sort(), ['T02', 'T03'])
  assert.deepEqual(m.res.merged_unclosed, [{ id: 'T02', branch: 'task/T02', merge: 'unknown', deviations: DEVIATION, reviews: [R.description], unverifiable: [UV], issues: [] }])
  assert.ok(m.res.detail.endsWith(' T02 interrupted at their merge, which may have run: see merged_unclosed.') && !m.res.detail.includes('merged before the trip'), m.res.detail)
  for (const l of ['T02 · replanning', 'T02 · progress']) assert.equal(idx(m.calls, l), -1, l)
  drained('SC6 merge', m.q)
  // A post-merge check failed, then the scribe interrupted: the issue of the check stays in stop_issue, and does not come
  // again in merged_unclosed (mutation W18 of T11R)
  const w = await trip('SC6 check', 'T02 · progress', { 'T02 · merge': [withProgress({ ...MOK, check_ok: false, detail: 'tests red' })], 'T02 · replanning': [NOTHING] })
  assert.equal(w.res.status, 'error'); assert.equal(w.res.stop_issue && w.res.stop_issue.title, 'Post-merge check failed after T02')
  assert.deepEqual(w.res.merged_unclosed.map(u => [u.id, u.merge, u.issues]), [['T02', undefined, []]])
  drained('SC6 check', w.q)
  // Interrupted at its replanning: the breaker latches while the integrator of T02 merges (the workers of T03 and T04 do not
  // answer); the merge done, the replanning never starts. Nothing rated, no issue; deviations, reviews and unverifiable criteria all the same
  const P4 = { ...T00, id: 'T04', title: 'Fourth', file: 'plans/p/tasks/T04.md', resources: [] }
  const atMerge = (name, extra, merge = MOK) => {
    const e = deferred()
    const silent = async () => { await e.promise; return null }
    return scenario(name, { 'plan-reader': [planOpened(P2, P3, P4)], ...iso('T02', { 'T02 · worker': [report('T02', { branch: 'task/T02', path: '/wt/T02', deviations: [...DEVIATION, R] })],
      'T02 · evaluation': [withProgress({ verdict: 'pass', unverifiable: [UV] })], 'T02 · merge': [async () => { e.resolve(); await new Promise(r => setTimeout(r, 10)); return withProgress(merge) }], 'T02 · progress': [], ...extra }),
    'T03 · start': [COK], 'T03 · worker': [silent], 'T04 · start': [COK], 'T04 · worker': [silent], 'run end · progress': [COK] }, { ...AP, mode: 'auto' })
  }
  const p = await atMerge('SC6 replanning', {})
  assert.equal(p.res.status, 'error'); assert.equal(p.res.detail.split(' (')[1].split(')')[0], 'T03 · worker, T04 · worker'); assert.ok(p.res.detail.endsWith(SENTENCE), p.res.detail)
  assert.deepEqual(p.res.merged_unclosed, [{ id: 'T02', branch: 'task/T02', deviations: DEVIATION, reviews: [R.description], unverifiable: [UV], issues: [] }])
  assert.deepEqual([...p.res.interrupted].sort(), ['T02', 'T03', 'T04'])
  for (const l of ['T02 · replanning', 'T02 · progress', 'T03 · progress']) assert.equal(idx(p.calls, l), -1, l)
  drained('SC6 replanning', p.q)
  // The breaker latches while T02 is evaluated: its merge call is refused before any integrator is launched, so the merge did
  // not run and T02 is only interrupted
  const b = deferred(), quiet = async () => { await b.promise; return null }
  const bm = await scenario('SC6 before merge', { 'plan-reader': [planOpened(P2, P3, P4)], ...iso('T02', { 'T02 · evaluation': [async () => { b.resolve(); await new Promise(r => setTimeout(r, 10)); return withProgress({ verdict: 'pass' }) }], 'T02 · merge': [], 'T02 · progress': [] }),
    'T03 · start': [COK], 'T03 · worker': [quiet], 'T04 · start': [COK], 'T04 · worker': [quiet], 'run end · progress': [COK] }, { ...AP, mode: 'auto' })
  assert.deepEqual([bm.res.status, bm.res.merged_unclosed, [...bm.res.interrupted].sort()], ['error', [], ['T02', 'T03', 'T04']])
  assert.equal(idx(bm.calls, 'T02 · merge'), -1, 'no integrator launched')
  drained('SC6 before merge', bm.q)
  // A file unreadable for the evaluator and a kept worktree: their reviews too
  const k = await atMerge('SC6 reviews', { 'T02 · worker': [report('T02', { branch: 'task/T02', path: '/wt/T02', deviations: DEVIATION })],
    'T02 · evaluation': [withProgress({ verdict: 'pass', unreadable: ['agents/x/.env.example'] })] }, { ...MOK, worktree_kept: 'contains modified or untracked files' })
  assert.deepEqual(k.res.merged_unclosed[0].reviews, ['agents/x/.env.example: unreadable by the agents, to review by the human before the PR', 'worktree /wt/T02 kept after the merge of T02 (contains modified or untracked files): what it holds uncommitted is not in plan/p; look at it, then remove it'])
  drained('SC6 reviews', k.q)
  // No task merged before the trip: merged_unclosed empty, the detail of 0.19.0 without the sentence
  const n0 = await scenario('SC6 none', y1(), { ...AP, parallelism: 1 })
  assert.deepEqual([n0.res.merged_unclosed, n0.res.detail], [[], silentDetail('T02 · verification, T02 · fix 1', 'T02')])
  drained('SC6 none', n0.q)
})
await test('SC7: scope — a blind spot of attempt 1 (scope unread twice) does not survive attempt 2, whose scope is read (mutation W21 of T11R)', async () => {
  const COPY = { ...OUT, outside: ['src/b.ts'] }
  const { res, calls, q } = await scenario('SC7', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · verification': [{ ...ok(1), scope: COPY }, ok(2)], 'T00 · scope · second reading': [COPY],
    'T00 · evaluation': [{ verdict: 'fail', gaps: ['G1'] }, { verdict: 'pass' }], 'T00 · fix 1': [report(1)], 'T00 · progress': [SOK] })
  assert.deepEqual([res.status, res.tasks[0].status, res.tasks[0].attempts], ['finished', 'merged', 2])
  assert.ok(byLabel(calls, 'T00 · evaluation')[0].prompt.includes(UNREAD) && !byLabel(calls, 'T00 · evaluation')[1].prompt.includes(UNREAD), 'attempt 1 without the facts, attempt 2 with them')
  const sc = byLabel(calls, 'T00 · progress')[0].prompt
  assert.ok(!sc.includes('blind-spot') && !sc.includes('scope of T00 not checked'), 'no blind spot of the scope once attempt 2 read it')
  drained('SC7', q)
})

// ——— 0.20.0: close writes the plan; digests of the progress commands and of the output of close ———
const AGAIN = 'Your first run of the progress command below was refused (payload altered in transit)'
const ALTERED = cmd => ({ progress_ok: false, progress_error: `progress: ${cmd}: payload altered in transit (_digest "0", 1 computed): nothing is written` })
await test('CL1: close — without a finding nor a flaky test, one single haiku call, the clerk: git switch first, then close; no step, no DISCOVERY.md, no scribe', async () => {
  const { res, calls, q } = await scenario('CL1', { 'plan-reader': [planOpened(T00)], ...s00({ 'T00 · worker': [withProgress(report(0, { findings: [] }))] }), 'run end · progress': [COK] }, AP)
  assert.equal(res.status, 'finished'); assert.deepEqual(res.progress_failures, [])
  const cs = byLabel(calls, 'T00 · progress')
  assert.equal(cs.length, 1, 'one single call')
  assert.deepEqual([cs[0].opts.agentType, cs[0].opts.model, cs[0].opts.schema.required], ['orchestre:clerk', 'haiku', ['progress_ok']])
  assert.ok(!calls.some(c => c.opts.agentType === 'orchestre:scribe'), 'no scribe')
  assert.deepEqual(progressOf(calls, 'T00 · progress'), [{ cmd: 'close', plan: 'plans/p', E: { task: 'T00', status: 'merged', attempts: 1, branch: 'task/T00' } }])
  const p = cs[0].prompt
  assert.ok(p.startsWith('Close of the task T00 of the plan plans/p, in the main checkout, in this order:\n1. `git switch plan/p`. If it fails, run nothing else'), p.slice(0, 200))
  assert.ok(p.indexOf('`git switch plan/p`') < p.indexOf('progress.mjs close'), 'the switch before close')
  assert.ok(!p.includes('DISCOVERY.md:') && !p.includes('Language:') && !p.includes('test -e'), 'nothing to write, no free text, no auto-decision')
  assert.ok(p.includes('Never write HANDOFF.md, PROGRESS.md, a task or an amendment yourself, and make no commit: the close command does.'))
  assert.ok(p.includes('return it in "close" exactly as printed, every field and every value, `digest` included'))
  drained('CL1', q)
  // The close agent without an answer (a single one: no circuit breaker): the task stays merged, a human stop
  for (const [name, w, who] of [['CL1 clerk silent', report(0, { findings: [] }), 'Clerk'], ['CL1 scribe silent', report(0), 'Scribe']]) {
    const s = await scenario(name, { 'plan-reader': [planOpened(T00)], ...s00({ 'T00 · worker': [withProgress(w)], 'T00 · progress': [null] }), 'run end · progress': [COK] }, AP)
    assert.deepEqual([s.res.status, s.res.tasks[0].status, s.res.stop_issue.title, s.res.stop_issue.context], ['awaiting-ruling', 'merged', 'Progress of T00 not committed', `${who} without an answer.`], name)
    drained(name, s.q)
  }
})
await test('CL2: close — a finding or a flaky test: one single call, the scribe, which switches, writes DISCOVERY.md, then runs close', async () => {
  for (const [name, w, v] of [['CL2 findings', report(0), ok(1)], ['CL2 flaky', report(0, { findings: [] }), { ...ok(1), flaky: ['a.spec.ts:3'] }]]) {
    const { res, calls, q } = await scenario(name, { 'plan-reader': [planOpened(T00)], ...s00({ 'T00 · worker': [withProgress(w)], 'T00 · verification': [withProgress(v)] }), 'run end · progress': [COK] }, AP)
    assert.equal(res.status, 'finished')
    const cs = byLabel(calls, 'T00 · progress')
    assert.equal(cs.length, 1, `${name}: one single call`)
    assert.deepEqual([cs[0].opts.agentType, cs[0].opts.model], ['orchestre:scribe', 'sonnet'], name)
    const p = cs[0].prompt, sw = p.indexOf('\n1. `git switch plan/p`.'), disc = p.indexOf('\n2. plans/p/DISCOVERY.md: integrate these findings'), close = p.indexOf('progress.mjs close')
    assert.ok(sw > 0 && sw < disc && disc < close, `${name}: switch, DISCOVERY.md, then close`)
    assert.ok(p.includes('commits them with DISCOVERY.md, with the message "progress(T00): merged"') && p.includes('Never write HANDOFF.md, PROGRESS.md, a task or an amendment yourself'), name)
    assert.deepEqual(progressOf(calls, 'T00 · progress').map(x => x.cmd), ['step', 'close'], name)
    if (v.flaky) {
      assert.ok(p.includes('Flaky tests (passed on the second run): add them to the section "Pitfalls and fixes": ["a.spec.ts:3"]'))
      assert.deepEqual(progressOf(calls, 'T00 · progress')[1].E.flaky, ['a.spec.ts:3'], 'close writes the debt entry')
    }
    drained(name, q)
  }
})
await test('CL3: real progress.mjs — a close altered on the way is refused, nothing written: run again once, faithful, it passes; altered twice, a human stop, as a failed scribe', async () => {
  const alter = c => c.replace('"attempts":1', '"attempts":3')
  for (const twice of [false, true]) {
    const D = toyRepo(), name = twice ? 'CL3 twice' : 'CL3 once'
    try {
      const { res, launched } = await play(name, D, { 'plan-reader': [plan(T0)], 'T00 · worker': [report(0)], 'T00 · verification': [ok(1)], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [MOK],
        'T00 · progress': [{ tamper: alter, answer: SOK }, twice ? { tamper: alter, answer: SOK } : SOK], 'run end · progress': [{ commit: '', detail: '' }] })
      // The scribe's step first (T0 has findings), then the close; the second call runs the close only
      const closes = launched.filter(l => l.label === 'T00 · progress').slice(1)
      assert.deepEqual(closes.map(l => l.code), [1, twice ? 1 : 0], name)
      assert.match(closes[0].err, /^progress: close: payload altered in transit \(_digest "[0-9a-f]{8}", [0-9a-f]{8} computed\): nothing is written$/)
      const commits = D.git('log', '--format=%s').split('\n').filter(s => s.startsWith('progress(T00)'))
      const t = D.doc().tasks.find(x => x.id === 'T00')
      if (!twice) {
        assert.deepEqual([res.status, res.progress_failures, commits, t.status, t.attempts], ['finished', [], ['progress(T00): merged'], 'merged', 1])
      } else {
        assert.deepEqual([res.status, res.stop_issue.title, res.stop_issue.human, commits], ['awaiting-ruling', 'Progress of T00 not committed', true, []])
        assert.ok(res.stop_issue.context.startsWith('close refused twice: progress: close: payload altered in transit'), res.stop_issue.context)
        assert.ok(!fs.readFileSync(join(D.root, 'plans', 'p', 'HANDOFF.md'), 'utf8').includes('## T00'), 'nothing written')
        assert.deepEqual([t.status, t.step], ['merged', null], 'the run end closes T00 from the summary')
      }
    } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
  }
  // The second call says why, and runs the same command
  const { calls, q } = await scenario('CL3 prompt', { 'plan-reader': [planOpened(T00)], ...s00({ 'T00 · progress': [ALTERED('close'), withProgress(SOK)] }), 'run end · progress': [COK] }, AP)
  const [a, b] = byLabel(calls, 'T00 · progress')
  assert.ok(!a.prompt.startsWith(AGAIN) && b.prompt.startsWith(AGAIN))
  assert.deepEqual(progressOf(calls, 'T00 · progress', 1), progressOf(calls, 'T00 · progress', 0).filter(x => x.cmd === 'close'), 'the same close, without the step again')
  drained('CL3 prompt', q)
})
await test('CL4: close — its output is read back through its digest: an altered copy, or the copy of another close, stops for a human; a faithful one gives rejected and discarded', async () => {
  const out = (x = {}) => { const o = { task: 'T00', status: 'merged', commit: 'p1', rejected: [], discarded: [], issues: [], pending: [], message: 'T00 merged', ...x }; return { ...o, digest: payloadDigest(o, 'digest') } }
  for (const [name, close] of [['CL4 altered', { ...out({ rejected: [{ id: 'T00C', reason: 'r' }] }), rejected: [] }], ['CL4 other task', out({ task: 'T01' })], ['CL4 other status', out({ status: 'blocked' })], ['CL4 none', undefined]]) {
    const { res, q } = await scenario(name, { 'plan-reader': [planOpened(T00)], ...s00({ 'T00 · progress': [withProgress({ close })] }), 'run end · progress': [COK] }, AP)
    assert.deepEqual([res.status, res.stop_issue.title, res.stop_issue.human], ['awaiting-ruling', 'Progress of T00: output of close not read', true], name)
    assert.ok(res.stop_issue.context.includes('Read the commit "progress(T00): merged" on plan/p'), name)
    drained(name, q)
  }
  const { res, q } = await scenario('CL4 faithful', { 'plan-reader': [planOpened(T00)], ...s00({ 'T00 · progress': [withProgress({ close: out({ rejected: [{ id: 'T00C', reason: 'plan-lint: x' }], discarded: [{ id: 'T09', reason: 'merged' }] }) })] }), 'run end · progress': [COK] }, AP)
  assert.deepEqual([res.status, res.stop_issue.title, res.stop_issue.context], ['awaiting-ruling', 'Progress of T00: tasks, amendments or decisions rejected', '[{"id":"T00C","reason":"plan-lint: x"}]'])
  assert.deepEqual(res.discarded_amendments, [{ task: 'T00', id: 'T09', reason: 'merged' }])
  drained('CL4 faithful', q)
})
await test('CL5: close — a path cited by an auto-decision that neither exists nor belongs to a task created: a human stop (the check of the 0.19 scribe, kept)', async () => {
  const { res, calls, q } = await scenario('CL5', { 'plan-reader': [planOpened(T00, T01)], ...s00({ 'T00 · worker': [withProgress(report(0, { deviations: DEVIATION }))], 'T00 · replanning': [RP_E], 'T00 · progress': [withProgress({ missing: ['src/rule-d.ts'] })] }), 'run end · progress': [COK] }, { ...AP, mode: 'auto' })
  assert.deepEqual([res.status, res.stop_issue.title], ['awaiting-ruling', 'Progress of T00: tasks, amendments or decisions rejected'])
  assert.deepEqual(JSON.parse(res.stop_issue.context), [{ id: 'src/rule-d.ts', reason: 'cited by an auto-decision: it does not exist and no task created by this close owns it' }])
  assert.ok(byLabel(calls, 'T00 · progress')[0].prompt.includes('Return in "missing" each path that does neither'))
  drained('CL5', q)
})
await test('CL6: digests — run start, start of a task in a worktree and run end refused for an altered payload run again once; the step of a working agent does not', async () => {
  const T02 = { ...T00, id: 'T02', title: 'Other', file: 'plans/p/tasks/T02.md', resources: [] }
  const tt = id => ({ [`${id} · worker`]: [report(id, { branch: `task/${id}`, path: `/wt/${id}` })], [`${id} · verification`]: [withProgress(ok(id))], [`${id} · evaluation`]: [withProgress({ verdict: 'pass' })], [`${id} · merge`]: [withProgress(MOK)], [`${id} · progress`]: [withProgress(SOK)] })
  const { res, calls, q } = await scenario('CL6', {
    'plan-reader': [{ ok: false, tasks: [], run_start_ok: false, ...ALTERED('run-start') }, planOpened(T02, { ...T00, id: 'T03', title: 'Again', file: 'plans/p/tasks/T03.md', resources: [] })],
    'T02 · start': [ALTERED('step'), COK], 'T03 · start': [COK], ...tt('T02'), ...tt('T03'), 'run end · progress': [ALTERED('run-end'), COK] }, AP)
  assert.equal(res.status, 'finished'); assert.deepEqual(res.progress_failures, [])
  for (const [l, n] of [['plan-reader', 2], ['T02 · start', 2], ['T03 · start', 1], ['run end · progress', 2]]) assert.equal(byLabel(calls, l).length, n, l)
  for (const l of ['plan-reader', 'T02 · start', 'run end · progress']) {
    const [a, b] = byLabel(calls, l)
    assert.ok(!a.prompt.startsWith(AGAIN) && b.prompt.startsWith(AGAIN), l)
    assert.deepEqual(progressOf(calls, l, 1), progressOf(calls, l, 0), `${l}: the same command`)
  }
  drained('CL6', q)
  // Altered twice: no third call; the failure goes where it went before (run not opened, progress_failures)
  const r2 = await scenario('CL6 twice', { 'plan-reader': [{ ok: false, tasks: [], run_start_ok: false, ...ALTERED('run-start') }, { ok: false, tasks: [], run_start_ok: false, ...ALTERED('run-start') }] }, AP)
  assert.equal(r2.res.status, 'error'); assert.ok(r2.res.detail.startsWith('progress: run not opened (run-start), no task started — progress: run-start: payload altered in transit'))
  drained('CL6 twice', r2.q)
  const r3 = await scenario('CL6 end', { 'plan-reader': [planOpened(T00)], ...s00(), 'run end · progress': [ALTERED('run-end'), ALTERED('run-end')] }, AP)
  assert.deepEqual(r3.res.progress_failures, [{ task: null, step: 'run-end', error: ALTERED('run-end').progress_error }])
  drained('CL6 end', r3.q)
  // The step of a working agent: display only, never run again
  const r4 = await scenario('CL6 step', { 'plan-reader': [planOpened(T00)], ...s00({ 'T00 · verification': [{ ...ok(1), ...ALTERED('step') }] }), 'run end · progress': [COK] }, AP)
  assert.equal(r4.res.status, 'finished'); assert.equal(byLabel(r4.calls, 'T00 · verification').length, 1)
  assert.deepEqual(r4.res.progress_failures, [{ task: 'T00', step: 'verification', error: ALTERED('step').progress_error }])
  drained('CL6 step', r4.q)
  // A command reported as passed is never run again, whatever its message: a second close would record its issues twice,
  // a second run-start would open another run
  const r5 = await scenario('CL6 passed', { 'plan-reader': [{ ...planOpened(T00), progress_error: ALTERED('run-start').progress_error }], ...s00({ 'T00 · progress': [withProgress({ ...SOK, progress_error: ALTERED('close').progress_error })] }), 'run end · progress': [COK] }, AP)
  assert.equal(r5.res.status, 'finished'); assert.deepEqual([byLabel(r5.calls, 'plan-reader').length, byLabel(r5.calls, 'T00 · progress').length], [1, 1])
  drained('CL6 passed', r5.q)
})
await test('CL7: close, autonomous — the amendments of the decided option on a task done or running stay out of the issue close applies, and go to it as amendments not applied (scenario M with progress)', async () => {
  const rp = { major: true, entries: [], issues: [{ title: 'Z', options: [{ id: 'A', description: 'a', recommended: true, amendments: [{ id: 'T00', verification: ['x'], reason: 'r0' }, { id: 'T01', verification: ['y'], reason: 'r1' }] }] }] }
  const { res, calls, q } = await scenario('CL7', { 'plan-reader': [planOpened({ ...T00, status: 'merged' }, T01)], 'T01 · worker': [withProgress(report(1, { branch: 'task/T01', deviations: DEVIATION }))], 'T01 · verification': [withProgress(ok(2))], 'T01 · evaluation': [withProgress({ verdict: 'pass' })], 'T01 · merge': [withProgress(MOK)], 'T01 · replanning': [rp], 'T01 · progress': [withProgress(SOK)], 'run end · progress': [COK] }, { ...AP, mode: 'auto' })
  assert.equal(res.status, 'finished')
  assert.deepEqual(res.discarded_amendments.map(a => [a.task, a.id]), [['T01', 'T00'], ['T01', 'T01']])
  const E = progressOf(calls, 'T01 · progress')[1].E
  assert.deepEqual([E.issues[0].auto, E.issues[0].options[0].amendments, E.discarded_amendments], ['A', [], [{ id: 'T00', reason: 'r0' }, { id: 'T01', reason: 'r1' }]])
  drained('CL7', q)
})
// ——— 0.20.0: rulings by reference. The pilot records the user's answers with progress.mjs rule; the plan reader that opens the
// run applies them (progress.mjs apply) before it reads the plan, in the same call; no option goes through args any more ———
const APPLY_CMD = 'node /plug/scripts/progress.mjs apply plans/p'
// The detail of a refused ruling says when an issue is open again, and when apply dropped the ruling: its output does not say which
const REOPENED = 'An issue is open again only when apply reopened it, its option invalid with the reason (refused by plan-lint or by an action, or no entry in ISSUES.json); a ruling on an unknown or already settled issue, an absent option or an option already invalid is dropped, and nothing is reopened.'
const L0 = ['plan-reader', 'T00 · worker', 'T00 · verification', 'T00 · evaluation', 'T00 · merge', 'T00 · progress', 'run end · progress']
// Outside the ~~~ blocks of an instruction: what the agent reads as instructions, not the JSON it copies to a script
const prose = prompt => prompt.replace(/~~~sh\n[\s\S]*?\n~~~/g, '')
await test('RB1: without a ruling, no agent call more than in 0.19 — the plan reader opens the run, runs apply, then plan-lint; apply writes nothing', async () => {
  const { res, calls, q } = await scenario('RB1', { 'plan-reader': [planOpened(T00)], ...s00(), 'run end · progress': [COK] }, AP)
  assert.equal(res.status, 'finished'); assert.deepEqual(res.rulings_applied, [])
  assert.deepEqual(calls.map(c => c.opts.label), L0, 'the calls of 0.19 without a ruling')
  const lp = byLabel(calls, 'plan-reader')[0].prompt
  const at = [lp.indexOf("progress.mjs run-start plans/p <<'ORCHESTRE_JSON'"), lp.indexOf(`~~~sh\n${APPLY_CMD}\n~~~`), lp.indexOf('Then run `node /plug/scripts/plan-lint.mjs plans/p --reader')]
  assert.ok(at.every(i => i > 0) && at[0] < at[1] && at[1] < at[2], 'run-start, then apply, then plan-lint: ' + at)
  assert.ok(lp.includes('return it in "apply" exactly as printed') && lp.includes('stop there without running plan-lint: apply_ok=false'))
  assert.ok(!('rulings_applied' in progressOf(calls, 'run end · progress')[0].E), 'run-end keeps what apply noted in the run')
  drained('RB1', q)
  // Without progress, nothing to apply: no apply command
  const r = await scenario('RB1 no progress', { 'plan-reader': [plan(T00)], ...t00(), 'T00 · progress': [SOK] })
  assert.deepEqual(r.calls.map(c => c.opts.label), ['plan-reader', 'T00 · worker', 'T00 · verification', 'T00 · evaluation', 'T00 · merge', 'T00 · progress'])
  assert.ok(r.calls.every(c => !c.prompt.includes(' apply ')))
  drained('RB1 no progress', r.q)
  // The real progress.mjs: apply without a ruling prints its output and commits nothing
  const D = toyRepo()
  try {
    const head = D.git('rev-parse', 'HEAD').trim()
    const p = await play('RB1 real', D, { 'plan-reader': [plan({ ...T0, status: 'merged' })], 'run end · progress': [{ commit: '', detail: '' }] })
    assert.deepEqual(p.calls.map(c => c.label), ['plan-reader', 'run end · progress'])
    assert.deepEqual(p.launched.slice(0, 2).map(l => [l.label, l.code]), [['plan-reader', 0], ['plan-reader', 0]])
    assert.deepEqual(JSON.parse(p.launched[1].out), NO_RULING)
    assert.equal(p.res.status, 'finished'); assert.deepEqual(p.res.progress_failures, [])
    assert.equal(D.git('rev-parse', 'HEAD').trim(), head, 'no commit')
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
await test('RB2: real progress.mjs — three rulings recorded by rule: one single agent call, the plan reader, applies them and reads the plan before the first task; one commit', async () => {
  const D = toyRepo()
  try {
    const ids = seed(D, [
      { title: 'Lint', context: 'c', human: false, options: [{ id: 'A', description: 'Lint the guard', recommended: true, amendments: [{ id: 'T01', verification: ['npm run lint'], reason: 'lint the guard' }] }, { id: 'B', description: 'Leave it' }] },
      { title: 'Docs', context: 'c', human: false, options: [{ id: 'A', description: 'Document it', recommended: true, entries: [{ type: 'debt', severity: 'minor', description: 'document the guard' }] }, { id: 'B', description: 'Leave it' }] },
      { title: 'Naming', context: 'c', human: false, options: [{ id: 'A', description: 'x' }, { id: 'B', description: 'y' }] },
    ])
    script(D, 'rule', { items: [{ issue: ids[0], option: 'A' }, { issue: ids[1], option: 'A' }, { issue: ids[2], text: 'Keep the current name' }] })
    const head = D.git('rev-parse', 'HEAD').trim()
    const { res, launched, calls } = await play('RB2', D, {
      'plan-reader': [plan({ ...T0, status: 'merged' }, T1)], 'T01 · worker': [report(1, { branch: 'task/T01' })], 'T01 · verification': [ok(1)], 'T01 · evaluation': [{ verdict: 'pass' }], 'T01 · merge': [MOK], 'T01 · progress': [SOK],
      'run end · progress': [{ commit: '', detail: '' }] })
    assert.deepEqual(launched.filter(l => l.code !== 0), [])
    assert.deepEqual(calls.map(c => c.label).slice(0, 2), ['plan-reader', 'T01 · worker'], 'one single call before the first task')
    const out = JSON.parse(launched[1].out)
    assert.deepEqual([launched[1].label, out.applied.map(a => a.issue), out.rejected], ['plan-reader', ids, []])
    assert.deepEqual(res.rulings_applied, [{ issue: ids[0], task: 'T00', option: 'A', text: null }, { issue: ids[1], task: 'T00', option: 'A', text: null }, { issue: ids[2], task: 'T00', option: null, text: 'Keep the current name' }])
    assert.equal(res.status, 'finished')
    assert.deepEqual(D.git('log', '--format=%s', `${head}..HEAD`).trim().split('\n').reverse(), [`progress: rulings ${ids.join(', ')}`, 'progress(T01): merged'])
    assert.ok(fs.readFileSync(join(D.root, 'plans', 'p', 'tasks', 'T01-x.md'), 'utf8').includes('  - "npm run lint"'))
    const w = calls.find(c => c.label === 'T01 · worker').prompt
    for (const x of [`${ids[0]}: option A (settled by the user)`, `${ids[2]}: Keep the current name (settled by the user)`]) assert.ok(w.includes(x), 'worker decisions: ' + x)
    assert.deepEqual(D.doc().runs[1].rulings_applied, [{ task: 'T00', title: 'Lint', option: 'A' }, { task: 'T00', title: 'Docs', option: 'A' }, { task: 'T00', title: 'Naming', option: 'free answer' }], 'kept by run-end')
    assert.deepEqual(register(D).issues.map(p => [p.id, p.status]), ids.map(id => [id, 'settled']))
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
await test('RB3: real progress.mjs — a ruling apply refuses stops the run before any task, in awaiting-ruling, its issue open again; the other two are applied', async () => {
  const D = toyRepo()
  try {
    D.writeTask('T02', []); script(D, 'view'); D.git('add', 'plans'); D.git('commit', '-qm', 'T02')
    // Each option alone is valid (dry run); the second, after the first, makes a cycle
    const ids = seed(D, [
      { title: 'Order', context: 'c', human: false, options: [{ id: 'A', description: 'T02 after T01', amendments: [{ id: 'T02', depends_on: ['T01'], reason: 'after T01' }] }, { id: 'B', description: 'Leave it' }] },
      { title: 'Reverse', context: 'c', human: false, options: [{ id: 'A', description: 'T01 after T02', amendments: [{ id: 'T01', depends_on: ['T02'], reason: 'after T02' }] }, { id: 'B', description: 'Leave it' }] },
      { title: 'Docs', context: 'c', human: false, options: [{ id: 'A', description: 'Document it', entries: [{ type: 'debt', severity: 'minor', description: 'document the order' }] }, { id: 'B', description: 'Leave it' }] },
    ])
    assert.deepEqual(D.doc().issues.map(p => p.options[0].valid), [true, true, true], 'each option valid alone')
    script(D, 'rule', { items: [{ issue: ids[0], option: 'A' }, { issue: ids[1], option: 'A' }, { issue: ids[2], option: 'A' }] })
    const T2 = { ...T1, id: 'T02', depends_on: [], file: 'plans/p/tasks/T02-x.md' }
    const { res, launched, calls } = await play('RB3', D, { 'plan-reader': [plan(T1, T2)], 'run end · progress': [{ commit: '', detail: '' }] })
    assert.deepEqual(launched.filter(l => l.code !== 0), [])
    assert.deepEqual(calls.map(c => c.label), ['plan-reader', 'run end · progress'], 'no task started')
    assert.equal(res.status, 'awaiting-ruling'); assert.ok(!('stop_issue' in res), 'no new issue: the one ruled on is open again')
    assert.deepEqual(res.rulings_applied.map(a => a.issue), [ids[0], ids[2]])
    assert.deepEqual(res.rulings_refused.map(x => [x.issue, x.option]), [[ids[1], 'A']]); assert.match(res.rulings_refused[0].reason, /cycle/)
    assert.ok(res.detail.startsWith(`rulings refused by apply: ${ids[1]} (option A: plan-lint:`) && res.detail.endsWith(`. ${REOPENED} No task started.`), res.detail)
    const reg = register(D).issues
    assert.deepEqual(reg.map(p => [p.id, p.status, p.options[0].valid]), [[ids[0], 'settled', true], [ids[1], 'open', false], [ids[2], 'settled', true]])
    assert.match(reg[1].options[0].invalid_reason, /cycle/)
    const doc = D.doc()
    assert.deepEqual(doc.issues.map(p => [p.id, p.status]), [[ids[0], 'settled'], [ids[1], 'open'], [ids[2], 'settled']], 'run-end added no issue')
    assert.deepEqual(doc.pending_rulings, [])
    assert.deepEqual([doc.runs[1].status, doc.runs[1].rulings_applied.map(a => a.title)], ['awaiting-ruling', ['Order', 'Docs']])
    assert.equal(spawnSync(process.execPath, [PROGRESS_SCRIPT, 'validate', 'plans/p'], { cwd: D.root }).status, 0)
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
await test('RB4: apply failed, its copy unfaithful, or an amendment it discarded — the run stops before any task or goes on; the clerk closes the run', async () => {
  const E1 = 'progress: apply: the main checkout is on main, not on the integration branch plan/p'
  let { res, calls, q } = await scenario('RB4 failed', { 'plan-reader': [{ ...planOpened(T00), apply_ok: false, apply_error: E1 }], 'run end · progress': [COK] }, AP)
  assert.deepEqual(calls.map(c => c.opts.label), ['plan-reader', 'run end · progress'])
  assert.deepEqual([res.status, res.detail], ['error', `progress: rulings not applied (apply), no task started — ${E1}. The rulings stay recorded: the next run applies them.`])
  drained('RB4 failed', q)
  ;({ res, calls, q } = await scenario('RB4 not reported', { 'plan-reader': [{ ...planOpened(T00), apply: NO_RULING }], 'run end · progress': [COK] }, AP))
  assert.ok(res.status === 'error' && res.detail.endsWith('result not reported. The rulings stay recorded: the next run applies them.'), res.detail)
  drained('RB4 not reported', q)
  const lie = { ...NO_RULING, rejected: [] , applied: [{ issue: 'T02-1', task: 'T02', option: 'B', text: null }] }
  ;({ res, calls, q } = await scenario('RB4 unfaithful', { 'plan-reader': [{ ...planOpened(T00), apply_ok: true, apply: lie }], 'run end · progress': [COK] }, AP))
  assert.deepEqual([res.status, calls.length, res.rulings_applied], ['error', 2, []])
  assert.ok(res.detail.startsWith('progress: output of apply not read, no task started — the copy does not match its digest.'), res.detail)
  drained('RB4 unfaithful', q)
  // A copy without its lists, whatever its digest: not read either, and the workflow does not throw
  ;({ res, calls, q } = await scenario('RB4 without lists', { 'plan-reader': [{ ...planOpened(T00), apply_ok: true, apply: sealApply({ commit: null, message: 'no ruling to apply' }) }], 'run end · progress': [COK] }, AP))
  assert.deepEqual([res.status, calls.length], ['error', 2]); assert.ok(res.detail.startsWith('progress: output of apply not read'), res.detail)
  drained('RB4 without lists', q)
  // Faithful, with an amendment discarded: the run goes on; the pilot gets it in the return (task null: apply's output does not
  // give it). run-end gets an empty list: apply already noted it in the run with its task, and run-end keeps what the run holds
  const kept = sealApply({ applied: [{ issue: 'T02-1', task: 'T02', option: 'B', text: null }], rejected: [], discarded: [{ id: 'T09', reason: 'merged' }], amended: [], added_tasks: [], commit: 'a1', message: '1 ruling applied (T02-1); committed a1' })
  ;({ res, calls, q } = await scenario('RB4 discarded', { 'plan-reader': [{ ...planOpened(T00), apply_ok: true, apply: kept }], ...s00(), 'run end · progress': [COK] }, AP))
  assert.equal(res.status, 'finished'); assert.deepEqual(res.discarded_amendments, [{ task: null, id: 'T09', reason: 'merged' }])
  assert.deepEqual(res.rulings_applied, [{ issue: 'T02-1', task: 'T02', option: 'B', text: null }])
  const re = progressOf(calls, 'run end · progress')[0].E
  assert.deepEqual([re.discarded_amendments, 'rulings_applied' in re], [[], false])
  assert.ok(byLabel(calls, 'T00 · worker')[0].prompt.includes('"T02-1: option B (settled by the user)"'))
  drained('RB4 discarded', q)
  // Refused, in the copy: awaiting-ruling before any task
  const refused = sealApply({ ...kept, discarded: [], rejected: [{ issue: 'T02-2', option: null, text: 'x', reason: 'issue already settled' }] })
  ;({ res, calls, q } = await scenario('RB4 refused', { 'plan-reader': [{ ...planOpened(T00), apply_ok: true, apply: refused }], 'run end · progress': [COK] }, AP))
  assert.deepEqual([res.status, res.detail, calls.length], ['awaiting-ruling', `rulings refused by apply: T02-2 (text: issue already settled). ${REOPENED} No task started.`, 2])
  assert.equal(progressOf(calls, 'run end · progress')[0].E.status, 'awaiting-ruling')
  drained('RB4 refused', q)
})
await test('RB5: real progress.mjs, autonomous — the automatic decision reaches the register through the close (auto: <option> on the issue); no action of an option goes through the instructions of an agent', async () => {
  const D = toyRepo()
  try {
    const [A, B] = RP_E.issues[0].options
    const RP = { ...RP_E, issues: [{ ...RP_E.issues[0], options: [{ ...A, added_tasks: [{ id: 'T00C', title: 'Rule d test', phase: 0, content: taskText('T00C', ['T00'], 0) }] }, B] }] }
    const { res, launched, calls } = await play('RB5', D, {
      'plan-reader': [{ ...plan(T0), all: [{ id: 'T00', phase: 1, status: 'todo' }, { id: 'T01', phase: 1, status: 'todo' }] }], 'T00 · worker': [report(0, { deviations: DEVIATION })], 'T00 · verification': [ok(1)], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [MOK],
      'T00 · replanning': [RP], 'T00 · progress': [SOK], 'run end · progress': [{ commit: '', detail: '' }] }, { mode: 'auto' })
    assert.deepEqual(launched.filter(l => l.code !== 0), [])
    assert.equal(res.status, 'rerun', 'T00C added to the phase')
    assert.deepEqual(res.auto_decisions.map(d => [d.title, d.option]), [['UpdateUserSchema contract', 'A']])
    // The close carries the issue whole, auto naming the option; close applies it
    const cl = calls.find(c => c.label === 'T00 · progress').prompt
    const E = progressCommands(cl).map(parse).find(x => x.cmd === 'close').E
    assert.deepEqual(E.issues.map(p => [p.title, p.auto]), [['UpdateUserSchema contract', 'A']])
    assert.ok(!('entries' in E) || E.entries.every(e => !/taken automatically/.test(e.description)), 'the decision entry is not passed apart: close writes it from auto')
    const reg = register(D).issues
    assert.deepEqual(reg.map(p => [p.title, p.status, p.ruling.option, p.ruling.author]), [['UpdateUserSchema contract', 'settled', 'A', 'auto']])
    assert.deepEqual(reg[0].options[0].amendments.map(a => a.id), ['T01'])
    assert.ok(fs.readFileSync(join(D.root, 'plans', 'p', 'tasks', 'T01-x.md'), 'utf8').includes('  - "pnpm test:rule-d"'), 'amendment applied by close')
    assert.equal(D.git('log', '-1', '--format=%s').trim(), 'progress(T00): merged')
    const files = D.git('show', '--name-only', '--format=', 'HEAD').trim().split('\n')
    for (const f of ['plans/p/ISSUES.json', 'plans/p/HANDOFF.md', 'plans/p/tasks/T01-x.md', 'plans/p/tasks/T00C-rule-d-test.md']) assert.ok(files.includes(f), `${f} in the commit of close: ${files}`)
    // No agent reads an action of the option as an instruction: neither the scribe nor any other, and no ruling call
    assert.ok(calls.every(c => !c.label.startsWith('ruling ')))
    for (const c of calls) for (const x of ['pnpm test:rule-d', 'document the contract', 'T00C', 'New tasks: create them', 'Amendments, for tasks not yet started']) assert.ok(!prose(c.prompt).includes(x), `${c.label}: ${x}`)
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
// ——— 0.20.0, fixes before the release (T20D): the whole close, an auto-decision close rejects, a dependency close adds ———
// The lines under "## <id>" of HANDOFF.md, without their "- "
const section = (D, id) => {
  const ls = fs.readFileSync(join(D.root, 'plans', 'p', 'HANDOFF.md'), 'utf8').split('\n'), h = ls.indexOf(`## ${id}`), out = []
  for (let i = h + 1; h >= 0 && i < ls.length && !ls[i].startsWith('## '); i++) if (ls[i].startsWith('- ')) out.push(ls[i].slice(2))
  return out
}
// T00 alone in the phase's tasks; T01, of the same phase, only in "all": amendable, never started in the run
const onlyT0 = () => ({ ...plan(T0), all: [{ id: 'T00', phase: 1, status: 'todo' }, { id: 'T01', phase: 1, status: 'todo' }] })
const closeOf = launched => JSON.parse(launched.filter(l => l.label === 'T00 · progress').pop().out)
await test('CL8: real progress.mjs, autonomous — one close of T00 carries an added task, an amendment, a review, a rejected attempt, an unverifiable criterion, a flaky test and an automatic decision: one commit, each line of HANDOFF.md once', async () => {
  const D = toyRepo()
  try {
    const GAP = 'the guard of rule (d) has no test', UV = 'rule (d) in a worktree: not provable from the main checkout', FLAKY = 'journal.spec.ts:53'
    const R = { type: 'review', description: '.env.example: add MR_MAX' }
    const AUTO = { title: 'UpdateUserSchema contract', context: 'isSuperAdmin optional', options: [
      { id: 'A', description: 'Keep optional and test rule (d)', recommended: true, entries: [{ type: 'debt', severity: 'minor', description: 'document the contract' }], amendments: [{ id: 'T01', verification: ['pnpm test:rule-d'], reason: 'security rule without a test' }] },
      { id: 'B', description: 'Make the field required', recommended: false }] }
    const RP = { major: true, entries: [{ type: 'deviation', severity: 'major', description: 'contract widened' }], added_tasks: [{ id: 'T00C', title: 'Rule d test', phase: 1, content: taskText('T00C', ['T00']) }], issues: [AUTO] }
    const P = join(D.root, 'plans', 'p'), head = D.git('rev-parse', 'HEAD').trim()
    const { res, launched, calls } = await play('CL8', D, {
      'plan-reader': [onlyT0()], 'T00 · worker': [report(0, { deviations: [...DEVIATION, R] })], 'T00 · verification': [ok(1), { ...ok(2), flaky: [FLAKY] }],
      'T00 · evaluation': [{ verdict: 'fail', gaps: [GAP] }, { verdict: 'pass', unverifiable: [UV] }], 'T00 · fix 1': [report(1)], 'T00 · merge': [MOK], 'T00 · replanning': [RP],
      // The scribe (findings, a flaky test) files a finding in DISCOVERY.md, then runs close
      'T00 · progress': [{ before: () => fs.appendFileSync(join(P, 'DISCOVERY.md'), '- routes prewarmed 1\n'), answer: SOK }], 'run end · progress': [{ commit: '', detail: '' }] }, { mode: 'auto' })
    assert.deepEqual(launched.filter(l => l.code !== 0), [])
    assert.deepEqual([res.status, res.progress_failures, 'stop_issue' in res], ['rerun', [], false], 'T00C added to the phase, nothing rejected')
    assert.ok(!calls.some(c => c.label.startsWith('T00C ')), 'a task added during a run does not start in it')
    // One close, by the scribe: every piece of it in the input
    const E = progressCommands(calls.find(c => c.label === 'T00 · progress').prompt).map(parse).find(x => x.cmd === 'close').E
    assert.deepEqual([E.rejections, E.unverifiable, E.flaky, E.reviews, E.added_tasks.map(x => x.id), E.issues.map(p => [p.title, p.auto])], [[{ attempt: 1, by: 'evaluation', gaps: [GAP] }], [UV], [FLAKY], [R.description], ['T00C'], [[AUTO.title, 'A']]])
    assert.deepEqual(closeOf(launched).rejected, [])
    // A single commit on the integration branch, with the added task, the amended task, HANDOFF.md and DISCOVERY.md
    assert.deepEqual(D.git('log', '--format=%s', `${head}..HEAD`).trim().split('\n'), ['progress(T00): merged'])
    const files = D.git('show', '--name-only', '--format=', 'HEAD').trim().split('\n')
    for (const f of ['plans/p/tasks/T00C-rule-d-test.md', 'plans/p/tasks/T01-x.md', 'plans/p/HANDOFF.md', 'plans/p/DISCOVERY.md', 'plans/p/ISSUES.json']) assert.ok(files.includes(f), `${f} in the commit of close: ${files}`)
    assert.ok(fs.readFileSync(join(P, 'tasks', 'T01-x.md'), 'utf8').includes('  - "pnpm test:rule-d"'))
    // Each line of the close once, in the order of close, the decision line and the review line included
    assert.deepEqual(section(D, 'T00'), [
      'deviation · major · contract widened',
      'review · major · .env.example: add MR_MAX',
      `rejection · minor · attempt 1, evaluation: ${GAP}`,
      `blind-spot · minor · criterion unverifiable in the context of the task: ${UV}`,
      `debt · minor · flaky test, passed on the second run: ${FLAKY}`,
      'decision · major · UpdateUserSchema contract: option A taken automatically (autonomous mode) — Keep optional and test rule (d)',
      'debt · minor · document the contract',
      'amendment · major · T01: security rule without a test',
    ])
    assert.deepEqual(register(D).issues.map(p => [p.title, p.status, p.ruling && p.ruling.author]), [[AUTO.title, 'settled', 'auto']])
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
await test('CL9: real progress.mjs, autonomous — the decided option gives T01 an owned file that neither exists nor belongs to a task the close creates: close rejects the decision by itself, the issue stays open, a human stop', async () => {
  const D = toyRepo()
  try {
    const MISSING = 'src/schema/user.ts'
    const AUTO = { title: 'Schema owner', context: 'c', options: [
      { id: 'A', description: 'T01 owns the schema', recommended: true, entries: [{ type: 'debt', severity: 'minor', description: 'document the schema' }], amendments: [{ id: 'T01', owned_files: [MISSING], verification: ['pnpm test:schema'], reason: 'owns the schema' }] },
      { id: 'B', description: 'Leave it', recommended: false }] }
    const P = join(D.root, 'plans', 'p'), t01 = fs.readFileSync(join(P, 'tasks', 'T01-x.md'), 'utf8'), head = D.git('rev-parse', 'HEAD').trim()
    // The clerk (no finding) reports no "missing": the check of the agent was skipped, close's own check holds
    const { res, launched } = await play('CL9', D, {
      'plan-reader': [onlyT0()], 'T00 · worker': [report(0, { findings: [], deviations: DEVIATION })], 'T00 · verification': [ok(1)], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [MOK],
      'T00 · replanning': [{ major: true, entries: [], issues: [AUTO] }], 'T00 · progress': [SOK], 'run end · progress': [{ commit: '', detail: '' }] }, { mode: 'auto' })
    assert.deepEqual(launched.filter(l => l.code !== 0), [])
    const reason = `inconsistent auto-decision on issue "${AUTO.title}", option A: ${MISSING} does not exist and no task creates it`
    assert.deepEqual(closeOf(launched).rejected, [{ id: MISSING, reason }])
    assert.deepEqual([res.status, res.stop_issue.title, res.stop_issue.human, JSON.parse(res.stop_issue.context)], ['awaiting-ruling', 'Progress of T00: tasks, amendments or decisions rejected', true, [{ id: MISSING, reason }]])
    // Nothing of the option is written: T01 as it was, no decision nor entry of the option; the needs-human entry instead
    assert.equal(fs.readFileSync(join(P, 'tasks', 'T01-x.md'), 'utf8'), t01)
    assert.deepEqual(section(D, 'T00'), [`needs-human · major · inconsistent auto-decision: ${MISSING} does not exist and no task creates it`])
    assert.deepEqual(register(D).issues.map(p => [p.title, p.status, p.ruling]), [[AUTO.title, 'open', null]])
    assert.deepEqual(D.git('log', '--format=%s', `${head}..HEAD`).trim().split('\n'), ['progress(T00): merged'])
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
await test('CL10: real progress.mjs — the replanner adds a task that shares files with a task of its phase, without a dependency: close gives it a depends_on and its HANDOFF line, rejects nothing; no stop, and the task does not start in this run', async () => {
  const D = toyRepo()
  try {
    const content = taskText('T00D', ['T00']).replace('src/T00D/**', 'src/T01/**')
    const RP = { major: false, entries: [], issues: [], added_tasks: [{ id: 'T00D', title: 'Shares T01', phase: 1, content }] }
    const { res, launched, calls } = await play('CL10', D, {
      'plan-reader': [onlyT0()], 'T00 · worker': [report(0, { findings: [], deviations: DEVIATION })], 'T00 · verification': [ok(1)], 'T00 · evaluation': [{ verdict: 'pass' }], 'T00 · merge': [MOK],
      'T00 · replanning': [RP], 'T00 · progress': [SOK], 'run end · progress': [{ commit: '', detail: '' }] })
    assert.deepEqual(launched.filter(l => l.code !== 0), [])
    assert.deepEqual(closeOf(launched).rejected, [], 'nothing rejected: the overlap is settled by a dependency')
    assert.deepEqual([res.status, 'stop_issue' in res, res.added_tasks.map(x => x.id)], ['rerun', false, ['T00D']])
    assert.ok(!calls.some(c => c.label.startsWith('T00D ')), 'the added task does not start in this run')
    assert.match(fs.readFileSync(join(D.root, 'plans', 'p', 'tasks', 'T00D-shares-t01.md'), 'utf8'), /^depends_on: \[T00, T01\]$/m)
    assert.deepEqual(section(D, 'T00'), ['amendment · minor · T00D: depends on T01, added automatically: the two tasks of phase 1 share src/T01/**'])
  } finally { fs.rmSync(D.root, { recursive: true, force: true }) }
})
console.log(`scenarios: ALL GREEN (${n} cases)`)
