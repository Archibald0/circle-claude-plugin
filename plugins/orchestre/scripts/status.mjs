#!/usr/bin/env node
// Progress status of an orchestre plan (orchestre plugin 0.12.0), as compact Markdown, for /orchestre:status.
// Read-only, safe during a run: no switch, no write, git without optional locks (GIT_OPTIONAL_LOCKS=0).
// Usage: node <plugin root>/scripts/status.mjs [<plan-dir>]
// Without a folder, takes the only plan in plans/. Always exits with code 0: a command injected into a skill
// that fails would cancel the skill; an error is therefore printed on one line "orchestre:status: …".
// Git history is read in both languages: branches task/<id> and tache/<id>, merge commits "task <id>: " and "tâche <id> : ".
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, basename, dirname, relative } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
const HERE = dirname(fileURLToPath(import.meta.url))
const LINT = join(HERE, 'plan-lint.mjs')
const MIGRATE = join(HERE, 'migrate.mjs')
const attempt = f => { try { return f() } catch { return null } }
const git = (args, cwd) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`
const bar = (r, n) => { const k = Math.floor(r * n); return '█'.repeat(k) + '░'.repeat(n - k) }
const pct = (f, n) => Math.floor((100 * f) / n)
const ago = ts => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts))
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
}
const shorten = (xs, max) => (xs.length > max ? [...xs.slice(0, max - 1), `+${xs.length - max + 1}`] : xs)
// Merge commit and task branch, in English (0.12) or in French (0.11 and earlier)
const MERGE = /^(?:task (\S+):|tâche (\S+) :)/
const isPlan = d => existsSync(join(d, 'tasks')) || existsSync(join(d, 'taches'))
const french = d => `plan in the French format of orchestre 0.11 and earlier (taches/): migrate it with node "${MIGRATE}" ${d}`

function status() {
  const root = attempt(() => git(['rev-parse', '--show-toplevel'], process.cwd()).trim())
  if (!root) return 'orchestre:status: not in a git repository'

  // Plan: the argument, relative to the current folder then to the root; otherwise the only plan in plans/
  const arg = process.argv.slice(2).find(a => !a.startsWith('--'))
  let dir
  if (arg) {
    dir = [resolve(arg), resolve(root, arg)].find(isPlan)
    if (!dir) return `orchestre:status: plan not found in this checkout: ${arg}`
  } else {
    const p = join(root, 'plans')
    const plans = existsSync(p) ? readdirSync(p).filter(n => isPlan(join(p, n))).sort() : []
    if (!plans.length) return 'orchestre:status: no plan in plans/; give its folder: /orchestre:status plans/<name>'
    if (plans.length > 1) return `orchestre:status: several plans (${plans.map(n => 'plans/' + n).join(', ')}); say which: /orchestre:status plans/${plans[0]}`
    dir = join(p, plans[0])
  }
  if (!existsSync(join(dir, 'tasks'))) return `orchestre:status: ${french(relative(root, dir) || '.')}`
  const name = basename(dir)
  const cfg = attempt(() => JSON.parse(readFileSync(join(dir, 'orchestre.config.json'), 'utf8'))) || {}
  const integ = cfg.integration_branch || `plan/${name}`
  const baseCfg = cfg.base_branch || null
  // A branch name that starts with "-" would be read by git as an option
  if ([integ, baseCfg].some(b => b && String(b).startsWith('-'))) return 'orchestre:status: invalid branch in orchestre.config.json'

  // plan-lint is the source of truth for the tasks, their statuses (git included) and the prerequisites
  const r = spawnSync(process.execPath, [LINT, relative(root, dir) || '.', '--json', '--integration', integ, ...(baseCfg ? ['--base', baseCfg] : [])], { cwd: root, env: ENV, encoding: 'utf8', maxBuffer: 1 << 26 })
  const L = attempt(() => JSON.parse(r.stdout))
  if (!L) return `orchestre:status: plan-lint returned no state (${String(r.stderr || r.stdout || 'no message').trim().split('\n')[0]})`
  const active = (L.tasks || []).filter(t => t.status !== 'cancelled')
  if (!active.length) return `orchestre:status: no task in ${relative(root, dir)}`
  const done = t => t.status === 'merged'
  const ATTENTION = { 'needs-human': 'waits for a human', blocked: 'blocked', failed: 'failed' }

  // Started tasks: a branch task/<id> (or task/<id>-r<n>, or tache/… of 0.11) exists, the task is neither merged nor waiting
  const refs = (attempt(() => git(['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads/task/', 'refs/heads/tache/'], root)) || '')
    .split('\n').filter(Boolean).map(l => { const [ref, ts] = l.split('\t'); return { ref, ts: Number(ts), id: ref.replace(/^(task|tache)\//, '').replace(/-r\d+$/, '') } })
  const head = attempt(() => git(['symbolic-ref', '-q', '--short', 'HEAD'], root).trim()) || ''
  // The first worktree listed is the main checkout
  const worktrees = new Set((attempt(() => git(['worktree', 'list', '--porcelain'], root)) || '').split(/\n\s*\n/).slice(1).map(b => (b.match(/^branch refs\/heads\/(.+)$/m) || [])[1]).filter(Boolean))
  const inProgress = []
  for (const t of active) {
    if (done(t) || ATTENTION[t.status]) continue
    const b = refs.filter(x => x.id === t.id).sort((x, y) => y.ts - x.ts)[0]
    if (!b) continue
    const ahead = Number(attempt(() => git(['rev-list', '--count', `${integ}..${b.ref}`], root).trim()) || 0)
    const where = b.ref === head ? 'checkout' : worktrees.has(b.ref) ? 'worktree' : null
    inProgress.push({ id: t.id, text: `${t.id} (${[where, ahead ? `last commit ${ago(b.ts)}` : 'started'].filter(Boolean).join(', ')})` })
  }

  // Last merge on the integration branch, excluding merges of an earlier plan already in the base
  const exists = b => attempt(() => git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], root)) != null
  const base = baseCfg || ['main', 'master'].find(exists)
  const log = attempt(() => git(['log', '--format=%ct%x09%s', base && base !== integ ? `${base}..${integ}` : integ, '--'], root)) || ''
  const merge = log.split('\n').map(l => l.split('\t')).find(([, s]) => MERGE.test(s || ''))

  // What waits for the user
  const yourTurn = []
  for (const p of (L.prerequisites || []).filter(x => x.status === 'open' && (x.blocks || []).length)) yourTurn.push(`${p.id} (${p.type}) blocks ${shorten(p.blocks, 4).join(', ')}`)
  for (const [st, what] of Object.entries(ATTENTION)) for (const t of active.filter(x => x.status === st)) yourTurn.push(`${t.id} ${what}`)
  const handoff = attempt(() => readFileSync(join(dir, 'HANDOFF.md'), 'utf8')) || ''
  const count = type => (handoff.match(new RegExp(`^\\s*(?:[-*]\\s*)?${type}\\s*·`, 'gim')) || []).length
  const reviews = count('review'), tickets = count('ticket')
  if (reviews) yourTurn.push(`${plural(reviews, 'review')} before the PR`)
  if (tickets) yourTurn.push(`${plural(tickets, 'ticket')} after the PR`)
  if (!L.ok) yourTurn.push(`plan-lint: ${plural((L.errors || []).length, 'error')}`)

  // Rendering
  const phases = [...new Set(active.map(t => t.phase))].sort((a, b) => a - b)
  const started = ph => active.some(t => t.phase === ph && (done(t) || inProgress.some(e => e.id === t.id)))
  const current = phases.find(ph => active.some(t => t.phase === ph && !done(t)))
  const doneCount = active.filter(done).length
  const m = merge && merge[1].match(MERGE)
  const out = [
    `## ${name} — ${doneCount}/${plural(active.length, 'task')} · ${pct(doneCount, active.length)}%`,
    `\`${bar(doneCount / active.length, 24)}\` ${current == null ? 'plan finished' : `phase ${current} ${started(current) ? 'in progress' : 'not started'}`}${m ? ` · last merge ${m[1] || m[2]} ${ago(Number(merge[0]))}` : ''}`,
    '',
    '| Phase | Progress | Tasks |',
    '| :-- | :-- | :-- |',
  ]
  for (const ph of phases) {
    const ts = active.filter(t => t.phase === ph), f = ts.filter(done).length
    const sym = f === ts.length ? '✓' : ts.some(t => ATTENTION[t.status]) ? '⚠' : started(ph) ? '●' : '○'
    out.push(`| ${sym} ${ph} | \`${bar(f / ts.length, 10)}\` ${pct(f, ts.length)}% | ${f}/${ts.length} |`)
  }
  if (inProgress.length) out.push('', `**In progress**: ${shorten(inProgress.map(e => e.text), 5).join(' · ')}`)
  out.push('', `**Your turn**: ${yourTurn.length ? shorten(yourTurn, 6).join(' · ') : 'nothing for now'}`)
  return out.join('\n')
}

let text
try { text = status() } catch (e) { text = `orchestre:status: ${String((e && e.message) || e).split('\n')[0]}` }
console.log(text)
// No process.exit(): in a pipe, it could cut the output (0.8.1)
process.exitCode = 0
