export const meta = {
  name: 'run-phase',
  description: 'Runs one phase of a plan (folder plans/<name>): workers, verification, evaluation, fixes, merge and progress. Launched by /orchestre:run.',
  phases: [{ title: 'Plan reading' }, { title: 'Tasks' }, { title: 'Wrap-up' }],
}

// Orchestrator 0.12.0 (orchestre plugin)
// args: { plan, phase, mode: 'auto'|'deviation'|'phase', parallelism, integration, base, decisions, max_fixes, escalation, max_auto_decisions,
//   rerun, lint, agent_prefix, progress, setup, shared_setup, language }
// base: branch the integration branch starts from (main by default, read by plan-lint)
// lint: path of scripts/plan-lint.mjs, required (0.12.0): /orchestre:run passes it; the fallback of the manual install (v0.5) is gone.
//   The plan-reader runs it with --reader (0.18.1), which adds the fingerprint of what it prints (digest): the workflow computes it
//   again on the copy the agent returns, reads the plan a second time when they differ, then stops (planDigest)
// Rulings (0.20.0): no arg. The pilot records the user's answers with progress.mjs rule (progress.json, pending_rulings); the
//   plan-reader opens the run, then runs progress.mjs apply, which applies them to the plan and commits them, then reads the
//   plan: one call, ruling or not. The workflow reads the output of apply back through its digest (applyOut). A ruling apply
//   refuses (its issue open again, or the ruling dropped) stops the run before any task, after the others are applied.
// Answering during the run (0.21.0): no arg either. close gives each open issue that is not human a deadline and the tasks not
//   started it holds (waits); a held task, once ready, waits for the ruling through the clerk (progress.mjs wait), then starts,
//   after an apply when the issue was ruled, or without it (step "without") when released or past its deadline. A ruling
//   recorded while tasks run (pending in the output of a close) is applied at once, under the lock of the main checkout.
//   Mode deviation (0.21.0, D3): a major issue that is not human, given a deadline by close, no longer stops the run at once. No
//   task starts any more; once the tasks in flight end, the clerk waits for its ruling (progress.mjs wait). Ruled in time, it is
//   applied and the run goes on; released, past its deadline or a wait that fails, it stops the run as before.
// Challenger (0.22.0, D9): a task marked challenge: true in the plan (plan-lint only passes true) is challenged after each
//   successful evaluation, by the agent challenger (sonnet), isolated in a worktree of its own, on a detached checkout of the
//   head of the task's branch. It tries 3 mutations at most of the code of the diff, never of the tests, runs the task's
//   verification commands after each and restores the file. A mutation that nothing detected rejects the attempt (by:
//   challenge): the fix adds the missing test, then verification, evaluation and challenge run again, within max_fixes. A
//   challenger without an answer, or that could not run its pass, is no rejection: a blind spot under the task's close. Its
//   worktree, detached, is removed at the end of the run by worktrees.mjs clean. An equivalent mutation (equivalent: true with a
//   reason, 0.22.1) is logged and not counted; the fix may answer a survivor it judges equivalent by a deviation, which the
//   evaluator weighs; each later pass is told the mutations the earlier ones tried.
// rerun: ids of "needs-human" tasks the user restarts, after their decision
// progress (0.8.0): path of scripts/progress.mjs, sole writer of progress.json and of the PROGRESS.md view (contract orchestre-progress/4
//   since 0.20.0, which converts a file of orchestre-progress/3, orchestre-suivi/2 or /1).
//   The workflow launches nothing: it writes in its agents' instructions the command to run, and reads its result in progress_ok.
//   A worker isolated in a worktree carries no progress command (0.18.2): Claude Code's isolation guard refuses it there. The clerk
//   notes the start of its task from the main checkout, before the worker is launched (noteStart).
//   Close of a task (0.20.0): progress.mjs close writes and commits the plan (HANDOFF.md, tasks, amendments, ISSUES.json,
//   PROGRESS.md); the clerk runs it, or the scribe after DISCOVERY.md when the task has findings or flaky tests (pClose).
//   Each JSON carries _digest, and the output of close its digest (payloadDigest).
//   Without progress: progress as in 0.6.3, the scribe edits PROGRESS.md, HANDOFF.md and the tasks itself.
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
// The JSON object of a progress command, on standard input, in a heredoc whose delimiter is quoted: nothing in it is read by
// the shell (' ` $ ( * …). Not in --json '…' (0.18.0, issue #1): the Bash tool of Claude Code decodes the \uXXXX sequences of
// a command before the shell reads it, so the ' that kept an apostrophe inside the single quotes became a quote again,
// and a ` a command substitution. The JSON is on one line: none of its lines can be the delimiter.
// A text that holds a backslash followed by "u" keeps it through that decoding: its "u" is written u, which gives "u"
// whether the tool decodes it or JSON.parse does (a JSON \u escape, an odd run of backslashes, is left as is).
const HEREDOC = 'ORCHESTRE_JSON'
const heredocJson = x => JSON.stringify(x).replace(/\\+u/g, m => ((m.length - 1) % 2 ? m : `${m.slice(0, -1)}\\u0075`))
// Each JSON carries its fingerprint, "_digest" (0.20.0, see payloadDigest)
const progressCmd = (cmd, E) => `${PROGRESS_CMD} ${cmd} ${PLANARG} <<'${HEREDOC}'\n${heredocJson({ ...E, _digest: payloadDigest(E) })}\n${HEREDOC}`
// A progress command in an instruction: a block between ~~~ lines, which no backtick of the JSON can close
const block = c => `\n~~~sh\n${c}\n~~~\n`
const runBlock = `run it as is, once, in a single call: the JSON stays on its own line, between the two ${HEREDOC} lines`
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
const arr = x => (Array.isArray(x) ? x : [])
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
// Fingerprint of what the workflow reads from plan-lint (0.18.1): the same text, to the character, as in scripts/plan-lint.mjs,
// which prints it in "digest" with --reader. A field left out, empty or null reads alike; FNV-1a on 32 bits, 8 hexadecimal digits.
function planDigest(p) {
  const s = x => (typeof x === 'string' ? x : ''), ss = x => (Array.isArray(x) ? x.map(s) : []), n = x => (Number.isInteger(x) ? x : null)
  const list = x => (Array.isArray(x) ? x : []).map(y => (y && typeof y === 'object' ? y : {}))
  const c = JSON.stringify([p.ok === true, ss(p.errors),
    list(p.tasks).map(t => [s(t.id), s(t.title), s(t.file), n(t.phase), s(t.model), s(t.model_reason), s(t.effort), ss(t.depends_on), ss(t.resources), s(t.status), ss(t.verification), ss(t.open_prerequisites), ...(t.challenge === true ? [true] : [])]),
    list(p.all).map(x => [s(x.id), n(x.phase), s(x.status)]), n(p.max_phase)])
  let h = 0x811c9dc5
  for (let i = 0; i < c.length; i++) h = Math.imul(h ^ c.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}
// Fingerprint of the scope check of a task branch (0.19.0): the same text, to the character, as in scripts/plan-lint.mjs, which
// prints it in "digest" with --scope. The verifier copies that JSON in "scope"; the workflow computes the fingerprint again on
// the copy and, when they differ and the verification passes, has the plan-reader read the scope a second time; unfaithful
// again, the task goes on without these facts (blind spot). A field left out, empty or null reads alike; FNV-1a on 32 bits, 8 hexadecimal digits.
function scopeDigest(p) {
  const s = x => (typeof x === 'string' ? x : ''), ss = x => (Array.isArray(x) ? x.map(s) : [])
  const list = x => (Array.isArray(x) ? x : []).map(y => (y && typeof y === 'object' ? y : {}))
  const c = JSON.stringify([s(p.task), s(p.branch), ss(p.files), ss(p.outside), ss(p.tests_removed),
    list(p.skips_added).map(x => [s(x.file), Number.isInteger(x.line) ? x.line : null, s(x.marker)])])
  let h = 0x811c9dc5
  for (let i = 0; i < c.length; i++) h = Math.imul(h ^ c.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}
// Fingerprint of a payload (0.20.0): the same text, to the character, as in scripts/progress.mjs. Each JSON of a progress
// command handed to an agent carries it in "_digest": the script computes it again and refuses an altered copy ("payload
// altered in transit", nothing written), and the workflow runs that call again once. The output of close carries it in
// "digest", which the workflow computes again on the agent's copy. Keys sorted at every level, the field `skip` of the
// top level left out; FNV-1a on 32 bits, 8 hexadecimal digits.
function payloadDigest(p, skip = '_digest') {
  const sorted = (x, top) => (Array.isArray(x) ? x.map(y => sorted(y, false)) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).filter(k => !(top && k === skip)).sort().map(k => [k, sorted(x[k], false)])) : x)
  const c = JSON.stringify(sorted(p, true))
  let h = 0x811c9dc5
  for (let i = 0; i < c.length; i++) h = Math.imul(h ^ c.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}
if (!PLAN || !PHASE || !INTEG || !LINT) return { status: 'error', detail: 'args required: plan, phase, integration, lint' }
if (!['auto', 'deviation', 'phase'].includes(MODE)) return { status: 'error', detail: `unknown mode: ${MODE} (auto, deviation or phase)` }

// Report schemas
const S = (properties, required) => ({ type: 'object', properties, required })
const str = { type: 'string' }, bool = { type: 'boolean' }, strs = { type: 'array', items: str }
// Result of the progress command run by the agent (0.8.0); run_start_ok for the first agent of the run, which runs run-start
const PROGRESS_P = { progress_ok: bool, progress_error: str }
// Output of progress.mjs apply (0.20.0), copied as printed by the plan-reader that opens the run, with its result (apply_ok)
const nullable = t => ({ type: [t, 'null'] })
const APPLY_S = S({
  applied: { type: 'array', items: S({ issue: str, task: str, option: nullable('string'), text: nullable('string') }, ['issue', 'task', 'option', 'text']) },
  rejected: { type: 'array', items: S({ issue: str, option: nullable('string'), text: nullable('string'), reason: str }, ['issue', 'option', 'text', 'reason']) },
  discarded: { type: 'array', items: S({ id: str, reason: str }, ['id', 'reason']) },
  amended: { type: 'array', items: S({ id: str, verification: strs, depends_on: strs }, ['id', 'verification', 'depends_on']) },
  added_tasks: { type: 'array', items: S({ id: str, title: str, phase: nullable('integer') }, ['id', 'title', 'phase']) },
  // done (0.21.0): only when a did was pending, the prerequisites apply wrote into PREREQUISITES.md
  commit: nullable('string'), done: strs,
  // before_run (0.22.0): only in a run whose run-start took in rulings applied outside a run (pre-flight of /orchestre:run)
  before_run: { type: 'array', items: S({ issue: str, task: str, option: nullable('string'), text: nullable('string') }, ['issue', 'task', 'option', 'text']) },
  message: str, digest: str,
}, ['applied', 'rejected', 'discarded', 'amended', 'added_tasks', 'commit', 'message', 'digest'])
const PLAN_S = S({ ok: bool, errors: strs, tasks: { type: 'array', items: S({ id: str, title: str, file: str, phase: { type: 'integer' }, model: str, model_reason: str, effort: str, depends_on: strs, resources: strs, status: str, verification: strs, open_prerequisites: strs, challenge: bool }, ['id', 'file', 'depends_on', 'status', 'verification', 'open_prerequisites']) }, all: { type: 'array', items: S({ id: str, phase: { type: 'integer' }, status: str }, ['id']) }, max_phase: { type: 'integer' }, digest: str, run_start_ok: bool, progress_error: str, apply: APPLY_S, apply_ok: bool, apply_error: str }, ['ok', 'tasks', 'digest'])
const REPORT_S = S({
  status: { type: 'string', enum: ['done', 'partial', 'blocked'] }, summary: str, branch: str, commit: str, path: str, changed_files: strs,
  deviations: { type: 'array', items: S({ type: { type: 'string', enum: ['deviation', 'blind-spot', 'decision', 'debt', 'needs-human', 'review'] }, description: str, affected_tasks: strs }, ['type', 'description']) },
  findings: { type: 'array', items: S({ category: str, content: str }, ['category', 'content']) }, blocker: str, ...PROGRESS_P,
}, ['status', 'summary', 'branch', 'path'])
// The worker isolated in a worktree runs no progress command (0.18.2): its report has no result of one to give
const REPORT_ISOLATED_S = S(Object.fromEntries(Object.entries(REPORT_S.properties).filter(([k]) => !(k in PROGRESS_P))), REPORT_S.required)
const RESULT_S = S({ command: str, code: { type: 'integer' }, excerpt: str }, ['command', 'code', 'excerpt'])
// Output of plan-lint --scope, copied as printed (0.19.0)
const SCOPE_S = S({ task: str, branch: str, files: strs, outside: strs, tests_removed: strs, skips_added: { type: 'array', items: S({ file: str, line: { type: 'integer' }, marker: str }, ['file', 'line', 'marker']) }, digest: str }, ['task', 'branch', 'files', 'outside', 'tests_removed', 'skips_added', 'digest'])
const VERIF_S = S({ ok: bool, results: { type: 'array', items: RESULT_S }, failures: { type: 'array', items: S({ command: str, excerpt: str }, ['command']) }, flaky: strs, forbidden: strs, uncommitted: strs, scope: SCOPE_S, ...PROGRESS_P }, ['ok', 'results'])
// Proof contract of the evaluator (0.19.0): on a pass, one proof per criterion, by the diff, a test, a command of the verifier or the report
const PROOF_BY = ['diff', 'test', 'command', 'report']
const PROOF_S = S({ criterion: str, by: { type: 'string', enum: PROOF_BY }, ref: str }, ['criterion', 'by', 'ref'])
const EVAL_S = S({ verdict: { type: 'string', enum: ['pass', 'fail'] }, gaps: strs, unverifiable: strs, unreadable: strs, proofs: { type: 'array', items: PROOF_S }, ...PROGRESS_P }, ['verdict'])
// Challenger (0.22.0): no progress field, the agent is isolated; the clerk notes its step from the main checkout
const MUTATIONS_MAX = 3
// equivalent and reason (0.22.1): a mutation that no test could observe, because it changes no behavior, with why
const MUTATION_S = S({ file: str, line: { type: 'integer' }, change: str, detected: bool, by: str, equivalent: bool, reason: str }, ['file', 'change', 'detected'])
const CHALLENGE_S = S({ ok: bool, path: str, mutations: { type: 'array', items: MUTATION_S }, detail: str }, ['ok', 'mutations'])
const INTEG_S = S({ ok: bool, merged: bool, check_ok: bool, check_skipped: bool, conflict: bool, commit: str, detail: str, worktree_kept: str, ...PROGRESS_P }, ['ok', 'merged'])
const SCRIBE_S = S({ ok: bool, commit: str, rejected: { type: 'array', items: S({ id: str, reason: str }, ['id', 'reason']) }, discarded: { type: 'array', items: S({ id: str, reason: str }, ['id', 'reason']) }, ...PROGRESS_P }, ['ok'])
const CLERK_S = S({ progress_ok: bool, progress_error: str, commit: str, detail: str, worktrees: str }, ['progress_ok'])
// Close of a task with progress (0.20.0), by the clerk or the scribe: the output of progress.mjs close, copied as printed, and
// the paths cited by an auto-decision that neither exist nor belong to a task the close creates. Every field the script prints
// every time, empty or not, is required (0.22.1): an agent that drops an empty one (waits: []) makes its copy's digest differ
const IDREASON_S = { type: 'array', items: S({ id: str, reason: str }, ['id', 'reason']) }
// A rejected automatic decision names its issue (0.21.0): issue, its id, and title
const REJECTED_S = { type: 'array', items: S({ id: str, issue: nullable('string'), title: str, reason: str }, ['id', 'reason']) }
// waits (0.21.0): each open issue that is not human, its deadline and the tasks not started it holds
const WAITS_S = { type: 'array', items: S({ issue: str, until: str, holds: strs }, ['issue', 'until', 'holds']) }
const CLOSE_OUT_S = S({ task: str, status: str, commit: { type: ['string', 'null'] }, rejected: REJECTED_S, discarded: IDREASON_S, issues: strs, pending: strs, waits: WAITS_S, message: str, digest: str }, ['task', 'status', 'commit', 'rejected', 'discarded', 'issues', 'pending', 'waits', 'message', 'digest'])
const CLOSE_S = S({ progress_ok: bool, progress_error: str, close: CLOSE_OUT_S, missing: strs }, ['progress_ok'])
// Wait of a held task (0.21.0), by the clerk: the last output of progress.mjs wait, copied as printed
const WAIT_OUT_S = S({ task: str, settled: strs, released: strs, timeout: strs, again: bool, digest: str }, ['task', 'settled', 'released', 'timeout', 'again', 'digest'])
const WAIT_S = S({ progress_ok: bool, progress_error: str, wait: WAIT_OUT_S }, ['progress_ok'])
// apply during the run (0.21.0), by the clerk: its output, copied as printed
const APPLY_RUN_S = S({ progress_ok: bool, progress_error: str, apply: APPLY_S }, ['progress_ok'])
// Choice of a fix's model (0.11.0): haiku, sonnet or opus; fable only comes from a task the user put on it
// (orchestre.config.json: fable: true, checked by plan-lint), as a floor
const CHOICE_MODELS = ['haiku', 'sonnet', 'opus']
const CHOICE_S = S({ model: { type: 'string', enum: CHOICE_MODELS }, reason: str }, ['model', 'reason'])
// With progress, the command's result is required when it decides what follows: run start (first agent)
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
// Copy of plan-lint --scope (0.19.0): kept only if it is about this task and branch and matches its digest
const scopeOf = (x, t, r) => (x && typeof x === 'object' && x.task === t.id && x.branch === r.branch && typeof x.digest === 'string' && x.digest === scopeDigest(x) ? x : null)
// Proof contract (0.19.0): the reason a pass is refused, null when its proofs hold. A command proof needs a result of code 0
// of the verifier for that command
const filled = x => typeof x === 'string' && !!x.trim()
function proofsRefused(e, v, dir) {
  if (e.verdict !== 'pass') return null
  const proofs = arr(e.proofs)
  if (!proofs.length) return 'pass without proofs'
  const incomplete = proofs.filter(p => !p || typeof p !== 'object' || !filled(p.criterion) || !PROOF_BY.includes(p.by) || !filled(p.ref))
  if (incomplete.length) return `proofs without a criterion, a "by" among ${PROOF_BY.join(', ')} or a ref: ${short(JSON.stringify(incomplete), 200)}`
  const passed = arr(v && v.results).filter(x => x && x.code === 0)
  const unproven = proofs.filter(p => p.by === 'command' && !passed.some(x => sameCommand(x.command, p.ref, dir)))
  return unproven.length ? `command proofs that match no result of code 0 of the verifier: ${short(unproven.map(p => p.ref).join('; '), 200)}` : null
}
// A review cites a file if one of its words is that path, and not a path that contains it
const pathOf = x => x.replace(/^\.\//, '').replace(/\.+$/, '')
const cite = (d, f) => String(d).split(/[\s,;:()«»"'`]+/).some(x => x && pathOf(x) === pathOf(f))

// Prompts
// Progress (0.8.0): the command the agent runs as is, and what it reports from it
const reportProgress = 'Return progress_ok=true if it exits with code 0; otherwise progress_ok=false and the first line of its error in progress_error.'
// A progress command whose JSON reached the script altered (0.20.0): refused, nothing written. The calls whose progress
// command decides what follows (run start, start of a task in a worktree, close, run end) run again once. The step of a
// working agent does not: it only spoils the display, and its result goes to progress_failures
const altered = x => !!x && x.progress_ok !== true && x.run_start_ok !== true && /payload altered in transit/.test(String(x.progress_error || ''))
const pAgain = `Your first run of the progress command below was refused (payload altered in transit): its JSON line changed on the way, and nothing was written. Run it again, the JSON line copied character for character.
`
const pStep = (id, step, extra = {}, report = true) => (PROGRESS ? `Plan progress: your first command, before any other, is the one below; ${runBlock}.${block(progressCmd('step', { task: id, step, ...extra }))}${report ? reportProgress : 'Its result does not count: progress_ok is about the close command, further down.'} It is not part of the work asked: refused or failed, it goes in no other field of your report. Then go on, whatever its result.
` : '')
// Start of a task that works in a worktree (0.18.2): the worker step, run by the clerk in the main checkout. Claude Code's
// isolation guard refuses the progress command to an agent isolated in a worktree (a heredoc that names a script outside it:
// "too complex to verify that it stays inside the worktree"); the task then showed as not started for the whole of its worker.
// without (0.21.0): the issues a held task starts without (released, past their deadline), so that progress logs it
const withoutOf = ids => (ids && ids.length ? { without: ids } : {})
const pStart = (t, model, again = false, wo = []) => `${again ? pAgain : ''}Start of the task ${t.id} of the plan ${PLAN}, which works in a worktree: note it in the plan's progress, from the main checkout. Your only command is the one below; ${runBlock}.${block(progressCmd('step', { task: t.id, step: 'worker', isolated: true, model, ...withoutOf(wo) }))}${reportProgress} Run nothing else and change no file.`
// Step of the challenger (0.22.0), isolated in a worktree like the worker: the clerk notes it from the main checkout
const pChallengeStep = (t, again = false) => `${again ? pAgain : ''}Challenge of the task ${t.id} of the plan ${PLAN}, which runs in a worktree: note its step in the plan's progress, from the main checkout. Your only command is the one below; ${runBlock}.${block(progressCmd('step', { task: t.id, step: 'challenge' }))}${reportProgress} Run nothing else and change no file.`
const pRunStart = stop => `Plan progress: your first command, before any other, opens the run; ${runBlock}.${block(progressCmd('run-start', { phase: integer(PHASE, 1), mode: MODE, parallelism: PAR, max_fixes: integer(MAXFIX, 0), max_auto_decisions: integer(MAX_AUTO, 0) }))}If it exits with code 0, return run_start_ok=true and go on. Otherwise, stop there without doing anything else: ${stop}, run_start_ok=false, and the first line of its error in progress_error.
`
// A task's branch: new, or taken back from the most recent one (a branch held by another worktree is not taken back, we start from it).
// A branch taken back is brought up to date by a merge of the integration branch, never by a rebase (classified destructive).
// Branches tache/* of 0.11 are not taken back (0.12.0): the task starts again from the integration branch
const pBranch = t => `Branch: if no branch \`task/${t.id}\` exists, create it with \`git switch -c task/${t.id}\`. Otherwise (earlier attempt), take back the most recent work: \`git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads/task/${t.id} 'refs/heads/task/${t.id}-r*'\` gives the most recent branch first; if no worktree uses it (\`git worktree list\`), switch to it with \`git switch <branch>\`, otherwise create from it \`task/${t.id}-r<n>\`, with the first free n from 2 (\`git switch -c task/${t.id}-r<n> <branch>\`). Branch taken back: if \`git merge-base --is-ancestor ${INTEG} HEAD\` exits with code 1, it lacks the latest merges; bring it up to date with \`git merge --no-edit ${INTEG}\`. A conflict in your owned files is resolved; elsewhere, \`git merge --abort\` and status blocked. Never a rebase or a reset. Commit all your work on the branch you are on and return its exact name in "branch".`
// Environment setup, declared by the project; a failed command does not stop silently
const pSetup = (t, when, onFailure) => { const c = setupOf(t); return c.length ? `
Environment setup, ${when}: run one by one, as they are, these project commands: ${c.map(x => '`' + x + '`').join(', ')}. ${onFailure}` : '' }
// The isolated worker has no step command: the clerk ran it before (pStart)
const pWorker = (t, isolated, model, wo = []) => `${isolated ? '' : pStep(t.id, 'worker', { isolated: false, model, ...withoutOf(wo) })}Task ${t.id} of the plan ${PLAN}. First read ${PLAN}/DISCOVERY.md and the decisions of ${PLAN}/HANDOFF.md, then ${t.file}, and follow its "Launch prompt".
${isolated ? "You are in an isolated worktree: Claude Code's isolation guard only accepts simple commands there (see your rules)." : `You are in the main checkout, on ${INTEG}.`} ${pBranch(t)}${pSetup(t, 'once on your branch, before any other work', 'If one fails, go on, and describe the failure (command and excerpt of its output) in a deviation. If they change tracked files you do not own, do not commit them and describe it in a deviation.')}
Decisions taken: ${JSON.stringify(runDecisions())}.
A file your permissions forbid you to read or change (organization or project settings): never get around the ban, by any command or script; describe the expected change in a deviation of type "review", the human will make it before the PR.
Run the task's verification commands before handing back.
Report: status, summary, branch, last commit, absolute path of the working folder (pwd), changed files, deviations from the plan, findings useful to the following tasks.${pLanguage}`
// Scope check of the task branch (0.19.0), read-only, run from the main checkout, which holds the plan and the branches
const scopeCmd = (t, r) => `${LINTCMD} ${PLANARG} --scope ${t.id} --branch ${r.branch} --integration ${INTEG}`
const pVerif = (t, r) => `${pStep(t.id, 'verification')}Verify the task ${t.id}, branch ${r.branch}. First, from the folder you start in (the main checkout), without a \`cd\`: \`${scopeCmd(t, r)}\`. It changes nothing and prints one line of JSON: return it in "scope" exactly as printed, every field and every value, \`digest\` included, character for character; the workflow checks the copy against the digest. It is not a verification command of the task: if it fails or is refused, return no "scope", and cite it neither among the failures nor in "forbidden".
Then, without changing anything, \`cd "${r.path}" && git status --porcelain --untracked-files=all\`: a file it lists that the task owns (its owned_files, in ${t.file}) is work left uncommitted, which the merge would not take: count it as a failure, with the command \`git status\` and the excerpt "uncommitted: " followed by the files. A file it lists that the task does not own is not a failure: cite it in "uncommitted".
Then run one by one, without changing anything, each command below, prefixed with \`cd "${r.path}" &&\`:
${bullets(t.verification)}
The failures listed as pre-existing in ${PLAN}/DISCOVERY.md do not count. A command your permissions refuse (organization or project settings): never get around it, by any other command or script, and do not count it as a failure; cite it in "forbidden", as it appears in the list above, without the \`cd\` prefix; the human will run it before the PR. If a test command fails, run it again once only: if it passes, the verification passes, but cite each test that failed then passed in "flaky". To read an exit code, do not pipe the command: add \`; echo "code=$?"\`. Return ok; in "results", for each command, even a successful one, the command, its exit code (that of the second run if there was one) and the excerpt that proves it (summary line, 10 lines at most); in "failures", for each failure that counts, the command and a useful excerpt of its output (30 lines at most). Never run a command that reads real production or personal data (production dump, production database or a copy of it): count it as a failure, with the excerpt "needs-human: real data, an action reserved to the human".`
// Facts of the scope check passed to the evaluator (0.19.0); without them (copy unfaithful twice), it checks the scope itself
const pScopeFacts = scope => scope ? `Scope check of this branch by plan-lint --scope, a script whose copy the workflow checked: the files outside owned_files are already checked, do not read the scope yourself. Test files deleted or renamed (tests_removed): ${JSON.stringify(arr(scope.tests_removed))}. Skipped-test markers added (skips_added): ${JSON.stringify(arr(scope.skips_added))}. A test deleted or skipped is a gap, unless the definition of done asks for it. tests_removed lists the paths containing \`test\` or \`spec\` (case-insensitive), which can include files that are not tests (such as \`docs/latest.md\`): such a file is not a gap by itself.`
  : 'The scope check of this branch (plan-lint --scope) could not be read: check yourself, in the diff, that it touches no file outside owned_files, and that it deletes or skips no test, unless the definition of done asks for it.'
const pProofs = `On a pass, return "proofs": one entry per criterion of the definition of done, with "criterion" (its text), "by" and "ref": \`diff\` and the file:line of the diff, \`test\` and the test file and case, \`command\` and the command exactly as in the results of the verifier above (only a result of code 0 proves), or \`report\` and the passage of the worker's report (only for a criterion that asks for report content). A pass without proofs, or with a \`command\` proof that matches no result of code 0, is refused.`
const pEval = (t, r, v, scope, refused = null, challenged = []) => `${refused ? `Your first evaluation of this attempt of the task ${t.id} returned pass, refused by the workflow: ${refused}. Evaluate again, from the start.
` : pStep(t.id, 'evaluation')}Evaluate the task ${t.id}. Read the definition of done in ${t.file}, then the diff \`git diff ${INTEG}...${r.branch}\`.
Results of the verifier, taken on this branch just before you; they are proof of execution: ${JSON.stringify((v && v.results) || [])}.${v && (v.flaky || []).length ? ` Tests passed only on the second run, counted as passed: ${JSON.stringify(v.flaky)}.` : ''}
${pScopeFacts(scope)}
${(v && (v.forbidden || []).length) ? `Commands refused to the agents by their permissions, that the human will run before the PR: ${JSON.stringify(v.forbidden)}. A criterion that only they demonstrate is neither a gap nor an unverifiable criterion.
` : ''}Report of the worker; it is a deliverable, not a proof: its claims of execution demonstrate nothing. ${JSON.stringify({ summary: r.summary, findings: r.findings || [], deviations: r.deviations || [] })}
For each criterion, look for a proof: file:line of the diff, a test that covers it, or a result of the verifier above. A criterion that asks for report content is met if that content is in the worker's report. PROGRESS.md, HANDOFF.md and DISCOVERY.md are written by the scribe only at the end of the task: their state proves nothing, either way. A criterion that no verification command nor the diff can demonstrate in the context of this task, whatever the worker does (for example a behavior in a worktree for a task of the main checkout), is not a gap: cite it in "unverifiable" with the reason. This is rare: a criterion that is merely not proven stays a gap. A file of the diff your permissions forbid you to read (organization or project settings): never get around the ban; it is neither a gap nor an unverifiable criterion: cite it in "unreadable", the human will review it before the PR. A criterion that can only be demonstrated by reading such a file follows the same rule. Also check that the comments, headers, DECISIONS entries and procedures added or changed by the diff tell the truth: they describe what the code really does, and each command of a procedure meant for a human exists in the repository and does what the text says. A false text is a gap.${challenged.length ? ` An earlier attempt was rejected by the challenger, for changes of the code that no verification command detected: ${JSON.stringify(shorts(challenged))}. The worker may answer one that it judges equivalent (the change alters no behavior that any test could observe) by a deviation of its report, instead of a test: weigh its reason against the diff, and accept it only if it holds. A change that a test could observe, with neither a test for it nor a reason that holds, is a gap.` : ''} Verdict fail if a single demonstrable criterion is not demonstrated; then list the precise gaps. ${pProofs} Change nothing.${pLanguage}`
// The second reading of the scope, by the plan-reader, when the verifier's copy does not match its digest (0.19.0)
const pScope = (t, r) => `Your instructions read the scope of a task branch, not the plan. Run \`${scopeCmd(t, r)}\`, from the folder you start in (the main checkout), and return its JSON exactly as printed: every field and every value, \`digest\` included, character for character. Leave nothing out, add nothing, rephrase nothing: the workflow checks the copy against the digest.`
// Challenge of a task (0.22.0), by the challenger isolated in a worktree of its own: every command it is given is a simple one
// (isolation guard). The task's verification commands as the plan gives them, those refused to the agents left out
const pChallenge = (t, r, cmds, tried = []) => `Challenge of the task ${t.id} of the plan ${PLAN}: its evaluation passed; do the verification commands of its branch ${r.branch} detect a wrong change of its code? You are in an isolated worktree of your own: Claude Code's isolation guard only accepts simple commands there (see your rules).
1. \`git switch --detach ${r.branch}\`: a detached checkout of the head of the task's branch, never the branch itself, which the main checkout or the worker's worktree holds. If it fails, stop there: ok=false and the first line of its error in "detail".${pSetup(t, 'once on that checkout, before any other work', 'If one fails, stop there: ok=false, the command and an excerpt of its output in "detail".')}
2. Read ${t.file}, then \`git diff --name-only ${INTEG}...HEAD\` and \`git diff ${INTEG}...HEAD -- <file>\` for each file you may change: a file of code of that diff, never a test (a path that contains test or spec, a fixture, a snapshot), never a file outside the diff nor of ${PLAN}.
3. Without any mutation, run once each command below, one by one, as it is. If one fails, stop there: ok=false, the command and an excerpt of its output in "detail"; a challenge proves nothing where the verification already fails.
${bullets(cmds.map(c => '`' + c + '`'))}
4. Then ${MUTATIONS_MAX} mutations at most, one at a time, each on a line the diff adds or changes, where a wrong change would do the most harm: invert a condition, remove a guard, a check or a call, shift a bound or a constant. For each: change that line with your Edit tool; run the commands of point 3, one by one, as they are; then \`git checkout HEAD -- <file>\`, then \`git status --porcelain\`, which must print nothing before the next mutation. A mutation is detected when one of the commands exits with a code other than 0.${tried.length ? `
Mutations already tried by the earlier passes of this task (file:line, change, result): do not try them again, pick other lines of the diff.
${bullets(tried.map(m => `${m.file}${Number.isInteger(m.line) ? `:${m.line}` : ''}, ${m.change}, ${m.result}`))}` : ''}
5. Return ok=true, "path" (what \`pwd\` prints) and "mutations": for each mutation tried, "file", "line", "change" (the line before → after), "detected" and "by" (the first command that detected it, nothing if none). A mutation that no test could observe, because it changes no behavior (dead code, a guard another one already makes redundant, a value no path reads), is an equivalent mutant: return it with "equivalent" true and its "reason", the one thing that makes it equivalent. Never use it to dismiss a survivor: a mutation that a test could observe, and that none detected, is not equivalent, and "equivalent" without a "reason" counts as not detected. Never commit, never change a test, and leave the worktree as you found it, without a mutation.${pLanguage}`
const pFix = (t, r, gaps, rejection, choice) => `${pStep(t.id, 'fix', { rejection: rejection && { ...rejection, gaps: shorts(rejection.gaps) }, model: choice.model, ...(choice.change ? { change: choice.change } : {}) })}Fix of the task ${t.id}. Work in ${r.path}, on the branch ${r.branch}: prefix each command with \`cd "${r.path}" &&\` and edit the files by their absolute path under that folder. Read ${t.file} and ${PLAN}/DISCOVERY.md again.
Gaps to fix:
${bullets(gaps)}${rejection && rejection.by === 'challenge' ? `
These gaps come from the challenger: each is a change of the code of the branch that no verification command detected. Add to the task's tests the case that fails under that change, or strengthen the one that should; change the code itself only if the mutation shows a real bug. A gap that you judge equivalent (the mutation changes no behavior that any test could observe) gets no test: answer it with a deviation of your report that names the mutation (file:line) and says why no test could observe it. The evaluator weighs that reason against the diff and accepts it only if it holds; otherwise the gap rejects the attempt again.` : ''}
Same rules as the task: owned files only, commits on ${r.branch}, nothing in the progress files${PROGRESS ? ' (the progress command above aside)' : ''}, no merge into another branch and no push.${setupOf(t).length ? ` If your fix changes the dependencies or what is generated, first run again, in this folder, these setup commands of the project: ${setupOf(t).map(x => '\`' + x + '\`').join(', ')}.` : ''} Run the verifications again, then return the same report format.${(r.deviations || []).length ? `
Deviations already reported at earlier attempts, already recorded in the plan's progress: ${JSON.stringify(r.deviations)}. Do not repeat them; if your fix cancels one, say so in a deviation.` : ''}${(r.findings || []).length ? `
Findings of earlier attempts: ${JSON.stringify(r.findings)}. Return in your report the updated list: those that still hold, without those your fix makes false, plus the new ones.` : ''}${pLanguage}`
const pMerge = (t, r, isolated, check) => `${pStep(t.id, 'merge')}Merge the task ${t.id} in the main checkout: \`git switch ${INTEG}\`, then \`git merge --no-ff ${r.branch} -m "task ${t.id}: ${forMessage(t.title)}"\`.
On a conflict: \`git merge --abort\`, then return ok=false, merged=false, conflict=true and the files involved.
Otherwise, return merged=true.${isolated ? '' : `
Then compare the tree of ${INTEG} with the verified branch: \`git diff --quiet ${r.branch} HEAD\` (add \`; echo "code=$?"\`). Code 0: the merged tree is the one the verifier just checked in this same folder; run neither the setup nor the check below, and return check_skipped=true, check_ok=true and ok=true. Any other code: go on below, without check_skipped.`}${pSetup(t, `on ${INTEG}, after the merge and before the check`, 'If one fails, do not run the check: return check_ok=false, with "setup:" followed by the command and an excerpt of its output in detail. After them, `git status --porcelain` must be empty: a setup changes no tracked file and leaves no file that is not ignored; otherwise, do not run the check and return check_ok=false, with "setup: changed files" and their list in detail.')}
Then run on ${INTEG} this check command, without a pipe (add \`; echo "code=$?"\`): ${check}. Return check_ok according to its exit code, a useful excerpt in detail on a failure, and ok=true only if the merge and the check succeeded.${isolated ? `
Then remove the worktree, never by force: \`git worktree unlock "${r.path}"\` (ignore the error), then \`git worktree remove "${r.path}"\`. If git refuses (modified or untracked files: work that was not committed), leave the worktree as it is, never with --force nor by deleting its folder, and return the first line of git's message in worktree_kept; the merge and the check keep their result. Keep the branch.` : ''}`
// Choice of the model of the next fix (0.11.0): the attempt's rejection, the earlier rejections and their models
const pChoice = (t, rejection, before, previous) => `Choice of the model of fix ${rejection.attempt} of the task ${t.id} (${t.file}). Model planned by the plan: ${t.model}${t.model_reason ? ` ("${oneLine(t.model_reason)}")` : ''}; it is a floor: the fix will never run on a weaker model. Attempt ${rejection.attempt}, on ${before}, was rejected by ${rejection.by === 'verification' ? 'the verification' : rejection.by === 'challenge' ? 'the challenge (changes of its code that no verification command detected)' : 'the evaluation'}. Gaps: ${JSON.stringify(rejection.gaps)}.${previous.length ? ` Attempts rejected before it: ${JSON.stringify(previous)}.` : ''}
Return model (haiku, sonnet or opus) and reason, on one line: haiku for a mechanical gap (text, format, renaming, configuration), sonnet for an implementation gap, opus for a gap of architecture, ambiguous, that touches several modules, or that comes back after a fix on the same model. You may read the task file. Rate no deviation, prepare no issue and change nothing.${pLanguage}`
const pReplan = (t, r, status, gaps, unverifiable, sensitive = []) => `Replanning after ${t.id} (status: ${status}, phase ${PHASE}${LAST ? ', last phase of the plan' : ''}, mode ${MODE}). Task: ${t.file}; its code is on the branch ${r.branch}${status === 'merged' ? `, merged into ${INTEG} (main checkout)` : `, in ${r.path}`}. Deviations reported: ${JSON.stringify(r.deviations || [])}. Gaps: ${JSON.stringify(gaps)}. Criteria unverifiable in the context of the task: ${JSON.stringify(unverifiable || [])}.${sensitive.length ? ` Sensitive deviations (data, database, prod, secret), major automatically: return an issue for each, except for a deviation that only concerns a file forbidden to the agents (see below): ${JSON.stringify(sensitive)}.` : ''}
Read ${PLAN}/PROGRESS.md, the decisions of ${PLAN}/HANDOFF.md, ${PLAN}/PREREQUISITES.md if it exists, and the remaining tasks of ${PLAN}/tasks/. Rate each deviation minor or major according to your grid and return one entry per deviation, except for those you return in "reviews".
For each major deviation and each unverifiable criterion, return an issue in "issues": title, context, 2 or 3 options of which a single one is recommended. Each option carries its actions: HANDOFF entries, tasks to add (phase ${PHASE} or later, never a past phase; an added task cites in "prerequisites" the prerequisites of PREREQUISITES.md it needs), amendments of tasks not yet started, other than ${t.id} (criteria, owned files, verification commands or dependencies to add, never anything to remove). Before adding a task, prefer amending a task not yet started that owns the files concerned, then one added task for all the findings of this answer on the same files; a separate task only for a reason of the splitting rule (parallel, contract, risk, size). For a task already merged, propose a task to add rather than an amendment. An option only cites tasks and files that already exist or that it creates itself. No option has an agent read, restore or copy real production or personal data: that action belongs to the human. Recommend the safest option for security and data: one more test or guard rather than an accepted risk.${MODE === 'auto' ? ' Autonomous mode: the recommended option will be applied as is, without a human review before the PR.' : ''}${LAST ? ' Last phase: only propose a task for an issue that protects the deployment, security or data; for the others, an entry of type "ticket" (to open after the PR), without a task.' : ''}
A file the agents may not read or write (organization or project settings), and that the human only has to review or change before the PR, is never an issue nor an entry: return it in "reviews", with in "review" the file and what the human must review or change in it, and in "deviation" the description, copied as is, of the reported deviation it replaces, if that deviation only concerns this file and is not of type needs-human. A deviation that also concerns something else stays a deviation. If a human action is needed before going on (a secret missing to run the tests, for example), it is a human need, not a review. Mark "human" an issue no agent can settle (access, secret, production, real data, product choice), an issue about an open prerequisite of PREREQUISITES.md (decision deferred by the user, manual action), a deviation of type needs-human, or an environment or tooling problem whose cause is not demonstrated by a command output cited above. Change nothing.${pLanguage}`

// Instructions for the scribe of a run without progress (0.6.3): created tasks, amendments, check by plan-lint, report. With
// progress (0.20.0), no agent gets them any more: close applies the actions of an issue settled automatically, apply those of a
// user's ruling
const pUpdates = (id, updates) => `${updates.tasks.length ? `
- New tasks: create them in ${PLAN}/tasks/ with the content given, as is, and add their row to PROGRESS.md, status "added": ${JSON.stringify(updates.tasks)}` : ''}${updates.amendments.length ? `
- Amendments, for tasks not yet started: in the frontmatter of each task concerned, append the items listed to the end of the matching list (definition_of_done, owned_files, verification, depends_on), without removing or rewording anything, then note "amendment · major · <id>: <reason>" under "## ${id}" in HANDOFF.md. Do not amend a task missing from the plan: return it in "rejected". A task "merged" or "cancelled" in PROGRESS.md can no longer be amended: note "blind-spot · major · amendment not applied to <id>: <reason>" under "## ${id}" in HANDOFF.md and return it in "discarded", not in "rejected". Amendments: ${JSON.stringify(updates.amendments)}` : ''}${updates.discarded.length ? `
- Amendments not applied, because the task concerned has already started or finished: note each under "## ${id}" in HANDOFF.md, as "blind-spot · major · amendment not applied to <id>: <reason>": ${JSON.stringify(updates.discarded)}` : ''}${(updates.auto || []).length ? `
- Decisions taken automatically in this update: ${JSON.stringify(updates.auto)}. For each file path they cite, check that it exists in the repository (\`test -e <path>\`) or that a task created here owns it; otherwise, note "needs-human · major · inconsistent auto-decision: <path> does not exist and no task creates it" under "## ${id}" in HANDOFF.md and return the decision in "rejected".` : ''}${updates.tasks.length || updates.amendments.length ? `
- Then run \`${LINTCMD} ${PLANARG} --integration ${INTEG}${BASE}\`. Any error that concerns a task created or amended here: put that task back in its original state (\`git checkout HEAD -- <file>\` for an amended file; for a created task, remove its file and its row of PROGRESS.md).
- Each task created or amended that you could not apply, or that you put back in its original state: note "needs-human · major · <id> not applied: <reason>" under "## ${id}" in HANDOFF.md, and return it in "rejected".` : ''}
Return ok=true once the commit is done, with its hash, "rejected" (empty if everything is applied) and "discarded" (empty if no amendment concerned a merged or cancelled task).${pLanguage}`
// Close of a task without progress (orchestre without progress.mjs): the scribe writes every file itself, as in 0.6.3
const pScribe = (t, status, attempts, r, updates, gaps, { flaky = [], rejections = [], unverifiable = [] } = {}) => `In the main checkout, start with \`git switch ${INTEG}\`. Update the progress of the plan ${PLAN}, then commit these files only, and the tasks created or amended, with the message "progress(${t.id}): ${status}".
- PROGRESS.md: row ${t.id} → status "${status}", attempts ${attempts}, branch ${r ? r.branch : '—'}; actual tokens: "see /workflows".
- HANDOFF.md: under "## ${t.id}", add these entries, word for word: ${JSON.stringify(updates.entries)}${gaps.length ? `, and this blocker: ${JSON.stringify(gaps)}` : ''}.${(rejections || []).length ? `
- HANDOFF.md, still under "## ${t.id}": an entry "rejection · minor · attempt <n>, <by>: <gaps separated by semicolons>" for each of these attempts rejected then fixed: ${JSON.stringify(rejections)}` : ''}${unverifiable.length ? `
- HANDOFF.md, still under "## ${t.id}": an entry "blind-spot · minor · criterion unverifiable in the context of the task: <criterion and reason>" for each of these: ${JSON.stringify(unverifiable)}` : ''}
- DISCOVERY.md: integrate these findings without duplicates, in the right section: ${JSON.stringify((r && r.findings) || [])}.${(flaky || []).length ? `
- Flaky tests (passed on the second run): add them to DISCOVERY.md, section "Pitfalls and fixes", and a "debt · minor" entry in HANDOFF.md: ${JSON.stringify(flaky)}` : ''}${pUpdates(t.id, updates)}`
// Close of a task with progress (0.20.0): progress.mjs close writes HANDOFF.md, the tasks created, the amendments, ISSUES.json
// and PROGRESS.md, runs plan-lint, and commits them with DISCOVERY.md. Without a finding nor a flaky test, the clerk runs it
// alone (haiku); otherwise the scribe first files them in DISCOVERY.md. Neither writes HANDOFF.md, a task nor an amendment.
// The agent copies the output of close back; the workflow checks the copy against its digest
const pClose = (t, status, E, { scribe, findings, flaky, auto }, again) => {
  const steps = [
    `\`git switch ${INTEG}\`. If it fails, run nothing else: return progress_ok=false and the first line of its error in progress_error.`,
    ...(scribe ? [`${planFile('DISCOVERY.md')}: integrate these findings without duplicates, each in its section: ${JSON.stringify(findings)}.${flaky.length ? ` Flaky tests (passed on the second run): add them to the section "Pitfalls and fixes": ${JSON.stringify(flaky)}.` : ''} Do not commit it: the close command does.`] : []),
    ...(auto.length ? [`Decisions taken automatically in this close: ${JSON.stringify(auto)}. For each file path they cite, check that it exists in the repository (\`test -e <path>\`) or that a task created by this close owns it (owned_files in the content of the JSON below). Return in "missing" each path that does neither; otherwise leave "missing" empty.`] : []),
    `The command below; ${runBlock}. It writes HANDOFF.md, the tasks created, the amendments, ISSUES.json and PROGRESS.md, runs plan-lint, and commits them${scribe ? ' with DISCOVERY.md' : ''}, with the message "progress(${t.id}): ${status}".${block(progressCmd('close', E))}If it exits with code 0, it prints one line of JSON: return it in "close" exactly as printed, every field and every value, \`digest\` included, character for character, and progress_ok=true; the workflow checks the copy against the digest. Otherwise, progress_ok=false, the first line of its error in progress_error, and no "close".`,
  ]
  return `${again ? pAgain : scribe ? pStep(t.id, 'progress', {}, false) : ''}Close of the task ${t.id} of the plan ${PLAN}, in the main checkout, in this order:
${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}
Never write HANDOFF.md, PROGRESS.md, a task or an amendment yourself, and make no commit: the close command does. Run nothing else.${scribe ? pLanguage : ''}`
}
// The plan-reader retypes the JSON of plan-lint --reader (0.18.1): the workflow checks its copy against the digest that plan-lint
// computed. A second reading, after a copy that does not match, never runs run-start again: the run is already open.
// Rulings (0.20.0): the plan-reader that opens the run runs apply between run-start and plan-lint, so that the plan it reads
// is the one the rulings changed. apply reads no input: the rulings are those of progress.json; without one, it writes nothing
const APPLY_CMD = PROGRESS && `${PROGRESS_CMD} apply ${PLANARG}`
const pApply = () => `Then the user's rulings recorded since the last run: the command below applies them to the plan and commits them itself (HANDOFF.md, tasks, ISSUES.json, PROGRESS.md); it is the script that writes, not you, and without a ruling recorded it writes nothing. Run it as is, once, in a single call, from the folder you start in (the main checkout).${block(APPLY_CMD)}If it exits with code 0, it prints one line of JSON: return it in "apply" exactly as printed, every field and every value, \`digest\` included, character for character, and apply_ok=true; the workflow checks the copy against the digest. Otherwise, stop there without running plan-lint: apply_ok=false, the first line of its error in apply_error, empty tasks.
`
const pReader = (opens, again, retry = false) => `${retry ? pAgain : ''}${opens ? pRunStart('return ok=false and empty tasks') + pApply() : ''}${again ? 'Your first copy of this output did not match its digest. ' : ''}${opens ? 'Then run' : 'Run'} \`${LINTCMD} ${PLANARG} --reader --phase ${PHASE} --integration ${INTEG}${BASE}\` and return its JSON exactly as printed${opens ? ', with run_start_ok, apply and apply_ok' : ''}: every field and every value, \`digest\` included, character for character. Leave nothing out, add nothing, rephrase nothing: the workflow checks the copy against the digest.`
// Answering during the run (0.21.0). A task ready to start that the valid options of an open issue amend waits for the ruling:
// the clerk runs progress.mjs wait, which blocks until each issue is settled, released or past its deadline (set by close, kept
// in progress.json: the workflow keeps no clock), 100 seconds at most per run, then answers again=true. The clerk runs it again
// in the same call, outside the exclusive queue: the wait takes no lock, the rest of the phase goes on. t.stopping (mode
// deviation): the run waits, on behalf of the task whose close raised the issues
const pWait = (t, ids, again = false) => `${again ? pAgain : ''}${t.stopping ? `Wait of the run of the plan ${PLAN} (mode deviation): the issues ${ids.join(', ')}, raised at the close of ${t.id}, stop it unless the user rules on them first.` : `Wait of the task ${t.id} of the plan ${PLAN}: it is ready to start, but the user's ruling on ${ids.join(', ')} may amend it.`} From the main checkout, run the command below, as is, in a single call each time: the JSON stays on its own line, between the two ${HEREDOC} lines.${block(progressCmd('wait', { task: t.id, issues: ids }))}It blocks until each issue is settled, released or past its deadline, 100 seconds at most per run, then prints one line of JSON. While that line says "again":true, run the same command again, unchanged, without a timeout of your own. Once it says "again":false, return that last line in "wait" exactly as printed, every field and every value, \`digest\` included, character for character, and progress_ok=true; the workflow checks the copy against the digest. If a run exits with a code other than 0, stop there: progress_ok=false, the first line of its error in progress_error, and no "wait". Run nothing else and change no file.`
// The rulings recorded during the run (pending in the output of a close, settled in the output of a wait): the clerk runs apply in
// the main checkout, which holds the lock of the main checkout meanwhile, as a worker of the main checkout does, and in the
// exclusive queue
const pApplyRun = () => `The user's rulings recorded during the run of the plan ${PLAN}, in the main checkout, in this order:
1. \`git switch ${INTEG}\`. If it fails, run nothing else: return progress_ok=false and the first line of its error in progress_error.
2. The command below applies them to the plan and commits them itself (HANDOFF.md, tasks, ISSUES.json, PROGRESS.md); it is the script that writes, not you. Run it as is, once, in a single call.${block(APPLY_CMD)}If it exits with code 0, it prints one line of JSON: return it in "apply" exactly as printed, every field and every value, \`digest\` included, character for character, and progress_ok=true; the workflow checks the copy against the digest. Otherwise, progress_ok=false, the first line of its error in progress_error, and no "apply".
Never write HANDOFF.md, PROGRESS.md, a task or an amendment yourself, and make no commit: the command does. Run nothing else.`
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
  // Without rulings_applied (0.20.0): apply notes them in the run itself. The amendments apply discarded (task null in its
  // output) are left out, the progress schema needing a task: apply already noted them in the run, with the task of their
  // issue. run-end keeps the entries the run already holds and adds those of this summary, without duplicates
  auto_decisions: (v.auto_decisions || []).map(d => ({ ...d, description: short(d.description) })),
  discarded_amendments: (v.discarded_amendments || []).filter(e => e.task != null).map(e => ({ task: e.task, id: e.id, reason: short(e.reason) })),
  added_tasks: (v.added_tasks || []).map(x => ({ ...x, ...(parents.has(x.id) ? { added_by: parents.get(x.id) } : {}) })), deferred: v.deferred || [], not_started: v.not_started || [], waiting: v.waiting || [], waiting_on_prerequisites: v.waiting_on_prerequisites || [],
})
const pClerk = (v, again = false) => `${again ? pAgain : ''}End of the run: phase ${PHASE} of the plan ${PLAN}, status "${v.status}". In the main checkout, in this order:
1. \`git switch ${INTEG}\`.
2. The command below; ${runBlock}.${block(progressCmd('run-end', progressSummary(v)))}${reportProgress}
3. \`git diff --quiet HEAD -- ${planFile('PROGRESS.md')}\`: if it exits with code 1, PROGRESS.md changed: \`git commit -m "progress: end of the run of phase ${PHASE}" -- ${planFile('PROGRESS.md')}\`, which only commits that file, and return its hash in commit. Otherwise, no commit.
4. \`${WTCMD} clean ${PLANARG}\`: it removes the clean worktrees the plan's tasks left behind (branches kept). Return its output, or its error message, in worktrees.
If step 1 fails, run step 2 anyway, skip steps 3 and 4 and say why in detail. If the commit fails, say why in detail. Otherwise, leave detail empty. Run nothing else and change no other file.`

// Run state
let stop = null
const issues = [], added = [], results = [], autoDecisions = [], deferred = [], discardedRun = [], rulingsApplied = []
// Circuit breaker (0.19.0): agents not answering. On a real run (0.18.1), an expired login brought every agent back without an
// answer, and each close turned that into issues ("Replanning without an answer", "Progress not committed"), for hours.
// Every agent call but the run end's clerk goes through ask, which counts the calls that come back without an answer or throw,
// in the order they return; an answer resets the count. At NO_ANSWER_MAX in a row, the breaker latches: no task starts any
// more, a task in flight stops at its next call (INTERRUPT), without a close (neither replanner, nor scribe, nor issue), and
// the run ends in error. Fewer calls in a row without an answer keep their effect of 0.18.2.
const NO_ANSWER_MAX = 2
const INTERRUPT = new Error('circuit breaker: agents not answering')
let silent = [], breaker = null
const interrupted = []
// Tasks interrupted after their merge, at their replanning or their scribe (0.19.0): the next run takes them as merged (commit
// "task <id>:") and never closes them, so what their close would have recorded comes out in merged_unclosed, outside run-end.
// A task interrupted at its own merge call comes out there too, with merge: 'unknown': git merge may have run before the
// integrator stopped answering, and only the pilot can look for its commit "task <id>:" before the new run
const mergedUnclosed = []
// What a close records from the report and the trace, before any replanning: the deviations, the reviews (review deviations,
// commands refused to the agents) and those of the files unreadable for the evaluator that no review cites yet
const deviationsOf = r => ((r && r.deviations) || []).filter(e => e.type !== 'review')
const reviewsOf = (r, trace) => [...((r && r.deviations) || []).filter(e => e.type === 'review').map(e => e.description), ...(trace.forbidden || []).map(c => `command \`${c}\` refused to the agents: to run by the human before the PR`)]
const unreadableOf = (trace, reviews) => (trace.unreadable || []).filter(f => !reviews.some(d => cite(d, f))).map(f => `${f}: unreadable by the agents, to review by the human before the PR`)
const unclosedOf = (t, r, trace, reviews, lost, unknown = false) => { mergedUnclosed.push({ id: t.id, branch: r ? r.branch : null, ...(unknown ? { merge: 'unknown' } : {}), deviations: deviationsOf(r), reviews: [...new Set([...reviews, ...unreadableOf(trace, reviews), ...(trace.kept || [])])], unverifiable: trace.unverifiable || [], issues: lost }) }
const unanswered = label => {
  if (!breaker) { silent.push(label); if (silent.length >= NO_ANSWER_MAX) { breaker = silent; log(`agents not answering: ${breaker.join(', ')}`) } }
  return !!breaker
}
async function ask(prompt, opts) {
  if (breaker) throw INTERRUPT
  let r
  try { r = await agent(prompt, opts) } catch (err) { throw unanswered(opts.label) ? INTERRUPT : err }
  if (r == null) { if (unanswered(opts.label)) throw INTERRUPT } else if (!breaker) silent = []
  return r
}
// Progress (0.8.0): run opened by run-start, and failed script calls (only the display suffers, except the run start, close and apply)
let opened = false
const progressFailures = []
// Added task → task whose close created it, for run-end (a close not written leaves them out of progress)
const parents = new Map()
const noteProgress = (task, step, x) => { if (PROGRESS && x && x.progress_ok !== true) progressFailures.push({ task, step, error: x.progress_error || (x.progress_ok === false ? 'failure without a message' : 'result not reported') }) }
// Amended tasks whose progress is not yet committed (counter per task): they only start afterwards
const amended = new Map()
// Answering during the run (0.21.0). heldBy: task → the open issues it waits for, from the waits of each close (the tasks of this
// run not started that a valid option amends); waitJobs: the waits in flight; startsWithout: task → the issues it starts without
// (released, past their deadline), for its start step; late: task → the amendments an apply during the run made after it
// started, which its work did not take in. A task whose wait ended on a ruling starts after the apply it asks for: the loop
// starts that apply before any task, and no task starts while it holds the lock of the main checkout
const heldBy = new Map(), waitJobs = new Map(), startsWithout = new Map(), late = new Map()
// ruledFor (0.22.0): task → the issues its wait ended settled on, that the next apply should apply
const ruledFor = new Map()
let applyWanted = false, applyBy = null, applying = null
// Mode deviation (0.21.0, D3): the issues that wait for their ruling instead of stopping the run ({ p, id, waits }), until an
// apply settles them or they stop it; deadlines: the issues close gave a deadline; stopJobs: their waits in flight, by task
const stopWaits = [], deadlines = new Set(), stopJobs = new Map()
// Only the tasks of this run still to start wait; the others are past it, or of another phase
const holdFrom = out => { for (const w of arr(out.waits)) for (const id of arr(w.holds)) if (pending.has(id)) { if (!heldBy.has(id)) heldBy.set(id, new Set()); heldBy.get(id).add(w.issue) } }
const wantApply = by => { if (!applyWanted) applyBy = by; applyWanted = true }
const appliedHere = id => rulingsApplied.some(a => a.issue === id)
// The id close gave each issue of this run (its output lists them in the order of its input), so that an issue settled by an
// apply during the run leaves open_issues
const issueIds = new Map()
// The first issue stops the run; the next ones go to open_issues. bucket: the issues of the current close, for progress
const stopOn = (p, bucket) => { if (bucket) bucket.push(p); if (!stop) stop = p; else issues.push(p) }
// An added task never runs in a phase already past
const toPhase = x => { const p = Math.max(Number(x.phase) || PHASE, PHASE); return { ...x, phase: p, content: String(x.content || '').replace(/^phase:\s*\d+/m, `phase: ${p}`) } }
// Options keep their actions: close records them in ISSUES.json, where apply takes the option the user chose (0.20.0)
const issueOf = (t, pt) => ({ task: t.id, title: pt.title, context: pt.context || '', human: !!pt.human, options: pt.options || [] })
// An issue as close records it (0.20.0): whole, its options with their actions, the tasks they add brought back to this phase
// at least, as the scribe created them before; with auto, the option the autonomous mode applies, and the amendments it applies
const wholeIssue = (p, auto = null, amendments = null) => ({
  ...p, options: (p.options || []).map(o => ({ ...o, ...(o.added_tasks ? { added_tasks: o.added_tasks.map(toPhase) } : {}), ...(auto != null && o.id === auto ? { amendments } : {}) })),
  ...(auto != null ? { auto } : {}),
})
const humanIssue = (id, title, context, options = []) => ({ task: id, title, context, human: true, options })
// Automatic decisions of a close that did not take them (0.21.0): close rejected them, or the close was refused. They leave
// autoDecisions (the cap, the decisions given to the agents, the return and run-end), and their issues, options included,
// go back to open_issues. decisions and decided are pushed in pairs by applyRecommended
const notTaken = (updates, which) => updates.decisions.forEach((d, i) => {
  if (!which(d)) return
  const k = autoDecisions.indexOf(d)
  if (k >= 0) autoDecisions.splice(k, 1)
  issues.push(updates.decided[i])
})
// The HANDOFF lines of a close (0.21.0), in the formats of progress.mjs close: what a refused close leaves unwritten
const handoffLine = (type, severity, text) => `${type} · ${severity} · ${oneLine(text)}`
const closeLines = (E, entries) => [
  ...entries.map(e => handoffLine(e.type, e.severity, e.description)),
  ...arr(E.blocker).map(g => handoffLine('blocker', 'major', g)),
  ...arr(E.rejections).map(x => handoffLine('rejection', 'minor', `attempt ${x.attempt}, ${x.by}: ${arr(x.gaps).map(oneLine).join('; ')}`)),
  ...arr(E.unverifiable).map(c => handoffLine('blind-spot', 'minor', `criterion unverifiable in the context of the task: ${c}`)),
  ...arr(E.flaky).map(x => handoffLine('debt', 'minor', `flaky test, passed on the second run: ${x}`)),
]
// The decision line of each automatic decision, then the entries and amendments of its option
const autoLines = autoIssues => autoIssues.flatMap(p => {
  const o = (p.options || []).find(x => String(x.id) === String(p.auto)) || {}
  return [handoffLine('decision', 'major', `${p.title}: option ${o.id} taken automatically (autonomous mode) — ${o.description ?? ''}`), ...arr(o.entries).map(e => handoffLine(e.type, e.severity, e.description)), ...arr(o.amendments).map(a => handoffLine('amendment', 'major', `${a.id}: ${a.reason}`))]
})
// The rulings apply applied at the run start: their decision entries are in HANDOFF.md, which the workers read
const runDecisions = () => [...DECISIONS, ...rulingsApplied.map(a => `${a.issue}: ${a.text != null ? a.text : `option ${a.option}`} (settled by the user)`), ...autoDecisions.map(o => `${o.title}: ${o.description} (taken automatically)`)]

// Every exit after the run start goes through finish: the clerk closes the run in progress (run-end)
let worktrees = null
async function finish(v) {
  if (PROGRESS && opened) {
    // A clerk that throws must not lose the summary: issues and actions live only in the return value
    // Called outside ask: after the circuit breaker too, since run-end clears the steps of the interrupted tasks
    let g = null
    const end = again => agent(pClerk(v, again), { label: 'run end · progress', agentType: AG('clerk'), model: 'haiku', schema: CLERK_S })
    try {
      g = await end(false)
      if (altered(g)) { log('run end: run-end refused, payload altered in transit; run again'); g = await end(true) }
    } catch (err) { progressFailures.push({ task: null, step: 'run-end', error: `clerk failed: ${String(err)}` }); g = undefined }
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

// Output of apply copied by the plan-reader (0.20.0): kept only if it matches its digest, its lists present
const applyOut = x => (x && typeof x === 'object' && ['applied', 'rejected', 'discarded'].every(k => Array.isArray(x[k])) && typeof x.digest === 'string' && x.digest === payloadDigest(x, 'digest') ? x : null)
// The rulings an apply refused, at the run start or during the run: what happened to each issue
const refusedBy = rejected => `rulings refused by apply: ${rejected.map(x => `${x.issue} (${x.option != null ? `option ${x.option}` : 'text'}: ${x.reason})`).join('; ')}. An issue is open again only when apply reopened it, its option invalid with the reason (refused by plan-lint or by an action, or no entry in ISSUES.json); a ruling on an unknown or already settled issue, an absent option or an option already invalid is dropped, and nothing is reopened.`
// What an apply applied, at the run start or during the run: the decisions given to the agents that follow, and the amendments it
// could not make (task merged or cancelled), whose issue its output does not give
// The opening apply also gives the rulings an apply outside a run applied before it (before_run, 0.22.0): settled by the user for
// this run too, in the return and in the decisions given to the agents
const noteApplied = (ap, opening = false) => {
  if (opening && arr(ap.before_run).length) { rulingsApplied.push(...ap.before_run); log(`rulings applied before the run: ${ap.before_run.map(a => a.issue).join(', ')}`) }
  rulingsApplied.push(...ap.applied)
  discardedRun.push(...ap.discarded.map(a => ({ task: null, id: a.id, reason: a.reason })))
  if (ap.applied.length) log(`rulings applied: ${ap.applied.map(a => a.issue).join(', ')}${ap.commit ? ` (${short(ap.commit, 12)})` : ''}`)
}

phase('Plan reading')
// With progress, the plan reader opens the run, then applies the user's rulings (apply), then reads the plan: one call (0.20.0)
const readerOpens = !!PROGRESS
const readPlan = (opens, again, retry = false) => ask(pReader(opens, again, retry), { label: again ? 'plan-reader · second reading' : 'plan-reader', agentType: AG('plan-reader'), model: 'haiku', schema: opens ? requireFields(PLAN_S, 'run_start_ok', 'apply_ok') : PLAN_S })
let plan = await readPlan(readerOpens, false)
// run-start refused, its JSON altered on the way (0.20.0): nothing was written, the plan reader runs again once
if (readerOpens && altered(plan)) { log('plan-reader: run-start refused, payload altered in transit; run again'); plan = await readPlan(true, false, true) }
if (readerOpens && plan) {
  if (plan.run_start_ok !== true) return notOpened(plan)
  opened = true
  // Rulings (0.20.0): apply failed (main checkout not on the integration branch, commit refused): nothing written, the rulings
  // stay recorded for the next run. Its output not read: apply ran, but what it refused is unknown. Either way, no task starts
  const stopBefore = (status, detail, extra = {}) => finish({ status, phase: PHASE, mode: MODE, detail, rulings_applied: rulingsApplied, discarded_amendments: discardedRun, tasks: [], open_issues: [], auto_decisions: [], ...extra })
  if (plan.apply_ok !== true) return await stopBefore('error', `progress: rulings not applied (apply), no task started — ${plan.apply_error || (plan.apply_ok === false ? 'failure without a message' : 'result not reported')}. The rulings stay recorded: the next run applies them.`)
  const ap = applyOut(plan.apply)
  if (!ap) return await stopBefore('error', `progress: output of apply not read, no task started — the copy does not match its digest. apply ran: read the last commit "progress: rulings …" on ${INTEG} and the issues of progress.json before a new run.`)
  noteApplied(ap, true)
  // A refused ruling still stops the run, before any task, once the others are applied. No stop issue: the issue is the one
  // the user ruled on. apply reopened it (open again, the option invalid with the reason) when plan-lint or an action refused
  // the option, or when the issue has no entry in ISSUES.json; it dropped the ruling, marking nothing, on an unknown or
  // already settled issue, an absent option or an option already invalid. Its output does not say which: the detail says both
  if (ap.rejected.length) return await stopBefore('awaiting-ruling', `${refusedBy(ap.rejected)} No task started.`, { rulings_refused: ap.rejected })
}
// Copy checked (0.18.1): everything that follows (statuses, dependencies, verifications, prerequisites) comes from this copy
const faithful = p => typeof p.digest === 'string' && p.digest === planDigest(p)
if (plan && !faithful(plan)) {
  log(`plan-reader: copy of plan-lint that does not match its digest (${typeof plan.digest === 'string' ? short(plan.digest, 20) : 'none'}, ${planDigest(plan)} computed); second reading`)
  plan = await readPlan(false, true)
  if (plan && !faithful(plan)) return await finish({ status: 'error', phase: PHASE, detail: `plan-reader: two copies of plan-lint's output that do not match its digest; no task started. Launch a new run.${plan.ok === false && (plan.errors || []).length ? ` plan-lint, as copied: ${short((plan.errors || []).join('; '), 400)}` : ''}`, rulings_applied: rulingsApplied })
}
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
  // The issue as raised, options included: if the scribe is interrupted, the decision is never applied (merged_unclosed)
  updates.decided.push(issueOf(t, pt))
  updates.auto.push(`${pt.title}: ${rec.description}`)
  // With progress (0.20.0), these entries, tasks and amendments reach the plan through the decided issue (auto), which close
  // applies; viaAuto keeps them out of the close's own lists. Without progress, the scribe writes them all
  const entries = [{ type: 'decision', severity: 'major', description: `${pt.title}: option ${rec.id} taken automatically (autonomous mode) — ${rec.description}` }, ...(rec.entries || [])]
  const tasks = (rec.added_tasks || []).map(toPhase)
  updates.entries.push(...entries)
  updates.tasks.push(...tasks)
  for (const x of [...entries, ...tasks]) updates.viaAuto.add(x)
  const fresh = new Set([...added, ...updates.tasks].map(x => x.id))
  const applied = []
  for (const am of rec.amendments || []) {
    if (done.has(am.id) || doneElsewhere(am.id) || running.has(am.id)) { const d = { task: t.id, ...am }; updates.discarded.push(am); updates.discardedHere.push(d); discardedRun.push(d); continue }
    applied.push(am)
    updates.amendments.push(am)
    const c = T.get(am.id)
    if (!c) continue
    amended.set(am.id, (amended.get(am.id) || 0) + 1)
    c.verification = [...(c.verification || []), ...(am.verification || [])]
    c.depends_on = [...(c.depends_on || []), ...(am.depends_on || [])]
    // New dependency on a task added during this run: the task waits for the next run
    if ((am.depends_on || []).some(d => fresh.has(d)) && pending.delete(am.id)) deferred.push(am.id)
  }
  // The issue whole for close, auto naming the option applied; its amendments without those discarded here (task done or
  // running), which close notes as amendments not applied
  updates.autoIssues.push(wholeIssue(issueOf(t, pt), rec.id, applied))
}

// Circuit breaker: a close interrupted at its scribe wrote nothing. What it put in the run's state (issues, auto-decisions,
// discarded amendments, added tasks) reached neither HANDOFF.md nor progress, and leaves the summary. The issues the task
// brought to its close (kept: a post-merge check failed, on a merge that did happen) stay.
function forget(u, kept) {
  const gone = new Set([...u.issues.filter(p => !kept.includes(p)), ...u.decisions, ...u.discardedHere, ...u.tasks])
  for (const xs of [issues, autoDecisions, discardedRun, added]) xs.splice(0, xs.length, ...xs.filter(x => !gone.has(x)))
  for (const x of u.tasks) parents.delete(x.id)
  if (gone.has(stop)) stop = null
}

// Output of close copied by the agent (0.20.0): kept only if it is about this close and matches its digest
const closeOut = (x, t, status) => (x && typeof x === 'object' && x.task === t.id && x.status === status && typeof x.digest === 'string' && x.digest === payloadDigest(x, 'digest') ? x : null)
// Close of a task with progress (0.20.0): a single call, to the clerk without a finding nor a flaky test, to the scribe
// otherwise (pClose). The input of close is the whole close: HANDOFF entries, texts uncut, issues with their actions, tasks
// with their content; an auto-decided issue carries auto and close applies its option. A refusal for an altered payload
// wrote nothing: the call runs again once; refused again, or refused for another reason, the run stops for a human, as for a
// failed scribe. The output is read back through its digest
async function closeWithProgress(t, final, attempts, r, gaps, updates, { flaky, rejections, unverifiable, allReviews, replan }) {
  const findings = (r && r.findings) || []
  const entries = updates.entries.filter(e => !updates.viaAuto.has(e))
  const tasks = updates.tasks.filter(x => !updates.viaAuto.has(x))
  const issues = [...updates.issues.map(p => wholeIssue(p)), ...updates.autoIssues]
  const E = {
    task: t.id, status: final, attempts, branch: r ? r.branch : null,
    ...(entries.length ? { entries } : {}), ...(gaps.length ? { blocker: gaps.map(oneLine) } : {}),
    ...(rejections.length ? { rejections: rejections.map(x => ({ ...x, gaps: (x.gaps || []).map(oneLine) })) } : {}),
    ...(unverifiable.length ? { unverifiable: unverifiable.map(oneLine) } : {}), ...(flaky.length ? { flaky: flaky.map(oneLine) } : {}),
    // Reviews on one line but whole: progress matches them with their HANDOFF.md entry, word for word
    ...(allReviews.length ? { reviews: allReviews.map(oneLine) } : {}), ...(issues.length ? { issues } : {}),
    ...(tasks.length ? { added_tasks: tasks.map(x => ({ id: x.id, title: x.title, phase: x.phase, content: x.content })) } : {}),
    ...(updates.discarded.length ? { discarded_amendments: updates.discarded.map(a => ({ id: a.id, reason: a.reason ?? '' })) } : {}),
    ...(replan ? { replanning: true } : {}),
  }
  const scribe = findings.length > 0 || flaky.length > 0
  const opts = { label: `${t.id} · progress`, ...(scribe ? { agentType: AG('scribe'), model: 'sonnet' } : { agentType: AG('clerk'), model: 'haiku' }), schema: CLOSE_S }
  const call = again => exclusive(() => ask(pClose(t, final, E, { scribe, findings, flaky, auto: updates.auto }, again), opts))
  let s = await call(false)
  if (altered(s)) { log(`${t.id}: close refused, payload altered in transit; run again`); s = await call(true) }
  noteProgress(t.id, 'close', s)
  if (!s) return stopOn(humanIssue(t.id, `Progress of ${t.id} not committed`, `${scribe ? 'Scribe' : 'Clerk'} without an answer.`))
  if (s.progress_ok !== true) {
    const lost = closeLines(E, entries), undecided = autoLines(updates.autoIssues)
    stopOn(humanIssue(t.id, `Progress of ${t.id} not committed`, `close refused${altered(s) ? ' twice' : ''}: ${s.progress_error || 'result not reported'}. Nothing of the close is written (HANDOFF.md, tasks, amendments, ISSUES.json); the run end closes ${t.id} in progress.json from the summary.${lost.length ? ` HANDOFF entries not written: ${JSON.stringify(lost)}` : ''}${undecided.length ? ` Automatic decisions not taken, their issues back in open_issues: ${JSON.stringify(undecided)}` : ''}`))
    return notTaken(updates, () => true)
  }
  const out = closeOut(s.close, t, final)
  if (!out) return stopOn(humanIssue(t.id, `Progress of ${t.id}: output of close not read`, `the copy of the output of progress.mjs close does not match its digest: the close ran, but what it rejected or discarded is unknown. Read the commit "progress(${t.id}): ${final}" on ${INTEG} and HANDOFF.md under "## ${t.id}" before the next run.`))
  // Answering during the run (0.21.0), only from a copy checked against its digest: the tasks each open issue holds wait for its
  // ruling once ready, and a ruling recorded meanwhile (pending) is applied at once
  // One id per issue passed, in the order of the input (updates.issues, then updates.autoIssues); otherwise none is mapped, and
  // every issue stays in open_issues rather than one settled under the id of another
  const passed = [...updates.issues, ...updates.autoIssues]
  if (arr(out.issues).length === passed.length && out.issues.every(x => typeof x === 'string')) passed.forEach((p, i) => issueIds.set(p, out.issues[i]))
  else log(`${t.id}: close gave ${arr(out.issues).length} issue ids for ${passed.length} issues: none mapped, each stays in open_issues`)
  holdFrom(out)
  for (const w of arr(out.waits)) if (w && typeof w.issue === 'string' && typeof w.until === 'string') deadlines.add(w.issue)
  if (arr(out.pending).length) wantApply(t.id)
  discardedRun.push(...arr(out.discarded).map(e => ({ task: t.id, ...e })))
  // Rejected by close (plan-lint), or a path cited by an auto-decision that neither exists nor belongs to a task created here
  const rejected = [...arr(out.rejected), ...arr(s.missing).map(p => ({ id: p, reason: 'cited by an auto-decision: it does not exist and no task created by this close owns it' }))]
  if (rejected.length) stopOn(humanIssue(t.id, `Progress of ${t.id}: tasks, amendments or decisions rejected`, JSON.stringify(rejected)))
  // An automatic decision close rejected (an item naming its issue, 0.21.0): not taken, its issue open in ISSUES.json
  const refused = new Set(arr(out.rejected).filter(x => x && x.issue != null).map(x => x.title))
  notTaken(updates, d => refused.has(d.title))
}

async function closeTask(t, status, attempts, r, gaps = [], trace = {}) {
  const flaky = [...new Set(trace.flaky || [])], rejections = trace.rejections || [], unverifiable = trace.unverifiable || []
  // issues and decisions: those of this close, passed to progress (close); tasks running in parallel have their own
  // Scope of the branch not checked (0.19.0): two copies of plan-lint --scope that did not match their digest
  const scopeBlind = trace.scopeUnread ? [{ type: 'blind-spot', severity: 'minor', description: trace.scopeUnread }] : []
  // Challenge not done (0.22.0): a challenger without an answer, or that could not run its pass, is no rejection
  const challengeBlind = trace.challengeBlind ? [{ type: 'blind-spot', severity: 'minor', description: trace.challengeBlind }] : []
  const updates = { entries: [...(trace.entries || []), ...scopeBlind, ...challengeBlind], tasks: [], amendments: [], discarded: [], auto: [], issues: [...(trace.issues || [])], decisions: [], decided: [], discardedHere: [], viaAuto: new Set(), autoIssues: [], untilRuled: [] }
  // Amended by an apply during the run after it started (0.21.0): its work did not take them in. Merged, they are amendments not
  // applied (a blind-spot under its close); otherwise its file keeps them, and the next run starts it with them
  if (status === 'merged') for (const a of late.get(t.id) || []) { const d = { task: t.id, ...a }; updates.discarded.push(a); updates.discardedHere.push(d); discardedRun.push(d) }
  // Files and commands the agents may not read, write or run: review by the human before the PR, without an issue or a stop
  const reviews = reviewsOf(r, trace)
  const deviations = deviationsOf(r)
  // File unreadable for the evaluator: a generic entry, unless a review already cites it
  const unreadableReviews = () => unreadableOf(trace, reviews)
  // Circuit breaker after the merge (0.19.0), at the replanning or at the scribe: nothing of this close is recorded and the next
  // run takes the task as merged. Its deviations, reviews, unverifiable criteria and lost issues go to merged_unclosed
  const unclosed = lost => { if (status === 'merged') unclosedOf(t, r, trace, reviews, lost) }
  let reclassified = new Set()
  // Sensitive deviations (data, database, prod, secret): major automatically, whatever the rating
  const sensitive = deviations.filter(e => e.type !== 'needs-human' && SENSITIVE.test(e.description || '')).map(e => e.description)
  const majorIfSensitive = e => (SENSITIVE.test(e.description || '') ? { ...e, severity: 'major' } : e)
  let humanSeen = false
  const replan = !!(r && (deviations.length || status !== 'merged' || unverifiable.length))
  if (replan) {
    const rp = await ask(pReplan(t, { ...r, deviations }, status, gaps, unverifiable, sensitive), { label: `${t.id} · replanning`, agentType: AG('replanner'), model: 'opus', schema: REPLAN_S })
      .catch(err => { if (err === INTERRUPT) unclosed([]); throw err })
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
        // Mode deviation with progress (0.21.0): the issue stops the run after its close, unless close gave it a deadline
        else if (MODE === 'deviation') { if (PROGRESS) { const p = issueOf(t, pt); updates.issues.push(p); updates.untilRuled.push(p) } else stopOn(issueOf(t, pt), updates.issues) }
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
  reviews.push(...unreadableReviews())
  // Worktree that git refused to remove after the merge (0.18.0): uncommitted work, never removed by force
  reviews.push(...(trace.kept || []))
  const allReviews = [...new Set(reviews)]
  updates.entries.push(...allReviews.map(d => ({ type: 'review', severity: 'major', description: d })))
  const needs = deviations.filter(e => e.type === 'needs-human')
  if (needs.length && !humanSeen) stopOn(humanIssue(t.id, `Human need reported by ${t.id}`, needs.map(e => e.description).join('; ')), updates.issues)
  // Unmerged task that waits for a human: it only restarts on their decision (args.rerun)
  const final = status !== 'merged' && (humanSeen || needs.length) ? 'needs-human' : status
  added.push(...updates.tasks)
  for (const x of updates.tasks) parents.set(x.id, t.id)
  // Circuit breaker at the close: nothing of it is written (forget), and a merged task comes out in merged_unclosed
  const interruptedClose = err => {
    if (err === INTERRUPT) { const kept = trace.issues || []; forget(updates, kept); unclosed([...updates.issues.filter(p => !kept.includes(p)), ...updates.decided]) }
    throw err
  }
  if (PROGRESS) await closeWithProgress(t, final, attempts, r, gaps, updates, { flaky, rejections, unverifiable, allReviews, replan }).catch(interruptedClose)
  else {
    const s = await exclusive(() => ask(pScribe(t, final, attempts, r, updates, gaps, { flaky, rejections, unverifiable }), { label: `${t.id} · progress`, agentType: AG('scribe'), model: 'sonnet', schema: SCRIBE_S })).catch(interruptedClose)
    if (s) discardedRun.push(...(s.discarded || []).map(e => ({ task: t.id, ...e })))
    if (!s || !s.ok) stopOn(humanIssue(t.id, `Progress of ${t.id} not committed`, s ? 'The scribe could not commit.' : 'Scribe without an answer.'))
    else if ((s.rejected || []).length) stopOn(humanIssue(t.id, `Progress of ${t.id}: tasks, amendments or decisions rejected`, JSON.stringify(s.rejected)))
  }
  // Mode deviation (0.21.0): an issue close gave a deadline waits for its ruling (with the run already stopped, the end of the
  // run stops on it); without one (ruling_wait_minutes 0, a close not read), it stops the run as before
  for (const p of updates.untilRuled) { const id = issueIds.get(p); if (deadlines.has(id)) stopWaits.push({ p, id, waits: 0 }); else stopOn(p) }
  for (const am of updates.amendments) { const n = (amended.get(am.id) || 1) - 1; if (n > 0) amended.set(am.id, n); else amended.delete(am.id) }
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
    const c = await ask(pChoice(t, rejection, before, previous.map((x, i) => ({ attempt: x.attempt, model: models[i], by: x.by, gaps: shorts(x.gaps) }))), { label: `${t.id} · model choice ${rejection.attempt}`, agentType: AG('replanner'), model: 'opus', schema: CHOICE_S, effort: 'low' })
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

// Start of a task in a worktree, noted by the clerk before its worker is launched (0.18.2, see pStart). Awaited, so that this
// step is written before the next ones of the task. A clerk that fails, throws or does not answer only spoils the display:
// the failure goes to progress_failures and the worker starts all the same. Without progress, nothing to note.
// The step of the challenger, isolated too, is noted the same way (0.22.0)
async function byClerk(t, step, what, call) {
  if (!PROGRESS) return
  let g = null
  // The circuit breaker is not a failure of the clerk: the task stops there
  try {
    g = await call(false)
    // The step refused, its JSON altered on the way (0.20.0): nothing was written, the clerk runs again once
    if (altered(g)) { log(`${t.id}: ${what} refused, payload altered in transit; run again`); g = await call(true) }
  } catch (err) { if (err === INTERRUPT) throw err; g = { progress_ok: false, progress_error: `clerk failed: ${String(err)}` } }
  noteProgress(t.id, step, g || { progress_ok: false, progress_error: 'clerk without an answer' })
}
const noteStart = (t, model) => byClerk(t, 'worker', 'start', again => ask(pStart(t, model, again, startsWithout.get(t.id)), { label: `${t.id} · start`, agentType: AG('clerk'), model: 'haiku', schema: CLERK_S }))

// Challenge of a task marked challenge: true (0.22.0, D9), after a successful evaluation. Returns the gaps: one per mutation
// that no verification command detected, among the first MUTATIONS_MAX; a mutation of a test file is not counted, the
// challenger may not change the tests. Without an answer, or a pass it could not run (ok=false), no gap: a blind spot under
// the close (trace.challengeBlind), never a rejection; the same for a pass that counted no mutation (0.22.1). A mutation
// returned with equivalent: true and a reason (it changes no behavior any test could observe) is logged, not counted (0.22.1);
// without a reason, it is a survivor. The mutations of every pass are kept in trace.tried, and given to the next pass
const TEST_PATH = /test|spec/i
const where = m => `${m.file}${Number.isInteger(m.line) ? `:${m.line}` : ''}`
const equivalentOf = m => m.detected === false && m.equivalent === true && typeof m.reason === 'string' && oneLine(m.reason) !== ''
async function challenge(t, r, trace) {
  await byClerk(t, 'challenge', 'challenge step', again => ask(pChallengeStep(t, again), { label: `${t.id} · challenge · start`, agentType: AG('clerk'), model: 'haiku', schema: CLERK_S }))
  const cmds = (t.verification || []).filter(c => !trace.forbidden.includes(c))
  const c = await ask(pChallenge(t, r, cmds, trace.tried), { label: `${t.id} · challenge`, agentType: AG('challenger'), model: 'sonnet', schema: CHALLENGE_S, isolation: 'worktree' })
  if (!c || c.ok !== true || !Array.isArray(c.mutations)) {
    trace.challengeBlind = `challenge of ${t.id} not done: ${c ? `challenger could not run its pass (${short(c.detail || 'no detail', 300)})` : 'challenger without an answer'}; the tests of its branch were not challenged by mutations`
    log(`${t.id}: ${trace.challengeBlind}`)
    return []
  }
  const tried = c.mutations.slice(0, MUTATIONS_MAX).filter(m => m && typeof m === 'object')
  const onTests = tried.filter(m => TEST_PATH.test(String(m.file || '')))
  if (onTests.length) log(`${t.id}: challenge, mutations of a test file not counted: ${short(onTests.map(m => m.file).join(', '), 200)}`)
  const equivalents = tried.filter(m => !onTests.includes(m) && equivalentOf(m))
  for (const m of equivalents) log(`${t.id}: challenge, equivalent mutation not counted: ${where(m)}, ${short(m.reason, 300)}`)
  const survivors = tried.filter(m => m.detected === false && !onTests.includes(m) && !equivalents.includes(m))
  trace.tried = [...trace.tried, ...tried.map(m => ({ file: String(m.file || ''), line: m.line, change: short(m.change, 200), result: m.detected === true ? `detected${m.by ? ` by ${short(m.by, 100)}` : ''}` : equivalents.includes(m) ? `equivalent: ${short(m.reason, 200)}` : 'not detected' }))]
  // A pass that counted no mutation (an empty list, or only mutations of test files) challenged nothing: a blind spot, no rejection
  if (tried.length === onTests.length) trace.challengeBlind = `challenge of ${t.id}: no mutation tried`
  log(`${t.id}: challenge, ${tried.length} mutation(s) tried, ${survivors.length} not detected`)
  return survivors.map(m => `mutation not detected by any verification command: ${where(m)}, ${oneLine(m.change)}`)
}

// Wait of a held task for the rulings of its issues (0.21.0), by the clerk, outside the exclusive queue (pWait). An issue
// settled by a ruling not applied yet sends the task after the next apply; released or past its deadline, the task starts
// without it. A wait without an answer runs again once: a second one in a row trips the circuit breaker, and the task does not
// start. A wait that fails, or whose copy does not match its digest, leaves the task to start without its rulings, as in 0.20
const waitOut = (x, t) => (x && typeof x === 'object' && x.task === t.id && ['settled', 'released', 'timeout'].every(k => Array.isArray(x[k])) && typeof x.again === 'boolean' && typeof x.digest === 'string' && x.digest === payloadDigest(x, 'digest') ? x : null)
// The calls of a wait: { out } once it is over, { why } when it failed, null on the circuit breaker
async function waitRuns(t, ids) {
  const call = again => ask(pWait(t, ids, again), { label: `${t.id} · wait`, agentType: AG('clerk'), model: 'haiku', schema: WAIT_S })
  let out = null, why = null
  try {
    for (;;) {
      let w = await call(false)
      if (altered(w)) { log(`${t.id}: wait refused, payload altered in transit; run again`); w = await call(true) }
      if (w == null) { log(`${t.id}: wait without an answer; run again`); w = await call(false) }
      noteProgress(t.id, 'wait', w || { progress_ok: false, progress_error: 'clerk without an answer' })
      out = w && w.progress_ok === true ? waitOut(w.wait, t) : null
      if (!out) { why = !w ? 'clerk without an answer' : w.progress_ok === true ? 'output of wait not read, the copy does not match its digest' : w.progress_error || 'result not reported'; break }
      // again: the clerk stopped before the end of the wait; the wait goes on in a new call
      if (!out.again) break
    }
  } catch (err) { if (err === INTERRUPT) return null; out = null; why = `clerk failed: ${String(err)}` }
  return { out, why }
}
async function waitFor(t) {
  // heldBy keeps only the issues no apply of this run has settled (runApply takes them out)
  const ids = [...heldBy.get(t.id)]
  heldBy.delete(t.id)
  const w = await waitRuns(t, ids)
  if (!w) return
  const { out, why } = w
  if (!out) { startsWithout.set(t.id, ids); log(`${t.id}: wait failed (${short(why, 200)}); it starts without the rulings on ${ids.join(', ')}`); return }
  const settled = ids.filter(id => out.settled.includes(id)), rest = ids.filter(id => !settled.includes(id))
  if (rest.length) startsWithout.set(t.id, rest)
  log(`${t.id}: wait over${settled.length ? `, ruled: ${settled.join(', ')}` : ''}${rest.length ? `, starts without: ${rest.join(', ')}` : ''}`)
  const toApply = settled.filter(id => !appliedHere(id))
  if (toApply.length) { ruledFor.set(t.id, toApply); wantApply(t.id) }
}
// Mode deviation (0.21.0, D3): the run waits for the rulings of the issues a close raised, on behalf of the task closed (pWait,
// t.stopping). A ruling not applied yet asks for an apply, which takes its issue out of stopWaits; released, past its deadline or
// a wait that fails, the issue stops the run, as before. On the circuit breaker, the end of the run stops on them
async function waitForStop(task, ids) {
  const w = await waitRuns({ id: task, stopping: true }, ids)
  if (!w) return
  const settled = w.out ? ids.filter(id => w.out.settled.includes(id)) : []
  const stops = stopWaits.filter(x => ids.includes(x.id) && !settled.includes(x.id))
  for (const x of stops) { stopWaits.splice(stopWaits.indexOf(x), 1); stopOn(x.p) }
  log(`${task}: ${w.out ? 'wait over' : `wait failed (${short(w.why, 200)})`}${settled.length ? `, ruled: ${settled.join(', ')}` : ''}${stops.length ? `; the run stops on ${stops.map(x => x.id).join(', ')}` : ''}`)
  if (settled.some(id => !appliedHere(id))) wantApply(task)
}

// apply during the run (0.21.0), by the clerk, in the exclusive queue and under the lock of the main checkout (the loop takes
// it). What it applied reaches the tasks not started yet before their worker: their verifications and dependencies added; a
// dependency on a task created in this run sends the task to the next run, as for an automatic decision. An amendment of a
// task already started is late: its close notes it as not applied. A refused ruling, a failed apply or an output not read stop
// the run for a human, as at the run start
async function runApply() {
  const by = applyBy
  applyWanted = false
  // The tasks whose wait ended on rulings before this apply: what it does not apply (withdrawn meanwhile: an Undo of the pane,
  // 0.22.0) they start without; a wait that ends while it runs is for the next apply
  const ruledBefore = new Map(ruledFor)
  ruledFor.clear()
  let a
  try { a = await exclusive(() => ask(pApplyRun(), { label: 'rulings · apply', agentType: AG('clerk'), model: 'haiku', schema: APPLY_RUN_S })) } catch (err) { a = err === INTERRUPT ? INTERRUPT : { progress_ok: false, progress_error: `clerk failed: ${String(err)}` } }
  if (a === INTERRUPT) return
  noteProgress(null, 'apply', a || { progress_ok: false, progress_error: 'clerk without an answer' })
  if (!a || a.progress_ok !== true) return stopOn(humanIssue(by, 'Rulings not applied during the run', `progress.mjs apply ${a ? `failed: ${a.progress_error || 'result not reported'}` : 'without an answer (clerk)'}. Nothing of it is written; the rulings stay recorded: the next run applies them.`))
  const ap = applyOut(a.apply)
  if (!ap) return stopOn(humanIssue(by, 'Rulings applied during the run: output of apply not read', `the copy of the output of progress.mjs apply does not match its digest: apply ran, but what it applied or refused is unknown. Read the last commit "progress: rulings …" on ${INTEG} and the issues of progress.json before the next run.`))
  noteApplied(ap)
  added.push(...arr(ap.added_tasks).map(x => ({ id: x.id, title: x.title, phase: x.phase ?? PHASE })))
  const fresh = new Set(added.map(x => x.id)), ruled = new Set(ap.applied.map(x => x.issue))
  for (const [id, s] of heldBy) { for (const i of ruled) s.delete(i); if (!s.size) heldBy.delete(id) }
  for (const [task, ids] of ruledBefore) {
    const not = ids.filter(id => !ruled.has(id))
    if (!not.length) continue
    startsWithout.set(task, [...new Set([...(startsWithout.get(task) || []), ...not])])
    log(`${task}: ${not.join(', ')} not applied (ruling withdrawn meanwhile); it starts without`)
  }
  // Settled now: no longer an open issue of the return, which the pilot would have the user settle again
  issues.splice(0, issues.length, ...issues.filter(p => !ruled.has(issueIds.get(p))))
  // Mode deviation: ruled in time, the issue no longer stops the run
  const goesOn = stopWaits.filter(x => ruled.has(x.id))
  if (goesOn.length) { stopWaits.splice(0, stopWaits.length, ...stopWaits.filter(x => !ruled.has(x.id))); log(`${goesOn.map(x => x.id).join(', ')}: ruled in time, the run goes on`) }
  for (const x of arr(ap.amended)) {
    const c = T.get(x.id)
    if (!c || done.has(x.id)) continue
    if (running.has(x.id)) {
      const what = [...arr(x.verification), ...arr(x.depends_on).map(d => `depends on ${d}`)].join('; ')
      late.set(x.id, [...(late.get(x.id) || []), { id: x.id, reason: `ruled during the run after ${x.id} started (${[...ruled].join(', ')}): ${what}` }])
      log(`${x.id}: amended by a ruling after its start (${what}): not applied to its work`)
      continue
    }
    c.verification = [...(c.verification || []), ...arr(x.verification)]
    c.depends_on = [...(c.depends_on || []), ...arr(x.depends_on)]
    if (arr(x.depends_on).some(d => fresh.has(d)) && pending.delete(x.id)) { deferred.push(x.id); heldBy.delete(x.id); startsWithout.delete(x.id) }
  }
  if (ap.rejected.length) stopOn(humanIssue(by, 'Rulings refused by apply during the run', refusedBy(ap.rejected)))
}

async function runTask(t, isolated) {
  try {
    log(`${t.id} starts (${isolated ? 'worktree' : 'main checkout'})`)
    // The task's model, as is; without a model in the plan, sonnet (0.10 and earlier)
    const workerModel = t.model || 'sonnet'
    // In a worktree, the clerk notes the start first: the worker itself would be refused the command (noteStart)
    if (isolated) await noteStart(t, workerModel)
    let r = await ask(pWorker(t, isolated, workerModel, startsWithout.get(t.id)), { label: `${t.id} · worker`, agentType: AG(isolated ? 'isolated-worker' : 'worker'), model: workerModel, schema: isolated ? REPORT_ISOLATED_S : REPORT_S, ...(isolated ? { isolation: 'worktree' } : {}), ...effort(t) })
    if (!isolated) noteProgress(t.id, 'worker', r)
    // Model of each attempt, in order: the worker, then each fix
    const models = [workerModel]
    let attempts = 1
    const trace = { flaky: [], rejections: [], unverifiable: [], unreadable: [], forbidden: [], issues: [], tried: [] }
    for (;;) {
      if (!r) return await closeTask(t, 'failed', attempts, null, ['worker without an answer (usage limit or API error)'], trace)
      if (r.status === 'blocked') return await closeTask(t, 'blocked', attempts, r, [r.blocker || 'blocked by the worker'], trace)
      let gaps = [], by = 'verification'
      const v = await ask(pVerif(t, r), { label: `${t.id} · verification`, agentType: AG('verifier'), model: 'sonnet', schema: VERIF_S })
      noteProgress(t.id, 'verification', v)
      if (v && (v.flaky || []).length) trace.flaky.push(...v.flaky)
      if (v && (v.uncommitted || []).length) log(`${t.id}: uncommitted in ${r.path}, outside the task's files: ${short(v.uncommitted.join(', '), 300)}`)
      // Commands refused by permissions: only the task's count as forbidden; another one is a failure
      // Progress command or scope check cited among the refused ones (authorization rule missing): neither a task command nor a failure
      const refused = ((v && v.forbidden) || []).filter(x => !(PROGRESS && String(x).includes(PROGRESS)) && !String(x).includes(`--scope ${t.id} --branch`))
      const unknown = refused.filter(x => !(t.verification || []).some(c => sameCommand(c, x, r.path)))
      trace.forbidden = [...new Set([...trace.forbidden, ...(t.verification || []).filter(c => refused.some(x => sameCommand(c, x, r.path)))])]
      // Scope of the branch (0.19.0): the verifier's copy of plan-lint --scope, checked against its digest. When it does not match
      // and the verification passes, a second reading by the plan-reader; unfaithful again, a blind spot, never a rejection
      let scope = v ? scopeOf(v.scope, t, r) : null
      trace.scopeUnread = null
      if (v && !scope && v.ok && !unknown.length) {
        log(`${t.id}: copy of plan-lint --scope that does not match its digest; second reading`)
        scope = scopeOf(await ask(pScope(t, r), { label: `${t.id} · scope · second reading`, agentType: AG('plan-reader'), model: 'haiku', schema: SCOPE_S }), t, r)
        if (!scope) {
          trace.scopeUnread = `scope of ${t.id} not checked: two copies of plan-lint --scope that do not match its digest (verifier, plan-reader); the files outside owned_files and the tests removed or skipped were left to the evaluator, from the diff`
          log(`${t.id}: ${trace.scopeUnread}`)
        }
      }
      const outside = scope ? arr(scope.outside) : []
      if (!v) gaps = ['verifier without an answer']
      else if (!v.ok || unknown.length || outside.length) gaps = [...(v.failures || []).map(e => `${e.command}: ${e.excerpt || 'failure'}`), ...unknown.map(x => `${x}: refused according to the verifier, but it is not a verification command of the task`), ...(outside.length ? [`files changed outside owned_files: ${outside.join(', ')}`] : [])]
      // No command allowed: nothing proves the task, and a fix would change nothing
      else if ((t.verification || []).length && (t.verification || []).every(c => trace.forbidden.includes(c))) return await closeTask(t, 'blocked', attempts, r, [`no verification command allowed to the agents: ${trace.forbidden.join('; ')}`], trace)
      else {
        by = 'evaluation'
        const facts = { ...v, forbidden: trace.forbidden }
        // The survivors of the challenger that an earlier attempt was rejected for: the evaluator weighs the fix's answer to them
        const challenged = trace.rejections.filter(x => x.by === 'challenge').flatMap(x => x.gaps)
        let e = await ask(pEval(t, r, facts, scope, null, challenged), { label: `${t.id} · evaluation`, agentType: AG('evaluator'), model: 'opus', schema: EVAL_S })
        noteProgress(t.id, 'evaluation', e)
        // Proof contract (0.19.0): a pass without valid proofs is sent back once, with the reason; invalid again, it counts as an
        // evaluation without an answer
        const refusal = e && proofsRefused(e, v, r.path)
        let invalid = null
        if (refusal) {
          log(`${t.id}: pass refused, ${refusal}; evaluation sent back`)
          const again = await ask(pEval(t, r, facts, scope, refusal, challenged), { label: `${t.id} · evaluation · proofs`, agentType: AG('evaluator'), model: 'opus', schema: EVAL_S })
          invalid = again && proofsRefused(again, v, r.path)
          e = invalid ? null : again
        }
        // A file unreadable once stays so: accumulated from one evaluation to the next
        if (e) { trace.unverifiable = e.unverifiable || []; trace.unreadable = [...new Set([...trace.unreadable, ...(e.unreadable || [])])] }
        if (!e) gaps = [invalid ? `evaluator without an answer: pass refused twice, ${invalid}` : 'evaluator without an answer']
        else if (e.verdict === 'fail') gaps = e.gaps && e.gaps.length ? e.gaps : ['verdict fail without detail']
        // Challenge (0.22.0): only a task marked challenge: true, only after a pass; a mutation not detected rejects the attempt
        else if (t.challenge === true) { const survivors = await challenge(t, r, trace); if (survivors.length) { by = 'challenge'; gaps = survivors } }
      }
      if (!gaps.length) break
      if (attempts > MAXFIX) return await closeTask(t, 'blocked', attempts, r, gaps, trace)
      const attemptRejection = { attempt: attempts, by, gaps }
      trace.rejections.push(attemptRejection)
      const choice = await chooseModel(t, attemptRejection, models, trace.rejections.slice(0, -1))
      // Every choice to the log, model change or not: a choice raised to the floor, equal to the previous attempt, has no other trace
      log(`${t.id}: fix ${attempts} on ${choice.model}${choice.change ? ` (instead of ${choice.change.from})` : ''}: ${choice.reason}`)
      const c = await ask(pFix(t, r, gaps, attemptRejection, choice), { label: `${t.id} · fix ${attempts}`, agentType: AG('worker'), model: choice.model, schema: REPORT_S, ...effort(t) })
      noteProgress(t.id, 'fix', c)
      models.push(choice.model)
      attempts++
      // Fix without an answer: we keep the report of the earlier attempts (deviations, reviews, branch)
      if (!c) return await closeTask(t, 'failed', attempts, r, ['fix without an answer (usage limit or API error)'], trace)
      r = accumulate(r, c)
    }
    // Post-merge check: the first verification command the agents are allowed to run
    const check = (t.verification || []).find(c => !trace.forbidden.includes(c)) || 'none'
    // An integrator that was launched and returned no verdict (no answer, an error, the circuit breaker at that call) may have
    // merged: the task comes out in merged_unclosed with merge: 'unknown' (0.19.0, whatever happens after it since 0.22.1: the
    // breaker at a later call of the task, or no breaker at all), besides interrupted if the breaker tripped. Not when the
    // breaker had latched before the call: no integrator was launched, the merge did not run
    let launched = false
    const i = await exclusive(() => { launched = !breaker; return ask(pMerge(t, r, isolated, check), { label: `${t.id} · merge`, agentType: AG('integrator'), model: 'sonnet', schema: INTEG_S }) })
      .catch(err => { if (launched) unclosedOf(t, r, trace, reviewsOf(r, trace), [], true); throw err })
    noteProgress(t.id, 'merge', i)
    if (!i) { unclosedOf(t, r, trace, reviewsOf(r, trace), [], true); return await closeTask(t, 'blocked', attempts, r, ['integrator without an answer'], trace) }
    if (!(i.merged ?? i.ok)) return await closeTask(t, 'blocked', attempts, r, [`merge: ${i.detail || 'failure'}`], trace)
    if (isolated && i.worktree_kept) {
      trace.kept = [`worktree ${r.path} kept after the merge of ${t.id} (${short(i.worktree_kept, 200)}): what it holds uncommitted is not in ${INTEG}; look at it, then remove it`]
      log(`${t.id}: worktree ${r.path} kept, uncommitted work`)
    }
    // Check skipped (0.19.0): only for a task of the main checkout, whose merged tree is the one its verifier checked in the
    // same folder. In a worktree, the folder is not the verifier's: a skipped check there is a check not done
    const skipped = i.check_skipped === true, notRun = skipped && isolated
    if (notRun || !(i.check_ok ?? i.ok)) {
      // Merge done but check failed or not run: the task stays merged and the run stops for a human
      const detail = notRun ? `post-merge check not run on ${INTEG} (${check}): skipped by the integrator for a task in a worktree, whose folder is not the verifier's` : `${setupOf(t).length ? 'setup or ' : ''}post-merge check failed on ${INTEG} (${check}): ${i.detail || 'failure'}`
      trace.entries = [{ type: 'needs-human', severity: 'major', description: detail }]
      stopOn({ task: t.id, title: `Post-merge check failed after ${t.id}`, context: detail, human: true, options: [{ id: 'repair', description: `Repair on ${INTEG}, replay the verifications, then rerun the phase`, impact: '', recommended: true }, { id: 'stop', description: 'Stop the plan here', impact: '', recommended: false }] }, trace.issues)
    } else if (skipped) log(`${t.id}: post-merge check skipped, same tree as the verified branch`)
    return await closeTask(t, 'merged', attempts, r, [], trace)
  } catch (err) {
    // Circuit breaker: the task stops without a close; its status and branch do not move, run-end clears its step
    if (err === INTERRUPT) { log(`${t.id}: interrupted, agents not answering`); return { id: t.id, interrupted: true } }
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
const depsDone = t => deps(t).every(d => done.has(d)) && !amended.has(t.id)
const ready = t => depsDone(t) && !(t.resources || []).some(r => locks.has(r)) && !locks.has('checkout')
// Answering during the run (0.21.0): apply takes the lock of the main checkout, so no task starts while it runs and it waits for a
// task of the main checkout to end. A held task waits once its dependencies are done and no apply runs (it may settle its issue:
// the task then starts without a wait), without a lock nor a place among the tasks in parallel; a task whose wait ended on a
// ruling starts after the apply. A stopped run starts no wait nor apply, but lets those in flight end: a wait left behind would
// note its task waiting again after the run end
const startApply = () => { locks.add('checkout'); applying = runApply().finally(() => { locks.delete('checkout'); applying = null }) }
const startWait = t => waitJobs.set(t.id, waitFor(t).finally(() => waitJobs.delete(t.id)))
// Mode deviation (0.21.0, D3): while an issue waits for its ruling, no task nor wait of a held task starts; once no task runs and
// no apply either, one wait per task that raised such issues. An issue waits twice at most (again after an apply that did not
// settle it), then stops the run
const startStopWaits = () => {
  for (const x of stopWaits.filter(x => x.waits >= 2)) { stopWaits.splice(stopWaits.indexOf(x), 1); stopOn(x.p) }
  if (stop) return
  for (const task of new Set(stopWaits.map(x => x.p.task))) {
    if (stopJobs.has(task)) continue
    const mine = stopWaits.filter(x => x.p.task === task)
    mine.forEach(x => { x.waits++ })
    stopJobs.set(task, waitForStop(task, mine.map(x => x.id)).finally(() => stopJobs.delete(task)))
  }
}
while (pending.size || running.size || applying || stopJobs.size || ((applyWanted || stopWaits.length) && !stop && !breaker)) {
  if (!stop && !breaker) {
    if (applyWanted && !applying && !locks.has('checkout')) startApply()
    if (stopWaits.length) { if (!running.size && !applying) startStopWaits() }
    else for (const t of [...pending.values()]) {
      if (waitJobs.has(t.id) || !depsDone(t)) continue
      if (heldBy.has(t.id)) { if (!applying) startWait(t); continue }
      if (running.size >= PAR || !ready(t)) continue
      const others = [...pending.values(), ...[...running.keys()].map(id => T.get(id))].filter(o => o.id !== t.id)
      // Worktree only if another task can run at the same time: never with a parallelism of 1
      const isolated = PAR > 1 && (running.size > 0 || others.some(o => canOverlap(o, t)))
      const taken = [...(t.resources || []), ...(isolated ? [] : ['checkout'])]
      taken.forEach(x => locks.add(x))
      pending.delete(t.id)
      running.set(t.id, runTask(t, isolated).then(res => {
        if (res.interrupted) interrupted.push(t.id)
        else results.push(res)
        if (res.status === 'merged') done.add(t.id)
        taken.forEach(x => locks.delete(x))
        running.delete(t.id)
      }))
    }
  }
  const live = [...running.values(), ...waitJobs.values(), ...stopJobs.values(), ...(applying ? [applying] : [])]
  if (!live.length) break
  await Promise.race(live)
}
// Mode deviation: an issue still without its ruling when the run ends (stopped meanwhile, circuit breaker) stops it, as before
for (const x of stopWaits.splice(0)) stopOn(x.p)

phase('Wrap-up')
const failed = results.filter(r => r.status !== 'merged')
const summary = {
  phase: PHASE, mode: MODE, tasks: results, not_started: [...pending.keys()], deferred,
  added_tasks: added.map(x => ({ id: x.id, phase: x.phase, title: x.title })),
  reviews: results.flatMap(x => (x.reviews || []).map(d => ({ task: x.id, review: d }))),
  auto_decisions: autoDecisions, discarded_amendments: discardedRun, open_issues: issues, rulings_applied: rulingsApplied, waiting, waiting_on_prerequisites: waitingOnPrerequisites,
  // Outside the circuit breaker too (0.22.1): a task whose integrator returned no verdict, for the pilot to look for its commit
  ...(mergedUnclosed.length ? { merged_unclosed: mergedUnclosed } : {}),
}
// Circuit breaker: error, whatever else happened. The interrupted tasks are in "interrupted", outside what run-end reads; the
// issue that stopped the run before, if any, stays (forget took out those of the interrupted closes). The tasks interrupted after
// their merge, or at their merge call, are also in "merged_unclosed" (0.19.0), with what their close did not record
if (breaker) {
  const known = mergedUnclosed.filter(x => !x.merge).map(x => x.id), unknown = mergedUnclosed.filter(x => x.merge).map(x => x.id)
  const unrecorded = (known.length ? ` ${known.join(', ')} merged before the trip: their deviations were not recorded, see merged_unclosed.` : '') + (unknown.length ? ` ${unknown.join(', ')} interrupted at their merge, which may have run: see merged_unclosed.` : '')
  return await finish({ status: 'error', ...summary, ...(stop ? { stop_issue: stop } : {}), interrupted, merged_unclosed: mergedUnclosed, detail: `agents not answering: ${breaker.length} calls in a row without an answer (${breaker.join(', ')}). Login expired, usage limit or network. ${interrupted.join(', ')} interrupted, their branches kept. Launch a new run once claude answers again.${unrecorded}` })
}
if (stop) return await finish({ status: 'awaiting-ruling', stop_issue: stop, ...summary })
if (failed.length || pending.size || waiting.length || waitingOnPrerequisites.length) return await finish({ status: 'partial', ...summary })
// Initial tasks all merged, but tasks added to this phase or deferred: rerun the phase
return await finish({ status: deferred.length || added.some(x => x.phase === PHASE) ? 'rerun' : 'finished', ...summary })
