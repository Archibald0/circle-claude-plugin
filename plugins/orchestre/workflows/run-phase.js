export const meta = {
  name: 'run-phase',
  description: 'Runs one phase of a plan (folder plans/<name>): workers, verification, evaluation, fixes, merge and progress. Launched by /orchestre:run.',
  phases: [{ title: 'Plan reading' }, { title: 'Tasks' }, { title: 'Wrap-up' }],
}

// Orchestrator 0.12.0 (orchestre plugin)
// args: { plan, phase, mode: 'auto'|'deviation'|'phase', parallelism, integration, base, decisions, max_fixes, escalation, max_auto_decisions,
//   rulings, rerun, lint, agent_prefix, progress, setup, shared_setup, language }
// base: branch the integration branch starts from (main by default, read by plan-lint)
// lint: path of scripts/plan-lint.mjs, required (0.12.0): /orchestre:run passes it; the fallback of the manual install (v0.5) is gone
// rulings: options chosen by the user since the previous run, [{ task, title, option }]; the scribe applies them before the plan is read
// rerun: ids of "needs-human" tasks the user restarts, after their decision
// progress (0.8.0): path of scripts/progress.mjs, sole writer of progress.json and of the PROGRESS.md view (contract orchestre-progress/3
//   since 0.12.0, which converts a file of orchestre-suivi/2 or /1).
//   The workflow launches nothing: it writes in its agents' instructions the command to run, and reads its result in progress_ok.
//   Without progress: progress as in 0.6.3, the scribe edits PROGRESS.md itself.
// setup (0.8.0): project commands that bring a working folder up to date (dependencies, generated code), taken from
//   orchestre.config.json by /orchestre:run; run by each worker after its branch, and by the integrator between the merge
//   and the post-merge check. The plugin knows no stack: it runs what the project declares.
// shared_setup: { <resource>: [commands] } for a shared service (test database); run only by the agents
//   of a task that declares this resource, hence under its lock: two tasks never prepare the same database at the same time.
// Models (0.11.0): the worker runs on the task's model (plan-lint), as is. After each rejected attempt, the replanner
//   chooses the model of the next fix from the rejection; the task's model is a floor, and without a valid answer
//   the escalation ladder applies. The choice holds for the run. Task without a model: sonnet, then the ladder, without a call (0.10 and earlier).
//   The worker and each fix pass their model, and the change if there is one, in their step command.
// language (0.12.0): language of the free text the agents write (summaries, descriptions, findings, gaps, issues, HANDOFF.md and
//   DISCOVERY.md content), "en" by default; keys, statuses, types and section titles stay in English.
const A = args || {}
const PLAN = A.plan
const PHASE = Number(A.phase)
const MODE = A.mode || 'phase'
const PAR = Math.max(1, Math.min(Number(A.parallelism) || 4, 8))
const INTEG = A.integration
const MAXFIX = A.max_fixes ?? 2
const ESC = A.escalation || ['sonnet', 'opus']
const DECISIONS = A.decisions || []
const MAX_AUTO = A.max_auto_decisions ?? 3
const DONE = s => s === 'merged' || s === 'cancelled'
const RULINGS = (A.rulings || []).filter(a => a && a.option)
const RERUN = new Set(A.rerun || [])
// Namespaced agents ("orchestre:worker"); /orchestre:run passes agent_prefix and lint
const AG = n => (A.agent_prefix ?? 'orchestre:') + n
const LINT = typeof A.lint === 'string' && A.lint.trim() ? A.lint : null
const LINTCMD = LINT && (/\s/.test(LINT) ? `node "${LINT}"` : `node ${LINT}`)
const BASE = A.base ? ` --base ${A.base}` : ''
const PROGRESS = A.progress || null
const PROGRESS_CMD = PROGRESS && (/\s/.test(PROGRESS) ? `node "${PROGRESS}"` : `node ${PROGRESS}`)
const PLANARG = /\s/.test(PLAN || '') ? `"${PLAN}"` : PLAN
// A file of the plan in a command, quoted when the plan path has a space
const planFile = f => (/\s/.test(PLAN || '') ? `"${PLAN}/${f}"` : `${PLAN}/${f}`)
// Task title in the merge message, between double quotes: no quote, backtick, dollar or backslash for the shell to read
const forMessage = x => oneLine(x).replace(/["`]/g, "'").replace(/[$\\]/g, '')
// JSON object in single quotes: apostrophe, backtick and dollar as \u escapes, nothing else in it is interpreted by the shell.
// A single command, without heredoc or pipe: the rule Bash(node <progress.mjs> *) is enough
const forShell = x => `'${JSON.stringify(x).replace(/'/g, '\\u0027').replace(/`/g, '\\u0060').replace(/\$/g, '\\u0024')}'`
const progressCmd = (cmd, E) => `${PROGRESS_CMD} ${cmd} ${PLANARG} --json ${forShell(E)}`
// Cleaning of the worktrees of earlier attempts, by the clerk at the end of the run: scripts/worktrees.mjs, next to progress.mjs
const WORKTREES = PROGRESS && PROGRESS.replace(/progress\.mjs$/, 'worktrees.mjs')
const WTCMD = WORKTREES && (/\s/.test(WORKTREES) ? `node "${WORKTREES}"` : `node ${WORKTREES}`)
// Environment setup (see args): project commands, non-empty strings
const commands = x => (Array.isArray(x) ? x : []).filter(c => typeof c === 'string' && c.trim())
const SETUP = commands(A.setup)
const SHARED_SETUP = Object.fromEntries(Object.entries(A.shared_setup && typeof A.shared_setup === 'object' && !Array.isArray(A.shared_setup) ? A.shared_setup : {}).map(([r, c]) => [r, commands(c)]).filter(([, c]) => c.length))
const setupOf = t => [...SETUP, ...(t.resources || []).flatMap(r => SHARED_SETUP[r] || [])]
// Texts passed to progress: on one line, and cut (command excerpts of 30 lines); HANDOFF.md keeps the whole text.
// A short command is copied without mistakes; a newline copied as is would break the JSON
const oneLine = x => String(x ?? '').replace(/\s+/g, ' ').trim()
const short = (x, n = 240) => { const s = oneLine(x); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const shorts = xs => (xs || []).map(x => short(x))
// Integers expected by the progress schema (args may carry strings)
const integer = (x, min) => Math.max(min, Math.trunc(Number(x)) || 0)
// Language of the free text (0.12.0): any non-empty text of orchestre.config.json ("en", "fr"…), on one line, quoted in the prompts
const LANGUAGE = typeof A.language === 'string' && oneLine(A.language) ? short(A.language, 40) : 'en'
const pLanguage = `
Language: write the free text you return or add to the plan files (summaries, descriptions, findings, gaps, reasons, issues and options) in the language ${JSON.stringify(LANGUAGE)}. Keys, statuses, types, section titles, commands, file paths and the texts you are given to copy stay exactly as they are.`
// Sensitive deviation (data, database, prod, secret): major automatically, whatever the replanner's rating
// Sensitive deviations, spotted by keywords, in English and French (plans of 0.11); SENSITIVE_NOT_ENV is used when a forbidden file
// is reclassified as a review
const SENSITIVE_NOT_ENV = /base de (données|dev|prod)|\bbdd\b|database|\bdump\b|\bprod\b|production|données (personnelles|réelles|de prod|utilisateur)|personal data|\bdbs?\b(?!:)|\b(?:real|user|customer|live|production) data\b|\bpii\b|rgpd|gdpr|secret|mot de passe|password|api[ -]?key|clé (d')?api|credential|pg_restore|pg_dump|database_url/i
const SENSITIVE = new RegExp(SENSITIVE_NOT_ENV.source + '|\\.env\\b', 'i')
if (!PLAN || !PHASE || !INTEG || !LINT) return { status: 'error', detail: 'args required: plan, phase, integration, lint' }
if (!['auto', 'deviation', 'phase'].includes(MODE)) return { status: 'error', detail: `unknown mode: ${MODE} (auto, deviation or phase)` }

// Report schemas
const S = (properties, required) => ({ type: 'object', properties, required })
const str = { type: 'string' }, bool = { type: 'boolean' }, strs = { type: 'array', items: str }
// Result of the progress command run by the agent (0.8.0); run_start_ok for the first agent of the run, which runs run-start
const PROGRESS_P = { progress_ok: bool, progress_error: str }
const PLAN_S = S({ ok: bool, errors: strs, tasks: { type: 'array', items: S({ id: str, title: str, file: str, phase: { type: 'integer' }, model: str, model_reason: str, effort: str, depends_on: strs, resources: strs, status: str, verification: strs, open_prerequisites: strs }, ['id', 'file', 'depends_on', 'status', 'verification', 'open_prerequisites']) }, all: { type: 'array', items: S({ id: str, phase: { type: 'integer' }, status: str }, ['id']) }, max_phase: { type: 'integer' }, run_start_ok: bool, progress_error: str }, ['ok', 'tasks'])
const REPORT_S = S({
  status: { type: 'string', enum: ['done', 'partial', 'blocked'] }, summary: str, branch: str, commit: str, path: str, changed_files: strs,
  deviations: { type: 'array', items: S({ type: { type: 'string', enum: ['deviation', 'blind-spot', 'decision', 'debt', 'needs-human', 'review'] }, description: str, affected_tasks: strs }, ['type', 'description']) },
  findings: { type: 'array', items: S({ category: str, content: str }, ['category', 'content']) }, blocker: str, ...PROGRESS_P,
}, ['status', 'summary', 'branch', 'path'])
const RESULT_S = S({ command: str, code: { type: 'integer' }, excerpt: str }, ['command', 'code', 'excerpt'])
const VERIF_S = S({ ok: bool, results: { type: 'array', items: RESULT_S }, failures: { type: 'array', items: S({ command: str, excerpt: str }, ['command']) }, flaky: strs, forbidden: strs, ...PROGRESS_P }, ['ok', 'results'])
const EVAL_S = S({ verdict: { type: 'string', enum: ['pass', 'fail'] }, gaps: strs, unverifiable: strs, unreadable: strs, ...PROGRESS_P }, ['verdict'])
const INTEG_S = S({ ok: bool, merged: bool, check_ok: bool, conflict: bool, commit: str, detail: str, ...PROGRESS_P }, ['ok', 'merged'])
const SCRIBE_S = S({ ok: bool, commit: str, rejected: { type: 'array', items: S({ id: str, reason: str }, ['id', 'reason']) }, discarded: { type: 'array', items: S({ id: str, reason: str }, ['id', 'reason']) }, ...PROGRESS_P, run_start_ok: bool }, ['ok'])
const CLERK_S = S({ progress_ok: bool, progress_error: str, commit: str, detail: str, worktrees: str }, ['progress_ok'])
// Choice of a fix's model (0.11.0): haiku, sonnet or opus; fable only comes from a task the user put on it
// (orchestre.config.json: fable: true, checked by plan-lint), as a floor
const CHOICE_MODELS = ['haiku', 'sonnet', 'opus']
const CHOICE_S = S({ model: { type: 'string', enum: CHOICE_MODELS }, reason: str }, ['model', 'reason'])
// With progress, the command's result is required when it decides what follows: run start (first agent), close and ruling (scribe)
const requireFields = (schema, ...fields) => (PROGRESS ? { ...schema, required: [...schema.required, ...fields] } : schema)
const ENTRIES_S = { type: 'array', items: S({ type: str, severity: { type: 'string', enum: ['minor', 'major'] }, description: str }, ['type', 'severity', 'description']) }
const TASKS_S = { type: 'array', items: S({ id: str, title: str, phase: { type: 'integer' }, content: str }, ['id', 'title', 'phase', 'content']) }
const AMENDS_S = { type: 'array', items: S({ id: str, definition_of_done: strs, owned_files: strs, verification: strs, depends_on: strs, reason: str }, ['id', 'reason']) }
const OPTION_S = S({ id: str, description: str, impact: str, recommended: bool, entries: ENTRIES_S, added_tasks: TASKS_S, amendments: AMENDS_S }, ['id', 'description'])
const REPLAN_S = S({
  major: bool,
  issues: { type: 'array', items: S({ title: str, context: str, human: bool, options: { type: 'array', items: OPTION_S } }, ['title', 'options']) },
  entries: ENTRIES_S,
  added_tasks: TASKS_S,
  reviews: { type: 'array', items: S({ review: str, deviation: str }, ['review']) },
}, ['major', 'entries'])

// A single agent at a time in the main checkout (merges, progress)
let queue = Promise.resolve()
const exclusive = fn => { const p = queue.then(fn); queue = p.catch(() => null); return p }
const ORDER = ['haiku', 'sonnet', 'opus', 'fable']
const atLeast = (m, base) => ORDER[Math.max(ORDER.indexOf(m), ORDER.indexOf(base || 'sonnet'))] || m
const bullets = xs => (xs || []).map(x => '- ' + x).join('\n')
const effort = t => (t.effort ? { effort: t.effort } : {})
const unique = xs => [...new Map(xs.map(x => [JSON.stringify(x), x])).values()]
// A fix report does not repeat the deviations of earlier attempts: they are accumulated, so that none escapes the replanner
const accumulate = (before, after) => ({ ...after, deviations: unique([...(before.deviations || []), ...(after.deviations || [])]), findings: after.findings ?? before.findings })
// Command cited by an agent, compared with the task's: without the "cd <working folder> &&" the verifier adds
// (another leading cd is part of the command), without the echo of the exit code, spaces collapsed
const withoutPrefix = (x, dir) => { const m = x.match(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/); return m && dir && m[1].replace(/^["']|["']$/g, '') === dir ? x.slice(m[0].length) : x }
const normalize = (c, dir) => withoutPrefix(String(c || '').trim(), dir).replace(/\s*;\s*echo\s+["']?code=\$\?["']?\s*$/, '').replace(/\s+/g, ' ').trim()
const sameCommand = (a, b, dir) => normalize(a, dir) === normalize(b, dir)
// A review cites a file if one of its words is that path, and not a path that contains it
const pathOf = x => x.replace(/^\.\//, '').replace(/\.+$/, '')
const cite = (d, f) => String(d).split(/[\s,;:()«»"'`]+/).some(x => x && pathOf(x) === pathOf(f))

// Prompts
// Progress (0.8.0): the command the agent runs as is, and what it reports from it
const reportProgress = 'Return progress_ok=true if it exits with code 0; otherwise progress_ok=false and the first line of its error in progress_error.'
const pStep = (id, step, extra = {}, report = true) => (PROGRESS ? `Plan progress: your first command, before any other, is \`${progressCmd('step', { task: id, step, ...extra })}\`. Run it as is, once. ${report ? reportProgress : 'Its result does not count: progress_ok is about the close command, further down.'} It is not part of the work asked: refused or failed, it goes in no other field of your report. Then go on, whatever its result.
` : '')
const pRunStart = stop => `Plan progress: your first command, before any other, opens the run: \`${progressCmd('run-start', { phase: integer(PHASE, 1), mode: MODE, parallelism: PAR, max_fixes: integer(MAXFIX, 0), max_auto_decisions: integer(MAX_AUTO, 0) })}\`. Run it as is, once. If it exits with code 0, return run_start_ok=true and go on. Otherwise, stop there without doing anything else: ${stop}, run_start_ok=false, and the first line of its error in progress_error.
`
// PROGRESS.md regenerated by the script, just before the scribe's commit
const pView = (cmd, E, effect) => `
- PROGRESS.md: never touch it yourself. Just before the commit, once everything else is written, run \`${progressCmd(cmd, E)}\`, as is, once: ${effect}. ${reportProgress} If it fails, commit the other files anyway.`
// A task's branch: new, or taken back from the most recent one (a branch held by another worktree is not taken back, we start from it).
// A branch taken back is brought up to date by a merge of the integration branch, never by a rebase (classified destructive).
// Branches tache/* of 0.11 are not taken back (0.12.0): the task starts again from the integration branch
const pBranch = t => `Branch: if no branch \`task/${t.id}\` exists, create it with \`git switch -c task/${t.id}\`. Otherwise (earlier attempt), take back the most recent work: \`git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads/task/${t.id} 'refs/heads/task/${t.id}-r*'\` gives the most recent branch first; if no worktree uses it (\`git worktree list\`), switch to it with \`git switch <branch>\`, otherwise create from it \`task/${t.id}-r<n>\`, with the first free n from 2 (\`git switch -c task/${t.id}-r<n> <branch>\`). Branch taken back: if \`git merge-base --is-ancestor ${INTEG} HEAD\` exits with code 1, it lacks the latest merges; bring it up to date with \`git merge --no-edit ${INTEG}\`. A conflict in your owned files is resolved; elsewhere, \`git merge --abort\` and status blocked. Never a rebase or a reset. Commit all your work on the branch you are on and return its exact name in "branch".`
// Environment setup, declared by the project; a failed command does not stop silently
const pSetup = (t, when, onFailure) => { const c = setupOf(t); return c.length ? `
Environment setup, ${when}: run one by one, as they are, these project commands: ${c.map(x => '`' + x + '`').join(', ')}. ${onFailure}` : '' }
const pWorker = (t, isolated, model) => `${pStep(t.id, 'worker', { isolated: !!isolated, model })}Task ${t.id} of the plan ${PLAN}. First read ${PLAN}/DISCOVERY.md and the decisions of ${PLAN}/HANDOFF.md, then ${t.file}, and follow its "Launch prompt".
${isolated ? "You are in an isolated worktree: Claude Code's isolation guard only accepts simple commands there (see your rules)." : `You are in the main checkout, on ${INTEG}.`} ${pBranch(t)}${pSetup(t, 'once on your branch, before any other work', 'If one fails, go on, and describe the failure (command and excerpt of its output) in a deviation. If they change tracked files you do not own, do not commit them and describe it in a deviation.')}
Decisions taken: ${JSON.stringify(runDecisions())}.
A file your permissions forbid you to read or change (organization or project settings): never get around the ban, by any command or script; describe the expected change in a deviation of type "review", the human will make it before the PR.
Run the task's verification commands before handing back.
Report: status, summary, branch, last commit, absolute path of the working folder (pwd), changed files, deviations from the plan, findings useful to the following tasks.${pLanguage}`
const pVerif = (t, r) => `${pStep(t.id, 'verification')}Verify the task ${t.id}, branch ${r.branch}. Run one by one, without changing anything, each command below, prefixed with \`cd "${r.path}" &&\`:
${bullets(t.verification)}
The failures listed as pre-existing in ${PLAN}/DISCOVERY.md do not count. A command your permissions refuse (organization or project settings): never get around it, by any other command or script, and do not count it as a failure; cite it in "forbidden", as it appears in the list above, without the \`cd\` prefix; the human will run it before the PR. If a test command fails, run it again once only: if it passes, the verification passes, but cite each test that failed then passed in "flaky". To read an exit code, do not pipe the command: add \`; echo "code=$?"\`. Return ok; in "results", for each command, even a successful one, the command, its exit code (that of the second run if there was one) and the excerpt that proves it (summary line, 10 lines at most); in "failures", for each failure that counts, the command and a useful excerpt of its output (30 lines at most). Never run a command that reads real production or personal data (production dump, production database or a copy of it): count it as a failure, with the excerpt "needs-human: real data, an action reserved to the human".`
const pEval = (t, r, v) => `${pStep(t.id, 'evaluation')}Evaluate the task ${t.id}. Read the definition of done in ${t.file}, then the diff \`git -C "${r.path}" diff ${INTEG}...${r.branch}\`.
Results of the verifier, taken on this branch just before you; they are proof of execution: ${JSON.stringify((v && v.results) || [])}.${v && (v.flaky || []).length ? ` Tests passed only on the second run, counted as passed: ${JSON.stringify(v.flaky)}.` : ''}
${(v && (v.forbidden || []).length) ? `Commands refused to the agents by their permissions, that the human will run before the PR: ${JSON.stringify(v.forbidden)}. A criterion that only they demonstrate is neither a gap nor an unverifiable criterion.
` : ''}Report of the worker; it is a deliverable, not a proof: its claims of execution demonstrate nothing. ${JSON.stringify({ summary: r.summary, findings: r.findings || [], deviations: r.deviations || [] })}
For each criterion, look for a proof: file:line of the diff, a test that covers it, or a result of the verifier above. A criterion that asks for report content is met if that content is in the worker's report. PROGRESS.md, HANDOFF.md and DISCOVERY.md are written by the scribe only at the end of the task: their state proves nothing, either way. A criterion that no verification command nor the diff can demonstrate in the context of this task, whatever the worker does (for example a behavior in a worktree for a task of the main checkout), is not a gap: cite it in "unverifiable" with the reason. This is rare: a criterion that is merely not proven stays a gap. A file of the diff your permissions forbid you to read (organization or project settings): never get around the ban; it is neither a gap nor an unverifiable criterion: cite it in "unreadable", the human will review it before the PR. A criterion that can only be demonstrated by reading such a file follows the same rule. Also check that the comments, headers, DECISIONS entries and procedures added or changed by the diff tell the truth: they describe what the code really does, and each command of a procedure meant for a human exists in the repository and does what the text says. A false text is a gap. Verdict fail if a single demonstrable criterion is not demonstrated; then list the precise gaps. Change nothing.${pLanguage}`
const pFix = (t, r, gaps, rejection, choice) => `${pStep(t.id, 'fix', { rejection: rejection && { ...rejection, gaps: shorts(rejection.gaps) }, model: choice.model, ...(choice.change ? { change: choice.change } : {}) })}Fix of the task ${t.id}. Work in ${r.path}, on the branch ${r.branch}: prefix each command with \`cd "${r.path}" &&\` and edit the files by their absolute path under that folder. Read ${t.file} and ${PLAN}/DISCOVERY.md again.
Gaps to fix:
${bullets(gaps)}
Same rules as the task: owned files only, commits on ${r.branch}, nothing in the progress files${PROGRESS ? ' (the progress command above aside)' : ''}, no merge into another branch and no push.${setupOf(t).length ? ` If your fix changes the dependencies or what is generated, first run again, in this folder, these setup commands of the project: ${setupOf(t).map(x => '\`' + x + '\`').join(', ')}.` : ''} Run the verifications again, then return the same report format.${(r.deviations || []).length ? `
Deviations already reported at earlier attempts, already recorded in the plan's progress: ${JSON.stringify(r.deviations)}. Do not repeat them; if your fix cancels one, say so in a deviation.` : ''}${(r.findings || []).length ? `
Findings of earlier attempts: ${JSON.stringify(r.findings)}. Return in your report the updated list: those that still hold, without those your fix makes false, plus the new ones.` : ''}${pLanguage}`
const pMerge = (t, r, isolated, check) => `${pStep(t.id, 'merge')}Merge the task ${t.id} in the main checkout: \`git switch ${INTEG}\`, then \`git merge --no-ff ${r.branch} -m "task ${t.id}: ${forMessage(t.title)}"\`.
On a conflict: \`git merge --abort\`, then return ok=false, merged=false, conflict=true and the files involved.
Otherwise, return merged=true.${pSetup(t, `on ${INTEG}, after the merge and before the check`, 'If one fails, do not run the check: return check_ok=false, with "setup:" followed by the command and an excerpt of its output in detail. After them, `git status --porcelain` must be empty: a setup changes no tracked file and leaves no file that is not ignored; otherwise, do not run the check and return check_ok=false, with "setup: changed files" and their list in detail.')}
Then run on ${INTEG} this check command, without a pipe (add \`; echo "code=$?"\`): ${check}. Return check_ok according to its exit code, a useful excerpt in detail on a failure, and ok=true only if the merge and the check succeeded.${isolated ? `
Then remove the worktree: \`git worktree unlock "${r.path}"\` (ignore the error), then \`git worktree remove --force "${r.path}"\`. Keep the branch.` : ''}`
// Choice of the model of the next fix (0.11.0): the attempt's rejection, the earlier rejections and their models
const pChoice = (t, rejection, before, previous) => `Choice of the model of fix ${rejection.attempt} of the task ${t.id} (${t.file}). Model planned by the plan: ${t.model}${t.model_reason ? ` ("${oneLine(t.model_reason)}")` : ''}; it is a floor: the fix will never run on a weaker model. Attempt ${rejection.attempt}, on ${before}, was rejected by ${rejection.by === 'verification' ? 'the verification' : 'the evaluation'}. Gaps: ${JSON.stringify(rejection.gaps)}.${previous.length ? ` Attempts rejected before it: ${JSON.stringify(previous)}.` : ''}
Return model (haiku, sonnet or opus) and reason, on one line: haiku for a mechanical gap (text, format, renaming, configuration), sonnet for an implementation gap, opus for a gap of architecture, ambiguous, that touches several modules, or that comes back after a fix on the same model. You may read the task file. Rate no deviation, prepare no issue and change nothing.${pLanguage}`
const pReplan = (t, r, status, gaps, unverifiable, sensitive = []) => `Replanning after ${t.id} (status: ${status}, phase ${PHASE}${LAST ? ', last phase of the plan' : ''}, mode ${MODE}). Task: ${t.file}; its code is on the branch ${r.branch}${status === 'merged' ? `, merged into ${INTEG} (main checkout)` : `, in ${r.path}`}. Deviations reported: ${JSON.stringify(r.deviations || [])}. Gaps: ${JSON.stringify(gaps)}. Criteria unverifiable in the context of the task: ${JSON.stringify(unverifiable || [])}.${sensitive.length ? ` Sensitive deviations (data, database, prod, secret), major automatically: return an issue for each, except for a deviation that only concerns a file forbidden to the agents (see below): ${JSON.stringify(sensitive)}.` : ''}
Read ${PLAN}/PROGRESS.md, the decisions of ${PLAN}/HANDOFF.md, ${PLAN}/PREREQUISITES.md if it exists, and the remaining tasks of ${PLAN}/tasks/. Rate each deviation minor or major according to your grid and return one entry per deviation, except for those you return in "reviews".
For each major deviation and each unverifiable criterion, return an issue in "issues": title, context, 2 or 3 options of which a single one is recommended. Each option carries its actions: HANDOFF entries, tasks to add (phase ${PHASE} or later, never a past phase; an added task cites in "prerequisites" the prerequisites of PREREQUISITES.md it needs), amendments of tasks not yet started, other than ${t.id} (criteria, owned files, verification commands or dependencies to add, never anything to remove). Before adding a task, prefer amending a task not yet started that owns the files concerned, then one added task for all the findings of this answer on the same files; a separate task only for a reason of the splitting rule (parallel, contract, risk, size). For a task already merged, propose a task to add rather than an amendment. An option only cites tasks and files that already exist or that it creates itself. No option has an agent read, restore or copy real production or personal data: that action belongs to the human. Recommend the safest option for security and data: one more test or guard rather than an accepted risk.${MODE === 'auto' ? ' Autonomous mode: the recommended option will be applied as is, without a human review before the PR.' : ''}${LAST ? ' Last phase: only propose a task for an issue that protects the deployment, security or data; for the others, an entry of type "ticket" (to open after the PR), without a task.' : ''}
A file the agents may not read or write (organization or project settings), and that the human only has to review or change before the PR, is never an issue nor an entry: return it in "reviews", with in "review" the file and what the human must review or change in it, and in "deviation" the description, copied as is, of the reported deviation it replaces, if that deviation only concerns this file and is not of type needs-human. A deviation that also concerns something else stays a deviation. If a human action is needed before going on (a secret missing to run the tests, for example), it is a human need, not a review. Mark "human" an issue no agent can settle (access, secret, production, real data, product choice), an issue about an open prerequisite of PREREQUISITES.md (decision deferred by the user, manual action), a deviation of type needs-human, or an environment or tooling problem whose cause is not demonstrated by a command output cited above. Change nothing.${pLanguage}`

// Shared instructions for the scribe: created tasks, amendments, check by plan-lint, report
const pUpdates = (id, updates, view = '') => `${updates.tasks.length ? `
- New tasks: create them in ${PLAN}/tasks/ with the content given, as is, and ${PROGRESS ? 'do not touch PROGRESS.md: the progress command below adds their row' : 'add their row to PROGRESS.md, status "added"'}: ${JSON.stringify(updates.tasks)}` : ''}${updates.amendments.length ? `
- Amendments, for tasks not yet started: in the frontmatter of each task concerned, append the items listed to the end of the matching list (definition_of_done, owned_files, verification, depends_on), without removing or rewording anything, then note "amendment · major · <id>: <reason>" under "## ${id}" in HANDOFF.md. Do not amend a task missing from the plan: return it in "rejected". A task "merged" or "cancelled" in PROGRESS.md can no longer be amended: note "blind-spot · major · amendment not applied to <id>: <reason>" under "## ${id}" in HANDOFF.md and return it in "discarded", not in "rejected". Amendments: ${JSON.stringify(updates.amendments)}` : ''}${updates.discarded.length ? `
- Amendments not applied, because the task concerned has already started or finished: note each under "## ${id}" in HANDOFF.md, as "blind-spot · major · amendment not applied to <id>: <reason>": ${JSON.stringify(updates.discarded)}` : ''}${(updates.auto || []).length ? `
- Decisions taken automatically in this update: ${JSON.stringify(updates.auto)}. For each file path they cite, check that it exists in the repository (\`test -e <path>\`) or that a task created here owns it; otherwise, note "needs-human · major · inconsistent auto-decision: <path> does not exist and no task creates it" under "## ${id}" in HANDOFF.md and return the decision in "rejected".` : ''}${updates.tasks.length || updates.amendments.length ? `
- Then run \`${LINTCMD} ${PLANARG} --integration ${INTEG}${BASE}\`. Any error that concerns a task created or amended here: put that task back in its original state (\`git checkout HEAD -- <file>\` for an amended file; for a created task, remove its file${PROGRESS ? '' : ' and its row of PROGRESS.md'}).
- Each task created or amended that you could not apply, or that you put back in its original state: note "needs-human · major · <id> not applied: <reason>" under "## ${id}" in HANDOFF.md, and return it in "rejected".` : ''}${view}
Return ok=true once the commit is done, with its hash, "rejected" (empty if everything is applied) and "discarded" (empty if no amendment concerned a merged or cancelled task).${pLanguage}`
const pScribe = (t, status, attempts, r, updates, gaps, { flaky = [], rejections = [], unverifiable = [] } = {}, closeInput = null) => `${PROGRESS ? `${pStep(t.id, 'progress', {}, false)}Then, in the main checkout, switch to the integration branch: \`git switch ${INTEG}\`. Update the progress of the plan ${PLAN}, then commit PROGRESS.md, HANDOFF.md and DISCOVERY.md, and the tasks created or amended, with the message "progress(${t.id}): ${status}".` : `In the main checkout, start with \`git switch ${INTEG}\`. Update the progress of the plan ${PLAN}, then commit these files only, and the tasks created or amended, with the message "progress(${t.id}): ${status}".
- PROGRESS.md: row ${t.id} → status "${status}", attempts ${attempts}, branch ${r ? r.branch : '—'}; actual tokens: "see /workflows".`}
- HANDOFF.md: under "## ${t.id}", add these entries, word for word: ${JSON.stringify(updates.entries)}${gaps.length ? `, and this blocker: ${JSON.stringify(gaps)}` : ''}.${(rejections || []).length ? `
- HANDOFF.md, still under "## ${t.id}": an entry "rejection · minor · attempt <n>, <by>: <gaps separated by semicolons>" for each of these attempts rejected then fixed: ${JSON.stringify(rejections)}` : ''}${unverifiable.length ? `
- HANDOFF.md, still under "## ${t.id}": an entry "blind-spot · minor · criterion unverifiable in the context of the task: <criterion and reason>" for each of these: ${JSON.stringify(unverifiable)}` : ''}
- DISCOVERY.md: integrate these findings without duplicates, in the right section: ${JSON.stringify((r && r.findings) || [])}.${(flaky || []).length ? `
- Flaky tests (passed on the second run): add them to DISCOVERY.md, section "Pitfalls and fixes", and a "debt · minor" entry in HANDOFF.md: ${JSON.stringify(flaky)}` : ''}${pUpdates(t.id, updates, PROGRESS ? pView('close', closeInput, 'it closes the task in progress.json and regenerates the table of PROGRESS.md') : '')}`
const pRuling = (a, updates, opens = false) => PROGRESS ? `${opens ? pRunStart('return ok=false') : ''}In the main checkout, ${opens ? 'then, ' : ''}start with \`git switch ${INTEG}\`. Apply the user's ruling to the plan ${PLAN}, then commit PROGRESS.md, HANDOFF.md and the tasks created or amended, with the message "progress(${a.task}): ruling ${a.option.id}".
- HANDOFF.md: under "## ${a.task}" (create this heading if it is missing), add these entries, word for word: ${JSON.stringify(updates.entries)}.${pUpdates(a.task, updates, pView('ruling', {
  task: a.task, title: a.title, option: a.option.id,
  ...(updates.tasks.length ? { added_tasks: updates.tasks.map(x => ({ id: x.id, title: x.title, phase: x.phase })) } : {}),
  ...(updates.amendments.length ? { amendments: updates.amendments.map(m => ({ id: m.id, reason: m.reason })) } : {}),
}, 'it notes the ruling in progress.json and regenerates the table of PROGRESS.md'))}` : `In the main checkout, start with \`git switch ${INTEG}\`. Apply the user's ruling to the plan ${PLAN}, then commit these files only, and the tasks created or amended, with the message "progress(${a.task}): ruling ${a.option.id}".
- HANDOFF.md: under "## ${a.task}" (create this heading if it is missing), add these entries, word for word: ${JSON.stringify(updates.entries)}.${pUpdates(a.task, updates)}`
const pReader = opens => `${opens ? pRunStart('return ok=false and empty tasks') : ''}Run \`${LINTCMD} ${PLANARG} --json --phase ${PHASE} --integration ${INTEG}${BASE}\` and return its JSON as is${opens ? ', with run_start_ok' : ''}.`
// End of run: the clerk runs run-end with the summary, then commits PROGRESS.md if it changed (task closed without a scribe, exception E:316)
const withoutActions = p => ({
  task: p.task, title: short(p.title), context: short(p.context), human: !!p.human, ...(p.circuit_breaker ? { circuit_breaker: true } : {}), ...(p.inconsistency ? { inconsistency: short(p.inconsistency) } : {}),
  options: (p.options || []).map(o => ({ id: o.id, description: short(o.description), ...(o.impact !== undefined ? { impact: short(o.impact) } : {}), ...(o.recommended !== undefined ? { recommended: !!o.recommended } : {}) })),
})
// What run-end reads from the summary: without the options' actions or the workers' summaries, for a short command
const progressSummary = v => ({
  status: v.status, detail: v.detail == null ? null : short(Array.isArray(v.detail) ? v.detail.join('; ') : v.detail, 600), ...(v.stop_issue ? { stop_issue: withoutActions(v.stop_issue) } : {}), open_issues: (v.open_issues || []).map(withoutActions),
  // attempts 0: task closed by an exception (catch of runTask), without known attempts or branch; progress keeps its own
  tasks: (v.tasks || []).map(x => ({ id: x.id, status: x.status, ...(x.attempts ? { attempts: x.attempts, branch: x.branch ?? null } : {}), ...(x.blocker ? { blocker: shorts(x.blocker) } : {}) })),
  auto_decisions: (v.auto_decisions || []).map(d => ({ ...d, description: short(d.description) })), rulings_applied: v.rulings_applied || [],
  discarded_amendments: (v.discarded_amendments || []).map(e => ({ task: e.task, id: e.id, reason: short(e.reason) })),
  added_tasks: (v.added_tasks || []).map(x => ({ ...x, ...(parents.has(x.id) ? { added_by: parents.get(x.id) } : {}) })), deferred: v.deferred || [], not_started: v.not_started || [], waiting: v.waiting || [], waiting_on_prerequisites: v.waiting_on_prerequisites || [],
})
const pClerk = v => `End of the run: phase ${PHASE} of the plan ${PLAN}, status "${v.status}". In the main checkout, in this order:
1. \`git switch ${INTEG}\`.
2. \`${progressCmd('run-end', progressSummary(v))}\`, as is, once. ${reportProgress}
3. \`git diff --quiet HEAD -- ${planFile('PROGRESS.md')}\`: if it exits with code 1, PROGRESS.md changed: \`git commit -m "progress: end of the run of phase ${PHASE}" -- ${planFile('PROGRESS.md')}\`, which only commits that file, and return its hash in commit. Otherwise, no commit.
4. \`${WTCMD} clean ${PLANARG}\`: it removes the clean worktrees the plan's tasks left behind (branches kept). Return its output, or its error message, in worktrees.
If step 1 fails, run step 2 anyway, skip steps 3 and 4 and say why in detail. If the commit fails, say why in detail. Otherwise, leave detail empty. Run nothing else and change no other file.`

// Run state
let stop = null
const issues = [], added = [], results = [], autoDecisions = [], deferred = [], discardedRun = [], rulingsApplied = []
// Progress (0.8.0): run opened by run-start, and failed script calls (only the display suffers, except close and ruling)
let opened = false
const progressFailures = []
// Added task → task whose close created it, for run-end (a close not written leaves them out of progress)
const parents = new Map()
const noteProgress = (task, step, x) => { if (PROGRESS && x && x.progress_ok !== true) progressFailures.push({ task, step, error: x.progress_error || (x.progress_ok === false ? 'failure without a message' : 'result not reported') }) }
// Amended tasks whose progress is not yet committed (counter per task): they only start afterwards
const amended = new Map()
// The first issue stops the run; the next ones go to open_issues. bucket: the issues of the current close, for progress
const stopOn = (p, bucket) => { if (bucket) bucket.push(p); if (!stop) stop = p; else issues.push(p) }
// An added task never runs in a phase already past
const toPhase = x => { const p = Math.max(Number(x.phase) || PHASE, PHASE); return { ...x, phase: p, content: String(x.content || '').replace(/^phase:\s*\d+/m, `phase: ${p}`) } }
// Options keep their actions: the chosen option comes back as is in args.rulings
const issueOf = (t, pt) => ({ task: t.id, title: pt.title, context: pt.context || '', human: !!pt.human, options: pt.options || [] })
const humanIssue = (id, title, context, options = []) => ({ task: id, title, context, human: true, options })
const runDecisions = () => [...DECISIONS, ...RULINGS.map(a => `${a.title}: ${a.option.description} (settled by the user)`), ...autoDecisions.map(o => `${o.title}: ${o.description} (taken automatically)`)]

// Every exit after the run start goes through finish: the clerk closes the run in progress (run-end)
let worktrees = null
async function finish(v) {
  if (PROGRESS && opened) {
    // A clerk that throws must not lose the summary: issues and actions live only in the return value
    let g = null
    try { g = await agent(pClerk(v), { label: 'run end · progress', agentType: AG('clerk'), model: 'haiku', schema: CLERK_S }) } catch (err) { progressFailures.push({ task: null, step: 'run-end', error: `clerk failed: ${String(err)}` }); g = undefined }
    if (g === null) progressFailures.push({ task: null, step: 'run-end', error: 'clerk without an answer' })
    else if (g) {
      noteProgress(null, 'run-end', g)
      if (g.detail) progressFailures.push({ task: null, step: 'run-end', error: `PROGRESS.md not committed: ${g.detail}` })
      if (g.worktrees) worktrees = g.worktrees
    }
  }
  return PROGRESS ? { ...v, progress_failures: progressFailures, ...(worktrees ? { worktrees } : {}) } : v
}
// Run start refused by the script (lock, unreadable PROGRESS.md or progress.json…): every following write would fail, nothing starts
const notOpened = x => {
  const error = x.progress_error || (x.run_start_ok === false ? 'failure without a message' : 'result not reported')
  return { status: 'error', phase: PHASE, mode: MODE, detail: `progress: run not opened (run-start), no task started — ${error}`, rulings_applied: rulingsApplied, progress_failures: [...progressFailures, { task: null, step: 'run-start', error }] }
}

phase('Plan reading')
// User rulings: the scribe writes the decision and applies the actions of the chosen option.
// With progress, the first of them opens the run: the ruling is noted in the run that applies it
for (const [i, a] of RULINGS.entries()) {
  const o = a.option
  const opens = !!PROGRESS && i === 0
  const updates = { entries: [{ type: 'decision', severity: 'major', description: `${a.title}: option ${o.id} settled by the user — ${o.description}` }, ...(o.entries || [])], tasks: (o.added_tasks || []).map(toPhase), amendments: o.amendments || [], discarded: [], auto: [] }
  const s = await agent(pRuling(a, updates, opens), { label: `ruling ${a.task} · progress`, agentType: AG('scribe'), model: 'sonnet', schema: opens ? requireFields(SCRIBE_S, 'progress_ok', 'run_start_ok') : requireFields(SCRIBE_S, 'progress_ok') })
  if (opens && s) { if (s.run_start_ok !== true) return notOpened(s); opened = true }
  if (s && s.ok) rulingsApplied.push({ task: a.task, title: a.title, option: o.id })
  // Amendment of a task merged in the meantime: discarded and recorded, the run goes on
  if (s) discardedRun.push(...(s.discarded || []).map(e => ({ task: a.task, ...e })))
  noteProgress(a.task, 'ruling', s && s.ok ? s : null)
  // Ruling applied but not noted in progress: stop, as for a close
  const progressKo = !!PROGRESS && !!s && s.ok && s.progress_ok !== true
  if (!s || !s.ok || (s.rejected || []).length || progressKo) return await finish({ status: 'awaiting-ruling', phase: PHASE, mode: MODE, stop_issue: humanIssue(a.task, `Ruling "${a.title}" ${s && s.ok ? 'partly applied' : 'not applied'}`, !s ? 'scribe without an answer' : (s.rejected || []).length || !progressKo ? JSON.stringify(s.rejected || []) : `HANDOFF.md and tasks committed, but progress.json and PROGRESS.md not written: ${s.progress_error || 'result not reported'}`), rulings_applied: rulingsApplied, discarded_amendments: discardedRun, tasks: [], open_issues: [], auto_decisions: [] })
}
// Without a ruling, the plan reader opens the run
const readerOpens = !!PROGRESS && !RULINGS.length
const plan = await agent(pReader(readerOpens), { label: 'plan-reader', agentType: AG('plan-reader'), model: 'haiku', schema: readerOpens ? requireFields(PLAN_S, 'run_start_ok') : PLAN_S })
if (readerOpens && plan) { if (plan.run_start_ok !== true) return notOpened(plan); opened = true }
if (!plan || !plan.ok) return await finish({ status: 'error', phase: PHASE, detail: plan ? plan.errors : 'plan-reader without an answer', rulings_applied: rulingsApplied })
const T = new Map(plan.tasks.map(t => [t.id, t]))
const done = new Set(plan.tasks.filter(t => DONE(t.status)).map(t => t.id))
const deps = t => (t.depends_on || []).filter(d => T.has(d))
const ancestors = (id, seen = new Set()) => { for (const d of deps(T.get(id))) if (!seen.has(d)) { seen.add(d); ancestors(d, seen) } return seen }
const shares = (a, b) => (a.resources || []).some(r => (b.resources || []).includes(r))
const canOverlap = (a, b) => a.id !== b.id && !ancestors(a.id).has(b.id) && !ancestors(b.id).has(a.id) && !shares(a, b)
// All the plan's tasks (consistency of auto-decisions) and last phase (convergence)
const ALL = plan.all && plan.all.length ? plan.all : plan.tasks
const PREFIXES = [...new Set(ALL.map(x => (String(x.id).match(/^[A-Z]+/) || [''])[0]).filter(Boolean))]
const RE_ID = new RegExp(`\\b(?:${PREFIXES.join('|') || 'T'})\\d+[A-Z]*\\b`, 'g')
// Task of another phase already merged or cancelled: it can no longer be amended
const doneElsewhere = id => !T.has(id) && DONE((ALL.find(x => x.id === id) || {}).status)
// Without max_phase, no convergence instruction
const LAST = plan.max_phase ? PHASE >= Number(plan.max_phase) : false

// Running a task
// Autonomous mode: applies the recommended option of an issue (decision, entries, tasks, amendments)
function applyRecommended(t, pt, updates) {
  const recommended = (pt.options || []).filter(o => o.recommended)
  // No recommended option, or several: a human settles
  if (recommended.length !== 1) return stopOn(issueOf(t, pt), updates.issues)
  const rec = recommended[0]
  // Consistency: every task cited exists in the plan, or the option (or the run) creates it
  const known = new Set([...ALL.map(x => x.id), ...added.map(x => x.id), ...updates.tasks.map(x => x.id), ...(rec.added_tasks || []).map(x => x.id)])
  const text = [rec.description, ...(rec.entries || []).map(e => e.description), ...(rec.amendments || []).map(a => a.reason)].join(' ')
  const unknown = [...new Set([...(text.match(RE_ID) || []), ...(rec.amendments || []).flatMap(a => [a.id, ...(a.depends_on || [])])])].filter(id => !known.has(id))
  if (unknown.length) return stopOn({ ...issueOf(t, pt), inconsistency: `cited tasks that do not exist and that the option does not create: ${unknown.join(', ')}` }, updates.issues)
  if (autoDecisions.length >= MAX_AUTO) return stopOn({ ...issueOf(t, pt), circuit_breaker: true }, updates.issues)
  const decision = { task: t.id, title: pt.title, option: rec.id, description: rec.description }
  autoDecisions.push(decision)
  updates.decisions.push(decision)
  updates.auto.push(`${pt.title}: ${rec.description}`)
  updates.entries.push({ type: 'decision', severity: 'major', description: `${pt.title}: option ${rec.id} taken automatically (autonomous mode) — ${rec.description}` }, ...(rec.entries || []))
  updates.tasks.push(...(rec.added_tasks || []).map(toPhase))
  const fresh = new Set([...added, ...updates.tasks].map(x => x.id))
  for (const am of rec.amendments || []) {
    if (done.has(am.id) || doneElsewhere(am.id) || running.has(am.id)) { updates.discarded.push(am); discardedRun.push({ task: t.id, ...am }); continue }
    updates.amendments.push(am)
    const c = T.get(am.id)
    if (!c) continue
    amended.set(am.id, (amended.get(am.id) || 0) + 1)
    c.verification = [...(c.verification || []), ...(am.verification || [])]
    c.depends_on = [...(c.depends_on || []), ...(am.depends_on || [])]
    // New dependency on a task added during this run: the task waits for the next run
    if ((am.depends_on || []).some(d => fresh.has(d)) && pending.delete(am.id)) deferred.push(am.id)
  }
}

async function closeTask(t, status, attempts, r, gaps = [], trace = {}) {
  const flaky = [...new Set(trace.flaky || [])], rejections = trace.rejections || [], unverifiable = trace.unverifiable || []
  // issues and decisions: those of this close, passed to progress (close); tasks running in parallel have their own
  const updates = { entries: [...(trace.entries || [])], tasks: [], amendments: [], discarded: [], auto: [], issues: [...(trace.issues || [])], decisions: [] }
  // Files and commands the agents may not read, write or run: review by the human before the PR, without an issue or a stop
  const reviews = [...((r && r.deviations) || []).filter(e => e.type === 'review').map(e => e.description), ...(trace.forbidden || []).map(c => `command \`${c}\` refused to the agents: to run by the human before the PR`)]
  const deviations = ((r && r.deviations) || []).filter(e => e.type !== 'review')
  let reclassified = new Set()
  // Sensitive deviations (data, database, prod, secret): major automatically, whatever the rating
  const sensitive = deviations.filter(e => e.type !== 'needs-human' && SENSITIVE.test(e.description || '')).map(e => e.description)
  const majorIfSensitive = e => (SENSITIVE.test(e.description || '') ? { ...e, severity: 'major' } : e)
  let humanSeen = false
  const replan = !!(r && (deviations.length || status !== 'merged' || unverifiable.length))
  if (replan) {
    const rp = await agent(pReplan(t, { ...r, deviations }, status, gaps, unverifiable, sensitive), { label: `${t.id} · replanning`, agentType: AG('replanner'), model: 'opus', schema: REPLAN_S })
    if (rp) {
      // Forbidden file reported as an ordinary deviation: the replanner reclassifies it as a review, which is neither an issue nor a sensitive deviation
      reclassified = new Set((rp.reviews || []).map(x => x.deviation).filter(Boolean))
      reviews.push(...(rp.reviews || []).map(x => x.review), ...(rp.entries || []).filter(e => e.type === 'review').map(e => e.description))
      updates.entries.push(...(rp.entries || []).filter(e => e.type !== 'review').map(majorIfSensitive))
      updates.tasks.push(...(rp.added_tasks || []).map(toPhase))
      // One issue per major deviation or unverifiable criterion: human → stop; otherwise by mode
      for (const pt of rp.issues || []) {
        if (pt.human) { humanSeen = true; stopOn(issueOf(t, pt), updates.issues) }
        else if (MODE === 'auto') applyRecommended(t, pt, updates)
        else if (MODE === 'deviation') stopOn(issueOf(t, pt), updates.issues)
        else { const p = issueOf(t, pt); updates.issues.push(p); issues.push(p) }
      }
      // A sensitive deviation without any decision issue: a human settles
      // Reclassification refused for a deviation made sensitive by other words than the mention of a .env: a human settles, whatever the other issues
      const disputed = sensitive.filter(d => reclassified.has(d) && SENSITIVE_NOT_ENV.test(d))
      if (disputed.length) { humanSeen = true; stopOn(humanIssue(t.id, `Sensitive deviation of ${t.id} reclassified as a review`, disputed.join('; ')), updates.issues) }
      const remaining = sensitive.filter(d => !reclassified.has(d))
      if (remaining.length && !(rp.issues || []).length) { humanSeen = true; stopOn(humanIssue(t.id, `Sensitive deviation of ${t.id} without a decision issue`, remaining.join('; ')), updates.issues) }
    } else {
      // Without a rating, nothing passes silently: deviations noted major, stop for a human
      updates.entries.push(...deviations.map(e => ({ type: e.type, severity: 'major', description: `${e.description} (not rated: replanner without an answer)` })))
      humanSeen = true
      stopOn(humanIssue(t.id, `Replanning of ${t.id} without an answer`, 'Deviations, gaps and unverifiable criteria not rated: read them in HANDOFF.md.'), updates.issues)
    }
  }
  // File unreadable for the evaluator: a generic entry, unless a review already cites it
  reviews.push(...(trace.unreadable || []).filter(f => !reviews.some(d => cite(d, f))).map(f => `${f}: unreadable by the agents, to review by the human before the PR`))
  const allReviews = [...new Set(reviews)]
  updates.entries.push(...allReviews.map(d => ({ type: 'review', severity: 'major', description: d })))
  const needs = deviations.filter(e => e.type === 'needs-human')
  if (needs.length && !humanSeen) stopOn(humanIssue(t.id, `Human need reported by ${t.id}`, needs.map(e => e.description).join('; ')), updates.issues)
  // Unmerged task that waits for a human: it only restarts on their decision (args.rerun)
  const final = status !== 'merged' && (humanSeen || needs.length) ? 'needs-human' : status
  added.push(...updates.tasks)
  for (const x of updates.tasks) parents.set(x.id, t.id)
  // Close in progress (0.8.0): what the scribe passes to progress.mjs close
  const closeInput = PROGRESS ? {
    task: t.id, status: final, attempts, branch: r ? r.branch : null,
    ...(rejections.length ? { rejections: rejections.map(x => ({ ...x, gaps: shorts(x.gaps) })) } : {}), ...(flaky.length ? { flaky: shorts(flaky) } : {}), ...(unverifiable.length ? { unverifiable: shorts(unverifiable) } : {}),
    // Reviews on one line but whole: progress matches them with their HANDOFF.md entry, word for word
    ...(final !== 'merged' ? { blocker: shorts(gaps) } : {}), ...(allReviews.length ? { reviews: allReviews.map(oneLine) } : {}),
    ...(updates.decisions.length ? { auto_decisions: updates.decisions.map(d => ({ ...d, description: short(d.description) })) } : {}), ...(updates.issues.length ? { issues: updates.issues.map(withoutActions) } : {}),
    ...(updates.tasks.length ? { added_tasks: updates.tasks.map(x => ({ id: x.id, title: short(x.title), phase: x.phase })) } : {}),
    ...(updates.amendments.length ? { amendments: updates.amendments.map(m => ({ id: m.id, reason: short(m.reason) })) } : {}),
    ...(replan ? { replanning: true } : {}),
  } : null
  const s = await exclusive(() => agent(pScribe(t, final, attempts, r, updates, gaps, { flaky, rejections, unverifiable }, closeInput), { label: `${t.id} · progress`, agentType: AG('scribe'), model: 'sonnet', schema: requireFields(SCRIBE_S, 'progress_ok') }))
  for (const am of updates.amendments) { const n = (amended.get(am.id) || 1) - 1; if (n > 0) amended.set(am.id, n); else amended.delete(am.id) }
  if (s) discardedRun.push(...(s.discarded || []).map(e => ({ task: t.id, ...e })))
  if (!s || !s.ok) stopOn(humanIssue(t.id, `Progress of ${t.id} not committed`, s ? 'The scribe could not commit.' : 'Scribe without an answer.'))
  else if ((s.rejected || []).length) stopOn(humanIssue(t.id, `Progress of ${t.id}: tasks, amendments or decisions rejected`, JSON.stringify(s.rejected)))
  // Close not written in progress.json: stop, as for a failed scribe; the clerk closes the task from the summary at the end of the run
  else if (PROGRESS && s.progress_ok !== true) stopOn(humanIssue(t.id, `Progress of ${t.id}: close not written in progress.json`, `${s.progress_error || 'result not reported'}. HANDOFF.md and DISCOVERY.md are committed; the run end closes ${t.id} in progress.json from the summary and regenerates PROGRESS.md.`))
  noteProgress(t.id, 'close', s && s.ok ? s : null)
  log(`${t.id}: ${final}`)
  return { id: t.id, status: final, attempts, branch: r ? r.branch : null, summary: r ? r.summary : '', ...(final !== 'merged' ? { blocker: gaps } : {}), ...(flaky.length ? { flaky } : {}), ...(rejections.length ? { rejections } : {}), ...(unverifiable.length ? { unverifiable } : {}), ...(allReviews.length ? { reviews: allReviews } : {}) }
}

// Model of the fix that follows the rejected attempt (0.11.0). Task without a model: the escalation ladder, as before, without a call.
// Task with a model: the replanner chooses from the rejection; never below the task's model (floor); without a valid
// answer, the ladder. Returns { model, reason, change? }: change { from, to, reason } when the model differs from the attempt's.
async function chooseModel(t, rejection, models, previous) {
  const before = models[models.length - 1], ladder = atLeast(ESC[Math.min(rejection.attempt - 1, ESC.length - 1)], t.model)
  let model = ladder, reason = `no model in the plan: escalation ladder, fix ${rejection.attempt}`
  if (t.model) {
    const c = await agent(pChoice(t, rejection, before, previous.map((x, i) => ({ attempt: x.attempt, model: models[i], by: x.by, gaps: shorts(x.gaps) }))), { label: `${t.id} · model choice ${rejection.attempt}`, agentType: AG('replanner'), model: 'opus', schema: CHOICE_S })
    if (c && CHOICE_MODELS.includes(c.model)) {
      model = atLeast(c.model, t.model)
      reason = short(c.reason || 'no reason', 200) + (model !== c.model ? `; raised to the task's model (${t.model})` : '')
    } else {
      reason = `${c ? `invalid choice (${short(String(c.model), 30)})` : 'model choice without an answer'}: escalation ladder, fix ${rejection.attempt}`
      log(`${t.id}: ${reason}`)
    }
  }
  return { model, reason, ...(model !== before ? { change: { from: before, to: model, reason } } : {}) }
}

async function runTask(t, isolated) {
  try {
    log(`${t.id} starts (${isolated ? 'worktree' : 'main checkout'})`)
    // The task's model, as is; without a model in the plan, sonnet (0.10 and earlier)
    const workerModel = t.model || 'sonnet'
    let r = await agent(pWorker(t, isolated, workerModel), { label: `${t.id} · worker`, agentType: AG(isolated ? 'isolated-worker' : 'worker'), model: workerModel, schema: REPORT_S, ...(isolated ? { isolation: 'worktree' } : {}), ...effort(t) })
    noteProgress(t.id, 'worker', r)
    // Model of each attempt, in order: the worker, then each fix
    const models = [workerModel]
    let attempts = 1
    const trace = { flaky: [], rejections: [], unverifiable: [], unreadable: [], forbidden: [], issues: [] }
    for (;;) {
      if (!r) return await closeTask(t, 'failed', attempts, null, ['worker without an answer (usage limit or API error)'], trace)
      if (r.status === 'blocked') return await closeTask(t, 'blocked', attempts, r, [r.blocker || 'blocked by the worker'], trace)
      let gaps = [], by = 'verification'
      const v = await agent(pVerif(t, r), { label: `${t.id} · verification`, agentType: AG('verifier'), model: 'sonnet', schema: VERIF_S })
      noteProgress(t.id, 'verification', v)
      if (v && (v.flaky || []).length) trace.flaky.push(...v.flaky)
      // Commands refused by permissions: only the task's count as forbidden; another one is a failure
      // Progress command cited among the refused ones (authorization rule missing): neither a task command nor a failure
      const refused = ((v && v.forbidden) || []).filter(x => !(PROGRESS && String(x).includes(PROGRESS)))
      const unknown = refused.filter(x => !(t.verification || []).some(c => sameCommand(c, x, r.path)))
      trace.forbidden = [...new Set([...trace.forbidden, ...(t.verification || []).filter(c => refused.some(x => sameCommand(c, x, r.path)))])]
      if (!v) gaps = ['verifier without an answer']
      else if (!v.ok || unknown.length) gaps = [...(v.failures || []).map(e => `${e.command}: ${e.excerpt || 'failure'}`), ...unknown.map(x => `${x}: refused according to the verifier, but it is not a verification command of the task`)]
      // No command allowed: nothing proves the task, and a fix would change nothing
      else if ((t.verification || []).length && (t.verification || []).every(c => trace.forbidden.includes(c))) return await closeTask(t, 'blocked', attempts, r, [`no verification command allowed to the agents: ${trace.forbidden.join('; ')}`], trace)
      else {
        by = 'evaluation'
        const e = await agent(pEval(t, r, { ...v, forbidden: trace.forbidden }), { label: `${t.id} · evaluation`, agentType: AG('evaluator'), model: 'opus', schema: EVAL_S })
        noteProgress(t.id, 'evaluation', e)
        // A file unreadable once stays so: accumulated from one evaluation to the next
        if (e) { trace.unverifiable = e.unverifiable || []; trace.unreadable = [...new Set([...trace.unreadable, ...(e.unreadable || [])])] }
        if (!e) gaps = ['evaluator without an answer']
        else if (e.verdict === 'fail') gaps = e.gaps && e.gaps.length ? e.gaps : ['verdict fail without detail']
      }
      if (!gaps.length) break
      if (attempts > MAXFIX) return await closeTask(t, 'blocked', attempts, r, gaps, trace)
      const attemptRejection = { attempt: attempts, by, gaps }
      trace.rejections.push(attemptRejection)
      const choice = await chooseModel(t, attemptRejection, models, trace.rejections.slice(0, -1))
      // Every choice to the log, model change or not: a choice raised to the floor, equal to the previous attempt, has no other trace
      log(`${t.id}: fix ${attempts} on ${choice.model}${choice.change ? ` (instead of ${choice.change.from})` : ''}: ${choice.reason}`)
      const c = await agent(pFix(t, r, gaps, attemptRejection, choice), { label: `${t.id} · fix ${attempts}`, agentType: AG('worker'), model: choice.model, schema: REPORT_S, ...effort(t) })
      noteProgress(t.id, 'fix', c)
      models.push(choice.model)
      attempts++
      // Fix without an answer: we keep the report of the earlier attempts (deviations, reviews, branch)
      if (!c) return await closeTask(t, 'failed', attempts, r, ['fix without an answer (usage limit or API error)'], trace)
      r = accumulate(r, c)
    }
    // Post-merge check: the first verification command the agents are allowed to run
    const check = (t.verification || []).find(c => !trace.forbidden.includes(c)) || 'none'
    const i = await exclusive(() => agent(pMerge(t, r, isolated, check), { label: `${t.id} · merge`, agentType: AG('integrator'), model: 'sonnet', schema: INTEG_S }))
    noteProgress(t.id, 'merge', i)
    if (!i) return await closeTask(t, 'blocked', attempts, r, ['integrator without an answer'], trace)
    if (!(i.merged ?? i.ok)) return await closeTask(t, 'blocked', attempts, r, [`merge: ${i.detail || 'failure'}`], trace)
    if (!(i.check_ok ?? i.ok)) {
      // Merge done but check failed: the task stays merged and the run stops for a human
      const detail = `${setupOf(t).length ? 'setup or ' : ''}post-merge check failed on ${INTEG} (${check}): ${i.detail || 'failure'}`
      trace.entries = [{ type: 'needs-human', severity: 'major', description: detail }]
      stopOn({ task: t.id, title: `Post-merge check failed after ${t.id}`, context: detail, human: true, options: [{ id: 'repair', description: `Repair on ${INTEG}, replay the verifications, then rerun the phase`, impact: '', recommended: true }, { id: 'stop', description: 'Stop the plan here', impact: '', recommended: false }] }, trace.issues)
    }
    return await closeTask(t, 'merged', attempts, r, [], trace)
  } catch (err) {
    return { id: t.id, status: 'failed', attempts: 0, branch: null, summary: String(err), blocker: [`workflow error: ${String(err)}`] }
  }
}

// Scheduling: dependencies, resources, parallelism
phase('Tasks')
// A task with an open prerequisite in PREREQUISITES.md waits, even when rerun: the prerequisite is settled in the plan first
const waitingOnPrerequisites = plan.tasks.filter(t => !DONE(t.status) && (t.open_prerequisites || []).length).map(t => ({ id: t.id, prerequisites: t.open_prerequisites }))
const waitsOnPrerequisite = id => waitingOnPrerequisites.some(a => a.id === id)
// A "needs-human" task only restarts if the user reruns it (args.rerun)
const waiting = plan.tasks.filter(t => t.status === 'needs-human' && !RERUN.has(t.id) && !waitsOnPrerequisite(t.id)).map(t => t.id)
const pending = new Map(plan.tasks.filter(t => !DONE(t.status) && !waiting.includes(t.id) && !waitsOnPrerequisite(t.id)).map(t => [t.id, t]))
const running = new Map()
const locks = new Set()
const ready = t => deps(t).every(d => done.has(d)) && !amended.has(t.id) && !(t.resources || []).some(r => locks.has(r)) && !locks.has('checkout')
while (pending.size || running.size) {
  if (!stop) {
    for (const t of [...pending.values()]) {
      if (running.size >= PAR) break
      if (!ready(t)) continue
      const others = [...pending.values(), ...[...running.keys()].map(id => T.get(id))].filter(o => o.id !== t.id)
      // Worktree only if another task can run at the same time: never with a parallelism of 1
      const isolated = PAR > 1 && (running.size > 0 || others.some(o => canOverlap(o, t)))
      const taken = [...(t.resources || []), ...(isolated ? [] : ['checkout'])]
      taken.forEach(x => locks.add(x))
      pending.delete(t.id)
      running.set(t.id, runTask(t, isolated).then(res => {
        results.push(res)
        if (res.status === 'merged') done.add(t.id)
        taken.forEach(x => locks.delete(x))
        running.delete(t.id)
      }))
    }
  }
  if (!running.size) break
  await Promise.race(running.values())
}

phase('Wrap-up')
const failed = results.filter(r => r.status !== 'merged')
const summary = {
  phase: PHASE, mode: MODE, tasks: results, not_started: [...pending.keys()], deferred,
  added_tasks: added.map(x => ({ id: x.id, phase: x.phase, title: x.title })),
  reviews: results.flatMap(x => (x.reviews || []).map(d => ({ task: x.id, review: d }))),
  auto_decisions: autoDecisions, discarded_amendments: discardedRun, open_issues: issues, rulings_applied: rulingsApplied, waiting, waiting_on_prerequisites: waitingOnPrerequisites,
}
if (stop) return await finish({ status: 'awaiting-ruling', stop_issue: stop, ...summary })
if (failed.length || pending.size || waiting.length || waitingOnPrerequisites.length) return await finish({ status: 'partial', ...summary })
// Initial tasks all merged, but tasks added to this phase or deferred: rerun the phase
return await finish({ status: deferred.length || added.some(x => x.phase === PHASE) ? 'rerun' : 'finished', ...summary })
