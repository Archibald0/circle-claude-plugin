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

// The formats of progress.json read here, those progress.mjs writes or converts without loss of these fields
const READS = ['orchestre-progress/4', 'orchestre-progress/3']

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
const HERE = dirname(fileURLToPath(import.meta.url))
const LINT = join(HERE, 'plan-lint.mjs')
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
// /orchestre:ready and /orchestre:run offer the migration with the user's agreement, on the integration branch (migrate.mjs)
const french = d => `plan in the French format of orchestre 0.11 and earlier (taches/): /orchestre:ready ${d} or /orchestre:run ${d} offers to migrate it`
// ── moments:begin ── The moment of what waits for the user (0.19.0) ──────────────────────────────────────────────────────
// The rules of "Your turn" in hooks/view-model.mjs, written a second time: the scripts load nothing from the mod.
// tests/status.test.mjs compares them with the mod on the same progress.json, and this block with its copy (status.mjs and
// progress.mjs carry the same one). Moment and rank, as in the pane:
//   task that waits for someone (needs-human, blocked, failed) .......... now; at run stop if it carries an open issue, during a run
//   open issue (also on a waiting task), plan-lint in error ............. now; at run stop during a run (they need the session)
//   decision to take that holds back a task of the phase in progress .... now; at run stop during a run
//   manual or environment prerequisite holding back such a task ......... now, run or not
//   prerequisite that holds back a task of a later phase k ............. before phase k
//   prerequisite that holds back no task left ........................... before the next (first) run, rank 98
//   review of a task of phase k ......................................... after phase k
//   auto-decision of a task of phase k .................................. before phase k + 1
//   auto-decision of the last phase; review of the source plan, or of a plan all merged ... before the PR
// P: { now, updated, tasks: [{ id, phase, status, step, start, end }] (cancelled included), runs: [{ status, phase, start, ruled }],
//      prerequisites: open [{ id, type, blocks }], issues: open [{ task }], reviews: open [{ task, phase, text }],
//      decisions: open [{ task }], lint: { ok, errors }, tickets, note }; dates in ms. Returns the lines of the answer.
function momentLines(P) {
  const WAITS = { 'needs-human': 'waits for a human', blocked: 'blocked', failed: 'failed' }
  const { tasks, runs } = P
  const open = tasks.filter(t => t.status !== 'cancelled'), merged = t => t.status === 'merged'
  const run = runs.at(-1) ?? null, live = !!run && run.status === 'in-progress'
  // A run in progress that has not written for 45 minutes gives no news: its tasks in a step no longer count as running
  const active = live && !(P.updated != null && P.now - P.updated >= 45 * 60000)
  const NOW = { moment: 'now', rank: 0 }, STOP = { moment: 'at run stop', rank: 0.2 }, PR = { moment: 'before the PR', rank: 99 }
  const after = k => ({ moment: `after phase ${k}`, rank: k }), before = k => ({ moment: `before phase ${k}`, rank: k - 0.5 })
  const session = live ? STOP : NOW
  const lineOf = m => (m === 'now' ? 'now' : m === 'at run stop' ? 'stop' : 'later')
  const phaseOf = id => tasks.find(t => t.id === id)?.phase ?? null
  const phases = [...new Set(open.map(t => t.phase))].sort((a, b) => a - b)
  const maxPhase = phases.at(-1) ?? 0, allMerged = open.length > 0 && open.every(merged)
  // The phase in progress: the one of the run (the highest of the tasks it started or closed), otherwise the first not finished
  const touched = run && run.start != null ? open.filter(t => (t.start != null && t.start >= run.start) || (t.end != null && t.end >= run.start)) : []
  const cur = live ? Math.max(run.phase, ...touched.map(t => t.phase)) : phases.find(k => !open.filter(t => t.phase === k).every(merged)) ?? null
  const items = []
  const put = (order, at, f) => items.push({ order, ...at, ...f })
  const seen = new Set()
  for (const t of open.filter(t => t.status in WAITS && !(active && t.step) && !(live && run.ruled.includes(t.id)))) {
    const p = P.issues.find(x => x.task === t.id)
    if (p) seen.add(p)
    put(1, p ? session : NOW, { text: `${t.id} ${WAITS[t.status]}` })
  }
  for (const p of P.issues) if (!seen.has(p)) put(2, session, { count: 'issue' })
  for (const p of P.prerequisites) {
    const held = tasks.filter(t => p.blocks.includes(t.id) && t.status !== 'merged' && t.status !== 'cancelled')
    const first = held.length ? Math.min(...held.map(t => t.phase)) : null
    const at = first == null ? { moment: runs.length ? 'before the next run' : 'before the first run', rank: 98 } : cur != null && first > cur ? before(first) : NOW
    const when = p.type === 'decision' && at.moment === 'now' ? session : at
    put(0, when, { text: lineOf(when.moment) === 'later' ? `${p.id} ${when.moment}` : `${p.id} (${p.type}) blocks ${shorten(p.blocks, 4).join(', ')}` })
  }
  if (!P.lint.ok) put(3, session, { text: `plan-lint: ${plural(P.lint.errors, 'error')}` })
  // Two open reviews of the same task are one when their first backquoted passage is the same (D5)
  const twins = new Set()
  for (const r of P.reviews) {
    const m = /`([^`]+)`/.exec(r.text)
    if (m) { const k = `${r.task ?? ''}|${m[1]}`; if (twins.has(k)) continue; twins.add(k) }
    const phase = r.phase ?? phaseOf(r.task)
    put(4, allMerged || phase == null ? PR : after(phase), { count: 'review' })
  }
  for (const d of P.decisions) {
    const phase = phaseOf(d.task)
    put(5, allMerged || phase == null || phase >= maxPhase ? PR : before(phase + 1), { count: 'auto-decision' })
  }
  // By rank, then prerequisites, tasks, issues, plan-lint, reviews, auto-decisions; the same kind at the same moment is counted
  items.sort((a, b) => a.rank - b.rank || a.order - b.order)
  const entries = []
  for (const it of items) {
    const same = it.count && entries.find(e => e.count === it.count && e.moment === it.moment)
    if (same) same.n++
    else entries.push({ line: lineOf(it.moment), moment: it.moment, count: it.count, n: 1, text: it.text })
  }
  if (P.note) entries.push({ line: 'now', text: P.note })
  if (P.tickets) entries.push({ line: 'later', text: `${plural(P.tickets, 'ticket')} after the PR` })
  const say = e => (e.count ? `${e.count === 'issue' ? `${plural(e.n, 'issue')} to settle` : plural(e.n, e.count)}${e.line === 'later' ? ` ${e.moment}` : ''}` : e.text)
  const lines = [['now', 'Now'], ['stop', 'At run stop'], ['later', 'Later']].map(([k, title]) => [title, entries.filter(e => e.line === k).map(say)]).filter(([, xs]) => xs.length)
    .map(([title, xs]) => `**${title}**: ${shorten(xs, 6).join(' · ')}`)
  return lines.length ? lines : ['**Your turn**: nothing for now']
}
// ── moments:end ──

// Without progress.json: the reviews of HANDOFF.md, each with its task from its section ("## T01"), as progress.mjs rebuilds them
function handoffReviews(handoff) {
  const found = []
  let section = null
  for (const line of handoff.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/)
    if (h) { section = h[1]; continue }
    const m = line.match(/^\s*(?:[-*]\s*)?review\s*·\s*(?:minor|major)\s*·\s*(.*)$/i)
    if (m && m[1].trim()) found.push({ task: /^[A-Z]+[0-9]+[A-Z]*$/.test(section || '') ? section : null, phase: null, text: m[1].trim() })
  }
  return found
}

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
  // progress.json (0.16.0): fresher than PROGRESS.md during a run; git stays the source of truth for "merged". Read in /4 (0.20.0)
  // as in /3: the fields read here are the same in both; another format, or not JSON, is ignored
  const progress = attempt(() => JSON.parse(readFileSync(join(dir, 'progress.json'), 'utf8')))
  const known = !!progress && READS.includes(progress.format)
  const S = new Map((known && Array.isArray(progress.tasks) ? progress.tasks : []).filter(t => t && t.id).map(t => [t.id, t]))
  const all = (L.tasks || []).map(t => ({ ...t, status: t.status === 'merged' ? 'merged' : S.get(t.id)?.status ?? t.status }))
  const active = all.filter(t => t.status !== 'cancelled')
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
  const log = attempt(() => git(['log', '--first-parent', '--format=%ct%x09%s', base && base !== integ ? `${base}..${integ}` : integ, '--'], root)) || ''
  const merge = log.split('\n').map(l => l.split('\t')).find(([, s]) => MERGE.test(s || ''))

  // What waits for the user, by moment (0.19.0). The reviews still open in progress.json (those marked done, 0.15.1, or moved
  // to tickets, 0.16.0, no longer wait), otherwise those of HANDOFF.md, whose phase is unknown; the tickets of HANDOFF.md, and
  // the reviews and auto-decisions moved to tickets
  const handoff = attempt(() => readFileSync(join(dir, 'HANDOFF.md'), 'utf8')) || ''
  const count = type => (handoff.match(new RegExp(`^\\s*(?:[-*]\\s*)?${type}\\s*·`, 'gim')) || []).length
  const list = k => (known && Array.isArray(progress[k]) ? progress[k] : []).filter(x => x && typeof x === 'object')
  const closed = x => x.done || x.ticket
  const moved = known ? [...list('reviews'), ...list('auto_decisions')].filter(x => x.ticket && !x.done).length : 0
  const ms = x => { const t = typeof x === 'string' ? Date.parse(x) : NaN; return Number.isNaN(t) ? null : t }
  const reviews = known && Array.isArray(progress.reviews)
    ? list('reviews').filter(r => !closed(r)).map(r => ({ task: r.task == null ? null : String(r.task), phase: Number.isInteger(r.phase) ? r.phase : null, text: typeof r.text === 'string' ? r.text : '' }))
    : handoffReviews(handoff)
  // A plan closed by the pilot ([ Close the plan ] of /progress, 0.16.1)
  const closedOn = known && typeof progress.closed === 'string'
  const ruled = new Set(known ? list('pending_rulings').map(r => r && r.issue) : [])
  const yourTurn = momentLines({
    now: Date.now(), updated: known ? ms(progress.updated) : null,
    tasks: all.map(t => { const s = S.get(t.id); return { id: t.id, phase: t.phase, status: t.status, step: typeof s?.step === 'string' ? s.step : null, start: ms(s?.start), end: ms(s?.end) } }),
    runs: list('runs').map(r => ({ status: String(r.status), phase: Number.isInteger(r.phase) ? r.phase : 0, start: ms(r.start), ruled: (Array.isArray(r.rulings_applied) ? r.rulings_applied : []).filter(a => a && typeof a === 'object').map(a => String(a.task)) })),
    prerequisites: (L.prerequisites || []).filter(x => x.status === 'open').map(p => ({ id: p.id, type: p.type, blocks: p.blocks || [] })),
    // An issue whose ruling is recorded (rule, 0.20.0) and not applied yet no longer waits for the user, as in progress.mjs status
    issues: list('issues').filter(p => p.status !== 'settled' && !ruled.has(p.id)).map(p => ({ task: String(p.task) })),
    reviews, decisions: list('auto_decisions').filter(d => !closed(d)).map(d => ({ task: String(d.task) })),
    lint: { ok: !!L.ok, errors: (L.errors || []).length },
    tickets: count('ticket') + moved, note: null,
  })

  // Rendering
  const phases = [...new Set(active.map(t => t.phase))].sort((a, b) => a - b)
  const started = ph => active.some(t => t.phase === ph && (done(t) || inProgress.some(e => e.id === t.id)))
  const current = phases.find(ph => active.some(t => t.phase === ph && !done(t)))
  const doneCount = active.filter(done).length
  const m = merge && merge[1].match(MERGE)
  const out = [
    `## ${name} — ${doneCount}/${plural(active.length, 'task')} · ${pct(doneCount, active.length)}%`,
    `\`${bar(doneCount / active.length, 24)}\` ${current == null ? `plan finished${closedOn ? ', closed' : ''}` : `phase ${current} ${started(current) ? 'in progress' : 'not started'}`}${m ? ` · last merge ${m[1] || m[2]} ${ago(Number(merge[0]))}` : ''}`,
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
  out.push('', ...yourTurn)
  return out.join('\n')
}

let text
try { text = status() } catch (e) { text = `orchestre:status: ${String((e && e.message) || e).split('\n')[0]}` }
console.log(text)
// No process.exit(): in a pipe, it could cut the output (0.8.1)
process.exitCode = 0
