// Tests of worktrees.mjs (cleaning the worktrees of earlier attempts), in temporary git repositories.
// Usage: node tests/worktrees.test.mjs [path of worktrees.mjs]
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

const SCRIPT = resolve(process.argv[2] || 'plugins/orchestre/scripts/worktrees.mjs')
const temporaries = []
let n = 0
const test = (name, fn) => { fn(); n++; console.log('ok ·', name) }

// A repository whose path contains spaces, with a plan of four tasks and worktrees of earlier attempts
function repo() {
  const base = mkdtempSync(join(tmpdir(), 'worktrees-')); temporaries.push(base)
  const root = join(base, 'my repo'), wt = n => join(base, 'work trees', n)
  mkdirSync(root, { recursive: true })
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n'); writeFileSync(join(root, 'a.txt'), 'a\n')
  mkdirSync(join(root, 'plans', 'p', 'tasks'), { recursive: true })
  for (const id of ['T01', 'T02', 'T03', 'T04']) writeFileSync(join(root, 'plans', 'p', 'tasks', `${id}-x.md`), `---\nid: ${id}\nphase: 1\n---\n`)
  git('add', '.'); git('commit', '-qm', 'plan'); git('switch', '-qc', 'plan/p')
  const add = (name, branch) => { git('worktree', 'add', '-q', '-b', branch, wt(name), 'plan/p'); return wt(name) }
  return { root, git, wt, add, launch: (args, cwd = root) => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' }); return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() } } }
}
const branches = D => D.git('branch', '--format=%(refname:short)').trim().split('\n').sort()
const worktrees = D => D.git('worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('branch ')).map(l => l.slice(18)).sort()

try {
  test('clean worktrees of the tasks removed, branches kept; modified ones, other branches and other plans kept; tache/ of 0.11 too', () => {
    const D = repo()
    const w1 = D.add('w1', 'task/T01')
    mkdirSync(join(w1, 'node_modules')); writeFileSync(join(w1, 'node_modules', 'x'), 'ignored\n')
    D.git('worktree', 'lock', w1, '--reason', 'agent')
    D.add('w2', 'tache/T02-r2')
    writeFileSync(join(D.add('w3', 'task/T03'), 'a.txt'), 'modified\n')
    writeFileSync(join(D.add('w4', 'task/T04'), 'new.txt'), 'untracked\n')
    D.add('w5', 'feature/other'); D.add('w6', 'task/T99'); D.add('w7', 'task/T01-old')
    const before = branches(D)
    const r = D.launch(['clean', 'plans/p'])
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(worktrees(D), ['feature/other', 'plan/p', 'task/T01-old', 'task/T03', 'task/T04', 'task/T99'])
    assert.deepEqual(branches(D), before, 'no branch deleted')
    assert.ok(!existsSync(w1) && existsSync(D.wt('w3')))
    assert.match(r.out, /^removed task\/T01 \(.*w1\), branch kept, lock "agent" lifted$/m)
    assert.match(r.out, /^removed tache\/T02-r2 \(.*w2\), branch kept$/m)
    assert.match(r.out, /^kept    task\/T03 \(.*w3\): 1 file modified or untracked, to commit or discard by hand$/m)
    assert.match(r.out, /^kept    task\/T04 /m)
    assert.equal(r.out.split('\n').pop(), 'worktrees plans/p: 2 removed, 2 kept')
    // The freed branch can be taken again
    D.git('switch', '-q', 'task/T01'); D.git('switch', '-q', 'plan/p')
  })

  test('--dry-run: nothing moves; vanished folder forgotten; call from a worktree, without a plan folder', () => {
    const D = repo()
    const w1 = D.add('w1', 'task/T01'), w2 = D.add('w2', 'task/T02')
    let r = D.launch(['clean', '--dry-run'])
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(worktrees(D), ['plan/p', 'task/T01', 'task/T02'])
    assert.equal(r.out.split('\n').pop(), 'worktrees plans/p: 2 to remove, 0 kept')
    rmSync(w2, { recursive: true, force: true })
    r = D.launch(['clean'], w1)
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /^kept    task\/T01 \(.*w1\): this is the folder the clean is launched from$/m)
    assert.equal(r.out.split('\n').pop(), 'worktrees plans/p: 0 removed, 1 kept, 1 stale forgotten')
    assert.deepEqual(worktrees(D), ['plan/p', 'task/T01'])
  })

  test('run "in-progress" in progress.json: refusal (code 1), except --dry-run or --run-stopped; a progress.json of 0.11 not yet converted too', () => {
    const D = repo()
    D.add('w1', 'task/T01')
    const progress = join(D.root, 'plans', 'p', 'progress.json')
    writeFileSync(progress, JSON.stringify({ format: 'orchestre-progress/3', runs: [{ number: 1, status: 'finished' }, { number: 2, status: 'in-progress', start: '2026-10-08T10:00:00+02:00' }] }))
    let r = D.launch(['clean', 'plans/p'])
    assert.equal(r.code, 1); assert.equal(r.err, 'worktrees: progress.json marks run 2 "in-progress" since 2026-10-08T10:00:00+02:00: nothing is removed, its agents may be working in these worktrees. If it is stopped, run again with --run-stopped.')
    assert.deepEqual(worktrees(D), ['plan/p', 'task/T01'])
    writeFileSync(progress, JSON.stringify({ format: 'orchestre-suivi/2', runs: [{ numero: 3, statut: 'en-cours', debut: '2026-10-09T10:00:00+02:00' }] }))
    r = D.launch(['clean', 'plans/p'])
    assert.equal(r.code, 1); assert.match(r.err, /run 3 "in-progress" since 2026-10-09T10:00:00\+02:00/)
    r = D.launch(['clean', 'plans/p', '--dry-run'])
    assert.equal(r.code, 0); assert.equal(r.out.split('\n').pop(), 'worktrees plans/p: 1 to remove, 0 kept')
    r = D.launch(['clean', 'plans/p', '--run-stopped'])
    assert.equal(r.code, 0, r.err); assert.deepEqual(worktrees(D), ['plan/p'])
  })

  test('invalid calls: code 2, nothing moves; French plan of 0.11 named with migrate.mjs', () => {
    const D = repo()
    D.add('w1', 'task/T01')
    for (const [args, pattern] of [[[], /usage/], [['clean', 'plans/unknown'], /plan not found/], [['nettoyer'], /usage/], [['erase'], /usage/]]) {
      const r = D.launch(args)
      assert.equal(r.code, 2, JSON.stringify(r)); assert.match(r.err, pattern)
    }
    const outside = mkdtempSync(join(tmpdir(), 'outside-')); temporaries.push(outside)
    assert.match(D.launch(['clean'], outside).err, /not in a git repository/)
    mkdirSync(join(D.root, 'plans', 'fr', 'taches'), { recursive: true })
    const fr = D.launch(['clean', 'plans/fr'])
    assert.equal(fr.code, 2); assert.match(fr.err, /^worktrees: plan in the French format of orchestre 0\.11 and earlier \(taches\/\): migrate it with node ".*\/migrate\.mjs" plans\/fr$/)
    assert.deepEqual(worktrees(D), ['plan/p', 'task/T01'])
  })
  console.log(`worktrees: ALL GREEN (${n} tests)`)
} finally { for (const d of temporaries) rmSync(d, { recursive: true, force: true }) }
