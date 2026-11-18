#!/usr/bin/env node
// progress (orchestre plugin 0.12.0): sole writer of plans/<name>/progress.json (format orchestre-progress/4 since 0.20.0) and
// of its view PROGRESS.md, and of the issue register plans/<name>/ISSUES.json (format orchestre-issues/1, tracked by git).
// Node 18 or later, no dependencies. Schemas: SCHEMA and REGISTER_SCHEMA below.
// A progress.json in /3 (0.12 to 0.19) is read and converted in memory, its issues without their actions (settled by a free
// answer); a progress.json in a format of orchestre 0.11 and earlier (orchestre-suivi/2 or /1, French keys and values) too.
// The first write turns it into /4. scripts/migrate.mjs converts the formats of 0.11 the same way (convertLegacy).
//
// Usage: node <plugin root>/scripts/progress.mjs <command> [<plan-dir>] [options]
// Writes read a JSON object on standard input, or in the option --json '<object>'. The workflow gives its agents a heredoc
// whose delimiter is quoted (0.18.0): --json '…' needed \u escapes for ' ` $, which the Bash tool of Claude Code decodes
// before the shell reads the command. Without a folder, the only plan in plans/.
//   run-start  { phase, mode, parallelism, max_fixes, max_auto_decisions, run_id? }
//              once per run, by its first agent: rereads the plan (plan-lint), turns a run left in progress into "interrupted"
//   step       { task, step, isolated?, rejection?, model?, change? }      step: worker, verification, evaluation, fix, merge,
//              replanning, progress; worker resets the task's run fields; fix adds rejection { attempt, by, gaps };
//              model: the model launched (worker, fix), noted in model_used; change { from, to, reason }: "model" event
//   close      { task, status, attempts, branch, actual_tokens?, rejections?, flaky?, unverifiable?, blocker?, reviews?,
//                auto_decisions?, issues?, added_tasks?, amendments?, replanning?, entries?, discarded_amendments? }
//              (0.20.0) writes and commits the plan, on the integration branch only (refused elsewhere, nothing written):
//              HANDOFF.md under "## <task>" (entries word for word, then the blocker, the rejections, the unverifiable criteria,
//              the flaky tests, the automatic decisions, the amendments, the amendments discarded and what is rejected), the task
//              files of added_tasks that carry their content, the amendments appended to the frontmatter lists, plan-lint on the
//              result (a task created or amended that it refuses is put back and comes out in "rejected"), ISSUES.json with the
//              dry run of each option of each issue (an issue with auto: <option> is settled by auto and its option applied),
//              progress.json and PROGRESS.md; then one commit "progress(<task>): <status>" of these files and of DISCOVERY.md
//              when it changed. Prints one line of JSON: { task, status, commit, rejected, discarded, issues, pending, message,
//              digest }. A task added that shares files with a task of its phase depends on it (noted "amendment · minor").
//              An automatic decision whose option cites a path that neither exists nor is owned by a task this close adds is
//              rejected: its issue stays open, nothing of its option is written, "needs-human · major · inconsistent
//              auto-decision: <path> …" in HANDOFF.md and an item in "rejected". Run twice, it records no issue again: an
//              issue of this run with the same task and title keeps its id
//              (plan-lint, the dry run and the plan's files outside .progress.lock; under it, progress.json, ISSUES.json, the commit:
//              a slow pre-commit hook makes the other progress commands wait, and refuse after 20 s)
//   ruling     { task, title, option, added_tasks?, amendments?, discarded_amendments? }      regenerates PROGRESS.md
//   rule       { issue, option } or { issue, text }, or { items: [ that object, … ] } (0.20.0, decision D1): the user's ruling on
//              an open issue, recorded in progress.json (pending_rulings) and nowhere else, until apply reports it into the plan;
//              refused for an unknown or settled issue, an issue that already has a ruling recorded, an option absent or
//              invalid (the dry run, or an issue inherited from /3); a list is applied whole or not at all
//   unrule     { issue }, or { items: [ … ] } (0.20.0): removes a ruling recorded and not applied yet; refused once applied
//   apply      no input (0.20.0, decision D1): applies the rulings of pending_rulings to the plan and commits them, on the
//              integration branch only (refused elsewhere, nothing written); without a ruling recorded, writes nothing.
//              An option: its HANDOFF entries, added tasks and amendments, as close applies an automatic decision; a task it
//              adds that shares files with a task of its phase, without a dependency (plan-lint's overlaps), depends on it
//              (noted in HANDOFF.md); a task it adds in a phase earlier than that of the run in progress (or of the last run)
//              joins that phase (noted in HANDOFF.md); an option plan-lint still refuses is put back, its issue open again and
//              the option invalid with the reason. A text: one decision entry. A ruling withdrawn or changed while apply runs
//              refuses the whole apply (code 1, every file put back). HANDOFF.md ("decision · major · <title>: option <id>
//              settled by the user — …"), the task files, ISSUES.json (issue settled, ruling with author user) and PROGRESS.md
//              in one commit "progress: rulings <ids>"; progress.json: the copies settled, the rulings out of pending_rulings.
//              Prints one line of JSON: { applied, rejected, discarded, amended: [{ id, verification, depends_on }],
//              added_tasks, commit, message, digest }
//   run-end    the workflow's return value (status, detail, stop_issue, open_issues, tasks…);
//              closes, from the summary, the tasks left without a close (workflow exception) and then regenerates PROGRESS.md;
//              rulings_applied and discarded_amendments of the summary are added to those of the run, never in their place
//   pilot      { task, status: "merged" | "cancelled", reason? }      pilot's manual action; regenerates PROGRESS.md
//   ack        { kind: "review" | "decision", task, text }, or { items: [ that object, … ] }      a review before the PR or an
//              auto-decision marked done (0.15.1, /orchestre:done; a list in one write and the /progress pane since 0.16.0):
//              its "done" date is set, it leaves "Your turn"; task null for the source plan; text: the review's text, or
//              the decision's title (exact, otherwise a unique start); a list is applied whole or not at all
//   ticket     same object (0.16.0): moved to the tickets to open after the PR; its "ticket" date is set, it leaves "Your turn"
//   reopen     same object (0.16.0, Undo of the /progress pane): a review or an auto-decision done or moved to tickets is open
//              again; its "done" and "ticket" dates are removed
//   relabel    { kind, task, text, label } (0.16.0): the text shown for it ("label"); text stays the key that ties it to
//              HANDOFF.md and to the closes, so the next run does not bring the original back; label null or "": the original
//   close-plan {} (0.16.1, [ Close the plan ] of /progress): the plan is closed, its "closed" date set; refused while a run
//              is in progress or a task is neither merged nor cancelled. The /progress mod no longer follows it on its own.
//              The reviews and auto-decisions left open stay so, in the PR draft
//   reopen-plan {} (0.16.1, [ Reopen ]): open again; a run-start opens it again too
//   view [--stdout]        regenerates PROGRESS.md (or prints it without writing anything); statuses reread from PROGRESS.md
//                          and git, as run-start
//   status                 progress as compact Markdown, like /orchestre:status; read-only, always code 0
//   triage [<plan-dir>]    end-of-run sorting of the open reviews and auto-decisions, as JSON { plan, base, integration, safe, open };
//                          read-only. safe: what the pilot closes alone (decision D6), in the input format of ack ({ items: safe }),
//                          each with its reason: duplicate, superseded, no-diff or worktree-gone; open: the rest, grouped by task
//   validate [--file <f>]  validates progress.json against the schema, and ISSUES.json when the plan has one; --file: that
//                          file only, a progress.json or a register (by its format)
// _digest (0.20.0): a write whose JSON carries "_digest" is checked against payloadDigest, and refused when they differ
// (code 1, "payload altered in transit", nothing written); a JSON without it (the pilot, the pane) is accepted as before.
// Exit codes: 0 done; 1 write refused, progress.json and PROGRESS.md unchanged; 2 invalid call.
//
// Guarantees: lock plans/<name>/.progress.lock (8 tasks at most in parallel; never removed while its process runs, a writer
// waits and refuses after 20 s); write to .progress.<pid>.tmp then rename;
// validation of each write; files always in the main checkout, even when called from a worktree;
// progress.json, .progress.lock and .progress.*.tmp added to .git/info/exclude if not already ignored.
// progress.json absent: rebuilt from PROGRESS.md, HANDOFF.md and plan-lint; the run fields start empty again.
// ISSUES.json absent: an empty register. A write that changes it validates it and writes it under the same lock.
import { readFileSync, writeFileSync, existsSync, readdirSync, openSync, closeSync, writeSync, renameSync, unlinkSync, statSync, mkdirSync, appendFileSync, realpathSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, relative, dirname, basename, isAbsolute, sep } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

export const FORMAT = 'orchestre-progress/4'
// The format of 0.12 to 0.19: read, then converted (convertV3); its issues have no actions
export const PREVIOUS_FORMAT = 'orchestre-progress/3'
// Formats of orchestre 0.11 and earlier, in French: read, then converted (convertLegacy)
export const LEGACY_FORMATS = ['orchestre-suivi/2', 'orchestre-suivi/1']
// The issue register (0.20.0, decision DO3): tracked by git, written by this script alone
export const REGISTER = 'ISSUES.json'
export const REGISTER_FORMAT = 'orchestre-issues/1'
const STATUSES = ['todo', 'added', 'merged', 'blocked', 'failed', 'needs-human', 'cancelled']
const STEPS = ['worker', 'verification', 'evaluation', 'fix', 'merge', 'replanning', 'progress']
const RUN_ENDS = ['finished', 'partial', 'awaiting-ruling', 'rerun', 'error']
const CLOSES = ['merged', 'blocked', 'failed', 'needs-human']
const KINDS = ['run', 'task', 'step', 'rejection', 'status', 'added', 'amendment', 'review', 'auto-decision', 'issue', 'ruling', 'pilot', 'error', 'model']
export const LOG_MAX = 200
const RE_ID = /^[A-Z]+[0-9]+[A-Z]*$/
// An issue: <task>-<n>, stable (0.20.0)
const RE_ISSUE = /^[A-Z]+[0-9]+[A-Z]*-[1-9][0-9]*$/
const DONE = s => s === 'merged' || s === 'cancelled'
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
const HERE = dirname(fileURLToPath(import.meta.url))
const LINT = join(HERE, 'plan-lint.mjs')
const MIGRATE = join(HERE, 'migrate.mjs')
// Merge commit and task branch, in English (0.12) or in French (0.11 and earlier): git history is never rewritten
const MERGE = /^(?:task (\S+):|tâche (\S+) :)/

// French values of orchestre 0.11 and earlier → English (glossary 0.12.0), shared with migrate.mjs
export const LEGACY = {
  status: { 'à-faire': 'todo', 'en-cours': 'in-progress', ajoutée: 'added', fusionnée: 'merged', bloquée: 'blocked', échec: 'failed', 'besoin-humain': 'needs-human', annulée: 'cancelled' },
  step: { worker: 'worker', vérification: 'verification', évaluation: 'evaluation', correction: 'fix', fusion: 'merge', replanification: 'replanning', suivi: 'progress' },
  runStatus: { 'en-cours': 'in-progress', terminé: 'finished', partiel: 'partial', arbitrage: 'awaiting-ruling', 'à-relancer': 'rerun', erreur: 'error', interrompu: 'interrupted' },
  mode: { auto: 'auto', devia: 'deviation', phase: 'phase' },
  by: { vérification: 'verification', évaluation: 'evaluation' },
  role: { arret: 'stop', 'a-trancher': 'open' },
  issueStatus: { ouvert: 'open', tranché: 'settled' },
  kind: { run: 'run', tache: 'task', etape: 'step', refus: 'rejection', statut: 'status', ajout: 'added', amendement: 'amendment', relecture: 'review', 'decision-office': 'auto-decision', point: 'issue', arbitrage: 'ruling', pilote: 'pilot', erreur: 'error', modele: 'model' },
  prerequisiteType: { décision: 'decision', geste: 'manual', environnement: 'environment' },
  prerequisiteStatus: { ouvert: 'open', fait: 'done', abandonné: 'dropped' },
  handoffType: { écart: 'deviation', 'angle-mort': 'blind-spot', décision: 'decision', dette: 'debt', 'besoin-humain': 'needs-human', ticket: 'ticket', relecture: 'review', refus: 'rejection', amendement: 'amendment', blocage: 'blocker' },
  severity: { mineur: 'minor', majeur: 'major' },
  section: { 'plan source': 'source plan', '(avant les sections)': '(before the sections)' },
  actualTokens: { 'voir /workflows': 'see /workflows' },
  // Plan files (migrate.mjs); plan-lint keeps its own copy of the two key maps, to name them in its errors
  taskKeys: { titre: 'title', modele: 'model', raison_modele: 'model_reason', depend_de: 'depends_on', lot_parallele: 'parallel_batch', fichiers_possedes: 'owned_files', ressources: 'resources', prerequis: 'prerequisites', budget_contexte: 'context_budget', estimation_tokens: 'token_estimate', max_tours: 'max_turns', definition_du_fini: 'definition_of_done' },
  configKeys: { parallelisme_max: 'max_parallelism', mode_par_defaut: 'default_mode', branche_integration: 'integration_branch', branche_base: 'base_branch', evaluateur: 'evaluator', corrections_max: 'max_fixes', escalade: 'escalation', decisions_office_max: 'max_auto_decisions', plafond_session_pilote: 'pilot_context_cap', preparation: 'setup', preparation_partagee: 'shared_setup' },
  evaluator: { systematique: 'always', systématique: 'always' },
  taskSections: { 'Prompt de lancement': 'Launch prompt', 'Contexte utile': 'Useful context', 'Détail de réalisation': 'Implementation notes', 'Hors périmètre': 'Out of scope' },
  progressColumns: { id: 'ID', titre: 'Title', phase: 'Phase', lot: 'Batch', 'dépend de': 'Depends on', modèle: 'Model', statut: 'Status', essais: 'Attempts', branche: 'Branch', 'tokens est. / réels': 'Tokens est. / actual' },
  prerequisiteColumns: { id: 'ID', type: 'Type', prérequis: 'Prerequisite', statut: 'Status', preuve: 'Evidence' },
  discoverySections: { 'Contexte existant': 'Existing context', 'Commandes vérifiées': 'Verified commands', 'Carte rapide': 'Quick map', 'Conventions constatées': 'Observed conventions', 'Pièges et solutions': 'Pitfalls and fixes', 'Recommandations de contexte (fin de run)': 'Context recommendations (end of run)', 'Recommandations de contexte': 'Context recommendations' },
}

class Refusal extends Error { constructor(m) { super(m); this.code = 1 } }
class UsageError extends Error { constructor(m) { super(m); this.code = 2 } }
const refuse = m => { throw new Refusal(m) }
const attempt = f => { try { return f() } catch { return null } }
const readOrNull = f => attempt(() => readFileSync(f, 'utf8'))
const git = (args, cwd) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const real = p => attempt(() => realpathSync(p)) || resolve(p)
const clip = (s, n = 140) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const width = s => [...s].length
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')

