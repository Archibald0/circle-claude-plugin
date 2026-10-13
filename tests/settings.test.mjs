// Tests of settings.mjs: the settings of a repository compared with the model of /orchestre:install, rule by rule, and written.
// Settings absent, complete, partial, of orchestre 0.11 (its real template, taken from git at dd14f89), not valid JSON, with
// --team, spread over the scopes, with rules of the project (--add), from a linked worktree, and through a pipe.
// Usage: node tests/settings.test.mjs
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, statSync, symlinkSync, cpSync, utimesSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PLUGIN = join(REPO, 'plugins', 'orchestre')
const SCRIPT = join(PLUGIN, 'scripts', 'settings.mjs')
const TEMPLATE = JSON.parse(readFileSync(join(PLUGIN, 'skills', 'install', 'settings.local.template.json'), 'utf8'))
const MANIFEST = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'))
const SCRIPTS = ['plan-lint.mjs', 'progress.mjs', 'worktrees.mjs']
// The rule as the workflow launches the script: its path between double quotes when it holds a space (run-phase.js)
const RULE = (root, s) => (/\s/.test(root) ? `Bash(node "${root}/scripts/${s}" *)` : `Bash(node ${root}/scripts/${s} *)`)
const OWN = SCRIPTS.map(s => RULE(PLUGIN, s))
const OLD_ROOT = '/Users/someone/.claude/plugins/cache/circle/orchestre/0.11.0'
// The template of orchestre 0.11.0, as its /orchestre:installer merged it, with the rules of its scripts
let TEMPLATE_011
try { TEMPLATE_011 = JSON.parse(execFileSync('git', ['show', 'dd14f89:plugins/orchestre/skills/installer/settings.local.modele.json'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) } catch { throw new Error('these tests need the git history of orchestre 0.11.0 (commit dd14f89) to read its settings template') }

const tmp = []
const tempDir = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); tmp.push(d); return d }
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
function newRepo() {
  const d = tempDir('settings-'), home = tempDir('home-')
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't'); git(d, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(d, 'README.md'), 'x\n'); git(d, 'add', '.'); git(d, 'commit', '-qm', 'init')
  return { d, home }
}
const run = (r, args, { script = SCRIPT, cwd = r.d } = {}) => {
  const p = spawnSync('node', [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: r.home, HOME: r.home } })
  return { code: p.status, out: p.stdout, err: p.stderr }
}
const json = (r, args, opts) => { const p = run(r, [...args, '--json'], opts); return { ...p, j: JSON.parse(p.out) } }
const write = (path, data) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n') }
const local = r => join(r.d, '.claude', 'settings.local.json')
const project = r => join(r.d, '.claude', 'settings.json')
const user = r => join(r.home, 'settings.json')
const readJson = p => JSON.parse(readFileSync(p, 'utf8'))
const rule = (j, name) => j.rules.find(x => x.rule === name)
const exceptions = TEMPLATE.permissions.deny.filter(r => r.startsWith('Read(!'))
// In a deny list, each exception of the .env templates comes after Read(./.env.*)
const placed = deny => exceptions.every(e => deny.indexOf(e) > deny.indexOf('Read(./.env.*)') && deny.indexOf('Read(./.env.*)') >= 0)

let n = 0
const test = (name, fn) => { fn(); n++; console.log('ok ·', name) }

