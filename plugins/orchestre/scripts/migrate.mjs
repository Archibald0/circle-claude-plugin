#!/usr/bin/env node
// migrate (orchestre plugin 0.12.0): converts, once, a plan written in the French format of orchestre 0.11 and earlier to the
// English format of 0.12. Node 18 or later, no dependencies besides progress.mjs, next to it.
//
// Usage: node <plugin root>/scripts/migrate.mjs [<plan-dir>] [--write] [--run-stopped]
//   Without --write: a preview of the changes, nothing is written. Without a folder: the only plan in plans/.
//   --write: refuses if the plan folder has uncommitted changes, migrates, then commits the plan folder alone
//            ("orchestre: migrate plan <name> to the 0.12 format"), on the current branch.
//   --run-stopped: the user confirms that the run marked "en-cours" in suivi.json is stopped (session closed without a run end).
// Idempotent: a plan already in the 0.12 format is left as is (code 0).
//
// What changes (glossary 0.12.0, sections 3 to 8); free text is kept as written:
//   taches/ → tasks/ : frontmatter keys, section titles of the body, branch names tache/<id>, key names quoted in the body;
//   SUIVI.md → PROGRESS.md : title, table header, statuses, token cells, legend;
//   PREREQUIS.md → PREREQUISITES.md : title, table header, types, statuses, legend, "Checked by /orchestre:ready" line;
//   HANDOFF.md : "Entries:" line, type and severity of each entry, "## source plan";
//   DISCOVERY.md : section titles;
//   orchestre.config.json : keys, default_mode "devia", evaluator "systematique"; "language": "fr" added if missing,
//                           since the free text of the plan is in French;
//   suivi.json → progress.json (outside git): orchestre-suivi/2 or /1 → orchestre-progress/3, and the git exclusions.
// Git history is never rewritten: branches tache/* and commits "tâche <id> : " stay, and the 0.12 scripts read them.
// Exit codes: 0 done, or nothing to do; 1 refused (nothing written), or commit failed (files migrated, not committed); 2 invalid call.
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, statSync, realpathSync } from 'node:fs'
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
// Lookup that ignores case and accents: "Geste", "décision", "Decision"
const fold = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ')
const lookup = (map, x) => { const k = Object.keys(map).find(k => fold(k) === fold(x)); return k === undefined ? null : map[k] }
const width = s => [...s].length

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
  const sepCells = sep ? cells(sep) : [], spaced = sep ? /^\s*\|\s/.test(sep) : true
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
const UNDERSCORE_KEYS = Object.keys(LEGACY.taskKeys).filter(k => k.includes('_'))
export function convertTask(text, n) {
  const m = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/)
  let head = '', body = text
  if (m) {
    const fm = m[2].split('\n').map(line => {
      const kv = line.match(/^([a-z_]+):/)
      if (!kv || !LEGACY.taskKeys[kv[1]]) return line
      n.keys++
      const key = LEGACY.taskKeys[kv[1]], rest = line.slice(kv[1].length)
      return key + (key === 'token_estimate' ? tokens(rest) : rest)
    }).join('\n')
    head = m[1] + fm + m[3]
    body = text.slice(m[0].length)
  }
  body = body.replace(/^(#{1,6}[ \t]+)(.+?)([ \t]*)$/gm, (all, h, title, sp) => { const t = LEGACY.taskSections[title.trim()]; if (!t) return all; n.sections++; return h + t + sp })
  // Key names quoted in the launch prompt ("ne modifie rien hors de fichiers_possedes"): format names, not prose
  body = body.replace(new RegExp(`\\b(${UNDERSCORE_KEYS.join('|')})\\b`, 'g'), k => { n.keyNames++; return LEGACY.taskKeys[k] })
  // Branch names: tache/<id> → task/<id> (the workflow of 0.12 creates task/<id>)
  const all = (head + body).replace(/\btache\/([A-Z]+[0-9]+[A-Z]*)\b/g, (_, id) => { n.branches++; return `task/${id}` })
  return all
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
      if (row[iSt] !== undefined && Object.hasOwn(LEGACY.status, row[iSt])) { row[iSt] = LEGACY.status[row[iSt]]; n.statuses++ }
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
      if (row.length >= header.length && RE_ID.test(row[iId] || '') && Object.hasOwn(LEGACY.status, row[iSt] || '')) {
        lines[i] = tb.indent + '| ' + convertRow(row).map(escapeCell).join(' | ') + ' |' + (lines[i].endsWith('\r') ? '\r' : '')
      }
    }
    lines.splice(tb.h, tb.end - tb.h + 1, ...formatTable(header, sep, rows, tb))
  }
  return lines.map(l => {
    if (/^#\s+SUIVI\b/.test(l)) { n.title++; return l.replace(/^(#\s+)SUIVI\b/, '$1PROGRESS') }
    const lg = l.match(/^Statuts\s*:\s*(.*?)(\r?)$/)
    if (lg) { n.legend++; return 'Statuses: ' + lg[1].split(/\s*·\s*/).map(s => LEGACY.status[s] ?? LEGACY.step[s] ?? s).join(' · ') + lg[2] }
    return l
  }).join('\n')
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
  return lines.map(l => {
    if (/^#\s+PREREQUIS\b/.test(l)) { n.title++; return l.replace(/^(#\s+)PREREQUIS\b/, '$1PREREQUISITES') }
    if (/^Types\s*:/.test(l)) {
      n.legend++
      return l.replace(/^Types\s*:/, 'Types:').replace(/Statuts\s*:/, 'Statuses:')
        .replace(/[\p{L}-]+/gu, w => lookup(LEGACY.prerequisiteType, w) ?? lookup(LEGACY.prerequisiteStatus, w) ?? w)
    }
    const v = l.match(/^Vérifié par \/orchestre:pret le (.+?) : (.*)$/)
    if (v) { n.checked++; return `Checked by /orchestre:ready on ${v[1]}: ${v[2]}` }
    return l
  }).join('\n')
}

export function convertHandoff(text, n) {
  return text.split('\n').map(l => {
    if (/^Entrées\s*:/.test(l)) {
      n.entriesLine++
      return l.replace(/^Entrées\s*:/, 'Entries:').replace(/`([^`]+)`/g, (all, w) => { const t = LEGACY.handoffType[w] ?? LEGACY.severity[w]; return t ? `\`${t}\`` : all })
        .replace(/,\s*classées\s+/, ', rated ').replace(/\s+ou\s+`/, ' or `')
    }
    if (/^##\s+plan source\s*$/.test(l)) { n.sections++; return l.replace('plan source', 'source plan') }
    const e = l.match(/^(\s*(?:[-*]\s*)?)([\p{L}][\p{L}-]*)(\s*·\s*)(mineur|majeur)(\s*·)/iu)
    if (e) {
      const type = LEGACY.handoffType[e[2].toLowerCase()] ?? e[2]
      n.entries++
      return e[1] + type + e[3] + LEGACY.severity[e[4].toLowerCase()] + e[5] + l.slice(e[0].length)
    }
    return l
  }).join('\n')
}