// ISO 8601 date with the machine's time zone, to the second: 2026-10-05T10:16:00+02:00
export function now(d = new Date()) {
  const p = n => String(n).padStart(2, '0'), o = -d.getTimezoneOffset(), a = Math.abs(o)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${o >= 0 ? '+' : '-'}${p(Math.floor(a / 60))}:${p(a % 60)}`
}

// ─── Schema orchestre-progress/4, without the descriptions ──────────────────────────────────────────────────────────
// /4 (0.20.0) is /3 plus: an id for each issue; for each option, valid and invalid_reason (the dry run), effect and amends;
// without_actions on an issue inherited from /3; pending_rulings, the rulings recorded by rule and not applied yet (D1)
const ref = n => ({ $ref: `#/$defs/${n}` })
const arrayOf = items => ({ type: 'array', items })
const object = (required, properties, extra = {}) => ({ type: 'object', additionalProperties: false, required, properties, ...extra })
const INT1 = { type: 'integer', minimum: 1 }
const TEXT1 = { type: 'string', minLength: 1 }
export const SCHEMA = {
  ...object(['format', 'plan', 'dir', 'integration', 'base', 'updated', 'tasks', 'runs', 'issues', 'pending_rulings', 'auto_decisions', 'reviews', 'prerequisites', 'handoff', 'lint', 'log', 'log_omitted'], {
    format: { const: FORMAT },
    plan: { type: 'string', minLength: 1 },
    dir: { type: 'string', minLength: 1 },
    integration: { type: 'string', minLength: 1 },
    base: { type: ['string', 'null'] },
    updated: ref('date'),
    tasks: arrayOf(ref('task')),
    runs: arrayOf(ref('run')),
    issues: arrayOf(ref('issue')),
    pending_rulings: arrayOf(object(['issue', 'option', 'text', 'at'], { issue: ref('issueId'), option: { type: ['string', 'null'], minLength: 1 }, text: { type: ['string', 'null'], minLength: 1 }, at: ref('date') })),
    auto_decisions: arrayOf(ref('autoDecision')),
    reviews: arrayOf(ref('review')),
    prerequisites: arrayOf(ref('prerequisite')),
    handoff: { type: 'object', additionalProperties: { type: 'object', additionalProperties: ref('count') } },
    lint: object(['ok', 'errors'], { ok: { type: 'boolean' }, errors: arrayOf({ type: 'string' }) }),
    log: { type: 'array', maxItems: LOG_MAX, items: ref('event') },
    log_omitted: { type: 'integer', minimum: 0 },
    closed: ref('date'),
  }),
  $defs: {
    date: { type: 'string', format: 'date-time' },
    dateOrNull: { oneOf: [ref('date'), { type: 'null' }] },
    taskId: { type: 'string', pattern: '^[A-Z]+[0-9]+[A-Z]*$' },
    issueId: { type: 'string', pattern: RE_ISSUE.source },
    texts: arrayOf({ type: 'string' }),
    ids: arrayOf(ref('taskId')),
    count: object(['minor', 'major'], { minor: { type: 'integer', minimum: 0 }, major: { type: 'integer', minimum: 0 } }),
    task: object(['id', 'title', 'phase', 'batch', 'depends_on', 'model', 'model_used', 'status', 'attempts', 'branch', 'token_estimate', 'actual_tokens', 'added_by', 'step', 'isolated', 'start', 'end', 'waiting', 'rejections', 'flaky', 'unverifiable', 'blocker'], {
      id: ref('taskId'),
      title: { type: 'string', minLength: 1 },
      phase: INT1,
      batch: { type: ['string', 'null'] },
      depends_on: ref('ids'),
      model: { type: ['string', 'null'], minLength: 1 },
      model_used: { type: ['string', 'null'], minLength: 1 },
      status: { enum: STATUSES },
      attempts: { type: 'integer', minimum: 0 },
      branch: { type: ['string', 'null'] },
      token_estimate: { type: ['number', 'null'], minimum: 0 },
      actual_tokens: { type: ['string', 'null'] },
      added_by: { oneOf: [ref('taskId'), { type: 'null' }] },
      step: { enum: [...STEPS, null] },
      isolated: { type: ['boolean', 'null'] },
      start: ref('dateOrNull'),
      end: ref('dateOrNull'),
      waiting: arrayOf({ type: 'string', minLength: 1 }),
      rejections: arrayOf(object(['attempt', 'by', 'gaps'], { attempt: INT1, by: { enum: ['verification', 'evaluation'] }, gaps: ref('texts') })),
      flaky: ref('texts'),
      unverifiable: ref('texts'),
      blocker: ref('texts'),
    }),
    run: object(['number', 'run_id', 'phase', 'mode', 'parallelism', 'max_fixes', 'max_auto_decisions', 'status', 'start', 'end', 'detail', 'rulings_applied', 'discarded_amendments', 'added_tasks', 'deferred', 'not_started', 'waiting', 'waiting_on_prerequisites'], {
      number: INT1,
      run_id: { type: ['string', 'null'] },
      phase: INT1,
      mode: { enum: ['auto', 'deviation', 'phase'] },
      parallelism: { type: 'integer', minimum: 1, maximum: 8 },
      max_fixes: { type: 'integer', minimum: 0 },
      max_auto_decisions: { type: 'integer', minimum: 0 },
      status: { enum: ['in-progress', ...RUN_ENDS, 'interrupted'] },
      start: ref('date'),
      end: ref('dateOrNull'),
      detail: { type: ['string', 'null'] },
      rulings_applied: arrayOf(object(['task', 'title', 'option'], { task: ref('taskId'), title: { type: 'string' }, option: { type: 'string' } })),
      discarded_amendments: arrayOf(object(['task', 'id', 'reason'], { task: ref('taskId'), id: ref('taskId'), reason: { type: 'string' } })),
      added_tasks: arrayOf(object(['id', 'phase', 'title'], { id: ref('taskId'), phase: INT1, title: { type: 'string' } })),
      deferred: ref('ids'),
      not_started: ref('ids'),
      waiting: ref('ids'),
      waiting_on_prerequisites: arrayOf(object(['id', 'prerequisites'], { id: ref('taskId'), prerequisites: arrayOf({ type: 'string' }) })),
    }),
    // The short copy of an issue, for display; the whole issue, with the actions of its options, is in ISSUES.json
    issue: object(['id', 'run', 'task', 'title', 'context', 'human', 'role', 'status', 'chosen_option', 'options'], {
      id: ref('issueId'),
      run: INT1,
      task: ref('taskId'),
      title: { type: 'string', minLength: 1 },
      context: { type: 'string' },
      human: { type: 'boolean' },
      role: { enum: ['stop', 'open'] },
      status: { enum: ['open', 'settled'] },
      chosen_option: { type: ['string', 'null'] },
      circuit_breaker: { type: 'boolean' },
      inconsistency: { type: 'string' },
      without_actions: { type: 'boolean' },
      options: arrayOf(object(['id', 'description', 'valid', 'invalid_reason', 'effect', 'amends'], {
        id: TEXT1, description: { type: 'string' }, impact: { type: 'string' }, recommended: { type: 'boolean' },
        // valid: null until a dry run decides it
        valid: { type: ['boolean', 'null'] }, invalid_reason: { type: ['string', 'null'] }, effect: { type: 'string' }, amends: ref('ids'),
      })),
    }),
    autoDecision: object(['run', 'task', 'title', 'option', 'description'], { run: INT1, task: ref('taskId'), title: { type: 'string' }, option: { type: 'string' }, description: { type: 'string' }, done: ref('date'), ticket: ref('date'), label: { type: 'string', minLength: 1 } }),
    review: object(['task', 'phase', 'text', 'run', 'at'], {
      task: { oneOf: [ref('taskId'), { type: 'null' }] },
      phase: { type: ['integer', 'null'], minimum: 1 },
      text: { type: 'string', minLength: 1 },
      run: { type: ['integer', 'null'], minimum: 1 },
      at: ref('dateOrNull'),
      done: ref('date'),
      ticket: ref('date'),
      label: { type: 'string', minLength: 1 },
    }),
    // evidence and how (0.17.0): the Evidence column and the steps of "## <ID> · how", optional in the contract
    prerequisite: object(['id', 'type', 'status', 'text', 'blocks'], { id: ref('taskId'), type: { type: 'string' }, status: { type: 'string' }, text: { type: 'string' }, evidence: { type: 'string' }, how: arrayOf({ type: 'string' }), blocks: ref('ids') }),
    event: object(['at', 'kind', 'task', 'text'], {
      at: ref('date'),
      kind: { enum: KINDS },
      task: { oneOf: [ref('taskId'), { type: 'null' }] },
      text: { type: 'string', minLength: 1 },
    }),
  },
}

// Hand-written validation: the subset of JSON Schema that SCHEMA uses
const RE_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const describe = x => (x === undefined ? 'nothing' : typeof x === 'string' ? `"${clip(x, 40)}"` : clip(JSON.stringify(x), 40))
const isOfType = (t, x) => ({ null: x === null, boolean: typeof x === 'boolean', string: typeof x === 'string', integer: Number.isInteger(x), number: typeof x === 'number' && Number.isFinite(x), array: Array.isArray(x), object: !!x && typeof x === 'object' && !Array.isArray(x) })[t]
// root: the schema whose $defs the references name (SCHEMA or REGISTER_SCHEMA)
function check(s, x, at, err, root = SCHEMA) {
  if (s.$ref) s = root.$defs[s.$ref.split('/').pop()]
  if (s.oneOf) {
    if (s.oneOf.filter(o => { const e = []; check(o, x, at, e, root); return !e.length }).length !== 1) err.push(`${at}: ${describe(x)} matches no allowed form`)
    return
  }
  if ('const' in s && x !== s.const) return err.push(`${at}: ${describe(x)} instead of "${s.const}"`)
  if (s.enum && !s.enum.includes(x)) return err.push(`${at}: ${describe(x)} is not allowed (${s.enum.map(e => e ?? 'null').join(', ')})`)
  if (s.type && ![].concat(s.type).some(t => isOfType(t, x))) return err.push(`${at}: ${[].concat(s.type).join(' or ')} expected, ${describe(x)} received`)
  if (typeof x === 'string') {
    if (s.minLength && width(x) < s.minLength) err.push(`${at}: empty text`)
    if (s.pattern && !new RegExp(s.pattern).test(x)) err.push(`${at}: ${describe(x)} does not follow the pattern ${s.pattern}`)
    if (s.format === 'date-time' && !(RE_DATE.test(x) && !Number.isNaN(Date.parse(x)))) err.push(`${at}: ${describe(x)} is not an ISO 8601 date with a time zone`)
  }
  if (typeof x === 'number') {
    if (s.minimum != null && x < s.minimum) err.push(`${at}: ${x} is less than ${s.minimum}`)
    if (s.maximum != null && x > s.maximum) err.push(`${at}: ${x} is greater than ${s.maximum}`)
  }
  if (Array.isArray(x)) {
    if (s.maxItems != null && x.length > s.maxItems) err.push(`${at}: ${x.length} items, at most ${s.maxItems}`)
    if (s.items) x.forEach((y, i) => check(s.items, y, `${at}[${i}]`, err, root))
  } else if (x && typeof x === 'object') {
    for (const k of s.required || []) if (x[k] === undefined) err.push(`${at ? at + '.' : ''}${k}: missing`)
    for (const [k, y] of Object.entries(x)) {
      if (y === undefined) continue
      const sk = s.properties && s.properties[k]
      if (sk) check(sk, y, at ? `${at}.${k}` : k, err, root)
      else if (s.additionalProperties === false) err.push(`${at ? at + '.' : ''}${k}: field unknown to format ${root.properties.format.const}`)
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, y, at ? `${at}.${k}` : k, err, root)
    }
  }
}
const twice = (xs, key, at, err) => { const seen = new Set(); xs.forEach((x, i) => { const k = key(x); if (seen.has(k)) err.push(`${at}[${i}]: ${k} given twice`); seen.add(k) }) }
// A ruling names an option or gives a text, never both, never neither
const oneOfOptionText = (r, at, err) => { if ((r.option == null) === (r.text == null)) err.push(`${at}: an option or a text, not ${r.option == null ? 'neither' : 'both'}`) }
export function validate(doc) {
  const err = []
  check(SCHEMA, doc, '', err)
  if (err.length) return err
  twice(doc.issues, p => p.id, 'issues', err)
  twice(doc.pending_rulings, r => r.issue, 'pending_rulings', err)
  doc.pending_rulings.forEach((r, i) => oneOfOptionText(r, `pending_rulings[${i}]`, err))
  return err
}

// ─── Schema of the issue register ISSUES.json (orchestre-issues/1, 0.20.0) ─────────────────────────────────────────
// One entry per issue, whole: its options with their actions (HANDOFF entries, added tasks, amendments) and, once a dry run
// has looked at them, valid and invalid_reason; its status and its ruling (option or text, user or auto, date, commit of
// application, null until apply has committed it)
const ACTIONS = arrayOf({ type: 'object' })
export const REGISTER_SCHEMA = {
  ...object(['format', 'issues'], { format: { const: REGISTER_FORMAT }, issues: arrayOf(ref('entry')) }),
  $defs: {
    date: SCHEMA.$defs.date,
    taskId: SCHEMA.$defs.taskId,
    issueId: SCHEMA.$defs.issueId,
    entry: object(['id', 'task', 'title', 'context', 'human', 'options', 'status', 'ruling'], {
      id: ref('issueId'), task: ref('taskId'), title: TEXT1, context: { type: 'string' }, human: { type: 'boolean' },
      options: arrayOf(object(['id', 'description'], {
        id: TEXT1, description: { type: 'string' }, impact: { type: 'string' }, recommended: { type: 'boolean' },
        valid: { type: ['boolean', 'null'] }, invalid_reason: { type: ['string', 'null'] }, entries: ACTIONS, added_tasks: ACTIONS, amendments: ACTIONS,
      })),
      status: { enum: ['open', 'settled', 'dropped'] },
      ruling: { oneOf: [ref('ruling'), { type: 'null' }] },
    }),
    ruling: object(['option', 'text', 'author', 'at', 'commit'], {
      option: { type: ['string', 'null'], minLength: 1 }, text: { type: ['string', 'null'], minLength: 1 }, author: { enum: ['user', 'auto'] }, at: ref('date'), commit: { type: ['string', 'null'], minLength: 1 },
    }),
  },
}
export function validateRegister(reg) {
  const err = []
  check(REGISTER_SCHEMA, reg, '', err, REGISTER_SCHEMA)
  if (err.length) return err
  twice(reg.issues, p => p.id, 'issues', err)
  reg.issues.forEach((p, i) => {
    const at = `issues[${i}]`
    if (!p.id.startsWith(`${p.task}-`)) err.push(`${at}: id ${p.id} is not an issue of ${p.task}`)
    twice(p.options, o => o.id, `${at}.options`, err)
    if (p.status === 'settled' && !p.ruling) err.push(`${at}: settled without a ruling`)
    if (p.status !== 'settled' && p.ruling) err.push(`${at}: ${p.status} with a ruling`)
    if (!p.ruling) return
    oneOfOptionText(p.ruling, `${at}.ruling`, err)
    if (p.ruling.option != null && !p.options.some(o => o.id === p.ruling.option)) err.push(`${at}.ruling: option ${p.ruling.option} is not an option of ${p.id}`)
  })
  return err
}

// ─── orchestre-progress/3 → /4 ─────────────────────────────────────────────────────────────────────────────────
// Each issue gets its id, <task>-<n> in the order of the file. A /3 issue only kept the text of its options, not their
// actions: it is marked without_actions, and each option is invalid for rule, so that it is settled by a free answer.
// Everything else is kept as is. Returns null for a document in another format.
export const INHERITED = `inherited from ${PREVIOUS_FORMAT} without its actions: settle it with a free answer`
export function convertV3(doc) {
  if (!doc || doc.format !== PREVIOUS_FORMAT) return null
  const n = new Map()
  const issue = p => {
    p = objectOf(p)
    n.set(p.task, (n.get(p.task) || 0) + 1)
    return { id: `${p.task}-${n.get(p.task)}`, ...p, without_actions: true, options: listOf(p.options, o => ({ ...objectOf(o), valid: false, invalid_reason: INHERITED, effect: '', amends: [] })) }
  }
  const out = {}
  for (const [k, v] of Object.entries(doc)) {
    out[k] = k === 'format' ? FORMAT : k === 'issues' ? listOf(v, issue) : v
    if (k === 'issues') out.pending_rulings = []
  }
  out.pending_rulings ??= []
  return out
}

// ─── Legacy formats: orchestre-suivi/2 and /1 (French) → orchestre-progress/3, then /4 ──────────────────────────────
// Keys renamed, enumerated values translated; free texts (titles, log, reviews, details) are kept as written.
// /1 had no modele_utilise: model_used starts at null. Returns null for a document in another format.
const tr = (map, x) => (typeof x === 'string' && Object.hasOwn(map, x) ? map[x] : x)
const listOf = (x, f) => (Array.isArray(x) ? x.map(f) : x)
const objectOf = x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {})
export function convertLegacy(doc) { return convertV3(legacyToV3(doc)) }
function legacyToV3(doc) {
  if (!doc || !LEGACY_FORMATS.includes(doc.format)) return null
  const L = LEGACY
  const task = t => (t = objectOf(t), {
    id: t.id, title: t.titre, phase: t.phase, batch: t.lot, depends_on: t.depend_de, model: t.modele, model_used: t.modele_utilise ?? null,
    status: tr(L.status, t.statut), attempts: t.essais, branch: t.branche, token_estimate: t.estimation_tokens, actual_tokens: tr(L.actualTokens, t.tokens_reels),
    added_by: t.ajoutee_par, step: tr(L.step, t.etape), isolated: t.isole, start: t.debut, end: t.fin, waiting: t.attend,
    rejections: listOf(t.refus, r => (r = objectOf(r), { attempt: r.essai, by: tr(L.by, r.par), gaps: r.manques })),
    flaky: t.instables, unverifiable: t.non_verifiables, blocker: t.blocage,
  })
  const run = r => (r = objectOf(r), {
    number: r.numero, run_id: r.run_id, phase: r.phase, mode: tr(L.mode, r.mode), parallelism: r.parallelisme, max_fixes: r.corrections_max, max_auto_decisions: r.decisions_office_max,
    status: tr(L.runStatus, r.statut), start: r.debut, end: r.fin, detail: r.detail,
    rulings_applied: listOf(r.arbitrages_appliques, a => (a = objectOf(a), { task: a.tache, title: a.titre, option: a.option })),
    discarded_amendments: listOf(r.amendements_ecartes, a => (a = objectOf(a), { task: a.tache, id: a.id, reason: a.raison })),
    added_tasks: listOf(r.taches_ajoutees, a => (a = objectOf(a), { id: a.id, phase: a.phase, title: a.titre })),
    deferred: r.reportees, not_started: r.non_lancees, waiting: r.en_attente,
    waiting_on_prerequisites: listOf(r.en_attente_prerequis, a => (a = objectOf(a), { id: a.id, prerequisites: a.prerequis })),
  })
  const issue = p => (p = objectOf(p), {
    run: p.run, task: p.tache, title: p.titre, context: p.contexte, human: p.humain, role: tr(L.role, p.role), status: tr(L.issueStatus, p.statut), chosen_option: p.option_choisie,
    ...(p.coupe_circuit !== undefined ? { circuit_breaker: p.coupe_circuit } : {}), ...(p.incoherence !== undefined ? { inconsistency: p.incoherence } : {}),
    options: listOf(p.options, o => (o = objectOf(o), { id: o.id, description: o.description, ...(o.impact !== undefined ? { impact: o.impact } : {}), ...(o.recommande !== undefined ? { recommended: o.recommande } : {}) })),
  })
  const handoff = Object.fromEntries(Object.entries(objectOf(doc.handoff)).map(([section, types]) => [tr(L.section, section),
    Object.fromEntries(Object.entries(objectOf(types)).map(([type, c]) => [tr(L.handoffType, type), { minor: objectOf(c).mineur, major: objectOf(c).majeur }]))]))
  return {
    format: PREVIOUS_FORMAT, plan: doc.plan, dir: doc.dossier, integration: doc.integration, base: doc.base, updated: doc.maj,
    tasks: listOf(doc.taches, task), runs: listOf(doc.runs, run), issues: listOf(doc.points, issue),
    auto_decisions: listOf(doc.decisions_office, d => (d = objectOf(d), { run: d.run, task: d.tache, title: d.titre, option: d.option, description: d.description })),
    reviews: listOf(doc.relectures, r => (r = objectOf(r), { task: r.tache, phase: r.phase, text: r.texte, run: r.run, at: r.quand })),
    prerequisites: listOf(doc.prerequis, p => (p = objectOf(p), { id: p.id, type: tr(L.prerequisiteType, p.type), status: tr(L.prerequisiteStatus, p.statut), text: p.texte, blocks: p.bloque })),
    handoff, lint: { ok: objectOf(doc.lint).ok, errors: objectOf(doc.lint).erreurs },
    log: listOf(doc.journal, e => (e = objectOf(e), { at: e.quand, kind: tr(L.kind, e.genre), task: e.tache, text: e.texte })),
    log_omitted: doc.journal_omis,
  }
}
// The log note that a conversion leaves, at the first write or by migrate.mjs; open: the open issues it kept without actions
export const conversionNote = (from, by = null, open = 0) => `progress.json converted from ${from} to ${FORMAT}${by ? ` by ${by}` : ''}${from === LEGACY_FORMATS[1] ? ': model used unknown until now' : ''}${open ? `; ${open} open issue${open > 1 ? 's' : ''} kept without ${open > 1 ? 'their' : 'its'} actions: settle ${open > 1 ? 'them' : 'it'} with a free answer` : ''}`

// ─── Plan: main checkout, configuration, plan-lint, frontmatter, HANDOFF.md ─────────────────────────────────────
const isPlan = d => existsSync(join(d, 'tasks')) || existsSync(join(d, 'taches'))
// The main checkout is the first block of « git worktree list --porcelain » (as status.mjs): the progress files always live there
export function locate(arg) {
  const cwd = process.cwd()
  const here = attempt(() => git(['rev-parse', '--show-toplevel'], cwd).trim())
  if (!here) throw new UsageError('not in a git repository')
  const mainCheckout = real((attempt(() => git(['worktree', 'list', '--porcelain'], cwd)) || '').match(/^worktree (.+)$/m)?.[1] || here)
  let rel
  if (arg) {
    const abs = resolve(cwd, arg)
    // Relative to the checkout we are in (worktree included), then to the main checkout; otherwise as is, from the root
    for (const base of [real(here), mainCheckout]) {
      const r = existsSync(abs) ? relative(base, real(abs)) : null
      if (r != null && !r.startsWith('..') && !isAbsolute(r)) { rel = r; break }
    }
    if (rel == null) rel = relative(mainCheckout, resolve(mainCheckout, arg))
    if (!isPlan(join(mainCheckout, rel))) throw new UsageError(`plan not found in this checkout: ${arg}`)
  } else {
    const p = join(mainCheckout, 'plans')
    const plans = existsSync(p) ? readdirSync(p).filter(n => isPlan(join(p, n))).sort() : []
    if (!plans.length) throw new UsageError('no plan in plans/; give its folder: plans/<name>')
    if (plans.length > 1) throw new UsageError(`several plans (${plans.map(n => 'plans/' + n).join(', ')}); say which`)
    rel = join('plans', plans[0])
  }
  const dir = join(mainCheckout, rel), name = basename(dir), relPosix = rel.split(sep).join('/') || '.'
  if (!existsSync(join(dir, 'tasks'))) throw new UsageError(`plan in the French format of orchestre 0.11 and earlier (taches/): migrate it with node "${MIGRATE}" ${relPosix}`)
  const cfg = attempt(() => JSON.parse(readFileSync(join(dir, 'orchestre.config.json'), 'utf8'))) || {}
  const integration = cfg.integration_branch || `plan/${name}`, base = cfg.base_branch || null
  // A branch name that starts with "-" would be read by git as an option
  if ([integration, base].some(b => b && String(b).startsWith('-'))) throw new UsageError('invalid branch in orchestre.config.json')
  return { root: mainCheckout, dir, rel: relPosix, name, integration, base }
}