try {
  test('the model: the template, the workflow of the plugin and the rules of its three scripts; no autoContinueAtUsageLimit, a user setting', () => {
    assert.equal(TEMPLATE.autoContinueAtUsageLimit, undefined)
    const r = newRepo()
    const { j } = json(r, ['check'])
    const expected = ['worktree.baseRef', ...TEMPLATE.permissions.allow, ...OWN, ...TEMPLATE.permissions.deny]
    assert.deepEqual(j.rules.map(x => x.rule), expected)
    assert.ok(j.rules.find(x => x.rule === 'Workflow(orchestre:run-phase)'))
    assert.equal(j.version, MANIFEST.version)
    assert.equal(j.plugin_root, PLUGIN)
  })

  test('absent: every rule missing; apply writes them, then check is complete; a second apply writes nothing', () => {
    const r = newRepo()
    const c = json(r, ['check'])
    assert.equal(c.code, 1)
    assert.equal(c.j.ok, true); assert.equal(c.j.complete, false); assert.equal(c.j.first_install, true)
    assert.ok(c.j.rules.every(x => x.status === 'missing'), 'all missing')
    assert.deepEqual(c.j.writes.map(w => w.path), ['.claude/settings.local.json'])
    assert.deepEqual(c.j.writes[0].set, { 'worktree.baseRef': 'head' })
    assert.equal(existsSync(local(r)), false, 'check writes nothing')
    const text = run(r, ['check']).out
    assert.match(text, /^✗ settings missing for orchestre \d+\.\d+\.\d+: \.claude\/settings\.local\.json, \d+ to add or change, 0 to remove\n/)
    assert.match(text, /^\+ allow Workflow\(orchestre:run-phase\)$/m)
    assert.match(text, /^\+ deny Read\(!\.env\.example\), right after Read\(\.\/\.env\.\*\)$/m)
    const a = json(r, ['apply'])
    assert.equal(a.code, 0, a.out)
    assert.deepEqual(a.j.written, ['.claude/settings.local.json'])
    assert.equal(a.j.complete, true)
    const s = readJson(local(r))
    assert.equal(s.worktree.baseRef, 'head')
    assert.deepEqual(s.permissions.allow, [...TEMPLATE.permissions.allow, ...OWN])
    assert.deepEqual(s.permissions.deny, TEMPLATE.permissions.deny)
    assert.ok(placed(s.permissions.deny))
    const c2 = json(r, ['check'])
    assert.equal(c2.code, 0); assert.equal(c2.j.complete, true); assert.equal(c2.j.first_install, false); assert.deepEqual(c2.j.writes, [])
    assert.equal(run(r, ['check']).out.trim(), `✓ settings complete for orchestre ${MANIFEST.version}`)
    // A second apply: nothing written, the file untouched
    utimesSync(local(r), new Date(2000, 0, 1), new Date(2000, 0, 1))
    const before = readFileSync(local(r), 'utf8')
    const a2 = run(r, ['apply'])
    assert.equal(a2.code, 0)
    assert.equal(a2.out.trim(), `✓ settings complete for orchestre ${MANIFEST.version}: nothing to write`)
    assert.equal(readFileSync(local(r), 'utf8'), before)
    assert.equal(statSync(local(r)).mtime.getFullYear(), 2000)
  })

  test('a local file written here, neither ignored nor tracked: excluded from git by .git/info/exclude, once; an ignored one is left alone', () => {
    const r = newRepo()
    const a = run(r, ['apply'])
    assert.match(a.out, /^ℹ \.git\/info\/exclude: \.claude\/settings\.local\.json added/m)
    assert.equal(git(r.d, 'status', '--porcelain'), '')
    assert.equal(readFileSync(join(r.d, '.git', 'info', 'exclude'), 'utf8').split('\n').filter(l => l === '/.claude/settings.local.json').length, 1)
    // Already ignored by .gitignore: no exclusion added
    const r2 = newRepo()
    write(join(r2.d, '.gitignore'), '.claude/settings.local.json\n'); git(r2.d, 'add', '.'); git(r2.d, 'commit', '-qm', 'ignore')
    const before = readFileSync(join(r2.d, '.git', 'info', 'exclude'), 'utf8')
    const a2 = json(r2, ['apply'])
    assert.equal(a2.j.excluded, null)
    assert.equal(readFileSync(join(r2.d, '.git', 'info', 'exclude'), 'utf8'), before)
    assert.equal(a2.j.files[0].ignored_by_git, true)
    // A file that exists, written by hand, neither ignored nor tracked: excluded when the script writes it, not when complete
    const r3 = newRepo()
    write(local(r3), { permissions: { allow: ['Bash(make *)'] } })
    assert.equal(json(r3, ['check']).j.files[0].ignored_by_git, false)
    assert.equal(json(r3, ['apply']).j.excluded, '.git/info/exclude')
    assert.equal(git(r3.d, 'status', '--porcelain'), '')
    // Complete, but shown by git: check warns, apply writes no setting and excludes it
    const r4 = newRepo()
    write(local(r4), { ...TEMPLATE, permissions: { allow: [...TEMPLATE.permissions.allow, ...OWN], deny: TEMPLATE.permissions.deny } })
    const c4 = json(r4, ['check'])
    assert.equal(c4.j.complete, true)
    assert.match(c4.j.warnings.join('\n'), /neither ignored nor tracked by git/)
    const a4 = json(r4, ['apply'])
    assert.deepEqual([a4.code, a4.j.written, a4.j.excluded], [0, [], '.git/info/exclude'])
    assert.match(run(r4, ['check']).out, /^✓ settings complete for orchestre [\d.]+\n$/, 'no warning once excluded')
    assert.equal(git(r4.d, 'status', '--porcelain'), '')
    // An exclude file without a final newline: the exclusion goes on a line of its own
    const r5 = newRepo()
    writeFileSync(join(r5.d, '.git', 'info', 'exclude'), '*.log')
    run(r5, ['apply'])
    assert.deepEqual(readFileSync(join(r5.d, '.git', 'info', 'exclude'), 'utf8').split('\n').slice(0, 3), ['*.log', '# orchestre: personal settings of Claude Code, outside git', '/.claude/settings.local.json'])
    // .git/info/exclude cannot be written: a warning, the settings are written all the same, exit 0
    const r6 = newRepo()
    rmSync(join(r6.d, '.git', 'info', 'exclude'), { force: true }); mkdirSync(join(r6.d, '.git', 'info', 'exclude'), { recursive: true })
    const a6 = json(r6, ['apply'])
    assert.equal(a6.code, 0, a6.out)
    assert.deepEqual(a6.j.written, ['.claude/settings.local.json'])
    assert.match(a6.j.warnings.join('\n'), /\.git\/info\/exclude could not be written \(EISDIR\)/)
    assert.equal(json(r6, ['check']).j.complete, true)
  })

  test('complete, with keys and rules of the user: nothing written, the file kept byte for byte', () => {
    const r = newRepo()
    const text = JSON.stringify({ model: 'sonnet', ...TEMPLATE, hooks: { Stop: [] }, permissions: { allow: ['Bash(make *)', ...TEMPLATE.permissions.allow, ...OWN], deny: TEMPLATE.permissions.deny, ask: ['Bash(rm *)'] } }, null, 4) + '\n'
    write(local(r), text)
    const c = json(r, ['check'])
    assert.equal(c.code, 0); assert.equal(c.j.complete, true)
    assert.equal(run(r, ['apply']).code, 0)
    assert.equal(readFileSync(local(r), 'utf8'), text)
  })

  test('partial: rule by rule, only what is missing, wrong or misplaced is changed; the rest stays in place', () => {
    const r = newRepo()
    const deny = ['Read(!.env.example)', 'Bash(git push *)', 'Read(./.env.*)', 'Read(!.env.sample)', 'Bash(curl *)']
    write(local(r), { model: 'sonnet', worktree: { baseRef: 'fresh', symlinkDirectories: ['node_modules'] }, permissions: { allow: ['Bash(make *)', 'Bash(git add *)', ...OWN], deny } })
    const c = json(r, ['check'])
    assert.equal(c.code, 1)
    assert.equal(c.j.first_install, false)
    assert.deepEqual(rule(c.j, 'worktree.baseRef'), { rule: 'worktree.baseRef', key: 'worktree.baseRef', expected: 'head', found: 'fresh', status: 'wrong', scope: 'local' })
    assert.equal(rule(c.j, 'Bash(git add *)').status, 'ok')
    assert.equal(rule(c.j, 'Bash(git commit *)').status, 'missing')
    assert.equal(rule(c.j, 'Read(!.env.example)').status, 'misplaced')
    assert.equal(rule(c.j, 'Read(!.env.sample)').status, 'ok')
    assert.equal(rule(c.j, 'Read(!.env.dist)').status, 'missing')
    assert.equal(rule(c.j, 'Read(./.env)').status, 'missing')
    const text = run(r, ['check']).out
    assert.match(text, /^~ worktree\.baseRef: "fresh" → "head"$/m)
    assert.match(text, /^↷ deny Read\(!\.env\.example\): moved right after Read\(\.\/\.env\.\*\)$/m)
    assert.doesNotMatch(text, /Bash\(git add \*\)/)
    const a = json(r, ['apply'])
    assert.equal(a.code, 0, a.out)
    const s = readJson(local(r))
    assert.equal(s.model, 'sonnet'); assert.deepEqual(s.worktree, { baseRef: 'head', symlinkDirectories: ['node_modules'] })
    assert.equal(s.permissions.allow[0], 'Bash(make *)')
    assert.equal(s.permissions.allow.filter(x => x === 'Bash(git add *)').length, 1, 'no duplicate')
    assert.ok(s.permissions.deny.includes('Bash(curl *)'))
    assert.ok(placed(s.permissions.deny), JSON.stringify(s.permissions.deny))
    assert.equal(json(r, ['check']).j.complete, true)
  })

  test('exceptions of the .env templates without Read(./.env.*) in the local file: misplaced; the rule added, they follow it', () => {
    const r = newRepo()
    write(local(r), { permissions: { deny: [...exceptions, 'Bash(curl *)'] } })
    const c = json(r, ['check'])
    assert.equal(rule(c.j, 'Read(./.env.*)').status, 'missing')
    for (const e of exceptions) assert.equal(rule(c.j, e).status, 'misplaced', e)
    run(r, ['apply'])
    const deny = readJson(local(r)).permissions.deny
    assert.ok(placed(deny), JSON.stringify(deny))
    assert.equal(deny.filter(x => x.startsWith('Read(!')).length, exceptions.length, 'no duplicate')
  })

  test('install of orchestre 0.11 (its real template and script rules): incomplete; the rules of 0.11 removed, the others completed', () => {
    const r = newRepo()
    const old = JSON.parse(JSON.stringify(TEMPLATE_011))
    old.permissions.allow.push(...['plan-lint.mjs', 'suivi.mjs', 'worktrees.mjs'].map(s => RULE(OLD_ROOT, s)), 'Bash(pnpm test *)')
    old.permissions.deny.push('Bash(railway *)')
    write(local(r), old)
    const c = json(r, ['check'])
    assert.equal(c.code, 1)
    assert.equal(c.j.first_install, false)
    assert.deepEqual(c.j.remove.map(x => [x.rule, x.reason]), [
      ['Workflow(orchestre:executer-phase)', 'orchestre 0.11 and earlier'],
      [RULE(OLD_ROOT, 'plan-lint.mjs'), 'orchestre 0.11.0'],
      [RULE(OLD_ROOT, 'suivi.mjs'), 'orchestre 0.11 and earlier'],
      [RULE(OLD_ROOT, 'worktrees.mjs'), 'orchestre 0.11.0'],
    ])
    for (const x of ['Workflow(orchestre:run-phase)', 'Bash(git for-each-ref *)', ...OWN]) assert.equal(rule(c.j, x).status, 'missing', x)
    assert.equal(rule(c.j, 'worktree.baseRef').status, 'ok')
    const t = run(r, ['check']).out
    assert.match(t, /^✗ settings incomplete for orchestre \d+\.\d+\.\d+: \.claude\/settings\.local\.json, \d+ to add or change, 4 to remove\n/)
    assert.match(t, /^− allow Workflow\(orchestre:executer-phase\) \(orchestre 0\.11 and earlier\)$/m)
    const a = run(r, ['apply'])
    assert.equal(a.code, 0)
    assert.match(a.out, /^✓ settings written for orchestre \d+\.\d+\.\d+: \.claude\/settings\.local\.json \(\d+ added or changed, 4 removed\)$/m)
    assert.match(a.out, /^− allow Workflow\(orchestre:executer-phase\) \(orchestre 0\.11 and earlier\)$/m)
    const s = readJson(local(r))
    assert.equal(s.permissions.allow.some(x => /executer-phase|suivi\.mjs|0\.11\.0/.test(x)), false)
    assert.ok(s.permissions.allow.includes('Bash(pnpm test *)') && s.permissions.deny.includes('Bash(railway *)'), 'rules of the project kept')
    assert.equal(s.autoContinueAtUsageLimit, true, 'a key of the user left in place')
    assert.equal(json(r, ['check']).j.complete, true)
  })

  test('older rules: another installed version and the manual install of v0.5 removed; a development copy of the plugin kept', () => {
    const r = newRepo()
    const v012 = '/Users/someone/.claude/plugins/cache/circle/orchestre/0.12.0'
    const dev = '/Users/someone/Projects/Circle Claude plugin/circle-claude-plugin/plugins/orchestre'
    const v06 = '/Users/someone/.claude/plugins/cache/circle/orchestre/0.6.3'
    // Kept: a development copy, scripts of the same names in another tool, a folder orchestre/ that is not the plugin cache
    const kept = [RULE(dev, 'plan-lint.mjs'), 'Bash(node /opt/other/scripts/progress.mjs *)', 'Bash(node /opt/other/scripts/suivi.mjs *)', RULE('/opt/orchestre/tools', 'plan-lint.mjs'), RULE('/opt/x/0.12.0', 'progress.mjs'), RULE('/opt/orchestre/other/0.12.0', 'progress.mjs')]
    write(local(r), { ...TEMPLATE, permissions: { allow: [...TEMPLATE.permissions.allow, ...OWN, RULE(v012, 'progress.mjs'), `Bash(node ${v06}/scripts/plan-lint.mjs:*)`, RULE(dev, 'etat.mjs'), 'Workflow(executer-phase)', 'Bash(node .claude/orchestre/plan-lint.mjs:*)', ...kept], deny: TEMPLATE.permissions.deny } })
    const c = json(r, ['check'])
    assert.deepEqual(c.j.remove.map(x => [x.rule, x.reason]), [
      [RULE(v012, 'progress.mjs'), 'orchestre 0.12.0'],
      [`Bash(node ${v06}/scripts/plan-lint.mjs:*)`, 'orchestre 0.6.3'],
      [RULE(dev, 'etat.mjs'), 'orchestre 0.11 and earlier'],
      ['Workflow(executer-phase)', 'manual install of v0.5 and earlier'],
      ['Bash(node .claude/orchestre/plan-lint.mjs:*)', 'manual install of v0.5 and earlier'],
    ])
    assert.equal(c.j.complete, false); assert.equal(c.code, 1)
    run(r, ['apply'])
    const s = readJson(local(r))
    for (const k of kept) assert.ok(s.permissions.allow.includes(k), k)
    assert.equal(json(r, ['check']).j.complete, true)
  })

  test('not valid JSON, or not settings: exit 2, the file and the error named, nothing written', () => {
    const cases = [
      [local, '{ "permissions": { "allow": [ } }', /not valid JSON/],
      [local, '[1, 2]', /not a JSON object/],
      [local, '{ "permissions": { "allow": "Bash(*)" } }', /"permissions\.allow" is not a list of rules/],
      [local, '{ "permissions": [] }', /"permissions" is not an object/],
      [user, '{ "permissions": ', /not valid JSON/],
      [project, '// comment\n{}', /not valid JSON/],
    ]
    for (const [file, text, re] of cases) {
      const r = newRepo()
      write(file(r), text)
      for (const mode of ['check', 'apply']) {
        const p = json(r, [mode])
        assert.equal(p.code, 2, `${mode} ${text}`)
        assert.equal(p.j.ok, false); assert.equal(p.j.complete, false)
        assert.ok(p.j.errors.some(e => re.test(e)), p.j.errors.join('; '))
        const t = run(r, [mode])
        assert.equal(t.code, 2)
        assert.match(t.out, re); assert.match(t.out, /^✗ nothing (checked|written): fix the file, then run the command again$/m)
      }
      assert.equal(readFileSync(file(r), 'utf8'), text, 'file unchanged')
      if (file !== local) assert.equal(existsSync(local(r)), false, 'nothing written next to it')
    }
  })

  test('a rule of an older install in the versioned project settings: reported, left in place; a settings file not valid JSON makes the check incomplete', () => {
    const r = newRepo()
    run(r, ['apply'])
    write(project(r), { permissions: { allow: ['Workflow(orchestre:executer-phase)'] } })
    const c = json(r, ['check'])
    assert.deepEqual(c.j.remove, [])
    assert.equal(c.j.complete, true)
    assert.match(c.j.warnings.join('\n'), /Workflow\(orchestre:executer-phase\) \(orchestre 0\.11 and earlier\): in the project settings/)
    run(r, ['apply'])
    assert.deepEqual(readJson(project(r)).permissions.allow, ['Workflow(orchestre:executer-phase)'])
    write(user(r), '{')
    const bad = json(r, ['check'])
    assert.deepEqual([bad.code, bad.j.ok, bad.j.complete], [2, false, false])
  })

  test('--team without a GitHub repository in plugin.json: refused, nothing written', () => {
    const base = tempDir('norepo-')
    for (const p of ['scripts', 'skills/install', '.claude-plugin']) cpSync(join(PLUGIN, p), join(base, p), { recursive: true })
    const m = readJson(join(base, '.claude-plugin', 'plugin.json')); delete m.repository
    writeFileSync(join(base, '.claude-plugin', 'plugin.json'), JSON.stringify(m))
    const r = newRepo()
    const p = json(r, ['apply', '--team'], { script: join(base, 'scripts', 'settings.mjs') })
    assert.equal(p.code, 2)
    assert.match(p.j.errors.join('\n'), /no GitHub repository in "repository"/)
    assert.equal(existsSync(local(r)), false)
    assert.equal(json(r, ['check'], { script: join(base, 'scripts', 'settings.mjs') }).code, 1, 'without --team, no repository needed')
  })

  test('--team: the marketplace and the plugin in .claude/settings.json, its keys kept; the rules stay local; without --team, not checked', () => {
    const r = newRepo()
    write(project(r), { enabledPlugins: { 'other@x': true }, extraKnownMarketplaces: { circle: { source: { source: 'github', repo: 'someone/fork' } } }, hooks: { Stop: [] } })
    const c = json(r, ['check', '--team'])
    assert.equal(c.code, 1); assert.equal(c.j.team, true)
    const repo = MANIFEST.repository.match(/github\.com\/(.+)$/)[1]
    assert.deepEqual(rule(c.j, 'extraKnownMarketplaces.circle'), { rule: 'extraKnownMarketplaces.circle', key: 'extraKnownMarketplaces.circle', expected: { source: { source: 'github', repo } }, found: { source: { source: 'github', repo: 'someone/fork' } }, status: 'wrong', scope: 'project' })
    assert.equal(rule(c.j, `enabledPlugins.${MANIFEST.name}@circle`).status, 'missing')
    assert.deepEqual(c.j.writes.map(w => w.path), ['.claude/settings.local.json', '.claude/settings.json'])
    const a = json(r, ['apply', '--team'])
    assert.equal(a.code, 0, a.out)
    assert.deepEqual(a.j.written, ['.claude/settings.local.json', '.claude/settings.json'])
    const p = readJson(project(r))
    assert.deepEqual(p, { enabledPlugins: { 'other@x': true, [`${MANIFEST.name}@circle`]: true }, extraKnownMarketplaces: { circle: { source: { source: 'github', repo } } }, hooks: { Stop: [] } })
    assert.equal(p.permissions, undefined, 'no rule in the versioned file')
    assert.equal(json(r, ['check', '--team']).j.complete, true)
    // A ref pinned by the team: kept, and the declaration counts as complete; another repository: fixed, the ref kept
    const q = readJson(project(r)); q.extraKnownMarketplaces.circle = { source: { source: 'github', repo: 'someone/fork', ref: 'v1' }, autoUpdate: true }; write(project(r), q)
    assert.equal(json(r, ['check', '--team']).j.complete, false)
    run(r, ['apply', '--team'])
    assert.deepEqual(readJson(project(r)).extraKnownMarketplaces.circle, { source: { source: 'github', repo, ref: 'v1' }, autoUpdate: true })
    assert.equal(json(r, ['check', '--team']).j.complete, true)
    // The plugin turned off in the versioned file: --team turns it on, after the line shown
    const q2 = readJson(project(r)); q2.enabledPlugins[`${MANIFEST.name}@circle`] = false; write(project(r), q2)
    const off = json(r, ['check', '--team'])
    assert.deepEqual([rule(off.j, `enabledPlugins.${MANIFEST.name}@circle`).status, rule(off.j, `enabledPlugins.${MANIFEST.name}@circle`).found], ['wrong', false])
    assert.match(run(r, ['check', '--team']).out, new RegExp(`^~ enabledPlugins\\.${MANIFEST.name}@circle: false → true$`, 'm'))
    run(r, ['apply', '--team'])
    assert.equal(readJson(project(r)).enabledPlugins[`${MANIFEST.name}@circle`], true)
    // Without --team, the project file is not required
    const r2 = newRepo()
    run(r2, ['apply'])
    const c2 = json(r2, ['check'])
    assert.equal(c2.j.complete, true); assert.equal(c2.j.team, false)
    assert.equal(existsSync(project(r2)), false)
  })

  test('never installed in this repository: "settings missing", even when the user settings hold rules of orchestre', () => {
    const r = newRepo()
    write(user(r), { permissions: { allow: ['Workflow(orchestre:run-phase)', ...OWN] } })
    const c = json(r, ['check'])
    assert.equal(c.j.first_install, true)
    assert.match(run(r, ['check']).out, /^✗ settings missing for orchestre /)
    // One rule of orchestre in the local file, of any version: an install to complete
    write(local(r), { permissions: { allow: [RULE('/x/.claude/plugins/cache/circle/orchestre/0.9.1', 'plan-lint.mjs')] } })
    assert.equal(json(r, ['check']).j.first_install, false)
    write(local(r), { permissions: { allow: ['Workflow(orchestre:run-phase)'] } })
    assert.equal(json(r, ['check']).j.first_install, false)
    // The rules of this version reached through another path (a symbolic link): installed, and nothing to remove
    write(local(r), { permissions: { allow: [RULE(`/x/.claude/plugins/cache/circle/orchestre/${MANIFEST.version}`, 'plan-lint.mjs')] } })
    const same = json(r, ['check'])
    assert.deepEqual([same.j.first_install, same.j.remove], [false, []])
  })

  test('scopes: rules of the user or project settings count, a scalar takes the highest scope, a deny elsewhere is reported', () => {
    const r = newRepo()
    write(user(r), { autoContinueAtUsageLimit: false, permissions: { allow: TEMPLATE.permissions.allow, deny: ['Bash(git commit *)', 'Read(./.env.*)', RULE(OLD_ROOT, 'suivi.mjs')] } })
    write(project(r), { worktree: { baseRef: 'fresh' }, permissions: { deny: ['Read(./.env.*)'] } })
    const c = json(r, ['check'])
    assert.equal(rule(c.j, 'Bash(git add *)').scope, 'user')
    assert.deepEqual(rule(c.j, 'worktree.baseRef'), { rule: 'worktree.baseRef', key: 'worktree.baseRef', expected: 'head', found: 'fresh', status: 'wrong', scope: 'project' })
    assert.equal(c.j.writes.length, 1)
    assert.deepEqual(c.j.writes[0].add['permissions.allow'], OWN, 'only what no scope has')
    // Read(./.env.*) and its exceptions in the local file itself, even when the user settings deny it
    assert.equal(rule(c.j, 'Read(./.env.*)').status, 'missing')
    const w = c.j.warnings.join('\n')
    assert.match(w, /Bash\(git commit \*\): also denied in the user settings/)
    assert.match(w, /Read\(\.\/\.env\.\*\): also denied in the user settings/)
    assert.match(w, /Read\(\.\/\.env\.\*\): also denied in the project settings/)
    assert.match(w, /autoContinueAtUsageLimit is false in the user settings/)
    assert.match(w, /suivi\.mjs \*\) \(orchestre 0\.11 and earlier\): in the user settings, which this script does not change/)
    assert.deepEqual(c.j.remove, [], 'nothing removed outside the local file')
    assert.equal(c.j.files[2].path, '~/settings.json', 'the user file under the home folder')
    run(r, ['apply'])
    assert.equal(readJson(local(r)).worktree.baseRef, 'head', 'the local scope wins over the project')
    assert.equal(readJson(project(r)).worktree.baseRef, 'fresh', 'the project file untouched')
    assert.deepEqual(readJson(local(r)).permissions.allow, OWN)
    const after = json(r, ['check'])
    assert.equal(after.j.complete, true); assert.equal(after.code, 0, 'warnings block nothing')
    assert.equal(readJson(user(r)).autoContinueAtUsageLimit, false, 'user settings never written')
  })

  test('--add: rules of the project checked and written with the model; a wrong --add refused, nothing written', () => {
    const r = newRepo()
    run(r, ['apply'])
    const add = JSON.stringify({ allow: ['Bash(pnpm test *)', 'Bash(git add *)'], deny: ['Bash(railway *)'], env: { PATH: '/opt/node/bin:/usr/bin' } })
    const c = json(r, ['check', '--add', add])
    assert.equal(c.code, 1)
    assert.deepEqual(c.j.rules.filter(x => x.added).map(x => [x.rule, x.status]), [['Bash(pnpm test *)', 'missing'], ['Bash(railway *)', 'missing'], ['env.PATH', 'missing']])
    assert.equal(rule(c.j, 'Bash(git add *)').added, undefined, 'a rule of the model is not counted twice')
    assert.equal(json(r, ['apply', '--add', add]).code, 0)
    const s = readJson(local(r))
    assert.equal(s.env.PATH, '/opt/node/bin:/usr/bin')
    assert.ok(s.permissions.allow.includes('Bash(pnpm test *)') && s.permissions.deny.includes('Bash(railway *)'))
    assert.equal(json(r, ['check', '--add', add]).j.complete, true)
    assert.equal(json(r, ['check']).j.complete, true)
    // A PATH that changes: shown, then written
    const add2 = JSON.stringify({ env: { PATH: '/new/bin' } })
    assert.match(run(r, ['check', '--add', add2]).out, /^~ env\.PATH: "\/opt\/node\/bin:\/usr\/bin" → "\/new\/bin"$/m)
    const before = readFileSync(local(r), 'utf8')
    for (const bad of ['{"allow": "Bash(x)"}', 'not json', '{"ask": []}', '{"env": {"PATH": 1}}', '{"allow": [""]}', '[]']) {
      const p = run(r, ['apply', '--add', bad])
      assert.equal(p.code, 2, bad); assert.match(p.err, /^settings: --add: /)
    }
    assert.equal(readFileSync(local(r), 'utf8'), before)
  })

  test('calls: usage refused with exit 2; outside a git repository, exit 2', () => {
    const r = newRepo()
    for (const args of [[], ['run'], ['check', 'apply'], ['check', '--force'], ['apply', '--add'], ['apply', '--add', '--team']]) {
      const p = run(r, args)
      assert.equal(p.code, 2, args.join(' ')); assert.match(p.err, /^settings: usage: settings\.mjs <check\|apply>/)
    }
    const outside = { d: tempDir('nogit-'), home: tempDir('home-') }
    const p = json(outside, ['check'])
    assert.equal(p.code, 2); assert.match(p.j.errors[0], /not in a git repository/)
  })

  test('write refused: exit 3, the file named, the advice for the sandbox, nothing changed', () => {
    const r = newRepo()
    write(join(r.d, '.claude'), 'a file where the folder goes\n')
    const p = run(r, ['apply'])
    assert.equal(p.code, 3)
    assert.match(p.err, /^settings: write refused for \.claude\/settings\.local\.json \(E[A-Z]+\)\. If the Bash sandbox of Claude Code is on, it refuses writes to its settings files: run the same command at the Claude Code prompt prefixed with ! \(outside the sandbox\), or in a terminal$/m)
    assert.equal(readFileSync(join(r.d, '.claude'), 'utf8'), 'a file where the folder goes\n')
  })

  test('from a linked worktree: the local settings of the main checkout, as Claude Code reads them', () => {
    const r = newRepo()
    git(r.d, 'worktree', 'add', '-q', '-b', 'other', join(r.d, '..', `${r.d.split('/').pop()}-wt`))
    tmp.push(join(r.d, '..', `${r.d.split('/').pop()}-wt`))
    const wt = join(r.d, '..', `${r.d.split('/').pop()}-wt`)
    assert.equal(run(r, ['apply'], { cwd: wt }).code, 0)
    assert.ok(existsSync(local(r)), 'written in the main checkout')
    assert.equal(existsSync(join(wt, '.claude', 'settings.local.json')), false)
    assert.equal(json(r, ['check']).j.complete, true)
  })

  test('tracked settings.local.json: reported', () => {
    const r = newRepo()
    write(local(r), {}); git(r.d, 'add', '-f', '.claude/settings.local.json'); git(r.d, 'commit', '-qm', 'tracked')
    const c = json(r, ['check'])
    assert.equal(c.j.files[0].tracked, true)
    assert.match(c.j.warnings.join('\n'), /tracked by git/)
    const before = readFileSync(join(r.d, '.git', 'info', 'exclude'), 'utf8')
    assert.equal(json(r, ['apply']).j.excluded, null, 'a tracked file is not excluded')
    assert.equal(readFileSync(join(r.d, '.git', 'info', 'exclude'), 'utf8'), before)
  })

  test('plugin root with a space, reached through a symbolic link: the rules name the root as the command typed it', () => {
    const base = tempDir('root-')
    const real = join(base, 'Circle Claude plugin', 'orchestre', MANIFEST.version)
    for (const p of ['scripts', 'skills/install', '.claude-plugin']) cpSync(join(PLUGIN, p), join(real, p), { recursive: true })
    const link = join(base, 'link')
    symlinkSync(real, link)
    const r = newRepo()
    const { j } = json(r, ['check'], { script: join(link, 'scripts', 'settings.mjs') })
    assert.equal(j.plugin_root, link)
    for (const s of SCRIPTS) assert.equal(rule(j, RULE(link, s)).status, 'missing')
    const viaReal = json(r, ['check'], { script: join(real, 'scripts', 'settings.mjs') })
    assert.ok(rule(viaReal.j, RULE(real, 'plan-lint.mjs')), 'the real path when typed')
    assert.equal(json(r, ['apply'], { script: join(real, 'scripts', 'settings.mjs') }).code, 0)
    assert.ok(readJson(local(r)).permissions.allow.includes(`Bash(node "${real}/scripts/progress.mjs" *)`), 'quoted, as the workflow runs it')
    // The same command as the workflow builds it (run-phase.js: node "<path>" when the path holds a space)
    const wf = readFileSync(join(PLUGIN, 'workflows', 'run-phase.js'), 'utf8')
    assert.match(wf, /const PROGRESS_CMD = PROGRESS && \(\/\\s\/\.test\(PROGRESS\) \? `node "\$\{PROGRESS\}"` : `node \$\{PROGRESS\}`\)/)
    assert.deepEqual(json(r, ['check'], { script: join(real, 'scripts', 'settings.mjs') }).j.remove, [])
    // The same version reached through the link: its rules are added, those of the real path are not taken for an older install
    const viaLink = json(r, ['check'], { script: join(link, 'scripts', 'settings.mjs') })
    assert.deepEqual(viaLink.j.remove, [])
    assert.equal(viaLink.j.first_install, false, 'installed, through the other path')
    assert.deepEqual(viaLink.j.rules.filter(x => x.status !== 'ok').map(x => x.rule), SCRIPTS.map(s => RULE(link, s)))
    // Another version under the same cache folder is
    const older = RULE(join(base, 'Circle Claude plugin', 'orchestre', '0.1.0'), 'progress.mjs')
    const s0 = readJson(local(r)); s0.permissions.allow.push(older); write(local(r), s0)
    assert.deepEqual(json(r, ['check'], { script: join(real, 'scripts', 'settings.mjs') }).j.remove.map(x => [x.rule, x.reason]), [[older, 'orchestre 0.1.0']])
  })

  test('JSON through a pipe: one complete line, and the source never calls process.exit()', () => {
    const r = newRepo()
    write(local(r), TEMPLATE_011)
    const p = spawnSync('sh', ['-c', `node "${SCRIPT}" check --json | cat`], { cwd: r.d, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: r.home } })
    const j = JSON.parse(p.stdout)
    assert.equal(j.complete, false)
    assert.equal(p.stdout.trim().split('\n').length, 1)
    // Over 64 KB: the whole line, and the exit code of an incomplete check
    const many = JSON.stringify({ allow: Array.from({ length: 2500 }, (_, i) => `Bash(tool-number-${i} --with-a-long-option *)`) })
    const big = spawnSync('sh', ['-c', `node "${SCRIPT}" check --json --add '${many}' | cat; exit 0`], { cwd: r.d, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: r.home } })
    assert.ok(big.stdout.length > 65536, `${big.stdout.length} bytes`)
    assert.equal(JSON.parse(big.stdout).rules.filter(x => x.added).length, 2500)
    const code = spawnSync('node', [SCRIPT, 'check', '--json', '--add', many], { cwd: r.d, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: r.home } })
    assert.equal(code.status, 1)
    assert.doesNotMatch(readFileSync(SCRIPT, 'utf8'), /process\.exit\(/)
  })

  console.log(`settings: ALL GREEN (${n} tests)`)
} finally {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
}
