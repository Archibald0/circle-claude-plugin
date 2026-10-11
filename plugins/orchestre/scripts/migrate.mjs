#!/usr/bin/env node
// migrate (orchestre plugin 0.12.0): converts, once, a plan written in the French format of orchestre 0.11 and earlier to the
// English format of 0.12. Node 18 or later, no dependencies besides progress.mjs, next to it.
//
// Usage: node <plugin root>/scripts/migrate.mjs [<plan-dir>] [--write] [--run-stopped]
//   Without --write: a preview of the changes, nothing is written. Without a folder: the only plan in plans/.
//   --write: refuses if the plan folder has uncommitted changes, migrates, then commits the plan folder alone
//            ("orchestre: migrate plan <name> to the 0.12 format"), on the current branch (a note says so when it is not the
//            integration branch). If writing fails, the plan folder is restored as it was.
//   --run-stopped: the user confirms that the run marked "en-cours" in suivi.json is stopped (session closed without a run end).
// To run from the main checkout, where suivi.json lives. Idempotent: what is already in the 0.12 format is left as is; files of
// the French format left next to tasks/ (suivi.json of another clone that pulled the migration, for one) are converted.
//
// What changes (glossary 0.12.0, sections 3 to 8); free text is kept as written:
//   taches/ → tasks/ : frontmatter keys, section titles of the body, branch names tache/<id> of the plan's tasks; files other
//                      than .md are moved untouched;
//   SUIVI.md → PROGRESS.md : title, table header, statuses, token cells, legend;
//   PREREQUIS.md → PREREQUISITES.md : title, table header, types, statuses, legend, "Checked by /orchestre:ready" line;
//   HANDOFF.md : "Entries:" line, type and severity of each entry, "## source plan";
//   DISCOVERY.md : section titles;
//   orchestre.config.json : keys, default_mode "devia", evaluator "systematique"; "language": "fr" added if missing when
//                           taches/ is migrated, since the free text of the plan is in French;
//   suivi.json → progress.json (outside git): orchestre-suivi/2 or /1 → orchestre-progress/3, and the git exclusions.
// Git history is never rewritten: branches tache/* and commits "tâche <id> : " stay, and the 0.12 scripts read them.
// Exit codes: 0 done, or nothing to do; 1 refused or failed (plan folder as it was), or commit failed (files migrated and
// staged, not committed); 2 invalid call.
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, lstatSync, realpathSync, mkdirSync, copyFileSync, rmSync, unlinkSync } from 'node:fs'
import { join, resolve, relative, basename, isAbsolute, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LEGACY, LEGACY_FORMATS, FORMAT, convertLegacy, conversionNote, validate, now, truncate, excludeFromGit } from './progress.mjs'

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
const RE_ID = /^[A-Z]+[0-9]+[A-Z]*$/
class UsageError extends Error { constructor(m) { super(m); this.code = 2 } }
class Refusal extends Error { constructor(m) { super(m); this.code = 1 } }
const attempt = f => { try { return f() } catch { return null } }
const git = (args, cwd) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const real = p => attempt(() => realpathSync(p)) || resolve(p)
const readOrNull = f => attempt(() => readFileSync(f, 'utf8'))
const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`
// A key of the map itself, never of Object.prototype ("constructor")
const own = (map, k) => (typeof k === 'string' && Object.hasOwn(map, k) ? map[k] : undefined)
// Lookup that ignores case and accents: "Geste", "décision", "Decision"
const fold = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ')
const lookup = (map, x) => { const k = Object.keys(map).find(k => fold(k) === fold(x)); return k === undefined ? null : map[k] }
const width = s => [...s].length
// Line by line, the line without its "\r", given back with it (CRLF files)
const mapLines = (text, fn) => text.split('\n').map((l, i, all) => { const cr = l.endsWith('\r') ? '\r' : ''; return fn(cr ? l.slice(0, -1) : l, i, all) + cr }).join('\n')
// Test hook: makes the write fail after the named step, to check that the plan folder is restored
const FAIL_AFTER = process.env.ORCHESTRE_MIGRATE_FAIL_AFTER || null
const failPoint = step => { if (FAIL_AFTER === step) throw new Error(`test failure after ${step}`) }

// ─── Markdown tables ─────────────────────────────────────────────────────────────────────────────────────────────
const cells = line => {
  const l = line.trim(), p = l.split(/(?<!\\)\|/)
  if (p.length && p[0].trim() === '') p.shift()
  if (/(?<!\\)\|$/.test(l)) p.pop()
  return p.map(c => c.trim().replace(/\\\|/g, '|'))
}
const escapeCell = s => String(s).replace(/\|/g, '\\|')
const isSeparator = row => row.length > 0 && row.every(x => /^:?-+:?$/.test(x))
// The table whose header contains ID and the status column: its lines, its rows (separator apart), and the header
function findTable(lines, statusHeader) {
  const net = l => l.replace(/\r$/, '')
  const h = lines.findIndex(l => net(l).trim().startsWith('|') && cells(net(l)).includes('ID') && cells(net(l)).some(c => fold(c) === fold(statusHeader)))
  if (h < 0) return null
  let end = h
  while (end + 1 < lines.length && net(lines[end + 1]).trim().startsWith('|')) end++
  return { h, end, header: cells(net(lines[h])), crlf: lines[h].endsWith('\r'), indent: net(lines[h]).match(/^\s*/)[0] }
}
// Rewrites a table aligned, in the style of its separator (spaced or compact, alignment colons kept)
function formatTable(header, sep, rows, { indent, crlf }) {
  // A row longer than the header keeps its extra cells
  const cols = Array.from({ length: Math.max(header.length, ...rows.map(r => r.length)) }, (_, j) => j)
  const head = cols.map(j => escapeCell(header[j] ?? '')), body = rows.map(r => cols.map(j => escapeCell(r[j] ?? '')))
  const widths = head.map((c, j) => Math.max(3, width(c), ...body.map(r => width(r[j]))))
  const pad = (c, j) => c + ' '.repeat(widths[j] - width(c))
  const sepCells = sep ? cells(sep) : [], spaced = sep ? /^\s*\|\s/.test(sep) : false
  const dashes = (j, w) => { const a = sepCells[j] || '', l = a.startsWith(':'), r = a.length > 1 && a.endsWith(':'); return (l ? ':' : '-') + '-'.repeat(Math.max(0, w - 2)) + (r ? ':' : '-') }
  const eol = crlf ? '\r' : ''
  return [
    indent + '| ' + head.map(pad).join(' | ') + ' |' + eol,
    indent + (spaced ? '| ' + widths.map((w, j) => dashes(j, w)).join(' | ') + ' |' : '|' + widths.map((w, j) => dashes(j, w + 2)).join('|') + '|') + eol,
    ...body.map(r => indent + '| ' + r.map(pad).join(' | ') + ' |' + eol),
  ]
}
// "1,0 M" → "1.0M", "0.3 M" → "0.3M"; "voir /workflows" → "see /workflows"
const tokens = s => String(s).replace(/(\d+),(\d+)\s*M\b/g, '$1.$2M').replace(/(\d+(?:\.\d+)?)\s+M\b/g, '$1M').replace(/voir \/workflows/g, 'see /workflows')

// ─── Conversions, pure: (text, counts) → new text ────────────────────────────────────────────────────────────────
// ids: the ids of the plan's tasks, whose branch names tache/<id> become task/<id> (the workflow of 0.12 creates task/<id>)
export function convertTask(text, n, ids = null) {
  const m = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/)
  let head = '', body = text
  if (m) {
    const fm = m[2].split('\n').map(line => {
      const kv = line.match(/^([a-z_]+):/), key = kv && own(LEGACY.taskKeys, kv[1])
      if (!key) return line
      n.keys++
      const rest = line.slice(kv[1].length)
      return key + (key === 'token_estimate' ? tokens(rest) : rest)
    }).join('\n')
    head = m[1] + fm + m[3]
    body = text.slice(m[0].length)
  }
  body = body.replace(/^(#{1,6}[ \t]+)(.+?)([ \t]*)(\r?)$/gm, (all, h, title, sp, cr) => { const t = own(LEGACY.taskSections, title.trim()); if (!t) return all; n.sections++; return h + t + sp + cr })
  return (head + body).replace(/\btache\/([A-Z]+[0-9]+[A-Z]*)\b/g, (all, id) => { if (ids && !ids.has(id)) return all; n.branches++; return `task/${id}` })
}

export function convertProgress(text, n) {
  const lines = text.split('\n')
  const tb = findTable(lines, 'Statut')
  if (tb) {
    const net = l => l.replace(/\r$/, '')
    const header = tb.header.map(c => lookup(LEGACY.progressColumns, c) ?? c)
    n.headers += header.filter((c, j) => c !== tb.header[j]).length
    const iSt = header.indexOf('Status'), iTok = header.findIndex(c => fold(c).startsWith('tokens')), iId = header.indexOf('ID')
    let sep = null
    const rows = []
    const convertRow = row => {
      const st = own(LEGACY.status, row[iSt])
      if (st) { row[iSt] = st; n.statuses++ }
      if (iTok >= 0 && row[iTok] !== undefined) { const t = tokens(row[iTok]); if (t !== row[iTok]) n.tokens++; row[iTok] = t }
      return row
    }
    for (let i = tb.h + 1; i <= tb.end; i++) {
      const row = cells(net(lines[i]))
      if (i === tb.h + 1 && isSeparator(row)) { sep = net(lines[i]); continue }
      rows.push(convertRow(row))
    }
    // Task rows written under the legend by a scribe of 0.6.3: converted in place
    for (let i = tb.end + 1; i < lines.length; i++) {
      if (!net(lines[i]).trim().startsWith('|')) continue
      const row = cells(net(lines[i]))
      if (row.length >= header.length && RE_ID.test(row[iId] || '') && own(LEGACY.status, row[iSt])) {
        lines[i] = tb.indent + '| ' + convertRow(row).map(escapeCell).join(' | ') + ' |' + (lines[i].endsWith('\r') ? '\r' : '')
      }
    }
    lines.splice(tb.h, tb.end - tb.h + 1, ...formatTable(header, sep, rows, tb))
  }
  return mapLines(lines.join('\n'), l => {
    if (/^#\s+SUIVI\b/.test(l)) { n.title++; return l.replace(/^(#\s+)SUIVI\b/, '$1PROGRESS') }
    const lg = l.match(/^Statuts\s*:\s*(.*)$/)
    if (lg) { n.legend++; return 'Statuses: ' + lg[1].split(/\s*·\s*/).map(s => own(LEGACY.status, s) ?? own(LEGACY.step, s) ?? s).join(' · ') }
    return l
  })
}

export function convertPrerequisites(text, n) {
  const lines = text.split('\n')
  const tb = findTable(lines, 'Statut')
  if (tb) {
    const net = l => l.replace(/\r$/, '')
    const header = tb.header.map(c => lookup(LEGACY.prerequisiteColumns, c) ?? c)
    n.headers += header.filter((c, j) => c !== tb.header[j]).length
    const iType = header.indexOf('Type'), iSt = header.indexOf('Status')
    let sep = null
    const rows = []
    for (let i = tb.h + 1; i <= tb.end; i++) {
      const row = cells(net(lines[i]))
      if (i === tb.h + 1 && isSeparator(row)) { sep = net(lines[i]); continue }
      const type = lookup(LEGACY.prerequisiteType, row[iType]), st = lookup(LEGACY.prerequisiteStatus, row[iSt])
      if (type) { row[iType] = type; n.types++ }
      if (st) { row[iSt] = st; n.statuses++ }
      rows.push(row)
    }
    lines.splice(tb.h, tb.end - tb.h + 1, ...formatTable(header, sep, rows, tb))
  }
  return mapLines(lines.join('\n'), l => {
    if (/^#\s+PREREQUIS\b/.test(l)) { n.title++; return l.replace(/^(#\s+)PREREQUIS\b/, '$1PREREQUISITES') }
    if (/^Types\s*:/.test(l)) {
      n.legend++
      return l.replace(/^Types\s*:/, 'Types:').replace(/Statuts\s*:/, 'Statuses:')
        .replace(/[\p{L}-]+/gu, w => lookup(LEGACY.prerequisiteType, w) ?? lookup(LEGACY.prerequisiteStatus, w) ?? w)
    }
    const v = l.match(/^Vérifié par \/orchestre:pret le (.+?)\s*:\s*(.*)$/)
    if (v) { n.checked++; return `Checked by /orchestre:ready on ${v[1]}: ${v[2]}` }
    return l
  })
}

export function convertHandoff(text, n) {
  return mapLines(text, l => {
    if (/^Entrées\s*:/.test(l)) {
      n.entriesLine++
      return l.replace(/^Entrées\s*:/, 'Entries:').replace(/`([^`]+)`/g, (all, w) => { const t = own(LEGACY.handoffType, w) ?? own(LEGACY.severity, w); return t ? `\`${t}\`` : all })
        .replace(/,\s*classées\s+/, ', rated ').replace(/\s+ou\s+`/, ' or `')
    }
    if (/^##\s+plan source\s*$/.test(l)) { n.sections++; return l.replace('plan source', 'source plan') }
    const e = l.match(/^(\s*(?:[-*]\s*)?)([\p{L}][\p{L}-]*)(\s*·\s*)(mineur|majeur)(\s*·)/iu)
    if (e) {
      n.entries++
      return e[1] + (own(LEGACY.handoffType, e[2].toLowerCase()) ?? e[2]) + e[3] + own(LEGACY.severity, e[4].toLowerCase()) + e[5] + l.slice(e[0].length)
    }
    // An entry without a severity, as 0.11 plan-lint accepted for a decision ("décision · D2 : …"): its type only, if known
    const t = l.match(/^(\s*(?:[-*]\s*)?)([\p{L}][\p{L}-]*)(\s*·)/u), type = t && own(LEGACY.handoffType, t[2].toLowerCase())
    if (type && type !== t[2]) { n.entries++; return t[1] + type + t[3] + l.slice(t[0].length) }
    return l
  })
}