// plan-lint is the source of truth for the frontmatter (amendments included), the statuses (git included) and the prerequisites
function planLint(ctx) {
  const r = spawnSync(process.execPath, [LINT, ctx.rel, '--json', '--integration', ctx.integration, ...(ctx.base ? ['--base', ctx.base] : [])], { cwd: ctx.root, env: ENV, encoding: 'utf8', maxBuffer: 1 << 26 })
  const L = attempt(() => JSON.parse(r.stdout))
  if (L && Array.isArray(L.tasks)) return L
  return { ok: false, errors: [`plan-lint returned no state (${String(r.stderr || r.stdout || 'no message').trim().split('\n')[0]})`], tasks: null, prerequisites: null }
}

function unquote(v) {
  v = v.trim()
  if (v.startsWith('"')) { const m = v.match(/^"((?:[^"\\]|\\.)*)"/); return m ? m[1].replace(/\\(["\\])/g, '$1') : v }
  if (v.startsWith("'")) { const m = v.match(/^'((?:[^']|'')*)'/); return m ? m[1].replace(/''/g, "'") : v }
  return v.replace(/\s+#.*$/, '').trim()
}
// What plan-lint does not return: parallel_batch, and whether token_estimate is present (plan-lint returns 0 for a missing estimate)
function frontmatter(ctx, file) {
  const fm = (readOrNull(resolve(ctx.root, file)) || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || ''
  const val = k => { const m = fm.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm')); return m ? unquote(m[1]) : null }
  return { batch: val('parallel_batch') || null, estimate: !!val('token_estimate') }
}

// Entries "type · severity · description", filed under "## <id>" or "## source plan" (scribe.md)
function parseHandoff(text) {
  const counts = {}, reviews = []
  let section = null
  for (const line of String(text || '').split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/)
    if (h) { section = h[1]; continue }
    const m = line.match(/^\s*(?:[-*]\s*)?([\p{L}][\p{L}-]*)\s*·\s*(minor|major)\s*·\s*(.*)$/iu)
    if (!m) continue
    const type = m[1].toLowerCase(), severity = m[2].toLowerCase(), key = section ?? '(before the sections)'
    const c = ((counts[key] ||= {})[type] ||= { minor: 0, major: 0 })
    c[severity]++
    if (type === 'review' && m[3].trim()) reviews.push({ task: RE_ID.test(section || '') ? section : null, text: m[3].trim() })
  }
  return { counts, reviews }
}

// ─── PROGRESS.md: the table only, the text around it kept byte for byte ────────────────────────────────────────────
// Cells of a Markdown table row; "\|" is a "|" inside a cell (as plan-lint)
const cells = line => {
  const l = line.trim(), p = l.split(/(?<!\\)\|/)
  if (p.length && p[0].trim() === '') p.shift()
  if (/(?<!\\)\|$/.test(l)) p.pop()
  return p.map(c => c.trim().replace(/\\\|/g, '|'))
}
const escapeCell = s => String(s).replace(/\|/g, '\\|')
const COLUMNS = { id: 'ID', title: 'Title', phase: 'Phase', batch: 'Batch', 'depends on': 'Depends on', model: 'Model', status: 'Status', attempts: 'Attempts', branch: 'Branch', tokens: 'Tokens est. / actual' }
const columnKey = name => { const n = norm(name); return n.startsWith('tokens') ? 'tokens' : n in COLUMNS ? n : null }
export const LEGEND = `Statuses: ${STATUSES.join(' · ')}`

// The table: from the header row that contains ID and Status (plan-lint's marker) to the last following row that starts with "|"
function table(text) {
  const lines = text.split('\n'), net = l => l.replace(/\r$/, '')
  const h = lines.findIndex(l => net(l).trim().startsWith('|') && cells(net(l)).includes('ID') && cells(net(l)).includes('Status'))
  if (h < 0) return null
  let end = h
  while (end + 1 < lines.length && net(lines[end + 1]).trim().startsWith('|')) end++
  const isSep = i => i <= end && cells(net(lines[i])).every(x => /^:?-+:?$/.test(x))
  const sepI = isSep(h + 1) ? h + 1 : -1
  const rows = []
  for (let i = h + 1; i <= end; i++) if (i !== sepI) rows.push({ n: i + 1, cells: cells(net(lines[i])) })
  // Task rows written after the table (under the legend, by a scribe from before 0.8.0): plan-lint reads them,
  // the view takes them back into the table (0.8.1). A row whose ID is not a task stays text.
  // Only a row that has at least the header's cells and a known status counts: a row of another table
  // (notes, decisions) stays text.
  const header = cells(net(lines[h])), iId = header.indexOf('ID'), iSt = header.indexOf('Status'), orphans = []
  for (let i = end + 1; i < lines.length; i++) {
    if (!net(lines[i]).trim().startsWith('|')) continue
    const row = cells(net(lines[i]))
    if (row.length >= header.length && RE_ID.test(row[iId] || '') && STATUSES.includes(row[iSt] || '')) orphans.push({ i, n: i + 1, cells: row })
  }
  return { lines, h, end, header, sep: sepI >= 0 ? net(lines[sepI]) : null, rows, orphans, crlf: lines[h].endsWith('\r'), indent: net(lines[h]).match(/^\s*/)[0] }
}

// The other way round, for the rebuild: the cells read by their column name; a status outside the 7 is an error
function parseProgress(text) {
  const tb = text == null ? null : table(text)
  if (!tb) return null
  const k = tb.header.map(columnKey), col = (row, c) => (k.indexOf(c) >= 0 ? row[k.indexOf(c)] ?? '' : '')
  const empty = v => !v || v === '—' || v === '-'
  const out = [], seen = new Set()
  for (const { n, cells: row, orphan } of [...tb.rows, ...tb.orphans.map(o => ({ ...o, orphan: true }))]) {
    const id = col(row, 'id')
    if (!RE_ID.test(id)) continue
    if (seen.has(id) && !orphan) refuse(`PROGRESS.md, line ${n}: ${id} duplicated`)
    seen.add(id)
    const status = col(row, 'status')
    if (!STATUSES.includes(status)) refuse(`PROGRESS.md, line ${n}: unknown status "${status}" for ${id} (${STATUSES.join(', ')})`)
    const tok = col(row, 'tokens'), i = tok.indexOf(' / '), actual = i >= 0 ? tok.slice(i + 3).trim() : ''
    const phase = Number(col(row, 'phase')), attempts = Number(col(row, 'attempts'))
    const l = {
      id, title: col(row, 'title') || id, status, attempts: Number.isInteger(attempts) && attempts >= 0 ? attempts : 0,
      branch: empty(col(row, 'branch')) ? null : col(row, 'branch'), actual_tokens: empty(actual) ? null : actual,
      phase: Number.isInteger(phase) && phase >= 1 ? phase : undefined, model: empty(col(row, 'model')) ? null : col(row, 'model'),
      batch: empty(col(row, 'batch')) ? null : col(row, 'batch'), depends_on: empty(col(row, 'depends on')) ? [] : col(row, 'depends on').split(/\s*,\s*/).filter(Boolean),
    }
    // A row under the legend that repeats a task already read replaces it, in its place: plan-lint also reads the last one
    const j = out.findIndex(x => x.id === id)
    if (j >= 0) out[j] = l
    else out.push(l)
  }
  return out
}

const millions = n => (n == null ? '—' : `${n.toFixed(1)}M`)
function cell(t, k) {
  switch (k) {
    case 'id': return t.id
    case 'title': return t.title
    case 'phase': return String(t.phase)
    case 'batch': return t.batch ?? '—'
    case 'depends on': return t.depends_on.length ? t.depends_on.join(', ') : '—'
    case 'model': return t.model ?? '—'
    case 'status': return t.status
    case 'attempts': return String(t.attempts)
    case 'branch': return t.branch ?? '—'
    case 'tokens': return `${millions(t.token_estimate)} / ${t.actual_tokens ?? '—'}`
  }
}

// The view: columns of the existing header in their order, one row per task, cells padded to their column's width
export function render(doc, text) {
  const tb = text == null ? null : table(text)
  const header = tb ? tb.header : Object.values(COLUMNS)
  const keys = header.map(columnKey)
  const previous = new Map()
  if (tb) { const iId = keys.indexOf('id'); for (const l of [...tb.orphans, ...tb.rows]) if (RE_ID.test(l.cells[iId] || '')) previous.set(l.cells[iId], l.cells) }
  // An unknown column keeps the task's current cell, found by its ID
  const body = doc.tasks.map(t => keys.map((k, j) => escapeCell(k ? cell(t, k) : (previous.get(t.id) || [])[j] ?? '')))
  const head = header.map(escapeCell)
  const widths = head.map((c, j) => Math.max(3, width(c), ...body.map(r => width(r[j]))))
  const pad = (c, j) => c + ' '.repeat(widths[j] - width(c))
  const sepCells = tb && tb.sep ? cells(tb.sep) : []
  const spaced = tb && tb.sep ? /^\s*\|\s/.test(tb.sep) : false
  const dashes = (j, w) => { const a = sepCells[j] || '', l = a.startsWith(':'), r = a.length > 1 && a.endsWith(':'); return (l ? ':' : '-') + '-'.repeat(Math.max(0, w - 2)) + (r ? ':' : '-') }
  const eol = tb && tb.crlf ? '\r' : '', indent = tb ? tb.indent : ''
  const lines = [
    indent + '| ' + head.map(pad).join(' | ') + ' |' + eol,
    indent + (spaced ? '| ' + widths.map((w, j) => dashes(j, w)).join(' | ') + ' |' : '|' + widths.map((w, j) => dashes(j, w + 2)).join('|') + '|') + eol,
    ...body.map(r => indent + '| ' + r.map(pad).join(' | ') + ' |' + eol),
  ]
  if (tb) {
    const iId = keys.indexOf('id'), inDoc = new Set(doc.tasks.map(t => t.id))
    const takenBack = new Set(tb.orphans.filter(l => inDoc.has(l.cells[iId])).map(l => l.i))
    return [...tb.lines.slice(0, tb.h), ...lines, ...tb.lines.slice(tb.end + 1).filter((_, k) => !takenBack.has(tb.end + 1 + k))].join('\n')
  }
  if (text != null) return text.replace(/\n*$/, '\n\n') + lines.join('\n') + '\n'
  return `# PROGRESS — ${doc.plan}\n\n${lines.join('\n')}\n\n${LEGEND}\n`
}

// ─── Document ─────────────────────────────────────────────────────────────────────────────────────────────────────
const newTask = x => ({
  id: x.id, title: x.title || x.id, phase: x.phase, batch: x.batch ?? null, depends_on: x.depends_on ?? [], model: x.model ?? null, model_used: null,
  status: x.status ?? 'todo', attempts: x.attempts ?? 0, branch: x.branch ?? null, token_estimate: x.token_estimate ?? null,
  actual_tokens: x.actual_tokens ?? null, added_by: x.added_by ?? null, step: null, isolated: null, start: null, end: null,
  waiting: [], rejections: [], flaky: [], unverifiable: [], blocker: [],
})
const emptyDoc = (ctx, at) => ({
  format: FORMAT, plan: ctx.name, dir: ctx.rel, integration: ctx.integration, base: ctx.base, updated: at,
  tasks: [], runs: [], issues: [], pending_rulings: [], auto_decisions: [], reviews: [], prerequisites: [], handoff: {}, lint: { ok: true, errors: [] }, log: [], log_omitted: 0,
})
export const logger = (doc, at) => (kind, task, text) => doc.log.push({ at, kind, task: task ?? null, text: clip(text, 300) })
const currentRun = doc => doc.runs.filter(r => r.status === 'in-progress').pop() || null
const taskOf = (doc, id) => doc.tasks.find(t => t.id === id) || refuse(`unknown task in progress: ${id}`)
const list = (E, k) => (E[k] == null ? [] : Array.isArray(E[k]) ? E[k] : refuse(`input: "${k}" must be a list`))

// Places a task: after the last task of a lower or equal phase; an added task, after the one that gave birth to it
// and after those that task already gave birth to (descendants included)
function insert(doc, t, parent) {
  let pos = -1
  if (parent && doc.tasks.some(x => x.id === parent)) {
    const desc = new Set([parent])
    for (let changed = true; changed;) { changed = false; for (const x of doc.tasks) if (x.added_by && desc.has(x.added_by) && !desc.has(x.id)) { desc.add(x.id); changed = true } }
    doc.tasks.forEach((x, i) => { if (desc.has(x.id)) pos = i })
  } else doc.tasks.forEach((x, i) => { if (x.phase <= t.phase) pos = i })
  doc.tasks.splice(pos + 1, 0, t)
}

// Plan fields of a task: plan-lint (frontmatter, amendments included), plus parallel_batch and whether the estimate is present
function planFields(ctx, lt) {
  const fm = frontmatter(ctx, lt.file)
  return {
    ...(Number.isInteger(lt.phase) && lt.phase >= 1 ? { phase: lt.phase } : {}),
    // Without a model in the frontmatter: null (0.11.0); the workflow then launches sonnet, then the escalation ladder
    model: typeof lt.model === 'string' && lt.model.trim() ? lt.model.trim() : null,
    depends_on: (lt.depends_on || []).map(String), batch: fm.batch, token_estimate: fm.estimate ? lt.token_estimate : null,
  }
}

// Plan fields from plan-lint. Statuses too at the start of a run and on rebuild: git and PROGRESS.md are the source of truth
function sync(doc, L, ctx, J, { statuses }) {
  if (!L.tasks) return
  const byId = new Map(L.tasks.map(t => [t.id, t]))
  let rows = null
  const row = id => { rows = rows || new Map((attempt(() => parseProgress(readOrNull(join(ctx.dir, 'PROGRESS.md')))) || []).map(l => [l.id, l])); return rows.get(id) }
  doc.tasks = doc.tasks.filter(t => byId.has(t.id) || (J('task', t.id, `${t.id} removed from progress: no task file in ${ctx.rel}/tasks/`), false))
  for (const lt of L.tasks) {
    const plan = planFields(ctx, lt)
    let t = doc.tasks.find(x => x.id === lt.id)
    if (!t) {
      if (!plan.phase) { J('error', null, `${lt.id} not added to progress: phase missing from the frontmatter`); continue }
      if (!STATUSES.includes(lt.status)) refuse(`PROGRESS.md: unknown status "${lt.status}" for ${lt.id} (${STATUSES.join(', ')})`)
      const l = row(lt.id)
      t = newTask({ id: lt.id, title: lt.title, status: lt.status, ...(l ? { title: l.title, attempts: l.attempts, branch: l.branch, actual_tokens: l.actual_tokens } : {}), ...plan })
      insert(doc, t, null)
      J('added', t.id, `${t.id} added to progress from its task file (phase ${t.phase})`)
      continue
    }
    Object.assign(t, plan)
    if (statuses && lt.status !== t.status) {
      if (!STATUSES.includes(lt.status)) refuse(`PROGRESS.md: unknown status "${lt.status}" for ${lt.id} (${STATUSES.join(', ')})`)
      J('status', t.id, `${t.id}: ${t.status} → ${lt.status} (PROGRESS.md and git)`)
      t.status = lt.status
    }
  }
}

// Reviews from HANDOFF.md missing from the progress file (written by /orchestre:prepare, or before progress.json was lost)
function mergeReviews(doc, handoff) {
  for (const r of parseHandoff(handoff).reviews) {
    if (doc.reviews.some(x => x.task === r.task && x.text === r.text)) continue
    doc.reviews.push({ task: r.task, phase: doc.tasks.find(t => t.id === r.task)?.phase ?? null, text: r.text, run: null, at: null })
  }
}

// Derived fields, recomputed at each write and valid as of the updated date
function derive(doc, L, handoff) {
  if (Array.isArray(L.prerequisites)) doc.prerequisites = L.prerequisites.filter(p => RE_ID.test(p.id)).map(p => ({ id: p.id, type: String(p.type ?? ''), status: String(p.status ?? ''), text: String(p.text ?? ''), evidence: String(p.evidence ?? ''), how: Array.isArray(p.how) ? p.how.map(String) : [], blocks: p.blocks || [] }))
  doc.lint = { ok: !!L.ok, errors: (L.errors || []).map(String) }
  doc.handoff = parseHandoff(handoff).counts
  const st = new Map(doc.tasks.map(t => [t.id, t.status]))
  for (const t of doc.tasks) {
    t.waiting = DONE(t.status) ? [] : [...t.depends_on.filter(d => !DONE(st.get(d))), ...doc.prerequisites.filter(p => p.status === 'open' && p.blocks.includes(t.id)).map(p => p.id)]
  }
}

function rebuild(ctx, L, handoff, at) {
  const doc = emptyDoc(ctx, at), J = logger(doc, at)
  for (const l of parseProgress(readOrNull(join(ctx.dir, 'PROGRESS.md'))) || []) doc.tasks.push(newTask(l))
  sync(doc, L, ctx, J, { statuses: true })
  mergeReviews(doc, handoff)
  J('run', null, 'progress.json rebuilt from PROGRESS.md, HANDOFF.md and plan-lint: dates, steps, rejections and log start empty again')
  return doc
}

const READS = [FORMAT, PREVIOUS_FORMAT, ...LEGACY_FORMATS]
const checkFormat = doc => { if (!doc || !READS.includes(doc.format)) refuse(`progress.json is in format ${doc && doc.format}, this reader reads ${READS.join(', ')}`) }
const CONVERTED = Symbol('converted from an earlier format')
// A document of an earlier format, in /4
const upgrade = doc => (doc.format === FORMAT ? doc : doc.format === PREVIOUS_FORMAT ? convertV3(doc) : convertLegacy(doc))

function load(ctx) {
  const f = join(ctx.dir, 'progress.json')
  if (!existsSync(f)) return null
  let doc
  try { doc = JSON.parse(readFileSync(f, 'utf8')) } catch (e) { refuse(`progress.json unreadable (${e.message}): fix it, or delete it so that it is rebuilt from PROGRESS.md, HANDOFF.md and plan-lint`) }
  checkFormat(doc)
  if (doc.format === FORMAT) return doc
  const converted = upgrade(doc)
  converted[CONVERTED] = doc.format
  return converted
}

// The issue register: absent, an empty register; unreadable, in another format or invalid, refused (it is in git: restore it)
const emptyRegister = () => ({ format: REGISTER_FORMAT, issues: [] })
function loadRegister(ctx) {
  const f = join(ctx.dir, REGISTER)
  if (!existsSync(f)) return emptyRegister()
  let reg
  try { reg = JSON.parse(readFileSync(f, 'utf8')) } catch (e) { refuse(`${REGISTER} unreadable (${e.message}): it is tracked by git, restore it`) }
  const err = validateRegister(reg)
  if (err.length) refuse(`${REGISTER} invalid:\n${err.slice(0, 12).map(e => '  - ' + e).join('\n')}`)
  return reg
}

// progress.json and its working files out of git: otherwise a "modified" checkout at pre-flight, or a blocked git switch.
// Also used by migrate.mjs.
export function excludeFromGit(root, rel) {
  const common = attempt(() => git(['rev-parse', '--git-common-dir'], root).trim())
  if (!common) return
  const ignored = p => attempt(() => git(['check-ignore', '-q', p], root)) != null
  const missing = [['progress.json', 'progress.json'], ['.progress.lock', '.progress.lock'], ['.progress.0.tmp', '.progress.*.tmp']].filter(([ex]) => !ignored(`${rel}/${ex}`)).map(([, m]) => `/${rel}/${m}`)
  if (!missing.length) return
  const f = join(resolve(root, common), 'info', 'exclude'), before = readOrNull(f) || ''
  mkdirSync(dirname(f), { recursive: true })
  appendFileSync(f, `${before && !before.endsWith('\n') ? '\n' : ''}# orchestre: progress of plan ${rel}, outside git\n${missing.join('\n')}\n`)
}

// Lock: exclusive creation. A lock whose process still runs is never removed, whatever its age (close and apply commit under
// it, and a slow pre-commit hook must not let another writer take it): the writer waits, then refuses after 20 s. A lock is
// removed only when its process no longer runs, or when its pid cannot be read and it is older than a minute.
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
function underLock(ctx, fn) {
  const p = join(ctx.dir, '.progress.lock'), deadline = Date.now() + 20000
  for (;;) {
    try { const fd = openSync(p, 'wx'); writeSync(fd, `${process.pid}\n`); closeSync(fd); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const pid = Number((readOrNull(p) || '').split('\n')[0]) || 0, age = attempt(() => Date.now() - statSync(p).mtimeMs)
      if (pid ? !alive(pid) : (age != null && age > 60000)) { attempt(() => unlinkSync(p)); continue }
      if (Date.now() > deadline) refuse(`lock ${ctx.rel}/.progress.lock held by process ${pid || '?'} for more than 20 s; if it no longer runs, delete the file`)
      sleep(10 + Math.floor(Math.random() * 30))
    }
  }
  try { return fn() } finally { attempt(() => unlinkSync(p)) }
}
// Temporary file renamed: a reader never sees a half-written file
function writeFile(ctx, name, content) {
  const tmp = join(ctx.dir, `.progress.${process.pid}.${name === 'PROGRESS.md' ? 'view.' : name === REGISTER ? 'issues.' : ''}tmp`)
  try { writeFileSync(tmp, content); renameSync(tmp, join(ctx.dir, name)) } finally { attempt(() => unlinkSync(tmp)) }
}

export const truncate = doc => { const k = doc.log.length - LOG_MAX; if (k > 0) { doc.log.splice(0, k); doc.log_omitted += k } }

// One write: plan-lint and HANDOFF.md read outside the lock, then under the lock: read, change, derived fields, validation, write.
// change(doc, tools) returns { view: true } for a durable transition: PROGRESS.md regenerated, plan fields reread.
// tools.register() reads ISSUES.json under the same lock, once; the change returns { register: true } to write it back,
// validated before anything is written.
const refusedAs = (what, err) => `write refused, ${what} unchanged:\n${err.slice(0, 12).map(e => '  - ' + e).join('\n')}${err.length > 12 ? `\n  - … ${err.length - 12} more` : ''}`
export function write(ctx, change, opts = {}) {
  const L = planLint(ctx), handoff = readOrNull(join(ctx.dir, 'HANDOFF.md')) || ''
  return underLock(ctx, () => writeLocked(ctx, change, opts, L, handoff))
}
// The same write, for a caller that already holds the lock and has read plan-lint and HANDOFF.md (close, 0.20.0)
function writeLocked(ctx, change, { runStart = false } = {}, L, handoff) {
  {
    const at = now()
    const existing = load(ctx)
    if (!existing && !L.tasks) refuse(`${L.errors[0]}: progress.json missing, it cannot be rebuilt without plan-lint; nothing is written`)
    const doc = existing || rebuild(ctx, L, handoff, at)
    const J = logger(doc, at)
    if (existing && existing[CONVERTED]) J('run', null, conversionNote(existing[CONVERTED], null, existing.issues.filter(p => p.status === 'open').length))
    if (!L.tasks) { const note = `${L.errors[0]}: plan fields, git statuses and prerequisites kept as they are`; if (!doc.log.slice(-20).some(e => e.text === clip(note, 300))) J('error', null, note) }
    if (!existing || runStart) excludeFromGit(ctx.root, ctx.rel)
    let register = null
    const r = change(doc, { L, handoff, at, J, ctx, register: () => (register ??= loadRegister(ctx)) }) || {}
    if (r.view && existing) sync(doc, L, ctx, J, { statuses: false })
    derive(doc, L, handoff)
    doc.updated = at
    truncate(doc)
    const err = validate(doc)
    if (err.length) refuse(refusedAs('progress.json', err))
    const registerText = r.register && register ? JSON.stringify(register, null, 2) + '\n' : null
    if (registerText != null) { const e = validateRegister(register); if (e.length) refuse(refusedAs(`progress.json and ${REGISTER}`, e)) }
    const viewText = r.view ? render(doc, readOrNull(join(ctx.dir, 'PROGRESS.md'))) : null
    if (registerText != null) writeFile(ctx, REGISTER, registerText)
    writeFile(ctx, 'progress.json', JSON.stringify(doc, null, 2) + '\n')
    if (viewText != null) writeFile(ctx, 'PROGRESS.md', viewText)
    return { doc, ...r }
  }
}

// ─── Write commands ─────────────────────────────────────────────────────────────────────────────────────────
function runStart(doc, E, { L, handoff, J, at, ctx }) {
  // A plan closed by the pilot (0.16.1) is open again as soon as a run starts on it
  if (doc.closed) { delete doc.closed; J('run', null, 'plan open again: a run starts') }
  for (const r of doc.runs.filter(r => r.status === 'in-progress')) { r.status = 'interrupted'; J('run', null, `run ${r.number} interrupted: left in progress, without a run end`) }
  for (const t of doc.tasks.filter(t => t.step)) { J('step', t.id, `${t.id}: step "${t.step}" interrupted with its run`); t.step = null }
  sync(doc, L, ctx, J, { statuses: true })
  mergeReviews(doc, handoff)
  const number = (doc.runs.length ? doc.runs[doc.runs.length - 1].number : 0) + 1
  doc.runs.push({
    number, run_id: E.run_id ?? null, phase: E.phase, mode: E.mode, parallelism: E.parallelism, max_fixes: E.max_fixes, max_auto_decisions: E.max_auto_decisions,
    status: 'in-progress', start: at, end: null, detail: null, rulings_applied: [], discarded_amendments: [], added_tasks: [], deferred: [], not_started: [], waiting: [], waiting_on_prerequisites: [],
  })
  J('run', null, `run ${number}: phase ${E.phase}, mode ${E.mode}, ${E.parallelism} in parallel`)
  return { message: `run ${number} opened (phase ${E.phase}, mode ${E.mode})` }
}

// Model launched by the worker or a fix (0.11.0), and the model change the workflow decided
const textOrNull = (x, field) => (x == null ? null : typeof x === 'string' && x.trim() ? x.trim() : refuse(`step: "${field}" must be a non-empty text`))
function modelChange(E, model) {
  const c = E.change
  if (c == null) return null
  if (typeof c !== 'object' || Array.isArray(c)) refuse('step: "change" must be an object { from, to, reason }')
  const to = textOrNull(c.to, 'change.to') ?? model
  if (!to) refuse('step: change without a target model (change.to or model)')
  if (model && to !== model) refuse(`step: change to ${to}, but model is ${model}`)
  return { from: textOrNull(c.from, 'change.from'), to, reason: c.reason == null ? '' : String(c.reason).replace(/\s+/g, ' ').trim() }
}
function step(doc, E, { J, at }) {
  const t = taskOf(doc, E.task)
  const model = textOrNull(E.model, 'model'), ch = modelChange(E, model)
  if (E.isolated !== undefined) t.isolated = E.isolated
  if (E.step === 'worker') {
    Object.assign(t, { step: 'worker', start: at, end: null, attempts: 1, rejections: [], flaky: [], unverifiable: [], blocker: [], model_used: ch ? ch.to : model })
    J('task', t.id, `${t.id} starts (${t.isolated === true ? 'worktree' : t.isolated === false ? 'main checkout' : 'place not given'})`)
    if (ch) J('model', t.id, `${t.id}: ${ch.from ?? '—'} → ${ch.to}${ch.reason ? ` (${ch.reason})` : ''}`)
  } else {
    t.step = E.step
    if (E.step === 'fix' && E.rejection) {
      t.rejections.push(E.rejection)
      if (Number.isInteger(E.rejection.attempt)) t.attempts = Math.max(t.attempts, E.rejection.attempt + 1)
      J('rejection', t.id, `${t.id}: attempt ${E.rejection.attempt} rejected (${E.rejection.by}): ${(E.rejection.gaps || []).length} gap(s)`)
    }
    if (model || ch) t.model_used = ch ? ch.to : model
    if (ch) J('model', t.id, `${t.id}: ${ch.from ?? '—'} → ${ch.to}${ch.reason ? ` (${ch.reason})` : ''}`)
    J('step', t.id, `${t.id}: ${E.step}${E.step === 'fix' ? ` (attempt ${t.attempts})` : ''}`)
  }
  return { message: `${t.id} → ${E.step}${t.model_used && (model || ch) ? ` (${t.model_used})` : ''}` }
}

// What an option does to the plan, in one sentence, from its actions: "amends AH04, AH05", "adds AH03B in phase 2", or
// "a note in HANDOFF, no task changes"
export function effectOf(o) {
  const ids = xs => (Array.isArray(xs) ? xs : []).map(x => x && x.id).filter(id => RE_ID.test(id || ''))
  const amends = [...new Set(ids(o.amendments))]
  const adds = (Array.isArray(o.added_tasks) ? o.added_tasks : []).filter(x => x && RE_ID.test(x.id || '')).map(x => `${x.id}${Number.isInteger(x.phase) ? ` in phase ${x.phase}` : ''}`)
  const parts = [...(amends.length ? [`amends ${amends.join(', ')}`] : []), ...(adds.length ? [`adds ${adds.join(', ')}`] : [])]
  return { effect: parts.length ? parts.join('; ') : 'a note in HANDOFF, no task changes', amends }
}
// The short copy of an option for progress.json: its text, what the dry run said of it (null: not looked at yet), its effect
const optionCopy = o => ({
  id: String(o.id), description: o.description ?? '', ...(o.impact !== undefined ? { impact: o.impact } : {}), ...(o.recommended !== undefined ? { recommended: o.recommended } : {}),
  valid: typeof o.valid === 'boolean' ? o.valid : null, invalid_reason: o.valid === false && typeof o.invalid_reason === 'string' ? o.invalid_reason : null, ...effectOf(o),
})
// The next id of an issue of a task: after those of progress.json and of the register (read if it can be)
function nextIssueId(doc, task, tools) {
  const ids = [...doc.issues.map(p => p.id), ...(attempt(() => tools.register().issues.map(p => p.id)) || [])].filter(id => typeof id === 'string' && id.startsWith(`${task}-`))
  return `${task}-${Math.max(0, ...ids.map(id => Number(id.slice(task.length + 1))).filter(Number.isInteger)) + 1}`
}
const issueOf = (doc, p, run, task, role, tools) => ({
  id: nextIssueId(doc, p.task ?? task, tools), run, task: p.task ?? task, title: p.title, context: p.context ?? '', human: !!p.human, role: p.role ?? role, status: 'open', chosen_option: null,
  options: (p.options || []).map(optionCopy), ...(p.circuit_breaker ? { circuit_breaker: true } : {}), ...(p.inconsistency ? { inconsistency: p.inconsistency } : {}),
})
const runNumber = doc => currentRun(doc)?.number ?? refuse('no run in progress: run run-start first')

// Tasks created by a close or a ruling: the task file already exists (the scribe wrote it), plan-lint reads it.
// Called again for a task already there (scribe rerun, progress rebuilt), it is not duplicated.
function add(doc, items, parent, { L, J, ctx }) {
  const run = currentRun(doc), skipped = []
  for (const x of items) {
    if (!x || !RE_ID.test(x.id || '')) refuse(`added task without a valid id: ${JSON.stringify(x)}`)
    const lt = (L.tasks || []).find(t => t.id === x.id)
    // Without a task file (the scribe removed it on a plan-lint refusal, and reports it on its side): skipped, noted in the log.
    // Refusing the whole write would lose the close of the task that proposed it.
    // Without a file, only a task the caller describes in full (phase and model) gets in: neither the workflow nor the summary do
    if (!lt && !(x.phase && x.model)) { J('error', x.id, `${x.id} not added to progress: no task file read by plan-lint (addition proposed by ${parent ?? 'the run summary'})`); skipped.push(x.id); continue }
    const plan = lt ? planFields(ctx, lt) : { phase: x.phase, model: x.model, depends_on: x.depends_on ?? [], batch: x.batch ?? null, token_estimate: x.token_estimate ?? null }
    let t = doc.tasks.find(y => y.id === x.id)
    if (!t) t = newTask({ id: x.id, title: x.title, status: 'added', ...plan })
    else if (t.added_by !== parent) doc.tasks.splice(doc.tasks.indexOf(t), 1)
    if (!doc.tasks.includes(t)) { t.added_by = parent; insert(doc, t, parent) }
    Object.assign(t, plan, { title: x.title || t.title })
    if (t.status === 'todo') t.status = 'added'
    if (run && !run.added_tasks.some(y => y.id === t.id)) run.added_tasks.push({ id: t.id, phase: t.phase, title: t.title })
    J('added', t.id, `${t.id} added by ${parent ?? 'the run summary'} (phase ${t.phase}): ${t.title}`)
  }
  return skipped
}
const notAdded = ids => (ids.length ? `; not added, without a task file: ${ids.join(', ')}` : '')
const logAmendments = (E, J, task) => {
  for (const a of list(E, 'amendments')) J('amendment', a.id ?? null, `${a.id} amended after ${task}: ${a.reason ?? 'no reason'}`)
}

function close(doc, E, tools) {
  const { J, at } = tools
  const t = taskOf(doc, E.task)
  if (!CLOSES.includes(E.status)) refuse(`close: status "${E.status}" not allowed (${CLOSES.join(', ')})`)
  const nrun = () => runNumber(doc)
  if (E.replanning) J('step', t.id, `${t.id}: replanning finished`)
  Object.assign(t, {
    status: E.status, attempts: E.attempts ?? t.attempts, branch: E.branch !== undefined ? E.branch : t.branch,
    actual_tokens: E.actual_tokens !== undefined ? E.actual_tokens : 'see /workflows', end: at, step: null,
    rejections: E.rejections ?? t.rejections, flaky: E.flaky ?? t.flaky, unverifiable: E.unverifiable ?? t.unverifiable,
    blocker: E.blocker ?? (E.status === 'merged' ? [] : t.blocker),
  })
  J('status', t.id, `${t.id}: ${E.status} (${t.attempts} attempt${t.attempts > 1 ? 's' : ''})${t.blocker.length ? ' — ' + t.blocker[0] : ''}`)
  for (const r of list(E, 'reviews')) {
    const text = typeof r === 'string' ? r : r && (r.text ?? r.review)
    if (doc.reviews.some(x => x.task === t.id && x.text === text)) continue
    doc.reviews.push({ task: t.id, phase: t.phase, text, run: currentRun(doc)?.number ?? null, at })
    J('review', t.id, `${t.id}: review before the PR — ${text}`)
  }
  // An issue with auto: <option> (0.20.0) is an automatic decision: the same decision given in auto_decisions is not noted twice
  const issues = list(E, 'issues'), autoKey = (title, option) => JSON.stringify([title, String(option)])
  const autos = new Set(issues.filter(p => p && p.auto != null).map(p => autoKey(p.title, p.auto)))
  const decided = d => doc.auto_decisions.some(x => x.run === nrun() && x.task === d.task && x.title === d.title && String(x.option) === String(d.option))
  for (const d of list(E, 'auto_decisions')) {
    if (autos.has(autoKey(d.title, d.option)) || decided({ ...d, task: d.task ?? t.id })) continue
    doc.auto_decisions.push({ run: nrun(), task: d.task ?? t.id, title: d.title, option: d.option, description: d.description })
    J('auto-decision', t.id, `${t.id}: "${d.title}", option ${d.option} taken automatically`)
  }
  // Each issue: its short copy in progress.json and, whole, in ISSUES.json (0.20.0). An issue this run already recorded for the
  // same task with the same title (the match of run-end) is the same issue, given again by a close run twice: it keeps its id
  // and is recorded neither again nor, settled by auto, as a second automatic decision
  const ids = [], same = new Set()
  let recorded = 0
  for (const p of issues) {
    const already = doc.issues.find(x => !same.has(x) && x.run === nrun() && x.task === (p.task ?? t.id) && x.title === p.title)
    if (already) { same.add(already); ids.push(already.id); continue }
    const copy = issueOf(doc, p, nrun(), t.id, 'open', tools), auto = p.auto != null ? String(p.auto) : null
    if (auto != null) {
      const o = copy.options.find(o => o.id === auto) || refuse(`close: issue "${p.title}": auto names option ${auto}, which it does not have`)
      Object.assign(copy, { status: 'settled', chosen_option: auto })
      doc.auto_decisions.push({ run: nrun(), task: copy.task, title: copy.title, option: auto, description: o.description })
      J('auto-decision', t.id, `${t.id}: "${p.title}", option ${auto} taken automatically`)
    } else J('issue', t.id, `${t.id}: issue "${p.title}"${p.human ? ' (human)' : ''}`)
    doc.issues.push(copy)
    same.add(copy)
    tools.register().issues.push(registerEntry(copy, p, auto, at))
    ids.push(copy.id)
    recorded++
  }
  const skipped = add(doc, list(E, 'added_tasks'), t.id, tools)
  for (const x of list(E, 'rejected')) J('error', RE_ID.test(x.id || '') ? x.id : null, `${x.id} not applied after ${t.id}: ${x.reason}`)
  logAmendments(E, J, t.id)
  return { view: true, register: recorded > 0, issues: ids, message: `${t.id} ${E.status}; PROGRESS.md regenerated${notAdded(skipped)}` }
}
// The whole issue for ISSUES.json: its options with their actions and the dry run's verdict; settled by auto when auto names
// one of its options (the commit of application is the one close makes, unknown before it: null)
const actionsOf = (o, k) => (Array.isArray(o[k]) ? o[k] : [])
const registerEntry = (copy, p, auto, at) => ({
  id: copy.id, task: copy.task, title: copy.title, context: copy.context, human: copy.human,
  options: (p.options || []).map((o, i) => ({
    id: copy.options[i].id, description: copy.options[i].description, ...(o.impact !== undefined ? { impact: o.impact } : {}), ...(o.recommended !== undefined ? { recommended: o.recommended } : {}),
    valid: copy.options[i].valid, invalid_reason: copy.options[i].invalid_reason, entries: actionsOf(o, 'entries'), added_tasks: actionsOf(o, 'added_tasks'), amendments: actionsOf(o, 'amendments'),
  })),
  status: auto != null ? 'settled' : 'open',
  ruling: auto != null ? { option: auto, text: null, author: 'auto', at, commit: null } : null,
})

function ruling(doc, E, tools) {
  const { J } = tools
  const t = taskOf(doc, E.task)
  const option = E.option && typeof E.option === 'object' ? E.option.id : E.option
  if (!option || !E.title) refuse('ruling: task, title and option expected')
  const p = doc.issues.filter(x => x.task === t.id && x.title === E.title && x.status === 'open').pop()
  if (p) Object.assign(p, { status: 'settled', chosen_option: String(option) })
  J('ruling', t.id, `${t.id}: "${E.title}" settled, option ${option}${p ? '' : ' (issue missing from progress)'}`)
  const run = currentRun(doc)
  if (run && !run.rulings_applied.some(a => a.task === t.id && a.title === E.title && a.option === String(option))) run.rulings_applied.push({ task: t.id, title: E.title, option: String(option) })
  for (const a of list(E, 'discarded_amendments')) {
    if (run) run.discarded_amendments.push({ task: t.id, id: a.id, reason: a.reason ?? '' })
    J('amendment', a.id ?? null, `amendment of ${a.id} discarded (${t.id}): ${a.reason ?? 'no reason'}`)
  }
  const skipped = add(doc, list(E, 'added_tasks'), t.id, tools)
  logAmendments(E, J, t.id)
  return { view: true, message: `ruling ${t.id} option ${option}; PROGRESS.md regenerated${notAdded(skipped)}` }
}

// ─── Rulings by reference (0.20.0, decision D1) ────────────────────────────────────────────────────────────────────
// rule records the user's answer to an open issue in progress.json only (pending_rulings): during a run, nothing tracked by
// git may be written. apply reports it into ISSUES.json, HANDOFF.md and the tasks, then commits; until then unrule withdraws it.
// An issue is looked up by its id in progress.json (the copy the pane shows) and in ISSUES.json (the whole issue, which
// prevails for the options and the status); settled in either one, it is settled.
function findIssue(doc, x, cmd, tools) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) refuse(`${cmd}: each item is an object { issue${cmd === 'rule' ? ', option } or { issue, text' : ''} }`)
  if (typeof x.issue !== 'string' || !RE_ISSUE.test(x.issue)) refuse(`${cmd}: "issue" must be the id of an issue, such as T02-1 (${describe(x.issue)} received)`)
  const copy = doc.issues.find(p => p.id === x.issue) || null, entry = tools.register().issues.find(p => p.id === x.issue) || null
  if (!copy && !entry) refuse(`${cmd}: unknown issue ${x.issue}`)
  const state = entry && entry.status !== 'open' ? entry.status : copy && copy.status === 'settled' ? 'settled' : 'open'
  return { id: x.issue, task: (entry || copy).task, state, options: (entry || copy).options, pending: doc.pending_rulings.find(r => r.issue === x.issue) || null }
}
const answer = r => (r.option != null ? `option ${r.option}` : 'a free answer')
function rule(doc, E, { J, at, ...tools }) {
  const seen = new Set()
  const rulings = itemsOf(E, 'rule').map(x => {
    const p = findIssue(doc, x, 'rule', tools)
    if (seen.has(p.id)) refuse(`rule: issue ${p.id} given twice`)
    seen.add(p.id)
    if (p.state !== 'open') refuse(`rule: issue ${p.id} already ${p.state}`)
    if (p.pending) refuse(`rule: issue ${p.id} already has a ruling recorded (${answer(p.pending)}); unrule it first`)
    if ((x.option == null) === (x.text == null)) refuse(`rule: ${p.id}: give "option" or "text", not ${x.option == null ? 'neither' : 'both'}`)
    if (x.text != null) {
      const text = typeof x.text === 'string' ? squash(x.text) : ''
      if (!text) refuse(`rule: ${p.id}: "text" must be a non-empty text`)
      return { p, r: { issue: p.id, option: null, text, at } }
    }
    if (typeof x.option !== 'string' || !x.option) refuse(`rule: ${p.id}: "option" must be the id of an option`)
    const o = p.options.find(o => o.id === x.option)
    if (!o) refuse(`rule: option ${x.option} absent from issue ${p.id} (${p.options.map(o => o.id).join(', ') || 'it has no option'}): give a text instead`)
    if (o.valid === false) refuse(`rule: option ${x.option} of ${p.id} is invalid: ${o.invalid_reason || 'refused by the dry run'}`)
    return { p, r: { issue: p.id, option: x.option, text: null, at } }
  })
  for (const { p, r } of rulings) {
    doc.pending_rulings.push(r)
    J('ruling', p.task, `${r.issue}: ${answer(r)} recorded`)
  }
  return { message: rulings.length === 1 ? `${rulings[0].r.issue}: ${answer(rulings[0].r)} recorded; it leaves "Your turn"` : `${rulings.length} rulings recorded; they leave "Your turn"` }
}
function unrule(doc, E, { J, ...tools }) {
  const seen = new Set()
  const drop = itemsOf(E, 'unrule').map(x => {
    const p = findIssue(doc, x, 'unrule', tools)
    if (seen.has(p.id)) refuse(`unrule: issue ${p.id} given twice`)
    seen.add(p.id)
    if (p.state !== 'open') refuse(`unrule: the ruling of ${p.id} is already applied (issue ${p.state})`)
    if (!p.pending) refuse(`unrule: no ruling recorded for ${p.id}`)
    return p
  })
  for (const p of drop) {
    doc.pending_rulings.splice(doc.pending_rulings.indexOf(p.pending), 1)
    J('ruling', p.task, `${p.id}: ${answer(p.pending)} withdrawn`)
  }
  return { message: drop.length === 1 ? `${drop[0].id}: ruling withdrawn; back in "Your turn"` : `${drop.length} rulings withdrawn; back in "Your turn"` }
}

