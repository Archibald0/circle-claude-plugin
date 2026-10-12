// Tests of status.mjs (/orchestre:status) on a toy plan, in a temporary git repository.
// Usage: node tests/status.test.mjs [path of status.mjs]
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

const STATUS = resolve(process.argv[2] || 'plugins/orchestre/scripts/status.mjs')
const root = mkdtempSync(join(tmpdir(), 'status-'))
const elsewhere = mkdtempSync(join(tmpdir(), 'outside-git-'))
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const status = (args = [], cwd = root) => { const r = spawnSync('node', [STATUS, ...args], { cwd, encoding: 'utf8' }); return { code: r.status, out: r.stdout.trim() } }
const task = (id, phase, extra = '') => `---\nid: ${id}\ntitle: Task ${id}\nphase: ${phase}\nmodel: sonnet\nmodel_reason: x\ndepends_on: []\nowned_files:\n  - src/${id}/**\nresources: []${extra}\ntoken_estimate: 1.0M\nverification:\n  - "npm test"\ndefinition_of_done:\n  - "the test passes"\n---\n`
const PROGRESS = rows => `| ID | Title | Phase | Status | Attempts | Branch |\n|----|-------|-------|--------|----------|--------|\n${rows.map(([id, ph, st]) => `| ${id} | Task ${id} | ${ph} | ${st} | 0 | — |`).join('\n')}\n`
let n = 0
const test = (name, fn) => { fn(); n++; console.log('ok ·', name) }