export function convertDiscovery(text, n) {
  return text.replace(/^(##[ \t]+)(.+?)([ \t]*)(\r?)$/gm, (all, h, title, sp, cr) => { const t = own(LEGACY.discoverySections, title.trim()); if (!t) return all; n.sections++; return h + t + sp + cr })
}

// French keys and values → English; "language": "fr" added only when asked (when taches/ is migrated)
export function convertConfig(cfg, n, { addLanguage = true } = {}) {
  const out = {}
  for (const [k, v] of Object.entries(cfg)) {
    const key = own(LEGACY.configKeys, k) ?? k
    if (key !== k) n.keys++
    let value = v
    const mode = own(LEGACY.mode, v), evaluator = own(LEGACY.evaluator, v)
    if (key === 'default_mode' && mode && mode !== v) { value = mode; n.values.push(`default_mode "${v}" → "${value}"`) }
    if (key === 'evaluator' && evaluator) { value = evaluator; n.values.push(`evaluator "${v}" → "${value}"`) }
    out[key] = value
  }
  if (addLanguage && out.language === undefined) { out.language = 'fr'; n.language = true }
  return out
}

// ─── Plan ───────────────────────────────────────────────────────────────────────────────────────────────────────
function locate(arg) {
  const here = attempt(() => git(['rev-parse', '--show-toplevel'], process.cwd()).trim())
  if (!here) throw new UsageError('not in a git repository')
  // The main checkout: suivi.json and progress.json live there, outside git; a linked worktree has none
  const main = real((attempt(() => git(['worktree', 'list', '--porcelain'], here)) || '').match(/^worktree (.+)$/m)?.[1] || here)
  if (real(here) !== main) throw new Refusal(`run migrate from the main checkout (${main}), where the progress file of the plan lives, not from a linked worktree`)
  const isPlan = d => existsSync(join(d, 'tasks')) || existsSync(join(d, 'taches'))
  let dir
  if (arg) {
    dir = resolve(process.cwd(), arg)
    if (!isPlan(dir)) throw new UsageError(`plan not found: ${arg}`)
  } else {
    const p = join(main, 'plans')
    const plans = existsSync(p) ? readdirSync(p).filter(x => isPlan(join(p, x))).sort() : []
    if (!plans.length) throw new UsageError('no plan in plans/; give its folder: plans/<name>')
    if (plans.length > 1) throw new UsageError(`several plans (${plans.map(x => 'plans/' + x).join(', ')}); say which`)
    dir = join(p, plans[0])
  }
  const rel = relative(main, real(dir))
  if (rel.startsWith('..') || isAbsolute(rel)) throw new UsageError(`the plan must be inside the repository: ${arg}`)
  const cfg = attempt(() => JSON.parse(readFileSync(join(dir, 'orchestre.config.json'), 'utf8'))) || {}
  const name = basename(real(dir))
  return { root: main, dir: real(dir), rel: rel.split(sep).join('/') || '.', name, integration: cfg.integration_branch || cfg.branche_integration || `plan/${name}` }
}

// The changes, computed in memory: files to write ({ to, text } or { to, copy }), paths to remove, and the progress file
function plan(ctx) {
  const { dir } = ctx, has = f => existsSync(join(dir, f))
  const changes = [], removals = [], summary = []
  const fromTaches = has('taches')
  if (fromTaches) {
    if (has('tasks')) throw new Refusal(`${ctx.rel}: both taches/ and tasks/ exist: migration stopped halfway? Move the files by hand`)
    const entries = readdirSync(join(dir, 'taches')).sort()
    for (const f of entries) {
      const st = lstatSync(join(dir, 'taches', f))
      if (st.isSymbolicLink()) throw new Refusal(`taches/${f}: a symbolic link, migrate does not follow it; replace it by the file, or move it by hand`)
      if (!st.isFile()) throw new Refusal(`taches/${f}: a folder inside taches/, unexpected; move it by hand`)
    }
    const texts = new Map(entries.filter(f => f.endsWith('.md')).map(f => [f, readFileSync(join(dir, 'taches', f), 'utf8')]))
    const ids = new Set([...texts.values()].map(t => ((t.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '').match(/^id:\s*["']?([A-Z]+[0-9]+[A-Z]*)/m)?.[1]).filter(Boolean))
    const tn = { keys: 0, sections: 0, branches: 0 }
    for (const f of entries) changes.push(texts.has(f) ? { to: `tasks/${f}`, text: convertTask(texts.get(f), tn, ids) } : { to: `tasks/${f}`, copy: `taches/${f}` })
    removals.push('taches')
    const other = entries.length - texts.size
    summary.push(`taches/ → tasks/: ${plural(texts.size, 'task file')} (${plural(tn.keys, 'frontmatter key')}, ${plural(tn.sections, 'section title')}, ${plural(tn.branches, 'branch name')})${other ? `, ${plural(other, 'other file')} moved as is` : ''}`)
  }
  // A file to convert; a renamed one is refused when its new name exists too. An unchanged file is no change.
  const file = (from, to, convert, describe) => {
    const text = readOrNull(join(dir, from))
    if (text == null) return
    if (to !== from && has(to)) throw new Refusal(`${from} and ${to} both exist: migration stopped halfway? Merge them by hand`)
    const n = { headers: 0, statuses: 0, tokens: 0, legend: 0, title: 0, types: 0, checked: 0, entriesLine: 0, entries: 0, sections: 0 }
    const out = convert(text, n)
    if (to === from && out === text) return
    changes.push({ to, text: out })
    if (to !== from) removals.push(from)
    summary.push(`${from}${to !== from ? ` → ${to}` : ''}: ${describe(n)}`)
  }
  file('SUIVI.md', 'PROGRESS.md', convertProgress, n => `${plural(n.headers, 'column title')}, ${plural(n.statuses, 'status', 'statuses')}, ${plural(n.tokens, 'token cell')}${n.legend ? ', legend' : ''}${n.title ? ', title' : ''}`)
  file('PREREQUIS.md', 'PREREQUISITES.md', convertPrerequisites, n => `${plural(n.headers, 'column title')}, ${plural(n.types, 'type')}, ${plural(n.statuses, 'status', 'statuses')}${n.legend ? ', legend' : ''}${n.checked ? ', "Checked by" line' : ''}${n.title ? ', title' : ''}`)
  file('HANDOFF.md', 'HANDOFF.md', convertHandoff, n => `${plural(n.entries, 'entry', 'entries')}${n.entriesLine ? ', "Entries:" line' : ''}${n.sections ? ', "## source plan"' : ''}`)
  file('DISCOVERY.md', 'DISCOVERY.md', convertDiscovery, n => plural(n.sections, 'section title'))
  // orchestre.config.json: with taches/, created with "language": "fr" if missing; afterwards, only its French keys and values
  const cfgText = readOrNull(join(dir, 'orchestre.config.json'))
  let cfg = {}
  if (cfgText != null) {
    try { cfg = JSON.parse(cfgText) } catch (e) { throw new Refusal(`orchestre.config.json unreadable (${e.message}): fix it, then run migrate again`) }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Refusal('orchestre.config.json: a JSON object is expected')
  }
  const cn = { keys: 0, values: [], language: false }
  const cfgOut = convertConfig(cfg, cn, { addLanguage: fromTaches })
  if (cn.keys || cn.values.length || cn.language) {
    changes.push({ to: 'orchestre.config.json', text: JSON.stringify(cfgOut, null, 2) + '\n' })
    summary.push(`orchestre.config.json${cfgText == null ? ' (created)' : ''}: ${plural(cn.keys, 'key')}${cn.values.map(v => ', ' + v).join('')}${cn.language ? ', "language": "fr" added' : ''}`)
  }
  // suivi.json (outside git) → progress.json
  let progress = null
  const sv = readOrNull(join(dir, 'suivi.json'))
  if (sv != null) {
    if (has('progress.json')) throw new Refusal('suivi.json and progress.json both exist: delete the one that is out of date')
    let doc
    try { doc = JSON.parse(sv) } catch (e) { throw new Refusal(`suivi.json unreadable (${e.message}): delete it, it will be rebuilt from PROGRESS.md, HANDOFF.md and plan-lint; then run migrate again`) }
    if (!doc || !LEGACY_FORMATS.includes(doc.format)) throw new Refusal(`suivi.json is in format ${doc && doc.format}, migrate reads ${LEGACY_FORMATS.join(' and ')}: delete it, it will be rebuilt; then run migrate again`)
    const running = (Array.isArray(doc.runs) ? doc.runs : []).filter(r => r && r.statut === 'en-cours').pop()
    progress = { doc, running, from: doc.format }
    summary.push(`suivi.json → progress.json (outside git): ${doc.format} → ${FORMAT}${running ? `, run ${running.numero} still "en-cours"` : ''}`)
  }
  return { changes, removals, summary, progress, fromTaches }
}

function convertProgressFile(p) {
  const at = now(), doc = convertLegacy(p.doc)
  doc.log.push({ at, kind: 'run', task: null, text: conversionNote(p.from, 'migrate.mjs') })
  truncate(doc)
  const err = validate(doc)
  if (err.length) throw new Refusal(`suivi.json does not convert into a valid progress.json:\n${err.slice(0, 8).map(e => '  - ' + e).join('\n')}\nDelete suivi.json, it will be rebuilt from PROGRESS.md, HANDOFF.md and plan-lint; then run migrate again`)
  return JSON.stringify(doc, null, 2) + '\n'
}

// Writes the changes: the new files first, then the removals; on a failure, the plan folder is restored from git (it was clean)
function apply(ctx, P, progressText) {
  const { dir } = ctx
  let progressWritten = false
  try {
    if (P.fromTaches) mkdirSync(join(dir, 'tasks'))
    for (const c of P.changes) {
      const target = join(dir, c.to)
      if (c.copy) copyFileSync(join(dir, c.copy), target)
      else { const tmp = `${target}.migrate.${process.pid}.tmp`; writeFileSync(tmp, c.text); renameSync(tmp, target) }
      failPoint(c.to)
    }
    excludeFromGit(ctx.root, ctx.rel)
    if (progressText != null) { writeFileSync(join(dir, 'progress.json'), progressText); progressWritten = true; failPoint('progress.json') }
    for (const r of P.removals) { rmSync(join(dir, r), { recursive: true }); failPoint(`remove ${r}`) }
    if (progressText != null) unlinkSync(join(dir, 'suivi.json'))
  } catch (e) {
    const restored = attempt(() => { git(['checkout', '-q', 'HEAD', '--', ctx.rel], ctx.root); git(['clean', '-fdq', '--', ctx.rel], ctx.root); return true })
    for (const f of readdirSync(dir).filter(f => /\.migrate\.\d+\.tmp$/.test(f))) attempt(() => unlinkSync(join(dir, f)))
    if (progressWritten && existsSync(join(dir, 'suivi.json'))) attempt(() => unlinkSync(join(dir, 'progress.json')))
    throw new Refusal(restored
      ? `migration failed (${e.message}): the plan folder is restored as it was, nothing is migrated`
      : `migration failed (${e.message}), and the plan folder could not be restored: look at git status ${ctx.rel}, then git checkout HEAD -- ${ctx.rel} and git clean -fd -- ${ctx.rel}`)
  }
}

export function migrate(arg, { write = false, runStopped = false } = {}) {
  const ctx = locate(arg)
  if (!existsSync(join(ctx.dir, 'taches')) && !existsSync(join(ctx.dir, 'tasks'))) throw new UsageError(`plan not found: ${arg}`)
  const P = plan(ctx)
  if (!P.changes.length && !P.removals.length && !P.progress) return { code: 0, text: `migrate ${ctx.rel}: already in the 0.12 format, nothing to migrate` }
  const head = P.fromTaches ? `migrate ${ctx.rel}: French format of orchestre 0.11 and earlier → 0.12` : `migrate ${ctx.rel}: files of the French format of 0.11 left next to tasks/ → 0.12`
  const branch = attempt(() => git(['symbolic-ref', '-q', '--short', 'HEAD'], ctx.root).trim()) || 'HEAD'
  const note = branch !== ctx.integration ? [`Note: the current branch is ${branch}, not the integration branch ${ctx.integration}; the migration commit goes on ${branch}.`] : []
  const lines = P.summary.map(s => '  ' + s)
  if (!write) return { code: 0, text: [`${head} (preview, nothing written)`, ...lines, ...note, 'Free text is kept as written; git history is not rewritten. Run again with --write to migrate and commit.'].join('\n') }

  // Checks before writing anything: a clean plan folder, no run in progress, a valid progress file
  const dirty = git(['status', '--porcelain', '--untracked-files=all', '--', ctx.rel], ctx.root).split('\n').filter(Boolean)
    .filter(l => !/(^|\/)(suivi\.json|\.suivi\.lock|\.suivi\.[^/]*\.tmp)$/.test(l.slice(3)))
  if (dirty.length) throw new Refusal(`${ctx.rel} has uncommitted changes (${dirty.slice(0, 3).map(l => l.slice(3)).join(', ')}${dirty.length > 3 ? ', …' : ''}): commit or discard them first, so that the migration commit holds the migration alone`)
  if (P.progress && P.progress.running && !runStopped) throw new Refusal(`suivi.json marks run ${P.progress.running.numero} "en-cours" since ${P.progress.running.debut}: migrate between two runs. If it is stopped, run again with --run-stopped.`)
  const progressText = P.progress ? convertProgressFile(P.progress) : null
  apply(ctx, P, progressText)

  // One commit, the plan folder alone (other staged changes stay staged)
  const message = `orchestre: migrate plan ${ctx.name} to the 0.12 format`
  try {
    git(['add', '-A', '--', ctx.rel], ctx.root)
    if (attempt(() => git(['diff', '--cached', '--quiet', '--', ctx.rel], ctx.root)) != null) return { code: 0, text: [`${head}: migrated, nothing to commit (outside git only)`, ...lines].join('\n') }
    git(['commit', '-q', '-m', message, '--', ctx.rel], ctx.root)
  } catch (e) {
    return { code: 1, text: [`${head}: files migrated and staged, but the commit failed (${String(e.stderr || e.message).trim().split('\n')[0]}): commit ${ctx.rel} by hand`, ...lines].join('\n') }
  }
  const hash = git(['rev-parse', '--short', 'HEAD'], ctx.root).trim()
  return { code: 0, text: [`${head}: migrated and committed (${hash} on ${branch}: "${message}")`, ...lines, ...note].join('\n') }
}

const launched = process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))
if (launched) {
  try {
    const argv = process.argv.slice(2)
    const unknown = argv.filter(a => a.startsWith('--') && !['--write', '--run-stopped'].includes(a))
    const args = argv.filter(a => !a.startsWith('--'))
    if (unknown.length || args.length > 1) throw new UsageError('usage: migrate.mjs [<plan-dir>] [--write] [--run-stopped]')
    const r = migrate(args[0], { write: argv.includes('--write'), runStopped: argv.includes('--run-stopped') })
    console.log(r.text)
    process.exitCode = r.code
  } catch (e) {
    if (e instanceof UsageError || e instanceof Refusal) { console.error(`migrate: ${e.message}`); process.exitCode = e.code } else { console.error(`migrate: unexpected error: ${(e && e.stack) || e}`); process.exitCode = 1 }
  }
}