function runEnd(doc, E, tools) {
  const { J, at } = tools
  const run = currentRun(doc) || refuse('no run in progress: run run-start first')
  if (!RUN_ENDS.includes(E.status)) refuse(`run-end: unknown status "${E.status}" (${RUN_ENDS.join(', ')})`)
  run.status = E.status
  run.end = at
  run.detail = E.detail == null ? null : Array.isArray(E.detail) ? E.detail.map(String).join('; ') : String(E.detail)
  const ids = k => list(E, k).map(x => (typeof x === 'string' ? x : x && x.id))
  // Rulings applied and amendments discarded (0.20.0): what apply, close and ruling already noted in this run stays; the summary
  // only adds what is not there yet (same task, title and option; same task and id). A summary with empty lists erases nothing.
  for (const a of list(E, 'rulings_applied').map(objectOf).map(a => ({ task: a.task, title: a.title, option: String(a.option && typeof a.option === 'object' ? a.option.id : a.option) }))) {
    if (!run.rulings_applied.some(y => y.task === a.task && y.title === a.title && y.option === a.option)) run.rulings_applied.push(a)
  }
  for (const a of list(E, 'discarded_amendments').map(objectOf).map(a => ({ task: a.task, id: a.id, reason: a.reason ?? '' }))) {
    if (!run.discarded_amendments.some(y => y.task === a.task && y.id === a.id)) run.discarded_amendments.push(a)
  }
  // Added tasks: the summary does not know those of the rulings, already noted by the ruling command; we complete without removing.
  // A summary task missing from the progress file (close not written) gets in, with the task that created it if the summary gives it.
  let viewNeeded = false
  for (const x of list(E, 'added_tasks')) {
    if (!x || !RE_ID.test(x.id || '')) continue
    if (!doc.tasks.some(t => t.id === x.id)) { const before = doc.tasks.length; add(doc, [x], RE_ID.test(x.added_by || '') ? x.added_by : null, tools); viewNeeded ||= doc.tasks.length > before }
    if (!run.added_tasks.some(y => y.id === x.id)) run.added_tasks.push({ id: x.id, phase: x.phase, title: x.title })
  }
  for (const k of ['deferred', 'not_started', 'waiting']) if (E[k]) run[k] = ids(k)
  if (E.waiting_on_prerequisites) run.waiting_on_prerequisites = list(E, 'waiting_on_prerequisites').map(x => ({ id: x.id, prerequisites: x.prerequisites || [] }))
  for (const d of list(E, 'auto_decisions')) {
    if (doc.auto_decisions.some(x => x.run === run.number && x.task === d.task && x.title === d.title && x.option === d.option)) continue
    doc.auto_decisions.push({ run: run.number, task: d.task, title: d.title, option: d.option, description: d.description })
    J('auto-decision', d.task, `${d.task}: "${d.title}", option ${d.option} taken automatically`)
  }
  // Summary issues: the stop issue and the open issues, matched with those the scribe already noted
  for (const [p, role] of [...(E.stop_issue ? [[E.stop_issue, 'stop']] : []), ...list(E, 'open_issues').map(p => [p, 'open'])]) {
    const already = doc.issues.find(x => x.run === run.number && x.task === p.task && x.title === p.title)
    if (already) { already.role = role; continue }
    doc.issues.push(issueOf(doc, p, run.number, p.task, role, tools))
    J('issue', p.task, `${p.task}: issue "${p.title}"${role === 'stop' ? ', which stops the run' : ''}`)
  }
  // Workflow exception: a summary task without a close in this run is closed here, from the summary
  const start = Date.parse(run.start)
  for (const r of list(E, 'tasks')) {
    const t = doc.tasks.find(x => x.id === r.id)
    if (!t || !r.status || !(t.step || !t.end || Date.parse(t.end) < start)) continue
    Object.assign(t, { status: r.status, attempts: r.attempts ?? t.attempts, branch: r.branch !== undefined ? r.branch : t.branch, blocker: r.blocker ?? [], end: at, step: null })
    J('status', t.id, `${t.id}: ${r.status}, closed at the run end without a scribe${t.blocker.length ? ' — ' + t.blocker[0] : ''}`)
    viewNeeded = true
  }
  for (const t of doc.tasks.filter(t => t.step)) { J('step', t.id, `${t.id}: step "${t.step}" without a close at the end of the run`); t.step = null }
  J(E.status === 'error' ? 'error' : 'run', null, `run ${run.number}: ${E.status}${run.detail ? ' — ' + run.detail : ''}`)
  return { view: viewNeeded, message: `run ${run.number} ${E.status}${viewNeeded ? '; PROGRESS.md regenerated, to commit' : ''}` }
}

