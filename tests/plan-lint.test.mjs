// Tests of plan-lint on toy plans, in a temporary git repository.
// Usage: node tests/plan-lint.test.mjs [path of plan-lint.mjs]
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

const LINT = resolve(process.argv[2] || 'plugins/orchestre/scripts/plan-lint.mjs')
const root = mkdtempSync(join(tmpdir(), 'plan-lint-'))
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const lint = (...a) => {
  const r = spawnSync('node', [LINT, ...a], { cwd: root, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr, json: a.includes('--json') && r.stdout ? JSON.parse(r.stdout) : null }
}
// model and reason: null to omit the line; an empty string writes "model:" without a value
const task = (id, { phase = 1, depends_on = '[]', files = [`src/${id}/**`], resources = '[]', verification = ['"npm test"'], done = ['"the test passes"'], prerequisites = null, model = 'sonnet', reason = 'ordinary implementation' } = {}) => `---
id: ${id}
title: Task ${id}
phase: ${phase}
${model != null ? `model: ${model}\n` : ''}${reason != null ? `model_reason: ${reason}\n` : ''}effort: high
depends_on: ${depends_on}
owned_files:
${files.map(f => `  - ${f}`).join('\n')}
resources: ${resources}${prerequisites ? `\nprerequisites: ${prerequisites}` : ''}
token_estimate: 1.0M
verification:
${verification.map(v => `  - ${v}`).join('\n')}
definition_of_done:
${done.map(v => `  - ${v}`).join('\n')}
---

## Launch prompt
You carry out ${id}.
`
const PROGRESS = ids => `| ID | Title | Phase | Batch | Depends on | Model | Status | Attempts | Branch | Tokens est. / actual |
|----|-------|-------|-------|------------|-------|--------|----------|--------|----------------------|
${ids.map(([id, st]) => `| ${id} | Task ${id} | 1 | 1A | — | sonnet | ${st} | 0 | — | 1.0M / — |`).join('\n')}
`
function plan(name, tasks, progress) {
  const d = join(root, 'plans', name)
  mkdirSync(join(d, 'tasks'), { recursive: true })
  for (const [id, txt] of Object.entries(tasks)) writeFileSync(join(d, 'tasks', `${id}-x.md`), txt)
  writeFileSync(join(d, 'PROGRESS.md'), PROGRESS(progress || Object.keys(tasks).map(id => [id, 'todo'])))
  return `plans/${name}`
}
let n = 0
const test = (name, fn) => { fn(); n++; console.log('ok ·', name) }

try {
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  const p = plan('ok', { T01: task('T01'), T02: task('T02', { depends_on: '[T01]' }), T03: task('T03', { phase: 2, depends_on: '[T02]' }), T02B: task('T02B', { resources: '[db]', files: ['src/b/**'] }) })
  git('add', '.'); git('commit', '-qm', 'plan'); git('switch', '-qc', 'plan/ok')

  test('valid plan: full JSON (tasks, all, max_phase, language), readable estimate', () => {
    const r = lint(p, '--json')
    assert.equal(r.code, 0, r.out + r.err); assert.equal(r.json.ok, true)
    assert.deepEqual(Object.keys(r.json), ['ok', 'errors', 'warnings', 'tasks', 'all', 'max_phase', 'prerequisites', 'ready', 'fable', 'language'])
    assert.equal(r.json.max_phase, 2); assert.equal(r.json.all.length, 4); assert.equal(r.json.tasks.length, 4); assert.equal(r.json.language, 'en')
    const t02b = r.json.tasks.find(t => t.id === 'T02B')
    assert.deepEqual(Object.keys(t02b), ['id', 'title', 'file', 'phase', 'model', 'model_reason', 'effort', 'depends_on', 'resources', 'status', 'verification', 'token_estimate', 'open_prerequisites'])
    assert.deepEqual(t02b.resources, ['db']); assert.equal(t02b.status, 'todo'); assert.deepEqual(t02b.verification, ['npm test']); assert.equal(t02b.token_estimate, 1)
    const h = lint(p); assert.equal(h.code, 0); assert.match(h.out, /^✓ valid plan: 4 tasks\. Remaining, in estimated tokens: phase 1 3\.0M · phase 2 1\.0M · total 4\.0M$/m)
  })
  test('--phase: only the tasks of the phase, and phase 2 refused while phase 1 is not done', () => {
    const r = lint(p, '--json', '--phase', '1'); assert.equal(r.json.tasks.length, 3); assert.equal(r.json.all.length, 4)
    const r2 = lint(p, '--json', '--phase', '2'); assert.equal(r2.code, 1)
    assert.ok(r2.json.errors.includes('T01 (phase 1) is neither merged nor cancelled: phase 2 cannot start'), r2.json.errors.join('\n'))
  })
  test('--integration: the commit "task <id>: " on the branch is the source of truth, "tâche <id> : " of 0.11 too; "cancelled" counts as done', () => {
    git('commit', '-q', '--allow-empty', '-m', 'task T01: x'); git('commit', '-q', '--allow-empty', '-m', 'tâche T02 : x')
    writeFileSync(join(root, p, 'PROGRESS.md'), PROGRESS([['T01', 'todo'], ['T02', 'todo'], ['T02B', 'cancelled'], ['T03', 'todo']]))
    const r = lint(p, '--json', '--phase', '2', '--integration', 'plan/ok')
    assert.equal(r.code, 0, JSON.stringify(r.json)); assert.equal(r.json.tasks[0].id, 'T03')
    assert.deepEqual(r.json.all.map(t => [t.id, t.status]), [['T01', 'merged'], ['T02', 'merged'], ['T02B', 'cancelled'], ['T03', 'todo']])
  })
  test('--integration: unknown branch reported, branch that looks like an option refused without writing anything', () => {
    const r = lint(p, '--json', '--integration', 'plan/missing'); assert.equal(r.code, 1)
    assert.ok(r.json.errors.includes('integration branch not found: plan/missing'))
    const x = join(root, 'written.txt'), r2 = lint(p, '--integration', `--output=${x}`)
    assert.equal(r2.code, 2); assert.ok(!existsSync(x), 'git must not write anything'); assert.match(r2.err, /^invalid integration branch: --output=/)
  })
  test('--integration: merges of an earlier plan, already in main, do not count', () => {
    git('switch', '-q', 'main'); git('commit', '-q', '--allow-empty', '-m', 'task T03: earlier plan, already in main'); git('switch', '-qc', 'plan/new')
    const r = lint(p, '--json', '--integration', 'plan/new')
    assert.equal(r.code, 0, JSON.stringify(r.json)); assert.equal(r.json.all.find(t => t.id === 'T03').status, 'todo')
    const r2 = lint(p, '--json', '--integration', 'plan/new', '--base', 'main'); assert.equal(r2.json.all.find(t => t.id === 'T03').status, 'todo')
    const r3 = lint(p, '--json', '--integration', 'plan/new', '--base', 'develop'); assert.equal(r3.code, 1)
    assert.ok(r3.json.errors.includes('base branch not found: develop'))
    git('switch', '-q', 'plan/ok')
  })
  test('inline list: a comma inside quotes does not split the item', () => {
    const txt = task('C01').replace('verification:\n  - "npm test"', `verification: ["pnpm test --reporter=dot,summary", 'echo ''a, b''', npm run lint]`).replace('definition_of_done:\n  - "the test passes"', 'definition_of_done: [one, "two, three"]')
    const q = plan('short', { C01: txt })
    const r = lint(q, '--json'); assert.equal(r.code, 0, JSON.stringify(r.json))
    assert.deepEqual(r.json.tasks[0].verification, ['pnpm test --reporter=dot,summary', "echo 'a, b'", 'npm run lint'])
    assert.equal(lint(q).out.trim().startsWith('✓ valid plan: 1 task.'), true)
  })
  test('prerequisites: waiting tasks (direct and through a dependency), next phase waiting, JSON and text output', () => {
    const q = plan('pre', {
      P01: task('P01', { prerequisites: '[H1]' }),
      P02: task('P02', { prerequisites: '[D5, E1]' }),
      P03: task('P03', { depends_on: '[P02]' }),
      P04: task('P04', { phase: 2, prerequisites: '[H2]' }),
    })
    writeFileSync(join(root, q, 'PREREQUISITES.md'), `# PREREQUISITES — pre

| ID | Type | Prerequisite | Status | Evidence |
|----|------|--------------|--------|----------|
| D5 | decision | Choose the model provider | open | — |
| H1 | manual | API key in \`.env\` | done | confirmed by Fabien |
| E1 | environment | Test database \\| port 5433 | dropped | no longer needed |
| H2 | Manual | Service account | Open | — |
`)
    const r = lint(q, '--json'); assert.equal(r.code, 0, JSON.stringify(r.json && r.json.errors))
    const t = id => r.json.tasks.find(x => x.id === id)
    assert.deepEqual(t('P01').open_prerequisites, []); assert.deepEqual(t('P02').open_prerequisites, ['D5']); assert.deepEqual(t('P04').open_prerequisites, ['H2'])
    const e1 = r.json.prerequisites.find(x => x.id === 'E1')
    assert.deepEqual(e1, { id: 'E1', type: 'environment', text: 'Test database | port 5433', status: 'dropped', evidence: 'no longer needed', blocks: ['P02'] })
    assert.deepEqual(r.json.prerequisites.find(x => x.id === 'D5').blocks, ['P02']); assert.equal(r.json.prerequisites.find(x => x.id === 'H2').type, 'manual')
    assert.deepEqual(r.json.ready[0], { phase: 1, after_phase: null, tasks: 3, waiting: [{ id: 'P02', waiting_on: ['D5'] }, { id: 'P03', waiting_on: ['P02'] }] })
    assert.equal(r.json.ready[1].after_phase, 1); assert.deepEqual(r.json.ready[1].waiting, [{ id: 'P04', waiting_on: ['H2'] }])
    const h = lint(q).out
    assert.ok(h.includes('Open prerequisites: D5 (decision) → P02 · H2 (manual) → P04'), h)
    assert.ok(h.includes('- phase 1: P02 waits for D5; P03 waits for P02'), h)
    assert.ok(h.includes('- phase 2: waits for the end of phase 1; no task can start; P04 waits for H2'), h)
    const r1 = lint(q, '--json', '--phase', '1'); assert.equal(r1.json.ready.length, 1); assert.equal(r1.json.tasks.length, 3)
  })
  test('prerequisites: unknown id, duplicate or taken by a task, unknown type and status, done decision missing from HANDOFF', () => {
    const q = plan('prek', { K01: task('K01', { prerequisites: '[D9, K02]' }), K02: task('K02') })
    writeFileSync(join(root, q, 'PREREQUISITES.md'), `| ID | Type | Prerequisite | Status | Evidence |
|----|------|--------------|--------|----------|
| D1 | decision | a | done | HANDOFF |
| D1 | decision | b | open | — |
| K02 | manual | c | open | — |
| X1 | idea | d | open | — |
| X2 | manual | e | maybe | — |
| D2 | decision | f | done | HANDOFF |
| D3 | decision | g | done | HANDOFF |
| D4 | décision | h | ouvert | — |
`)
    writeFileSync(join(root, q, 'HANDOFF.md'), '# HANDOFF — prek\nEntries: `decision`…\n## source plan\ndecision · major · D2: option A chosen (settled by Fabien)\nneeds-human · major · D3: decision for the PO\n')
    const r = lint(q, '--json'); assert.equal(r.code, 1)
    const e = r.json.errors.join('\n')
    for (const x of ['K01: unknown prerequisite D9', 'prerequisite D1: duplicate id', 'prerequisite K02: id already taken by a task', 'prerequisite X1: unknown type "idea"', 'prerequisite X2: unknown status "maybe"', 'prerequisite D1: decision marked "done" without a "decision" entry citing it in HANDOFF.md', 'prerequisite D3: decision marked "done" without a "decision" entry citing it in HANDOFF.md', 'prerequisite D4: unknown type "décision"', 'prerequisite D4: unknown status "ouvert"'])
      assert.ok(e.includes(x), 'expected: ' + x + '\n' + e)
    assert.ok(!e.includes('prerequisite D2'), 'D2 is written in HANDOFF.md')
  })
  test('prerequisites: without PREREQUISITES.md, a task that cites one is refused; otherwise, a simple reminder', () => {
    const q = plan('without', { S01: task('S01', { prerequisites: '[D1]' }) })
    const r = lint(q, '--json'); assert.equal(r.code, 1); assert.ok(r.json.errors.includes('S01: unknown prerequisite D1 (no PREREQUISITES.md)'))
    const q2 = plan('without2', { S02: task('S02') })
    const h = lint(q2); assert.equal(h.code, 0); assert.match(h.out, /no PREREQUISITES\.md/); assert.ok(!h.out.includes('Ready to run'))
  })
  test('prerequisites: table not recognized, row ignored, last cell without "|", orphan open decision, orphan manual, needs-human task', () => {
    const q = plan('orph', { O01: task('O01', { prerequisites: '[E2]' }), O02: task('O02') }, [['O01', 'todo'], ['O02', 'needs-human']])
    writeFileSync(join(root, q, 'PREREQUISITES.md'), '| Identifier | What | State |\n|---|---|---|\n| D1 | decision | open |\n')
    let r = lint(q, '--json'); assert.equal(r.code, 1)
    assert.ok(r.json.errors.includes('PREREQUISITES.md: no table recognized (headers ID, Type, Prerequisite, Status, Evidence)'), JSON.stringify(r.json.errors))
    writeFileSync(join(root, q, 'PREREQUISITES.md'), '| ID | Type | Prerequisite | Status | Evidence |\n|:--|---|---|---|---|\n| d6 | decision | x | open | — |\n| D7 | decision | y | open | — |\n| H3 | manual | z | open | — |\n| E2 | environment | test database | done | `docker ps` without a closing bar\n')
    r = lint(q, '--json'); const e = r.json.errors.join('\n')
    assert.ok(e.includes('PREREQUISITES.md: row ignored, invalid id "d6"'), e)
    assert.ok(e.includes('prerequisite D7: open decision that no remaining task cites'), e)
    assert.ok(!e.includes('H3'), 'an orphan manual prerequisite is a warning, not an error')
    assert.equal(r.json.prerequisites.find(x => x.id === 'E2').evidence, '`docker ps` without a closing bar')
    assert.deepEqual(r.json.ready[0].waiting, [{ id: 'O02', waiting_on: ['needs-human'] }])
    writeFileSync(join(root, q, 'PREREQUISITES.md'), '| ID | Type | Prerequisite | Status | Evidence |\n|---|---|---|---|---|\n| H3 | manual | z | open | — |\n| E2 | environment | test database | done | ok |\n')
    const h = lint(q); assert.equal(h.code, 0, h.out)
    assert.ok(h.out.includes('⚠ prerequisite H3 (manual) open, but no remaining task cites it'), h.out)
    assert.ok(h.out.includes('- phase 1: O02 waits for needs-human'), h.out)
  })
  test('errors: verification, done, unknown or later dependency, cycle, duplicate, shared files in parallel', () => {
    const q = plan('ko', {
      A01: task('A01', { verification: [], done: [] }).replace('verification:\n\n', 'verification: []\n').replace('definition_of_done:\n\n', 'definition_of_done: []\n'),
      A02: task('A02', { depends_on: '[A09]' }),
      A03: task('A03', { depends_on: '[A04]' }), A04: task('A04', { depends_on: '[A03]', phase: 1 }),
      A05: task('A05', { depends_on: '[A06]' }), A06: task('A06', { phase: 2 }),
      A07: task('A07', { files: ['src/common/**'] }), A08: task('A08', { files: ['src/common/x.ts'] }),
    })
    writeFileSync(join(root, q, 'tasks', 'A07-double.md'), task('A07', { files: ['src/other/**'] }))
    const r = lint(q, '--json'); assert.equal(r.code, 1)
    const e = r.json.errors.join('\n')
    for (const x of ['A01: no verification command', 'A01: no definition of done', 'A02: unknown dependency A09', 'A03: dependency cycle', 'A05: depends on A06, from a later phase', 'A07: duplicate id', 'A07 and A08 can run together and share files'])
      assert.ok(e.includes(x), 'expected: ' + x + '\n' + e)
  })
  test('shared resource: no file error, the tasks will be serialized', () => {
    const q = plan('res', { R01: task('R01', { files: ['src/c/**'], resources: '[db]' }), R02: task('R02', { files: ['src/c/y.ts'], resources: '[db]' }) })
    assert.equal(lint(q, '--json').code, 0)
  })
  test('folder without tasks/: clear stop; plan in the French format of 0.11: stop that names migrate.mjs', () => {
    mkdirSync(join(root, 'plans', 'empty'), { recursive: true })
    let r = lint('plans/empty'); assert.equal(r.code, 2); assert.match(r.err, /^task folder not found: plans\/empty\/tasks/)
    mkdirSync(join(root, 'plans', 'fr', 'taches'), { recursive: true })
    r = lint('plans/fr', '--json'); assert.equal(r.code, 2); assert.equal(r.out, '')
    assert.match(r.err, /^plan in the French format of orchestre 0\.11 and earlier \(taches\/\): migrate it first with node ".*\/scripts\/migrate\.mjs" plans\/fr\n$/)
  })
  test('French keys of 0.11 in a task or in orchestre.config.json: errors that name the English key', () => {
    const q = plan('frkeys', { F01: task('F01').replace('depends_on: []', 'depend_de: [F02]').replace('title: Task F01', 'titre: Tâche F01'), F02: task('F02') })
    writeFileSync(join(root, q, 'orchestre.config.json'), JSON.stringify({ branche_integration: 'plan/frkeys', escalation: ['sonnet', 'opus'], preparation: ['pnpm install'] }))
    const r = lint(q, '--json'); assert.equal(r.code, 1)
    assert.deepEqual(r.json.errors, [
      'F01: French key "titre" of orchestre 0.11 and earlier: rename it "title"', 'F01: French key "depend_de" of orchestre 0.11 and earlier: rename it "depends_on"',
      'orchestre.config.json: French key "branche_integration" of orchestre 0.11 and earlier: rename it "integration_branch"', 'orchestre.config.json: French key "preparation" of orchestre 0.11 and earlier: rename it "setup"',
    ])
  })
  test('warnings: compound verifications of remaining tasks, compound setup or without a declared resource; nothing is blocked', () => {
    const V = ['"cd api && pnpm test"', '"git diff --quiet plan/x...HEAD -- src; echo $?"', '"PATH=/opt/n/bin:$PATH pnpm typecheck"', "\"pnpm exec tsx -e 'import(1)'\"", "\"grep -E 'a|b;c' src/x.ts\"", '"pnpm test -- --reporter=dot 2>&1"', '"git diff --quiet plan/x...HEAD -- src"']
    const d = plan('warn', { T01: task('T01', { verification: V, resources: '[test-db]' }), T02: task('T02', { verification: ['"cd x && make"'], files: ['lib/**'] }) }, [['T01', 'todo'], ['T02', 'cancelled']])
    writeFileSync(join(root, d, 'orchestre.config.json'), JSON.stringify({ setup: ['pnpm install --frozen-lockfile', 'pnpm prisma generate && pnpm build'], shared_setup: { 'test-db': ['pnpm db:test:prepare'], 'port-3000': ['pnpm e2e:prepare'] } }))
    const r = lint(d, '--json')
    assert.equal(r.code, 0, r.out); assert.equal(r.json.ok, true)
    const a = r.json.warnings
    assert.deepEqual(a.filter(x => x.startsWith('T01:')).map(x => x.match(/`(.*)` \((.*?)\):/).slice(1)), [
      ['cd api && pnpm test', 'chaining or subcommand, cd, export or assignment first'],
      ['git diff --quiet plan/x...HEAD -- src; echo $?', 'chaining or subcommand'],
      ['PATH=/opt/n/bin:$PATH pnpm typecheck', 'cd, export or assignment first'],
      ["pnpm exec tsx -e 'import(1)'", 'code evaluated inline'],
    ], 'quotes, redirection and simple command are not reported')
    assert.ok(!a.some(x => x.startsWith('T02')), 'cancelled task: no warning')
    assert.ok(a.includes("setup: `pnpm prisma generate && pnpm build` (chaining or subcommand): an agent isolated in a worktree will be refused it (Claude Code's isolation guard): make it a simple command, or a project script"))
    assert.ok(a.includes('shared_setup: no task declares the resource "port-3000"; its commands will never run'))
    assert.equal(a.length, 6)
    const t = lint(d)
    assert.equal(t.code, 0); assert.match(t.out, /^✓ valid plan/); assert.match(t.out, /\n⚠ T01: verification `cd api && pnpm test`/)
    writeFileSync(join(root, d, 'orchestre.config.json'), JSON.stringify({ setup: 'pnpm install', shared_setup: { db: 'x' } }))
    const e = lint(d, '--json')
    assert.equal(e.code, 1)
    assert.deepEqual(e.json.errors, ['orchestre.config.json: "setup" must be a list of commands', 'orchestre.config.json: "shared_setup" must map each resource to a list of commands'])
  })

  test('warnings: neither false positives (grep -e, sed -e, find -exec \\;, quotes) nor false negatives (substitution inside double quotes, php -r, node -p, absolute path)', () => {
    const no = ['grep -e "TODO" src', "sed -e 's/a/b/' x.txt", 'find src -name "*.tmp" -exec rm {} \\;', "grep -E 'a|b;c' src", 'sh scripts/check.sh', 'pnpm test -- --reporter=dot 2>&1', "echo 'a `b` $(c)'"]
    const yes = [['grep "$(cat x)" src', 'chaining or subcommand'], ['echo "`date`"', 'chaining or subcommand'], ['php -r "echo 1;"', 'code evaluated inline'], ['node -p "1+1"', 'code evaluated inline'], ['/usr/bin/python3 -c "print(1)"', 'code evaluated inline'], ['node --no-warnings -e "x"', 'code evaluated inline'], ['deno eval "1"', 'code evaluated inline'], ['node /home/u/x.mjs', 'script by absolute path']]
    const d = plan('warn2', { T01: task('T01', { verification: [...no, ...yes.map(([c]) => c)].map(c => JSON.stringify(c)) }) })
    const a = lint(d, '--json').json.warnings
    assert.deepEqual(a.map(x => x.match(/^T01: verification `(.*)` \((.*?)\):/).slice(1)), yes)
  })

  test('JSON over 64 KB read through a pipe: full output, exit code kept (0.8.1)', () => {
    // process.exit() right after console.log cut the output at 65,536 bytes in a pipe (MonitIA, 08/10)
    const ts = {}
    for (let i = 1; i <= 220; i++) { const id = `T${String(i).padStart(3, '0')}`; ts[id] = task(id, { phase: Math.ceil(i / 20), verification: [`"pnpm test -- src/${id} --reporter=verbose"`, `"sh scripts/e2e-local.sh ${id}"`] }) }
    const d = plan('big', ts)
    const pipe = spawnSync('sh', ['-c', `node "${LINT}" "${d}" --json | cat`], { cwd: root, encoding: 'utf8' })
    assert.ok(Buffer.byteLength(pipe.stdout) > 65536, `output too small for the case: ${Buffer.byteLength(pipe.stdout)} bytes`)
    assert.equal(JSON.parse(pipe.stdout).tasks.length, 220)
    const direct = spawnSync('node', [LINT, d, '--json'], { cwd: root, encoding: 'utf8' })
    assert.equal(direct.stdout, pipe.stdout); assert.equal(direct.status, 0)
    const ko = plan('big-ko', { ...ts, T999: task('T999', { depends_on: '[T000]' }) })
    const r = spawnSync('sh', ['-c', `node "${LINT}" "${ko}" --json | cat; exit 0`], { cwd: root, encoding: 'utf8' })
    assert.equal(JSON.parse(r.stdout).ok, false)
    assert.equal(spawnSync('node', [LINT, ko, '--json'], { cwd: root, encoding: 'utf8' }).status, 1)
  })

  test('PROGRESS.md: a row of another table under the legend is not a task; --phase only returns the warnings of the phase (0.8.1)', () => {
    const d = plan('notes', { T01: task('T01'), T02: task('T02', { phase: 2, verification: ['"cd web && npm test"'] }), T03: task('T03', { phase: 1, verification: ['"cd api && npm test"'] }) }, [['T01', 'merged'], ['T02', 'todo'], ['T03', 'todo']])
    writeFileSync(join(root, d, 'PROGRESS.md'), PROGRESS([['T01', 'merged'], ['T02', 'todo'], ['T03', 'todo']]) + '\nStatuses: todo · merged\n\n## Pilot notes\n\n| ID | Note |\n|----|------|\n| T01 | rerun by hand on 07/10 |\n| D1 | settled: option B |\n')
    const r = lint(d, '--json')
    assert.equal(r.json.tasks.find(t => t.id === 'T01').status, 'merged')
    assert.equal(r.json.warnings.length, 2)
    const p2 = spawnSync('node', [LINT, d, '--json', '--phase', '2'], { cwd: root, encoding: 'utf8' })
    assert.deepEqual(JSON.parse(p2.stdout).warnings.map(a => a.slice(0, 3)), ['T02'])
  })

  test('model: valid, unknown or unreadable value; model or reason missing as a warning, never for a done task; the choice is not judged', () => {
    const d = plan('models', {
      T01: task('T01', { model: 'haiku', reason: 'mechanical renaming' }), T02: task('T02', { model: 'opus', reason: 'architecture' }), T03: task('T03', { model: 'fable', reason: 'existing plan' }),
      T04: task('T04', { model: null, reason: null }), T05: task('T05', { model: 'sonnet', reason: null }), T06: task('T06', { model: '', reason: '' }),
      T07: task('T07', { model: null, reason: null }), T08: task('T08', { model: 'haiku', reason: 'architecture of the whole system' }), T12: task('T12', { model: '""', reason: null }),
    }, [['T01', 'todo'], ['T02', 'todo'], ['T03', 'todo'], ['T04', 'todo'], ['T05', 'todo'], ['T06', 'todo'], ['T07', 'merged'], ['T08', 'todo'], ['T12', 'todo']])
    let r = lint(d, '--json')
    assert.equal(r.code, 0, r.out); assert.equal(r.json.ok, true, 'absent or without reason: nothing is blocked')
    const t = id => r.json.tasks.find(x => x.id === id)
    assert.deepEqual(['T01', 'T02', 'T03', 'T05', 'T08'].map(id => t(id).model), ['haiku', 'opus', 'fable', 'sonnet', 'haiku'])
    assert.ok(!('model' in t('T04')) && !('model' in t('T06')) && !('model' in t('T12')), 'absent or empty ("model:", "model: \\"\\""): no model field')
    assert.deepEqual([t('T01').model_reason, 'model_reason' in t('T05')], ['mechanical renaming', false])
    const a = r.json.warnings.filter(x => /: (no model|model \S+ without model_reason)/.test(x))
    assert.deepEqual(a.map(x => x.slice(0, 3)), ['T04', 'T05', 'T06', 'T12'], 'T07 merged: no warning; T08: choice never judged')
    assert.match(a[0], /^T04: no model \(haiku, sonnet, opus\): the worker will run on sonnet/)
    assert.match(a[1], /^T05: model sonnet without model_reason/)
    const text = lint(d)
    assert.equal(text.code, 0); assert.ok(text.out.includes('✓ valid plan') && text.out.includes('⚠ T04: no model'), 'as text: valid plan and warning')
    // With --phase, only the tasks of the phase
    assert.deepEqual(JSON.parse(spawnSync('node', [LINT, d, '--json', '--phase', '2'], { cwd: root, encoding: 'utf8' }).stdout).warnings, [])
    // Unknown value or list: error that names the task
    writeFileSync(join(root, d, 'tasks', 'T09-x.md'), task('T09', { model: 'gpt-5', reason: 'x' }))
    writeFileSync(join(root, d, 'tasks', 'T10-x.md'), task('T10', { model: '\n  - sonnet', reason: 'x' }))
    writeFileSync(join(root, d, 'tasks', 'T11-x.md'), task('T11', { model: 'Sonnet', reason: null }))
    r = lint(d, '--json')
    assert.equal(r.code, 1); assert.equal(r.json.ok, false)
    assert.deepEqual(r.json.errors.filter(e => /model/.test(e)), ['T09: unknown model "gpt-5" (haiku, sonnet, opus, fable)', 'T10: unreadable model (a single name: haiku, sonnet, opus, fable)', 'T11: unknown model "Sonnet" (haiku, sonnet, opus, fable)'])
    assert.ok(!r.json.warnings.some(x => /^T(09|10|11): /.test(x)), 'a rejected model is not, on top, a model without a reason')
  })

  test('fable: allowed by orchestre.config.json (fable: true); refused by fable: false; without the setting, a warning', () => {
    const d = plan('fable', {
      T01: task('T01', { model: 'fable', reason: 'at the user\'s request' }), T02: task('T02', { model: 'fable', reason: 'x' }),
      T03: task('T03', { model: 'opus', reason: 'architecture' }), T04: task('T04', { phase: 2, depends_on: '[T03]', model: 'fable', reason: 'x' }),
    }, [['T01', 'todo'], ['T02', 'merged'], ['T03', 'todo'], ['T04', 'todo']])
    const config = c => (c == null ? rmSync(join(root, d, 'orchestre.config.json'), { force: true }) : writeFileSync(join(root, d, 'orchestre.config.json'), JSON.stringify(c)))
    const fab = x => x.filter(e => /fable/.test(e))
    // Without the setting: warnings for the remaining tasks (T02 merged has none), nothing blocks
    config(null)
    let r = lint(d, '--json')
    assert.equal(r.code, 0, r.out); assert.equal(r.json.fable, null)
    assert.deepEqual(fab(r.json.warnings).map(x => x.slice(0, 3)), ['T01', 'T04'])
    assert.match(fab(r.json.warnings)[0], /^T01: model fable, without a "fable" setting in orchestre\.config\.json: to settle with the user \(\/orchestre:ready\)$/)
    assert.deepEqual(fab(JSON.parse(spawnSync('node', [LINT, d, '--json', '--phase', '1'], { cwd: root, encoding: 'utf8' }).stdout).warnings).map(x => x.slice(0, 3)), ['T01'], '--phase: the phase only')
    // fable: true: nothing
    config({ fable: true, escalation: ['sonnet', 'fable'] })
    r = lint(d, '--json')
    assert.equal(r.code, 0); assert.equal(r.json.fable, true); assert.deepEqual([fab(r.json.errors), fab(r.json.warnings)], [[], []])
    // fable: false: error for each remaining task on fable, all phases, and for the escalation
    config({ fable: false, escalation: ['sonnet', 'fable'] })
    r = lint(d, '--json')
    assert.equal(r.code, 1); assert.equal(r.json.fable, false)
    assert.deepEqual(fab(r.json.errors), ['T01: model fable, refused by orchestre.config.json (fable: false): move the task to opus, or set fable: true if the user wants it', 'T04: model fable, refused by orchestre.config.json (fable: false): move the task to opus, or set fable: true if the user wants it', 'orchestre.config.json: "escalation" contains fable, refused by fable: false'])
    assert.equal(fab(JSON.parse(spawnSync('node', [LINT, d, '--json', '--phase', '1'], { cwd: root, encoding: 'utf8' }).stdout).errors).length, 3, 'with --phase too: the setting applies to the whole plan')
    assert.ok(lint(d).out.includes('✗ T01: model fable, refused'), 'as text')
    // Without a task on fable, fable: false says nothing; an escalation on fable without the setting warns
    writeFileSync(join(root, d, 'tasks', 'T01-x.md'), task('T01', { model: 'opus', reason: 'x' })); writeFileSync(join(root, d, 'tasks', 'T04-x.md'), task('T04', { phase: 2, depends_on: '[T03]', model: 'opus', reason: 'x' }))
    config({ fable: false })
    r = lint(d, '--json')
    assert.equal(r.code, 0); assert.deepEqual([fab(r.json.errors), fab(r.json.warnings)], [[], []])
    config({ escalation: ['fable'] })
    assert.deepEqual(fab(lint(d, '--json').json.warnings), ['orchestre.config.json: "escalation" contains fable, without a "fable" setting: to settle with the user (/orchestre:ready)'])
    // A value that is not a boolean: error
    config({ fable: 'no' })
    r = lint(d, '--json')
    assert.equal(r.code, 1); assert.deepEqual(fab(r.json.errors), ['orchestre.config.json: "fable" must be true or false']); assert.equal(r.json.fable, null)
  })

  test('language: "en" by default, the value of orchestre.config.json otherwise; an empty or non-text value is an error', () => {
    const d = plan('lang', { T01: task('T01') })
    assert.equal(lint(d, '--json').json.language, 'en')
    writeFileSync(join(root, d, 'orchestre.config.json'), JSON.stringify({ language: ' fr ' }))
    let r = lint(d, '--json'); assert.equal(r.code, 0); assert.equal(r.json.language, 'fr')
    for (const bad of ['', 3, null]) {
      writeFileSync(join(root, d, 'orchestre.config.json'), JSON.stringify({ language: bad }))
      r = lint(d, '--json'); assert.equal(r.code, 1, JSON.stringify(bad)); assert.deepEqual(r.json.errors, ['orchestre.config.json: "language" must be a non-empty text, like "en" or "fr"']); assert.equal(r.json.language, 'en')
    }
  })

  test('token estimate: "1.0M", "0.5 M" and "1,2 M" of 0.11 read alike', () => {
    const d = plan('tok', { T01: task('T01'), T02: task('T02').replace('token_estimate: 1.0M', 'token_estimate: 0.5 M'), T03: task('T03').replace('token_estimate: 1.0M', 'token_estimate: "1,2 M"') })
    assert.deepEqual(lint(d, '--json').json.tasks.map(t => t.token_estimate), [1, 0.5, 1.2])
    assert.match(lint(d).out, /phase 1 2\.7M · total 2\.7M/)
  })

  test('merges read on the first parent only: a worker commit "task T03: …" inside the branch of T04 does not merge T03', () => {
    const d = plan('firstparent', { T03: task('T03'), T04: task('T04') })
    git('add', '.'); git('commit', '-qm', 'plan firstparent'); git('switch', '-qc', 'plan/firstparent')
    git('switch', '-qc', 'task/T04'); git('commit', '-q', '--allow-empty', '-m', 'task T03: share a helper'); git('switch', '-q', 'plan/firstparent')
    git('merge', '-q', '--no-ff', 'task/T04', '-m', 'task T04: Task T04')
    const r = lint(d, '--json', '--integration', 'plan/firstparent')
    assert.deepEqual(r.json.all.map(t => [t.id, t.status]), [['T03', 'todo'], ['T04', 'merged']])
    git('switch', '-q', 'plan/ok')
  })

  test('files of the French format next to tasks/, and French values in orchestre.config.json: errors (default_mode) or warning (evaluator)', () => {
    const d = plan('leftover', { T01: task('T01') })
    for (const f of ['SUIVI.md', 'PREREQUIS.md', 'suivi.json']) writeFileSync(join(root, d, f), 'x')
    writeFileSync(join(root, d, 'orchestre.config.json'), JSON.stringify({ default_mode: 'devia', evaluator: 'systematique' }))
    const r = lint(d, '--json')
    assert.equal(r.code, 1)
    assert.deepEqual(r.json.errors.map(e => e.replace(/node ".*?"/, 'node "…"')), [
      'SUIVI.md: file of the French format of orchestre 0.11 next to tasks/: run node "…" plans/leftover, which converts what is left',
      'PREREQUIS.md: file of the French format of orchestre 0.11 next to tasks/: run node "…" plans/leftover, which converts what is left',
      'suivi.json: file of the French format of orchestre 0.11 next to tasks/: run node "…" plans/leftover, which converts what is left',
      'orchestre.config.json: "default_mode" must be auto, deviation or phase, not "devia"',
    ])
    assert.ok(r.json.warnings.includes('orchestre.config.json: "evaluator" is indicative and only takes "always" (the evaluation is always systematic), not "systematique"'))
    for (const f of ['SUIVI.md', 'PREREQUIS.md', 'suivi.json']) rmSync(join(root, d, f))
    writeFileSync(join(root, d, 'orchestre.config.json'), JSON.stringify({ default_mode: 'deviation', evaluator: 'always' }))
    const ok = lint(d, '--json'); assert.equal(ok.code, 0); assert.deepEqual(ok.json.warnings, [])
  })

  console.log(`plan-lint: ALL GREEN (${n} tests)`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
