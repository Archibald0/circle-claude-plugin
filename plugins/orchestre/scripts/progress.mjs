#!/usr/bin/env node
// progress (orchestre plugin 0.12.0): sole writer of plans/<name>/progress.json (format orchestre-progress/3) and of its view
// PROGRESS.md. Node 18 or later, no dependencies. Contract: 0.12.0/CONTRACT.md; schema: SCHEMA below, a copy of
// progress.v3.schema.json without the descriptions.
// A progress.json in a format of orchestre 0.11 and earlier (orchestre-suivi/2 or /1, French keys and values) is read and
// converted in memory; the first write turns it into /3. scripts/migrate.mjs converts it the same way (convertLegacy).
//
// Usage: node <plugin root>/scripts/progress.mjs <command> [<plan-dir>] [options]
// Writes read a JSON object on standard input, or in the option --json '<object>' (a single command to allow,
// without heredoc or pipe: this is the form the workflow gives its agents). Without a folder, the only plan in plans/.
//   run-start  { phase, mode, parallelism, max_fixes, max_auto_decisions, run_id? }
//              once per run, by its first agent: rereads the plan (plan-lint), turns a run left in progress into "interrupted"
//   step       { task, step, isolated?, rejection?, model?, change? }      step: worker, verification, evaluation, fix, merge,
//              replanning, progress; worker resets the task's run fields; fix adds rejection { attempt, by, gaps };
//              model: the model launched (worker, fix), noted in model_used; change { from, to, reason }: "model" event
//   close      { task, status, attempts, branch, actual_tokens?, rejections?, flaky?, unverifiable?, blocker?, reviews?,
//                auto_decisions?, issues?, added_tasks?, amendments?, replanning? }      regenerates PROGRESS.md
//   ruling     { task, title, option, added_tasks?, amendments?, discarded_amendments? }      regenerates PROGRESS.md
//   run-end    the workflow's return value (status, detail, stop_issue, open_issues, tasks…);
//              closes, from the summary, the tasks left without a close (workflow exception) and then regenerates PROGRESS.md
//   pilot      { task, status: "merged" | "cancelled", reason? }      pilot's manual action; regenerates PROGRESS.md
//   view [--stdout]        regenerates PROGRESS.md (or prints it without writing anything); statuses reread from PROGRESS.md
//                          and git, as run-start
//   status                 progress as compact Markdown, like /orchestre:status; read-only, always code 0
//   validate [--file <f>]  validates progress.json against the schema
// Exit codes: 0 done; 1 write refused, progress.json and PROGRESS.md unchanged; 2 invalid call.
//
// Guarantees: lock plans/<name>/.progress.lock (8 tasks at most in parallel); write to .progress.<pid>.tmp then rename;
// validation of each write; files always in the main checkout, even when called from a worktree;
// progress.json, .progress.lock and .progress.*.tmp added to .git/info/exclude if not already ignored.
// progress.json absent: rebuilt from PROGRESS.md, HANDOFF.md and plan-lint; the run fields start empty again.
import { readFileSync, writeFileSync, existsSync, readdirSync, openSync, closeSync, writeSync, renameSync, unlinkSync, statSync, mkdirSync, appendFileSync, realpathSync } from 'node:fs'
import { join, resolve, relative, dirname, basename, isAbsolute, sep } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const FORMAT = 'orchestre-progress/3'
// Formats of orchestre 0.11 and earlier, in French: read, then converted (convertLegacy)
export const LEGACY_FORMATS = ['orchestre-suivi/2', 'orchestre-suivi/1']
const STATUSES = ['todo', 'added', 'merged', 'blocked', 'failed', 'needs-human', 'cancelled']
const STEPS = ['worker', 'verification', 'evaluation', 'fix', 'merge', 'replanning', 'progress']
const RUN_ENDS = ['finished', 'partial', 'awaiting-ruling', 'rerun', 'error']
const CLOSES = ['merged', 'blocked', 'failed', 'needs-human']
const KINDS = ['run', 'task', 'step', 'rejection', 'status', 'added', 'amendment', 'review', 'auto-decision', 'issue', 'ruling', 'pilot', 'error', 'model']
export const LOG_MAX = 200
const RE_ID = /^[A-Z]+[0-9]+[A-Z]*$/
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

