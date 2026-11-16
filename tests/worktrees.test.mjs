// Tests of worktrees.mjs (cleaning the worktrees of earlier attempts, disk space for the worktrees), in temporary git repositories.
// Usage: node tests/worktrees.test.mjs [path of worktrees.mjs]
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync, statfsSync, symlinkSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const SCRIPT = resolve(process.argv[2] || 'plugins/orchestre/scripts/worktrees.mjs')
const { space } = await import(pathToFileURL(SCRIPT).href)
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
    rmSync(progress)
    writeFileSync(join(D.root, 'plans', 'p', 'suivi.json'), JSON.stringify({ format: 'orchestre-suivi/2', runs: [{ numero: 5, statut: 'en-cours', debut: '2026-10-10T10:00:00+02:00' }] }))
    r = D.launch(['clean', 'plans/p'])
    assert.equal(r.code, 1, 'a suivi.json of 0.11 left next to tasks/ is read too'); assert.match(r.err, /run 5 "in-progress"/)
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

  test('space: one line, ⚠ only when space is lacking (size injected), code 0 in both cases', () => {
    const D = repo()
    let r = D.launch(['space', 'plans/p', '--parallelism', '2', '--size-bytes', '1000'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /^space: [0-9.]+ GB free, 0\.0 GB needed \(0\.0 GB x 2 in parallel\)$/)
    assert.ok(!r.out.includes('⚠'))
    r = D.launch(['space', 'plans/p', '--parallelism', '2', '--size-bytes', '1000000000000000000'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /^space: ⚠ [0-9.]+ GB free, 2000000000\.0 GB needed \(1000000000\.0 GB x 2 in parallel\): the worktrees may not fit$/)
    assert.equal(r.out.split('\n').length, 1)
  })

  test('space: the size is multiplied by the parallelism (one copy fits, four do not)', () => {
    const D = repo()
    const fs = statfsSync(D.root), free = Number(fs.bavail) * Number(fs.bsize)
    const size = String(Math.floor(free / 2))
    assert.ok(!D.launch(['space', 'plans/p', '--parallelism', '1', '--size-bytes', size]).out.includes('⚠'))
    assert.ok(D.launch(['space', 'plans/p', '--parallelism', '4', '--size-bytes', size]).out.includes('⚠'))
    assert.ok(D.launch(['space', 'plans/p', '--size-bytes', size]).out.includes('x 4 in parallel'), 'default parallelism 4')
  })

  test('space: measured size counts ignored files, never .git', () => {
    const D = repo()
    const here = process.cwd()
    process.chdir(D.root)
    try {
      const base = space('plans/p', { parallelism: 1 }).need
      assert.ok(base > 0)
      writeFileSync(join(D.root, '.git', 'big'), 'x'.repeat(7000))
      assert.equal(space('plans/p', { parallelism: 1 }).need, base, '.git excluded')
      mkdirSync(join(D.root, 'node_modules')); writeFileSync(join(D.root, 'node_modules', 'x'), 'x'.repeat(5000))
      assert.equal(space('plans/p', { parallelism: 1 }).need, base + 5000, 'ignored files included')
      assert.equal(space('plans/p', { parallelism: 3 }).need, 3 * (base + 5000))
    } finally { process.chdir(here) }
  })

  test('space: measure fails (unreadable folder): one line "not measured", code 0; invalid options: code 2', () => {
    const D = repo()
    const locked = join(D.root, 'locked'); mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      if (process.getuid && process.getuid() !== 0) {
        const r = D.launch(['space', 'plans/p'])
        assert.equal(r.code, 0, r.err)
        assert.match(r.out, /^space: not measured \(EACCES.*\)$/)
        assert.ok(!r.out.includes('⚠'))
      }
    } finally { chmodSync(locked, 0o755) }
    for (const args of [['space', 'plans/p', '--parallelism', '0'], ['space', 'plans/p', '--parallelism', 'x'], ['space', 'plans/p', '--size-bytes', '-1'], ['space', 'plans/unknown']]) assert.equal(D.launch(args).code, 2, args.join(' '))
  })

  // node:fs patched before the script loads it: statfsSync missing (Node 18.0 to 18.14) or giving no usable figure
  const patched = (D, patch, args) => {
    const code = `const fs = require('fs'); ${patch}; require('module').syncBuiltinESMExports(); import(require('url').pathToFileURL(process.argv[1]).href)`
    const r = spawnSync(process.execPath, ['-e', code, SCRIPT, ...args], { cwd: D.root, encoding: 'utf8' })
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
  }
  test('space: no statfsSync, or a free space that is not a number: one line "not measured", code 0', () => {
    const D = repo()
    let r = patched(D, 'fs.statfsSync = undefined', ['space', 'plans/p', '--size-bytes', '1000'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, 'space: not measured (this Node version has no statfsSync (18.15 or later))')
    r = patched(D, 'fs.statfsSync = () => ({ bavail: undefined, bsize: 4096 })', ['space', 'plans/p', '--size-bytes', '1000'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, 'space: not measured (free space unknown)')
  })

  test('space: the message of a failed measure: its code first, its first line only, also for a thrown value that is not an Error; code 0', () => {
    const D = repo()
    let r = patched(D, "fs.statfsSync = () => { throw new Error('disk gone\\nsecond line') }", ['space', 'plans/p', '--size-bytes', '1000'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, 'space: not measured (disk gone)')
    r = patched(D, "fs.statfsSync = () => { throw Object.assign(new Error('i/o failure'), { code: 'EIO' }) }", ['space', 'plans/p', '--size-bytes', '1000'])
    assert.equal(r.out, 'space: not measured (EIO i/o failure)', 'the error code comes first')
    r = patched(D, "fs.statfsSync = () => { throw 'not an Error' }", ['space', 'plans/p', '--size-bytes', '1000'])
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, 'space: not measured (not an Error)', 'a thrown value that is not an Error')
  })

  test('space: an injected size of 0 is used as is, the folder is not measured', () => {
    const D = repo()
    const r = D.launch(['space', 'plans/p', '--parallelism', '1', '--size-bytes', '0'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /^space: [0-9.]+ GB free, 0\.0 GB needed \(0\.0 GB x 1 in parallel\)$/)
    const here = process.cwd()
    process.chdir(D.root)
    try { assert.equal(space('plans/p', { parallelism: 1, sizeBytes: 0 }).need, 0) } finally { process.chdir(here) }
  })

  test('space: a symbolic link counts for itself, never for its target; a .git below the root is counted', () => {
    const D = repo()
    const here = process.cwd()
    process.chdir(D.root)
    try {
      const base = space('plans/p', { parallelism: 1 }).need
      const target = join(D.root, '..', 'big outside'); writeFileSync(target, 'x'.repeat(50000))
      symlinkSync(target, join(D.root, 'link'))
      const linked = space('plans/p', { parallelism: 1 }).need
      assert.equal(linked, base + lstatSync(join(D.root, 'link')).size, 'link counted for itself')
      assert.ok(linked < base + 50000, 'target not followed')
      mkdirSync(join(D.root, 'sub', '.git'), { recursive: true }); writeFileSync(join(D.root, 'sub', '.git', 'x'), 'x'.repeat(3000))
      assert.equal(space('plans/p', { parallelism: 1 }).need, linked + 3000, '.git below the root counted')
    } finally { process.chdir(here) }
  })

  test('space: option values are never taken as the plan, options before or after it', () => {
    const D = repo()
    const r = D.launch(['space', '--parallelism', '3', '--size-bytes', '1000', 'plans/p'])
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /x 3 in parallel\)$/)
  })

  test('space: the lacking field follows the ⚠', () => {
    const D = repo()
    const here = process.cwd()
    process.chdir(D.root)
    try {
      assert.equal(space('plans/p', { sizeBytes: 0 }).lacking, false)
      assert.equal(space('plans/p', { sizeBytes: 1e18 }).lacking, true)
    } finally { process.chdir(here) }
  })
  console.log(`worktrees: ALL GREEN (${n} tests)`)
} finally { for (const d of temporaries) rmSync(d, { recursive: true, force: true }) }