function pilot(doc, E, { J, at }) {
  const t = taskOf(doc, E.task)
  if (!['merged', 'cancelled'].includes(E.status)) refuse(`pilot: status "${E.status}" not allowed (merged or cancelled)`)
  Object.assign(t, { status: E.status, step: null, ...(E.status === 'merged' ? { end: at, blocker: [] } : {}) })
  J('pilot', t.id, `${t.id}: ${E.status} by the pilot${E.reason ? ' — ' + E.reason : ''}`)
  return { view: true, message: `${t.id} ${E.status}; PROGRESS.md regenerated, to commit` }
}

// A review or an auto-decision closed by the pilot: done (0.15.1) or moved to tickets (0.16.0). It stays in progress.json,
// with its date, so that neither HANDOFF.md (mergeReviews) nor a close brings it back. Matched on its key, the exact text
// (the review's, or the decision's title), otherwise on a unique start of it; a list is checked whole before any change.
const squash = x => String(x ?? '').replace(/\s+/g, ' ').trim()
const closedAs = x => (x.done ? 'done' : x.ticket ? 'ticket' : null)
const CLOSED_WORDS = { done: 'done', ticket: 'moved to tickets' }
// The items of a call: the object itself, or its "items" list
function itemsOf(E, cmd) {
  if (E.items === undefined) return [E]
  if (!Array.isArray(E.items) || !E.items.length) refuse(`${cmd}: "items" must be a non-empty list`)
  return E.items
}
// The review or auto-decision an object names; `wanted` picks among those with that text the ones the command acts on
function findItem(doc, E, cmd, wanted) {
  if (!E || typeof E !== 'object' || Array.isArray(E)) refuse(`${cmd}: each item is an object { kind, task, text }`)
  if (!['review', 'decision'].includes(E.kind)) refuse(`${cmd}: kind "${E.kind}" not allowed (review or decision)`)
  const text = squash(E.text)
  if (!text) refuse(`${cmd}: text expected (the text of the review, or the title of the decision)`)
  const task = E.task == null || E.task === '' || E.task === '-' || E.task === 'source plan' ? null : String(E.task)
  if (task != null && !RE_ID.test(task)) refuse(`${cmd}: task "${task}" is not a task id`)
  const items = E.kind === 'review' ? doc.reviews : doc.auto_decisions
  const key = x => squash(E.kind === 'review' ? x.text : x.title)
  const same = items.filter(x => (x.task ?? null) === task)
  let found = same.filter(x => key(x) === text)
  if (!found.length) found = same.filter(x => key(x).startsWith(text.replace(/…$/, '')))
  const what = `${E.kind === 'review' ? 'review' : 'auto-decision'} of ${task ?? 'the source plan'}`
  if (!found.length) refuse(`${cmd}: no ${what} "${clip(text, 60)}" in progress.json`)
  const picked = found.filter(wanted), pool = picked.length ? picked : found
  if (new Set(pool.map(key)).size > 1) refuse(`${cmd}: ${pool.length} ${E.kind === 'review' ? 'reviews' : 'auto-decisions'} of ${task ?? 'the source plan'} start with "${clip(text, 60)}": give the whole text`)
  return { picked, found, what, task, name: key(pool[0]) }
}
function closeItems(doc, E, J, at, cmd, state) {
  const results = itemsOf(E, cmd).map(x => findItem(doc, x, cmd, y => !closedAs(y)))
  const touched = new Set()
  let changed = 0
  for (const r of results) {
    const fresh = r.picked.filter(x => !touched.has(x))
    if (!fresh.length) continue
    for (const x of fresh) { x[state] = at; touched.add(x) }
    changed++
    J('pilot', r.task, `${r.what} ${CLOSED_WORDS[state]} by the pilot: ${clip(r.name, 80)}`)
  }
  if (results.length === 1) {
    const r = results[0]
    return { message: changed ? `${r.what} ${CLOSED_WORDS[state]}; it leaves "Your turn"` : `${r.what} already ${CLOSED_WORDS[closedAs(r.found[0]) || state]}` }
  }
  const already = results.length - changed
  return { message: `${changed} ${CLOSED_WORDS[state]}; ${changed === 1 ? 'it leaves' : 'they leave'} "Your turn"${already ? `; ${already} already closed` : ''}` }
}
const ack = (doc, E, { J, at }) => closeItems(doc, E, J, at, 'ack', 'done')
const ticket = (doc, E, { J, at }) => closeItems(doc, E, J, at, 'ticket', 'ticket')

// The plan closed by the pilot (0.16.1, [ Close the plan ] of /progress): once every task is merged or cancelled and no run
// is in progress. What is left open in "Your turn" stays open, listed in the PR draft; the mod no longer follows the plan
function closePlan(doc, E, { J, at }) {
  if (doc.closed) return { message: 'plan already closed' }
  const run = doc.runs.find(r => r.status === 'in-progress')
  if (run) refuse(`close-plan: run ${run.number} is in progress; a plan closes between two runs`)
  const left = doc.tasks.filter(t => !DONE(t.status))
  if (left.length) refuse(`close-plan: ${plural(left.length, 'task')} neither merged nor cancelled (${left.slice(0, 4).map(t => `${t.id} ${t.status}`).join(', ')}${left.length > 4 ? ', …' : ''}); cancel or merge ${left.length > 1 ? 'them' : 'it'} first`)
  const open = [...doc.reviews, ...doc.auto_decisions].filter(x => !closedAs(x)).length
  doc.closed = at
  J('pilot', null, `plan closed by the pilot${open ? `, ${plural(open, 'item')} left open in "Your turn"` : ''}`)
  return { message: `plan closed${open ? `, ${plural(open, 'item')} left open (in the PR draft)` : ''}; /progress no longer follows it` }
}
function reopenPlan(doc, E, { J }) {
  if (!doc.closed) return { message: 'plan already open' }
  delete doc.closed
  J('pilot', null, 'plan open again by the pilot')
  return { message: 'plan open again; /progress follows it' }
}

// Undo of the /progress pane (0.16.0): back in "Your turn"
function reopen(doc, E, { J }) {
  const results = itemsOf(E, 'reopen').map(x => findItem(doc, x, 'reopen', y => !!closedAs(y)))
  let changed = 0
  for (const r of results) {
    if (!r.picked.length) continue
    for (const x of r.picked) { delete x.done; delete x.ticket }
    changed++
    J('pilot', r.task, `${r.what} open again by the pilot: ${clip(r.name, 80)}`)
  }
  if (results.length === 1) return { message: changed ? `${results[0].what} open again; back in "Your turn"` : `${results[0].what} already open` }
  return { message: `${changed} open again; back in "Your turn"` }
}

// The text shown for a review or an auto-decision (0.16.0); its key does not change
function relabel(doc, E, { J }) {
  if (E.items !== undefined) refuse('relabel: one item at a time')
  if (E.label != null && typeof E.label !== 'string') refuse('relabel: "label" must be a text, or null for the original')
  const r = findItem(doc, E, 'relabel', () => true)
  const label = squash(E.label)
  const items = r.picked.length ? r.picked : r.found
  const original = !label || label === r.name
  for (const x of items) { if (original) delete x.label; else x.label = label }
  J('pilot', r.task, original ? `${r.what}: original text back` : `${r.what}: text changed by the pilot: ${clip(label, 80)}`)
  return { message: original ? `${r.what}: original text back` : `${r.what}: text changed; HANDOFF.md keeps the original` }
}

// ─── Read: plan status, as status.mjs, with the current step when a run is going ───────────────────────────────
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`
const bar = (r, n) => { const k = Math.floor(r * n); return '█'.repeat(k) + '░'.repeat(n - k) }
const pct = (f, n) => Math.floor((100 * f) / n)
const ago = ts => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts))
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
}
const shorten = (xs, max) => (xs.length > max ? [...xs.slice(0, max - 1), `+${xs.length - max + 1}`] : xs)
// ── moments:begin ── The moment of what waits for the user (0.19.0) ──────────────────────────────────────────────────────
// The rules of "Your turn" in hooks/view-model.mjs, written a second time: the scripts load nothing from the mod.
// tests/status.test.mjs compares them with the mod on the same progress.json, and this block with its copy (status.mjs and
// progress.mjs carry the same one). Moment and rank, as in the pane:
//   task that waits for someone (needs-human, blocked, failed) .......... now; at run stop if it carries an open issue, during a run
//   open issue (also on a waiting task), plan-lint in error ............. now; at run stop during a run (they need the session)
//   decision to take that holds back a task of the phase in progress .... now; at run stop during a run
//   manual or environment prerequisite holding back such a task ......... now, run or not
//   prerequisite that holds back a task of a later phase k ............. before phase k
//   prerequisite that holds back no task left ........................... before the next (first) run, rank 98
//   review of a task of phase k ......................................... after phase k
//   auto-decision of a task of phase k .................................. before phase k + 1
//   auto-decision of the last phase; review of the source plan, or of a plan all merged ... before the PR
// P: { now, updated, tasks: [{ id, phase, status, step, start, end }] (cancelled included), runs: [{ status, phase, start, ruled }],
//      prerequisites: open [{ id, type, blocks }], issues: open [{ task }], reviews: open [{ task, phase, text }],
//      decisions: open [{ task }], lint: { ok, errors }, tickets, note }; dates in ms. Returns the lines of the answer.
function momentLines(P) {
  const WAITS = { 'needs-human': 'waits for a human', blocked: 'blocked', failed: 'failed' }
  const { tasks, runs } = P
  const open = tasks.filter(t => t.status !== 'cancelled'), merged = t => t.status === 'merged'
  const run = runs.at(-1) ?? null, live = !!run && run.status === 'in-progress'
  // A run in progress that has not written for 45 minutes gives no news: its tasks in a step no longer count as running
  const active = live && !(P.updated != null && P.now - P.updated >= 45 * 60000)
  const NOW = { moment: 'now', rank: 0 }, STOP = { moment: 'at run stop', rank: 0.2 }, PR = { moment: 'before the PR', rank: 99 }
  const after = k => ({ moment: `after phase ${k}`, rank: k }), before = k => ({ moment: `before phase ${k}`, rank: k - 0.5 })
  const session = live ? STOP : NOW
  const lineOf = m => (m === 'now' ? 'now' : m === 'at run stop' ? 'stop' : 'later')
  const phaseOf = id => tasks.find(t => t.id === id)?.phase ?? null
  const phases = [...new Set(open.map(t => t.phase))].sort((a, b) => a - b)
  const maxPhase = phases.at(-1) ?? 0, allMerged = open.length > 0 && open.every(merged)
  // The phase in progress: the one of the run (the highest of the tasks it started or closed), otherwise the first not finished
  const touched = run && run.start != null ? open.filter(t => (t.start != null && t.start >= run.start) || (t.end != null && t.end >= run.start)) : []
  const cur = live ? Math.max(run.phase, ...touched.map(t => t.phase)) : phases.find(k => !open.filter(t => t.phase === k).every(merged)) ?? null
  const items = []
  const put = (order, at, f) => items.push({ order, ...at, ...f })
  const seen = new Set()
  for (const t of open.filter(t => t.status in WAITS && !(active && t.step) && !(live && run.ruled.includes(t.id)))) {
    const p = P.issues.find(x => x.task === t.id)
    if (p) seen.add(p)
    put(1, p ? session : NOW, { text: `${t.id} ${WAITS[t.status]}` })
  }
  for (const p of P.issues) if (!seen.has(p)) put(2, session, { count: 'issue' })
  for (const p of P.prerequisites) {
    const held = tasks.filter(t => p.blocks.includes(t.id) && t.status !== 'merged' && t.status !== 'cancelled')
    const first = held.length ? Math.min(...held.map(t => t.phase)) : null
    const at = first == null ? { moment: runs.length ? 'before the next run' : 'before the first run', rank: 98 } : cur != null && first > cur ? before(first) : NOW
    const when = p.type === 'decision' && at.moment === 'now' ? session : at
    put(0, when, { text: lineOf(when.moment) === 'later' ? `${p.id} ${when.moment}` : `${p.id} (${p.type}) blocks ${shorten(p.blocks, 4).join(', ')}` })
  }
  if (!P.lint.ok) put(3, session, { text: `plan-lint: ${plural(P.lint.errors, 'error')}` })
  // Two open reviews of the same task are one when their first backquoted passage is the same (D5)
  const twins = new Set()
  for (const r of P.reviews) {
    const m = /`([^`]+)`/.exec(r.text)
    if (m) { const k = `${r.task ?? ''}|${m[1]}`; if (twins.has(k)) continue; twins.add(k) }
    const phase = r.phase ?? phaseOf(r.task)
    put(4, allMerged || phase == null ? PR : after(phase), { count: 'review' })
  }
  for (const d of P.decisions) {
    const phase = phaseOf(d.task)
    put(5, allMerged || phase == null || phase >= maxPhase ? PR : before(phase + 1), { count: 'auto-decision' })
  }
  // By rank, then prerequisites, tasks, issues, plan-lint, reviews, auto-decisions; the same kind at the same moment is counted
  items.sort((a, b) => a.rank - b.rank || a.order - b.order)
  const entries = []
  for (const it of items) {
    const same = it.count && entries.find(e => e.count === it.count && e.moment === it.moment)
    if (same) same.n++
    else entries.push({ line: lineOf(it.moment), moment: it.moment, count: it.count, n: 1, text: it.text })
  }
  if (P.note) entries.push({ line: 'now', text: P.note })
  if (P.tickets) entries.push({ line: 'later', text: `${plural(P.tickets, 'ticket')} after the PR` })
  const say = e => (e.count ? `${e.count === 'issue' ? `${plural(e.n, 'issue')} to settle` : plural(e.n, e.count)}${e.line === 'later' ? ` ${e.moment}` : ''}` : e.text)
  const lines = [['now', 'Now'], ['stop', 'At run stop'], ['later', 'Later']].map(([k, title]) => [title, entries.filter(e => e.line === k).map(say)]).filter(([, xs]) => xs.length)
    .map(([title, xs]) => `**${title}**: ${shorten(xs, 6).join(' · ')}`)
  return lines.length ? lines : ['**Your turn**: nothing for now']
}
// ── moments:end ──

