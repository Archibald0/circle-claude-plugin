#!/usr/bin/env node
// settings (orchestre plugin 0.13.0): compares the Claude Code settings of a repository with the settings model of
// /orchestre:install, rule by rule, and writes what is missing. The model has one source: skills/install/settings.local.template.json,
// plus the rules of the plugin's scripts at the path of this copy of the plugin. Node 18 or later, no dependencies.
//
// Usage: node <plugin root>/scripts/settings.mjs check [--team] [--json] [--add '<json>']
//        node <plugin root>/scripts/settings.mjs apply [--team] [--json] [--add '<json>']
//   check: reads, writes nothing. "complete" when every rule of the model holds in the settings Claude Code merges (local,
//          project, user), and no rule of an older install of orchestre is left in .claude/settings.local.json. Text: "settings
//          complete", "settings missing" (no rule of orchestre yet: the whole of /orchestre:install is to do) or "settings
//          incomplete" (an older install, or the plugin updated since), then one line per change.
//   apply: writes what check lists into .claude/settings.local.json only (and .claude/settings.json with --team), keeping every
//          other key and rule where it is; writes nothing when there is nothing to change. A local file it writes, neither
//          ignored nor tracked by git, is excluded through .git/info/exclude.
//   --add '{"allow":[…],"deny":[…],"env":{"PATH":"…"}}': rules of the project, chosen with the user (deployment tool, project
//          commands, PATH), checked and written with the model.
//   --team: also the declaration of the marketplace and of the plugin in .claude/settings.json (versioned), for the team.
// Scopes read (code.claude.com/docs/en/settings): local, .claude/settings.local.json of the main checkout; project,
// .claude/settings.json at the root of the checkout; user, $CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json.
// Managed settings are not read. Lists merge across scopes; a scalar takes the value of the highest scope (local, then
// project, then user). The exceptions "Read(!…)" only cancel the rule before them in the same file: Read(./.env.*) and its
// exceptions are checked in .claude/settings.local.json itself.
// Rules removed: those of the scripts of another installed version of the plugin (path …/orchestre/<version>/scripts/), those
// of orchestre 0.11 and earlier (Workflow(orchestre:executer-phase), suivi.mjs, etat.mjs) and of the manual install of v0.5
// (Workflow(executer-phase), .claude/orchestre/).
// Exit codes: 0 complete (check) or written (apply); 1 incomplete (check); 2 invalid call, not in a git repository, or a
// settings file that is not valid JSON (nothing written); 3 write refused by the system (the Bash sandbox refuses writes to
// the settings files of Claude Code: the user runs the same command in a terminal, prefixed with !).
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, appendFileSync, realpathSync } from 'node:fs'
import { join, dirname, resolve, basename, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = join(HERE, '..', 'skills', 'install', 'settings.local.template.json')
const MANIFEST = join(HERE, '..', '.claude-plugin', 'plugin.json')
export const SCRIPTS = ['plan-lint.mjs', 'progress.mjs', 'worktrees.mjs']
export const MARKETPLACE = 'circle'
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
const attempt = f => { try { return f() } catch { return null } }
const git = (args, cwd) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const show = v => JSON.stringify(v)
class Failure extends Error { constructor(m, code) { super(m); this.code = code } }

// The rule of a script of the plugin, as the skills and the workflow launch it: node <plugin root>/scripts/<script> …
export const scriptRule = (root, script) => `Bash(node ${root}/scripts/${script} *)`

// The model: the template's scalars (dotted keys), its allow and deny lists, and the rules of this copy's scripts
export function model(template, root) {
  const scalars = []
  const walk = (o, path) => {
    for (const [k, v] of Object.entries(o)) {
      if (!path.length && k === 'permissions') continue
      if (isObject(v)) walk(v, [...path, k])
      else scalars.push({ path: [...path, k], value: v })
    }
  }
  walk(template, [])
  const p = template.permissions || {}
  return { scalars, allow: [...(p.allow || []), ...SCRIPTS.map(s => scriptRule(root, s))], deny: [...(p.deny || [])] }
}

// Why a rule of the settings is left over from an older install, or null
export function obsolete(rule, root) {
  if (rule === 'Workflow(orchestre:executer-phase)') return 'orchestre 0.11 and earlier'
  if (rule === 'Workflow(executer-phase)' || /^Bash\(node \.claude\/orchestre\//.test(rule)) return 'manual install of v0.5 and earlier'
  const m = rule.match(/^Bash\(node (.+)\/scripts\/([a-z-]+\.mjs)(?: \*|:\*)\)$/)
  if (!m || m[1] === root) return null
  const segments = m[1].split('/')
  if (!segments.includes('orchestre')) return null
  if (['suivi.mjs', 'etat.mjs'].includes(m[2])) return 'orchestre 0.11 and earlier'
  const version = segments[segments.length - 1]
  if (segments[segments.length - 2] === 'orchestre' && /^\d+\.\d+\.\d+/.test(version) && [...SCRIPTS, 'status.mjs', 'migrate.mjs'].includes(m[2])) return `orchestre ${version}`
  return null
}

// A rule of orchestre, of any version: the workflow or a script of the plugin
const orchestreRule = (rule, root) => /^Workflow\((orchestre:[a-z-]+|executer-phase)\)$/.test(rule) || rule.includes(`${root}/scripts/`) || obsolete(rule, root) != null

const getPath = (o, path) => path.reduce((x, k) => (isObject(x) && k in x ? x[k] : undefined), o)
function setPath(o, path, value) {
  let x = o
  for (const k of path.slice(0, -1)) { if (!isObject(x[k])) x[k] = {}; x = x[k] }
  x[path[path.length - 1]] = value
}
const list = (data, key) => (isObject(data) && isObject(data.permissions) && Array.isArray(data.permissions[key]) ? data.permissions[key] : [])

// Reads a settings file: { exists, valid, error, data }
export function readSettings(path) {
  if (!existsSync(path)) return { exists: false, valid: true, data: {} }
  let data
  try { data = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { return { exists: true, valid: false, error: `not valid JSON (${e.message})`, data: {} } }
  if (!isObject(data)) return { exists: true, valid: false, error: 'not a JSON object', data: {} }
  if (data.permissions !== undefined && !isObject(data.permissions)) return { exists: true, valid: false, error: '"permissions" is not an object', data: {} }
  for (const k of ['allow', 'deny']) {
    const v = data.permissions && data.permissions[k]
    if (v !== undefined && !(Array.isArray(v) && v.every(r => typeof r === 'string'))) return { exists: true, valid: false, error: `"permissions.${k}" is not a list of rules`, data: {} }
  }
  return { exists: true, valid: true, data }
}

// Checks the --add argument: { allow, deny, env }
export function parseAdd(text) {
  let a
  try { a = JSON.parse(text) } catch (e) { throw new Failure(`--add: not valid JSON (${e.message})`, 2) }
  if (!isObject(a)) throw new Failure('--add: a JSON object is expected, like {"allow":[…],"deny":[…],"env":{…}}', 2)
  const unknown = Object.keys(a).filter(k => !['allow', 'deny', 'env'].includes(k))
  if (unknown.length) throw new Failure(`--add: unknown key ${unknown.join(', ')}; allowed: allow, deny, env`, 2)
  for (const k of ['allow', 'deny']) if (a[k] !== undefined && !(Array.isArray(a[k]) && a[k].every(r => typeof r === 'string' && r.trim()))) throw new Failure(`--add: "${k}" must be a list of rules`, 2)
  if (a.env !== undefined && !(isObject(a.env) && Object.values(a.env).every(v => typeof v === 'string'))) throw new Failure('--add: "env" must be an object of texts', 2)
  return { allow: a.allow || [], deny: a.deny || [], env: a.env || {} }
}

// Compares the scopes with the model. scopes: { local, project, user } as returned by readSettings. Returns the rules, the rules
// to remove, the changes per file and the warnings; pure, writes nothing.
export function evaluate({ template, root, scopes, team = null, add = { allow: [], deny: [], env: {} } }) {
  const M = model(template, root)
  const ORDER = ['local', 'project', 'user']
  const rules = [], remove = [], warnings = []
  const local = { set: [], allow: [], deny: [], exceptions: null, remove: { allow: [], deny: [] } }
  const project = { set: [] }
  const where = (key, rule) => ORDER.find(s => list(scopes[s].data, key).includes(rule)) || null

  // Scalars: the highest scope that sets the key
  for (const { path, value } of M.scalars) {
    const scope = ORDER.find(s => getPath(scopes[s].data, path) !== undefined) || null
    const found = scope ? getPath(scopes[scope].data, path) : null
    const status = scope == null ? 'missing' : same(found, value) ? 'ok' : 'wrong'
    rules.push({ rule: path.join('.'), key: path.join('.'), expected: value, found, status, scope })
    if (status !== 'ok') local.set.push({ path, value, found })
  }
  // Allow: present in any scope
  for (const rule of [...M.allow, ...add.allow.filter(r => !M.allow.includes(r))]) {
    const scope = where('allow', rule)
    rules.push({ rule, key: 'permissions.allow', status: scope ? 'ok' : 'missing', scope, ...(M.allow.includes(rule) ? {} : { added: true }) })
    if (!scope) local.allow.push(rule)
    const denied = where('deny', rule)
    if (denied) warnings.push(`${rule}: also denied in the ${denied} settings, and a deny wins: the agents will be refused this command`)
  }
  // Deny: present in any scope, apart from Read(./.env.*) and its exceptions, which are checked in the local file
  const isException = r => r.startsWith('Read(!')
  const anchorOf = i => { for (let j = i - 1; j >= 0; j--) if (!isException(M.deny[j])) return M.deny[j]; return null }
  const anchors = new Set(M.deny.filter((r, i) => !isException(r) && isException(M.deny[i + 1] || '')))
  const localDeny = list(scopes.local.data, 'deny')
  for (const [i, rule] of M.deny.entries()) {
    if (anchors.has(rule)) {
      const status = localDeny.includes(rule) ? 'ok' : 'missing'
      rules.push({ rule, key: 'permissions.deny', status, scope: status === 'ok' ? 'local' : null })
      if (status === 'missing') local.deny.push(rule)
      for (const s of ['project', 'user']) if (list(scopes[s].data, 'deny').includes(rule)) warnings.push(`${rule}: also denied in the ${s} settings, where the exceptions of .claude/settings.local.json do not reach it: the agents will neither read nor change the .env templates, which go to review before the PR`)
    } else if (isException(rule)) {
      const anchor = anchorOf(i), at = localDeny.indexOf(rule), anchorAt = localDeny.indexOf(anchor)
      const status = at < 0 ? 'missing' : anchorAt >= 0 && at > anchorAt ? 'ok' : 'misplaced'
      rules.push({ rule, key: 'permissions.deny', status, scope: at < 0 ? null : 'local', after: anchor })
      if (status !== 'ok') (local.exceptions ||= []).push({ rule, anchor, status })
    } else {
      const scope = where('deny', rule)
      rules.push({ rule, key: 'permissions.deny', status: scope ? 'ok' : 'missing', scope })
      if (!scope) local.deny.push(rule)
    }
  }
  for (const rule of add.deny.filter(r => !M.deny.includes(r))) {
    const scope = where('deny', rule)
    rules.push({ rule, key: 'permissions.deny', status: scope ? 'ok' : 'missing', scope, added: true })
    if (!scope) local.deny.push(rule)
  }
  for (const [name, value] of Object.entries(add.env)) {
    const scope = ORDER.find(s => getPath(scopes[s].data, ['env', name]) !== undefined) || null
    const found = scope ? getPath(scopes[scope].data, ['env', name]) : null
    const status = scope == null ? 'missing' : found === value ? 'ok' : 'wrong'
    rules.push({ rule: `env.${name}`, key: `env.${name}`, expected: value, found, status, scope, added: true })
    if (status !== 'ok') local.set.push({ path: ['env', name], value, found })
  }
  // Team: the marketplace and the plugin declared in the versioned settings of the project
  if (team) {
    for (const [path, value] of [[['extraKnownMarketplaces', MARKETPLACE], { source: { source: 'github', repo: team.repo } }], [['enabledPlugins', `${team.plugin}@${MARKETPLACE}`], true]]) {
      const found = getPath(scopes.project.data, path)
      const status = found === undefined ? 'missing' : same(found, value) ? 'ok' : 'wrong'
      rules.push({ rule: path.join('.'), key: path.join('.'), expected: value, found: found === undefined ? null : found, status, scope: found === undefined ? null : 'project' })
      if (status !== 'ok') project.set.push({ path, value, found: found === undefined ? null : found })
    }
  }
  // Rules of an older install: removed from the local file; reported elsewhere
  for (const key of ['allow', 'deny']) for (const s of ORDER) for (const rule of list(scopes[s].data, key)) {
    const reason = obsolete(rule, root)
    if (!reason) continue
    if (s === 'local') { remove.push({ rule, key: `permissions.${key}`, scope: s, reason }); local.remove[key].push(rule) } else warnings.push(`${rule} (${reason}): in the ${s} settings, which this script does not change; remove it by hand`)
  }
  // Resume on a usage limit: a setting of the user (scope "User or managed"), on by default
  if (getPath(scopes.user.data, ['autoContinueAtUsageLimit']) === false) warnings.push('autoContinueAtUsageLimit is false in the user settings: a run that hits a usage limit fails instead of waiting for the reset (not changed here: /config, "Continue automatically at usage limit")')
  if (scopes.local.tracked) warnings.push('.claude/settings.local.json is tracked by git: Claude Code holds its allow rules until the folder is trusted, and every change shows in git status')

  const firstInstall = !ORDER.some(s => ['allow', 'deny'].some(k => list(scopes[s].data, k).some(r => orchestreRule(r, root))))
  const localChanges = local.set.length + local.allow.length + local.deny.length + (local.exceptions || []).length + local.remove.allow.length + local.remove.deny.length
  const writes = []
  if (localChanges) writes.push({ scope: 'local', set: local.set, add: { allow: local.allow, deny: local.deny }, exceptions: local.exceptions || [], remove: local.remove })
  if (project.set.length) writes.push({ scope: 'project', set: project.set, add: { allow: [], deny: [] }, exceptions: [], remove: { allow: [], deny: [] } })
  const complete = rules.every(r => r.status === 'ok') && !remove.length
  return { complete, first_install: firstInstall, rules, remove, writes, warnings }
}

// Applies the changes of one file to its data; returns the new data
export function applyChanges(data, w) {
  const out = JSON.parse(JSON.stringify(data))
  for (const { path, value } of w.set) setPath(out, path, value)
  const touches = w.add.allow.length || w.add.deny.length || w.exceptions.length || w.remove.allow.length || w.remove.deny.length
  if (!touches) return out
  if (!isObject(out.permissions)) out.permissions = {}
  for (const key of ['allow', 'deny']) {
    let l = Array.isArray(out.permissions[key]) ? [...out.permissions[key]] : []
    l = l.filter(r => !w.remove[key].includes(r))
    for (const r of w.add[key]) if (!l.includes(r)) l.push(r)
    if (key === 'deny') {
      // Exceptions missing or placed before their rule: right after it, in the order of the model
      const moved = w.exceptions.map(e => e.rule)
      l = l.filter(r => !moved.includes(r))
      const byAnchor = {}
      for (const e of w.exceptions) (byAnchor[e.anchor] ||= []).push(e.rule)
      for (const [anchor, rules] of Object.entries(byAnchor)) {
        if (!l.includes(anchor)) l.push(anchor)
        let at = l.indexOf(anchor) + 1
        while (at < l.length && l[at].startsWith('Read(!')) at++
        l.splice(at, 0, ...rules)
      }
    }
    if (l.length || Array.isArray(out.permissions[key])) out.permissions[key] = l
  }
  return out
}

// Text of the changes, one line each
function changeLines(r, paths) {
  const lines = []
  for (const w of r.writes) {
    const at = r.writes.length > 1 ? ` (${paths[w.scope]})` : ''
    for (const s of w.set) lines.push(s.found == null ? `+ ${s.path.join('.')}: ${show(s.value)}${at}` : `~ ${s.path.join('.')}: ${show(s.found)} → ${show(s.value)}${at}`)
    for (const k of ['allow', 'deny']) for (const rule of w.add[k]) lines.push(`+ ${k} ${rule}${at}`)
    for (const e of w.exceptions) lines.push(e.status === 'misplaced' ? `↷ deny ${e.rule}: moved right after ${e.anchor}${at}` : `+ deny ${e.rule}, right after ${e.anchor}${at}`)
  }
  for (const x of r.remove) lines.push(`− ${x.key.replace('permissions.', '')} ${x.rule} (${x.reason})`)
  return lines
}
const count = r => {
  let changed = 0
  for (const w of r.writes) changed += w.set.length + w.add.allow.length + w.add.deny.length + w.exceptions.length
  return { changed, removed: r.remove.length }
}

// Paths of the scopes, from the folder the command runs in
function locate(cwd) {
  const top = attempt(() => git(['rev-parse', '--show-toplevel'], cwd).trim())
  if (!top) throw new Failure('not in a git repository: run it from the root of the repository', 2)
  const common = attempt(() => git(['rev-parse', '--git-common-dir'], top).trim())
  const commonAbs = common ? resolve(top, common) : null
  // The local settings live in the main checkout, even from a linked worktree (code.claude.com/docs/en/permissions)
  const main = commonAbs && basename(commonAbs) === '.git' ? dirname(commonAbs) : top
  const config = process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude')
  return { top, main, local: join(main, '.claude', 'settings.local.json'), project: join(top, '.claude', 'settings.json'), user: join(config, 'settings.json') }
}
const display = (p, top) => {
  const rel = relative(top, p)
  if (!rel.startsWith('..') && !isAbsolute(rel)) return rel
  const home = homedir(), r = relative(home, p)
  return !r.startsWith('..') && !isAbsolute(r) ? `~/${r}` : p
}

// The whole check: files read, then evaluate. Throws a Failure (code 2) when a file cannot be read
export function check({ cwd, root, team, add }) {
  const at = locate(cwd)
  const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'))
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const scopes = {}, files = [], errors = []
  for (const s of ['local', 'project', 'user']) {
    scopes[s] = readSettings(at[s])
    const f = { scope: s, path: display(at[s], at.top), exists: scopes[s].exists, valid: scopes[s].valid }
    if (scopes[s].error) { f.error = scopes[s].error; errors.push(`${f.path}: ${scopes[s].error}`) }
    if (s === 'local') {
      const rel = relative(at.main, at.local)
      f.ignored_by_git = attempt(() => { git(['check-ignore', '-q', rel], at.main); return true }) || false
      scopes.local.tracked = f.tracked = scopes[s].exists && attempt(() => { git(['ls-files', '--error-unmatch', rel], at.main); return true }) === true
    }
    files.push(f)
  }
  const repo = (String(manifest.repository || '').match(/github\.com[/:]([^/]+\/[^/.]+)/) || [])[1] || null
  if (team && !repo) errors.push(`${display(MANIFEST, at.top)}: no GitHub repository in "repository", needed to declare the marketplace for the team`)
  const r = evaluate({ template, root, scopes, team: team ? { repo, plugin: manifest.name } : null, add })
  return { at, scopes, files, errors, version: manifest.version, ...r }
}

function report(r, { root, team, mode, written = null }) {
  const paths = Object.fromEntries(r.files.map(f => [f.scope, f.path]))
  const json = {
    ok: r.errors.length === 0,
    complete: r.errors.length === 0 && r.complete,
    first_install: r.first_install,
    version: r.version,
    plugin_root: root,
    team: !!team,
    files: r.files,
    rules: r.rules,
    remove: r.remove,
    writes: r.writes.map(w => ({
      path: paths[w.scope],
      set: Object.fromEntries(w.set.map(s => [s.path.join('.'), s.value])),
      add: Object.fromEntries(['allow', 'deny'].map(k => [`permissions.${k}`, [...w.add[k], ...(k === 'deny' ? w.exceptions.map(e => e.rule) : [])]]).filter(([, v]) => v.length)),
      remove: Object.fromEntries(['allow', 'deny'].map(k => [`permissions.${k}`, w.remove[k]]).filter(([, v]) => v.length)),
    })),
    warnings: r.warnings,
    errors: r.errors,
    ...(written ? { written: written.files, excluded: written.excluded } : {}),
  }
  const lines = []
  const head = `orchestre ${r.version}`
  if (r.errors.length) lines.push(...r.errors.map(e => `✗ ${e}`), `✗ nothing ${mode === 'apply' ? 'written' : 'checked'}: fix the file, then run the command again`)
  else if (written && written.files.length) {
    const c = count(r)
    lines.push(`✓ settings written for ${head}: ${written.files.join(', ')} (${c.changed} added or changed, ${c.removed} removed)`, ...changeLines(r, paths))
    if (written.excluded) lines.push(`ℹ ${written.excluded}: .claude/settings.local.json added, so that git does not show it`)
  } else if (r.complete) lines.push(`✓ settings complete for ${head}${mode === 'apply' ? ': nothing to write' : ''}`)
  else {
    const c = count(r), where = r.writes.map(w => paths[w.scope]).join(' and ')
    // "missing": no rule of orchestre yet, the whole install is to do; "incomplete": an older install or a plugin updated since
    lines.push(`✗ settings ${r.first_install ? 'missing' : 'incomplete'} for ${head}: ${where}, ${c.changed} to add or change, ${c.removed} to remove`, ...changeLines(r, paths))
  }
  if (!r.errors.length) lines.push(...r.warnings.map(w => `⚠ ${w}`))
  return { json, text: lines.join('\n') }
}

// Writes a file in place of the old one, through a temporary file in the same folder
function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  try { writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n'); renameSync(tmp, path) } catch (e) { attempt(() => unlinkSync(tmp)); throw e }
}

export function apply({ cwd, root, team, add }) {
  const r = check({ cwd, root, team, add })
  if (r.errors.length) return { r, written: null }
  const files = []
  let excluded = null
  for (const w of r.writes) {
    const path = r.at[w.scope], created = !r.scopes[w.scope].exists
    const next = applyChanges(r.scopes[w.scope].data, w)
    if (!created && same(next, r.scopes[w.scope].data)) continue
    try { writeAtomic(path, next) } catch (e) {
      throw new Failure(`write refused for ${display(path, r.at.top)} (${e.code || e.message})${['EPERM', 'EACCES', 'EROFS'].includes(e.code) ? ': the Bash sandbox of Claude Code refuses writes to its settings files. Run the same command in a terminal, prefixed with !' : ''}`, 3)
    }
    files.push(display(path, r.at.top))
    // Claude Code excludes the local file from git only when it creates it itself: a file written here, neither ignored nor
    // tracked, goes into .git/info/exclude (personal, nothing to commit)
    const lf = r.files.find(f => f.scope === 'local')
    if (w.scope === 'local' && !lf.ignored_by_git && !lf.tracked) {
      const exclude = attempt(() => resolve(r.at.main, git(['rev-parse', '--git-path', 'info/exclude'], r.at.main).trim()))
      if (exclude) {
        const before = attempt(() => readFileSync(exclude, 'utf8')) || ''
        mkdirSync(dirname(exclude), { recursive: true })
        appendFileSync(exclude, `${before && !before.endsWith('\n') ? '\n' : ''}# orchestre: personal settings of Claude Code, outside git\n/.claude/settings.local.json\n`)
        excluded = '.git/info/exclude'
      }
    }
  }
  return { r: files.length ? check({ cwd, root, team, add }) : r, written: { files, excluded }, before: r }
}

const USAGE = "usage: settings.mjs <check|apply> [--team] [--json] [--add '<json>']"
const real = p => attempt(() => realpathSync(p)) || resolve(p)
const launched = process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))
if (launched) {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  try {
    const ai = argv.indexOf('--add')
    const addText = ai >= 0 ? argv[ai + 1] : null
    const rest = argv.filter((a, i) => i !== ai && !(ai >= 0 && i === ai + 1))
    const unknown = rest.filter(a => a.startsWith('--') && !['--team', '--json'].includes(a))
    const words = rest.filter(a => !a.startsWith('--'))
    if (unknown.length || words.length !== 1 || !['check', 'apply'].includes(words[0]) || (ai >= 0 && (addText == null || addText.startsWith('--')))) throw new Failure(USAGE, 2)
    const mode = words[0], team = argv.includes('--team')
    const add = addText != null ? parseAdd(addText) : undefined
    // The root of the plugin as the command was typed (${CLAUDE_PLUGIN_ROOT}, symbolic links kept), to match the rules
    const root = dirname(dirname(resolve(process.argv[1])))
    const ctx = { cwd: process.cwd(), root, team, add }
    let out
    if (mode === 'check') {
      const r = check(ctx)
      out = report(r, { root, team, mode })
      process.exitCode = r.errors.length ? 2 : r.complete ? 0 : 1
    } else {
      const { r, written, before } = apply(ctx)
      // The changes listed are those written: the check before the write
      out = report(written && written.files.length ? { ...r, writes: before.writes, remove: before.remove, rules: r.rules, complete: r.complete } : r, { root, team, mode, written })
      process.exitCode = r.errors.length ? 2 : r.complete ? 0 : 1
    }
    console.log(json ? JSON.stringify(out.json) : out.text)
  } catch (e) {
    const code = e instanceof Failure ? e.code : 2
    const message = e instanceof Failure ? e.message : `unexpected error: ${(e && e.stack) || e}`
    if (json) console.log(JSON.stringify({ ok: false, complete: false, errors: [message] }))
    else console.error(`settings: ${message}`)
    // The exit code only: exiting right away would cut the output in a pipe (0.8.1)
    process.exitCode = code
  }
}
