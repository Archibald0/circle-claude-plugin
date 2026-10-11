#!/usr/bin/env node
// plan-lint (orchestre plugin 0.12.0): validates a plan folder and compiles it to JSON. Node 18 or later, no dependencies.
// Usage: node <plugin root>/scripts/plan-lint.mjs <plan-dir> [--json] [--phase N] [--integration <branch>] [--base <branch>]
// With --integration, a task whose merge commit "task <id>: " is on the integration branch, and not on the base branch
// (--base, else main, else master), counts as merged: git is the source of truth. The base excludes merges of earlier plans
// already in main. Commits "tâche <id> : " of orchestre 0.11 and earlier count too: git history is never rewritten.
// A task "cancelled" in PROGRESS.md counts as done: it blocks neither its phase nor the tasks that depend on it.
// PREREQUISITES.md (optional): what the plan expects from a human or the environment. A task lists its own in "prerequisites";
// while one of them is "open", the task waits (open_prerequisites) and the rest of the phase can run.
// Warnings (block nothing): compound verification or setup commands, which an agent isolated in a worktree would be refused
// by Claude Code's isolation guard; shared setup resource that no task declares; remaining task without model or
// model_reason. A model outside MODELS is an error; the choice itself is never judged.
// Fable: orchestre.config.json says whether the user allows it ("fable": true or false, asked by /orchestre:prepare).
// A remaining task on fable, or an escalation that contains it: error with fable: false, warning without the setting.
// orchestre.config.json (optional): setup, a list of commands; shared_setup, { resource: [commands] }; language, the language
// of the free text written during a run ("en" by default).
// A plan in the French format of orchestre 0.11 and earlier (taches/, SUIVI.md, French keys) is refused: scripts/migrate.mjs
// converts it once.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MIGRATE = join(dirname(fileURLToPath(import.meta.url)), 'migrate.mjs')
const argv = process.argv.slice(2)
const dir = argv.find((a, i) => !a.startsWith('--') && !['--phase', '--integration', '--base'].includes(argv[i - 1]))
const ii = argv.indexOf('--integration')
const integ = ii >= 0 ? argv[ii + 1] : null
const bi = argv.indexOf('--base')
const baseArg = bi >= 0 ? argv[bi + 1] : null
const asJson = argv.includes('--json')
const pi = argv.indexOf('--phase')
const phaseF = pi >= 0 ? Number(argv[pi + 1]) : null
if (!dir) { console.error('usage: plan-lint <plan-dir> [--json] [--phase N] [--integration <branch>] [--base <branch>]'); process.exit(2) }
// A branch name never starts with "-": git would read it as an option (--output=… would write a file)
for (const [name, b] of [['integration', integ], ['base', baseArg]]) if (b != null && (!b || b.startsWith('-'))) { console.error(`invalid ${name} branch: ${b}`); process.exit(2) }
if (!existsSync(join(dir, 'tasks'))) {
  if (existsSync(join(dir, 'taches'))) console.error(`plan in the French format of orchestre 0.11 and earlier (taches/): migrate it first with node "${MIGRATE}" ${dir}`)
  else console.error(`task folder not found: ${join(dir, 'tasks')}`)
  process.exit(2)
}

