#!/usr/bin/env node
// worktrees (orchestre plugin 0.12.0): removes the worktrees that earlier attempts left behind for the tasks of a plan.
// Node 18 or later, no dependencies.
//
// Usage: node <plugin root>/scripts/worktrees.mjs clean [<plan-dir>] [--dry-run] [--run-stopped]
//   Without a folder: the only plan in plans/. --dry-run: says what would be done, without touching anything.
//   --run-stopped: the user confirms that the run marked "in-progress" in progress.json is stopped (session closed without a run end).
//
// A worktree left on the branch task/<id> (or task/<id>-rN, or tache/… of orchestre 0.11 and earlier) of a plan task holds that
// branch: the next attempt can no longer use it and starts on a -rN branch, sometimes without bringing it up to date. The script
// removes these worktrees:
//   - only those of the plan's tasks, never the main checkout;
//   - only if they are clean (empty git status, untracked files included; ignored files, such as
//     installed dependencies, go with the worktree); a modified worktree is reported, never removed;
//   - with "git worktree remove" without --force (git itself refuses a modified worktree), after "git worktree unlock": when
//     no run of the plan is running, the lock an agent put on its worktree is stale;
//   - never the worktree the script is launched from;
//   - the branch is always kept: the work of earlier attempts stays in git.
// To run when no agent of the plan is working: by the clerk at the end of a run, or by /orchestre:run before a run.
// If progress.json marks a run "in-progress", the script refuses (code 1): its agents may be working in these worktrees.
// Two plans of the same repository do not share task ids: they would also share the task/<id> branches.
// Output: one line per worktree removed or kept, then a summary. Code 0, even if worktrees remain; 1 if a run is in progress;
// 2 if the call is invalid.
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, dirname, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
const RE_ID = /^[A-Z]+[0-9]+[A-Z]*$/
const MIGRATE = join(dirname(fileURLToPath(import.meta.url)), 'migrate.mjs')
class UsageError extends Error {}
class Refusal extends Error {}
const attempt = f => { try { return f() } catch { return null } }
const git = (args, cwd) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const real = p => attempt(() => realpathSync(p)) || resolve(p)
const isPlan = d => existsSync(join(d, 'tasks')) || existsSync(join(d, 'taches'))

