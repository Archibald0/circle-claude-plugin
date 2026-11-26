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
    const hints = { install: '[--team]', prepare: '<existing plan (file or folder) | goal of the plan>', ready: '<plan-dir> [--no-dry-run]', run: '<plan-dir> [--resume]', status: '[<plan-dir>]', done: '<plan-dir> [ticket] [review|decision <task|-> <text>]' }
    for (const s of SKILLS) {
      const { fm, body } = FM[s]
      assert.equal(fm.name, s, `${s}: name`)
      assert.ok(fm.description && fm.description.includes(`/orchestre:${s}`), `${s}: description without /orchestre:${s}`)
      assert.equal(fm['argument-hint'], hints[s], `${s}: argument-hint`)
      for (const opt of hints[s].match(/--[a-z-]+/g) || []) assert.ok(body.includes(`\`${opt}\``), `${s}: option ${opt} not explained`)
      assert.equal(fm['disable-model-invocation'], s === 'prepare' ? undefined : 'true', `${s}: disable-model-invocation`)
    }
    assert.equal(FM.prepare.fm.model, 'opus')
    assert.match(FM.prepare.fm.description, /^For the orchestre plugin only\. Use when the user types \/orchestre:prepare, or names orchestre itself and asks to prepare, write or convert a plan for it\. Never on words such as orchestrator, agents, roles or master plan alone/, 'prepare: Claude starts it only when orchestre is named (#32)')
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
    for (const a of ['lint', 'progress', 'agent_prefix', 'language', 'setup', 'shared_setup', 'max_auto_decisions', 'rerun']) assert.ok(text.run.includes(`\`${a}\`:`) || text.run.includes(`\`${a}\` and \``), `arg ${a} not explained`)
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
    const FIELDS = ['status', 'detail', 'stop_issue', 'open_issues', 'progress_failures', 'auto_decisions', 'discarded_amendments', 'rulings_applied', 'rulings_refused', 'worktrees', 'waiting', 'waiting_on_prerequisites', 'deferred', 'added_tasks', 'reviews', 'rejections', 'unverifiable', 'blocker', 'branch', 'circuit_breaker', 'inconsistency', 'human', 'interrupted', 'merged_unclosed']
    for (const f of FIELDS) {
      assert.ok(text.run.includes(`\`${f}\``), `field ${f} not read by /orchestre:run`)
      assert.match(WF, new RegExp(`\\b${f}\\b`), `field ${f} not in the workflow`)
    }
    // Any snake_case name the skill cites: an arg, a config key, a field above, or a name of the workflow, of plan-lint or of a schema key of progress.mjs (0.20.0)
    for (const l of text.run.split('\n').map(scrub)) {
      for (const m of l.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) assert.ok(new RegExp(`\\b${m[1]}\\b`).test(WF) || SRC['plan-lint'].includes(m[1]) || FORMAT.includes(`"${m[1]}"`) || SRC.progress.includes(`${m[1]}:`), `unknown name ${m[1]} in /orchestre:run`)
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
    // Rulings (0.20.0): recorded by rule, applied by apply at the run start; no option in the args, no skill cites `rulings`
    assert.ok(!/\bA\.rulings\b/.test(WF) && !WF.includes('args.rulings'), 'the workflow no longer reads args.rulings')
    for (const s of SKILLS) assert.ok(!text[s].includes('`rulings`'), `${s}: cites \`rulings\` in the args`)
    assert.ok(text.run.includes('`{"issue":"<id>","text":"<answer>"}` for a free answer, "Other" included'))
    assert.ok(text.run.includes('Never pass an option in `args`, and never write the decision or its actions yourself'))
    assert.ok(text.run.includes("node ${CLAUDE_PLUGIN_ROOT}/scripts/progress.mjs rule <plan> <<'ORCHESTRE_JSON'"))
    // The plan reader that opens the run runs apply, then plan-lint; a refused ruling stops before any task, its fields read by the skill
    assert.ok(WF.includes('const APPLY_CMD = PROGRESS && `${PROGRESS_CMD} apply ${PLANARG}`') && WF.includes("opens ? pRunStart('return ok=false and empty tasks') + pApply() : ''"))
    assert.match(WF, /if \(ap\.rejected\.length\) return await stopBefore\('awaiting-ruling'/)
    for (const x of ['progress: rulings not applied', 'progress: output of apply not read']) assert.ok(WF.includes(x) && text.run.includes(`A \`detail\` that starts with "${x}"`), x)
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
      if (script === 'worktrees') assert.ok(sub && ['clean', 'space'].includes(sub[1]), `${s}: worktrees.mjs ${sub && sub[1]}`)
      if (script === 'settings') assert.ok(sub && ['check', 'apply'].includes(sub[1]), `${s}: settings.mjs ${sub && sub[1]}`)
    }
    for (const s of ['run', 'ready']) {
      for (const o of ['`--write`', '`--write --run-stopped`']) assert.ok(text[s].includes(o), `${s}: ${o}`)
      assert.ok(text[s].includes('scripts/migrate.mjs <plan>`'), `${s}: migrate.mjs`)
    }
    assert.ok(text.run.includes('run it again with `--run-stopped`') && OPTS.worktrees.has('--run-stopped'))
    assert.ok(text.ready.includes('worktrees.mjs clean <plan> --dry-run`'))
  })

  test('0.20.0: the skill run settles issues with rule, offers valid options only, and --resume lists the rulings not applied; format.md shows ISSUES.json', () => {
    const progressCommands = SRC.progress.match(/usage: progress\.mjs <([a-z|-]+)>/)[1].split('|')
    for (const c of ['rule', 'unrule', 'apply']) assert.ok(progressCommands.includes(c), `progress.mjs knows ${c}`)
    // The fields the skill reads in the issues of progress.json are the ones of its schema
    for (const f of ['valid', 'invalid_reason', 'without_actions', 'pending_rulings', 'effect']) {
      assert.ok(text.run.includes(`\`${f}`) || text.run.includes(f), `run: ${f}`)
      assert.ok(SRC.progress.includes(f), `progress.mjs: ${f}`)
    }
    // An invalid option is not offered and its reason is said; the question about all the recommended options comes first
    assert.match(text.run, /An option with `valid: false` is not offered: say its `invalid_reason` in one line/)
    assert.match(text.run, /With at least two issues whose recommended option is valid, the first question is `Accept the N recommended options\?`/)
    assert.ok(text.run.includes('record them in one `rule` as `{"items":[…]}`'))
    // The answer goes through the question tool, then rule; unrule withdraws it until apply
    assert.match(text.run, /question tool[^\n]*Then record the answer, between two runs, with the `progress\.mjs rule` block/)
    assert.match(text.run, /`progress\.mjs unrule` withdraws a ruling recorded and not applied yet/)
    // --resume: the rulings recorded and not applied yet, from pending_rulings
    // 0.22.0: listed, and offered for withdrawal, at point 4 of the pre-flight, before apply
    assert.match(text.run, /Rulings recorded outside a run: first list what apply would write, from `progress\.json`: its `pending_rulings`/)
    // The structure of the plan in format.md has the register, tracked by git and written by the script
    assert.match(FORMAT, /^├── ISSUES\.json .*orchestre-issues\/1.*tracked by git.*progress\.mjs alone/m)
    assert.ok(SRC.progress.includes("REGISTER = 'ISSUES.json'") && SRC.progress.includes("REGISTER_FORMAT = 'orchestre-issues/1'"))
    assert.ok(FORMAT.includes('`valid`, `invalid_reason`') && FORMAT.includes('`progress.mjs apply`'))
  })

  test('0.19.0: the skills run, ready and status cite the circuit breaker, space and triage as the code gives them', () => {
    // Circuit breaker: the detail the workflow writes is the one the skill reads, and the fields of its return are read
    assert.ok(WF.includes('`agents not answering: '), 'workflow: detail of the breaker')
    const from = text.run.indexOf('"agents not answering:"'), breaker = text.run.slice(from, text.run.indexOf('Having an issue settled'))
    assert.ok(from > 0 && breaker.length > 0, 'run: the breaker is not handled')
    for (const w of ['`/login`', 'usage limit', '`interrupted`', '`merged_unclosed`', '`stop_issue`', '`open_issues`', 'recorded before the trip', 'No issue to settle', 'already merged']) assert.ok(breaker.toLowerCase().includes(w.toLowerCase()), `run: breaker line without ${w}`)
    assert.ok(breaker.includes('question tool'), 'run: issues of the breaker settled with the question tool')
    assert.match(WF, /merged_unclosed: mergedUnclosed/)
    // merged_unclosed: the fields the skill cites are the ones the workflow returns, and its issues are settled before the new run
    const entry = WF.match(/mergedUnclosed\.push\(\{([^\n]*)\}\) \}/)
    assert.ok(entry, 'workflow: entry of merged_unclosed')
    const wfFields = ['id', 'branch', 'deviations', 'reviews', 'unverifiable', 'issues']
    for (const f of wfFields) assert.match(entry[1], new RegExp(`(^|[ ,{])${f}[:,]`), `workflow: merged_unclosed returns ${f}`)
    const mu = text.run.slice(text.run.indexOf('A non-empty `merged_unclosed`'), text.run.indexOf('Having an issue settled'))
    for (const f of wfFields.slice(2)) assert.ok(mu.includes(`\`${f}\``), `run: merged_unclosed cites ${f}`)
    assert.ok(/every one of its `issues` settled with the question tool before the new run/.test(mu), 'run: the issues of merged_unclosed are settled before the new run')
    assert.ok(mu.includes('decided automatically') && mu.includes('never written') && mu.includes('never present them as already applied'), 'run: auto-decided issues are not presented as applied')
    assert.ok(mu.includes('An empty `merged_unclosed` adds nothing.'), 'run: an empty merged_unclosed adds nothing')
    // A task interrupted at its own merge (T11C): the marker the skill cites is the one the workflow returns, set on the
    // integrator call only, and the skill looks for the commit "task <id>:" before the new run
    const marker = entry[1].match(/\.\.\.\(unknown \? \{ merge: '([a-z]+)' \} : \{\}\)/)
    assert.ok(marker, 'workflow: marker of a merge unknown in merged_unclosed')
    // Whatever the integrator's failure (an error, the breaker) and its silence: the marker is set once, at the call
    assert.match(WF, /label: `\$\{t\.id\} · merge`[^\n]*\n\s*\.catch\(err => \{ if \(launched\) unclosedOf\([^\n]*, true\); throw err \}\)/, 'workflow: the integrator call marks its task merge unknown')
    assert.match(WF, /if \(!i\) \{ unclosedOf\([^\n]*, true\); return await closeTask\(t, 'blocked', attempts, r, \['integrator without an answer'\], trace\) \}/, 'workflow: an integrator without an answer marks its task merge unknown')
    assert.match(WF, /\.\.\.\(mergedUnclosed\.length \? \{ merged_unclosed: mergedUnclosed \} : \{\}\)/, 'workflow: merged_unclosed outside the breaker when not empty')
    const cited = `\`merge: "${marker[1]}"\``
    assert.ok(breaker.includes(`the tasks in \`interrupted\` are taken up by the next run, from their branch, except a task that is also in \`merged_unclosed\` with ${cited}`), 'run: the exception to the tasks in interrupted')
    const at = mu.indexOf(`An entry with ${cited}`)
    assert.ok(at > 0, 'run: an entry with a merge unknown')
    const unk = mu.slice(at)
    for (const w of ['Before the new run, check whether a commit `task <id>:` is on the integration branch', 'If it is, the task is merged: handle the entry as above', 'run the task\'s verifications on the integration branch before the new run, as for `repair`', 'If it is not, the merge did not run: say that the next run takes the task up from its branch']) assert.ok(unk.includes(w), `run: merge unknown without "${w}"`)
    // T40: merged_unclosed outside the breaker, and the pre-flight when another session runs
    const runN = text.run.replace(/\s+/g, ' ')
    for (const w of ['When `merged_unclosed` is not empty, whatever the `status` of the return (`finished`, `rerun`, `partial`, `awaiting-ruling`, `error`), handle it first', 'before any rerun of the phase is offered. Then, by `status`:', 'on any return and not only on the breaker\'s', 'The exception is a `blocked` or `needs-human` task with `merge: "unknown"`, which the workflow did close', 'was closed by the workflow: its deviations, reviews and issues are already written under `## <id>`', 'do not write them into HANDOFF.md again', 'An `interrupted` or `failed` task (no close) is handled as the paragraph above says', 'If it is not stopped, another session runs the plan: stop the pre-flight here, say so, and run neither `apply` nor the checks that follow. Otherwise, `node', 'If `clean` refuses and the user says that run is not stopped, another session runs the plan: stop the pre-flight here and say so']) assert.ok(runN.includes(w), `run: T40 without "${w}"`)
    // check_skipped: a log line, nothing to ask
    assert.ok(text.run.includes('`check_skipped`') && text.run.includes('it asks nothing of the user'))
    // space: run and ready launch it, not blocking; the script has it, with its option
    for (const s of ['run', 'ready']) {
      assert.ok(codeSpans(text[s]).includes('node ${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs space <plan> --parallelism <n>'), `${s}: worktrees.mjs space`)
      assert.ok(text[s].includes('block nothing'), `${s}: space is not blocking`)
    }
    assert.ok(SRC.worktrees.includes("argv[0] === 'space'") && optionsOf(SRC.worktrees).has('--parallelism'), 'worktrees.mjs: space')
    // triage: the skill reads the format of the script, closes only safe through ack, and says what to do on a non-zero exit
    assert.ok(codeSpans(text.run).some(c => c.startsWith('node ${CLAUDE_PLUGIN_ROOT}/scripts/progress.mjs triage <plan>')))
    assert.ok(/function triage\(/.test(SRC.progress) && /cmd === 'triage'/.test(SRC.progress), 'progress.mjs: triage')
    assert.ok(text.run.includes('`{ plan, base, integration, safe, open }`') && SRC.progress.includes('return { plan: ctx.name, base, integration: ctx.integration, safe, open }'))
    for (const reason of ['duplicate', 'superseded', 'no-diff', 'worktree-gone']) { assert.ok(text.run.includes(`\`${reason}\``), `run: reason ${reason}`); assert.ok(SRC.progress.includes(`'${reason}'`), `progress.mjs: reason ${reason}`) }
    assert.ok(text.run.includes('`{ "items": <safe> }`') && text.run.includes('`{ task, items: [{ kind, task, text }] }`'))
    assert.ok(/A non-zero exit of `triage` \(2: plan not found or ambiguous; 1: `progress.json` unreadable/.test(text.run), 'run: non-zero exit of triage')
    assert.ok(text.run.includes('"triage not available"') && text.run.includes('never read the failure as an empty `safe` list') && text.run.includes('close nothing alone'))
    // The exit codes the skill states are the script's
    const bad = tempDir('triage-')
    const none = node([join(SCRIPTS, 'progress.mjs'), 'triage', join(bad, 'plans', 'nothing')], bad)
    assert.equal(none.code, 2, none.out)
    assert.match(none.out, /^progress: /)
    // status: the three lines and the label of a prerequisite that holds back nothing, in the docs
    const REF = read(join(ROOT, 'docs', 'reference.md'))
    for (const w of ['**Now**', '**At run stop**', '**Later**', '`before the next run`', '`before the first run`', '`plan-lint --scope`'.replace('`plan-lint --scope`', '`--scope`')]) assert.ok(REF.includes(w), `docs/reference.md without ${w}`)
    assert.ok(SRC.status.includes('before the next run') && SRC.status.includes('before the first run'))
    for (const w of ['entry with `*` owns the paths that start with the text before the `*`', '`docs/sc.md` does not own `docs/sc.md.bak`', '`*.md`) owns nothing', '`outside`']) assert.ok(REF.includes(w), `docs/reference.md: --scope without ${w}`)
  })

  test('0.19.0: at the end of a phase, autonomous and deviation mode close safe and ask nothing; open is offered only in phase mode and at the end of the command', () => {
    const fin = text.run.split('\n').find(l => l.startsWith('   - `finished`:'))
    assert.ok(fin && fin.includes('In phase mode'), 'run: the finished bullet')
    const auto = fin.slice(0, fin.indexOf('In phase mode'))
    for (const w of ['In autonomous or deviation mode, the triage asks no question', 'close `safe` through `ack`', 'say in one line per task how many items of `open` stay open', 'go on to the next phase without waiting']) assert.ok(auto.includes(w), `run: finished, autonomous mode without "${w}"`)
    assert.ok(!/question tool|\boffer/i.test(auto), 'run: finished, autonomous mode offers nothing with the question tool')
    // Every sentence of the skill that offers `open` with the question tool is for phase mode or the end of the command
    for (const s of text.run.split(/\.\s+/).filter(s => s.includes("`open`") && /question tool|\boffer `open`/i.test(s))) {
      assert.ok(/phase mode/.test(s), `run: open offered outside phase mode: ${s}`)
      if (!s.startsWith('In phase mode')) assert.ok(s.includes('only in phase mode') && s.includes('at the end of the command'), `run: open offered without its moments: ${s}`)
    }
    const end = text.run.slice(text.run.indexOf('## 4. End'), text.run.indexOf('## During a run'))
    assert.ok(end.includes('Offer `open` to the user with the question tool only in phase mode, at the end of a phase before the end-of-phase question, and at the end of the command'), 'run: when open is offered')
    assert.ok(end.includes('At the end of a phase in autonomous or deviation mode, do not offer it: say in one line per task how many of its items stay open, ask nothing, and go on to the next phase.'), 'run: autonomous mode does not stop on open')
    const REF = read(join(ROOT, 'docs', 'reference.md'))
    const tri = REF.slice(REF.indexOf('**End-of-run triage**'), REF.indexOf('\n', REF.indexOf('**End-of-run triage**')))
    assert.ok(tri.includes('in phase mode at the end of each phase, before the end-of-phase question, and at the end of the command') && tri.includes('Autonomous and deviation mode do not stop on it at the end of a phase'), 'docs/reference.md: when open is offered')
  })

  test('0.19.0: the check_skipped rule of the integrator agent is the one pMerge gives', () => {
    const INTEG = read(join(PLUGIN, 'agents', 'integrator.md'))
    const pm = WF.slice(WF.indexOf('const pMerge = '), WF.indexOf('\n// Choice of the model'))
    assert.ok(pm.length > 0, 'workflow: pMerge')
    // The comparison: given only for a task of the main checkout, the same command on both sides
    const cmp = pm.match(/\$\{isolated \? '' : `\nThen compare the tree of \$\{INTEG\} with the verified branch: \\`(git diff --quiet \$\{r\.branch\} HEAD)\\`/)
    assert.ok(cmp, 'pMerge: the comparison only for a task of the main checkout')
    assert.ok(INTEG.includes(`Check skipped: only when your instructions give the comparison \`${cmp[1].replace('${r.branch}', '<branch>')}\` (a task of the main checkout, never a task in a worktree)`), 'integrator.md: when check_skipped applies')
    // Code 0: the same values returned
    const values = s => [...s.matchAll(/([a-z_]+)=(true|false)/g)].map(m => m[0]).sort()
    const wf0 = pm.match(/Code 0: [^`]*?return ([^.]*)\./), ag0 = INTEG.match(/Code 0: [^\n]*?return ([^.]*)\./)
    assert.ok(wf0 && ag0, 'code 0 of the comparison')
    assert.deepEqual(values(ag0[1]), values(wf0[1]))
    assert.deepEqual(values(wf0[1]), ['check_ok=true', 'check_skipped=true', 'ok=true'])
    // Any other code: no check_skipped, on both sides; and the workflow takes a skipped check in a worktree as a check not done
    assert.ok(pm.includes('Any other code: go on below, without check_skipped.') && INTEG.includes('Any other code, or no comparison in your instructions: no `check_skipped`'), 'any other code')
    assert.ok(WF.includes('const skipped = i.check_skipped === true, notRun = skipped && isolated'), 'workflow: check_skipped read for the main checkout only')
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
    assert.deepEqual(sorted(keys), sorted(['id', 'phase', 'effort', 'verification', 'challenge', ...Object.values(LEGACY.taskKeys)]))
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
    assert.deepEqual(sorted(Object.keys(config)), sorted([...Object.values(LEGACY.configKeys), 'fable', 'language', 'ruling_wait_minutes']))
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
    assert.equal(j.tasks[0].challenge, true, 'the template of format.md carries challenge: true, which plan-lint passes on')
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
    // The pilot's action, with the JSON of /orchestre:run: a heredoc whose delimiter is quoted (0.18.0)
    const pilot = text.run.match(/progress\.mjs pilot <plan> <<'ORCHESTRE_JSON'\n\s*(\{[^\n]+\})\n\s*ORCHESTRE_JSON\n/)
    assert.ok(pilot, 'pilot command not found')
    const json = pilot[1].replace('<id>', 'T01').replace('<reason>', 'merged by hand in the test')
    assert.deepEqual(Object.keys(JSON.parse(json)), ['task', 'status', 'reason'])
    const p = node([join(SCRIPTS, 'progress.mjs'), 'pilot', 'plans/demo', '--json', json], d)
    assert.equal(p.code, 0, p.out)
    assert.match(read(join(d, 'plans', 'demo', 'PROGRESS.md')), /\| T01 \| Hello script \|.*\| merged \|/)
    // An apostrophe, a backtick and a dollar in the reason, as they are, through the shell, in the heredoc of the skill
    assert.ok(!text.run.includes("--json '{") && !text.done.includes("--json '<object>'"), 'no JSON in single quotes left in /run or /done')
    const raw = pilot[1].replace('<id>', 'T01').replace('"merged"', '"cancelled"').replace('<reason>', "the user's choice, `x` for $HOME")
    const sh = spawnSync('sh', ['-c', `node "${join(SCRIPTS, 'progress.mjs')}" pilot plans/demo <<'ORCHESTRE_JSON'\n${raw}\nORCHESTRE_JSON`], { cwd: d, encoding: 'utf8' })
    assert.equal(sh.status, 0, sh.stderr)
    assert.ok(JSON.parse(read(join(d, 'plans', 'demo', 'progress.json'))).log.some(e => e.kind === 'pilot' && e.text.includes("the user's choice, `x` for $HOME")))
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
    assert.ok(text.run.includes('If the user said at the migration or at the rulings (point 4) that the run is stopped, run it with `--run-stopped` straight away.'))
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
    assert.ok(SRC.progress.includes('`progress: rulings ${ids.join') && text.run.includes('its commit `progress: rulings …`'), 'commit of apply, named by the skill')
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

  test('agents without MCP tools (0.18.0): the workers inherit none, the other agents list their tools without any MCP', () => {
    for (const a of AGENTS) {
      const fm = read(join(PLUGIN, 'agents', `${a}.md`)).match(/^---\n([\s\S]*?)\n---\n/)[1]
      const tools = (fm.match(/^tools:\s*(.*)$/m) || [])[1]
      if (tools) assert.ok(!/mcp__/.test(tools), `${a}: an MCP tool among its tools`)
      // Without a tools field, an agent inherits every tool of the session, the user's MCP servers included (code.claude.com/docs/en/sub-agents)
      else assert.match(fm, /^disallowedTools:\s*"?mcp__\*"?\s*$/m, `${a}: no tools field and no disallowedTools: mcp__*`)
    }
    assert.ok(['worker', 'isolated-worker'].every(a => AGENTS.includes(a)))
  })

  test('digest of the plan (0.18.1): the same planDigest in plan-lint and in the workflow, which reads plan-lint --reader; the plan-reader copies it', () => {
    const fn = t => (t.match(/\nfunction planDigest\(p\) \{\n[\s\S]*?\n\}/) || [''])[0]
    assert.ok(fn(WF).length > 100, 'planDigest missing from run-phase.js')
    assert.equal(fn(SRC['plan-lint']), fn(WF), 'planDigest differs between scripts/plan-lint.mjs and workflows/run-phase.js')
    assert.ok(WF.includes('--reader --phase ${PHASE}') && !/plan-lint[^\n]*--json/.test(WF.replace(/\/\/[^\n]*/g, '')), 'the workflow reads plan-lint --reader, not --json')
    // The fields the workflow requires of the copy: those --reader prints, digest included
    const schema = WF.match(/const PLAN_S = S\(\{([\s\S]*?)\n/)[1]
    for (const k of ['ok', 'errors', 'tasks', 'all', 'max_phase', 'digest']) assert.ok(schema.includes(`${k}: `), `PLAN_S: ${k}`)
    const reader = read(join(PLUGIN, 'agents', 'plan-reader.md'))
    assert.ok(reader.includes('`digest` included, character for character') && reader.includes('plan-lint --reader'), 'plan-reader.md')
    // The skills keep --json, which does not change
    for (const s of ['ready']) assert.ok(text[s].includes('--json --integration'), s)
    assert.ok(!SKILLS.some(s => text[s].includes('--reader')), 'a skill reads --reader: it is the JSON of the workflow')
  })

  test('start of a task in a worktree (0.18.2): the isolated worker runs no progress command, the clerk notes its start', () => {
    const agent = a => read(join(PLUGIN, 'agents', `${a}.md`))
    // Claude Code's isolation guard refuses the command to an agent isolated in a worktree: its rules no longer describe one
    assert.ok(agent('isolated-worker').includes('you run no progress command (`progress.mjs`)'), 'isolated-worker.md: no progress command')
    assert.ok(!/ORCHESTRE_JSON|progress_ok|heredoc/.test(agent('isolated-worker')), 'isolated-worker.md still describes a progress command to run')
    // The agents of the main checkout keep theirs
    for (const a of ['worker', 'verifier', 'evaluator', 'integrator', 'scribe', 'plan-reader']) assert.ok(agent(a).includes('ORCHESTRE_JSON'), `${a}.md: rule of the progress command`)
    for (const x of ['progress.mjs step', 'progress.mjs run-end', 'Start of a task: the progress command is your only command']) assert.ok(agent('clerk').includes(x), `clerk.md: ${x}`)
    // The workflow gives the step to the clerk, and none to the isolated worker
    assert.ok(WF.includes("if (isolated) await noteStart(t, workerModel)") && WF.includes("label: `${t.id} · start`, agentType: AG('clerk')"), 'run-phase.js: the clerk notes the start')
    assert.ok(WF.includes("`${isolated ? '' : pStep(t.id, 'worker', { isolated: false, model, ...withoutOf(wo) })}Task"), 'run-phase.js: no step in the instructions of the isolated worker')
  })

  test('digest of the scope (0.19.0): the same scopeDigest in plan-lint and in the workflow, which reads the copy of plan-lint --scope; each field changes it, marker included', () => {
    const fn = t => (t.match(/\nfunction scopeDigest\(p\) \{\n[\s\S]*?\n\}/) || [''])[0]
    assert.ok(fn(WF).length > 100, 'scopeDigest missing from run-phase.js')
    assert.equal(fn(SRC['plan-lint']), fn(WF), 'scopeDigest differs between scripts/plan-lint.mjs and workflows/run-phase.js')
    const load = t => new Function(fn(t) + '\nreturn scopeDigest')()
    const lint = load(SRC['plan-lint']), wf = load(WF)
    const skip = { file: 'tests/x.test.mjs', line: 3, marker: '.skip(' }
    const base = { task: 'T04', branch: 'task/T04', files: ['a.js', 'tests/x.test.mjs'], outside: ['a.js'], tests_removed: ['tests/y.test.mjs'], skips_added: [skip] }
    assert.equal(wf(base), lint(base))
    const variants = { task: { task: 'T05' }, branch: { branch: 'task/T04-r2' }, files: { files: ['a.js'] }, outside: { outside: [] }, tests_removed: { tests_removed: ['docs/latest.md'] },
      'skips_added.file': { skips_added: [{ ...skip, file: 'tests/z.test.mjs' }] }, 'skips_added.line': { skips_added: [{ ...skip, line: 4 }] }, 'skips_added.marker': { skips_added: [{ ...skip, marker: '.only(' }] } }
    for (const [field, change] of Object.entries(variants)) {
      const v = { ...base, ...change }
      assert.equal(wf(v), lint(v), `${field}: the two copies differ`)
      assert.notEqual(wf(v), wf(base), `${field}: not covered by the digest`)
    }
    // A field left out reads as empty, as for planDigest
    assert.equal(wf({ ...base, outside: undefined }), wf({ ...base, outside: [] }))
  })

  test('digest of the payloads (0.20.0): the same payloadDigest in progress.mjs and in the workflow, which puts _digest in each progress command and reads the output of close through its digest', () => {
    const fn = t => (t.match(/function payloadDigest\(p, skip = '_digest'\) \{\n[\s\S]*?\n\}/) || [''])[0]
    assert.ok(fn(WF).length > 100, 'payloadDigest missing from run-phase.js')
    assert.equal(fn(SRC.progress), fn(WF), 'payloadDigest differs between scripts/progress.mjs and workflows/run-phase.js')
    const wf = new Function(fn(WF) + '\nreturn payloadDigest')()
    assert.equal(wf({ task: 'T01', status: 'merged', issues: [] }), 'e4a3b3bf', 'the fixed vector of tests/progress.test.mjs')
    // Keys sorted at every level; the field skipped is left out at the top level only
    assert.equal(wf({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), wf({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }))
    assert.equal(wf({ a: 1, _digest: 'x' }), wf({ a: 1 })); assert.notEqual(wf({ a: { _digest: 'x' } }), wf({ a: {} }))
    assert.equal(wf({ a: 1, digest: 'x' }, 'digest'), wf({ a: 1 }, 'digest')); assert.notEqual(wf({ a: 1, digest: 'x' }), wf({ a: 1 }))
    assert.ok(WF.includes('heredocJson({ ...E, _digest: payloadDigest(E) })'), 'run-phase.js: _digest in every progress command')
    assert.ok(WF.includes("x.digest === payloadDigest(x, 'digest')"), 'run-phase.js: the output of close read through its digest')
  })

  test('close of a task (0.20.0): the clerk or the scribe switches to the integration branch, then runs close; the scribe no longer writes HANDOFF.md, a task nor an amendment', () => {
    const agent = a => read(join(PLUGIN, 'agents', `${a}.md`))
    const scribe = agent('scribe'), clerk = agent('clerk')
    const inWF = x => WF.includes(x.replace(/`/g, '\\`'))
    assert.ok(scribe.includes('Close of a task (`progress.mjs close`, since 0.20.0): you no longer write HANDOFF.md, a task nor an amendment'), 'scribe.md')
    assert.ok(inWF('Never write HANDOFF.md, PROGRESS.md, a task or an amendment yourself, and make no commit: the close command does.'), 'run-phase.js: the instruction of close')
    assert.ok(inWF('`git switch ${INTEG}`. If it fails, run nothing else'), 'run-phase.js: the switch, step 1 of the close')
    for (const x of ['`node …/progress.mjs close …`', 'Close of a task: first `git switch <integration branch>`', '`test -e <path>`', '`digest` included, character for character']) assert.ok(clerk.includes(x), `clerk.md: ${x}`)
    // The commands of the close are allowed to the agents by the template of /orchestre:install
    const allow = JSON.parse(read(join(PLUGIN, 'skills', 'install', 'settings.local.template.json'))).permissions.allow
    for (const r of ['Bash(git switch *)', 'Bash(test -e *)']) assert.ok(allow.includes(r), `template: ${r}`)
  })

  test('scope check and proofs (0.19.0): the rules of verifier.md and evaluator.md match the instructions of the workflow', () => {
    const agent = a => read(join(PLUGIN, 'agents', `${a}.md`))
    const verifier = agent('verifier'), evaluator = agent('evaluator')
    // The workflow's texts are in template literals: a backtick there is written \`
    const inWF = x => WF.includes(x.replace(/`/g, '\\`'))
    // Verifier: the scope check first, from the main checkout, its JSON copied in "scope"; never a failure nor a forbidden command
    assert.ok(WF.includes('--scope ${t.id} --branch ${r.branch} --integration ${INTEG}'), 'run-phase.js: the scope command')
    assert.match(WF, /const VERIF_S = S\(\{[^\n]*scope: SCOPE_S/, 'VERIF_S: scope')
    for (const x of ['First, the scope check your instructions give (`plan-lint.mjs … --scope …`), from the folder you start in (the main checkout), without a `cd`', '`digest` included, character for character', 'the workflow checks the copy against the digest', 'cite it neither among the failures nor in `forbidden`']) assert.ok(verifier.includes(x), `verifier.md: ${x}`)
    for (const x of ['First, from the folder you start in (the main checkout), without a `cd`', '`digest` included, character for character', 'the workflow checks the copy against the digest', 'cite it neither among the failures nor in "forbidden"']) assert.ok(inWF(x), `run-phase.js: ${x}`)
    // Evaluator: the proofs, with the four kinds of the schema
    const by = JSON.parse(WF.match(/const PROOF_BY = (\[[^\]\n]*\])/)[1].replace(/'/g, '"'))
    assert.deepEqual(by, ['diff', 'test', 'command', 'report'])
    for (const b of by) { assert.ok(evaluator.includes(`\`${b}\``), `evaluator.md: ${b}`); assert.ok(inWF(`\`${b}\``), `run-phase.js: ${b}`) }
    for (const k of ['criterion', 'by', 'ref']) { assert.ok(evaluator.includes(`\`${k}\``), `evaluator.md: ${k}`); assert.ok(WF.includes(`"${k}"`), `run-phase.js: ${k}`) }
    assert.ok(evaluator.includes('On a pass, return `proofs`: one entry per criterion of `definition_of_done`') && WF.includes('On a pass, return "proofs": one entry per criterion of the definition of done'))
    for (const x of ['(only a result of code 0 proves)', '(only for a criterion that asks for report content)']) { assert.ok(evaluator.includes(x), `evaluator.md: ${x}`); assert.ok(WF.includes(x), `run-phase.js: ${x}`) }
    // Evaluator: the facts of the scope, the rule on a removed or skipped test, the path heuristic; it no longer reads the scope itself
    for (const x of ['do not read the scope yourself', 'a test deleted or skipped is a gap, unless the definition of done asks for it',
      'lists the paths containing `test` or `spec` (case-insensitive), which can include files that are not tests (such as `docs/latest.md`): such a file is not a gap by itself.']) {
      assert.ok(evaluator.includes(x), `evaluator.md: ${x}`)
      assert.ok(inWF(x) || inWF(x[0].toUpperCase() + x.slice(1)), `run-phase.js: ${x}`)
    }
    assert.ok(!evaluator.includes('Also check that the diff touches no file outside'), 'evaluator.md: the scope is the workflow\'s')
    assert.ok(evaluator.includes('When your instructions say the scope check could not be read, check these points yourself') && WF.includes('could not be read: check yourself, in the diff'), 'fallback without the facts')
  })

  test('fixes before 0.20.0: the plan reader runs apply, the scribe no ruling; the skill run reads the stops of close and apply as the workflow writes them; docs/reference.md describes close, the return and the two paths', () => {
    const agent = a => read(join(PLUGIN, 'agents', `${a}.md`))
    const reader = agent('plan-reader'), scribe = agent('scribe')
    // A definition of the workflow, up to the next top-level const
    const def = name => { const i = WF.indexOf(`const ${name} = `); assert.ok(i >= 0, `run-phase.js: ${name}`); return WF.slice(i, WF.indexOf('\nconst ', i + 1)) }
    // The plan reader that opens the run: run-start, then apply (the script commits, not the agent), then plan-lint
    const readerBody = frontmatter(reader).body
    const at = ['1. `progress.mjs run-start`', '2. `progress.mjs apply`', '3. The plan-lint command'].map(x => readerBody.indexOf(x))
    assert.ok(at.every(i => i > 0) && at[0] < at[1] && at[1] < at[2], `plan-reader.md: run-start, apply, then plan-lint: ${at}`)
    assert.ok(/^description: [^\n]*progress\.mjs run-start, then progress\.mjs apply/m.test(reader), 'plan-reader.md: its description names run-start and apply')
    assert.ok(reader.includes('return its one line of JSON in `apply` exactly as printed') && reader.includes('`apply_ok=true`') && reader.includes('`apply_ok=false`, the first line of its error in `apply_error`, and stop there: no plan-lint'), 'plan-reader.md: apply, apply_ok, apply_error')
    assert.ok(reader.includes('The script writes and commits, not you: running it is allowed') && reader.includes('You change nothing yourself: you edit no file and make no commit'), 'plan-reader.md: the commit of apply is the script\'s')
    // Each field it names is in the schema of the plan reader and in its instructions
    const schema = WF.match(/const PLAN_S = S\(\{([\s\S]*?)\n/)[1], prompts = ['pRunStart', 'pApply', 'pReader'].map(def).join('\n')
    const fields = codeSpans(reader).map(x => x.replace(/=(true|false)$/, '')).filter(x => /^[a-z]+(?:_[a-z]+)*$/.test(x))
    for (const f of ['apply', 'apply_ok', 'apply_error']) assert.ok(fields.includes(f), `plan-reader.md: ${f}`)
    for (const f of fields) {
      assert.ok(schema.includes(`${f}: `), `plan-reader.md names ${f}, absent from PLAN_S`)
      assert.ok(prompts.includes(f), `plan-reader.md names ${f}, absent from the instructions of the plan reader`)
    }
    // The scribe: no ruling and no run start any more; the progress commands it names are those the workflow sends it
    assert.ok(!/\bruling/i.test(scribe) && !scribe.includes('run-start'), 'scribe.md: a ruling or a run start')
    const pc = def('pClose'), sent = new Set([...pc.matchAll(/progressCmd\('([a-z-]+)'/g)].map(m => m[1]))
    if (pc.includes('pStep(')) sent.add('step')
    assert.ok(!/progressCmd\(|pStep\(|pRunStart\(|pApply\(/.test(def('pScribe') + def('pUpdates')), 'run-phase.js: the scribe without progress gets no progress command')
    assert.ok(WF.includes("{ agentType: AG('scribe'), model: 'sonnet' }") && WF.includes('ask(pClose(t, final, E,'), 'run-phase.js: the scribe gets pClose')
    const named = [...scribe.matchAll(/progress\.mjs ([a-z-]+)/g)].map(m => m[1])
    assert.ok(named.length > 0, 'scribe.md: names no progress command')
    for (const c of named) assert.ok(sent.has(c), `scribe.md names progress.mjs ${c}, which the workflow does not send to the scribe`)
    // The stops of a close the skill run reads: titles written by the workflow, and what the pilot does
    const titles = [...WF.matchAll(/humanIssue\(t\.id, `(Progress of \$\{t\.id\}[^`]*)`/g)].map(m => m[1].replace(/\$\{t\.id\}/g, '<id>'))
    const citedTitles = [...text.run.matchAll(/A stop issue `(Progress of [^`]+)`/g)].map(m => m[1])
    for (const t of ['Progress of <id>: output of close not read', 'Progress of <id> not committed']) assert.ok(citedTitles.includes(t), `run: the stop ${t} is not handled`)
    for (const t of citedTitles) assert.ok(titles.includes(t), `run: cites a stop the workflow does not write: ${t}`)
    const stopText = t => { const i = text.run.indexOf(`A stop issue \`${t}\``); return text.run.slice(i, text.run.indexOf(' A ', i + 20)) }
    const notRead = stopText('Progress of <id>: output of close not read')
    for (const w of ['close ran and has already committed', 'read the commit `progress(<id>): <status>` on the integration branch and HANDOFF.md under `## <id>`', 'Never run `progress.mjs close` again by hand']) assert.ok(notRead.includes(w), `run: output of close not read without "${w}"`)
    assert.ok(WF.includes('Read the commit "progress(${t.id}): ${final}" on ${INTEG} and HANDOFF.md under "## ${t.id}" before the next run.'), 'run-phase.js: the context of an output of close not read')
    const notCommitted = stopText('Progress of <id> not committed')
    for (const w of ['whose context lists `HANDOFF entries not written`', 'before the new run, write these entries under `## <id>` in HANDOFF.md', 'then commit them on the integration branch, together with `<plan>/DISCOVERY.md` if `git status` shows it modified']) assert.ok(notCommitted.includes(w), `run: close not committed without "${w}"`)
    assert.ok(WF.includes('HANDOFF entries not written: ${JSON.stringify(lost)}'), 'run-phase.js: the context of a refused close lists the entries not written')
    // An issue without an entry in ISSUES.json: an answer recorded as a text; its options offered only when the workflow return gives them. A refused ruling: open again only when apply reopened it
    const noEntry = text.run.slice(text.run.indexOf('So does an issue of `progress.json` that has no entry in `ISSUES.json`'), text.run.indexOf(' With at least two issues'))
    for (const w of ['since `apply` refuses an option whose actions it does not know: its answer is always recorded as a text', 'When the workflow return gives its options', 'offer them, write the actions of the chosen option by hand as said above, then record `rule` with the text `option <id>: <description>`', 'otherwise, offer no option and ask for a free answer']) assert.ok(noEntry.includes(w), `run: an issue without an ISSUES.json entry without "${w}"`)
    assert.ok(!noEntry.includes('offer no option and ask for a free answer, since'), 'run: an issue without an ISSUES.json entry is no longer always a free answer without options')
    for (const w of ['An issue is open again only when apply reopened it', 'is dropped, and nothing is reopened']) assert.ok(text.run.includes(w) && WF.includes(w),`run and run-phase.js: "${w}"`)
    // merged_unclosed: rule refuses these issues, the pilot writes them by hand, plan-lint before the commit
    const mu = text.run.slice(text.run.indexOf('A non-empty `merged_unclosed`'), text.run.indexOf('An entry with `merge: "unknown"`'))
    assert.ok(mu.includes('so `rule` refuses them'), 'run: rule refuses the issues of merged_unclosed')
    assert.match(mu, /`decision · major · <title>: option <id> settled by the user — <description>`[^\n]*run plan-lint until "valid plan", then commit on the integration branch/, 'run: plan-lint before the commit of a ruling written by hand')
    assert.ok(mu.includes('Every other issue goes through `rule`'), 'run: every issue outside merged_unclosed goes through rule')
    // docs/reference.md: close, ruling.commit, the dependency added on an overlap, the return of 0.20.0, the two paths
    const REF = read(join(ROOT, 'docs', 'reference.md'))
    const req = WF.match(/const CLOSE_OUT_S = S\(\{[^\n]*\}, \[([^\]]+)\]\)/)[1].split(/,\s*/).map(x => x.replace(/'/g, ''))
    const from = REF.indexOf('- `progress.mjs close <plan>`'), closeDoc = REF.slice(from, REF.indexOf('\n', from))
    // `waits` is required since 0.22.1 (it is always printed): the doc line lists it with the other fields
    assert.ok(req.includes('waits'), 'CLOSE_OUT_S requires waits')
    assert.ok(from > 0 && closeDoc.includes(`\`{ ${req.join(', ')} }\``), `docs/reference.md: the output of close, ${req.join(', ')}`)
    assert.ok(!/Optional fields of the outputs: `waits`/.test(REF), 'reference.md: waits is no longer an optional field')
    for (const w of ['`entries`', '`discarded_amendments`', '`added_tasks`, `{ id, title, phase, content }`, a task file being written only when `content` is given', '`issues`, whole', '`auto: <option id>`', 'and commits them', 'in one commit `progress(<id>): <status>`']) assert.ok(closeDoc.includes(w), `docs/reference.md: close without ${w}`)
    assert.ok(REF.includes('`ruling.commit` stays null in ISSUES.json, for a user ruling and for `auto`') && REF.includes('The commit is in the `commit` field of the output of `apply` (of `close` for `auto`)'), 'docs/reference.md: ruling.commit')
    assert.ok(REF.includes('`amendment · minor · <id>: depends on <other>, added automatically: …`') && SRC.progress.includes('depends on ${d.on}, added automatically: '), 'docs/reference.md: the dependency added on an overlap')
    assert.ok(REF.includes('`rulings_refused`, `[{ issue, option, text, reason }]`, comes with status `awaiting-ruling` and no `stop_issue`') && REF.includes('`rulings_applied` lists the rulings `apply` applied at the start of the run, `[{ issue, task, option, text }]`'), 'docs/reference.md: the return of 0.20.0')
    const prefixes = [...REF.matchAll(/`detail` that starts with "([^"]+)"/g)].map(m => m[1])
    for (const x of ['progress: rulings not applied (apply)', 'progress: output of apply not read']) assert.ok(prefixes.includes(x), `docs/reference.md: the detail "${x}"`)
    for (const x of prefixes) assert.ok(WF.includes(x), `docs/reference.md cites a detail the workflow does not write: ${x}`)
    assert.ok(REF.includes('then records the answer with `rule`; `apply` writes it into the plan at the pre-flight of the next run, or during a run') && REF.includes('those of `merged_unclosed` (a return with a task merged and not closed, with or without the circuit breaker) reached neither `progress.json` nor ISSUES.json, so `rule` refuses them') && REF.includes('runs plan-lint until "valid plan", then commits on the integration branch'), 'docs/reference.md: the two paths')
  })

  test('fixes after EV2 (0.21.0): upgrading.md says which run applies a ruling of 0.19.0; the skill run settles the issues of a task whose progress was not committed by a free answer; docs/reference.md names the issue of a rejected automatic decision', () => {
    const UP = read(join(ROOT, 'docs', 'upgrading.md')), REF = read(join(ROOT, 'docs', 'reference.md'))
    const step1 = UP.slice(UP.indexOf('## From 0.19.0 to 0.20.0'), UP.indexOf('\n2. ', UP.indexOf('## From 0.19.0 to 0.20.0')))
    assert.ok(step1.includes('only the next 0.19.0 run applies a ruling settled on 0.19.0'), 'upgrading.md, step 1: only the next 0.19.0 run applies a ruling settled on 0.19.0')
    for (const w of ['write the actions of the chosen option by hand', "mark the issue settled with 0.19's `progress.mjs ruling`", 'answer it with a text after the update']) assert.ok(step1.includes(w), `upgrading.md, step 1: ${w}`)
    assert.ok(text.run.includes('The issues of a task whose progress was not committed are settled by a free answer'), 'run: the issues of a task whose progress was not committed are settled by a free answer')
    assert.ok(text.run.includes('then write the actions of the chosen option by hand, as for `merged_unclosed`'), 'run: the pilot writes the actions of the chosen option by hand')
    assert.ok(text.run.includes('A context that also lists `Automatic decisions not taken`: do not write those lines') && WF.includes(' Automatic decisions not taken, their issues back in open_issues: '), 'run and run-phase.js: the automatic decisions of a refused close')
    assert.ok(REF.includes('`{ id, issue, title, reason }` for each path an automatic decision cites'), 'docs/reference.md: the issue of a rejected automatic decision in the output of close')
    assert.ok(REF.includes('`raised without its actions (its close was not written): settle it with a free answer`') && SRC.progress.includes("'raised without its actions (its close was not written): settle it with a free answer'"), 'docs/reference.md: the reason run-end gives')
  })

  test('answering during the run (0.21.0): the clerk runs wait again while it says again, outside the exclusive queue, and apply in it; the outputs of close and apply declare waits and done; no new arg', () => {
    const clerk = read(join(PLUGIN, 'agents', 'clerk.md'))
    const def = name => { const i = WF.indexOf(`const ${name} = `); assert.ok(i >= 0, `run-phase.js: ${name}`); return WF.slice(i, WF.indexOf('\nconst ', i + 1)) }
    // The rules of the clerk are those its instructions give
    for (const x of ['`node …/progress.mjs wait …`', 'while that line says `"again":true`, run the same command again, unchanged, in a new call, without a timeout of your own', 'Once it says `"again":false`, return that last line in `wait`', 'Rulings of the run (`node …/progress.mjs apply …`, without JSON): first `git switch <integration branch>`']) assert.ok(clerk.includes(x), `clerk.md: ${x}`)
    assert.match(clerk, /^description: [^\n]*scripts\/progress\.mjs wait[^\n]*scripts\/progress\.mjs apply/m, 'clerk.md: its description names wait and apply')
    const pw = def('pWait'), pa = def('pApplyRun')
    for (const x of ['While that line says "again":true, run the same command again, unchanged, without a timeout of your own', 'Once it says "again":false, return that last line in "wait"', "progressCmd('wait', { task: t.id, issues: ids })"]) assert.ok(pw.includes(x), `pWait: ${x}`)
    assert.ok(pa.includes("\\`git switch ${INTEG}\\`. If it fails, run nothing else") && pa.includes('block(APPLY_CMD)'), 'pApplyRun: the switch, then apply')
    // The wait outside the exclusive queue, apply in it; both by the clerk
    assert.ok(WF.includes("ask(pWait(t, ids, again), { label: `${t.id} · wait`, agentType: AG('clerk')") && !/exclusive\(\(\) => ask\(pWait/.test(WF), 'run-phase.js: the wait, by the clerk, outside the exclusive queue')
    assert.ok(WF.includes("exclusive(() => ask(pApplyRun(), { label: 'rulings · apply', agentType: AG('clerk')"), 'run-phase.js: apply, by the clerk, in the exclusive queue')
    // The outputs the workflow reads, as progress.mjs prints them: waits of close, the fields of wait, done of apply
    assert.match(def('CLOSE_OUT_S'), /waits: WAITS_S/, 'CLOSE_OUT_S declares waits')
    assert.ok(SRC.progress.includes('pending: r.doc.pending_rulings.map(x => x.issue), waits: r.waits,'), 'progress.mjs: close prints waits')
    assert.ok(WF.includes("commit: nullable('string'), done: strs,") && SRC.progress.includes('if (dids.length) result.done = []'), 'APPLY_S declares done')
    const outKeys = (WF.match(/const WAIT_OUT_S = S\(\{[^\n]*\}, \[([^\]]+)\]\)/) || [])[1] || ''
    assert.deepEqual(outKeys.split(/,\s*/).map(x => x.replace(/'/g, '')), ['task', 'settled', 'released', 'timeout', 'again', 'digest'], 'WAIT_OUT_S')
    assert.ok(SRC.progress.includes('out = { task: t.id, settled: [], released: [], timeout: [] }') && SRC.progress.includes('const res = { ...out, again: next !== Infinity }'), 'progress.mjs: the output of wait')
    // The duration and the deadline come from progress.mjs: the workflow reads no arg for them
    assert.ok(!/\bA\.(ruling_wait|wait|until|deadline)/.test(WF), 'run-phase.js: an arg for the wait')
  })

  test('pilot skills (0.21.0): the commands, the config key and the fields the skills and docs cite exist in the scripts and the workflow', () => {
    const REF = read(join(ROOT, 'docs', 'reference.md')), CONF = read(join(ROOT, 'docs', 'configuration.md')), UPG = read(join(ROOT, 'docs', 'upgrading.md'))
    const usage = (SRC.progress.match(/const USAGE = '([^']+)'/) || [])[1] || ''
    const cmds = usage.slice(usage.indexOf('<') + 1, usage.indexOf('>')).split('|')
    // The commands the docs and the skill run cite are commands of progress.mjs, and the docs describe the four added
    for (const c of ['wait', 'release', 'did', 'undid', 'rule', 'unrule', 'apply']) assert.ok(cmds.includes(c), `progress.mjs: command ${c}`)
    for (const c of ['wait', 'release', 'did', 'undid']) assert.ok(REF.includes('`progress.mjs ' + c + ' <plan>`'), `reference.md describes ${c}`)
    for (const m of text.run.matchAll(/progress\.mjs (\w[\w-]*)/g)) assert.ok(cmds.includes(m[1]) || m[1] === 'mjs', `run: progress.mjs ${m[1]} exists`)
    for (const m of REF.matchAll(/`progress\.mjs ([a-z-]+)(?: <plan>)?`/g)) assert.ok(cmds.includes(m[1]), `reference.md: progress.mjs ${m[1]} exists`)
    // run: apply in the pre-flight, ready only reports, and during a run the only writes are rule, release and did
    assert.ok(text.run.includes('progress.mjs apply <plan>`, from the main checkout'), 'run: apply in the pre-flight')
    const runApply = text.run.indexOf('progress.mjs apply <plan>`, from the main checkout'), runLint = text.run.indexOf('7. `node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs')
    assert.ok(runApply > 0 && runLint > runApply && text.run.indexOf('5. Read `orchestre.config.json`') > runApply, 'run: apply comes before the plan-lint and prerequisite check of point 7')
    const choices = text.run.slice(text.run.indexOf("## 2. The user's choices"), text.run.indexOf('## 3.'))
    assert.ok(choices.includes('were listed, offered for withdrawal and applied at point 4 of the pre-flight') && !choices.includes('(point 9) applies') && !choices.includes('`pending_rulings`'), 'run: section 2 cites the point that holds apply, and lists nothing left after it')
    assert.ok(text.ready.includes('`pending_rulings`') && text.ready.includes('`pending_done`') && text.ready.includes('never apply them here'), 'ready: reports, never applies')
    assert.ok(!text.ready.includes('progress.mjs apply <plan>'), 'ready: no apply command')
    const during = text.run.slice(text.run.indexOf('## During a run'), text.run.indexOf('## Context'))
    assert.ok(during.includes('The only writes you may make during a run are `progress.mjs rule`, `release`') && during.includes('and `did`') && during.includes('no other write is allowed'), 'run: during a run, rule, release and did only')
    assert.ok(!/progress\.mjs (unrule|undid|pilot|ack|close|apply)/.test(during), 'run: no other progress command during a run')
    // Mode deviation (D3): said by run and reference.md
    assert.ok(text.run.includes('In `deviation`, a major issue that is not human no longer stops the run at once') && text.run.includes('waits for the ruling until its deadline'), 'run: mode deviation waits')
    assert.ok(REF.includes('it first waits for that ruling'), 'reference.md: mode deviation waits')
    // The config key: format.md, plan-lint, the docs, the same bounds
    assert.ok(FORMAT.includes('"ruling_wait_minutes": 15') && FORMAT.includes('`ruling_wait_minutes` (0.21.0)') && FORMAT.includes('from 0 to 60'), 'format.md describes ruling_wait_minutes')
    assert.ok(SRC['plan-lint'].includes('config.ruling_wait_minutes >= 0 && config.ruling_wait_minutes <= 60'), 'plan-lint checks 0 to 60')
    assert.ok(CONF.includes('`ruling_wait_minutes`') && UPG.includes('`ruling_wait_minutes`') && REF.includes('`ruling_wait_minutes`'), 'docs cite ruling_wait_minutes')
    // The fields of the progress.json the docs name are in the schema of progress.mjs
    for (const f of ['until', 'holds', 'waiting', 'started_without', 'released', 'pending_done']) assert.ok(SRC.progress.includes(f), `progress.mjs: field ${f}`)
    // The three stops of an apply during the run, as the workflow writes them
    for (const t of ['Rulings not applied during the run', 'Rulings applied during the run: output of apply not read', 'Rulings refused by apply during the run']) assert.ok(WF.includes(t) && text.run.includes(t) && REF.includes(t), `stop ${t}`)
    // The section of the changelog, written for this version
    const version = JSON.parse(read(join(PLUGIN, '.claude-plugin', 'plugin.json'))).version
    assert.ok(/^## 0\.21\.0 — \d{4}-\d{2}-\d{2}: .+$/m.test(read(join(ROOT, 'CHANGELOG.md'))) && version >= '0.21.0', 'CHANGELOG.md: ## 0.21.0 — <date>: <title>')
  })

  test('fixes after EV3 (0.22.0): the skill run and docs/reference.md say what the code does; the clerk runs an altered run end once more; apply and close outputs declared', () => {
    const REF = read(join(ROOT, 'docs', 'reference.md')), UPG = read(join(ROOT, 'docs', 'upgrading.md')), CL = read(join(ROOT, 'CHANGELOG.md')), clerk = read(join(PLUGIN, 'agents', 'clerk.md'))
    const VMS = read(join(PLUGIN, 'hooks', 'view-model.mjs'))
    const both = (x, label) => { assert.ok(text.run.includes(x), `run: ${label || x}`); assert.ok(REF.includes(x), `reference.md: ${label || x}`) }
    // T21-1, T21-2: the two lists of a refused close, and the two hand paths
    assert.ok(REF.includes('`HANDOFF entries not written`') && REF.includes('`Automatic decisions not taken, their issues back in open_issues`') && REF.includes('the pilot does not write these'), 'reference.md: the two lists of a refused close')
    assert.ok(WF.includes(' Automatic decisions not taken, their issues back in open_issues: ') && WF.includes('HANDOFF entries not written'), 'run-phase.js: the two lists')
    assert.ok(text.run.includes('If `rule` refuses that text after the actions of the option were committed') && text.run.includes('write the decision line by hand: `decision · major · <title>: option <id> settled by the user — <description>` under `## <task>` of HANDOFF.md, then run plan-lint until "valid plan" and commit'), 'run: the decision line when rule refuses the text')
    assert.ok(REF.includes('For the second, the pilot writes the actions of the chosen option by hand') && REF.includes('records `rule` with the text `option <id>: <description>`, and `apply` writes the decision line'), 'reference.md: the second hand path')
    // T22-1: the compatibility of /4
    for (const [f, t] of [['upgrading.md', UPG], ['CHANGELOG.md', CL]]) assert.ok(t.includes('0.20.0 refuses, with `field unknown`, a `progress.json` that 0.21.0 has written, so going back to 0.20.0 is not supported') && /0\.21\.0 reads a (`progress\.json`|file) that 0\.20\.0 wrote/.test(t), f)
    // T22-3: the outputs the workflow reads, as progress.mjs prints them
    assert.ok(WF.includes("commit: nullable('string'), done: strs,") && /before_run: \{ type: 'array'/.test(WF) && SRC.progress.includes('result.before_run = before.map('), 'APPLY_S declares done and before_run')
    // T23-1, T23-2, T23-3
    both('starts no new wait', 'a stopped run starts no new wait')
    both('(`ruling_wait_minutes`, 15 min by default)', 'the deadline of the waits of a stopped run')
    assert.ok(text.run.includes('a wait left behind would mark its task waiting again after the run end') && REF.includes('a wait left behind would mark its task `waiting` again after the run end'), 'why a stopped run lets the waits end')
    both('nothing of the apply is written and the rulings stay recorded, so the next run applies them')
    both('the last commit `progress: rulings …` on the integration branch and the issues of `progress.json`')
    both('the same procedure as')
    assert.ok(REF.includes('with the log line `<id>: wait failed (...)`') && WF.includes(': wait failed ('), 'reference.md: a failed wait')
    assert.ok(REF.includes('its close writes the amendment as a blind-spot') && text.run.includes('its close writes the amendment as a blind-spot'), 'an amendment after the start')
    assert.ok(REF.includes('`waits`, always present since 0.22.1') && REF.includes('`done` in the output of `apply`'), 'reference.md: the optional fields')
    both('A held task waits once its dependencies are done and no apply runs; when that apply settled its issue, it starts without a wait.')
    assert.ok(REF.includes('it shows in `rulings_applied`, and the pilot does not have it settled again') && text.run.includes('it shows in `rulings_applied`, and you do not have it settled again'), 'open_issues and rulings_applied')
    // T24-1, T24-3: mode deviation
    assert.ok(text.run.includes('In mode `deviation`, an issue the run waits for that the user releases with `[ Decide later ]` stops the run as when its deadline passes, because a release is not a ruling (D3).') && REF.includes('In mode `deviation`, an issue the run waits for that you release with `[ Decide later ]` stops the run as when its deadline passes, because a release is not a ruling (D3).'), 'release in mode deviation')
    assert.ok(text.run.includes('On a stop, `open_issues` can hold an issue already ruled during the run and not applied yet. Before asking the user, read `pending_rulings` in `progress.json`, do not ask again about an issue ruled there, and tell the user that the next run start applies it.'), 'run: a ruled issue on a stop')
    assert.ok(REF.includes('reads `pending_rulings` in `progress.json`, does not ask again about an issue ruled there') && REF.includes('the first issue still waiting becomes `stop_issue` when none is set and the others go to `open_issues`'), 'reference.md: a ruled issue on a stop')
    // T25-1 to T25-4: the pane
    assert.ok(!/Resume the run|Settle when resuming/.test(REF), 'reference.md: no button of before 0.21.0')
    assert.ok(REF.includes('`[ Decide later ]` only when the issue holds a task') && REF.includes('`/orchestre:run plans/<name> --resume`'), 'reference.md: the issue card and how to resume')
    assert.ok(REF.includes('The pane reads `ISSUES.json` read-only') && REF.includes('an absent file counts as an empty register') && REF.includes('every answer from the pane goes through a command of `progress.mjs`'), 'reference.md: ISSUES.json')
    assert.ok(REF.includes('an issue with at least one option is `now`, a human issue and an issue whose options are all refused included; an issue without options stays `at run stop`') && REF.includes('A waiting task that carries an issue follows the rule of that issue.'), 'reference.md: the moment of an issue')
    assert.ok(REF.includes('it leaves out human issues, which are answered from their own card') && !REF.includes('a human issue with a valid recommended option included'), 'reference.md: Accept the N recommended')
    // Human issue ruled during a run
    assert.ok(text.run.includes('A `stop_issue` already ruled from the pane (its id in `pending_rulings`) is not asked again either: its ruling is applied at the pre-flight (point 4), and its task goes in `rerun` if the ruling restarts it.'), 'run: a stop_issue already ruled')
    both('neither lets the run go on nor restarts its `needs-human` task')
    // T28R: Undo during a run, the pre-flight, the deviation texts
    assert.ok(REF.includes('Undo during a run (0.22.0).') && REF.includes('leaves the withdrawn one out with a log line') && SRC.progress.includes('withdrawn while apply ran: left out'), 'reference.md: Undo during a run')
    assert.ok(text.run.includes('The rulings it applies here are recorded in the run that the next run start opens') && SRC.progress.includes('run.applied_before = before'), 'run: the rulings of the pre-flight recorded in the next run')
    for (const x of ['`Now: the run waits for it <m:ss>, then stops`', '`‖ run waits for you`', '`? <id>: <n> issues to settle now — the run waits for them <m> min, then stops`']) assert.ok(REF.includes(x), `reference.md: ${x}`)
    for (const x of [': the run waits for it ${timeLeft(p.until, now)}, then stops', "'  ‖ run waits for you'", "'‖ run waits for you'", '} to settle now — the run waits for ${']) assert.ok(VMS.includes(x), `view-model.mjs: ${x}`)
    // Run 9: the clerk runs once more a run end refused as altered, as the workflow asks
    assert.ok(clerk.includes('Run again after `payload altered in transit`') && clerk.includes('at the start of a task, at the close of a task and at the end of a run alike: run the command once, with the payload as received'), 'clerk.md: the run once more')
    assert.ok(WF.includes('const pAgain = `Your first run of the progress command below was refused (payload altered in transit)') && clerk.includes('`Your first run of the progress command below was refused (payload altered in transit)`'), 'clerk.md quotes the opening of pAgain')
    assert.ok(WF.includes("if (altered(g)) { log('run end: run-end refused, payload altered in transit; run again'); g = await end(true) }") && /const pClerk = \(v, again = false\) => `\$\{again \? pAgain : ''\}/.test(WF), 'run-phase.js: run-end run once more, with pAgain')
    // Run 9: the reason rule gives for an option that would be wasted
    assert.ok(REF.includes('`its amendments would all be discarded: <ids> merged or cancelled since the issue was raised; answer with a text`') && SRC.progress.includes('its amendments would all be discarded: ${ids.join'), 'reference.md: the reason of a wasted option')
  })

  test('outputs of close, wait and apply (0.22.1): every field the real progress.mjs prints, with an issue that holds a task and without one, a did pending and without one, is declared in CLOSE_OUT_S, WAIT_OUT_S and APPLY_S; every field printed every time, empty or not, is required; waits is an array of { issue, until, holds }', () => {
    // The top-level keys of a schema S({ … }, [ … ]) of run-phase.js, nested schemas left out
    const keysOf = name => {
      const i = WF.indexOf(`const ${name} = S({`), j = WF.indexOf('\nconst ', i + 1)
      assert.ok(i >= 0 && j > i, `run-phase.js: ${name}`)
      let t = WF.slice(i + `const ${name} = S({`.length, j)
      for (let k = 0; k < 6; k++) t = t.replace(/\([^()]*\)/g, '').replace(/\{[^{}]*\}/g, '').replace(/\[[^[\]]*\]/g, '')
      return new Set([...t.matchAll(/(?:^|[\s,])([a-z_]+):/g)].map(m => m[1]))
    }
    // The required list of a schema: its last [ … ]. A field the script prints every time must be in it, or an agent that drops it
    // (run 14: the clerk dropped waits: []) makes its copy's digest differ and stops the run on 'output of close not read'
    const requiredOf = name => {
      const i = WF.indexOf(`const ${name} = S({`), j = WF.indexOf('\nconst ', i + 1)
      const m = WF.slice(i, j).trim().match(/\}, \[([^\]]*)\]\)$/)
      assert.ok(m, `run-phase.js: the required list of ${name}`)
      return new Set([...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]))
    }
    const CLOSE = keysOf('CLOSE_OUT_S'), APPLY = keysOf('APPLY_S'), WAIT = keysOf('WAIT_OUT_S')
    const always = (out, name, label) => { const req = requiredOf(name); for (const k of Object.keys(out)) assert.ok(req.has(k), `${label}: ${k} is printed but not required by ${name}`) }
    assert.ok(CLOSE.has('waits') && CLOSE.has('digest') && !CLOSE.has('issue'), [...CLOSE].join())
    assert.ok(APPLY.has('done') && APPLY.has('before_run') && APPLY.has('amended') && !APPLY.has('verification'), [...APPLY].join())
    assert.ok(WF.includes("const WAITS_S = { type: 'array', items: S({ issue: str, until: str, holds: strs }, ['issue', 'until', 'holds']) }"), 'WAITS_S')
    assert.ok(/const holdFrom = out => \{ for \(const w of arr\(out\.waits\)\) for \(const id of arr\(w\.holds\)\)/.test(WF), 'the workflow reads the held tasks from waits[].holds')
    // A plan of two tasks of phase 1 and a manual prerequisite, on its integration branch
    const D = tempDir('outputs-')
    assert.equal(spawnSync('sh', [join(ROOT, 'tests', 'toy-repo.sh'), join(D, 'r')], { encoding: 'utf8' }).status, 0)
    const R = join(D, 'r'), git = gitIn(R), plan = join(R, 'plans', 'demo')
    git('switch', '-q', 'plan/demo')
    writeFileSync(join(plan, 'tasks', 'T02-other.md'), read(join(plan, 'tasks', 'T01-hello.md')).replace('id: T01', 'id: T02').replace('title: Hello script', 'title: Other script').replace(/src\/hello\.sh/g, 'src/other.sh'))
    writeFileSync(join(plan, 'PREREQUISITES.md'), '# PREREQUISITES — demo\n\n| ID | Type | Prerequisite | Status | Evidence |\n|----|------|--------------|--------|----------|\n| M1 | manual | A token | open | |\n\nTypes: decision · manual · environment.\n')
    git('add', '.'); git('commit', '-qm', 'plan')
    const run = (cmd, E, env = {}) => { const r = spawnSync('node', [join(SCRIPTS, 'progress.mjs'), cmd, 'plans/demo', ...(E ? ['--json', JSON.stringify(E)] : [])], { cwd: R, encoding: 'utf8', env: { ...process.env, ...env } }); assert.equal(r.status, 0, `${cmd}: ${r.stderr}`); return r.stdout.trim() }
    const within = (out, keys, label) => { for (const k of Object.keys(out)) assert.ok(keys.has(k), `${label}: field ${k} not declared`) }
    run('view')
    git('add', '.'); git('commit', '-qm', 'view', '--allow-empty')
    run('run-start', { phase: 1, mode: 'phase', parallelism: 1, max_fixes: 2, max_auto_decisions: 3 })
    const held = JSON.parse(run('close', { task: 'T01', status: 'merged', attempts: 1, branch: 'task/T01', issues: [{ title: 'Lint', context: 'c', human: false, options: [{ id: 'A', description: 'Lint T02', amendments: [{ id: 'T02', reason: 'r', verification: ['sh src/other.sh'] }] }] }] }))
    assert.deepEqual(held.waits.map(w => [Object.keys(w).sort(), w.holds]), [[['holds', 'issue', 'until'], ['T02']]])
    within(held, CLOSE, 'close with an issue that holds a task'); always(held, 'CLOSE_OUT_S', 'close with an issue that holds a task')
    // wait: the issue is open and has a deadline, so the call answers again after the shortened wait
    const waited = JSON.parse(run('wait', { task: 'T02', issues: ['T01-1'] }, { ORCHESTRE_WAIT_SECONDS: '1' }))
    assert.equal(waited.again, true)
    within(waited, WAIT, 'wait'); always(waited, 'WAIT_OUT_S', 'wait')
    run('rule', { issue: 'T01-1', option: 'A' })
    const applied = JSON.parse(run('apply'))
    assert.ok(!('done' in applied) && applied.applied.length === 1)
    within(applied, APPLY, 'apply without a did'); always(applied, 'APPLY_S', 'apply without a did')
    run('did', { prerequisite: 'M1' })
    const done = JSON.parse(run('apply'))
    assert.deepEqual(done.done, ['M1'])
    within(done, APPLY, 'apply with a did')
    assert.ok(!requiredOf('APPLY_S').has('done') && !requiredOf('APPLY_S').has('before_run'), 'done and before_run are printed only sometimes: not required')
    const plain = JSON.parse(run('close', { task: 'T02', status: 'blocked', attempts: 1, branch: 'task/T02', blocker: ['x'] }))
    assert.deepEqual(plain.waits, [])
    within(plain, CLOSE, 'close without an issue'); always(plain, 'CLOSE_OUT_S', 'close without an issue')
  })

  test('challenger (0.22.0): the rules of challenger.md match the instructions and the schema of the workflow; isolated, it runs simple commands and no progress command', () => {
    const agent = a => read(join(PLUGIN, 'agents', `${a}.md`))
    const ch = agent('challenger')
    const def = name => { const i = WF.indexOf(`const ${name} = `); assert.ok(i >= 0, `run-phase.js: ${name}`); return WF.slice(i, WF.indexOf('\nconst ', i + 1)) }
    const inWF = x => WF.includes(x.replace(/`/g, '\\`'))
    // The agent: sonnet (D9), isolated in a worktree, without an MCP tool
    const fm = ch.match(/^---\n([\s\S]*?)\n---\n/)[1]
    for (const x of [/^name: challenger$/m, /^model: sonnet$/m, /^isolation: worktree$/m]) assert.match(fm, x, 'challenger.md: ' + x)
    assert.ok(WF.includes("agentType: AG('challenger'), model: 'sonnet', schema: CHALLENGE_S, isolation: 'worktree'"), 'run-phase.js: the challenger call')
    // Only for a task marked challenge: true, after a pass; its gaps reject the attempt by the challenge
    assert.ok(WF.includes("else if (t.challenge === true) { const survivors = await challenge(t, r, trace); if (survivors.length) { by = 'challenge'; gaps = survivors } }"), 'run-phase.js: the challenge after a pass')
    // 3 mutations at most, in the workflow and in the rules
    const max = Number((WF.match(/\nconst MUTATIONS_MAX = (\d+)\n/) || [])[1])
    assert.equal(max, 3)
    assert.ok(ch.includes(`${max} mutations at most, one at a time`) && WF.includes('${MUTATIONS_MAX} mutations at most, one at a time') && WF.includes('c.mutations.slice(0, MUTATIONS_MAX)'), 'the cap of mutations')
    // The commands of the instructions, in the rules too: the detached checkout, the restore, the clean state, the path
    for (const x of ['`git switch --detach ', '`git checkout HEAD -- <file>`', '`git status --porcelain`', '`pwd`']) { assert.ok(ch.includes(x), `challenger.md: ${x}`); assert.ok(inWF(x), `run-phase.js: ${x}`) }
    // The restore is pinned in the challenger's own prompt: the clerk's instructions cite the same command elsewhere in the file
    assert.ok(def('pChallenge').includes('\\`git checkout HEAD -- <file>\\`'), 'run-phase.js: pChallenge restores with git checkout HEAD -- <file>')
    for (const x of ['never the branch itself, which the main checkout or the worker\'s worktree holds', 'never a test']) { assert.ok(ch.includes(x), `challenger.md: ${x}`); assert.ok(inWF(x), `run-phase.js: ${x}`) }
    // The fields it returns: those of CHALLENGE_S and MUTATION_S, each cited in its rules, as the workflow names them
    const keys = name => [...def(name).replace(/\[[^\]]*\]\)$/m, '').matchAll(/(\w+): (?:str|bool|\{)/g)].map(m => m[1])
    const fields = [...keys('MUTATION_S'), ...keys('CHALLENGE_S').filter(k => k !== 'type' && k !== 'items')]
    assert.deepEqual(sorted(fields), sorted(['file', 'line', 'change', 'detected', 'by', 'equivalent', 'reason', 'ok', 'path', 'mutations', 'detail']))
    for (const k of fields) { assert.ok(ch.includes(`\`${k}\``), `challenger.md: ${k}`); assert.ok(def('pChallenge').includes(`"${k}"`) || def('pChallenge').includes(` ${k}=`), `run-phase.js, pChallenge: ${k}`) }
    // Equivalent mutants (0.22.1, #17): `equivalent` and `reason` in the schema, the rules and the instructions; only a reason makes a
    // mutation equivalent; the mutations of the earlier passes are given to the next one; the fix answers a survivor by a
    // deviation and the evaluator weighs it
    assert.ok(def('MUTATION_S').includes('equivalent: bool, reason: str') && def('MUTATION_S').includes("['file', 'change', 'detected'])"), 'MUTATION_S declares equivalent and reason, both optional')
    for (const k of ['equivalent', 'reason']) assert.ok(ch.includes(`\`${k}\``) && def('pChallenge').includes(`"${k}"`), `${k}: in challenger.md and in pChallenge`)
    assert.ok(ch.includes('`equivalent` without a `reason` counts as not detected') && def('pChallenge').includes('"equivalent" without a "reason" counts as not detected'), 'an equivalent mutation without a reason counts as not detected')
    assert.ok(ch.includes('do not try them again, pick other lines of the diff') && def('pChallenge').includes('do not try them again, pick other lines of the diff') && WF.slice(WF.indexOf('async function challenge')).includes('pChallenge(t, r, cmds, trace.tried)'), 'the mutations already tried')
    assert.ok(WF.includes('const equivalentOf = m => m.detected === false && m.equivalent === true && typeof m.reason === \'string\' && oneLine(m.reason) !== \'\''), 'run-phase.js: equivalentOf')
    assert.ok(def('pFix').includes('answer it with a deviation of your report that names the mutation (file:line) and says why no test could observe it') && def('pEval').includes('weigh its reason against the diff, and accept it only if it holds'), 'pFix and pEval: the deviation of an equivalent survivor')
    assert.ok(WF.includes('pEval(t, r, facts, scope, null, challenged)') && WF.includes('pEval(t, r, facts, scope, refusal, challenged)'), 'run-phase.js: both evaluations get the survivors')
    // The gap of a survivor keeps its text: the pane strips the prefix (T38)
    assert.ok(WF.includes('`mutation not detected by any verification command: ${where(m)}, ${oneLine(m.change)}`'), 'run-phase.js: the gap text of a survivor')
    // Isolated: no progress command (the clerk notes its step), and the guard rules of the isolated worker, word for word
    assert.ok(ch.includes('you run no progress command (`progress.mjs`)') && !/ORCHESTRE_JSON|progress_ok|heredoc/.test(ch), 'challenger.md: no progress command')
    assert.ok(!/progressCmd\(|pStep\(/.test(def('pChallenge')) && /progressCmd\('step', \{ task: t\.id, step: 'challenge' \}\)/.test(def('pChallengeStep')), 'run-phase.js: the step of the challenge by the clerk only')
    const guard = t => t.slice(t.indexOf('- Commands, in your worktree:'), t.indexOf('\n', t.indexOf('  - the exit code is read')))
    assert.ok(guard(ch).length > 300 && guard(ch) === guard(agent('isolated-worker')), 'challenger.md: the guard rules of isolated-worker.md')
  })

  test('challenge (0.22.0): the key cited by the skills and format.md is the one plan-lint validates and the workflow reads', () => {
    // plan-lint: boolean key, refused otherwise, in the view only when true; the workflow reads it as `t.challenge === true`
    assert.ok(SRC['plan-lint'].includes("challengeState(t.challenge) === 'rejected'") && SRC['plan-lint'].includes('challenge must be true or false'), 'plan-lint: the key is validated')
    assert.ok(WF.includes('t.challenge === true') && WF.includes("agentType: AG('challenger')"), 'run-phase.js: the key and the challenger')
    // format.md: the key in the template and its rule, with the cap the workflow applies
    assert.match(FORMAT, /^challenge: true +#/m, 'format.md: the key in the task template')
    const max = WF.match(/\nconst MUTATIONS_MAX = (\d+)\n/)[1]
    assert.ok(FORMAT.includes('`challenge: true` (0.22.0)') && FORMAT.includes(`${max} mutations at most`) && FORMAT.includes('Only `true` or `false` is accepted'), 'format.md: the rule of the key')
    // The skills: prepare marks the risky tasks and says so, ready offers the key for an older plan, run explains a rejection by the challenge
    assert.ok(text.prepare.includes('Mark `challenge: true`') && text.prepare.includes('whose reason to stand alone is risk') && /summary \(step 6\)/.test(text.prepare.slice(text.prepare.indexOf('Mark `challenge: true`'), text.prepare.indexOf('Mark `challenge: true`') + 600)), 'prepare: marks the risky tasks')
    assert.ok(text.prepare.includes('`challenge: true` for the risky ones'), 'prepare: the summary names them')
    assert.ok(text.ready.includes('add `challenge: true`') && text.ready.includes('plan written before 0.22.0'), 'ready: offers the key')
    assert.ok(text.run.includes('`by: challenge`') && WF.includes("by = 'challenge'"), 'run: explains a rejection by the challenge')
    // The docs describe the key and the challenger, and cite commands that exist
    const REF = read(join(ROOT, 'docs', 'reference.md')), CONF = read(join(ROOT, 'docs', 'configuration.md')), UPG = read(join(ROOT, 'docs', 'upgrading.md'))
    for (const [f, t] of [['reference.md', REF], ['configuration.md', CONF], ['upgrading.md', UPG]]) assert.ok(t.includes('`challenge: true`'), `${f}: the key`)
    assert.ok(REF.includes('| Challenge | `challenger` | sonnet |') && REF.includes('`worktrees.mjs clean`'), 'reference.md: the challenger step')
    for (const f of [REF, CONF, UPG.slice(UPG.indexOf('## From 0.21.0 to 0.22.0'), UPG.indexOf('## From 0.20.0 to 0.21.0'))]) for (const m of f.matchAll(/\/orchestre:([a-z]+)/g)) assert.ok(SKILLS.includes(m[1]), `/orchestre:${m[1]} exists`)
    // The version: the section of the changelog, the README badge and the upgrade note
    const version = JSON.parse(read(join(PLUGIN, '.claude-plugin', 'plugin.json'))).version
    assert.ok(version >= '0.22.0', 'version 0.22.0 or later')
    assert.ok(/^## 0\.22\.0 — \d{4}-\d{2}-\d{2}: .+$/m.test(read(join(ROOT, 'CHANGELOG.md'))), 'CHANGELOG.md: ## 0.22.0 — <date>: <title>')
    assert.ok(UPG.includes('## From 0.21.0 to 0.22.0'), 'upgrading.md: the 0.22.0 section')
  })

  test('skills, docs and version (0.22.1): rulings after the last run, a dead run, the texts of 0.22.0 corrected, the prefix of the challenger gaps', () => {
    const REF = read(join(ROOT, 'docs', 'reference.md')), CONF = read(join(ROOT, 'docs', 'configuration.md')), UPG = read(join(ROOT, 'docs', 'upgrading.md')), CL = read(join(ROOT, 'CHANGELOG.md')), README = read(join(ROOT, 'README.md'))
    const APPLY = 'node ${CLAUDE_PLUGIN_ROOT}/scripts/progress.mjs apply <plan>'
    const at4 = text.run.indexOf('Rulings recorded outside a run'), point4 = text.run.slice(at4, text.run.indexOf('\n5. Read `orchestre.config.json`'))
    const end = text.run.slice(text.run.indexOf('## 4. End'), text.run.indexOf('## During a run'))
    // #18: section 4 applies the rulings recorded after the last run, with the command of point 4
    assert.ok(at4 > 0 && point4.includes(`\`${APPLY}\``), 'run: apply at point 4')
    assert.ok(end.includes(`\`${APPLY}\``), 'run: section 4 cites the same apply command as point 4')
    for (const w of ['Rulings recorded after the last run', 'no run is `in-progress`', '`pending_rulings`', '`pending_done`', '`progress.mjs unrule`', '`progress.mjs undid`', 'from the main checkout, on the integration branch', 'copy its output', 'say in one line what it applied']) assert.ok(end.includes(w), `run, section 4: ${w}`)
    assert.ok(REF.includes('Rulings recorded after the last run of a plan are applied the same way at the end of `/orchestre:run` (0.22.1)'), 'reference.md: the rulings applied at the end')
    // #19: a run still in-progress at point 4 is asked about, as at point 6, and apply --run-stopped marks it
    for (const w of ['If `progress.json` marks a run `in-progress`, ask the user, as at point 6, whether that run is stopped', '`' + APPLY + ' --run-stopped`', 'it first marks that run `interrupted`', '`applied_outside`', 'that answer also holds for `worktrees.mjs clean` at point 6']) assert.ok(point4.includes(w), `run, point 4: ${w}`)
    assert.ok(text.run.includes('If the user said at the migration or at the rulings (point 4) that the run is stopped'), 'run: point 6 follows the answer of point 4')
    assert.ok(SRC.progress.includes("'--run-stopped'") && optionsOf(SRC.progress).has('--run-stopped'), 'progress.mjs knows --run-stopped')
    assert.ok(REF.includes('runs `apply <plan> --run-stopped` (0.22.1)') && REF.includes('never into that run'), 'reference.md: where the rulings go for a dead run')
    // T40: reference.md
    for (const w of ['`/orchestre:run` handles it first, whatever the `status`, before any rerun of the phase', 'A `blocked` or `needs-human` task with that entry was closed by the workflow', 'the pilot does not write them again', 'an `interrupted` or `failed` task (no close) is handled as `merged_unclosed` above']) assert.ok(REF.replace(/\s+/g, ' ').includes(w), `reference.md: T40 without "${w}"`)
    // #20, #12, #17: merge unknown without the breaker, no mutation tried, an equivalent mutation
    for (const w of ['gave no verdict (no answer, an error or the circuit breaker)', 'with or without the breaker', '`challenge of <id>: no mutation tried`', 'an equivalent mutation the challenger reports with a reason is logged and not counted', 'answers a survivor it judges equivalent with a deviation that says why']) assert.ok(text.run.replace(/\s+/g, ' ').includes(w), `run: ${w}`)
    for (const w of ['`merge: "unknown"`, with or without the breaker', 'no mutation tried', '`equivalent: true`', 'neither rejects nor uses up `max_fixes`', 'the evaluator weighs']) assert.ok(REF.replace(/\s+/g, ' ').includes(w), `reference.md: ${w}`)
    // #13: the texts of 0.22.0 corrected against the code
    assert.ok(REF.includes('for the steps that go through the clerk or the plan reader') && REF.includes('are not retried'), 'reference.md: the steps whose refused write is retried')
    assert.ok(CL.includes('for the steps that go through the clerk or the plan reader only'), 'CHANGELOG.md: the retry of 0.20.0')
    for (const [f, t] of [['upgrading.md', UPG], ['configuration.md', CONF]]) assert.ok(t.includes('counted from the close of the task that raised the issue'), `${f}: ruling_wait_minutes is a deadline`)
    assert.ok(REF.includes('`? <task>: N issues to settle now`') && REF.includes('`▶ <task> starts without your ruling`'), 'reference.md: the notifications of 0.21.0')
    assert.ok(REF.includes('an issue with an option is `now`, 0.21.0') && !REF.includes('(during a run, an issue, a decision to take'), 'reference.md: the moment of an issue')
    assert.ok(!CL.includes('the pane and `status` show it invalid') && CL.includes('`progress.mjs status` show it invalid with the same reason'), 'CHANGELOG.md: status of the invalid option')
    const VMS = read(join(PLUGIN, 'hooks', 'view-model.mjs')), prefix = VMS.match(/const MUTATION_PREFIX = '([^']+)'/)
    assert.ok(prefix && WF.includes('`' + prefix[1] + '${where(m)}'), 'view-model.mjs strips the prefix run-phase.js writes on each challenger gap')
    // #14: README
    for (const w of ['`[ Other… ]`', '`[ Accept the N recommended ]`', '`[ ✓ I did it ]`', 'withdraws a ruling or a `did`', 'challenge{"challenge<br/>', 'Going back to 0.19, 0.20 or 0.21 is not supported; going back within 0.22 is.', 'to 0.22.3.']) assert.ok(README.includes(w), `README.md: ${w}`)
    assert.ok(!README.includes('from 0.12 and from 0.11'), 'README.md: no stale upgrading line')
    // #15: the pre-flight and the challenger's worktrees; the downgrade text of 0.22.0 is pinned as that of 0.21.0 is
    assert.ok(REF.includes("the challenger's detached worktrees go with them when the run has no progress, and one that has changes or commits of its own is kept and reported"), 'reference.md: the challenger worktrees at the pre-flight')
    assert.ok(/The step `challenge`|step `challenge`/.test(REF) && SRC.worktrees.includes('one with commits of its own is reported, never removed'), 'worktrees.mjs: the header says what reference.md says')
    for (const [f, t] of [['upgrading.md', UPG], ['CHANGELOG.md', CL]]) assert.ok(/0\.21\.0 refuses a `progress\.json` that holds one of (these|the 0\.22\.0) additions \(`is not allowed` for the step (or the rejection )?`challenge`, `field unknown` for `applied_outside` and `applied_before`\)/.test(t) && t.includes('going back to 0.21.0 is not supported'), `${f}: the downgrade text of 0.22.0`)
    // The version: 0.22.1, the badge, the section and ten lines, the upgrade note, and the commands cited exist
    const version = JSON.parse(read(join(PLUGIN, '.claude-plugin', 'plugin.json'))).version
    assert.ok(version >= '0.22.1', 'version 0.22.1 or later')
    const at1 = CL.indexOf('## 0.22.1 — '), first = CL.slice(at1, CL.indexOf('\n## ', at1 + 4))
    assert.ok(/^## 0\.22\.1 — \d{4}-\d{2}-\d{2}: .+$/m.test(first.split('\n')[0]), 'CHANGELOG.md has the section ## 0.22.1 — <date>: <title>')
    assert.deepEqual(first.split('\n').filter(l => /^Fixes #\d+\.$/.test(l)), Array.from({ length: 10 }, (_, i) => `Fixes #${11 + i}.`), 'CHANGELOG.md: Fixes #11. to Fixes #20.')
    assert.ok(first.includes('which clears the `isCollapsed` type warnings of `npm run validate`') && !first.includes('clears the type warnings'), 'CHANGELOG.md 0.22.1: the Pane bullet claims only the isCollapsed warnings')
    assert.ok(UPG.includes('## From 0.22.0 to 0.22.1') && UPG.includes('Going back to 0.22.0 is supported'), 'upgrading.md: the 0.22.1 section')
    const sec = UPG.slice(UPG.indexOf('## From 0.22.0 to 0.22.1'), UPG.indexOf('## From 0.21.0 to 0.22.0'))
    for (const m of [...sec.matchAll(/\/orchestre:([a-z]+)/g), ...first.matchAll(/\/orchestre:([a-z]+)/g)]) assert.ok(SKILLS.includes(m[1]), `/orchestre:${m[1]} exists`)
    for (const m of [...sec.matchAll(/progress\.mjs ([a-z-]+)/g), ...first.matchAll(/progress\.mjs ([a-z-]+)/g)]) assert.ok(SRC.progress.match(/usage: progress\.mjs <([a-z|-]+)>/)[1].split('|').includes(m[1]), `progress.mjs ${m[1]}`)
  })

  test('docs and version (0.22.2): the doc fixes of #26 to #28, the step of a fix and the breaker detail, the section and seven lines', () => {
    const REF = read(join(ROOT, 'docs', 'reference.md')), README = read(join(ROOT, 'README.md')), UPG = read(join(ROOT, 'docs', 'upgrading.md')), CL = read(join(ROOT, 'CHANGELOG.md'))
    const flat = t => t.replace(/\s+/g, ' ')
    // #27: the 0.20.0 retry no longer lists the wait (it arrived in 0.21.0)
    const at20 = CL.indexOf('## 0.20.0 — '), s20 = CL.slice(at20, CL.indexOf('\n## ', at20 + 4))
    assert.ok(s20.includes('for the steps that go through the clerk or the plan reader only (the run start, the start of a task, the close and the run end)') && !s20.includes('the wait'), 'CHANGELOG.md 0.20.0: the retry list without the wait')
    assert.ok(REF.includes('about thirty of which run the real `progress.mjs` or `worktrees.mjs` (two the real `plan-lint.mjs`)'), 'reference.md: the scenarios that run real scripts')
    // #28: the two README rows and the downgrade sentence
    assert.ok(/^\| `\[ Accept the N recommended \]` \| "Your turn" card \|/m.test(README) && /^\| `\[ ✓ I did it \]` \| Detail card of a prerequisite \|/m.test(README), 'README.md: the two buttons in their own rows')
    assert.ok(!/`\[ Decide later \]`, `\[ Accept/.test(README), 'README.md: the row of the issue card no longer holds them')
    assert.ok(README.includes('Going back to 0.19, 0.20 or 0.21 is not supported; going back within 0.22 is.'), 'README.md: the downgrades')
    // T41: the step of a fix and the breaker detail
    assert.ok(flat(REF).includes('`step` payload carries each gap whole, on one line, never cut with an ellipsis (0.22.2)'), 'reference.md: whole gaps in the step of a fix')
    assert.ok(flat(REF).includes('`<ids> without a merge verdict, which may have run: see merged_unclosed.`') && WF.includes('without a merge verdict, which may have run: see merged_unclosed'), 'reference.md and run-phase.js: the breaker detail')
    // The version, the section, seven lines, the upgrade note, the commands cited
    const version = JSON.parse(read(join(PLUGIN, '.claude-plugin', 'plugin.json'))).version
    assert.ok(version >= '0.22.2', 'version 0.22.2 or later')
    const at = CL.indexOf('\n## 0.22.2 — ') + 1, first = CL.slice(at, CL.indexOf('\n## ', at + 4))
    assert.ok(/^## 0\.22\.2 — \d{4}-\d{2}-\d{2}: .+$/.test(first.split('\n')[0]), 'CHANGELOG.md: section ## 0.22.2 — <date>: <title>')
    assert.deepEqual(first.split('\n').filter(l => /^Fixes #\d+\.$/.test(l)), Array.from({ length: 7 }, (_, i) => `Fixes #${22 + i}.`), 'CHANGELOG.md: Fixes #22. to Fixes #28.')
    assert.ok(!first.includes('#29'), 'CHANGELOG.md 0.22.2 does not cite #29')
    assert.ok(UPG.includes('## From 0.22.1 to 0.22.2') && UPG.includes('Going back to 0.22.1 is supported'), 'upgrading.md: the 0.22.2 section')
    const sec = UPG.slice(UPG.indexOf('## From 0.22.1 to 0.22.2'), UPG.indexOf('## From 0.22.0 to 0.22.1'))
    for (const m of [...sec.matchAll(/\/orchestre:([a-z]+)/g), ...first.matchAll(/\/orchestre:([a-z]+)/g)]) assert.ok(SKILLS.includes(m[1]), `/orchestre:${m[1]} exists`)
    for (const m of [...sec.matchAll(/progress\.mjs ([a-z-]+)/g), ...first.matchAll(/progress\.mjs ([a-z-]+)/g)]) assert.ok(SRC.progress.match(/usage: progress\.mjs <([a-z|-]+)>/)[1].split('|').includes(m[1]), `progress.mjs ${m[1]}`)
  })

  console.log(`commands: ALL GREEN (${n} tests)`)
} finally {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
}
