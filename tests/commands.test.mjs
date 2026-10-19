// Contract between the commands of the orchestre plugin (skills/*/SKILL.md, format.md) and its engine: the workflow
// run-phase, the scripts, the agents and the plan format. The skills are prompts: this test reads what they cite (args,
// fields, statuses, options, scripts, rules, names) and checks it against the code, then runs the commands they give on
// plans written from format.md, from the toy repository and in the format of orchestre 0.11.
// Usage: node tests/commands.test.mjs
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { LEGACY, LEGEND } from '../plugins/orchestre/scripts/progress.mjs'
import { convertHandoff } from '../plugins/orchestre/scripts/migrate.mjs'
import { SCRIPTS as RULED } from '../plugins/orchestre/scripts/settings.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PLUGIN = join(ROOT, 'plugins', 'orchestre')
const SCRIPTS = join(PLUGIN, 'scripts')
const read = p => readFileSync(p, 'utf8')
const sorted = xs => [...new Set(xs)].sort()
const SKILLS = ['install', 'prepare', 'ready', 'run', 'status', 'done']
const text = Object.fromEntries(SKILLS.map(s => [s, read(join(PLUGIN, 'skills', s, 'SKILL.md'))]))
const FORMAT = read(join(PLUGIN, 'skills', 'prepare', 'format.md'))
const WF = read(join(PLUGIN, 'workflows', 'run-phase.js'))
const SRC = Object.fromEntries(['plan-lint', 'progress', 'worktrees', 'migrate', 'status', 'settings'].map(s => [s, read(join(SCRIPTS, `${s}.mjs`))]))
const AGENTS = sorted(readdirSync(join(PLUGIN, 'agents')).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)))
const RULE = s => `Bash(node \${CLAUDE_PLUGIN_ROOT}/scripts/${s} *)`