// ─── Schema orchestre-progress/3, without the descriptions ──────────────────────────────────────────────────────────
const ref = n => ({ $ref: `#/$defs/${n}` })
const arrayOf = items => ({ type: 'array', items })
const object = (required, properties, extra = {}) => ({ type: 'object', additionalProperties: false, required, properties, ...extra })
const INT1 = { type: 'integer', minimum: 1 }
export const SCHEMA = {
  ...object(['format', 'plan', 'dir', 'integration', 'base', 'updated', 'tasks', 'runs', 'issues', 'auto_decisions', 'reviews', 'prerequisites', 'handoff', 'lint', 'log', 'log_omitted'], {
    format: { const: FORMAT },
    plan: { type: 'string', minLength: 1 },
    dir: { type: 'string', minLength: 1 },
    integration: { type: 'string', minLength: 1 },
    base: { type: ['string', 'null'] },
    updated: ref('date'),
    tasks: arrayOf(ref('task')),
    runs: arrayOf(ref('run')),
    issues: arrayOf(ref('issue')),
    auto_decisions: arrayOf(ref('autoDecision')),
    reviews: arrayOf(ref('review')),
    prerequisites: arrayOf(ref('prerequisite')),
    handoff: { type: 'object', additionalProperties: { type: 'object', additionalProperties: ref('count') } },
    lint: object(['ok', 'errors'], { ok: { type: 'boolean' }, errors: arrayOf({ type: 'string' }) }),
    log: { type: 'array', maxItems: LOG_MAX, items: ref('event') },
    log_omitted: { type: 'integer', minimum: 0 },
  }),
  $defs: {
    date: { type: 'string', format: 'date-time' },
    dateOrNull: { oneOf: [ref('date'), { type: 'null' }] },
    taskId: { type: 'string', pattern: '^[A-Z]+[0-9]+[A-Z]*$' },
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
    issue: object(['run', 'task', 'title', 'context', 'human', 'role', 'status', 'chosen_option', 'options'], {
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
      options: arrayOf(object(['id', 'description'], { id: { type: 'string', minLength: 1 }, description: { type: 'string' }, impact: { type: 'string' }, recommended: { type: 'boolean' } })),
    }),
    autoDecision: object(['run', 'task', 'title', 'option', 'description'], { run: INT1, task: ref('taskId'), title: { type: 'string' }, option: { type: 'string' }, description: { type: 'string' } }),
    review: object(['task', 'phase', 'text', 'run', 'at'], {
      task: { oneOf: [ref('taskId'), { type: 'null' }] },
      phase: { type: ['integer', 'null'], minimum: 1 },
      text: { type: 'string', minLength: 1 },
      run: { type: ['integer', 'null'], minimum: 1 },
      at: ref('dateOrNull'),
    }),
    prerequisite: object(['id', 'type', 'status', 'text', 'blocks'], { id: ref('taskId'), type: { type: 'string' }, status: { type: 'string' }, text: { type: 'string' }, blocks: ref('ids') }),
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
function check(s, x, at, err) {
  if (s.$ref) s = SCHEMA.$defs[s.$ref.split('/').pop()]
  if (s.oneOf) {
    if (s.oneOf.filter(o => { const e = []; check(o, x, at, e); return !e.length }).length !== 1) err.push(`${at}: ${describe(x)} matches no allowed form`)
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
    if (s.items) x.forEach((y, i) => check(s.items, y, `${at}[${i}]`, err))
  } else if (x && typeof x === 'object') {
    for (const k of s.required || []) if (x[k] === undefined) err.push(`${at ? at + '.' : ''}${k}: missing`)
    for (const [k, y] of Object.entries(x)) {
      if (y === undefined) continue
      const sk = s.properties && s.properties[k]
      if (sk) check(sk, y, at ? `${at}.${k}` : k, err)
      else if (s.additionalProperties === false) err.push(`${at ? at + '.' : ''}${k}: field unknown to format ${FORMAT}`)
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, y, at ? `${at}.${k}` : k, err)
    }
  }
}
export function validate(doc) { const err = []; check(SCHEMA, doc, '', err); return err }

// ─── Legacy formats: orchestre-suivi/2 and /1 (French) → orchestre-progress/3 ───────────────────────────────────────
// Keys renamed, enumerated values translated; free texts (titles, log, reviews, details) are kept as written.
// /1 had no modele_utilise: model_used starts at null. Returns null for a document in another format.
const tr = (map, x) => (typeof x === 'string' && Object.hasOwn(map, x) ? map[x] : x)
const listOf = (x, f) => (Array.isArray(x) ? x.map(f) : x)
const objectOf = x => (x && typeof x === 'object' && !Array.isArray(x) ? x : {})
export function convertLegacy(doc) {
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
    format: FORMAT, plan: doc.plan, dir: doc.dossier, integration: doc.integration, base: doc.base, updated: doc.maj,
    tasks: listOf(doc.taches, task), runs: listOf(doc.runs, run), issues: listOf(doc.points, issue),
    auto_decisions: listOf(doc.decisions_office, d => (d = objectOf(d), { run: d.run, task: d.tache, title: d.titre, option: d.option, description: d.description })),
    reviews: listOf(doc.relectures, r => (r = objectOf(r), { task: r.tache, phase: r.phase, text: r.texte, run: r.run, at: r.quand })),
    prerequisites: listOf(doc.prerequis, p => (p = objectOf(p), { id: p.id, type: tr(L.prerequisiteType, p.type), status: tr(L.prerequisiteStatus, p.statut), text: p.texte, blocks: p.bloque })),
    handoff, lint: { ok: objectOf(doc.lint).ok, errors: objectOf(doc.lint).erreurs },
    log: listOf(doc.journal, e => (e = objectOf(e), { at: e.quand, kind: tr(L.kind, e.genre), task: e.tache, text: e.texte })),
    log_omitted: doc.journal_omis,
  }
}
// The log note that a conversion leaves, at the first write or by migrate.mjs
export const conversionNote = (from, by = null) => `progress.json converted from ${from} to ${FORMAT}${by ? ` by ${by}` : ''}${from === LEGACY_FORMATS[1] ? ': model used unknown until now' : ''}`