export function convertDiscovery(text, n) {
  return text.replace(/^(##[ \t]+)(.+?)([ \t]*)$/gm, (all, h, title, sp) => { const t = LEGACY.discoverySections[title.trim()]; if (!t) return all; n.sections++; return h + t + sp })
}

export function convertConfig(cfg, n) {
  const out = {}
  for (const [k, v] of Object.entries(cfg)) {
    const key = LEGACY.configKeys[k] ?? k
    if (key !== k) n.keys++
    let value = v
    if (key === 'default_mode' && typeof v === 'string' && LEGACY.mode[v] && LEGACY.mode[v] !== v) { value = LEGACY.mode[v]; n.values.push(`default_mode "${v}" → "${value}"`) }
    if (key === 'evaluator' && typeof v === 'string' && LEGACY.evaluator[v]) { value = LEGACY.evaluator[v]; n.values.push(`evaluator "${v}" → "${value}"`) }
    out[key] = value
  }
  if (out.language === undefined) { out.language = 'fr'; n.language = true }
  return out
}

// ─── Plan ───────────────────────────────────────────────────────────────────────────────────────────────────────
function locate(arg) {
  const root = attempt(() => git(['rev-parse', '--show-toplevel'], process.cwd()).trim())
  if (!root) throw new UsageError('not in a git repository')
  const isPlan = d => existsSync(join(d, 'tasks')) || existsSync(join(d, 'taches'))
  let dir
  if (arg) {
    dir = resolve(process.cwd(), arg)
    if (!isPlan(dir)) throw new UsageError(`plan not found: ${arg}`)
  } else {
    const p = join(root, 'plans')
    const plans = existsSync(p) ? readdirSync(p).filter(x => isPlan(join(p, x))).sort() : []
    if (!plans.length) throw new UsageError('no plan in plans/; give its folder: plans/<name>')
    if (plans.length > 1) throw new UsageError(`several plans (${plans.map(x => 'plans/' + x).join(', ')}); say which`)
    dir = join(p, plans[0])
  }
  const rel = relative(real(root), real(dir))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new UsageError(`the plan must be inside the repository: ${arg}`)
  return { root: real(root), dir: real(dir), rel: rel.split(sep).join('/'), name: basename(dir) }
}

// The changes, computed in memory: [{ from, to, text }] for the tracked files, and the progress file outside git
function plan(ctx) {
  const { dir } = ctx, changes = [], summary = []
  const tasksDir = join(dir, 'taches')
  const tn = { files: 0, keys: 0, sections: 0, keyNames: 0, branches: 0 }
  for (const f of readdirSync(tasksDir).sort()) {
    const p = join(tasksDir, f)
    if (!statSync(p).isFile()) throw new Refusal(`taches/${f}: a folder inside taches/, unexpected; move it by hand`)
    const text = readFileSync(p, 'utf8')
    changes.push({ from: `taches/${f}`, to: `tasks/${f}`, text: f.endsWith('.md') ? convertTask(text, tn) : text })
    if (f.endsWith('.md')) tn.files++
  }
  summary.push(`taches/ → tasks/: ${plural(tn.files, 'task file')} (${plural(tn.keys, 'frontmatter key')}, ${plural(tn.sections, 'section title')}, ${plural(tn.keyNames, 'key name')} in the body, ${plural(tn.branches, 'branch name')})`)
  const file = (from, to, convert, describe) => {
    const text = readOrNull(join(dir, from))
    if (text == null) return
    if (to !== from && existsSync(join(dir, to))) throw new Refusal(`${from} and ${to} both exist: migration stopped halfway? Merge them by hand`)
    const n = { headers: 0, statuses: 0, tokens: 0, legend: 0, title: 0, types: 0, checked: 0, entriesLine: 0, entries: 0, sections: 0 }
    changes.push({ from, to, text: convert(text, n) })
    summary.push(`${from}${to !== from ? ` → ${to}` : ''}: ${describe(n)}`)
  }
  file('SUIVI.md', 'PROGRESS.md', convertProgress, n => `${plural(n.headers, 'column title')}, ${plural(n.statuses, 'status', 'statuses')}, ${plural(n.tokens, 'token cell')}${n.legend ? ', legend' : ''}${n.title ? ', title' : ''}`)
  file('PREREQUIS.md', 'PREREQUISITES.md', convertPrerequisites, n => `${plural(n.headers, 'column title')}, ${plural(n.types, 'type')}, ${plural(n.statuses, 'status', 'statuses')}${n.legend ? ', legend' : ''}${n.checked ? ', "Checked by" line' : ''}${n.title ? ', title' : ''}`)
  file('HANDOFF.md', 'HANDOFF.md', convertHandoff, n => `${plural(n.entries, 'entry', 'entries')}${n.entriesLine ? ', "Entries:" line' : ''}${n.sections ? ', "## source plan"' : ''}`)
  file('DISCOVERY.md', 'DISCOVERY.md', convertDiscovery, n => plural(n.sections, 'section title'))
  // orchestre.config.json: created with "language": "fr" if missing
  const cfgText = readOrNull(join(dir, 'orchestre.config.json'))
  let cfg = {}
  if (cfgText != null) {
    try { cfg = JSON.parse(cfgText) } catch (e) { throw new Refusal(`orchestre.config.json unreadable (${e.message}): fix it, then run migrate again`) }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Refusal('orchestre.config.json: a JSON object is expected')
  }
  const cn = { keys: 0, values: [], language: false }
  changes.push({ from: cfgText == null ? null : 'orchestre.config.json', to: 'orchestre.config.json', text: JSON.stringify(convertConfig(cfg, cn), null, 2) + '\n' })
  summary.push(`orchestre.config.json${cfgText == null ? ' (created)' : ''}: ${plural(cn.keys, 'key')}${cn.values.map(v => ', ' + v).join('')}${cn.language ? ', "language": "fr" added' : ''}`)
  // suivi.json (outside git) → progress.json
  let progress = null
  const sv = readOrNull(join(dir, 'suivi.json'))
  if (sv != null) {
    if (existsSync(join(dir, 'progress.json'))) throw new Refusal('suivi.json and progress.json both exist: delete the one that is out of date')
    let doc
    try { doc = JSON.parse(sv) } catch (e) { throw new Refusal(`suivi.json unreadable (${e.message}): delete it, it will be rebuilt from PROGRESS.md, HANDOFF.md and plan-lint; then run migrate again`) }
    if (!doc || !LEGACY_FORMATS.includes(doc.format)) throw new Refusal(`suivi.json is in format ${doc && doc.format}, migrate reads ${LEGACY_FORMATS.join(' and ')}: delete it, it will be rebuilt; then run migrate again`)
    const running = (Array.isArray(doc.runs) ? doc.runs : []).filter(r => r && r.statut === 'en-cours').pop()
    progress = { doc, running, from: doc.format }
    summary.push(`suivi.json → progress.json (outside git): ${doc.format} → ${FORMAT}${running ? `, run ${running.numero} still "en-cours"` : ''}`)
  }
  return { changes, summary, progress }
}

function convertProgressFile(p) {
  const at = now(), doc = convertLegacy(p.doc)
  doc.log.push({ at, kind: 'run', task: null, text: conversionNote(p.from, 'migrate.mjs') })
  truncate(doc)
  const err = validate(doc)
  if (err.length) throw new Refusal(`suivi.json does not convert into a valid progress.json:\n${err.slice(0, 8).map(e => '  - ' + e).join('\n')}\nDelete suivi.json, it will be rebuilt from PROGRESS.md, HANDOFF.md and plan-lint; then run migrate again`)
  return JSON.stringify(doc, null, 2) + '\n'
}

export function migrate(arg, { write = false, runStopped = false } = {}) {
  const ctx = locate(arg)
  const fr = existsSync(join(ctx.dir, 'taches')), en = existsSync(join(ctx.dir, 'tasks'))
  if (en && !fr) return { code: 0, text: `migrate ${ctx.rel}: already in the 0.12 format, nothing to migrate` }
  if (en && fr) throw new Refusal(`${ctx.rel}: both taches/ and tasks/ exist: migration stopped halfway? Move the files by hand`)
  const P = plan(ctx)
  const head = `migrate ${ctx.rel}: French format of orchestre 0.11 and earlier → 0.12`
  const lines = P.summary.map(s => '  ' + s)
  if (!write) return { code: 0, text: [`${head} (preview, nothing written)`, ...lines, 'Free text is kept as written; git history is not rewritten. Run again with --write to migrate and commit.'].join('\n') }

  // Checks before writing anything: a clean plan folder, no run in progress, a valid progress file
  const dirty = git(['status', '--porcelain', '--untracked-files=all', '--', ctx.rel], ctx.root).split('\n').filter(Boolean)
    .filter(l => !/(^|\/)(suivi\.json|\.suivi\.lock|\.suivi\.[^/]*\.tmp)$/.test(l.slice(3)))
  if (dirty.length) throw new Refusal(`${ctx.rel} has uncommitted changes (${dirty.slice(0, 3).map(l => l.slice(3)).join(', ')}${dirty.length > 3 ? ', …' : ''}): commit or discard them first, so that the migration commit holds the migration alone`)
  if (P.progress && P.progress.running && !runStopped) throw new Refusal(`suivi.json marks run ${P.progress.running.numero} "en-cours" since ${P.progress.running.debut}: migrate between two runs. If it is stopped, run again with --run-stopped.`)
  const progressText = P.progress ? convertProgressFile(P.progress) : null

  // Write: renames first, then the new contents (git log --follow finds a task file through the migration)
  renameSync(join(ctx.dir, 'taches'), join(ctx.dir, 'tasks'))
  for (const c of P.changes) {
    const from = c.from && (c.from.startsWith('taches/') ? 'tasks/' + c.from.slice(7) : c.from)
    if (from && from !== c.to) renameSync(join(ctx.dir, from), join(ctx.dir, c.to))
    writeFileSync(join(ctx.dir, c.to), c.text)
  }
  if (progressText != null) {
    excludeFromGit(ctx.root, ctx.rel)
    renameSync(join(ctx.dir, 'suivi.json'), join(ctx.dir, 'progress.json'))
    writeFileSync(join(ctx.dir, 'progress.json'), progressText)
  } else excludeFromGit(ctx.root, ctx.rel)

  // One commit, the plan folder alone (other staged changes stay staged)
  const message = `orchestre: migrate plan ${ctx.name} to the 0.12 format`
  try {
    git(['add', '-A', '--', ctx.rel], ctx.root)
    if (attempt(() => git(['diff', '--cached', '--quiet', '--', ctx.rel], ctx.root)) != null) return { code: 0, text: [`${head}: migrated, nothing to commit`, ...lines].join('\n') }
    git(['commit', '-q', '-m', message, '--', ctx.rel], ctx.root)
  } catch (e) {
    return { code: 1, text: [`${head}: files migrated, but the commit failed (${String(e.stderr || e.message).trim().split('\n')[0]}): commit ${ctx.rel} by hand`, ...lines].join('\n') }
  }
  const hash = git(['rev-parse', '--short', 'HEAD'], ctx.root).trim(), branch = attempt(() => git(['symbolic-ref', '-q', '--short', 'HEAD'], ctx.root).trim()) || 'HEAD'
  return { code: 0, text: [`${head}: migrated and committed (${hash} on ${branch}: "${message}")`, ...lines].join('\n') }
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