function status(arg) {
  let ctx
  try { ctx = locate(arg) } catch (e) { return `orchestre:status: ${e.message}` }
  const { root, dir, name, integration: integ } = ctx
  const L = planLint(ctx)
  if (!L.tasks) return `orchestre:status: ${L.errors[0]}`
  const handoff = readOrNull(join(dir, 'HANDOFF.md')) || ''
  // progress.json if it exists, otherwise its rebuild in memory; nothing is written
  let doc = null, note = null
  try { doc = load(ctx) || rebuild(ctx, L, handoff, now()) } catch (e) { note = `progress.json: ${e.message.split('\n')[0]}` }
  const S = new Map((doc ? doc.tasks : []).map(t => [t.id, t]))
  const run = doc ? currentRun(doc) : null
  // git is the source of truth for "merged"; otherwise the progress file, fresher than PROGRESS.md during a run
  const statusOf = t => (t.status === 'merged' ? 'merged' : S.get(t.id)?.status ?? t.status)
  const all = L.tasks.map(t => ({ ...t, status: statusOf(t) }))
  const active = all.filter(t => t.status !== 'cancelled')
  if (!active.length) return `orchestre:status: no task in ${ctx.rel}`
  const done = t => t.status === 'merged'
  const ATTENTION = { 'needs-human': 'waits for a human', blocked: 'blocked', failed: 'failed' }
  const inStep = t => run && S.get(t.id)?.step

  const refs = (attempt(() => git(['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads/task/', 'refs/heads/tache/'], root)) || '')
    .split('\n').filter(Boolean).map(l => { const [r, ts] = l.split('\t'); return { ref: r, ts: Number(ts), id: r.replace(/^(task|tache)\//, '').replace(/-r\d+$/, '') } })
  const head = attempt(() => git(['symbolic-ref', '-q', '--short', 'HEAD'], root).trim()) || ''
  const worktrees = new Set((attempt(() => git(['worktree', 'list', '--porcelain'], root)) || '').split(/\n\s*\n/).slice(1).map(b => (b.match(/^branch refs\/heads\/(.+)$/m) || [])[1]).filter(Boolean))
  const inProgress = []
  for (const t of active) {
    if (done(t)) continue
    const s = S.get(t.id)
    if (inStep(t)) {
      inProgress.push({ id: t.id, text: `${t.id} (${[s.step, s.isolated === true ? 'worktree' : s.isolated === false ? 'checkout' : null, s.start ? `started ${ago(Date.parse(s.start) / 1000)}` : null].filter(Boolean).join(', ')})` })
      continue
    }
    if (ATTENTION[t.status]) continue
    const b = refs.filter(x => x.id === t.id).sort((x, y) => y.ts - x.ts)[0]
    if (!b) continue
    const ahead = Number(attempt(() => git(['rev-list', '--count', `${integ}..${b.ref}`], root).trim()) || 0)
    const where = b.ref === head ? 'checkout' : worktrees.has(b.ref) ? 'worktree' : null
    inProgress.push({ id: t.id, text: `${t.id} (${[where, ahead ? `last commit ${ago(b.ts)}` : 'started'].filter(Boolean).join(', ')})` })
  }

  const exists = b => attempt(() => git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], root)) != null
  const base = ctx.base || ['main', 'master'].find(exists)
  const log = attempt(() => git(['log', '--first-parent', '--format=%ct%x09%s', base && base !== integ ? `${base}..${integ}` : integ, '--'], root)) || ''
  const merge = log.split('\n').map(l => l.split('\t')).find(([, s]) => MERGE.test(s || ''))

  // What waits for the user, by moment (0.19.0). The reviews still open in the progress file (those marked done, 0.15.1, or
  // moved to tickets, 0.16.0, no longer wait), otherwise those of HANDOFF.md, whose phase is unknown; the tickets of
  // HANDOFF.md, and the reviews and auto-decisions moved to tickets
  const counts = parseHandoff(handoff).counts
  const count = type => Object.values(counts).reduce((n, c) => n + (c[type] ? c[type].minor + c[type].major : 0), 0)
  const ms = x => { const t = typeof x === 'string' ? Date.parse(x) : NaN; return Number.isNaN(t) ? null : t }
  // An issue whose ruling is recorded (rule, 0.20.0) and not applied yet no longer waits for the user
  const ruled = new Set((doc ? doc.pending_rulings : []).map(r => r.issue))
  const yourTurn = momentLines({
    now: Date.now(), updated: doc ? ms(doc.updated) : null,
    tasks: all.map(t => { const s = S.get(t.id); return { id: t.id, phase: t.phase, status: t.status, step: typeof s?.step === 'string' ? s.step : null, start: ms(s?.start), end: ms(s?.end) } }),
    runs: doc ? doc.runs.map(r => ({ status: r.status, phase: Number.isInteger(r.phase) ? r.phase : 0, start: ms(r.start), ruled: (r.rulings_applied || []).map(a => a.task) })) : [],
    prerequisites: (L.prerequisites || []).filter(x => x.status === 'open').map(p => ({ id: p.id, type: p.type, blocks: p.blocks || [] })),
    issues: doc ? doc.issues.filter(p => p.status !== 'settled' && !ruled.has(p.id)).map(p => ({ task: p.task })) : [],
    reviews: doc ? doc.reviews.filter(r => !closedAs(r)).map(r => ({ task: r.task ?? null, phase: Number.isInteger(r.phase) ? r.phase : null, text: String(r.text ?? '') })) : parseHandoff(handoff).reviews.map(r => ({ task: r.task, phase: null, text: r.text })),
    decisions: doc ? doc.auto_decisions.filter(d => !closedAs(d)).map(d => ({ task: d.task })) : [],
    lint: { ok: !!L.ok, errors: (L.errors || []).length },
    tickets: count('ticket') + (doc ? [...doc.reviews, ...doc.auto_decisions].filter(x => closedAs(x) === 'ticket').length : 0), note,
  })

  const phases = [...new Set(active.map(t => t.phase))].sort((a, b) => a - b)
  const started = ph => active.some(t => t.phase === ph && (done(t) || inProgress.some(e => e.id === t.id)))
  const current = phases.find(ph => active.some(t => t.phase === ph && !done(t)))
  const doneCount = active.filter(done).length
  const m = merge && merge[1].match(MERGE)
  const out = [
    `## ${name} — ${doneCount}/${plural(active.length, 'task')} · ${pct(doneCount, active.length)}%`,
    `\`${bar(doneCount / active.length, 24)}\` ${current == null ? `plan finished${doc && doc.closed ? ', closed' : ''}` : `phase ${current} ${started(current) ? 'in progress' : 'not started'}`}${m ? ` · last merge ${m[1] || m[2]} ${ago(Number(merge[0]))}` : ''}${run ? ` · run ${run.number} (${run.mode}) opened ${ago(Date.parse(run.start) / 1000)}` : ''}`,
    '',
    '| Phase | Progress | Tasks |',
    '| :-- | :-- | :-- |',
  ]
  for (const ph of phases) {
    const ts = active.filter(t => t.phase === ph), f = ts.filter(done).length
    const sym = f === ts.length ? '✓' : ts.some(t => ATTENTION[t.status] && !inStep(t)) ? '⚠' : started(ph) ? '●' : '○'
    out.push(`| ${sym} ${ph} | \`${bar(f / ts.length, 10)}\` ${pct(f, ts.length)}% | ${f}/${ts.length} |`)
  }
  if (inProgress.length) out.push('', `**In progress**: ${shorten(inProgress.map(e => e.text), 5).join(' · ')}`)
  out.push('', ...yourTurn)
  return out.join('\n')
}

// ─── Read: end-of-run triage ─────────────────────────────────────────────────────────────────────────────────────
// What the pilot may close alone (D6) is decided here, by four cases; everything else is offered, never closed. Writes nothing.
//   duplicate      two open reviews of one task (or of the source plan) with the same first backquoted passage (D5): the later one
//   superseded     an open auto-decision whose issue a ruling of the user settled in a later run
//   no-diff        a review "<file>: unreadable by the agents…" whose file no longer differs between the base and the integration branch
//   worktree-gone  a review "worktree <path> kept…" whose folder no longer exists
// A review that asks to change a file forbidden to the agents is free text: it matches none of them and stays open.
const FIRST_TICKS = /`([^`]+)`/
const UNREADABLE = /^`?([^\s`:]+)`?: unreadable by the agents\b/
const WORKTREE_KEPT = /^worktree (.+?) kept\b/
function triage(arg) {
  const ctx = locate(arg)
  const handoff = readOrNull(join(ctx.dir, 'HANDOFF.md')) || ''
  let doc = load(ctx)
  if (!doc) {
    const L = planLint(ctx)
    if (!L.tasks) refuse(`${L.errors[0]}: progress.json missing, it cannot be rebuilt without plan-lint`)
    doc = rebuild(ctx, L, handoff, now())
  }
  const entries = [...doc.reviews.filter(x => !closedAs(x)).map(x => ({ kind: 'review', x })), ...doc.auto_decisions.filter(x => !closedAs(x)).map(x => ({ kind: 'decision', x }))]
  const textOf = e => (e.kind === 'review' ? e.x.text : e.x.title)
  const item = e => ({ kind: e.kind, task: e.x.task ?? null, text: textOf(e) })
  // What ack matches on: kind, task and the text squashed
  const ackKey = e => `${e.kind}\0${e.x.task ?? ''}\0${squash(textOf(e))}`
  const seen = new Set()
  const candidates = []
  const settle = (e, reason, detail, of) => { if (!seen.has(e)) { seen.add(e); candidates.push({ e, safe: { ...item(e), reason, detail, ...(of ? { of: item(of) } : {}) } }) } }

  const firstOf = new Map()
  for (const e of entries.filter(e => e.kind === 'review')) {
    const passage = e.x.text.match(FIRST_TICKS)?.[1]
    if (!passage) continue
    const k = `${e.x.task ?? ''}\0${passage}`
    if (!firstOf.has(k)) firstOf.set(k, e)
    else settle(e, 'duplicate', `same first passage \`${passage}\` as an earlier review`, firstOf.get(k))
  }
  for (const e of entries.filter(e => e.kind === 'decision')) {
    const ruling = doc.runs.filter(r => r.number > e.x.run).flatMap(r => r.rulings_applied.map(a => ({ ...a, run: r.number }))).find(a => a.task === e.x.task && squash(a.title) === squash(e.x.title))
    if (ruling) settle(e, 'superseded', `settled by the user in run ${ruling.run}: option ${ruling.option}, instead of ${e.x.option}`)
  }
  const exists = b => attempt(() => git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], ctx.root)) != null
  const base = ctx.base || ['main', 'master'].find(exists) || null
  // git diff --quiet: 0 no difference, 1 a difference, anything else (unknown branch or path) is not known
  const same = file => spawnSync('git', ['--literal-pathspecs', 'diff', '--quiet', base, ctx.integration, '--', file], { cwd: ctx.root, env: ENV, stdio: 'ignore' }).status === 0
  for (const e of entries.filter(e => e.kind === 'review')) {
    const file = e.x.text.match(UNREADABLE)?.[1]
    if (file && base && base !== ctx.integration && same(file)) settle(e, 'no-diff', `${file} has no difference between ${base} and ${ctx.integration}`)
    const path = e.x.text.match(WORKTREE_KEPT)?.[1]
    if (path && !existsSync(resolve(ctx.root, path))) settle(e, 'worktree-gone', `${path} no longer exists`)
  }
  // ack closes every open item that has the same key: a candidate is safe only when all of them are candidates
  const kept = candidates.filter(c => entries.filter(e => ackKey(e) === ackKey(c.e)).every(e => seen.has(e)))
  const safe = kept.map(c => c.safe), closing = new Set(kept.map(c => c.e))
  const groups = new Map()
  for (const e of entries) {
    if (closing.has(e)) continue
    if (!groups.has(e.x.task ?? null)) groups.set(e.x.task ?? null, [])
    groups.get(e.x.task ?? null).push(item(e))
  }
  const order = [null, ...doc.tasks.map(t => t.id)]
  const rank = t => (order.includes(t) ? order.indexOf(t) : order.length)
  const open = [...groups].sort((a, b) => rank(a[0]) - rank(b[0])).map(([task, items]) => ({ task, items }))
  return { plan: ctx.name, base, integration: ctx.integration, safe, open }
}

// ─── close writes and commits the plan (0.20.0) ────────────────────────────────────────────────────────────────────
// Before 0.20.0 the scribe wrote HANDOFF.md, the tasks created and the amendments by hand, then committed. close does it now,
// under the lock and on the integration branch only; any refusal puts every file it wrote back as it was.

// Fingerprint of a payload (0.20.0): the JSON the workflow hands to an agent for a progress command carries it in "_digest",
// the output of close in "digest". Keys sorted at every level, the field `skip` of the top level left out; FNV-1a on 32 bits,
// 8 hexadecimal digits. Self-contained: the workflow, which can load no module, carries the same text.
export function payloadDigest(p, skip = '_digest') {
  const sorted = (x, top) => (Array.isArray(x) ? x.map(y => sorted(y, false)) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).filter(k => !(top && k === skip)).sort().map(k => [k, sorted(x[k], false)])) : x)
  const c = JSON.stringify(sorted(p, true))
  let h = 0x811c9dc5
  for (let i = 0; i < c.length; i++) h = Math.imul(h ^ c.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}
// A JSON with "_digest" whose fingerprint differs was altered between the workflow and this script: refused, nothing written
function checkDigest(cmd, E) {
  if (!Object.hasOwn(E, '_digest')) return E
  const computed = payloadDigest(E)
  if (E._digest !== computed) refuse(`${cmd}: payload altered in transit (_digest ${describe(E._digest)}, ${computed} computed): nothing is written`)
  const { _digest, ...rest } = E
  return rest
}

// The main checkout must be on the integration branch: a blocked or failed task of the main checkout leaves it on task/<id>
function onIntegration(ctx, cmd) {
  const head = attempt(() => git(['symbolic-ref', '--quiet', '--short', 'HEAD'], ctx.root).trim())
  if (head !== ctx.integration) refuse(`${cmd}: the main checkout is on ${head ? `the branch ${head}` : 'a detached HEAD'}, not on the integration branch ${ctx.integration}: nothing is written; run git switch ${ctx.integration} first`)
}