// Frontmatter of a skill: scalars, and lists of "  - item"
function frontmatter(t) {
  const m = t.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(m, 'frontmatter missing')
  const fm = {}
  let list = null
  for (const line of m[1].split('\n')) {
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && list) { fm[list].push(item[1].trim()); continue }
    const kv = line.match(/^([a-z-]+):\s*(.*)$/)
    if (!kv) continue
    if (kv[2] === '') { fm[kv[1]] = []; list = kv[1] } else { fm[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1'); list = null }
  }
  return { fm, body: t.slice(m[0].length) }
}
const FM = Object.fromEntries(SKILLS.map(s => [s, frontmatter(text[s])]))
// A numbered point of a skill, its sub-bullets included: from "<n>. <start>" to the next point or heading of the same level
function point(t, n, start) {
  const lines = t.split('\n')
  const i = lines.findIndex(l => l.startsWith(`${n}. ${start}`))
  assert.ok(i >= 0, `point "${n}. ${start}" not found`)
  let j = i + 1
  while (j < lines.length && !/^(\d+\. |#)/.test(lines[j])) j++
  return lines.slice(i, j).join('\n')
}
// Lines allowed to name what orchestre 0.11 and earlier called otherwise: detection, migration, manual install of v0.5
const legacyLine = l => /0\.11|manual install|v0\.5|migrate/i.test(l)
// Names of orchestre 0.11 and earlier (glossary 0.12.0)
const OLD = [/executer-phase/, /\bsuivi\.mjs\b/, /\betat\.mjs\b/, /\bSUIVI\.md\b/, /\bPREREQUIS\.md\b/, /\bsuivi\.json\b/, /\btaches\//, /\btache\//, /tâche/, /à-faire/, /fusionnée/, /besoin-humain/, /annulée/, /bloquée/, /échec/, /\barbitrages?\b/, /points_a_trancher/, /decisions_office/, /branche_(?:integration|base)/, /mode_par_defaut/, /parallelisme/, /corrections_max/, /\bescalade\b/, /\bpreparation(?:_partagee)?\b/, /\brelancer\b/, /prefixe_agents/, /\bdevia\b/, /systematique/, /\bhumain\b/, /\bmodele\b/, /raison_modele/, /depend_de/, /fichiers_possedes/, /definition_du_fini/, /\/orchestre:(?:installer|preparer|pret|lancer|etat)\b/, /\bgreffier\b/, /lecteur-plan/, /verificateur/, /evaluateur/, /integrateur/, /replanificateur/, /worker-isole/, /--equipe/, /--reprendre/, /--sans-repetition/, /\bdécision\b/, /\bgeste\b/, /\benvironnement\b/, /\bmajeur\b/, /\bmineur\b/, /Prompt de lancement/, /Hors périmètre/, /\bStatuts\b/, /Entrées/, /\bplan source\b/]
// What such a line may cite on purpose: files, branches, commits, keys and rules of 0.11 that the detection and the migration
// name. On such a line, these names, in a code span or between double quotes, are blanked before the checks; the rest of the
// line, other names of 0.11 included (a command, a status), is checked like any other
const CITABLE = [/executer-phase/, /\bsuivi\.mjs\b/, /\bsuivi\.json\b/, /\bSUIVI\.md\b/, /\bPREREQUIS\.md\b/, /\btaches\//, /\btache\//, /tâche <id> : /, /branche_(?:integration|base)/, /\.claude\/skills\/lancer/]
const scrub = l => (legacyLine(l) ? l.replace(/`[^`\n]*`|"[^"\n]*"/g, x => (CITABLE.some(re => re.test(x)) ? '``' : x)) : l)
const codeSpans = t => [...t.matchAll(/`([^`\n]+)`/g)].map(m => m[1])
// Options a script knows: the quoted '--x' of its source
const optionsOf = src => new Set([...src.matchAll(/'(--[a-z-]+)'/g)].map(m => m[1]))

const tmp = []
const tempDir = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); tmp.push(d); return d }
const node = (args, cwd) => { const r = spawnSync('node', args, { cwd, encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') } }
const gitIn = cwd => (...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const newRepo = prefix => {
  const d = tempDir(prefix), git = gitIn(d)
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(d, 'README.md'), 'x\n'); git('add', '.'); git('commit', '-qm', 'init')
  return { d, git }
}
const write = (base, files) => { for (const [f, c] of Object.entries(files)) { mkdirSync(join(base, f, '..'), { recursive: true }); writeFileSync(join(base, f), c) } }

let n = 0
const test = (name, fn) => { fn(); n++; console.log('ok ·', name) }

try {
  test('six commands in English: folders, names, descriptions, arguments, model invocation', () => {
    const dirs = readdirSync(join(PLUGIN, 'skills')).filter(d => statSync(join(PLUGIN, 'skills', d)).isDirectory())
    assert.deepEqual(sorted(dirs), sorted(SKILLS))
    const hints = { install: '[--team]', prepare: '<existing plan (file or folder) | goal of the plan>', ready: '<plan-dir> [--no-dry-run]', run: '<plan-dir> [--resume]', status: '[<plan-dir>]', done: '<plan-dir> review|decision <task|-> <text>' }
    for (const s of SKILLS) {
      const { fm, body } = FM[s]
      assert.equal(fm.name, s, `${s}: name`)
      assert.ok(fm.description && fm.description.includes(`/orchestre:${s}`), `${s}: description without /orchestre:${s}`)
      assert.equal(fm['argument-hint'], hints[s], `${s}: argument-hint`)
      for (const opt of hints[s].match(/--[a-z-]+/g) || []) assert.ok(body.includes(`\`${opt}\``), `${s}: option ${opt} not explained`)
      assert.equal(fm['disable-model-invocation'], s === 'prepare' ? undefined : 'true', `${s}: disable-model-invocation`)
    }
    assert.equal(FM.prepare.fm.model, 'opus')
  })

  test('scripts and files cited exist; each script a skill launches is in its allowed-tools, and only those', () => {
    for (const s of SKILLS) {
      const { fm, body } = FM[s]
      for (const m of text[s].matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([a-z-]+\.mjs)/g)) assert.ok(existsSync(join(SCRIPTS, m[1])), `${s}: unknown script ${m[1]}`)
      for (const m of text[s].matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([\w.-]+)/g)) assert.ok(existsSync(join(PLUGIN, 'skills', s, m[1])), `${s}: unknown file ${m[1]}`)
      const launched = [...body.matchAll(/(?<!Bash\()node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([a-z-]+\.mjs)/g)].map(m => m[1])
      const allowed = (fm['allowed-tools'] || []).map(r => r.match(/^Bash\(node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/([a-z-]+\.mjs) \*\)$/)).filter(Boolean).map(m => m[1])
      assert.deepEqual(sorted(launched), sorted(allowed), `${s}: scripts launched and allowed`)
      // Commands of the body run by the skill itself, without a rule in the settings
      for (const [cmd, rule] of [['git branch --list ', 'Bash(git branch --list *)'], ['test -e ', 'Bash(test -e *)'], ['date +', 'Bash(date *)']]) {
        if (codeSpans(body).some(c => c.startsWith(cmd))) assert.ok((fm['allowed-tools'] || []).includes(rule), `${s}: ${rule} missing from allowed-tools`)
      }
    }
    assert.ok(text.status.includes('!`node ${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs $ARGUMENTS`'), 'status: injected command')
  })

  test('agents: /orchestre:run lists exactly the agents of the plugin; any orchestre:<x> cited exists', () => {
    const listed = [...point(text.run, 2, 'Plugin:').matchAll(/`orchestre:([a-z-]+)`/g)].map(m => m[1])
    assert.deepEqual(sorted(listed), AGENTS)
    const known = new Set([...AGENTS, 'run-phase', ...SKILLS])
    for (const s of SKILLS) for (const l of text[s].split('\n').map(scrub)) {
      for (const m of l.matchAll(/orchestre:([a-z][a-z-]*)/g)) assert.ok(known.has(m[1]), `${s}: unknown orchestre:${m[1]}`)
    }
    assert.match(WF, /export const meta = \{\s*name: 'run-phase'/)
    assert.ok(text.run.includes('workflow `orchestre:run-phase` (Workflow tool, parameter `name`)'))
  })

  test('/orchestre:run passes exactly the args the workflow reads, the required ones included', () => {
    const m = text.run.match(/with `args`: `\{ ([a-z_, ]+) \}`/)
    assert.ok(m, 'args list not found')
    const passed = m[1].split(/,\s*/)
    const readByWf = [...WF.matchAll(/\bA\.([a-z_]+)/g)].map(x => x[1])
    assert.deepEqual(sorted(passed), sorted(readByWf))
    const required = WF.match(/args required: ([a-z_, ]+)'/)[1].split(/,\s*/)
    for (const a of required) assert.ok(passed.includes(a), `required arg ${a} not passed`)
    for (const a of ['lint', 'progress', 'agent_prefix', 'language', 'setup', 'shared_setup', 'max_auto_decisions', 'rulings', 'rerun']) assert.ok(text.run.includes(`\`${a}\`:`) || text.run.includes(`\`${a}\` and \``), `arg ${a} not explained`)
    const modes = WF.match(/if \(!\[([^\]]+)\]\.includes\(MODE\)\)/)[1].split(/,\s*/).map(x => x.replace(/'/g, ''))
    assert.deepEqual(modes, ['auto', 'deviation', 'phase'])
    assert.ok(text.run.includes('`auto` (autonomous), `deviation` (stop on deviation) or `phase` (stop at each phase), exactly'))
    assert.ok(text.run.includes('`agent_prefix`: `orchestre:`'))
    assert.ok(text.run.includes('`lint`: `${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs`') && text.run.includes('`progress`: `${CLAUDE_PLUGIN_ROOT}/scripts/progress.mjs`'))
  })

  test('/orchestre:run reads the statuses and fields of the return value: stop_issue, open_issues, progress_failures, repair and stop…', () => {
    const statuses = Object.values(LEGACY.runStatus).filter(s => !['in-progress', 'interrupted'].includes(s))
    for (const s of statuses) assert.ok(WF.includes(`'${s}'`), `status ${s} not in the workflow`)
    const handled = [...point(text.run, 4, 'On receiving the report').matchAll(/^\s+- `([a-z-]+)`(?:, or a run interrupted)?:/gm)].map(m => m[1])
    assert.deepEqual(sorted(handled), sorted(statuses))
    const FIELDS = ['status', 'detail', 'stop_issue', 'open_issues', 'progress_failures', 'auto_decisions', 'discarded_amendments', 'rulings_applied', 'worktrees', 'waiting', 'waiting_on_prerequisites', 'deferred', 'added_tasks', 'reviews', 'rejections', 'unverifiable', 'blocker', 'branch', 'circuit_breaker', 'inconsistency', 'human']
    for (const f of FIELDS) {
      assert.ok(text.run.includes(`\`${f}\``), `field ${f} not read by /orchestre:run`)
      assert.match(WF, new RegExp(`\\b${f}\\b`), `field ${f} not in the workflow`)
    }
    // Any snake_case name the skill cites: an arg, a config key, a field above, or a name of the workflow or of plan-lint
    for (const l of text.run.split('\n').map(scrub)) {
      for (const m of l.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) assert.ok(new RegExp(`\\b${m[1]}\\b`).test(WF) || SRC['plan-lint'].includes(m[1]) || FORMAT.includes(`"${m[1]}"`), `unknown name ${m[1]} in /orchestre:run`)
    }
    // progress_failures[] { task, step, error }
    assert.match(WF, /progressFailures\.push\(\{ task[^}]*\bstep\b[^}]*\berror\b/)
    assert.ok(text.run.includes('(`task`, `step`, `error`)'))
    // Post-merge check: the options of the workflow, by their ids
    const ids = WF.match(/title: `Post-merge check failed[^\n]*?options: \[\{ id: '([a-z]+)'[^\n]*?\{ id: '([a-z]+)'/)
    assert.ok(ids, 'options of the post-merge check not found in the workflow')
    assert.deepEqual([ids[1], ids[2]], ['repair', 'stop'])
    assert.match(text.run, /options `repair` \(recommended\) and `stop`[^\n]*on `repair`, repair here, on the integration branch[^\n]*on `stop`, go to the end/)
    // Run not opened
    assert.ok(WF.includes('detail: `progress: run not opened'))
    assert.ok(text.run.includes('A `detail` that starts with "progress: run not opened"'))
    // Rulings, and the free answer
    assert.ok(text.run.includes('`rulings`: the options the user chose since the last report, `[{ task, title, option }]`'))
    for (const k of ['a.task', 'a.title', 'a.option.id']) assert.ok(WF.includes(k), `rulings: ${k} not read by the workflow`)
    assert.ok(text.run.includes('A free answer, "Other" included, is passed as the option `{ id: "human", description: <answer> }`'))
  })

  test('script commands of the skills: subcommands and options known to each script', () => {
    const progressCommands = SRC.progress.match(/usage: progress\.mjs <([a-z|-]+)>/)[1].split('|')
    const OPTS = Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, optionsOf(v)]))
    for (const s of SKILLS) for (const span of codeSpans(text[s])) {
      const m = span.match(/scripts\/([a-z-]+)\.mjs (.*)$/)
      if (!m || span.startsWith('Bash(')) continue
      const [, script, rest] = m
      for (const o of rest.match(/--[a-z-]+/g) || []) assert.ok(OPTS[script].has(o), `${s}: ${script}.mjs does not know ${o} (\`${span}\`)`)
      const sub = rest.match(/^([a-z][a-z-]*)/)
      if (script === 'progress') assert.ok(sub && progressCommands.includes(sub[1]), `${s}: progress.mjs ${sub && sub[1]}`)
      if (script === 'worktrees') assert.equal(sub && sub[1], 'clean', `${s}: worktrees.mjs ${sub && sub[1]}`)
      if (script === 'settings') assert.ok(sub && ['check', 'apply'].includes(sub[1]), `${s}: settings.mjs ${sub && sub[1]}`)
    }
    for (const s of ['run', 'ready']) {
      for (const o of ['`--write`', '`--write --run-stopped`']) assert.ok(text[s].includes(o), `${s}: ${o}`)
      assert.ok(text[s].includes('scripts/migrate.mjs <plan>`'), `${s}: migrate.mjs`)
    }
    assert.ok(text.run.includes('run it again with `--run-stopped`') && OPTS.worktrees.has('--run-stopped'))
    assert.ok(text.ready.includes('worktrees.mjs clean <plan> --dry-run`'))
  })

  test('settings: one script, settings.mjs, for /install, /prepare, /ready and /run; its headers are those the skills read', () => {
    // The model holds the rules of the scripts the workflow's agents run: plan-lint (lint), progress, worktrees (derived from it)
    assert.deepEqual(sorted(RULED), ['plan-lint.mjs', 'progress.mjs', 'worktrees.mjs'])
    assert.ok(WF.includes('worktrees.mjs'))
    // The rules of 0.11 and of other versions are the script's business, no longer written in the skills
    for (const old of ['executer-phase', 'suivi.mjs', 'etat.mjs']) assert.ok(SRC.settings.includes(old), `settings.mjs: ${old}`)
    for (const s of SKILLS) {
      assert.ok(!text[s].includes('settings.local.template.json'), `${s}: template merged by hand`)
      for (const script of RULED) assert.ok(!text[s].includes(`\`${RULE(script)}\``), `${s}: rule of ${script} written in the skill`)
    }
    for (const s of ['install', 'prepare', 'ready', 'run']) {
      assert.ok(text[s].includes('`node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs check`') || text[s].includes('`node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs` (below, `settings.mjs`)'), `${s}: settings.mjs check`)
      assert.ok(text[s].includes('`settings.mjs apply`'), `${s}: settings.mjs apply`)
    }
    assert.ok(text.install.includes('`settings.mjs check` (plus `--team` if given)') && text.install.includes('with the same arguments (`--add`, `--team`)'))
    // The three headers, as the script prints them, quoted by /prepare, /ready and /run
    const r = newRepo('settings-')
    const env = { ...process.env, CLAUDE_CONFIG_DIR: tempDir('home-') }
    const out = () => spawnSync('node', [join(SCRIPTS, 'settings.mjs'), 'check'], { cwd: r.d, encoding: 'utf8', env }).stdout
    const missing = out()
    mkdirSync(join(r.d, '.claude'), { recursive: true })
    writeFileSync(join(r.d, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Workflow(orchestre:executer-phase)'] } }))
    const incomplete = out()
    spawnSync('node', [join(SCRIPTS, 'settings.mjs'), 'apply'], { cwd: r.d, encoding: 'utf8', env })
    const complete = out()
    for (const [h, o] of [['settings missing', missing], ['settings incomplete', incomplete], ['settings complete', complete]]) {
      assert.ok(o.startsWith(`${h.startsWith('settings complete') ? '✓' : '✗'} ${h} for orchestre `), `${h}: ${o.split('\n')[0]}`)
      for (const s of ['prepare', 'ready', 'run']) assert.ok(text[s].includes(`- "${h}`), `${s}: case "${h}"`)
    }
    // /ready and /run: "missing" stops and sends to /orchestre:install; "incomplete" is written on the spot after agreement
    for (const [s, n] of [['ready', 2], ['run', 3]]) {
      const p = point(text[s], n, 'Settings:')
      assert.match(p, /- "settings missing"[^\n]*Stop[^\n]*`\/orchestre:install`/)
      assert.match(p, /- "settings incomplete"[^\n]*question tool[^\n]*`settings\.mjs apply`[^\n]*If the user declines: stop[^\n]*`\/orchestre:install`/)
      assert.ok(!p.includes('/orchestre:prepare'), `${s}: sends to /orchestre:prepare`)
      assert.match(p, /Exit code 3[^\n]*`!`/)
    }
    // /prepare: "missing" does the sections 1 to 5 of /install; declined, the preparation goes on
    assert.ok(text.prepare.includes('Read `${CLAUDE_PLUGIN_ROOT}/skills/install/SKILL.md` and do its sections 1 to 5, as `/orchestre:install` without `--team`'))
    for (const n of [1, 2, 3, 4, 5]) assert.match(text.install, new RegExp(`^## ${n}\\. `, 'm'))
    assert.match(text.prepare, /The user declines the install or the write: go on preparing the plan/)
    for (const t of FM.install.fm['allowed-tools']) assert.ok(FM.prepare.fm['allowed-tools'].includes(t), `prepare: ${t} of /install missing from allowed-tools`)
  })

  test('no name of orchestre 0.11 outside the lines about detection, migration or the manual install', () => {
    const files = { ...Object.fromEntries(SKILLS.map(s => [`${s}/SKILL.md`, text[s]])), 'prepare/format.md': FORMAT, 'install/settings.local.template.json': read(join(PLUGIN, 'skills', 'install', 'settings.local.template.json')), 'tests/toy-repo.sh': read(join(ROOT, 'tests', 'toy-repo.sh')) }
    for (const [f, t] of Object.entries(files)) {
      let manualInstall = false
      for (const [i, l] of t.split('\n').entries()) {
        if (/^## /.test(l)) manualInstall = f === 'install/SKILL.md' && /^## 5\. Old manual install/.test(l)
        if (manualInstall) continue
        for (const re of OLD) assert.ok(!re.test(scrub(l)), `${f}:${i + 1}: name of 0.11 ${re}: ${l.trim().slice(0, 120)}`)
      }
    }
  })

  test('format.md says the format the scripts read and migrate.mjs writes', () => {
    const blocks = [...FORMAT.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map(m => ({ lang: m[1], body: m[2] }))
    const block = start => { const b = blocks.find(x => x.body.startsWith(start)); assert.ok(b, `block "${start}" not found in format.md`); return b.body }
    // Task template: keys and body sections
    const task = block('---\nid: T01')
    const keys = [...task.split('---')[1].matchAll(/^([a-z_]+):/gm)].map(m => m[1])
    assert.deepEqual(sorted(keys), sorted(['id', 'phase', 'effort', 'verification', ...Object.values(LEGACY.taskKeys)]))
    assert.deepEqual([...task.matchAll(/^## (.+)$/gm)].map(m => m[1]), Object.values(LEGACY.taskSections))
    assert.match(task, /on the branch task\/T01\./)
    // PROGRESS.md: title, columns, legend
    const progress = block('# PROGRESS — <name>')
    const header = progress.split('\n').find(l => l.startsWith('| ID'))
    assert.deepEqual(header.split('|').slice(1, -1).map(c => c.trim()), Object.values(LEGACY.progressColumns))
    assert.ok(progress.includes(`\n${LEGEND}\n`))
    // PREREQUISITES.md: columns, types and statuses
    const prereq = block('# PREREQUISITES — <name>')
    assert.deepEqual(prereq.split('\n').find(l => l.startsWith('| ID')).split('|').slice(1, -1).map(c => c.trim()), Object.values(LEGACY.prerequisiteColumns))
    assert.ok(prereq.includes(`Types: ${Object.values(LEGACY.prerequisiteType).join(' · ')}. Statuses: ${[...new Set(Object.values(LEGACY.prerequisiteStatus))].join(' · ')}.`))
    // HANDOFF.md: the "Entries:" line that migrate.mjs writes from the one of 0.11
    const handoff = block('# HANDOFF — <name>')
    const entries = convertHandoff('Entrées : `écart`, `angle-mort`, `décision`, `dette`, `besoin-humain`, `ticket`, `relecture`, classées `mineur` ou `majeur`.\n', {})
    assert.equal(handoff.split('\n')[1], entries.trim())
    const added = Object.values(LEGACY.handoffType).filter(t => !entries.includes(`\`${t}\``))
    assert.ok(FORMAT.includes(`also adds the types ${added.slice(0, -1).map(t => `\`${t}\``).join(', ')} and \`${added.at(-1)}\``), 'types added during a run')
    // DISCOVERY.md
    const discovery = block('# DISCOVERY — <name>')
    assert.deepEqual([...discovery.matchAll(/^## (.+)$/gm)].map(m => m[1]), Object.values(LEGACY.discoverySections).filter(s => s !== 'Context recommendations'))
    // orchestre.config.json: the keys of 0.12, and the values plan-lint accepts
    const config = JSON.parse(blocks.find(b => b.lang === 'json').body)
    assert.deepEqual(sorted(Object.keys(config)), sorted([...Object.values(LEGACY.configKeys), 'fable', 'language']))
    assert.equal(config.evaluator, 'always'); assert.equal(config.language, 'en'); assert.equal(config.integration_branch, 'plan/<name>')
    // /orchestre:run reads every key of the config it uses (evaluator is indicative, fable is for plan-lint)
    const p5 = point(text.run, 5, 'Read `orchestre.config.json`')
    for (const k of Object.keys(config).filter(k => !['evaluator', 'fable'].includes(k))) assert.ok(p5.includes(`\`${k}\``), `/orchestre:run does not read ${k}`)
  })

  test('a plan assembled from the templates of format.md: plan-lint, progress.mjs and migrate.mjs accept it', () => {
    const blocks = [...FORMAT.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map(m => m[2])
    const b = start => blocks.find(x => x.startsWith(start)).replace(/<name>/g, 'demo')
    const { d, git } = newRepo('format-')
    const config = JSON.parse(b('{'))
    config.setup = ['npm ci']; config.shared_setup = { db: ['npm run db:test'] }
    write(join(d, 'plans', 'demo'), {
      'tasks/T01-example.md': b('---\nid: T01').replace(/^title: …$/m, 'title: Example task').replace('model_reason: "…"', 'model_reason: "example"').replace('resources: []', 'resources: [db]').replace('prerequisites: []', 'prerequisites: [D5, E1]'),
      'PROGRESS.md': b('# PROGRESS').replace('| T01 | …     |', '| T01 | Example task |'),
      'PREREQUISITES.md': b('# PREREQUISITES'),
      'HANDOFF.md': b('# HANDOFF'),
      'DISCOVERY.md': b('# DISCOVERY'),
      'orchestre.config.json': JSON.stringify(config, null, 2) + '\n',
    })
    git('switch', '-qc', 'plan/demo'); git('add', '.'); git('commit', '-qm', 'plan(demo): initial plan')
    const lint = node([join(SCRIPTS, 'plan-lint.mjs'), 'plans/demo', '--json', '--integration', 'plan/demo'], d)
    const j = JSON.parse(lint.out)
    assert.deepEqual(j.errors, [], lint.out)
    assert.equal(j.language, 'en')
    assert.deepEqual(j.prerequisites.map(x => [x.id, x.type, x.status]), [['D5', 'decision', 'open'], ['H1', 'manual', 'done'], ['E1', 'environment', 'open']])
    assert.deepEqual(j.tasks[0].open_prerequisites, ['D5', 'E1'])
    const view = node([join(SCRIPTS, 'progress.mjs'), 'view', 'plans/demo', '--stdout'], d)
    assert.equal(view.code, 0, view.out)
    assert.ok(view.out.includes('| T01 | Example task |') && view.out.includes(LEGEND))
    // The row of format.md is the one progress.mjs writes from the task of format.md, cell by cell
    const row = t => t.split('\n').find(l => l.startsWith('| T01 ')).split('|').slice(1, -1).map(c => c.trim())
    assert.deepEqual(row(read(join(d, 'plans', 'demo', 'PROGRESS.md'))), row(view.out))
    const mig = node([join(SCRIPTS, 'migrate.mjs'), 'plans/demo'], d)
    assert.equal(mig.code, 0, mig.out); assert.match(mig.out, /nothing to migrate/)
  })

  test('toy repository: English plan accepted by plan-lint; the commands of the skills run on it as written', () => {
    const d = join(tempDir('toy-'), 'repo')
    const r = spawnSync('sh', [join(ROOT, 'tests', 'toy-repo.sh'), d], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /\/orchestre:install, a new session, and \/orchestre:run plans\/demo/)
    const git = gitIn(d)
    git('switch', '-q', 'plan/demo')
    const lint = node([join(SCRIPTS, 'plan-lint.mjs'), 'plans/demo', '--json', '--integration', 'plan/demo'], d)
    const j = JSON.parse(lint.out)
    assert.equal(j.ok, true, lint.out); assert.deepEqual(j.warnings, []); assert.equal(j.language, 'en'); assert.equal(j.fable, false)
    assert.deepEqual(j.tasks.map(t => [t.id, t.model, t.status]), [['T01', 'haiku', 'todo']])
    // The view regenerated is the file as written: no drift at the first pre-flight
    const view = node([join(SCRIPTS, 'progress.mjs'), 'view', 'plans/demo', '--stdout'], d)
    assert.equal(view.out, read(join(d, 'plans', 'demo', 'PROGRESS.md')))
    assert.match(node([join(SCRIPTS, 'migrate.mjs'), 'plans/demo'], d).out, /nothing to migrate/)
    assert.equal(node([join(SCRIPTS, 'worktrees.mjs'), 'clean', 'plans/demo', '--dry-run'], d).code, 0)
    assert.match(node([join(SCRIPTS, 'status.mjs'), 'plans/demo'], d).out, /^## demo — 0\/1 task/)
    assert.equal(node([join(SCRIPTS, 'progress.mjs'), 'status', 'plans/demo'], d).code, 0)
    // The pilot's action, with the JSON of /orchestre:run
    const pilot = text.run.match(/progress\.mjs pilot <plan> --json '(\{[^']+\})'/)
    assert.ok(pilot, 'pilot command not found')
    const json = pilot[1].replace('<id>', 'T01').replace('<reason>', 'merged by hand in the test')
    assert.deepEqual(Object.keys(JSON.parse(json)), ['task', 'status', 'reason'])
    const p = node([join(SCRIPTS, 'progress.mjs'), 'pilot', 'plans/demo', '--json', json], d)
    assert.equal(p.code, 0, p.out)
    assert.match(read(join(d, 'plans', 'demo', 'PROGRESS.md')), /\| T01 \| Hello script \|.*\| merged \|/)
    // An apostrophe in the reason, written \u0027 as the skill says, through the shell's single quotes
    assert.ok(text.run.includes('No apostrophe in the reason, or written `\\u0027`.'))
    const quoted = pilot[1].replace('<id>', 'T01').replace('"merged"', '"cancelled"').replace('<reason>', 'the user\\u0027s choice')
    const sh = spawnSync('sh', ['-c', `node "${join(SCRIPTS, 'progress.mjs')}" pilot plans/demo --json '${quoted}'`], { cwd: d, encoding: 'utf8' })
    assert.equal(sh.status, 0, sh.stderr)
    assert.ok(JSON.parse(read(join(d, 'plans', 'demo', 'progress.json'))).log.some(e => e.kind === 'pilot' && e.text.includes("the user's choice")))
  })

  test('a plan of 0.11: the skills detect what plan-lint refuses; migrate.mjs, as they run it, converts it and keeps tache/*', () => {
    // Detection: the files plan-lint refuses next to tasks/, and taches/
    const nextTo = SRC['plan-lint'].match(/for \(const f of \[([^\]]+)\]\) if \(existsSync\(join\(dir, f\)\)\)/)[1].split(/,\s*/).map(x => x.replace(/'/g, ''))
    for (const s of ['run', 'ready']) {
      const sentence = text[s].split('\n').find(l => l.includes('is still in the French format of orchestre 0.11 or earlier'))
      assert.ok(sentence, `${s}: detection sentence`)
      for (const f of ['`<plan>/taches/`', ...nextTo.map(f => `\`${f}\``), '`<plan>/tasks/`']) assert.ok(sentence.includes(f), `${s}: ${f} not detected`)
    }
    const french = {
      'taches/T01-bonjour.md': '---\nid: T01\ntitre: Script bonjour\nphase: 1\nmodele: haiku\nraison_modele: mécanique\neffort: low\ndepend_de: []\nfichiers_possedes:\n  - src/bonjour.sh\nressources: []\nestimation_tokens: 0.2M\nverification:\n  - "sh src/bonjour.sh"\ndefinition_du_fini:\n  - "src/bonjour.sh affiche bonjour"\n---\n\n## Prompt de lancement\nTu réalises T01 sur la branche tache/T01.\n',
      'SUIVI.md': '| ID  | Titre          | Phase | Lot | Dépend de | Modèle | Statut  | Essais | Branche | Tokens est. / réels |\n|-----|----------------|-------|-----|-----------|--------|---------|--------|---------|---------------------|\n| T01 | Script bonjour | 1     | 1A  | —         | haiku  | bloquée | 1      | tache/T01 | 0,2 M / —           |\n\nStatuts : à-faire · ajoutée · fusionnée · bloquée · échec · besoin-humain · annulée\n',
      'HANDOFF.md': '# HANDOFF — demo\nEntrées : `écart`, `angle-mort`, `décision`, `dette`, `besoin-humain`, `ticket`, classées `mineur` ou `majeur`.\n',
      'PREREQUIS.md': '# PREREQUIS — demo\n\n| ID | Type | Prérequis | Statut | Preuve |\n|----|------|-----------|--------|--------|\n',
      'DISCOVERY.md': '# DISCOVERY — demo\n## Contexte existant\n',
      'orchestre.config.json': '{ "parallelisme_max": 1, "mode_par_defaut": "devia", "branche_integration": "plan/demo", "evaluateur": "systematique" }\n',
    }
    // Each case of the detection is refused by plan-lint, which names migrate.mjs
    for (const extra of [null, ...nextTo]) {
      const { d, git } = newRepo('legacy-')
      write(join(d, 'plans', 'demo'), extra ? { 'tasks/T01-x.md': '---\nid: T01\ntitle: x\nphase: 1\nverification:\n  - "true"\ndefinition_of_done:\n  - "x"\n---\n', 'orchestre.config.json': '{}', [extra]: extra.endsWith('.json') ? '{}' : '| ID | Statut |\n' } : french)
      git('add', '.'); git('commit', '-qm', 'plan')
      const lint = node([join(SCRIPTS, 'plan-lint.mjs'), 'plans/demo'], d)
      assert.notEqual(lint.code, 0, `plan-lint accepts ${extra || 'taches/'}`)
      assert.match(lint.out, /migrate\.mjs/, `plan-lint does not name migrate.mjs for ${extra || 'taches/'}`)
    }
    // The migration as the pre-flight runs it: on the integration branch, preview, then --write; tache/* stays
    const { d, git } = newRepo('migration-')
    write(join(d, 'plans', 'demo'), french)
    git('switch', '-qc', 'plan/demo'); git('add', '.'); git('commit', '-qm', 'plan(demo) : plan initial')
    git('branch', 'tache/T01')
    const preview = node([join(SCRIPTS, 'migrate.mjs'), 'plans/demo'], d)
    assert.equal(preview.code, 0, preview.out)
    assert.ok(existsSync(join(d, 'plans', 'demo', 'taches')), 'the preview wrote')
    const w = node([join(SCRIPTS, 'migrate.mjs'), 'plans/demo', '--write'], d)
    assert.equal(w.code, 0, w.out)
    const message = SRC.migrate.match(/const message = `([^`]+)`/)[1].replace('${ctx.name}', '<name>')
    for (const s of ['run', 'ready']) assert.ok(text[s].includes(`\`${message}\``), `${s}: commit message of migrate.mjs`)
    assert.equal(git('log', '-1', '--format=%s'), message.replace('<name>', 'demo') + '\n')
    const lint = JSON.parse(node([join(SCRIPTS, 'plan-lint.mjs'), 'plans/demo', '--json', '--integration', 'plan/demo'], d).out)
    assert.equal(lint.ok, true, JSON.stringify(lint.errors)); assert.equal(lint.language, 'fr')
    // The text of the task names task/T01; the Branch cell keeps the branch git really has, tache/T01
    assert.match(read(join(d, 'plans', 'demo', 'tasks', 'T01-bonjour.md')), /sur la branche task\/T01\./)
    assert.match(read(join(d, 'plans', 'demo', 'PROGRESS.md')), /\| tache\/T01 \|/)
    // The branch of git keeps its name: the command of the skills finds it
    const cmd = text.run.match(/`git branch --list "tache\/\*" --no-merged <integration branch>`/)
    assert.ok(cmd && text.ready.includes(cmd[0]))
    assert.equal(git('branch', '--list', 'tache/*', '--no-merged', 'plan/demo').trim(), '')
    git('switch', '-qc', 'tache/T02'); writeFileSync(join(d, 'x.txt'), 'x'); git('add', '.'); git('commit', '-qm', 'feat: x'); git('switch', '-q', 'plan/demo')
    assert.equal(git('branch', '--list', 'tache/*', '--no-merged', 'plan/demo').trim(), 'tache/T02')
    // Fix here on its branch: this run's task/<id>*, then, for a plan migrated from 0.11, tache/<id>*, the most recent
    assert.ok(text.run.includes('If `branch` is null or missing from git, take the most recent of `git branch --list "task/<id>*" --sort=-committerdate`; if there is none, for a plan migrated from orchestre 0.11, the most recent of `git branch --list "tache/<id>*" --sort=-committerdate`'))
    assert.ok(text.run.includes('first brought up to date with the integration branch (`git merge <integration branch>`, never a rebase)'))
  })

  test('pre-flight: the migration comes before every script that refuses a plan of 0.11; one confirmation of a stopped run', () => {
    const nothing = SRC.migrate.match(/already in the 0\.12 format, nothing to migrate/)
    assert.ok(nothing)
    for (const s of ['run', 'ready']) {
      const t = text[s]
      const at = x => { const i = t.indexOf(x); assert.ok(i >= 0, `${s}: ${x} not found`); return i }
      const migration = at('scripts/migrate.mjs <plan>`, from the main checkout, on the integration branch.')
      for (const x of ['worktrees.mjs clean <plan>', 'plan-lint.mjs <plan> --', ...(s === 'run' ? ['progress.mjs view <plan>'] : [])]) assert.ok(migration < at(x), `${s}: ${x} comes before the migration`)
      assert.ok(t.includes(`if it answers "${nothing[0]}", go on`), `${s}: answer of the preview`)
      assert.ok(t.includes('If the user declines'), `${s}: refusal of the migration`)
      assert.ok(at('scripts/settings.mjs check`') < migration, `${s}: the settings are checked before the migration`)
    }
    const prep = x => { const i = text.prepare.indexOf(x); assert.ok(i >= 0, `prepare: ${x}`); return i }
    assert.ok(prep('- A git repository on its base branch') < prep('scripts/settings.mjs check`') && prep('scripts/settings.mjs check`') < prep('- Name of the plan:'), 'prepare: the install after the git check, before the name of the plan')
    assert.ok(prep('A folder `plans/<name>/` already written for orchestre is not a plan to convert') < prep('scripts/settings.mjs check`'))
    // /run: the stopped run confirmed at the migration also holds for worktrees.mjs; /ready: the confirmation at the start holds
    assert.ok(text.run.includes('run it again with `--write --run-stopped`, and that answer also holds for `worktrees.mjs clean` at point 6'))
    assert.ok(text.run.includes('If the user said at the migration (point 4) that the run is stopped, run it with `--run-stopped` straight away.'))
    assert.ok(text.ready.includes('the user confirmed at the start that no run is active, so run it again with `--write --run-stopped`'))
    assert.ok(text.ready.includes('Never during a run of the orchestrator: first have the user confirm that no run is active'))
    // /ready migrates on the integration branch only
    assert.ok(text.ready.includes('If the integration branch does not exist yet, do not migrate'))
    // Language before the plan's is known
    for (const s of ['run', 'ready']) assert.ok(text[s].includes('and for a plan of orchestre 0.11 not migrated yet, talk to the user in the language of the conversation'), `${s}: language before the migration`)
  })

  test('commit messages and fixed lines: the names validated for 0.12, consistent with the scripts and the workflow', () => {
    const NAMES = {
      install: ['`chore: exclude plans/ and .claude/ from the formatter and linter`', '`chore: remove the manual install of the orchestrator (replaced by the orchestre plugin)`'],
      prepare: ['`plan(<name>): initial plan`', '`decision · major · <ID>: … (settled by the user)`', '"Language of the plan?"', '"Use fable for this plan?"'],
      ready: ['`ready(<name>): <short verdict>`, the short verdict in English', '"Checked by /orchestre:ready on <date>: <one-line verdict>" (`date +%F`', '"confirmed by the user on <date>" (`date +%F`)', '`decision · major · <ID>: … (settled by the user)`'],
      run: ['`progress: PROGRESS.md regenerated by progress.mjs`', '`chore: exclude plans/ and .claude/ from the formatter and linter`', '`progress(<id>): <status> by hand`', 'the message "task <id>: <title>"', '`decision · major · <ID>: … (settled by the user)`', 'line "Checked by /orchestre:ready"'],
    }
    for (const [s, names] of Object.entries(NAMES)) for (const x of names) assert.ok(text[s].includes(x), `${s}: ${x}`)
    assert.ok(SRC.migrate.includes('Checked by /orchestre:ready on ${v[1]}: ${v[2]}'))
    assert.ok(WF.includes('-m "task ${t.id}: '), 'merge message of the workflow')
    assert.ok(WF.includes('"progress(${a.task}): ruling'), 'progress commits of the workflow')
    assert.ok(WF.includes('(settled by the user)'))
  })

  test('language: asked by /prepare for each plan, shown by /ready, passed by /run; /install leaves it alone', () => {
    // Two options always (the question tool needs 2 to 4), "Other" added by the tool
    assert.match(text.prepare, /^- Language of the plan's free text \(`language`[^\n]*"Language of the plan\?", with two options: the language of the conversation first, recommended, then English; when the conversation is in English, the second option is the language of the source plan for a conversion, French otherwise\.[^\n]*short code \(`fr`, `en`, `es`…\)/m)
    assert.ok(text.prepare.includes('`language` (step 0)'), '/prepare writes language in the config')
    assert.ok(text.ready.includes('`language`. Say the plan\'s `language` in one line'))
    assert.match(SRC['plan-lint'], /language: typeof language === 'string'/)
    assert.ok(text.run.includes('`language`: `language` of the config, as is, `"en"` when absent'))
    assert.ok(!/`language`/.test(text.install), '/install asks nothing about language')
    for (const s of ['run', 'ready']) assert.ok(text[s].includes('in the plan\'s language: `language` of `orchestre.config.json`, `"en"` when absent'), `${s}: language of the pilot`)
  })

  test('version (0.15.0): the README badge and a CHANGELOG section follow plugin.json', () => {
    const version = JSON.parse(read(join(PLUGIN, '.claude-plugin', 'plugin.json'))).version
    const badges = [...read(join(ROOT, 'README.md')).matchAll(/badge\/orchestre-([0-9.]+)-/g)].map(m => m[1])
    assert.deepEqual(badges, [version], 'one orchestre badge, at the version of plugin.json')
    assert.ok(read(join(ROOT, 'CHANGELOG.md')).includes(`\n## ${version} `), `CHANGELOG.md: section ## ${version}`)
  })

  test('splitting rule (0.15.0): one rule in the format, cited by /prepare, /run, the replanner and the workflow', () => {
    assert.ok(FORMAT.includes('- Own task only for a reason:'), 'format.md defines the rule')
    for (const reason of ['parallel:', 'contract:', 'risk:', 'size:']) assert.ok(FORMAT.includes(`  - ${reason}`), `format.md: reason ${reason}`)
    assert.ok(text.prepare.includes('"Own task only for a reason"'), '/prepare cites the rule')
    assert.ok(text.run.includes('"Own task only for a reason"') && text.run.includes('"Group these <N> findings?"'), '/run: pilot tasks follow the rule')
    assert.ok(read(join(PLUGIN, 'agents', 'replanner.md')).includes('before adding a task, prefer, in this order'), 'replanner: amend, group, then add')
    assert.ok(WF.includes('Before adding a task, prefer amending a task not yet started'), 'workflow instructions of the replanner')
  })

  console.log(`commands: ALL GREEN (${n} tests)`)
} finally {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
}
