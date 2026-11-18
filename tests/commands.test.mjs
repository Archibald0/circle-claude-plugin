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
    assert.match(text.run, /With `--resume`[^\n]*list the rulings recorded and not applied yet: the `pending_rulings` of `progress\.json`/)
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
    assert.match(WF, /label: `\$\{t\.id\} · merge`[^\n]*\n\s*\.catch\(err => \{ if \(err === INTERRUPT && launched\) unclosedOf\([^\n]*, true\); throw err \}\)/, 'workflow: the integrator call marks its task merge unknown')
    const cited = `\`merge: "${marker[1]}"\``
    assert.ok(breaker.includes(`the tasks in \`interrupted\` are taken up by the next run, from their branch, except a task that is also in \`merged_unclosed\` with ${cited}`), 'run: the exception to the tasks in interrupted')
    const at = mu.indexOf(`An entry with ${cited}`)
    assert.ok(at > 0, 'run: an entry with a merge unknown')
    const unk = mu.slice(at)
    for (const w of ['Before the new run, check whether a commit `task <id>:` is on the integration branch', 'If it is, the task is merged: handle the entry as above', 'run the task\'s verifications on the integration branch before the new run, as for `repair`', 'If it is not, the merge did not run: say that the next run takes the task up from its branch']) assert.ok(unk.includes(w), `run: merge unknown without "${w}"`)
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
    assert.ok(WF.includes("`${isolated ? '' : pStep(t.id, 'worker', { isolated: false, model })}Task"), 'run-phase.js: no step in the instructions of the isolated worker')
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
    // An issue without an entry in ISSUES.json: a free answer only. A refused ruling: open again only when apply reopened it
    assert.ok(text.run.includes('an issue of `progress.json` that has no entry in `ISSUES.json`') && text.run.includes('offer no option and ask for a free answer, since `apply` refuses an option whose actions it does not know'), 'run: free answer for an issue without an ISSUES.json entry')
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
    assert.ok(from > 0 && closeDoc.includes(`\`{ ${req.join(', ')} }\``), `docs/reference.md: the output of close, ${req.join(', ')}`)
    for (const w of ['`entries`', '`discarded_amendments`', '`added_tasks`, `{ id, title, phase, content }`, a task file being written only when `content` is given', '`issues`, whole', '`auto: <option id>`', 'and commits them', 'in one commit `progress(<id>): <status>`']) assert.ok(closeDoc.includes(w), `docs/reference.md: close without ${w}`)
    assert.ok(REF.includes('`ruling.commit` stays null in ISSUES.json, for a user ruling and for `auto`') && REF.includes('The commit is in the `commit` field of the output of `apply` (of `close` for `auto`)'), 'docs/reference.md: ruling.commit')
    assert.ok(REF.includes('`amendment · minor · <id>: depends on <other>, added automatically: …`') && SRC.progress.includes('depends on ${d.on}, added automatically: '), 'docs/reference.md: the dependency added on an overlap')
    assert.ok(REF.includes('`rulings_refused`, `[{ issue, option, text, reason }]`, comes with status `awaiting-ruling` and no `stop_issue`') && REF.includes('`rulings_applied` lists the rulings `apply` applied at the start of the run, `[{ issue, task, option, text }]`'), 'docs/reference.md: the return of 0.20.0')
    const prefixes = [...REF.matchAll(/`detail` that starts with "([^"]+)"/g)].map(m => m[1])
    for (const x of ['progress: rulings not applied (apply)', 'progress: output of apply not read']) assert.ok(prefixes.includes(x), `docs/reference.md: the detail "${x}"`)
    for (const x of prefixes) assert.ok(WF.includes(x), `docs/reference.md cites a detail the workflow does not write: ${x}`)
    assert.ok(REF.includes('then records the answer with `rule`; the next run start applies it with `apply`') && REF.includes('the issues of `merged_unclosed` (a circuit breaker return) reached neither `progress.json` nor ISSUES.json, so `rule` refuses them') && REF.includes('runs plan-lint until "valid plan", then commits on the integration branch'), 'docs/reference.md: the two paths')
  })

  console.log(`commands: ALL GREEN (${n} tests)`)
} finally {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
}