// ─── Plan: main checkout, configuration, plan-lint, frontmatter, HANDOFF.md ─────────────────────────────────────
const isPlan = d => existsSync(join(d, 'tasks')) || existsSync(join(d, 'taches'))
// The main checkout is the first block of « git worktree list --porcelain » (as status.mjs): the progress files always live there
function locate(arg) {
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
  tasks: [], runs: [], issues: [], auto_decisions: [], reviews: [], prerequisites: [], handoff: {}, lint: { ok: true, errors: [] }, log: [], log_omitted: 0,
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
  if (Array.isArray(L.prerequisites)) doc.prerequisites = L.prerequisites.filter(p => RE_ID.test(p.id)).map(p => ({ id: p.id, type: String(p.type ?? ''), status: String(p.status ?? ''), text: String(p.text ?? ''), blocks: p.blocks || [] }))
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

const checkFormat = doc => { if (!doc || (doc.format !== FORMAT && !LEGACY_FORMATS.includes(doc.format))) refuse(`progress.json is in format ${doc && doc.format}, this reader reads ${[FORMAT, ...LEGACY_FORMATS].join(', ')}`) }
const CONVERTED = Symbol('converted from a legacy format')

function load(ctx) {
  const f = join(ctx.dir, 'progress.json')
  if (!existsSync(f)) return null
  let doc
  try { doc = JSON.parse(readFileSync(f, 'utf8')) } catch (e) { refuse(`progress.json unreadable (${e.message}): fix it, or delete it so that it is rebuilt from PROGRESS.md, HANDOFF.md and plan-lint`) }
  checkFormat(doc)
  if (doc.format === FORMAT) return doc
  const converted = convertLegacy(doc)
  converted[CONVERTED] = doc.format
  return converted
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

// Lock: exclusive creation; a lock whose process no longer runs, or older than a minute, is removed
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
function underLock(ctx, fn) {
  const p = join(ctx.dir, '.progress.lock'), deadline = Date.now() + 20000
  for (;;) {
    try { const fd = openSync(p, 'wx'); writeSync(fd, `${process.pid}\n`); closeSync(fd); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const pid = Number((readOrNull(p) || '').split('\n')[0]) || 0, age = attempt(() => Date.now() - statSync(p).mtimeMs)
      if ((pid && !alive(pid)) || (age != null && age > 60000)) { attempt(() => unlinkSync(p)); continue }
      if (Date.now() > deadline) refuse(`lock ${ctx.rel}/.progress.lock held by process ${pid || '?'} for more than 20 s; if it no longer runs, delete the file`)
      sleep(10 + Math.floor(Math.random() * 30))
    }
  }
  try { return fn() } finally { attempt(() => unlinkSync(p)) }
}
// Temporary file renamed: a reader never sees a half-written file
function writeFile(ctx, name, content) {
  const tmp = join(ctx.dir, `.progress.${process.pid}.${name === 'PROGRESS.md' ? 'view.' : ''}tmp`)
  try { writeFileSync(tmp, content); renameSync(tmp, join(ctx.dir, name)) } finally { attempt(() => unlinkSync(tmp)) }
}

export const truncate = doc => { const k = doc.log.length - LOG_MAX; if (k > 0) { doc.log.splice(0, k); doc.log_omitted += k } }

// One write: plan-lint and HANDOFF.md read outside the lock, then under the lock: read, change, derived fields, validation, write.
// change(doc, tools) returns { view: true } for a durable transition: PROGRESS.md regenerated, plan fields reread.
function write(ctx, change, { runStart = false } = {}) {
  const L = planLint(ctx), handoff = readOrNull(join(ctx.dir, 'HANDOFF.md')) || ''
  return underLock(ctx, () => {
    const at = now()
    const existing = load(ctx)
    if (!existing && !L.tasks) refuse(`${L.errors[0]}: progress.json missing, it cannot be rebuilt without plan-lint; nothing is written`)
    const doc = existing || rebuild(ctx, L, handoff, at)
    const J = logger(doc, at)
    if (existing && existing[CONVERTED]) J('run', null, conversionNote(existing[CONVERTED]))
    if (!L.tasks) { const note = `${L.errors[0]}: plan fields, git statuses and prerequisites kept as they are`; if (!doc.log.slice(-20).some(e => e.text === clip(note, 300))) J('error', null, note) }
    if (!existing || runStart) excludeFromGit(ctx.root, ctx.rel)
    const r = change(doc, { L, handoff, at, J, ctx }) || {}
    if (r.view && existing) sync(doc, L, ctx, J, { statuses: false })
    derive(doc, L, handoff)
    doc.updated = at
    truncate(doc)
    const err = validate(doc)
    if (err.length) refuse(`write refused, progress.json unchanged:\n${err.slice(0, 12).map(e => '  - ' + e).join('\n')}${err.length > 12 ? `\n  - … ${err.length - 12} more` : ''}`)
    const viewText = r.view ? render(doc, readOrNull(join(ctx.dir, 'PROGRESS.md'))) : null
    writeFile(ctx, 'progress.json', JSON.stringify(doc, null, 2) + '\n')
    if (viewText != null) writeFile(ctx, 'PROGRESS.md', viewText)
    return { doc, ...r }
  })
}

// ─── Write commands ─────────────────────────────────────────────────────────────────────────────────────────
function runStart(doc, E, { L, handoff, J, at, ctx }) {
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

const optionWithoutActions = o => ({ id: o.id, description: o.description ?? '', ...(o.impact !== undefined ? { impact: o.impact } : {}), ...(o.recommended !== undefined ? { recommended: o.recommended } : {}) })
const issueOf = (p, run, task, role) => ({
  run, task: p.task ?? task, title: p.title, context: p.context ?? '', human: !!p.human, role: p.role ?? role, status: 'open', chosen_option: null,
  options: (p.options || []).map(optionWithoutActions), ...(p.circuit_breaker ? { circuit_breaker: true } : {}), ...(p.inconsistency ? { inconsistency: p.inconsistency } : {}),
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
  for (const d of list(E, 'auto_decisions')) {
    doc.auto_decisions.push({ run: nrun(), task: d.task ?? t.id, title: d.title, option: d.option, description: d.description })
    J('auto-decision', t.id, `${t.id}: "${d.title}", option ${d.option} taken automatically`)
  }
  for (const p of list(E, 'issues')) {
    doc.issues.push(issueOf(p, nrun(), t.id, 'open'))
    J('issue', t.id, `${t.id}: issue "${p.title}"${p.human ? ' (human)' : ''}`)
  }
  const skipped = add(doc, list(E, 'added_tasks'), t.id, tools)
  logAmendments(E, J, t.id)
  return { view: true, message: `${t.id} ${E.status}; PROGRESS.md regenerated${notAdded(skipped)}` }
}

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

function runEnd(doc, E, tools) {
  const { J, at } = tools
  const run = currentRun(doc) || refuse('no run in progress: run run-start first')
  if (!RUN_ENDS.includes(E.status)) refuse(`run-end: unknown status "${E.status}" (${RUN_ENDS.join(', ')})`)
  run.status = E.status
  run.end = at
  run.detail = E.detail == null ? null : Array.isArray(E.detail) ? E.detail.map(String).join('; ') : String(E.detail)
  // Summary lists: they are the source of truth for this run
  const ids = k => list(E, k).map(x => (typeof x === 'string' ? x : x && x.id))
  if (E.rulings_applied) run.rulings_applied = list(E, 'rulings_applied').map(a => ({ task: a.task, title: a.title, option: String(a.option && typeof a.option === 'object' ? a.option.id : a.option) }))
  if (E.discarded_amendments) run.discarded_amendments = list(E, 'discarded_amendments').map(a => ({ task: a.task, id: a.id, reason: a.reason ?? '' }))
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
    doc.issues.push(issueOf(p, run.number, p.task, role))
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

// ─── Read: plan status, as status.mjs, with the current step when a run is going ───────────────────────────────
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`
const bar = (r, n) => { const k = Math.floor(r * n); return '█'.repeat(k) + '░'.repeat(n - k) }
const pct = (f, n) => Math.floor((100 * f) / n)
const ago = ts => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts))
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
}
const shorten = (xs, max) => (xs.length > max ? [...xs.slice(0, max - 1), `+${xs.length - max + 1}`] : xs)

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
  const active = L.tasks.map(t => ({ ...t, status: statusOf(t) })).filter(t => t.status !== 'cancelled')
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
  const log = attempt(() => git(['log', '--format=%ct%x09%s', base && base !== integ ? `${base}..${integ}` : integ, '--'], root)) || ''
  const merge = log.split('\n').map(l => l.split('\t')).find(([, s]) => MERGE.test(s || ''))

  const yourTurn = []
  for (const p of (L.prerequisites || []).filter(x => x.status === 'open' && (x.blocks || []).length)) yourTurn.push(`${p.id} (${p.type}) blocks ${shorten(p.blocks, 4).join(', ')}`)
  for (const [st, what] of Object.entries(ATTENTION)) for (const t of active.filter(x => x.status === st && !inStep(x))) yourTurn.push(`${t.id} ${what}`)
  const counts = parseHandoff(handoff).counts
  const count = type => Object.values(counts).reduce((n, c) => n + (c[type] ? c[type].minor + c[type].major : 0), 0)
  const reviews = count('review'), tickets = count('ticket')
  if (reviews) yourTurn.push(`${plural(reviews, 'review')} before the PR`)
  if (tickets) yourTurn.push(`${plural(tickets, 'ticket')} after the PR`)
  if (!L.ok) yourTurn.push(`plan-lint: ${plural((L.errors || []).length, 'error')}`)
  if (note) yourTurn.push(note)

  const phases = [...new Set(active.map(t => t.phase))].sort((a, b) => a - b)
  const started = ph => active.some(t => t.phase === ph && (done(t) || inProgress.some(e => e.id === t.id)))
  const current = phases.find(ph => active.some(t => t.phase === ph && !done(t)))
  const doneCount = active.filter(done).length
  const m = merge && merge[1].match(MERGE)
  const out = [
    `## ${name} — ${doneCount}/${plural(active.length, 'task')} · ${pct(doneCount, active.length)}%`,
    `\`${bar(doneCount / active.length, 24)}\` ${current == null ? 'plan finished' : `phase ${current} ${started(current) ? 'in progress' : 'not started'}`}${m ? ` · last merge ${m[1] || m[2]} ${ago(Number(merge[0]))}` : ''}${run ? ` · run ${run.number} (${run.mode}) opened ${ago(Date.parse(run.start) / 1000)}` : ''}`,
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
  out.push('', `**Your turn**: ${yourTurn.length ? shorten(yourTurn, 6).join(' · ') : 'nothing for now'}`)
  return out.join('\n')
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

const WRITES = { 'run-start': runStart, step, close, ruling, 'run-end': runEnd, pilot }
const USAGE = 'usage: progress.mjs <run-start|step|close|ruling|run-end|pilot|view|status|validate> [<plan-dir>] [--stdout] [--file <progress.json>] [--json <object>]; for writes, JSON in --json or on standard input'

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
  if (cmd === 'validate') {
    const f = file ? resolve(file) : join(locate(arg).dir, 'progress.json')
    if (!existsSync(f)) refuse(`${f}: missing; it will be rebuilt at the next write`)
    let doc
    try { doc = JSON.parse(readFileSync(f, 'utf8')) } catch (e) { refuse(`progress.json unreadable: ${e.message}`) }
    checkFormat(doc)
    // A legacy file is validated as it will be converted
    const from = doc.format === FORMAT ? null : doc.format
    if (from) doc = convertLegacy(doc)
    const err = validate(doc)
    if (err.length) refuse(`progress.json invalid:\n${err.map(e => '  - ' + e).join('\n')}`)
    console.log(`progress: progress.json valid (${from ? `${from}, converted to ${FORMAT} at the next write` : FORMAT}, ${plural(doc.tasks.length, 'task')}, ${plural(doc.runs.length, 'run')})`)
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
  const ctx = locate(arg), E = input(json)
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
