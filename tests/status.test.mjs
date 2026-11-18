// Tests of status.mjs (/orchestre:status) on a toy plan, in a temporary git repository.
// Usage: node tests/status.test.mjs [path of status.mjs]
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

const STATUS = resolve(process.argv[2] || 'plugins/orchestre/scripts/status.mjs')
const root = mkdtempSync(join(tmpdir(), 'status-'))
const elsewhere = mkdtempSync(join(tmpdir(), 'outside-git-'))
const eq = mkdtempSync(join(tmpdir(), 'status-eq-'))
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const status = (args = [], cwd = root) => { const r = spawnSync('node', [STATUS, ...args], { cwd, encoding: 'utf8' }); return { code: r.status, out: r.stdout.trim() } }
const task = (id, phase, extra = '') => `---\nid: ${id}\ntitle: Task ${id}\nphase: ${phase}\nmodel: sonnet\nmodel_reason: x\ndepends_on: []\nowned_files:\n  - src/${id}/**\nresources: []${extra}\ntoken_estimate: 1.0M\nverification:\n  - "npm test"\ndefinition_of_done:\n  - "the test passes"\n---\n`
const PROGRESS = rows => `| ID | Title | Phase | Status | Attempts | Branch |\n|----|-------|-------|--------|----------|--------|\n${rows.map(([id, ph, st]) => `| ${id} | Task ${id} | ${ph} | ${st} | 0 | — |`).join('\n')}\n`
// The same progress.json in the contract of 0.20.0: issues with their id, pending_rulings (status.mjs reads both)
const as4 = raw => ({ ...raw, format: 'orchestre-progress/4', issues: (raw.issues || []).map((p, i) => ({ id: `${p.task}-${i + 1}`, ...p })), pending_rulings: [] })
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
    assert.ok(r.out.endsWith('**Now**: D5 (decision) blocks T04 · T06 waits for a human\n**Later**: 2 reviews after phase 1 · 1 ticket after the PR'), r.out)
    assert.ok(!/T06 \(/.test(r.out), 'T06 waiting, not in progress')
    assert.ok(r.out.split('\n').length <= 16, 'compact')
  })
  test('progress.json (0.16.0), in /3 and in /4: the reviews done or moved to tickets no longer wait; the tickets moved count', () => {
    const f = join(root, 'plans', 'demo', 'progress.json')
    const reviews = [{ task: 'T01', text: 'a', done: '2026-11-02T10:00:00+01:00' }, { task: 'T01', text: 'b', ticket: '2026-11-02T10:00:00+01:00' }, { task: 'T02', text: 'c' }]
    const v3 = { format: 'orchestre-progress/3', reviews, auto_decisions: [{ task: 'T02', title: 'd', ticket: '2026-11-02T10:00:00+01:00' }] }
    for (const raw of [v3, as4(v3)]) {
      writeFileSync(f, JSON.stringify(raw))
      const r = status(['plans/demo'])
      assert.ok(r.out.endsWith('**Later**: 1 review after phase 1 · 3 tickets after the PR'), `${raw.format}\n${r.out}`)
    }
    rmSync(f)
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
  // ── The moments of "Your turn" (0.19.0): one line per moment, the rules of the mod, on the same progress.json ──
  // status.mjs loads nothing from the mod: the rules are written a second time, and these cases compare both.
  const VM = await import(pathToFileURL(join(dirname(STATUS), '..', 'hooks', 'view-model.mjs')).href)
  const g = (...a) => execFileSync('git', a, { cwd: eq, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const E = join(eq, 'plans', 'eq')
  const PH = { T01: 1, T02: 1, T03: 2, T04: 2, T05: 3, T06: 4 }
  const BEHIND = { T01: ['H3'], T02: ['H1', 'D1'], T03: ['EV1'], T04: ['D9'] }
  const PRE = [['H1', 'manual', ['T02']], ['D1', 'decision', ['T02']], ['EV1', 'manual', ['T03']], ['D9', 'decision', ['T04']], ['H3', 'environment', ['T01']]]
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false')
  writeFileSync(join(eq, 'README.md'), 'x\n'); g('add', '.'); g('commit', '-qm', 'init')
  mkdirSync(join(E, 'tasks'), { recursive: true })
  for (const [id, ph] of Object.entries(PH)) writeFileSync(join(E, 'tasks', `${id}-x.md`), task(id, ph, BEHIND[id] ? `\nprerequisites: [${BEHIND[id].join(', ')}]` : ''))
  writeFileSync(join(E, 'PROGRESS.md'), PROGRESS(Object.entries(PH).map(([id, ph]) => [id, ph, id === 'T06' ? 'cancelled' : 'todo'])))
  writeFileSync(join(E, 'PREREQUISITES.md'), `| ID | Type | Prerequisite | Status | Evidence |\n|----|------|--------------|--------|----------|\n${PRE.map(([id, type]) => `| ${id} | ${type} | Do ${id} | open | — |`).join('\n')}\n`)
  writeFileSync(join(E, 'HANDOFF.md'), '# Handoff\n')
  writeFileSync(join(E, 'orchestre.config.json'), JSON.stringify({ integration_branch: 'plan/eq', base_branch: 'main' }))
  g('switch', '-qc', 'plan/eq'); g('add', '.'); g('commit', '-qm', 'plan')
  g('commit', '-q', '--allow-empty', '-m', 'task T01: Task T01')
  const ago = ms => new Date(Date.now() - ms).toISOString()
  const run = (status, o = {}) => ({ number: 1, phase: 1, mode: 'phase', parallelism: 1, status, start: ago(600000), end: status === 'in-progress' ? null : ago(60000), rulings_applied: [], ...o })
  const issue = (task, title) => ({ task, title, status: 'open', human: false, role: 'worker' })
  const review = (task, text, phase = null) => ({ task, phase, text, run: 1, at: ago(1000) })
  const REVIEWS = [review('T01', 'first `a.md`: relire', 1), review('T01', 'same passage `a.md`: autre', 1), review('T02', 'sans passage', 1), review(null, 'plan source'), review('T03', 'later `b.md`', 2), review('T05', 'last phase `c.md`', 3)]
  const DECISIONS = [{ task: 'T01', title: 'Seuil', option: 'A', description: '' }, { task: 'T05', title: 'Dernier', option: 'B', description: '' }]
  const doc = (o = {}) => ({
    format: 'orchestre-progress/3', plan: 'eq', dir: 'plans/eq', updated: ago(1000),
    tasks: Object.entries(PH).map(([id, phase]) => ({ id, title: `Task ${id}`, phase, status: id === 'T01' ? 'merged' : id === 'T06' ? 'cancelled' : (o.statuses || {})[id] || 'todo', ...((o.steps || {})[id] ? { step: o.steps[id], start: ago(300000) } : {}) })),
    runs: [run('finished')], issues: [], auto_decisions: DECISIONS, reviews: REVIEWS, handoff: {}, lint: { ok: true, errors: [] }, log: [],
    prerequisites: PRE.map(([id, type, blocks]) => ({ id, type, status: 'open', text: `Do ${id}`, evidence: '—', how: [], blocks })),
    ...o.over,
  })
  const WAITS = { 'needs-human': 'waits for a human', blocked: 'blocked', failed: 'failed' }
  const KIND = { prerequisite: 0, task: 1, issue: 2, lint: 3, review: 4, 'auto-decision': 5 }
  const plural = (k, w) => `${k} ${w}${k > 1 ? 's' : ''}`
  // What the mod says, as the lines of the answer: its items, sorted by rank, then by kind, those of one kind and one moment counted
  const expectedLines = raw => {
    const inst = VM.normalize(raw)
    const items = VM.yourTurnItems(inst, Date.now()).items.map(it => ({ it, kind: it.group === 'review' ? 'review' : it.group === 'decision' ? 'auto-decision' : it.g.t === '◇' ? 'prerequisite' : it.g.t === '?' ? 'issue' : it.task === 'plan-lint' ? 'lint' : 'task' }))
    items.sort((a, b) => a.it.rank - b.it.rank || KIND[a.kind] - KIND[b.kind])
    const entries = []
    for (const { it, kind } of items) {
      const line = it.moment === 'now' ? 'Now' : it.moment === 'at run stop' ? 'At run stop' : 'Later'
      if (['issue', 'review', 'auto-decision'].includes(kind)) {
        const e = entries.find(x => x.kind === kind && x.moment === it.moment)
        if (e) e.n++; else entries.push({ line, kind, moment: it.moment, n: 1 })
        continue
      }
      const p = raw.prerequisites.find(x => x.id === it.task)
      entries.push({ line, text: kind === 'prerequisite' ? (line === 'Later' ? `${p.id} ${it.moment}` : `${p.id} (${p.type}) blocks ${p.blocks.join(', ')}`) : kind === 'lint' ? `plan-lint: ${plural(inst.lint.errors, 'error')}` : `${it.task} ${WAITS[raw.tasks.find(t => t.id === it.task).status]}` })
    }
    const tickets = inst.closed.filter(c => c.as === 'ticket').length
    if (tickets) entries.push({ line: 'Later', text: `${plural(tickets, 'ticket')} after the PR` })
    const say = e => (e.text ?? `${e.kind === 'issue' ? `${plural(e.n, 'issue')} to settle` : plural(e.n, e.kind)}${e.line === 'Later' ? ` ${e.moment}` : ''}`)
    const cap = xs => (xs.length > 6 ? [...xs.slice(0, 5), `+${xs.length - 5}`] : xs)
    const lines = ['Now', 'At run stop', 'Later'].filter(l => entries.some(e => e.line === l)).map(l => `**${l}**: ${cap(entries.filter(e => e.line === l).map(say)).join(' · ')}`)
    return lines.length ? lines : ['**Your turn**: nothing for now']
  }
  // status.mjs on this progress.json, and the mod's reading of it: the same lines; the same again with the file in /4 (0.20.0);
  // returns them
  const same = (label, raw) => {
    let got = null
    for (const file of [raw, as4(raw)]) {
      writeFileSync(join(E, 'progress.json'), JSON.stringify(file))
      const r = status(['plans/eq'], eq)
      const lines = r.out.split('\n').filter(l => /^\*\*(Now|At run stop|Later|Your turn)\*\*/.test(l))
      assert.deepEqual(lines, expectedLines(file), `${label}, ${file.format}\n${r.out}`)
      if (got) assert.deepEqual(lines, got, `${label}: /3 and /4 alike`)
      got = lines
    }
    return got
  }
  const WAITING = { T02: 'needs-human', T03: 'failed' }
  const OPEN = [issue('T02', 'Missing secret'), issue('T04', 'Other')]

  test('moments, run stopped: now for what waits and for the phase in progress, before phase k for the later ones, after the phases, before the PR', () => {
    const got = same('stopped', doc({ statuses: WAITING, over: { issues: OPEN } }))
    // Nine groups wait for later: the line keeps five and counts the rest, as every line did before (6 at most)
    assert.deepEqual(got, [
      '**Now**: H1 (manual) blocks T02 · D1 (decision) blocks T02 · T02 waits for a human · T03 failed · 1 issue to settle',
      '**Later**: 2 reviews after phase 1 · EV1 before phase 2 · D9 before phase 2 · 1 auto-decision before phase 2 · 1 review after phase 2 · +4',
    ])
  })
  test('moments during a run: an issue and a decision to take wait for the run to stop; a waiting task without an issue stays now (row 17)', () => {
    const live = { runs: [run('in-progress')] }
    let got = same('run, T02 with an issue', doc({ statuses: WAITING, over: { ...live, issues: OPEN } }))
    assert.equal(got[0], '**Now**: H1 (manual) blocks T02 · T03 failed')
    assert.equal(got[1], '**At run stop**: D1 (decision) blocks T02 · T02 waits for a human · 1 issue to settle')
    got = same('run, T02 without an issue', doc({ statuses: WAITING, over: live }))
    assert.equal(got[0], '**Now**: H1 (manual) blocks T02 · T02 waits for a human · T03 failed')
    assert.ok(got[1].startsWith('**At run stop**: D1 (decision) blocks T02'), got[1])
    got = same('blocked task, no issue', doc({ statuses: { T02: 'blocked' }, over: live }))
    assert.ok(got[0].includes('T02 blocked'), got[0])
  })
  test('moments: a decision for a later phase stays "before phase k", run or not; a prerequisite that holds back nothing left waits for the first or the next run', () => {
    for (const runs of [[run('in-progress')], [run('finished')]]) {
      const got = same('later decision', doc({ over: { runs, reviews: [], auto_decisions: [] } }))
      assert.ok(got.at(-1).includes('D9 before phase 2'), got.at(-1))
      assert.ok(got.at(-1).includes('H3 before the next run'), got.at(-1))
    }
    const got = same('no run yet', doc({ over: { runs: [], reviews: [], auto_decisions: [] } }))
    assert.ok(got.at(-1).includes('H3 before the first run') && !got.at(-1).includes('next run'), got.at(-1))
  })
  test('moments: the phase of the run moves with its tasks (a task of phase 2 started: EV1 is now, D9 at run stop); a step, a silent run or a ruling change who waits', () => {
    const live = { runs: [run('in-progress')] }
    let got = same('phase 2 started', doc({ steps: { T03: 'worker' }, over: live }))
    assert.equal(got[0], '**Now**: H1 (manual) blocks T02 · EV1 (manual) blocks T03')
    assert.ok(got[1].startsWith('**At run stop**: D1 (decision) blocks T02 · D9 (decision) blocks T04'), got[1])
    got = same('a task in a step', doc({ statuses: { T03: 'failed' }, steps: { T03: 'worker' }, over: live }))
    assert.ok(!got.join('\n').includes('T03 failed'), got.join('\n'))
    got = same('silent run', doc({ statuses: { T03: 'failed' }, steps: { T03: 'worker' }, over: { ...live, updated: ago(2 * 3600000) } }))
    assert.ok(got[0].includes('T03 failed'), got.join('\n'))
    got = same('ruled task', doc({ statuses: { T03: 'failed' }, over: { runs: [run('in-progress', { rulings_applied: [{ task: 'T03', title: 'x', option: 'A' }] })] } }))
    assert.ok(!got.join('\n').includes('T03 failed'), got.join('\n'))
  })
  test('moments: plan-lint in error (now, at run stop during a run); reviews and auto-decisions moved to tickets close nothing but count', () => {
    writeFileSync(join(E, 'tasks', 'T09-x.md'), task('T09', 3).replace('verification:\n  - "npm test"\n', 'verification: []\n'))
    const bad = { lint: { ok: false, errors: ['T09: verification is empty'] } }
    assert.ok(same('lint, stopped', doc({ over: bad }))[0].includes('plan-lint: 1 error'))
    assert.ok(same('lint, run', doc({ over: { ...bad, runs: [run('in-progress')] } })).some(l => l.startsWith('**At run stop**') && l.includes('plan-lint: 1 error')))
    rmSync(join(E, 'tasks', 'T09-x.md'))
    const ticket = [{ ...REVIEWS[3], ticket: ago(500) }, { ...REVIEWS[1], done: ago(500) }]
    const got = same('tickets', doc({ over: { reviews: [REVIEWS[0], ...ticket], auto_decisions: [{ ...DECISIONS[0], ticket: ago(500) }] } }))
    assert.ok(got.at(-1).endsWith('2 tickets after the PR'), got.at(-1))
  })
  test('moments: two reviews of one task with the same first passage count as one; without a passage, never merged (D5)', () => {
    const got = same('duplicates', doc({ over: { auto_decisions: [], reviews: [review('T01', 'a `x.md` one', 1), review('T01', 'b `x.md` two', 1), review('T01', 'no passage', 1), review('T01', 'no passage 2', 1), review('T02', 'c `x.md` other task', 1), review(null, 'd `x.md` plan', null), review(null, 'e `x.md` plan again', null)] } }))
    assert.ok(got.at(-1).includes('4 reviews after phase 1'), got.at(-1))
    assert.ok(got.at(-1).includes('1 review before the PR'), got.at(-1))
  })
  // ── Git wins, and an unknown progress.json is ignored (T08B) ──
  const lines = out => out.split('\n').filter(l => /^\*\*(Now|At run stop|Later|Your turn)\*\*/.test(l))
  test('a task merged in git while progress.json (/3 or /4) still says needs-human: counted merged, in no moment line', () => {
    for (const base of [doc(), as4(doc())]) {
      const stale = { ...base, tasks: base.tasks.map(t => (t.id === 'T01' ? { ...t, status: 'needs-human' } : t)) }
      assert.equal(stale.tasks.find(t => t.id === 'T01').status, 'needs-human')
      writeFileSync(join(E, 'progress.json'), JSON.stringify(stale))
      const r = status(['plans/eq'], eq)
      assert.equal(r.code, 0)
      assert.ok(r.out.startsWith('## eq — 1/5 tasks · 20%'), `${base.format}\n${r.out}`)
      assert.ok(!lines(r.out).join('\n').includes('T01'), r.out)
      writeFileSync(join(E, 'progress.json'), JSON.stringify(base))
      assert.equal(r.out, status(['plans/eq'], eq).out, 'same text as with the fresh file')
    }
  })
  test('a progress.json in another format (/2, /5), or not JSON: the text of a plan without progress.json, code 0', () => {
    rmSync(join(E, 'progress.json'))
    const without = status(['plans/eq'], eq)
    assert.equal(without.code, 0)
    const other = { ...doc(), format: 'orchestre-progress/2', tasks: doc().tasks.map(t => ({ ...t, status: 'failed' })) }
    // /3 and /4 are read; a format after /4 is not
    for (const raw of [JSON.stringify(other), JSON.stringify({ ...as4(other), format: 'orchestre-progress/5' }), '{ not json']) {
      writeFileSync(join(E, 'progress.json'), raw)
      const r = status(['plans/eq'], eq)
      assert.equal(r.code, 0)
      assert.equal(r.out, without.out)
    }
    rmSync(join(E, 'progress.json'))
  })
  test('/4 with a ruling recorded and not applied yet: the issue leaves Your turn in status.mjs, in the mod and in progress.mjs status alike', () => {
    const progressMjs = join(dirname(STATUS), 'progress.mjs')
    const viaProgress = () => spawnSync('node', [progressMjs, 'status', 'plans/eq'], { cwd: eq, encoding: 'utf8' }).stdout.split('\n').filter(l => /^\*\*(Now|At run stop|Later|Your turn)\*\*/.test(l))
    const play = (label, raw, rulings) => {
      const file = { ...as4(raw), pending_rulings: rulings }
      writeFileSync(join(E, 'progress.json'), JSON.stringify(file))
      const lines = status(['plans/eq'], eq).out.split('\n').filter(l => /^\*\*(Now|At run stop|Later|Your turn)\*\*/.test(l))
      assert.deepEqual(lines, expectedLines(file), `${label}: status.mjs and the mod`)
      assert.deepEqual(lines, viaProgress(), `${label}: status.mjs and progress.mjs status`)
      return lines
    }
    const ruling = (issue, o = {}) => ({ issue, option: null, text: 'Use the staging key', at: ago(1000), ...o })
    for (const live of [false, true]) {
      const over = { issues: OPEN, ...(live ? { runs: [run('in-progress')] } : {}) }
      const open = play('no ruling', doc({ statuses: WAITING, over }), []).join('\n')
      assert.ok(open.includes('2 issues to settle') || /1 issue to settle/.test(open), open)
      // T02-1 ruled, as an option or as a free text: the line changes
      for (const r of [ruling('T02-1'), ruling('T02-1', { option: 'A', text: null })]) {
        const got = play(`T02-1 ruled, live ${live}`, doc({ statuses: WAITING, over }), [r]).join('\n')
        if (live) assert.notEqual(got, open, 'during a run, the ruling moves T02 from at run stop to now')
      }
      // Both ruled: no issue waits at all, a waiting task stays in Your turn as a task
      const none = play(`both ruled, live ${live}`, doc({ statuses: WAITING, over }), [ruling('T02-1'), ruling('T04-2')]).join('\n')
      assert.ok(!/issue/.test(none), none)
      assert.ok(none.includes('T02 waits for a human'), none)
    }
    // A ruling on another issue changes nothing
    const base = doc({ statuses: WAITING, over: { issues: OPEN } })
    assert.deepEqual(play('ruling of an unknown issue', base, [ruling('T09-1')]), play('no ruling', base, []))
    rmSync(join(E, 'progress.json'))
  })
  test('moments: a plan all merged puts its reviews and auto-decisions before the PR; a line without an item is not written; nothing at all says so', () => {
    for (const id of ['T02', 'T03', 'T04', 'T05']) g('commit', '-q', '--allow-empty', '-m', `task ${id}: Task ${id}`)
    writeFileSync(join(E, 'PREREQUISITES.md'), `| ID | Type | Prerequisite | Status | Evidence |\n|----|------|--------------|--------|----------|\n${PRE.map(([id, type]) => `| ${id} | ${type} | Do ${id} | dropped | not needed |`).join('\n')}\n`)
    const merged = { statuses: { T02: 'merged', T03: 'merged', T04: 'merged', T05: 'merged' } }
    assert.deepEqual(same('all merged', doc({ ...merged, over: { prerequisites: [] } })), ['**Later**: 5 reviews before the PR · 2 auto-decisions before the PR'])
    assert.deepEqual(same('one review', doc({ ...merged, over: { prerequisites: [], auto_decisions: [], reviews: [review('T05', 'z `z.md`', 3)] } })), ['**Later**: 1 review before the PR'])
    assert.deepEqual(same('nothing', doc({ ...merged, over: { prerequisites: [], auto_decisions: [], reviews: [] } })), ['**Your turn**: nothing for now'])
  })
  test('the rules of status.mjs and of progress.mjs status are the same text', () => {
    const block = f => { const t = readFileSync(f, 'utf8'); return t.slice(t.indexOf('// ── moments:begin'), t.indexOf('// ── moments:end')) }
    const a = block(STATUS), b = block(join(dirname(STATUS), 'progress.mjs'))
    assert.ok(a.length > 1000, 'the block is found')
    assert.equal(a, b)
  })
  console.log(`status: ALL GREEN (${n} tests)`)
} finally {
  rmSync(root, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); rmSync(eq, { recursive: true, force: true })
}