// Amendment of a task: the items appended to the end of its frontmatter lists, without removing or rewording anything; an item
// already in the list is not added twice. A list written inline ([a, b]) stays inline. null without a frontmatter.
const AMENDED_LISTS = ['definition_of_done', 'owned_files', 'verification', 'depends_on']
const yamlItem = x => (RE_ID.test(x) ? x : JSON.stringify(x))
export function amendText(text, am) {
  const m = text.match(/^---(\r?\n)([\s\S]*?)\r?\n---/)
  if (!m) return null
  const eol = m[1], lines = m[2].split(/\r?\n/)
  for (const k of AMENDED_LISTS) {
    const items = (Array.isArray(am[k]) ? am[k] : []).map(squash).filter(Boolean)
    if (!items.length) continue
    const i = lines.findIndex(l => l.startsWith(`${k}:`))
    if (i < 0) { lines.push(`${k}:`, ...[...new Set(items)].map(x => `  - ${yamlItem(x)}`)); continue }
    const rest = lines[i].slice(k.length + 1).trim()
    if (rest) {
      const inner = rest.startsWith('[') ? rest.replace(/^\[/, '').replace(/\]\s*(#.*)?$/, '') : rest
      const have = inner.split(',').map(s => s.trim()).filter(Boolean)
      const fresh = [...new Set(items)].filter(x => !have.map(unquote).includes(x))
      if (fresh.length) lines[i] = `${k}: [${[...have, ...fresh.map(yamlItem)].join(', ')}]`
      continue
    }
    let j = i + 1
    while (j < lines.length && /^\s+-\s/.test(lines[j])) j++
    const indent = j > i + 1 ? lines[i + 1].match(/^\s+/)[0] : '  '
    const have = lines.slice(i + 1, j).map(l => unquote(l.replace(/^\s+-\s+/, '')))
    lines.splice(j, 0, ...[...new Set(items)].filter(x => !have.includes(x)).map(x => `${indent}- ${yamlItem(x)}`))
  }
  return `---${eol}${lines.join(eol)}${eol}---${text.slice(m[0].length)}`
}
// The task files of a plan folder, by the id of their frontmatter
function taskFiles(dir) {
  const out = new Map(), t = join(dir, 'tasks')
  for (const f of (attempt(() => readdirSync(t)) || []).filter(f => f.endsWith('.md')).sort()) {
    const id = ((readOrNull(join(t, f)) || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '').match(/^id:[ \t]*(.*)$/m)
    if (id && !out.has(unquote(id[1]))) out.set(unquote(id[1]), join(t, f))
  }
  return out
}
const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-')
// What added tasks and amendments do to a plan folder: a task is created from its content (one already there is left as is);
// an amendment of a task merged or cancelled is discarded, of a task missing from the plan refused. keep(file) is called
// before a file is written, so that it can be put back.
function applyActions(dir, statuses, { added_tasks, amendments }, keep = () => {}) {
  const files = taskFiles(dir), created = [], amended = [], discarded = [], refused = []
  for (const x of added_tasks) {
    if (!x || !RE_ID.test(x.id || '')) { refused.push({ id: String((x && x.id) ?? '?'), reason: 'added task without a valid id' }); continue }
    if (files.has(x.id)) continue
    if (typeof x.content !== 'string' || !x.content.trim()) { refused.push({ id: x.id, reason: `no task file for ${x.id}, and no content to create it` }); continue }
    const f = join(dir, 'tasks', `${x.id}${slug(x.title) ? '-' + slug(x.title) : ''}.md`)
    if (existsSync(f)) { refused.push({ id: x.id, reason: `${basename(f)} already exists for another task` }); continue }
    keep(f)
    writeFileSync(f, x.content)
    files.set(x.id, f)
    created.push({ id: x.id, file: f })
  }
  for (const a of amendments) {
    if (!a || !RE_ID.test(a.id || '')) { refused.push({ id: String((a && a.id) ?? '?'), reason: 'amendment without a valid id' }); continue }
    const f = files.get(a.id), reason = a.reason ?? 'no reason'
    if (!f) { refused.push({ id: a.id, reason: `amends ${a.id}, a task missing from the plan` }); continue }
    if (DONE(statuses.get(a.id))) { discarded.push({ id: a.id, reason }); continue }
    const text = amendText(readFileSync(f, 'utf8'), a)
    if (text == null) { refused.push({ id: a.id, reason: `${basename(f)}: frontmatter not found` }); continue }
    keep(f)
    writeFileSync(f, text)
    amended.push({ id: a.id, file: f, reason })
  }
  return { created, amended, discarded, refused }
}
// An error of plan-lint names a task when its id stands alone in it (T01 does not name T01B)
const names = (e, id) => new RegExp(`(?:^|[^A-Za-z0-9])${id}(?:[^A-Za-z0-9]|$)`).test(e)
// plan-lint on the plan as close left it: a task created or amended that a new error names, or that plan-lint does not read,
// is put back as it was; a new error that names none of them puts them all back. Returns plan-lint on the final plan.
function lintTouched(ctx, L0, touched, restore) {
  const before = new Set(L0.tasks ? L0.errors : [])
  let L = touched.length ? planLint(ctx) : L0
  for (;;) {
    const live = touched.filter(t => !t.out)
    if (!live.length) return L
    const fresh = L.tasks ? L.errors.filter(e => !before.has(e)) : [L.errors[0]]
    const why = t => [...(L.tasks && t.kind === 'created' && !L.tasks.some(x => x.id === t.id) ? [`no task ${t.id} in ${basename(t.file)}`] : []), ...(L.tasks ? fresh.filter(e => names(e, t.id)) : fresh)]
    let bad = live.filter(t => why(t).length)
    const reason = t => clip(`plan-lint: ${(why(t).length ? why(t) : fresh).join('; ')}`, 300)
    if (!bad.length && fresh.length) bad = live
    if (!bad.length) return L
    for (const t of bad) for (const u of live) if (u.file === t.file && !u.out) { u.out = reason(t); restore(u.file) }
    L = planLint(ctx)
  }
}
// A task created that shares files with a task of its phase, without a dependency between them (plan-lint's overlaps,
// 0.20.0): it gets a dependency on that task, written into its file; of two tasks created, the later one depends on the
// earlier one. Same rule for close, its dry run and apply. Returns the dependencies added: [{ task, on, files, phase }]
function dependOnOverlaps(created, L) {
  const ids = created.map(x => x.id), deps = []
  for (const v of (L.tasks && Array.isArray(L.overlaps) ? L.overlaps : [])) {
    const ia = ids.indexOf(v.a), ib = ids.indexOf(v.b)
    if (ia < 0 && ib < 0) continue
    const [task, on] = ia > ib ? [v.a, v.b] : [v.b, v.a]
    deps.push({ task, on, files: (v.files || []).map(String), phase: L.tasks.find(t => t.id === task)?.phase ?? null })
  }
  for (const d of deps) {
    const f = created.find(x => x.id === d.task).file, text = readFileSync(f, 'utf8')
    writeFileSync(f, amendText(text, { depends_on: [d.on] }) ?? text)
  }
  return deps
}
const dependencyNote = d => `${d.task}: depends on ${d.on}, added automatically: the two tasks of phase ${d.phase} share ${d.files.join(', ')}`
// A line of HANDOFF.md, "type · severity · text"; an entry of an option without its type, severity or text is left out
const entryLine = (type, severity, text) => `${type} · ${severity} · ${squash(text)}`
const isEntry = e => !!e && typeof e.type === 'string' && /^[\p{L}][\p{L}-]*$/u.test(e.type) && ['minor', 'major'].includes(e.severity) && typeof e.description === 'string' && !!e.description.trim()
// The lines of the actions of an option, the same for close (an automatic decision) and apply (a ruling of the user), after the
// line of the decision: its entries, the amendments made, the dependencies added on an overlap, the amendments discarded
function actionLines({ entries = [], amended = [], deps = [], discarded = [] }) {
  return [
    ...entries.filter(isEntry).map(e => entryLine(e.type, e.severity, e.description)),
    ...amended.map(a => entryLine('amendment', 'major', `${a.id}: ${a.reason}`)),
    ...deps.map(d => entryLine('amendment', 'minor', dependencyNote(d))),
    ...discarded.map(a => entryLine('blind-spot', 'major', `amendment not applied to ${a.id}: ${a.reason ?? 'no reason'}`)),
  ]
}
// A list of a task's frontmatter (owned_files of an added task given by its content)
function frontList(text, k) {
  const lines = (String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '').split(/\r?\n/), i = lines.findIndex(l => l.startsWith(`${k}:`))
  if (i < 0) return []
  const rest = lines[i].slice(k.length + 1).trim()
  if (rest) return rest.replace(/^\[/, '').replace(/\]\s*(#.*)?$/, '').split(',').map(unquote).filter(Boolean)
  const out = []
  for (let j = i + 1; j < lines.length && /^\s+-\s/.test(lines[j]); j++) out.push(unquote(lines[j].replace(/^\s+-\s+/, '')))
  return out
}
// The paths an automatic decision cites (0.20.0): the owned_files its amendments add, and each backquoted text of its description
// and of its amendments' criteria and verifications that holds a "/", no space, no "<" and no "://", and whose first segment
// exists at the root of the main checkout (a branch such as task/T01 or a placeholder such as <plan>/tasks/ is not a path).
// A path with "*" is checked on the folder before its first "*"; a line number (:12, :12-30) is not part of the path.
const pathPart = p => { const s = String(p).replace(/:\d+(?:-\d+)?$/, ''); return s.includes('*') ? s.slice(0, s.indexOf('*')) : s }
function citedPaths(ctx, o) {
  const ams = actionsOf(o, 'amendments').map(objectOf), strings = x => (Array.isArray(x) ? x.filter(y => typeof y === 'string') : [])
  const owned = ams.flatMap(a => strings(a.owned_files)).map(squash).filter(Boolean)
  const texts = [o.description, ...ams.flatMap(a => [...strings(a.definition_of_done), ...strings(a.verification)])].filter(x => typeof x === 'string')
  const ticked = texts.flatMap(x => [...x.matchAll(/`([^`]+)`/g)].map(m => m[1]))
    .filter(x => x.includes('/') && !/\s/.test(x) && !x.includes('<') && !x.includes('://') && x.split('/')[0] && existsSync(join(ctx.root, x.split('/')[0])))
  return [...new Set([...owned, ...ticked])]
}
// A path owned by one of the owned_files entries given
const ownedBy = (p, owners) => owners.some(o => { const b = pathPart(o), q = pathPart(p); return o.includes('*') ? q.startsWith(b) : q === b || q.startsWith(b.endsWith('/') ? b : `${b}/`) })
// The paths of an automatic decision that neither exist in the main checkout nor are owned by a task the same close adds
const missingPaths = (ctx, o, owners) => citedPaths(ctx, o).filter(p => !existsSync(join(ctx.root, pathPart(p))) && !ownedBy(p, owners))
const ownedOf = x => (x && Array.isArray(x.owned_files) ? x.owned_files.map(String) : frontList(x && x.content, 'owned_files'))
// A task an option adds, brought to the phase of the run that applies it when its own phase is earlier, both in its phase field
// and in the phase: line of its content, as toPhase of the workflow does (0.20.0): a ruling applied at the start of phase 2 on
// an issue raised in phase 1 does not leave its task in a phase that is over. raised_from: its own phase, when raised.
function toRunPhase(x, phase) {
  if (!x || typeof x !== 'object' || !Number.isInteger(phase)) return x
  const own = Number(x.phase) || Number(frontList(x.content, 'phase')[0]) || 0
  if (own >= phase) return x
  return { ...x, phase, ...(typeof x.content === 'string' ? { content: x.content.replace(/^phase:[ \t]*\d+/m, `phase: ${phase}`) } : {}), raised_from: own }
}
const raisedNote = x => `${x.id}: phase ${x.raised_from} raised to phase ${x.phase}, the phase of the run that applies the ruling`
// A copy of a plan folder
function copyPlan(from, to) {
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyPlan(join(from, e.name), join(to, e.name))
    else if (e.isFile()) copyFileSync(join(from, e.name), join(to, e.name))
  }
}
// Dry run (0.20.0): each option that adds or amends a task is applied to a temporary copy of the plan, as close leaves it, then
// plan-lint runs on it; valid: true when it raises no new error, otherwise false with the reason. An option without such an
// action changes no task: valid. Only the issues of this close: an issue inherited from /3 keeps what T13 set.
function dryRun(ctx, issues) {
  const options = issues.flatMap(p => p.options || [])
  const acting = options.filter(o => actionsOf(o, 'added_tasks').length || actionsOf(o, 'amendments').length)
  for (const o of options) if (!acting.includes(o)) Object.assign(o, { valid: true, invalid_reason: null })
  if (!acting.length) return
  const tmp = mkdtempSync(join(tmpdir(), 'orchestre-dry-run-')), copy = join(tmp, ctx.name)
  try {
    const lint = () => planLint({ ...ctx, rel: copy })
    copyPlan(ctx.dir, copy)
    const base = lint(), known = new Set(base.tasks ? base.errors : [])
    const statuses = new Map((base.all || []).map(t => [t.id, t.status]))
    for (const o of acting) {
      rmSync(copy, { recursive: true, force: true })
      copyPlan(ctx.dir, copy)
      const done = applyActions(copy, statuses, { added_tasks: actionsOf(o, 'added_tasks'), amendments: actionsOf(o, 'amendments') })
      let L = lint()
      // The dependency apply would add: an overlap it settles does not make the option invalid
      if (dependOnOverlaps(done.created, L).length) L = lint()
      const unread = L.tasks ? done.created.filter(x => !L.tasks.some(t => t.id === x.id)).map(x => `no task ${x.id} in ${basename(x.file)}`) : []
      const why = [...done.refused.map(x => x.reason), ...unread, ...(L.tasks ? L.errors.filter(e => !known.has(e)) : [L.errors[0]])]
      Object.assign(o, why.length ? { valid: false, invalid_reason: clip(`dry run: ${why.join('; ')}`, 300) } : { valid: true, invalid_reason: null })
    }
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}
// One commit of the plan's files; null when none of them changed. A refused commit leaves the index as it was.
function commitPlan(ctx, files, message, cmd = 'close') {
  const rel = [...new Set(files)].filter(f => existsSync(f)).map(f => relative(ctx.root, f).split(sep).join('/'))
  const run = args => spawnSync('git', ['--literal-pathspecs', ...args], { cwd: ctx.root, env: ENV, encoding: 'utf8' })
  const firstLine = r => String(r.stderr || r.stdout || r.error || 'no message').trim().split('\n')[0]
  if (!rel.length) return null
  const a = run(['add', '--', ...rel])
  if (a.status !== 0) refuse(`${cmd}: git add refused (${firstLine(a)}): nothing is written`)
  if (run(['diff', '--cached', '--quiet', '--', ...rel]).status === 0) return null
  const c = run(['commit', '-q', '-m', message, '--', ...rel])
  if (c.status !== 0) { run(['reset', '-q', '--', ...rel]); refuse(`${cmd}: commit refused (${firstLine(c)}): nothing is written`) }
  return git(['rev-parse', 'HEAD'], ctx.root).trim()
}

// close (0.20.0). Outside the lock: plan-lint, the tasks and HANDOFF.md written (the workflow runs one close at a time), the
// dry run. Under the lock: progress.json and ISSUES.json read, changed and written, then the commit, so that a refused commit
// puts them back before any other writer reads them. A plan-lint under the lock would hold it past its stale limit (60 s).
function closeAndCommit(ctx, E) {
  onIntegration(ctx, 'close')
  // An unknown task or a status not allowed is refused by the close of progress.json, after which every file is put back
  const id = E.task
  const entries = list(E, 'entries'), given = list(E, 'issues')
  entries.forEach((e, i) => { if (!isEntry(e)) refuse(`close: entries[${i}] must be { type, severity: minor or major, description }`) })
  given.forEach((p, i) => {
    if (!p || typeof p !== 'object' || typeof p.title !== 'string' || !p.title.trim()) refuse(`close: issues[${i}] must be an object with a title`)
    if (!(p.options == null || (Array.isArray(p.options) && p.options.every(o => o && typeof o === 'object' && !Array.isArray(o))))) refuse(`close: issues[${i}].options must be a list of objects`)
    if (p.auto != null && !(p.options || []).some(o => String(o.id) === String(p.auto))) refuse(`close: issue "${p.title}": auto names option ${p.auto}, which it does not have`)
  })
  // An automatic decision whose option cites a path that neither exists nor is owned by a task this close adds is rejected
  // before anything is written: its issue stays open, nothing of its option is applied, a needs-human entry says why
  const decided = given.filter(p => p.auto != null).map(p => ({ p, o: p.options.find(o => String(o.id) === String(p.auto)) }))
  const owners = [...list(E, 'added_tasks'), ...decided.flatMap(({ o }) => actionsOf(o, 'added_tasks'))].flatMap(ownedOf)
  const inconsistent = decided.flatMap(({ p, o }) => missingPaths(ctx, o, owners).map(path => ({ p, o, path })))
  const autos = decided.filter(({ p }) => !inconsistent.some(x => x.p === p))
  const issues = given.map(p => (inconsistent.some(x => x.p === p) ? (({ auto, ...rest }) => rest)(p) : p))
  const added = [...list(E, 'added_tasks'), ...autos.flatMap(({ o }) => actionsOf(o, 'added_tasks'))]
  const amendments = [...list(E, 'amendments'), ...autos.flatMap(({ o }) => actionsOf(o, 'amendments'))]
  const kept = new Map()
  const keep = f => { if (!kept.has(f)) kept.set(f, readOrNull(f)) }
  const restore = f => { const c = kept.get(f); if (c == null) attempt(() => unlinkSync(f)); else writeFileSync(f, c) }
  try {
    const L0 = planLint(ctx)
    // Tasks created and amended, then plan-lint: what it refuses is put back
    const done = applyActions(ctx.dir, new Map((L0.all || L0.tasks || []).map(t => [t.id, t.status])), { added_tasks: added, amendments }, keep)
    // A task created that shares files with a task of its phase depends on it (0.20.0), as in the dry run and apply
    const deps = done.created.length ? dependOnOverlaps(done.created, planLint(ctx)) : []
    const touched = [...done.created.map(x => ({ ...x, kind: 'created' })), ...done.amended.map(x => ({ ...x, kind: 'amended' }))]
    const L = lintTouched(ctx, L0, touched, restore)
    const rejected = []
    for (const x of [...done.refused, ...touched.filter(t => t.out).map(t => ({ id: t.id, reason: t.out }))]) if (!rejected.some(y => y.id === x.id)) rejected.push(x)
    const out = new Set(rejected.map(x => x.id))
    // HANDOFF.md, under "## <task>", in the order of the scribe's instruction; the actions of the options with the code of apply
    const lines = [
      ...actionLines({ entries }),
      ...list(E, 'blocker').map(g => entryLine('blocker', 'major', g)),
      ...list(E, 'rejections').map(objectOf).map(r => entryLine('rejection', 'minor', `attempt ${r.attempt}, ${r.by}: ${(Array.isArray(r.gaps) ? r.gaps : []).map(squash).join('; ')}`)),
      ...list(E, 'unverifiable').map(c => entryLine('blind-spot', 'minor', `criterion unverifiable in the context of the task: ${c}`)),
      ...list(E, 'flaky').map(x => entryLine('debt', 'minor', `flaky test, passed on the second run: ${x}`)),
      ...autos.flatMap(({ p, o }) => [entryLine('decision', 'major', `${p.title}: option ${o.id} taken automatically (autonomous mode) — ${o.description ?? ''}`), ...actionLines({ entries: actionsOf(o, 'entries') })]),
      ...actionLines({ amended: touched.filter(t => t.kind === 'amended' && !t.out), deps: deps.filter(d => !out.has(d.task)), discarded: [...done.discarded, ...list(E, 'discarded_amendments').map(objectOf)] }),
      ...rejected.map(x => entryLine('needs-human', 'major', `${x.id} not applied: ${x.reason}`)),
      ...inconsistent.map(x => entryLine('needs-human', 'major', `inconsistent auto-decision: ${x.path} does not exist and no task creates it`)),
    ]
    rejected.push(...inconsistent.map(x => ({ id: x.path, reason: `inconsistent auto-decision on issue "${x.p.title}", option ${x.o.id}: ${x.path} does not exist and no task creates it` })))
    const handoffFile = join(ctx.dir, 'HANDOFF.md')
    if (lines.length) { keep(handoffFile); writeFileSync(handoffFile, handoffWith(readOrNull(handoffFile) || '', id, lines)) }
    // Dry run of the options of the new issues
    dryRun(ctx, issues)
    const dropped = new Set(inconsistent.map(x => JSON.stringify([x.p.title, String(x.o.id)])))
    const E2 = {
      ...E, issues, rejected,
      auto_decisions: list(E, 'auto_decisions').filter(d => !dropped.has(JSON.stringify([d && d.title, String(d && d.option)]))),
      added_tasks: [...new Map(added.filter(x => x && RE_ID.test(x.id || '') && !out.has(x.id)).map(x => [x.id, x])).values()].map(x => ({ id: x.id, title: x.title, phase: x.phase })),
      amendments: touched.filter(t => t.kind === 'amended' && !t.out).map(t => ({ id: t.id, reason: t.reason })),
    }
    const handoff = readOrNull(handoffFile) || ''
    // Under the lock: progress.json, ISSUES.json and PROGRESS.md, then one commit of the plan's files
    return underLock(ctx, () => {
      const held = new Map(['progress.json', 'PROGRESS.md', REGISTER].map(f => [join(ctx.dir, f), readOrNull(join(ctx.dir, f))]))
      try {
        const r = writeLocked(ctx, (doc, tools) => close(doc, E2, tools), {}, L, handoff)
        const files = [handoffFile, join(ctx.dir, 'PROGRESS.md'), join(ctx.dir, REGISTER), join(ctx.dir, 'DISCOVERY.md'), ...touched.filter(t => !t.out).map(t => t.file)]
        const commit = commitPlan(ctx, files, `progress(${id}): ${E.status}`)
        const result = {
          task: id, status: E.status, commit, rejected, discarded: done.discarded.map(a => ({ id: a.id, reason: a.reason })), issues: r.issues,
          pending: r.doc.pending_rulings.map(x => x.issue), message: `${r.message}; ${commit ? `committed ${commit.slice(0, 7)}` : 'nothing to commit'}`,
        }
        return { ...result, digest: payloadDigest(result, 'digest') }
      } catch (e) {
        for (const [f, c] of held) { if (c == null) attempt(() => unlinkSync(f)); else writeFileSync(f, c) }
        throw e
      }
    })
  } catch (e) {
    for (const f of kept.keys()) restore(f)
    throw e
  }
}
// Entries under "## <id>" (the heading created at the end of the file when it is missing), after the last line of the
// section; an entry already written there word for word is not written twice
function handoffWith(text, id, lines) {
  const all = text.replace(/\s+$/, '').split('\n'), h = all.findIndex(l => l.trim() === `## ${id}`)
  if (h < 0) return `${all.join('\n')}${all.join('').trim() ? '\n\n' : ''}## ${id}\n\n${lines.map(l => `- ${l}`).join('\n')}\n`
  let end = h + 1
  while (end < all.length && !/^##\s/.test(all[end])) end++
  let last = end - 1
  while (last > h && !all[last].trim()) last--
  const there = new Set(all.slice(h + 1, end).map(l => l.trim()))
  const add = [...new Set(lines.map(l => `- ${l}`))].filter(l => !there.has(l))
  all.splice(last + 1, 0, ...(last === h && add.length ? ['', ...add] : add))
  return all.join('\n') + '\n'
}

// ─── apply: the rulings recorded, reported into the plan (0.20.0, decision D1) ─────────────────────────────────────────
// Each ruling of pending_rulings, in the order recorded, on top of those applied before it. An option is applied as close
// applies an automatic decision: its HANDOFF entries, its added tasks, its amendments; a text adds one decision entry and
// changes no task. A task the option adds that shares files with a task of its phase, without a dependency between them
// (plan-lint's overlaps), gets a dependency on that task, noted in HANDOFF.md. An option that plan-lint still refuses is put
// back as it was, and its issue is open again, the option invalid with the reason; the others are applied. Then, in one
// commit "progress: rulings <ids>": HANDOFF.md, the task files, ISSUES.json (each issue applied settled, with its ruling;
// commit null: the hash of the commit that holds the register cannot be written in it) and PROGRESS.md; progress.json too
// (the copy of each issue settled, the ruling out of pending_rulings). Without a ruling recorded, nothing is written.
const FREE_ANSWER = 'free answer'
const registerOf = copy => ({
  id: copy.id, task: copy.task, title: copy.title, context: copy.context, human: copy.human,
  options: copy.options.map(o => ({ id: o.id, description: o.description, ...(o.impact !== undefined ? { impact: o.impact } : {}), ...(o.recommended !== undefined ? { recommended: o.recommended } : {}), valid: o.valid, invalid_reason: o.invalid_reason, entries: [], added_tasks: [], amendments: [] })),
  status: 'open', ruling: null,
})
// Outside the lock: progress.json read (written by rename, a read sees a whole file), plan-lint, the tasks and HANDOFF.md
// written. Under the lock: the rulings read checked unchanged (a ruling withdrawn or changed by unrule or rule meanwhile
// refuses the whole apply, every file put back), progress.json and ISSUES.json written, then the commit.
function applyRulings(ctx) {
  onIntegration(ctx, 'apply')
  const doc0 = load(ctx), pending = doc0 ? doc0.pending_rulings : []
  const result = { applied: [], rejected: [], discarded: [], amended: [], added_tasks: [], commit: null }
  const answerOf = (o, message) => { const x = { ...o, message }; return { ...x, digest: payloadDigest(x, 'digest') } }
  if (!pending.length) return answerOf(result, 'no ruling to apply')
  const reg0 = loadRegister(ctx), L0 = planLint(ctx)
  const statuses = new Map((L0.all || L0.tasks || []).map(t => [t.id, t.status]))
  // The phase of the run in progress, of the last run when none is: a task an option adds joins it when its own phase is earlier
  const runPhase = (currentRun(doc0) || doc0.runs[doc0.runs.length - 1] || {}).phase
  const kept = new Map()
  const restore = f => { const c = kept.get(f); if (c == null) attempt(() => unlinkSync(f)); else writeFileSync(f, c) }
  const lists = L => new Map((L.tasks || []).map(t => [t.id, { verification: t.verification || [], depends_on: t.depends_on || [] }]))
  let L = L0, known = new Set(L0.tasks ? L0.errors : []), state = lists(L0)
  const lines = new Map(), written = [], amended = new Map(), outcomes = []
  const note = (task, ...ls) => { if (!lines.has(task)) lines.set(task, []); lines.get(task).push(...ls) }
  const grow = (id, verification, dependsOn) => {
    const a = amended.get(id) || { id, verification: [], depends_on: [] }
    for (const [k, xs] of [['verification', verification], ['depends_on', dependsOn]]) for (const x of xs) if (!a[k].includes(x)) a[k].push(x)
    amended.set(id, a)
  }
  try {
    for (const r of pending) {
      const copy = doc0.issues.find(p => p.id === r.issue) || null, entry = reg0.issues.find(p => p.id === r.issue) || null
      // reopen: the option is marked invalid with the reason, so that rule refuses it and the pane says why
      const reject = (reason, reopen = true) => { outcomes.push({ r, reason, reopen }); result.rejected.push({ issue: r.issue, option: r.option, text: r.text, reason }) }
      if (!copy && !entry) { reject('unknown issue', false); continue }
      const issueState = entry && entry.status !== 'open' ? entry.status : copy && copy.status === 'settled' ? 'settled' : 'open'
      if (issueState !== 'open') { reject(`issue already ${issueState}`, false); continue }
      const p = entry || copy
      if (r.text != null) {
        note(p.task, entryLine('decision', 'major', `${p.title}: settled by the user — ${r.text}`))
        outcomes.push({ r, p, created: [], discarded: [] })
        continue
      }
      const o = p.options.find(x => x.id === r.option)
      if (!o) { reject(`option ${r.option} absent from issue ${r.issue}`, false); continue }
      if (!entry) { reject(`no entry in ${REGISTER}: the actions of option ${r.option} are unknown; answer with a text`); continue }
      if (o.valid === false) { reject(`option ${r.option} invalid: ${o.invalid_reason || 'refused by the dry run'}`, false); continue }
      // The option's files, as they were before it: put back if it fails
      const mine = new Map()
      const keep = f => { if (!kept.has(f)) kept.set(f, readOrNull(f)); if (!mine.has(f)) mine.set(f, readOrNull(f)) }
      const putBack = () => { for (const [f, c] of mine) { if (c == null) attempt(() => unlinkSync(f)); else writeFileSync(f, c) } }
      // Its tasks in the phase of this run at least, before plan-lint and the dependencies
      const adds = actionsOf(o, 'added_tasks').map(x => toRunPhase(x, runPhase))
      const done = applyActions(ctx.dir, statuses, { added_tasks: adds, amendments: actionsOf(o, 'amendments') }, keep)
      if (done.refused.length) { putBack(); reject(clip(done.refused.map(x => x.reason).join('; '), 300)); continue }
      let deps = [], L1 = L
      if (done.created.length || done.amended.length) {
        L1 = planLint(ctx)
        deps = dependOnOverlaps(done.created, L1)
        if (deps.length) L1 = planLint(ctx)
        const unread = L1.tasks ? done.created.filter(x => !L1.tasks.some(t => t.id === x.id)).map(x => `no task ${x.id} in ${basename(x.file)}`) : []
        const fresh = [...unread, ...(L1.tasks ? L1.errors.filter(e => !known.has(e)) : [L1.errors[0]])]
        if (fresh.length) { putBack(); reject(clip(`plan-lint: ${fresh.join('; ')}`, 300)); continue }
      }
      const created = adds.filter(x => done.created.some(c => c.id === x.id))
      // Applied: the decision, then the actions of the option with the code of close, then each phase raised
      note(p.task, entryLine('decision', 'major', `${p.title}: option ${o.id} settled by the user${o.description ? ` — ${o.description}` : ''}`),
        ...actionLines({ entries: actionsOf(o, 'entries'), amended: done.amended, deps, discarded: done.discarded }),
        ...created.filter(x => x.raised_from != null).map(x => entryLine('amendment', 'minor', raisedNote(x))))
      // What the workflow reads back: the verifications and dependencies added to each task amended
      const fresh = new Set(done.created.map(x => x.id)), after = lists(L1)
      for (const a of done.amended) if (!fresh.has(a.id)) { const b = state.get(a.id) || { verification: [], depends_on: [] }, t = after.get(a.id) || b; grow(a.id, t.verification.filter(x => !b.verification.includes(x)), t.depends_on.filter(x => !b.depends_on.includes(x))) }
      for (const d of deps) grow(d.task, [], [d.on])
      L = L1; known = new Set(L1.tasks ? L1.errors : []); state = after
      written.push(...mine.keys())
      result.added_tasks.push(...created.map(x => ({ id: x.id, title: x.title ?? x.id, phase: L1.tasks.find(t => t.id === x.id)?.phase ?? x.phase ?? null })))
      result.discarded.push(...done.discarded.map(a => ({ id: a.id, reason: a.reason })))
      outcomes.push({ r, p, created, discarded: done.discarded })
    }
    result.applied = outcomes.filter(x => x.p).map(({ r, p }) => ({ issue: r.issue, task: p.task, option: r.option, text: r.text }))
    result.amended = [...amended.values()]
    // HANDOFF.md, under "## <task>" of each issue
    const handoffFile = join(ctx.dir, 'HANDOFF.md')
    if (lines.size) {
      if (!kept.has(handoffFile)) kept.set(handoffFile, readOrNull(handoffFile))
      let text = readOrNull(handoffFile) || ''
      for (const [task, ls] of lines) text = handoffWith(text, task, ls)
      writeFileSync(handoffFile, text)
    }
    const handoff = readOrNull(handoffFile) || ''
    return underLock(ctx, () => {
      const held = new Map(['progress.json', 'PROGRESS.md', REGISTER].map(f => [join(ctx.dir, f), readOrNull(join(ctx.dir, f))]))
      try {
        // progress.json and ISSUES.json: each issue applied settled, each ruling out of pending_rulings
        writeLocked(ctx, (doc, tools) => {
          const same = (a, b) => a.issue === b.issue && a.option === b.option && a.text === b.text && a.at === b.at
          const moved = pending.filter(r => !doc.pending_rulings.some(y => same(r, y))).map(r => r.issue)
          if (moved.length) refuse(`apply: the ruling of ${moved.join(', ')} was withdrawn or changed while apply ran (unrule, rule): nothing is written; run apply again`)
          const { J } = tools, reg = tools.register(), run = currentRun(doc)
          for (const x of outcomes) {
            const { r } = x
            doc.pending_rulings = doc.pending_rulings.filter(y => y.issue !== r.issue)
            const copy = doc.issues.find(p => p.id === r.issue) || null
            let entry = reg.issues.find(p => p.id === r.issue) || null
            if (!x.p) {
              if (x.reopen) for (const opts of [copy && copy.options, entry && entry.options]) { const o = (opts || []).find(y => y.id === r.option); if (o) Object.assign(o, { valid: false, invalid_reason: x.reason }) }
              J('ruling', copy?.task ?? entry?.task ?? null, `${r.issue}: ${answer(r)} not applied: ${x.reason}${x.reopen ? '; the issue is open again' : ''}`)
              continue
            }
            if (!entry) { entry = registerOf(copy); reg.issues.push(entry) }
            Object.assign(entry, { status: 'settled', ruling: { option: r.option, text: r.text, author: 'user', at: r.at, commit: null } })
            if (copy) Object.assign(copy, { status: 'settled', chosen_option: r.option })
            J('ruling', x.p.task, `${r.issue}: ${answer(r)} applied`)
            if (run && !run.rulings_applied.some(a => a.task === x.p.task && a.title === x.p.title)) run.rulings_applied.push({ task: x.p.task, title: x.p.title, option: r.option ?? FREE_ANSWER })
            for (const a of x.discarded) if (run) run.discarded_amendments.push({ task: x.p.task, id: a.id, reason: a.reason })
            add(doc, x.created, x.p.task, tools)
          }
          // PROGRESS.md regenerated when a task was added or amended
          return { view: written.length > 0, register: true }
        }, {}, L, handoff)
        // One commit of the plan's files
        const ids = result.applied.map(x => x.issue)
        result.commit = commitPlan(ctx, [handoffFile, join(ctx.dir, 'PROGRESS.md'), join(ctx.dir, REGISTER), ...written], ids.length ? `progress: rulings ${ids.join(', ')}` : `progress: rulings refused ${result.rejected.map(x => x.issue).join(', ')}`, 'apply')
        const said = [...(ids.length ? [`${plural(ids.length, 'ruling')} applied (${ids.join(', ')})`] : []), ...(result.rejected.length ? [`${result.rejected.length} refused (${result.rejected.map(x => x.issue).join(', ')})`] : [])]
        return answerOf(result, `${said.join('; ')}; ${result.commit ? `committed ${result.commit.slice(0, 7)}` : 'nothing to commit'}`)
      } catch (e) {
        for (const [f, c] of held) { if (c == null) attempt(() => unlinkSync(f)); else writeFileSync(f, c) }
        throw e
      }
    })
  } catch (e) {
    for (const f of kept.keys()) restore(f)
    throw e
  }
}

// ─── Entry ──────────────────────────────────────────────────────────────────────────────────────────────────────
// The object of --json if given, otherwise standard input
function input(json) {
  const source = json != null ? '--json' : 'standard input'
  if (json == null && process.stdin.isTTY) throw new UsageError('JSON object expected on standard input or in --json')
  const raw = json != null ? json : attempt(() => readFileSync(0, 'utf8')) || ''
  if (!raw.trim()) throw new UsageError('JSON object expected on standard input or in --json')
  let E
  try { E = JSON.parse(raw) } catch (e) { throw new UsageError(`${source}: invalid JSON (${e.message})`) }
  if (!E || typeof E !== 'object' || Array.isArray(E)) throw new UsageError(`${source}: a JSON object is expected`)
  return E
}

const WRITES = { 'run-start': runStart, step, close, ruling, rule, unrule, 'run-end': runEnd, pilot, ack, ticket, reopen, relabel, 'close-plan': closePlan, 'reopen-plan': reopenPlan }
const USAGE = 'usage: progress.mjs <run-start|step|close|ruling|rule|unrule|apply|run-end|pilot|ack|ticket|reopen|relabel|close-plan|reopen-plan|view|status|triage|validate> [<plan-dir>] [--stdout] [--file <progress.json>] [--json <object>]; for writes, JSON in --json or on standard input'

function main() {
  const argv = process.argv.slice(2), cmd = argv[0]
  const fi = argv.indexOf('--file'), file = fi >= 0 ? argv[fi + 1] : null
  const ji = argv.indexOf('--json')
  if (ji >= 0 && ji + 1 >= argv.length) throw new UsageError('--json: JSON object expected after the option')
  const json = ji >= 0 ? argv[ji + 1] : null
  const arg = argv.slice(1).find((a, i, xs) => !a.startsWith('--') && xs[i - 1] !== '--file' && xs[i - 1] !== '--json')
  if (cmd === 'status') {
    let text
    try { text = status(arg) } catch (e) { text = `orchestre:status: ${String((e && e.message) || e).split('\n')[0]}` }
    console.log(text)
    return 0
  }
  if (cmd === 'triage') {
    console.log(JSON.stringify(triage(arg), null, 2))
    return 0
  }
  // apply reads no input: the rulings are those of progress.json (0.20.0)
  if (cmd === 'apply') {
    console.log(JSON.stringify(applyRulings(locate(arg))))
    return 0
  }
  if (cmd === 'validate') {
    const dir = file ? null : locate(arg).dir
    const f = file ? resolve(file) : join(dir, 'progress.json')
    if (!existsSync(f)) refuse(`${f}: missing; it will be rebuilt at the next write`)
    let doc
    try { doc = JSON.parse(readFileSync(f, 'utf8')) } catch (e) { refuse(`${file ? basename(f) : 'progress.json'} unreadable: ${e.message}`) }
    // --file: a register is validated as one
    const register = reg => {
      const err = validateRegister(reg)
      if (err.length) refuse(`${REGISTER} invalid:\n${err.map(e => '  - ' + e).join('\n')}`)
      return `progress: ${REGISTER} valid (${REGISTER_FORMAT}, ${plural(reg.issues.length, 'issue')}, ${reg.issues.filter(p => p.status === 'open').length} open)`
    }
    if (file && doc && doc.format === REGISTER_FORMAT) { console.log(register(doc)); return 0 }
    checkFormat(doc)
    // A file of an earlier format is validated as it will be converted
    const from = doc.format === FORMAT ? null : doc.format
    if (from) doc = upgrade(doc)
    const err = validate(doc)
    if (err.length) refuse(`progress.json invalid:\n${err.map(e => '  - ' + e).join('\n')}`)
    const lines = [`progress: progress.json valid (${from ? `${from}, converted to ${FORMAT} at the next write` : FORMAT}, ${plural(doc.tasks.length, 'task')}, ${plural(doc.runs.length, 'run')})`]
    // The plan's register, when it has one
    if (dir && existsSync(join(dir, REGISTER))) {
      let reg
      try { reg = JSON.parse(readFileSync(join(dir, REGISTER), 'utf8')) } catch (e) { refuse(`${REGISTER} unreadable: ${e.message}`) }
      lines.push(register(reg))
    }
    console.log(lines.join('\n'))
    return 0
  }
  if (cmd === 'view') {
    const ctx = locate(arg)
    if (argv.includes('--stdout')) {
      const L = planLint(ctx), handoff = readOrNull(join(ctx.dir, 'HANDOFF.md')) || '', at = now()
      const existing = load(ctx)
      if (!existing && !L.tasks) throw new Refusal(`${L.errors[0]}: progress.json missing, it cannot be rebuilt without plan-lint`)
      const doc = existing || rebuild(ctx, L, handoff, at)
      if (existing) sync(doc, L, ctx, logger(doc, at), { statuses: true })
      derive(doc, L, handoff)
      process.stdout.write(render(doc, readOrNull(join(ctx.dir, 'PROGRESS.md'))))
      return 0
    }
    // Between two runs (pre-flight of /orchestre:run): PROGRESS.md and git are the source of truth for statuses, as at the start
    // of a run (a task merged by hand without "progress.mjs pilot" becomes "merged")
    const r = write(ctx, (doc, { L, ctx: c, J }) => { sync(doc, L, c, J, { statuses: true }); return { view: true } })
    console.log(`progress: PROGRESS.md regenerated (${plural(r.doc.tasks.length, 'task')})`)
    return 0
  }
  const change = WRITES[cmd]
  if (!change) throw new UsageError(USAGE)
  const ctx = locate(arg), E = checkDigest(cmd, input(json))
  // close writes and commits the plan, and answers in JSON (0.20.0)
  if (cmd === 'close') { console.log(JSON.stringify(closeAndCommit(ctx, E))); return 0 }
  const r = write(ctx, (doc, tools) => change(doc, E, tools), { runStart: cmd === 'run-start' })
  console.log(`progress: ${r.message}`)
  return 0
}

const launched = process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))
if (launched) {
  try { process.exitCode = main() } catch (e) {
    if (e instanceof Refusal || e instanceof UsageError) { console.error(`progress: ${e.message}`); process.exitCode = e.code } else { console.error(`progress: unexpected error, nothing is written: ${(e && e.stack) || e}`); process.exitCode = 1 }
  }
}
