#!/usr/bin/env node
// worktrees (orchestre plugin 0.8.0): removes the worktrees that earlier attempts left behind for the tasks of a plan.
// Node 18 or later, no dependencies.
//
// Usage: node <plugin root>/scripts/worktrees.mjs nettoyer [<plan-dir>] [--essai] [--run-arrete]
//   Without a folder: the only plan in plans/. --essai: says what would be done, without touching anything.
//   --run-arrete: the user confirms that the run marked « en-cours » in suivi.json is stopped (session closed without a run end).
//
// A worktree left on the branch tache/<id> (or tache/<id>-rN) of a plan task holds that branch: the next attempt
// can no longer use it and starts on a -rN branch, sometimes without bringing it up to date. The script removes these worktrees:
//   - only those of the plan's tasks, never the main checkout;
//   - only if they are clean (empty git status, untracked files included; ignored files, such as
//     installed dependencies, go with the worktree); a modified worktree is reported, never removed;
//   - with « git worktree remove » without --force (git itself refuses a modified worktree), after « git worktree unlock »: when
//     no run of the plan is running, the lock an agent put on its worktree is stale;
//   - never the worktree the script is launched from;
//   - the branch is always kept: the work of earlier attempts stays in git.
// To run when no agent of the plan is working: by the clerk at the end of a run, or by /orchestre:lancer before a run.
// If suivi.json marks a run « en-cours », the script refuses (code 1): its agents may be working in these worktrees.
// Two plans of the same repository do not share task ids: they would also share the tache/<id> branches.
// Output: one line per worktree removed or kept, then a summary. Code 0, even if worktrees remain; 1 if a run is in progress;
// 2 if the call is invalid.
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
const RE_ID = /^[A-Z]+[0-9]+[A-Z]*$/
class UsageError extends Error {}
class Refusal extends Error {}
const attempt = f => { try { return f() } catch { return null } }
const git = (args, cwd) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const real = p => attempt(() => realpathSync(p)) || resolve(p)

// The blocks of « git worktree list --porcelain »: the first one is the main checkout
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

// The task of a branch tache/<id> or tache/<id>-rN
export const taskOf = branch => { const m = String(branch || '').match(/^tache\/([A-Z]+[0-9]+[A-Z]*)(?:-r[0-9]+)?$/); return m ? m[1] : null }

function locate(arg) {
  const here = attempt(() => git(['rev-parse', '--show-toplevel'], process.cwd()).trim())
  if (!here) throw new UsageError('pas dans un dépôt git')
  const main = real(parseWorktrees(attempt(() => git(['worktree', 'list', '--porcelain'], here)) || '')[0]?.path || here)
  let dir
  if (arg) {
    const abs = resolve(process.cwd(), arg)
    const r = existsSync(abs) ? relative(real(here), real(abs)) : null
    dir = r != null && !r.startsWith('..') && !isAbsolute(r) ? join(main, r) : resolve(main, arg)
    if (!existsSync(join(dir, 'taches'))) throw new UsageError(`plan introuvable : ${arg}`)
  } else {
    const p = join(main, 'plans')
    const plans = existsSync(p) ? readdirSync(p).filter(n => existsSync(join(p, n, 'taches'))).sort() : []
    if (!plans.length) throw new UsageError('aucun plan dans plans/ ; précise son dossier : plans/<nom>')
    if (plans.length > 1) throw new UsageError(`plusieurs plans (${plans.map(n => 'plans/' + n).join(', ')}) ; précise lequel`)
    dir = join(p, plans[0])
  }
  return { main, dir, here: real(here) }
}