// The blocks of "git worktree list --porcelain": the first one is the main checkout
export function parseWorktrees(text) {
  const blocks = []
  for (const block of String(text).split(/\n\s*\n/)) {
    const b = {}
    for (const l of block.split('\n')) {
      const i = l.indexOf(' '), k = i < 0 ? l : l.slice(0, i), v = i < 0 ? '' : l.slice(i + 1)
      if (k === 'worktree') b.path = v
      else if (k === 'HEAD') b.head = v
      else if (k === 'branch') b.branch = v.replace(/^refs\/heads\//, '')
      else if (k === 'detached') b.detached = true
      else if (k === 'locked') b.lock = v || true
      else if (k === 'prunable') b.prunable = v || true
    }
    if (b.path) blocks.push(b)
  }
  return blocks
}

// The task of a branch task/<id> or task/<id>-rN, and tache/… of orchestre 0.11 and earlier
export const taskOf = branch => { const m = String(branch || '').match(/^(?:task|tache)\/([A-Z]+[0-9]+[A-Z]*)(?:-r[0-9]+)?$/); return m ? m[1] : null }

function locate(arg) {
  const here = attempt(() => git(['rev-parse', '--show-toplevel'], process.cwd()).trim())
  if (!here) throw new UsageError('not in a git repository')
  const main = real(parseWorktrees(attempt(() => git(['worktree', 'list', '--porcelain'], here)) || '')[0]?.path || here)
  let dir
  if (arg) {
    const abs = resolve(process.cwd(), arg)
    const r = existsSync(abs) ? relative(real(here), real(abs)) : null
    dir = r != null && !r.startsWith('..') && !isAbsolute(r) ? join(main, r) : resolve(main, arg)
    if (!isPlan(dir)) throw new UsageError(`plan not found: ${arg}`)
  } else {
    const p = join(main, 'plans')
    const plans = existsSync(p) ? readdirSync(p).filter(n => isPlan(join(p, n))).sort() : []
    if (!plans.length) throw new UsageError('no plan in plans/; give its folder: plans/<name>')
    if (plans.length > 1) throw new UsageError(`several plans (${plans.map(n => 'plans/' + n).join(', ')}); say which`)
    dir = join(p, plans[0])
  }
  if (!existsSync(join(dir, 'tasks'))) throw new UsageError(`plan in the French format of orchestre 0.11 and earlier (taches/): migrate it with node "${MIGRATE}" ${relative(main, dir).split(sep).join('/') || '.'}`)
  return { main, dir, here: real(here) }
}

// The ids of the plan's tasks, read from the frontmatter of tasks/*.md
function planIds(dir) {
  const ids = new Set()
  for (const f of readdirSync(join(dir, 'tasks')).filter(f => f.endsWith('.md'))) {
    const fm = (readFileSync(join(dir, 'tasks', f), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''
    const id = (fm.match(/^id:\s*["']?([^"'\s#]+)/m) || [])[1]
    if (id && RE_ID.test(id)) ids.add(id)
  }
  return ids
}

// A run marked "in-progress" in progress.json: its agents may be working in the worktrees. A progress.json still in a
// format of 0.11 (converted at its first write) says "en-cours".
function runInProgress(dir) {
  const doc = attempt(() => JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8')))
  const r = ((doc && Array.isArray(doc.runs) && doc.runs) || []).filter(r => r && (r.status === 'in-progress' || r.statut === 'en-cours')).pop()
  return r ? { number: r.number ?? r.numero, start: r.start ?? r.debut } : null
}

export function clean(arg, { dryRun = false, runStopped = false } = {}) {
  const { main, dir, here } = locate(arg)
  const running = runInProgress(dir)
  if (running && !runStopped && !dryRun) throw new Refusal(`progress.json marks run ${running.number} "in-progress" since ${running.start}: nothing is removed, its agents may be working in these worktrees. If it is stopped, run again with --run-stopped.`)
  const ids = planIds(dir)
  const all = parseWorktrees(git(['worktree', 'list', '--porcelain'], main))
  const lines = [], removed = [], kept = []
  let prunable = 0
  for (const w of all.slice(1)) {
    const id = taskOf(w.branch)
    if (!id || !ids.has(id) || real(w.path) === main) continue
    if (real(w.path) === here) { kept.push(w); lines.push(`kept    ${w.branch} (${w.path}): this is the folder the clean is launched from`); continue }
    if (w.prunable || !existsSync(w.path)) { prunable++; continue }
    const changes = attempt(() => git(['-C', w.path, 'status', '--porcelain', '--untracked-files=all'], main))
    if (changes == null) { kept.push(w); lines.push(`kept    ${w.branch} (${w.path}): unreadable state`); continue }
    const n = changes.split('\n').filter(Boolean).length
    if (n) { kept.push(w); lines.push(`kept    ${w.branch} (${w.path}): ${n} file${n > 1 ? 's' : ''} modified or untracked, to commit or discard by hand`); continue }
    const lock = w.lock ? `, lock${w.lock === true ? '' : ` "${w.lock}"`} lifted` : ''
    if (dryRun) { removed.push(w); lines.push(`to remove ${w.branch} (${w.path})${lock ? lock.replace('lifted', 'to lift') : ''}`); continue }
    if (w.lock) attempt(() => git(['worktree', 'unlock', w.path], main))
    try {
      git(['worktree', 'remove', w.path], main)
      removed.push(w)
      lines.push(`removed ${w.branch} (${w.path}), branch kept${lock}`)
    } catch (e) {
      kept.push(w)
      lines.push(`kept    ${w.branch} (${w.path}): git refuses to remove it (${String(e.stderr || e.message).trim().split('\n')[0]})`)
    }
  }
  // Worktrees whose folder has disappeared: only their metadata in .git
  if (prunable && !dryRun) attempt(() => git(['worktree', 'prune'], main))
  const plan = relative(main, dir).split(sep).join('/') || '.'
  const summary = `worktrees ${plan}: ${removed.length} ${dryRun ? 'to remove' : 'removed'}, ${kept.length} kept${prunable ? `, ${prunable} stale ${dryRun ? 'to forget' : 'forgotten'}` : ''}`
  return { text: [...lines, summary].join('\n'), removed: removed.map(w => w.branch), kept: kept.map(w => w.branch), prunable }
}

const launched = process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))
if (launched) {
  try {
    const argv = process.argv.slice(2)
    if (argv[0] !== 'clean') throw new UsageError('usage: worktrees.mjs clean [<plan-dir>] [--dry-run] [--run-stopped]')
    const arg = argv.slice(1).find(a => !a.startsWith('--'))
    console.log(clean(arg, { dryRun: argv.includes('--dry-run'), runStopped: argv.includes('--run-stopped') }).text)
  } catch (e) {
    console.error(`worktrees: ${e instanceof UsageError || e instanceof Refusal ? e.message : `unexpected error, nothing more is removed: ${(e && e.stack) || e}`}`)
    process.exitCode = e instanceof UsageError ? 2 : 1
  }
}