try {
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'README.md'), 'x\n'); git('add', '.'); git('commit', '-qm', 'init')
  const d = join(root, 'plans', 'demo')
  mkdirSync(join(d, 'tasks'), { recursive: true })
  const T = { T01: 1, T02: 1, T03: 2, T04: 2, T05: 2, T06: 2, T07: 3, T08: 3 }
  for (const [id, ph] of Object.entries(T)) writeFileSync(join(d, 'tasks', `${id}-x.md`), task(id, ph, id === 'T04' ? '\nprerequisites: [D5]' : ''))
  writeFileSync(join(d, 'PROGRESS.md'), PROGRESS(Object.entries(T).map(([id, ph]) => [id, ph, id === 'T06' ? 'needs-human' : id === 'T08' ? 'cancelled' : 'todo'])))
  writeFileSync(join(d, 'PREREQUISITES.md'), '| ID | Type | Prerequisite | Status | Evidence |\n|----|------|--------------|--------|----------|\n| D5 | decision | Choose the model | open | — |\n')
  writeFileSync(join(d, 'HANDOFF.md'), '# Handoff\n\n## T01\n- review · major · agents/x/.env.example: add MR_MAX\n- ticket · minor · rename the script\n\n## T02\nreview · major · command `grep -q X a` refused to agents\n')
  writeFileSync(join(d, 'orchestre.config.json'), JSON.stringify({ integration_branch: 'plan/demo', base_branch: 'main' }))
  git('switch', '-qc', 'plan/demo'); git('add', '.'); git('commit', '-qm', 'plan')
  for (const id of ['T01', 'T02']) {
    git('switch', '-qc', `task/${id}`); writeFileSync(join(root, `${id}.txt`), id); git('add', '.'); git('commit', '-qm', `feat: ${id}`)
    git('switch', '-q', 'plan/demo'); git('merge', '-q', '--no-ff', `task/${id}`, '-m', `task ${id}: Task ${id}`)
  }
  // T03 started with a commit, T05 in a worktree without a commit, T06 waiting for a human with a branch
  git('switch', '-qc', 'task/T03'); writeFileSync(join(root, 'T03.txt'), 'T03'); git('add', '.'); git('commit', '-qm', 'feat: T03'); git('switch', '-q', 'plan/demo')
  git('branch', 'task/T06')
  const wt = join(elsewhere, 'wt')
  git('worktree', 'add', '-q', '-b', 'task/T05', wt, 'plan/demo')

  const before = [git('status', '--porcelain'), git('rev-parse', 'HEAD'), git('symbolic-ref', 'HEAD')].join('|')

  test('full table: title, bar, phases, in progress, your turn', () => {
    const r = status(['plans/demo'])
    assert.equal(r.code, 0)
    const l = r.out.split('\n')
    assert.equal(l[0], '## demo — 2/7 tasks · 28%')
    assert.match(l[1], /^`█{6}░{18}` phase 2 in progress · last merge T02 (just now|\d+ min ago)$/)
    assert.ok(r.out.includes('| Phase | Progress | Tasks |'), 'header')
    assert.ok(r.out.includes('| ✓ 1 | `██████████` 100% | 2/2 |'), 'phase 1')
    assert.ok(r.out.includes('| ⚠ 2 | `░░░░░░░░░░` 0% | 0/4 |'), 'phase 2: T06 waits for a human')
    assert.ok(r.out.includes('| ○ 3 | `░░░░░░░░░░` 0% | 0/1 |'), 'phase 3: T08 cancelled, not counted')
    assert.match(r.out, /\*\*In progress\*\*: T03 \(last commit (just now|\d+ min ago)\) · T05 \(worktree, started\)$/m)
    assert.ok(r.out.includes('**Your turn**: D5 (decision) blocks T04 · T06 waits for a human · 2 reviews before the PR · 1 ticket after the PR'), r.out)
    assert.ok(!/T06 \(/.test(r.out), 'T06 waiting, not in progress')
    assert.ok(r.out.split('\n').length <= 16, 'compact')
  })
  test('read-only: neither status, HEAD nor branch changed; no lock left', () => {
    status(['plans/demo'])
    assert.equal([git('status', '--porcelain'), git('rev-parse', 'HEAD'), git('symbolic-ref', 'HEAD')].join('|'), before)
    assert.ok(!existsSync(join(root, '.git', 'index.lock')))
  })
  test('checkout on a task branch: "checkout"; without an argument, the only plan', () => {
    git('switch', '-q', 'task/T03')
    const r = status([])
    assert.match(r.out, /\*\*In progress\*\*: T03 \(checkout, last commit/)
    git('switch', '-q', 'plan/demo')
  })
  test('from a subfolder: path relative to the root', () => {
    const r = status(['plans/demo'], join(root, 'plans'))
    assert.equal(r.out.split('\n')[0], '## demo — 2/7 tasks · 28%')
  })
  test('errors on one line, code 0: plan not found, several plans, French plan of 0.11, outside a git repository', () => {
    let r = status(['plans/missing']); assert.equal(r.code, 0); assert.equal(r.out, 'orchestre:status: plan not found in this checkout: plans/missing')
    mkdirSync(join(root, 'plans', 'other', 'tasks'), { recursive: true })
    r = status([]); assert.equal(r.code, 0); assert.match(r.out, /^orchestre:status: several plans \(plans\/demo, plans\/other\); say which/)
    rmSync(join(root, 'plans', 'other'), { recursive: true })
    mkdirSync(join(root, 'plans', 'fr', 'taches'), { recursive: true })
    r = status(['plans/fr']); assert.equal(r.code, 0); assert.equal(r.out, 'orchestre:status: plan in the French format of orchestre 0.11 and earlier (taches/): /orchestre:ready plans/fr or /orchestre:run plans/fr offers to migrate it')
    rmSync(join(root, 'plans', 'fr'), { recursive: true })
    r = status([], elsewhere); assert.equal(r.code, 0); assert.equal(r.out, 'orchestre:status: not in a git repository')
  })
  test('plan-lint in error: reported in "Your turn"', () => {
    writeFileSync(join(d, 'tasks', 'T09-x.md'), task('T09', 3).replace('  - "npm test"\n', '').replace('verification:\n', 'verification: []\n'))
    const r = status(['plans/demo'])
    assert.ok(r.out.includes('plan-lint: 1 error'), r.out)
    rmSync(join(d, 'tasks', 'T09-x.md'))
  })
  test('task without a model: a plan-lint warning, not an error; unknown model: an error', () => {
    writeFileSync(join(d, 'tasks', 'T09-x.md'), task('T09', 3).replace('model: sonnet\n', ''))
    let r = status(['plans/demo'])
    assert.ok(r.out.includes('| ○ 3 | `░░░░░░░░░░` 0% | 0/2 |') && !r.out.includes('plan-lint'), r.out)
    writeFileSync(join(d, 'tasks', 'T09-x.md'), task('T09', 3).replace('model: sonnet', 'model: gpt-5'))
    r = status(['plans/demo'])
    assert.ok(r.out.includes('plan-lint: 1 error'), r.out)
    rmSync(join(d, 'tasks', 'T09-x.md'))
  })
  test('git history of 0.11 read too: branch tache/<id> in progress, commit "tâche <id> : " merged', () => {
    git('switch', '-qc', 'tache/T04'); writeFileSync(join(root, 'T04.txt'), 'T04'); git('add', '.'); git('commit', '-qm', 'feat: T04'); git('switch', '-q', 'plan/demo')
    let r = status(['plans/demo'])
    assert.match(r.out, /\*\*In progress\*\*: T03 \(last commit [^)]*\) · T04 \(last commit [^)]*\) · T05 \(worktree, started\)$/m)
    git('merge', '-q', '--no-ff', 'tache/T04', '-m', 'tâche T04 : Tâche T04')
    r = status(['plans/demo'])
    assert.equal(r.out.split('\n')[0], '## demo — 3/7 tasks · 42%')
    assert.match(r.out.split('\n')[1], / · last merge T04 /)
  })
  test('plan finished', () => {
    for (const id of ['T03', 'T05', 'T06', 'T07']) git('commit', '-q', '--allow-empty', '-m', `task ${id}: Task ${id}`)
    const r = status(['plans/demo'])
    assert.equal(r.out.split('\n')[0], '## demo — 7/7 tasks · 100%')
    assert.match(r.out.split('\n')[1], /^`█{24}` plan finished · last merge T07 /)
    assert.ok(!r.out.includes('**In progress**'))
  })
  console.log(`status: ALL GREEN (${n} tests)`)
} finally {
  rmSync(root, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true })
}