// The ids of the plan's tasks, read from the frontmatter of taches/*.md
function planIds(dir) {
  const ids = new Set()
  for (const f of readdirSync(join(dir, 'taches')).filter(f => f.endsWith('.md'))) {
    const fm = (readFileSync(join(dir, 'taches', f), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''
    const id = (fm.match(/^id:\s*["']?([^"'\s#]+)/m) || [])[1]
    if (id && RE_ID.test(id)) ids.add(id)
  }
  return ids
}

// A run marked « en-cours » in suivi.json (0.8.0): its agents may be working in the worktrees
function runInProgress(dir) {
  const doc = attempt(() => JSON.parse(readFileSync(join(dir, 'suivi.json'), 'utf8')))
  return ((doc && Array.isArray(doc.runs) && doc.runs) || []).filter(r => r && r.statut === 'en-cours').pop() || null
}

export function clean(arg, { dryRun = false, runStopped = false } = {}) {
  const { main, dir, here } = locate(arg)
  const running = runInProgress(dir)
  if (running && !runStopped && !dryRun) throw new Refusal(`suivi.json note le run ${running.numero} « en-cours » depuis ${running.debut} : rien n'est retiré, ses agents travaillent peut-être dans ces worktrees. S'il est arrêté, relance avec --run-arrete.`)
  const ids = planIds(dir)
  const all = parseWorktrees(git(['worktree', 'list', '--porcelain'], main))
  const lines = [], removed = [], kept = []
  let prunable = 0
  for (const w of all.slice(1)) {
    const id = taskOf(w.branch)
    if (!id || !ids.has(id) || real(w.path) === main) continue
    if (real(w.path) === here) { kept.push(w); lines.push(`gardé  ${w.branch} (${w.path}) : c'est le dossier d'où le nettoyage est lancé`); continue }
    if (w.prunable || !existsSync(w.path)) { prunable++; continue }
    const changes = attempt(() => git(['-C', w.path, 'status', '--porcelain', '--untracked-files=all'], main))
    if (changes == null) { kept.push(w); lines.push(`gardé  ${w.branch} (${w.path}) : état illisible`); continue }
    const n = changes.split('\n').filter(Boolean).length
    if (n) { kept.push(w); lines.push(`gardé  ${w.branch} (${w.path}) : ${n} fichier${n > 1 ? 's' : ''} modifié${n > 1 ? 's' : ''} ou non suivi${n > 1 ? 's' : ''}, à commiter ou annuler à la main`); continue }
    const lock = w.lock ? `, verrou${w.lock === true ? '' : ` « ${w.lock} »`} levé` : ''
    if (dryRun) { removed.push(w); lines.push(`à retirer ${w.branch} (${w.path})${lock ? lock.replace('levé', 'à lever') : ''}`); continue }
    if (w.lock) attempt(() => git(['worktree', 'unlock', w.path], main))
    try {
      git(['worktree', 'remove', w.path], main)
      removed.push(w)
      lines.push(`retiré ${w.branch} (${w.path}), branche gardée${lock}`)
    } catch (e) {
      kept.push(w)
      lines.push(`gardé  ${w.branch} (${w.path}) : git refuse de le retirer (${String(e.stderr || e.message).trim().split('\n')[0]})`)
    }
  }
  // Worktrees whose folder has disappeared: only their metadata in .git
  if (prunable && !dryRun) attempt(() => git(['worktree', 'prune'], main))
  const plan = relative(main, dir) || '.'
  const summary = `worktrees ${plan} : ${removed.length} ${dryRun ? 'à retirer' : 'retiré' + (removed.length > 1 ? 's' : '')}, ${kept.length} gardé${kept.length > 1 ? 's' : ''}${prunable ? `, ${prunable} orphelin${prunable > 1 ? 's' : ''} ${dryRun ? 'à oublier' : 'oublié' + (prunable > 1 ? 's' : '')}` : ''}`
  return { text: [...lines, summary].join('\n'), removed: removed.map(w => w.branch), kept: kept.map(w => w.branch), prunable }
}

const launched = process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))
if (launched) {
  try {
    const argv = process.argv.slice(2)
    if (argv[0] !== 'nettoyer') throw new UsageError('usage : worktrees.mjs nettoyer [<dossier-plan>] [--essai] [--run-arrete]')
    const arg = argv.slice(1).find(a => !a.startsWith('--'))
    console.log(clean(arg, { dryRun: argv.includes('--essai'), runStopped: argv.includes('--run-arrete') }).text)
  } catch (e) {
    console.error(`worktrees : ${e instanceof UsageError || e instanceof Refusal ? e.message : `erreur inattendue, rien de plus n'est retiré : ${(e && e.stack) || e}`}`)
    process.exitCode = e instanceof UsageError ? 2 : 1
  }
}