const arr = x => (Array.isArray(x) ? x : x ? [x] : [])
// Compound command: chaining or subcommand, cd/export/assignment first, code evaluated inline by an interpreter,
// script by absolute path. Quoted text does not count, except a substitution inside double quotes; "\;" neither.
const withoutQuotes = c => c.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""')
const withoutSingleQuotes = c => c.replace(/'[^']*'/g, "''")
const INTERPRETERS = 'node|nodejs|deno|bun|tsx|ts-node|python[0-9.]*|ruby|perl|php|bash|sh|zsh|pwsh|powershell'
const INLINE = new RegExp(`(^|[\\s/])(${INTERPRETERS})\\s+(?:-{1,2}[\\w-]+\\s+)*(-e|-c|-p|-r|--eval|--print|-Command)\\s+["'\`]`)
function compound(c) {
  const s = String(c), bare = withoutQuotes(s).replace(/\\;/g, ''), reasons = []
  if (/&&|\|\||;|\|/.test(bare) || /\$\(|`|<\(/.test(withoutSingleQuotes(s))) reasons.push('chaining or subcommand')
  if (/^\s*(cd|export)\s/.test(s) || /^\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(s)) reasons.push('cd, export or assignment first')
  if (INLINE.test(s) || /(^|\s)deno\s+eval\s/.test(s)) reasons.push('code evaluated inline')
  if (/(^|\s)\/[^\s'"]+\.(sh|bash|mjs|cjs|js|ts|py|rb|php|pl)(\s|$)/.test(withoutQuotes(s))) reasons.push('script by absolute path')
  return reasons
}
const short = c => (String(c).length > 100 ? String(c).slice(0, 99) + '…' : String(c))
const done = s => s === 'merged' || s === 'cancelled'
// Models of a task: /orchestre:prepare picks haiku, sonnet or opus; fable only on the tasks the user designates
const MODELS = ['haiku', 'sonnet', 'opus', 'fable']
// Frontmatter text field: an empty value ("model:") reads as an empty list, hence as absent
const fmText = x => (typeof x === 'string' && x.trim() ? x.trim() : null)
// Model of a task: absent (nothing, or an empty value), valid, or rejected by an error
const modelState = x => (fmText(x) === null && (x === undefined || typeof x === 'string' || (Array.isArray(x) && !x.length)) ? 'absent' : MODELS.includes(fmText(x)) ? 'valid' : 'rejected')
// French names of orchestre 0.11 and earlier: read silently, they would be ignored (a dependency, a branch), hence an error
const FRENCH_TASK_KEYS = { titre: 'title', modele: 'model', raison_modele: 'model_reason', depend_de: 'depends_on', lot_parallele: 'parallel_batch', fichiers_possedes: 'owned_files', ressources: 'resources', prerequis: 'prerequisites', budget_contexte: 'context_budget', estimation_tokens: 'token_estimate', max_tours: 'max_turns', definition_du_fini: 'definition_of_done' }
const FRENCH_CONFIG_KEYS = { parallelisme_max: 'max_parallelism', mode_par_defaut: 'default_mode', branche_integration: 'integration_branch', branche_base: 'base_branch', evaluateur: 'evaluator', corrections_max: 'max_fixes', escalade: 'escalation', decisions_office_max: 'max_auto_decisions', plafond_session_pilote: 'pilot_context_cap', preparation: 'setup', preparation_partagee: 'shared_setup' }
function unquote(v) {
  v = v.trim()
  if (v.startsWith('"')) { const m = v.match(/^"((?:[^"\\]|\\.)*)"/); return m ? m[1].replace(/\\(["\\])/g, '$1') : v }
  if (v.startsWith("'")) { const m = v.match(/^'((?:[^']|'')*)'/); return m ? m[1].replace(/''/g, "'") : v }
  return v.replace(/\s+#.*$/, '').trim()
}
// Inline list [a, "b, c"]: commas inside quotes do not split items
function inlineList(v) {
  const s = v.trim()
  if (!s.startsWith('[')) return null
  const out = []
  let cur = '', q = null
  for (let i = 1; i < s.length; i++) {
    const c = s[i]
    if (q) {
      cur += c
      if (q === '"' && c === '\\') { cur += s[++i] ?? ''; continue }
      if (c === q) { if (q === "'" && s[i + 1] === "'") { cur += s[++i]; continue } q = null }
    } else if (c === '"' || c === "'") { q = c; cur += c }
    else if (c === ',' || c === ']') { if (cur.trim()) out.push(unquote(cur)); cur = ''; if (c === ']') return out }
    else cur += c
  }
  return null
}
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const out = {}
  let key = null
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && key) { if (!Array.isArray(out[key])) out[key] = []; out[key].push(unquote(item[1])); continue }
    const kv = line.match(/^([a-z_]+):\s*(.*)$/)
    if (kv) { key = kv[1]; const l = inlineList(kv[2]); out[key] = l !== null ? l : kv[2].trim() === '' ? [] : unquote(kv[2]) }
  }
  return out
}
// Cells of a Markdown table row; "\|" is a "|" inside a cell
const cells = line => {
  const l = line.trim(), p = l.split(/(?<!\\)\|/)
  if (p.length && p[0].trim() === '') p.shift()
  if (/(?<!\\)\|$/.test(l)) p.pop()
  return p.map(c => c.trim().replace(/\\\|/g, '|'))
}
function statuses() {
  const p = join(dir, 'PROGRESS.md'), map = {}
  if (!existsSync(p)) return map
  let cols = null
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const row = cells(line)
    if (!cols && row.includes('ID') && row.includes('Status')) { cols = { id: row.indexOf('ID'), st: row.indexOf('Status'), n: row.length }; continue }
    // A row of another table (fewer cells than the header, or no status) is not a task (0.8.1)
    if (cols && row.length >= cols.n && row[cols.st] && /^[A-Z]+\d+[A-Z]*$/.test(row[cols.id] || '')) map[row[cols.id]] = row[cols.st]
  }
  return map
}
// "1.0M", "1.0 M", and "1,0 M" written by orchestre 0.11 and earlier
const tokens = s => { const m = String(s || '').match(/([\d.,]+)\s*M/i); return m ? Number(m[1].replace(',', '.')) : 0 }
const norm = s => String(s || '').trim().toLowerCase()
const TYPES = ['decision', 'manual', 'environment']
const PREREQ_STATUSES = ['open', 'done', 'dropped']
function prerequisites() {
  const p = join(dir, 'PREREQUISITES.md'), list = []
  if (!existsSync(p)) return null
  let cols = null
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const row = cells(line)
    const idx = k => row.findIndex(x => norm(x) === norm(k))
    if (!cols && idx('ID') >= 0 && idx('Status') >= 0) { cols = Object.fromEntries(['ID', 'Type', 'Prerequisite', 'Status', 'Evidence'].map(k => [k, idx(k)])); continue }
    const c = k => (cols && cols[k] >= 0 ? row[cols[k]] || '' : '')
    if (!cols || row.every(x => /^:?-*:?$/.test(x))) continue
    if (/^[A-Z]+\d+[A-Z]*$/.test(c('ID'))) list.push({ id: c('ID'), type: TYPES.includes(norm(c('Type'))) ? norm(c('Type')) : c('Type'), text: c('Prerequisite'), status: PREREQ_STATUSES.includes(norm(c('Status'))) ? norm(c('Status')) : c('Status'), evidence: c('Evidence') })
    else errors.push(`PREREQUISITES.md: row ignored, invalid id "${c('ID')}" (capital letters then digits, like D5)`)
  }
  if (!cols) errors.push('PREREQUISITES.md: no table recognized (headers ID, Type, Prerequisite, Status, Evidence)')
  return list
}

const errors = [], warnings = [], T = new Map(), tdir = join(dir, 'tasks')
for (const f of readdirSync(tdir).filter(f => f.endsWith('.md')).sort()) {
  const fm = frontmatter(readFileSync(join(tdir, f), 'utf8'))
  if (!fm || !fm.id) { errors.push(`${f}: frontmatter missing or without id`); continue }
  if (T.has(fm.id)) errors.push(`${fm.id}: duplicate id`)
  for (const k of Object.keys(fm)) if (Object.hasOwn(FRENCH_TASK_KEYS, k)) errors.push(`${fm.id}: French key "${k}" of orchestre 0.11 and earlier: rename it "${FRENCH_TASK_KEYS[k]}"`)
  T.set(fm.id, { ...fm, file: join(tdir, f), phase: Number(fm.phase) })
}
// Files of the French format left next to tasks/: PROGRESS.md would be missing (every task read as todo), or the progress
// file of 0.11 ignored; migrate.mjs converts what is left
for (const f of ['SUIVI.md', 'PREREQUIS.md', 'suivi.json']) if (existsSync(join(dir, f))) errors.push(`${f}: file of the French format of orchestre 0.11 next to tasks/: run node "${MIGRATE}" ${dir}, which converts what is left`)
const st = statuses()
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const exists = b => { try { git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]); return true } catch { return false } }
if (integ) {
  const base = baseArg || ['main', 'master'].find(exists)
  if (baseArg && !exists(baseArg)) errors.push(`base branch not found: ${baseArg}`)
  try {
    // First-parent only: the merge commits of the integrator, not a commit of a worker that happens to start with "task <id>: "
    const log = git(['log', '--first-parent', '--format=%s', base && base !== integ ? `${base}..${integ}` : integ, '--'])
    for (const m of log.matchAll(/^(?:task (\S+):|tâche (\S+) :)/gm)) st[m[1] || m[2]] = 'merged'
  } catch { errors.push(`integration branch not found: ${integ}`) }
}
for (const t of T.values()) {
  if (!t.phase) errors.push(`${t.id}: missing phase`)
  // Model absent (nothing, "model:", "model: \"\""): warning below (the worker will run on sonnet, then the escalation
  // ladder); unknown value or list: error
  if (modelState(t.model) === 'rejected' && fmText(t.model) !== null) errors.push(`${t.id}: unknown model "${fmText(t.model)}" (${MODELS.join(', ')})`)
  else if (modelState(t.model) === 'rejected') errors.push(`${t.id}: unreadable model (a single name: ${MODELS.join(', ')})`)
  if (!arr(t.verification).length) errors.push(`${t.id}: no verification command`)
  if (!arr(t.definition_of_done).length) errors.push(`${t.id}: no definition of done`)
  for (const d of arr(t.depends_on)) {
    if (!T.has(d)) errors.push(`${t.id}: unknown dependency ${d}`)
    else if (T.get(d).phase > t.phase) errors.push(`${t.id}: depends on ${d}, from a later phase`)
  }
}
const ancestors = (id, seen = new Set()) => { for (const d of arr(T.get(id)?.depends_on)) if (T.has(d) && !seen.has(d)) { seen.add(d); ancestors(d, seen) } return seen }
for (const id of T.keys()) if (ancestors(id).has(id)) errors.push(`${id}: dependency cycle`)
const root = p => p.split('#')[0].trim().replace(/\*.*$/, '')
const overlaps = (a, b) => arr(a).some(x => arr(b).some(y => { const p = root(x), q = root(y); return p === q || p.startsWith(q) || q.startsWith(p) }))
const ids = [...T.keys()]
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
  const a = T.get(ids[i]), b = T.get(ids[j])
  if (a.phase !== b.phase || ancestors(a.id).has(b.id) || ancestors(b.id).has(a.id)) continue
  if (arr(a.resources).some(r => arr(b.resources).includes(r))) continue
  if (overlaps(a.owned_files, b.owned_files)) errors.push(`${a.id} and ${b.id} can run together and share files`)
}
if (phaseF != null) for (const t of T.values()) if (t.phase < phaseF && !done(st[t.id] || 'todo')) errors.push(`${t.id} (phase ${t.phase}) is neither merged nor cancelled: phase ${phaseF} cannot start`)

// Prerequisites: known ids, types and statuses; a "done" decision is written in HANDOFF.md, where agents read it
const P = prerequisites(), PR = new Map()
const handoff = existsSync(join(dir, 'HANDOFF.md')) ? readFileSync(join(dir, 'HANDOFF.md'), 'utf8').split(/\r?\n/) : []
const cites = (l, id) => new RegExp(`(^|[^A-Za-z0-9])${id}([^A-Za-z0-9]|$)`).test(l)
for (const x of P || []) {
  if (PR.has(x.id)) errors.push(`prerequisite ${x.id}: duplicate id`)
  if (T.has(x.id)) errors.push(`prerequisite ${x.id}: id already taken by a task`)
  if (!TYPES.includes(x.type)) errors.push(`prerequisite ${x.id}: unknown type "${x.type}" (decision, manual or environment)`)
  if (!PREREQ_STATUSES.includes(x.status)) errors.push(`prerequisite ${x.id}: unknown status "${x.status}" (open, done or dropped)`)
  if (x.type === 'decision' && x.status === 'done' && !handoff.some(l => /^\s*(?:[-*]\s*)?decision\s*·/i.test(l) && cites(l, x.id))) errors.push(`prerequisite ${x.id}: decision marked "done" without a "decision" entry citing it in HANDOFF.md`)
  PR.set(x.id, x)
}
for (const t of T.values()) for (const id of arr(t.prerequisites)) if (!PR.has(id)) errors.push(`${t.id}: unknown prerequisite ${id}${P ? '' : ' (no PREREQUISITES.md)'}`)
const open = t => arr(t.prerequisites).filter(id => PR.has(id) && PR.get(id).status === 'open')
// Ready to run, phase by phase: a task waits for its open prerequisites, or for a task of its phase that waits;
// a phase waits for the end of the previous one if a task waits there
const remaining = t => !done(st[t.id] || 'todo')
const ready = []
let blockedPhase = null
for (const ph of [...new Set([...T.values()].filter(remaining).map(t => t.phase))].sort((a, b) => a - b)) {
  const ts = [...T.values()].filter(t => t.phase === ph && remaining(t))
  const waits = new Map(ts.filter(t => open(t).length || st[t.id] === 'needs-human').map(t => [t.id, [...(st[t.id] === 'needs-human' ? ['needs-human'] : []), ...open(t)]]))
  for (let changed = true; changed;) {
    changed = false
    for (const t of ts) if (!waits.has(t.id)) { const d = arr(t.depends_on).filter(x => waits.has(x)); if (d.length) { waits.set(t.id, d); changed = true } }
  }
  ready.push({ phase: ph, after_phase: blockedPhase, tasks: ts.length, waiting: [...waits].map(([id, a]) => ({ id, waiting_on: a })) })
  if (waits.size && blockedPhase == null) blockedPhase = ph
}

const tasks = [...T.values()].filter(t => phaseF == null || t.phase === phaseF).map(t => ({
  id: t.id, title: t.title || '', file: t.file, phase: t.phase, ...(fmText(t.model) ? { model: fmText(t.model) } : {}), ...(fmText(t.model_reason) ? { model_reason: fmText(t.model_reason) } : {}), effort: t.effort || '',
  depends_on: arr(t.depends_on), resources: arr(t.resources), status: st[t.id] || 'todo',
  verification: arr(t.verification), token_estimate: tokens(t.token_estimate), open_prerequisites: open(t),
}))
// All tasks, whatever the requested phase: the orchestrator checks the tasks named by an auto-decision
const all = [...T.values()].map(t => ({ id: t.id, phase: t.phase, status: st[t.id] || 'todo' }))
const maxPhase = Math.max(0, ...[...T.values()].map(t => t.phase || 0))
const blocks = id => [...T.values()].filter(t => remaining(t) && arr(t.prerequisites).includes(id)).map(t => t.id)
const prereqs = [...PR.values()].map(x => ({ ...x, blocks: blocks(x.id) }))
// A deferred decision that no remaining task cites would block nothing: an agent would settle it instead of the human
for (const x of prereqs) if (x.type === 'decision' && x.status === 'open' && !x.blocks.length) errors.push(`prerequisite ${x.id}: open decision that no remaining task cites in "prerequisites" (add it to the tasks it affects, or set it to "dropped")`)
const orphans = prereqs.filter(x => x.type !== 'decision' && x.status === 'open' && !x.blocks.length)

// Verification commands of remaining tasks: compound, they would be refused to an agent isolated in a worktree
const refusable = "an agent isolated in a worktree will be refused it (Claude Code's isolation guard): make it a simple command, or a project script"
// With --phase, only the tasks of the phase: the plan reader needs only them, and the output stays short (0.8.1)
for (const t of T.values()) if (!done(st[t.id] || 'todo') && (phaseF == null || t.phase === phaseF)) for (const c of arr(t.verification)) {
  const r = compound(c)
  if (r.length) warnings.push(`${t.id}: verification \`${short(c)}\` (${r.join(', ')}): ${refusable}`)
}
// Model and reason of remaining tasks: /orchestre:prepare writes them; an older plan still runs
for (const t of T.values()) if (!done(st[t.id] || 'todo') && (phaseF == null || t.phase === phaseF)) {
  if (modelState(t.model) === 'absent') warnings.push(`${t.id}: no model (${MODELS.slice(0, 3).join(', ')}): the worker will run on sonnet, and its fixes will follow the escalation ladder`)
  else if (modelState(t.model) === 'valid' && !fmText(t.model_reason)) warnings.push(`${t.id}: model ${fmText(t.model)} without model_reason (one line that justifies the choice)`)
}
// orchestre.config.json: environment setup (shape, simple commands, resources declared by a task), fable, language
let config = null
if (existsSync(join(dir, 'orchestre.config.json'))) {
  try { config = JSON.parse(readFileSync(join(dir, 'orchestre.config.json'), 'utf8')) } catch (e) { errors.push(`orchestre.config.json unreadable: ${e.message}`) }
}
if (config && typeof config === 'object') for (const k of Object.keys(config)) if (Object.hasOwn(FRENCH_CONFIG_KEYS, k)) errors.push(`orchestre.config.json: French key "${k}" of orchestre 0.11 and earlier: rename it "${FRENCH_CONFIG_KEYS[k]}"`)
const isList = x => Array.isArray(x) && x.every(c => typeof c === 'string' && c.trim())
if (config && config.setup !== undefined) {
  if (!isList(config.setup)) errors.push('orchestre.config.json: "setup" must be a list of commands')
  else for (const c of config.setup) { const r = compound(c); if (r.length) warnings.push(`setup: \`${short(c)}\` (${r.join(', ')}): ${refusable}`) }
}
if (config && config.shared_setup !== undefined) {
  const sp = config.shared_setup
  if (!sp || typeof sp !== 'object' || Array.isArray(sp) || !Object.values(sp).every(isList)) errors.push('orchestre.config.json: "shared_setup" must map each resource to a list of commands')
  else for (const [res, cs] of Object.entries(sp)) {
    if (![...T.values()].some(t => arr(t.resources).includes(res))) warnings.push(`shared_setup: no task declares the resource "${res}"; its commands will never run`)
    for (const c of cs) { const r = compound(c); if (r.length) warnings.push(`shared_setup (${res}): \`${short(c)}\` (${r.join(', ')}): ${refusable}`) }
  }
}
// Run mode and evaluator: English values only ("devia" and "systematique" of 0.11 are converted by migrate.mjs)
if (config && config.default_mode !== undefined && !['auto', 'deviation', 'phase'].includes(config.default_mode)) errors.push(`orchestre.config.json: "default_mode" must be auto, deviation or phase, not ${JSON.stringify(config.default_mode)}`)
if (config && config.evaluator !== undefined && config.evaluator !== 'always') warnings.push(`orchestre.config.json: "evaluator" is indicative and only takes "always" (the evaluation is always systematic), not ${JSON.stringify(config.evaluator)}`)
// Fable: allowed only if the user said so (fable: true). With fable: false, a remaining task on fable or an escalation
// that contains it blocks, across the whole plan; without the setting (older plan), a warning makes the user decide
const fable = config && config.fable !== undefined ? config.fable : null
if (fable !== null && typeof fable !== 'boolean') errors.push('orchestre.config.json: "fable" must be true or false')
else if (fable !== true) {
  const onFable = [...T.values()].filter(t => !done(st[t.id] || 'todo') && fmText(t.model) === 'fable')
  const escFable = !!config && Array.isArray(config.escalation) && config.escalation.includes('fable')
  if (fable === false) {
    for (const t of onFable) errors.push(`${t.id}: model fable, refused by orchestre.config.json (fable: false): move the task to opus, or set fable: true if the user wants it`)
    if (escFable) errors.push('orchestre.config.json: "escalation" contains fable, refused by fable: false')
  } else {
    for (const t of onFable.filter(t => phaseF == null || t.phase === phaseF)) warnings.push(`${t.id}: model fable, without a "fable" setting in orchestre.config.json: to settle with the user (/orchestre:ready)`)
    if (escFable) warnings.push('orchestre.config.json: "escalation" contains fable, without a "fable" setting: to settle with the user (/orchestre:ready)')
  }
}
// Language of the free text written during a run (HANDOFF, DISCOVERY, reports); keys, statuses and titles stay in English
const language = config && config.language !== undefined ? config.language : 'en'
if (typeof language !== 'string' || !language.trim()) errors.push('orchestre.config.json: "language" must be a non-empty text, like "en" or "fr"')
const readyShown = ready.filter(p => phaseF == null || p.phase === phaseF)
// JSON on one line: read by scripts and agents, it thus stays under the Bash tool's display thresholds longer (0.8.1)
if (asJson) console.log(JSON.stringify({ ok: errors.length === 0, errors, warnings, tasks, all, max_phase: maxPhase, prerequisites: prereqs, ready: readyShown, fable: typeof fable === 'boolean' ? fable : null, language: typeof language === 'string' && language.trim() ? language.trim() : 'en' }))
else {
  if (errors.length) console.log(errors.map(e => '✗ ' + e).join('\n'))
  else {
    const byPhase = {}
    for (const t of tasks) if (!done(t.status)) byPhase[t.phase] = (byPhase[t.phase] || 0) + t.token_estimate
    const fmt = n => n.toFixed(1) + 'M'
    console.log(`✓ valid plan: ${T.size} task${T.size > 1 ? 's' : ''}. Remaining, in estimated tokens: ` +
      Object.entries(byPhase).map(([p, n]) => `phase ${p} ${fmt(n)}`).join(' · ') +
      ` · total ${fmt(Object.values(byPhase).reduce((a, b) => a + b, 0))}`)
    if (!P) console.log('ℹ no PREREQUISITES.md: no prerequisite declared (see /orchestre:ready)')
    for (const x of orphans) console.log(`⚠ prerequisite ${x.id} (${x.type}) open, but no remaining task cites it`)
    const openShown = prereqs.filter(x => x.status === 'open' && x.blocks.length)
    if (openShown.length) console.log('Open prerequisites: ' + openShown.map(x => `${x.id} (${x.type}) → ${x.blocks.join(', ')}`).join(' · '))
    if (P || openShown.length) {
      console.log('Ready to run:')
      for (const p of readyShown) {
        const what = [
          ...(p.after_phase != null ? [`waits for the end of phase ${p.after_phase}`] : []),
          ...(p.waiting.length === p.tasks ? ['no task can start'] : []),
          ...p.waiting.map(e => `${e.id} waits for ${e.waiting_on.join(', ')}`),
        ]
        console.log(`- phase ${p.phase}: ${what.length ? what.join('; ') : 'ready'}`)
      }
    }
  }
}
if (!asJson) for (const a of warnings) console.log('⚠ ' + a)
// No process.exit() here: in a pipe, it would cut the output at 64 KB (the JSON of a big plan, 0.8.1)
process.exitCode = errors.length ? 1 : 0
