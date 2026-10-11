#!/usr/bin/env node
// suivi (orchestre plugin 0.11.0): sole writer of plans/<name>/suivi.json (format orchestre-suivi/2) and of its view SUIVI.md.
// Node 18 or later, no dependencies. Contract: 0.11.0/CONTRAT.md; schema: SCHEMA below, a copy of suivi.v2.schema.json.
// A suivi.json in format orchestre-suivi/1 (0.10 and earlier) is read and migrated in memory; the first write turns it into /2.
//
// Usage: node <plugin root>/scripts/suivi.mjs <command> [<plan-dir>] [options]
// Writes read a JSON object on standard input, or in the option --json '<object>' (a single command to allow,
// without heredoc or pipe: this is the form the workflow gives its agents). Without a folder, the only plan in plans/.
//   debut-run  { phase, mode, parallelisme, corrections_max, decisions_office_max, run_id? }
//              once per run, by its first agent: rereads the plan (plan-lint), turns a run left in progress into « interrompu »
//   etape      { tache, etape, isole?, refus?, modele?, changement? }      step: worker, vérification, évaluation, correction, fusion,
//              replanification, suivi; worker resets the task's run fields; correction adds refus { essai, par, manques };
//              modele: the model launched (worker, correction), noted in modele_utilise; changement { de, vers, raison }: « modele » event
//   cloture    { tache, statut, essais, branche, tokens_reels?, refus?, instables?, non_verifiables?, blocage?, relectures?,
//                decisions_office?, points?, taches_ajoutees?, amendements?, replanification? }      regenerates SUIVI.md
//   arbitrage  { tache, titre, option, taches_ajoutees?, amendements?, amendements_ecartes? }      regenerates SUIVI.md
//   fin-run    the workflow's return value (statut, detail, arbitrage, points_a_trancher, taches…);
//              closes, from the summary, the tasks left without a close (workflow exception, E:316) and then regenerates SUIVI.md
//   pilote     { tache, statut: "fusionnée" | "annulée", raison? }      pilot's manual action; regenerates SUIVI.md
//   vue [--stdout]          regenerates SUIVI.md (or prints it without writing anything); statuses reread from SUIVI.md and git, as debut-run
//   etat                    progress as compact Markdown, like /orchestre:etat; read-only, always code 0
//   valider [--fichier <f>] validates suivi.json against the schema
// Exit codes: 0 done; 1 write refused, suivi.json and SUIVI.md unchanged; 2 invalid call.
//
// Guarantees: lock plans/<name>/.suivi.lock (8 tasks at most in parallel); write to .suivi.<pid>.tmp then rename;
// validation of each write; files always in the main checkout, even when called from a worktree;
// suivi.json, .suivi.lock and .suivi.*.tmp added to .git/info/exclude if not already ignored.
// suivi.json absent: rebuilt from SUIVI.md, HANDOFF.md and plan-lint; the run fields start empty again.
import { readFileSync, writeFileSync, existsSync, readdirSync, openSync, closeSync, writeSync, renameSync, unlinkSync, statSync, mkdirSync, appendFileSync, realpathSync } from 'node:fs'
import { join, resolve, relative, dirname, basename, isAbsolute, sep } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const FORMAT = 'orchestre-suivi/2'
// Format of 0.10 and earlier: read, then migrated (migrate)
export const FORMAT_V1 = 'orchestre-suivi/1'
const STATUSES = ['à-faire', 'ajoutée', 'fusionnée', 'bloquée', 'échec', 'besoin-humain', 'annulée']
const STEPS = ['worker', 'vérification', 'évaluation', 'correction', 'fusion', 'replanification', 'suivi']
const RUN_ENDS = ['terminé', 'partiel', 'arbitrage', 'à-relancer', 'erreur']
const CLOSES = ['fusionnée', 'bloquée', 'échec', 'besoin-humain']
const LOG_MAX = 200
const RE_ID = /^[A-Z]+[0-9]+[A-Z]*$/
const DONE = s => s === 'fusionnée' || s === 'annulée'
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
const LINT = join(dirname(fileURLToPath(import.meta.url)), 'plan-lint.mjs')

class Refusal extends Error { constructor(m) { super(m); this.code = 1 } }
class UsageError extends Error { constructor(m) { super(m); this.code = 2 } }
const refuse = m => { throw new Refusal(m) }
const attempt = f => { try { return f() } catch { return null } }
const readOrNull = f => attempt(() => readFileSync(f, 'utf8'))
const git = (args, cwd) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const real = p => attempt(() => realpathSync(p)) || resolve(p)
const clip = (s, n = 140) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const width = s => [...s].length
const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ')

// ISO 8601 date with the machine's time zone, to the second: 2026-10-05T10:16:00+02:00
export function now(d = new Date()) {
  const p = n => String(n).padStart(2, '0'), o = -d.getTimezoneOffset(), a = Math.abs(o)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${o >= 0 ? '+' : '-'}${p(Math.floor(a / 60))}:${p(a % 60)}`
}

// ─── Schema orchestre-suivi/2, without the descriptions ────────────────────────────────────────────────────────────────
const ref = n => ({ $ref: `#/$defs/${n}` })
const arrayOf = items => ({ type: 'array', items })
const object = (required, properties, extra = {}) => ({ type: 'object', additionalProperties: false, required, properties, ...extra })
const INT1 = { type: 'integer', minimum: 1 }
export const SCHEMA = {
  ...object(['format', 'plan', 'dossier', 'integration', 'base', 'maj', 'taches', 'runs', 'points', 'decisions_office', 'relectures', 'prerequis', 'handoff', 'lint', 'journal', 'journal_omis'], {
    format: { const: FORMAT },
    plan: { type: 'string', minLength: 1 },
    dossier: { type: 'string', minLength: 1 },
    integration: { type: 'string', minLength: 1 },
    base: { type: ['string', 'null'] },
    maj: ref('date'),
    taches: arrayOf(ref('tache')),
    runs: arrayOf(ref('run')),
    points: arrayOf(ref('point')),
    decisions_office: arrayOf(ref('decisionOffice')),
    relectures: arrayOf(ref('relecture')),
    prerequis: arrayOf(ref('prerequis')),
    handoff: { type: 'object', additionalProperties: { type: 'object', additionalProperties: ref('compte') } },
    lint: object(['ok', 'erreurs'], { ok: { type: 'boolean' }, erreurs: arrayOf({ type: 'string' }) }),
    journal: { type: 'array', maxItems: LOG_MAX, items: ref('evenement') },
    journal_omis: { type: 'integer', minimum: 0 },
  }),
  $defs: {
    date: { type: 'string', format: 'date-time' },
    dateOuNull: { oneOf: [ref('date'), { type: 'null' }] },
    idTache: { type: 'string', pattern: '^[A-Z]+[0-9]+[A-Z]*$' },
    textes: arrayOf({ type: 'string' }),
    ids: arrayOf(ref('idTache')),
    compte: object(['mineur', 'majeur'], { mineur: { type: 'integer', minimum: 0 }, majeur: { type: 'integer', minimum: 0 } }),
    tache: object(['id', 'titre', 'phase', 'lot', 'depend_de', 'modele', 'modele_utilise', 'statut', 'essais', 'branche', 'estimation_tokens', 'tokens_reels', 'ajoutee_par', 'etape', 'isole', 'debut', 'fin', 'attend', 'refus', 'instables', 'non_verifiables', 'blocage'], {
      id: ref('idTache'),
      titre: { type: 'string', minLength: 1 },
      phase: INT1,
      lot: { type: ['string', 'null'] },
      depend_de: ref('ids'),
      modele: { type: ['string', 'null'], minLength: 1 },
      modele_utilise: { type: ['string', 'null'], minLength: 1 },
      statut: { enum: STATUSES },
      essais: { type: 'integer', minimum: 0 },
      branche: { type: ['string', 'null'] },
      estimation_tokens: { type: ['number', 'null'], minimum: 0 },
      tokens_reels: { type: ['string', 'null'] },
      ajoutee_par: { oneOf: [ref('idTache'), { type: 'null' }] },
      etape: { enum: [...STEPS, null] },
      isole: { type: ['boolean', 'null'] },
      debut: ref('dateOuNull'),
      fin: ref('dateOuNull'),
      attend: arrayOf({ type: 'string', minLength: 1 }),
      refus: arrayOf(object(['essai', 'par', 'manques'], { essai: INT1, par: { enum: ['vérification', 'évaluation'] }, manques: ref('textes') })),
      instables: ref('textes'),
      non_verifiables: ref('textes'),
      blocage: ref('textes'),
    }),
    run: object(['numero', 'run_id', 'phase', 'mode', 'parallelisme', 'corrections_max', 'decisions_office_max', 'statut', 'debut', 'fin', 'detail', 'arbitrages_appliques', 'amendements_ecartes', 'taches_ajoutees', 'reportees', 'non_lancees', 'en_attente', 'en_attente_prerequis'], {
      numero: INT1,
      run_id: { type: ['string', 'null'] },
      phase: INT1,
      mode: { enum: ['auto', 'devia', 'phase'] },
      parallelisme: { type: 'integer', minimum: 1, maximum: 8 },
      corrections_max: { type: 'integer', minimum: 0 },
      decisions_office_max: { type: 'integer', minimum: 0 },
      statut: { enum: ['en-cours', ...RUN_ENDS, 'interrompu'] },
      debut: ref('date'),
      fin: ref('dateOuNull'),
      detail: { type: ['string', 'null'] },
      arbitrages_appliques: arrayOf(object(['tache', 'titre', 'option'], { tache: ref('idTache'), titre: { type: 'string' }, option: { type: 'string' } })),
      amendements_ecartes: arrayOf(object(['tache', 'id', 'raison'], { tache: ref('idTache'), id: ref('idTache'), raison: { type: 'string' } })),
      taches_ajoutees: arrayOf(object(['id', 'phase', 'titre'], { id: ref('idTache'), phase: INT1, titre: { type: 'string' } })),
      reportees: ref('ids'),
      non_lancees: ref('ids'),
      en_attente: ref('ids'),
      en_attente_prerequis: arrayOf(object(['id', 'prerequis'], { id: ref('idTache'), prerequis: arrayOf({ type: 'string' }) })),
    }),
    point: object(['run', 'tache', 'titre', 'contexte', 'humain', 'role', 'statut', 'option_choisie', 'options'], {
      run: INT1,
      tache: ref('idTache'),
      titre: { type: 'string', minLength: 1 },
      contexte: { type: 'string' },
      humain: { type: 'boolean' },
      role: { enum: ['arret', 'a-trancher'] },
      statut: { enum: ['ouvert', 'tranché'] },
      option_choisie: { type: ['string', 'null'] },
      coupe_circuit: { type: 'boolean' },
      incoherence: { type: 'string' },
      options: arrayOf(object(['id', 'description'], { id: { type: 'string', minLength: 1 }, description: { type: 'string' }, impact: { type: 'string' }, recommande: { type: 'boolean' } })),
    }),
    decisionOffice: object(['run', 'tache', 'titre', 'option', 'description'], { run: INT1, tache: ref('idTache'), titre: { type: 'string' }, option: { type: 'string' }, description: { type: 'string' } }),
    relecture: object(['tache', 'phase', 'texte', 'run', 'quand'], {
      tache: { oneOf: [ref('idTache'), { type: 'null' }] },
      phase: { type: ['integer', 'null'], minimum: 1 },
      texte: { type: 'string', minLength: 1 },
      run: { type: ['integer', 'null'], minimum: 1 },
      quand: ref('dateOuNull'),
    }),
    prerequis: object(['id', 'type', 'statut', 'texte', 'bloque'], { id: ref('idTache'), type: { type: 'string' }, statut: { type: 'string' }, texte: { type: 'string' }, bloque: ref('ids') }),
    evenement: object(['quand', 'genre', 'tache', 'texte'], {
      quand: ref('date'),
      genre: { enum: ['run', 'tache', 'etape', 'refus', 'statut', 'ajout', 'amendement', 'relecture', 'decision-office', 'point', 'arbitrage', 'pilote', 'erreur', 'modele'] },
      tache: { oneOf: [ref('idTache'), { type: 'null' }] },
      texte: { type: 'string', minLength: 1 },
    }),
  },
}

// Hand-written validation: the subset of JSON Schema that SCHEMA uses
const RE_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const describe = x => (x === undefined ? 'rien' : typeof x === 'string' ? `« ${clip(x, 40)} »` : clip(JSON.stringify(x), 40))
const isOfType = (t, x) => ({ null: x === null, boolean: typeof x === 'boolean', string: typeof x === 'string', integer: Number.isInteger(x), number: typeof x === 'number' && Number.isFinite(x), array: Array.isArray(x), object: !!x && typeof x === 'object' && !Array.isArray(x) })[t]
function check(s, x, at, err) {
  if (s.$ref) s = SCHEMA.$defs[s.$ref.split('/').pop()]
  if (s.oneOf) {
    if (s.oneOf.filter(o => { const e = []; check(o, x, at, e); return !e.length }).length !== 1) err.push(`${at} : ${describe(x)} ne correspond à aucune forme permise`)
    return
  }
  if ('const' in s && x !== s.const) return err.push(`${at} : ${describe(x)} au lieu de « ${s.const} »`)
  if (s.enum && !s.enum.includes(x)) return err.push(`${at} : ${describe(x)} n'est pas permis (${s.enum.map(e => e ?? 'null').join(', ')})`)
  if (s.type && ![].concat(s.type).some(t => isOfType(t, x))) return err.push(`${at} : ${[].concat(s.type).join(' ou ')} attendu, ${describe(x)} reçu`)
  if (typeof x === 'string') {
    if (s.minLength && width(x) < s.minLength) err.push(`${at} : texte vide`)
    if (s.pattern && !new RegExp(s.pattern).test(x)) err.push(`${at} : ${describe(x)} ne suit pas le motif ${s.pattern}`)
    if (s.format === 'date-time' && !(RE_DATE.test(x) && !Number.isNaN(Date.parse(x)))) err.push(`${at} : ${describe(x)} n'est pas une date ISO 8601 avec fuseau`)
  }
  if (typeof x === 'number') {
    if (s.minimum != null && x < s.minimum) err.push(`${at} : ${x} est inférieur à ${s.minimum}`)
    if (s.maximum != null && x > s.maximum) err.push(`${at} : ${x} est supérieur à ${s.maximum}`)
  }
  if (Array.isArray(x)) {
    if (s.maxItems != null && x.length > s.maxItems) err.push(`${at} : ${x.length} éléments, ${s.maxItems} au plus`)
    if (s.items) x.forEach((y, i) => check(s.items, y, `${at}[${i}]`, err))
  } else if (x && typeof x === 'object') {
    for (const k of s.required || []) if (x[k] === undefined) err.push(`${at ? at + '.' : ''}${k} : manquant`)
    for (const [k, y] of Object.entries(x)) {
      if (y === undefined) continue
      const sk = s.properties && s.properties[k]
      if (sk) check(sk, y, at ? `${at}.${k}` : k, err)
      else if (s.additionalProperties === false) err.push(`${at ? at + '.' : ''}${k} : champ inconnu du format ${FORMAT}`)
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') check(s.additionalProperties, y, at ? `${at}.${k}` : k, err)
    }
  }
}
export function validate(doc) { const err = []; check(SCHEMA, doc, '', err); return err }

// ─── Plan: main checkout, configuration, plan-lint, frontmatter, HANDOFF.md ─────────────────────────────────────
// The main checkout is the first block of « git worktree list --porcelain » (as etat.mjs): the progress files always live there
function locate(arg) {
  const cwd = process.cwd()
  const here = attempt(() => git(['rev-parse', '--show-toplevel'], cwd).trim())
  if (!here) throw new UsageError('pas dans un dépôt git')
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
    if (!existsSync(join(mainCheckout, rel, 'taches'))) throw new UsageError(`plan introuvable dans ce checkout : ${arg}`)
  } else {
    const p = join(mainCheckout, 'plans')
    const plans = existsSync(p) ? readdirSync(p).filter(n => existsSync(join(p, n, 'taches'))).sort() : []
    if (!plans.length) throw new UsageError('aucun plan dans plans/ ; précise son dossier : plans/<nom>')
    if (plans.length > 1) throw new UsageError(`plusieurs plans (${plans.map(n => 'plans/' + n).join(', ')}) ; précise lequel`)
    rel = join('plans', plans[0])
  }
  const dir = join(mainCheckout, rel), name = basename(dir)
  const cfg = attempt(() => JSON.parse(readFileSync(join(dir, 'orchestre.config.json'), 'utf8'))) || {}
  const integration = cfg.branche_integration || `plan/${name}`, base = cfg.branche_base || null
  // A branch name that starts with « - » would be read by git as an option
  if ([integration, base].some(b => b && String(b).startsWith('-'))) throw new UsageError('branche invalide dans orchestre.config.json')
  return { root: mainCheckout, dir, rel: rel.split(sep).join('/') || '.', name, integration, base }
}

// plan-lint is the source of truth for the frontmatter (amendments included), the statuses (git included) and the prerequisites
function planLint(ctx) {
  const r = spawnSync(process.execPath, [LINT, ctx.rel, '--json', '--integration', ctx.integration, ...(ctx.base ? ['--base', ctx.base] : [])], { cwd: ctx.root, env: ENV, encoding: 'utf8', maxBuffer: 1 << 26 })
  const L = attempt(() => JSON.parse(r.stdout))
  if (L && Array.isArray(L.taches)) return L
  return { ok: false, erreurs: [`plan-lint n'a pas rendu d'état (${String(r.stderr || r.stdout || 'sans message').trim().split('\n')[0]})`], taches: null, prerequis: null }
}

function unquote(v) {
  v = v.trim()
  if (v.startsWith('"')) { const m = v.match(/^"((?:[^"\\]|\\.)*)"/); return m ? m[1].replace(/\\(["\\])/g, '$1') : v }
  if (v.startsWith("'")) { const m = v.match(/^'((?:[^']|'')*)'/); return m ? m[1].replace(/''/g, "'") : v }
  return v.replace(/\s+#.*$/, '').trim()
}
// What plan-lint does not return: lot_parallele, and whether estimation_tokens is present (plan-lint returns 0 for a missing estimate)
function frontmatter(ctx, file) {
  const fm = (readOrNull(resolve(ctx.root, file)) || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || ''
  const val = k => { const m = fm.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm')); return m ? unquote(m[1]) : null }
  return { batch: val('lot_parallele') || null, estimate: !!val('estimation_tokens') }
}

// Entries « type · severity · description », filed under « ## <id> » or « ## plan source » (scribe.md)
function parseHandoff(text) {
  const counts = {}, reviews = []
  let section = null
  for (const line of String(text || '').split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/)
    if (h) { section = h[1]; continue }
    const m = line.match(/^\s*(?:[-*]\s*)?([\p{L}][\p{L}-]*)\s*·\s*(mineur|majeur)\s*·\s*(.*)$/iu)
    if (!m) continue
    const type = m[1].toLowerCase(), severity = m[2].toLowerCase(), key = section ?? '(avant les sections)'
    const c = ((counts[key] ||= {})[type] ||= { mineur: 0, majeur: 0 })
    c[severity]++
    if (type === 'relecture' && m[3].trim()) reviews.push({ tache: RE_ID.test(section || '') ? section : null, texte: m[3].trim() })
  }
  return { counts, reviews }
}

// ─── SUIVI.md: the table only, the text around it kept byte for byte ───────────────────────────────────────────────
// Cells of a Markdown table row; « \| » is a « | » inside a cell (as plan-lint)
const cells = line => {
  const l = line.trim(), p = l.split(/(?<!\\)\|/)
  if (p.length && p[0].trim() === '') p.shift()
  if (/(?<!\\)\|$/.test(l)) p.pop()
  return p.map(c => c.trim().replace(/\\\|/g, '|'))
}
const escapeCell = s => String(s).replace(/\|/g, '\\|')
const COLUMNS = { id: 'ID', titre: 'Titre', phase: 'Phase', lot: 'Lot', 'depend de': 'Dépend de', modele: 'Modèle', statut: 'Statut', essais: 'Essais', branche: 'Branche', tokens: 'Tokens est. / réels' }
const columnKey = name => { const n = norm(name); return n.startsWith('tokens') ? 'tokens' : n in COLUMNS ? n : null }
const LEGEND = `Statuts : ${STATUSES.join(' · ')}`

// The table: from the header row that contains ID and Statut (plan-lint's marker) to the last following row that starts with « | »
function table(text) {
  const lines = text.split('\n'), net = l => l.replace(/\r$/, '')
  const h = lines.findIndex(l => net(l).trim().startsWith('|') && cells(net(l)).includes('ID') && cells(net(l)).includes('Statut'))
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
  const header = cells(net(lines[h])), iId = header.indexOf('ID'), iSt = header.indexOf('Statut'), orphans = []
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
    if (seen.has(id) && !orphan) refuse(`SUIVI.md, ligne ${n} : ${id} en double`)
    seen.add(id)
    const status = col(row, 'statut')
    if (!STATUSES.includes(status)) refuse(`SUIVI.md, ligne ${n} : statut inconnu « ${status} » pour ${id} (${STATUSES.join(', ')})`)
    const tok = col(row, 'tokens'), i = tok.indexOf(' / '), actual = i >= 0 ? tok.slice(i + 3).trim() : ''
    const phase = Number(col(row, 'phase')), attempts = Number(col(row, 'essais'))
    const l = {
      id, titre: col(row, 'titre') || id, statut: status, essais: Number.isInteger(attempts) && attempts >= 0 ? attempts : 0,
      branche: empty(col(row, 'branche')) ? null : col(row, 'branche'), tokens_reels: empty(actual) ? null : actual,
      phase: Number.isInteger(phase) && phase >= 1 ? phase : undefined, modele: empty(col(row, 'modele')) ? null : col(row, 'modele'),
      lot: empty(col(row, 'lot')) ? null : col(row, 'lot'), depend_de: empty(col(row, 'depend de')) ? [] : col(row, 'depend de').split(/\s*,\s*/).filter(Boolean),
    }
    // A row under the legend that repeats a task already read replaces it, in its place: plan-lint also reads the last one
    const j = out.findIndex(x => x.id === id)
    if (j >= 0) out[j] = l
    else out.push(l)
  }
  return out
}

const millions = n => (n == null ? '—' : `${n.toFixed(1).replace('.', ',')} M`)
function cell(t, k) {
  switch (k) {
    case 'id': return t.id
    case 'titre': return t.titre
    case 'phase': return String(t.phase)
    case 'lot': return t.lot ?? '—'
    case 'depend de': return t.depend_de.length ? t.depend_de.join(', ') : '—'
    case 'modele': return t.modele ?? '—'
    case 'statut': return t.statut
    case 'essais': return String(t.essais)
    case 'branche': return t.branche ?? '—'
    case 'tokens': return `${millions(t.estimation_tokens)} / ${t.tokens_reels ?? '—'}`
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
  const body = doc.taches.map(t => keys.map((k, j) => escapeCell(k ? cell(t, k) : (previous.get(t.id) || [])[j] ?? '')))
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
    const iId = keys.indexOf('id'), inDoc = new Set(doc.taches.map(t => t.id))
    const takenBack = new Set(tb.orphans.filter(l => inDoc.has(l.cells[iId])).map(l => l.i))
    return [...tb.lines.slice(0, tb.h), ...lines, ...tb.lines.slice(tb.end + 1).filter((_, k) => !takenBack.has(tb.end + 1 + k))].join('\n')
  }
  if (text != null) return text.replace(/\n*$/, '\n\n') + lines.join('\n') + '\n'
  return `# SUIVI — ${doc.plan}\n\n${lines.join('\n')}\n\n${LEGEND}\n`
}

// ─── Document ─────────────────────────────────────────────────────────────────────────────────────────────────────
const newTask = x => ({
  id: x.id, titre: x.titre || x.id, phase: x.phase, lot: x.lot ?? null, depend_de: x.depend_de ?? [], modele: x.modele ?? null, modele_utilise: null,
  statut: x.statut ?? 'à-faire', essais: x.essais ?? 0, branche: x.branche ?? null, estimation_tokens: x.estimation_tokens ?? null,
  tokens_reels: x.tokens_reels ?? null, ajoutee_par: x.ajoutee_par ?? null, etape: null, isole: null, debut: null, fin: null,
  attend: [], refus: [], instables: [], non_verifiables: [], blocage: [],
})
const emptyDoc = (ctx, at) => ({
  format: FORMAT, plan: ctx.name, dossier: ctx.rel, integration: ctx.integration, base: ctx.base, maj: at,
  taches: [], runs: [], points: [], decisions_office: [], relectures: [], prerequis: [], handoff: {}, lint: { ok: true, erreurs: [] }, journal: [], journal_omis: 0,
})
const logger = (doc, at) => (kind, task, text) => doc.journal.push({ quand: at, genre: kind, tache: task ?? null, texte: clip(text, 300) })
const currentRun = doc => doc.runs.filter(r => r.statut === 'en-cours').pop() || null
const taskOf = (doc, id) => doc.taches.find(t => t.id === id) || refuse(`tâche inconnue du suivi : ${id}`)
const list = (E, k) => (E[k] == null ? [] : Array.isArray(E[k]) ? E[k] : refuse(`entrée : « ${k} » doit être une liste`))

// Places a task: after the last task of a lower or equal phase; an added task, after the one that gave birth to it
// and after those that task already gave birth to (descendants included)
function insert(doc, t, parent) {
  let pos = -1
  if (parent && doc.taches.some(x => x.id === parent)) {
    const desc = new Set([parent])
    for (let changed = true; changed;) { changed = false; for (const x of doc.taches) if (x.ajoutee_par && desc.has(x.ajoutee_par) && !desc.has(x.id)) { desc.add(x.id); changed = true } }
    doc.taches.forEach((x, i) => { if (desc.has(x.id)) pos = i })
  } else doc.taches.forEach((x, i) => { if (x.phase <= t.phase) pos = i })
  doc.taches.splice(pos + 1, 0, t)
}

// Plan fields of a task: plan-lint (frontmatter, amendments included), plus lot_parallele and whether the estimate is present
function planFields(ctx, lt) {
  const fm = frontmatter(ctx, lt.fichier)
  return {
    ...(Number.isInteger(lt.phase) && lt.phase >= 1 ? { phase: lt.phase } : {}),
    // Without a model in the frontmatter: null (0.11.0); the workflow then launches sonnet, then the escalation ladder
    modele: typeof lt.modele === 'string' && lt.modele.trim() ? lt.modele.trim() : null,
    depend_de: (lt.depend_de || []).map(String), lot: fm.batch, estimation_tokens: fm.estimate ? lt.estimation_tokens : null,
  }
}

// Plan fields from plan-lint. Statuses too at the start of a run and on rebuild: git and SUIVI.md are the source of truth
function sync(doc, L, ctx, J, { statuses }) {
  if (!L.taches) return
  const byId = new Map(L.taches.map(t => [t.id, t]))
  let rows = null
  const row = id => { rows = rows || new Map((attempt(() => parseProgress(readOrNull(join(ctx.dir, 'SUIVI.md')))) || []).map(l => [l.id, l])); return rows.get(id) }
  doc.taches = doc.taches.filter(t => byId.has(t.id) || (J('tache', t.id, `${t.id} retirée du suivi : aucun fichier de tâche dans ${ctx.rel}/taches/`), false))
  for (const lt of L.taches) {
    const plan = planFields(ctx, lt)
    let t = doc.taches.find(x => x.id === lt.id)
    if (!t) {
      if (!plan.phase) { J('erreur', null, `${lt.id} non ajoutée au suivi : phase absente du frontmatter`); continue }
      if (!STATUSES.includes(lt.statut)) refuse(`SUIVI.md : statut inconnu « ${lt.statut} » pour ${lt.id} (${STATUSES.join(', ')})`)
      const l = row(lt.id)
      t = newTask({ id: lt.id, titre: lt.titre, statut: lt.statut, ...(l ? { titre: l.titre, essais: l.essais, branche: l.branche, tokens_reels: l.tokens_reels } : {}), ...plan })
      insert(doc, t, null)
      J('ajout', t.id, `${t.id} ajoutée au suivi depuis son fichier de tâche (phase ${t.phase})`)
      continue
    }
    Object.assign(t, plan)
    if (statuses && lt.statut !== t.statut) {
      if (!STATUSES.includes(lt.statut)) refuse(`SUIVI.md : statut inconnu « ${lt.statut} » pour ${lt.id} (${STATUSES.join(', ')})`)
      J('statut', t.id, `${t.id} : ${t.statut} → ${lt.statut} (SUIVI.md et git)`)
      t.statut = lt.statut
    }
  }
}

// Reviews from HANDOFF.md missing from the progress file (written by /orchestre:preparer, or before suivi.json was lost)
function mergeReviews(doc, handoff) {
  for (const r of parseHandoff(handoff).reviews) {
    if (doc.relectures.some(x => x.tache === r.tache && x.texte === r.texte)) continue
    doc.relectures.push({ tache: r.tache, phase: doc.taches.find(t => t.id === r.tache)?.phase ?? null, texte: r.texte, run: null, quand: null })
  }
}

// Derived fields, recomputed at each write and valid as of the maj date
function derive(doc, L, handoff) {
  if (Array.isArray(L.prerequis)) doc.prerequis = L.prerequis.filter(p => RE_ID.test(p.id)).map(p => ({ id: p.id, type: String(p.type ?? ''), statut: String(p.statut ?? ''), texte: String(p.texte ?? ''), bloque: p.bloque || [] }))
  doc.lint = { ok: !!L.ok, erreurs: (L.erreurs || []).map(String) }
  doc.handoff = parseHandoff(handoff).counts
  const st = new Map(doc.taches.map(t => [t.id, t.statut]))
  for (const t of doc.taches) {
    t.attend = DONE(t.statut) ? [] : [...t.depend_de.filter(d => !DONE(st.get(d))), ...doc.prerequis.filter(p => p.statut === 'ouvert' && p.bloque.includes(t.id)).map(p => p.id)]
  }
}

function rebuild(ctx, L, handoff, at) {
  const doc = emptyDoc(ctx, at), J = logger(doc, at)
  for (const l of parseProgress(readOrNull(join(ctx.dir, 'SUIVI.md'))) || []) doc.taches.push(newTask(l))
  sync(doc, L, ctx, J, { statuses: true })
  mergeReviews(doc, handoff)
  J('run', null, 'suivi.json reconstruit depuis SUIVI.md, HANDOFF.md et plan-lint : dates, étapes, refus et journal repartent vides')
  return doc
}

// orchestre-suivi/1 → /2 (0.11.0): modele_utilise starts at null (the launched model was not noted); modele keeps its value.
// Returns true if the document was /1. Any other format is refused, without guessing.
export function migrate(doc) {
  if (!doc || doc.format !== FORMAT_V1) return false
  doc.format = FORMAT
  for (const t of Array.isArray(doc.taches) ? doc.taches : []) if (t && typeof t === 'object' && !Array.isArray(t) && t.modele_utilise === undefined) t.modele_utilise = null
  return true
}
const checkFormat = doc => { if (!doc || (doc.format !== FORMAT && doc.format !== FORMAT_V1)) refuse(`suivi.json est au format ${doc && doc.format}, ce lecteur lit ${FORMAT} et ${FORMAT_V1}`) }
const MIGRATED = Symbol('migré de /1')

function load(ctx) {
  const f = join(ctx.dir, 'suivi.json')
  if (!existsSync(f)) return null
  let doc
  try { doc = JSON.parse(readFileSync(f, 'utf8')) } catch (e) { refuse(`suivi.json illisible (${e.message}) : corrige-le, ou supprime-le pour qu'il soit reconstruit depuis SUIVI.md, HANDOFF.md et plan-lint`) }
  checkFormat(doc)
  if (migrate(doc)) doc[MIGRATED] = true
  return doc
}

// suivi.json and its working files out of git: otherwise a « modified » checkout at pre-flight, or a blocked git switch
function ignore(ctx) {
  const common = attempt(() => git(['rev-parse', '--git-common-dir'], ctx.root).trim())
  if (!common) return
  const ignored = p => attempt(() => git(['check-ignore', '-q', p], ctx.root)) != null
  const missing = [['suivi.json', 'suivi.json'], ['.suivi.lock', '.suivi.lock'], ['.suivi.0.tmp', '.suivi.*.tmp']].filter(([ex]) => !ignored(`${ctx.rel}/${ex}`)).map(([, m]) => `/${ctx.rel}/${m}`)
  if (!missing.length) return
  const f = join(resolve(ctx.root, common), 'info', 'exclude'), before = readOrNull(f) || ''
  mkdirSync(dirname(f), { recursive: true })
  appendFileSync(f, `${before && !before.endsWith('\n') ? '\n' : ''}# orchestre : suivi du plan ${ctx.rel}, hors git\n${missing.join('\n')}\n`)
}

// Lock: exclusive creation; a lock whose process no longer runs, or older than a minute, is removed
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
function underLock(ctx, fn) {
  const p = join(ctx.dir, '.suivi.lock'), deadline = Date.now() + 20000
  for (;;) {
    try { const fd = openSync(p, 'wx'); writeSync(fd, `${process.pid}\n`); closeSync(fd); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const pid = Number((readOrNull(p) || '').split('\n')[0]) || 0, age = attempt(() => Date.now() - statSync(p).mtimeMs)
      if ((pid && !alive(pid)) || (age != null && age > 60000)) { attempt(() => unlinkSync(p)); continue }
      if (Date.now() > deadline) refuse(`verrou ${ctx.rel}/.suivi.lock tenu par le processus ${pid || '?'} depuis plus de 20 s ; s'il ne tourne plus, supprime le fichier`)
      sleep(10 + Math.floor(Math.random() * 30))
    }
  }
  try { return fn() } finally { attempt(() => unlinkSync(p)) }
}
// Temporary file renamed: a reader never sees a half-written file
function writeFile(ctx, name, content) {
  const tmp = join(ctx.dir, `.suivi.${process.pid}.${name === 'SUIVI.md' ? 'vue.' : ''}tmp`)
  try { writeFileSync(tmp, content); renameSync(tmp, join(ctx.dir, name)) } finally { attempt(() => unlinkSync(tmp)) }
}

const truncate = doc => { const k = doc.journal.length - LOG_MAX; if (k > 0) { doc.journal.splice(0, k); doc.journal_omis += k } }

// One write: plan-lint and HANDOFF.md read outside the lock, then under the lock: read, change, derived fields, validation, write.
// change(doc, tools) returns { view: true } for a durable transition: SUIVI.md regenerated, plan fields reread.
function write(ctx, change, { runStart = false } = {}) {
  const L = planLint(ctx), handoff = readOrNull(join(ctx.dir, 'HANDOFF.md')) || ''
  return underLock(ctx, () => {
    const at = now()
    const existing = load(ctx)
    if (!existing && !L.taches) refuse(`${L.erreurs[0]} : suivi.json absent, il ne se reconstruit pas sans plan-lint ; rien n'est écrit`)
    const doc = existing || rebuild(ctx, L, handoff, at)
    const J = logger(doc, at)
    if (existing && existing[MIGRATED]) J('run', null, `suivi.json migré de ${FORMAT_V1} à ${FORMAT} : modèle utilisé inconnu jusqu'ici`)
    if (!L.taches) { const note = `${L.erreurs[0]} : champs de plan, statuts de git et prérequis gardés tels quels`; if (!doc.journal.slice(-20).some(e => e.texte === clip(note, 300))) J('erreur', null, note) }
    if (!existing || runStart) ignore(ctx)
    const r = change(doc, { L, handoff, at, J, ctx }) || {}
    if (r.view && existing) sync(doc, L, ctx, J, { statuses: false })
    derive(doc, L, handoff)
    doc.maj = at
    truncate(doc)
    const err = validate(doc)
    if (err.length) refuse(`écriture refusée, suivi.json inchangé :\n${err.slice(0, 12).map(e => '  - ' + e).join('\n')}${err.length > 12 ? `\n  - … ${err.length - 12} de plus` : ''}`)
    const viewText = r.view ? render(doc, readOrNull(join(ctx.dir, 'SUIVI.md'))) : null
    writeFile(ctx, 'suivi.json', JSON.stringify(doc, null, 2) + '\n')
    if (viewText != null) writeFile(ctx, 'SUIVI.md', viewText)
    return { doc, ...r }
  })
}

// ─── Write commands ─────────────────────────────────────────────────────────────────────────────────────────
function runStart(doc, E, { L, handoff, J, at, ctx }) {
  for (const r of doc.runs.filter(r => r.statut === 'en-cours')) { r.statut = 'interrompu'; J('run', null, `run ${r.numero} interrompu : resté en cours, sans fin de run`) }
  for (const t of doc.taches.filter(t => t.etape)) { J('etape', t.id, `${t.id} : étape « ${t.etape} » interrompue avec son run`); t.etape = null }
  sync(doc, L, ctx, J, { statuses: true })
  mergeReviews(doc, handoff)
  const number = (doc.runs.length ? doc.runs[doc.runs.length - 1].numero : 0) + 1
  doc.runs.push({
    numero: number, run_id: E.run_id ?? null, phase: E.phase, mode: E.mode, parallelisme: E.parallelisme, corrections_max: E.corrections_max, decisions_office_max: E.decisions_office_max,
    statut: 'en-cours', debut: at, fin: null, detail: null, arbitrages_appliques: [], amendements_ecartes: [], taches_ajoutees: [], reportees: [], non_lancees: [], en_attente: [], en_attente_prerequis: [],
  })
  J('run', null, `run ${number} : phase ${E.phase}, mode ${E.mode}, ${E.parallelisme} en parallèle`)
  return { message: `run ${number} ouvert (phase ${E.phase}, mode ${E.mode})` }
}

// Model launched by the worker or a fix (0.11.0), and the model change the workflow decided
const textOrNull = (x, field) => (x == null ? null : typeof x === 'string' && x.trim() ? x.trim() : refuse(`etape : « ${field} » doit être un texte non vide`))
function modelChange(E, model) {
  const c = E.changement
  if (c == null) return null
  if (typeof c !== 'object' || Array.isArray(c)) refuse('etape : « changement » doit être un objet { de, vers, raison }')
  const to = textOrNull(c.vers, 'changement.vers') ?? model
  if (!to) refuse('etape : changement sans modèle d\'arrivée (changement.vers ou modele)')
  if (model && to !== model) refuse(`etape : changement vers ${to}, mais modele vaut ${model}`)
  return { from: textOrNull(c.de, 'changement.de'), to, reason: c.raison == null ? '' : String(c.raison).replace(/\s+/g, ' ').trim() }
}
function step(doc, E, { J, at }) {
  const t = taskOf(doc, E.tache)
  const model = textOrNull(E.modele, 'modele'), ch = modelChange(E, model)
  if (E.isole !== undefined) t.isole = E.isole
  if (E.etape === 'worker') {
    Object.assign(t, { etape: 'worker', debut: at, fin: null, essais: 1, refus: [], instables: [], non_verifiables: [], blocage: [], modele_utilise: ch ? ch.to : model })
    J('tache', t.id, `${t.id} démarre (${t.isole === true ? 'worktree' : t.isole === false ? 'checkout principal' : 'lieu non précisé'})`)
    if (ch) J('modele', t.id, `${t.id} : ${ch.from ?? '—'} → ${ch.to}${ch.reason ? ` (${ch.reason})` : ''}`)
  } else {
    t.etape = E.etape
    if (E.etape === 'correction' && E.refus) {
      t.refus.push(E.refus)
      if (Number.isInteger(E.refus.essai)) t.essais = Math.max(t.essais, E.refus.essai + 1)
      J('refus', t.id, `${t.id} : essai ${E.refus.essai} refusé (${E.refus.par}) : ${(E.refus.manques || []).length} manque(s)`)
    }
    if (model || ch) t.modele_utilise = ch ? ch.to : model
    if (ch) J('modele', t.id, `${t.id} : ${ch.from ?? '—'} → ${ch.to}${ch.reason ? ` (${ch.reason})` : ''}`)
    J('etape', t.id, `${t.id} : ${E.etape}${E.etape === 'correction' ? ` (essai ${t.essais})` : ''}`)
  }
  return { message: `${t.id} → ${E.etape}${t.modele_utilise && (model || ch) ? ` (${t.modele_utilise})` : ''}` }
}

const optionWithoutActions = o => ({ id: o.id, description: o.description ?? '', ...(o.impact !== undefined ? { impact: o.impact } : {}), ...(o.recommande !== undefined ? { recommande: o.recommande } : {}) })
const issueOf = (p, run, task, role) => ({
  run, tache: p.tache ?? task, titre: p.titre, contexte: p.contexte ?? '', humain: !!p.humain, role: p.role ?? role, statut: 'ouvert', option_choisie: null,
  options: (p.options || []).map(optionWithoutActions), ...(p.coupe_circuit ? { coupe_circuit: true } : {}), ...(p.incoherence ? { incoherence: p.incoherence } : {}),
})
const runNumber = doc => currentRun(doc)?.numero ?? refuse('aucun run en cours : lance d\'abord debut-run')

// Tasks created by a close or a ruling: the task file already exists (the scribe wrote it), plan-lint reads it.
// Called again for a task already there (scribe rerun, progress rebuilt), it is not duplicated.
function add(doc, items, parent, { L, J, ctx }) {
  const run = currentRun(doc), skipped = []
  for (const x of items) {
    if (!x || !RE_ID.test(x.id || '')) refuse(`tâche ajoutée sans identifiant valide : ${JSON.stringify(x)}`)
    const lt = (L.taches || []).find(t => t.id === x.id)
    // Without a task file (the scribe removed it on a plan-lint refusal, and reports it on its side): skipped, noted in the log.
    // Refusing the whole write would lose the close of the task that proposed it.
    // Without a file, only a task the caller describes in full (phase and model) gets in: neither the workflow nor the summary do
    if (!lt && !(x.phase && x.modele)) { J('erreur', x.id, `${x.id} non ajoutée au suivi : aucun fichier de tâche lu par plan-lint (ajout proposé par ${parent ?? 'le bilan du run'})`); skipped.push(x.id); continue }
    const plan = lt ? planFields(ctx, lt) : { phase: x.phase, modele: x.modele, depend_de: x.depend_de ?? [], lot: x.lot ?? null, estimation_tokens: x.estimation_tokens ?? null }
    let t = doc.taches.find(y => y.id === x.id)
    if (!t) t = newTask({ id: x.id, titre: x.titre, statut: 'ajoutée', ...plan })
    else if (t.ajoutee_par !== parent) doc.taches.splice(doc.taches.indexOf(t), 1)
    if (!doc.taches.includes(t)) { t.ajoutee_par = parent; insert(doc, t, parent) }
    Object.assign(t, plan, { titre: x.titre || t.titre })
    if (t.statut === 'à-faire') t.statut = 'ajoutée'
    if (run && !run.taches_ajoutees.some(y => y.id === t.id)) run.taches_ajoutees.push({ id: t.id, phase: t.phase, titre: t.titre })
    J('ajout', t.id, `${t.id} ajoutée par ${parent ?? 'le bilan du run'} (phase ${t.phase}) : ${t.titre}`)
  }
  return skipped
}
const notAdded = ids => (ids.length ? ` ; non ajoutée${ids.length > 1 ? 's' : ''}, sans fichier de tâche : ${ids.join(', ')}` : '')
const logAmendments = (E, J, task) => {
  for (const a of list(E, 'amendements')) J('amendement', a.id ?? null, `${a.id} amendée après ${task} : ${a.raison ?? 'sans raison'}`)
}

function close(doc, E, tools) {
  const { J, at } = tools
  const t = taskOf(doc, E.tache)
  if (!CLOSES.includes(E.statut)) refuse(`cloture : statut « ${E.statut} » non permis (${CLOSES.join(', ')})`)
  const nrun = () => runNumber(doc)
  if (E.replanification) J('etape', t.id, `${t.id} : replanification terminée`)
  Object.assign(t, {
    statut: E.statut, essais: E.essais ?? t.essais, branche: E.branche !== undefined ? E.branche : t.branche,
    tokens_reels: E.tokens_reels !== undefined ? E.tokens_reels : 'voir /workflows', fin: at, etape: null,
    refus: E.refus ?? t.refus, instables: E.instables ?? t.instables, non_verifiables: E.non_verifiables ?? t.non_verifiables,
    blocage: E.blocage ?? (E.statut === 'fusionnée' ? [] : t.blocage),
  })
  J('statut', t.id, `${t.id} : ${E.statut} (${t.essais} essai${t.essais > 1 ? 's' : ''})${t.blocage.length ? ' — ' + t.blocage[0] : ''}`)
  for (const r of list(E, 'relectures')) {
    const text = typeof r === 'string' ? r : r && (r.texte ?? r.relecture)
    if (doc.relectures.some(x => x.tache === t.id && x.texte === text)) continue
    doc.relectures.push({ tache: t.id, phase: t.phase, texte: text, run: currentRun(doc)?.numero ?? null, quand: at })
    J('relecture', t.id, `${t.id} : relecture avant la PR — ${text}`)
  }
  for (const d of list(E, 'decisions_office')) {
    doc.decisions_office.push({ run: nrun(), tache: d.tache ?? t.id, titre: d.titre, option: d.option, description: d.description })
    J('decision-office', t.id, `${t.id} : « ${d.titre} », option ${d.option} prise d'office`)
  }
  for (const p of list(E, 'points')) {
    doc.points.push(issueOf(p, nrun(), t.id, 'a-trancher'))
    J('point', t.id, `${t.id} : point « ${p.titre} »${p.humain ? ' (humain)' : ''}`)
  }
  const skipped = add(doc, list(E, 'taches_ajoutees'), t.id, tools)
  logAmendments(E, J, t.id)
  return { view: true, message: `${t.id} ${E.statut} ; SUIVI.md régénéré${notAdded(skipped)}` }
}

function ruling(doc, E, tools) {
  const { J } = tools
  const t = taskOf(doc, E.tache)
  const option = E.option && typeof E.option === 'object' ? E.option.id : E.option
  if (!option || !E.titre) refuse('arbitrage : tache, titre et option attendus')
  const p = doc.points.filter(x => x.tache === t.id && x.titre === E.titre && x.statut === 'ouvert').pop()
  if (p) Object.assign(p, { statut: 'tranché', option_choisie: String(option) })
  J('arbitrage', t.id, `${t.id} : « ${E.titre} » tranché, option ${option}${p ? '' : ' (point absent du suivi)'}`)
  const run = currentRun(doc)
  if (run && !run.arbitrages_appliques.some(a => a.tache === t.id && a.titre === E.titre && a.option === String(option))) run.arbitrages_appliques.push({ tache: t.id, titre: E.titre, option: String(option) })
  for (const a of list(E, 'amendements_ecartes')) {
    if (run) run.amendements_ecartes.push({ tache: t.id, id: a.id, raison: a.raison ?? '' })
    J('amendement', a.id ?? null, `amendement de ${a.id} écarté (${t.id}) : ${a.raison ?? 'sans raison'}`)
  }
  const skipped = add(doc, list(E, 'taches_ajoutees'), t.id, tools)
  logAmendments(E, J, t.id)
  return { view: true, message: `arbitrage ${t.id} option ${option} ; SUIVI.md régénéré${notAdded(skipped)}` }
}

function runEnd(doc, E, tools) {
  const { J, at } = tools
  const run = currentRun(doc) || refuse('aucun run en cours : lance d\'abord debut-run')
  if (!RUN_ENDS.includes(E.statut)) refuse(`fin-run : statut « ${E.statut} » inconnu (${RUN_ENDS.join(', ')})`)
  run.statut = E.statut
  run.fin = at
  run.detail = E.detail == null ? null : Array.isArray(E.detail) ? E.detail.map(String).join(' ; ') : String(E.detail)
  // Summary lists (E:356-360): they are the source of truth for this run
  const ids = k => list(E, k).map(x => (typeof x === 'string' ? x : x && x.id))
  if (E.arbitrages_appliques) run.arbitrages_appliques = list(E, 'arbitrages_appliques').map(a => ({ tache: a.tache, titre: a.titre, option: String(a.option && typeof a.option === 'object' ? a.option.id : a.option) }))
  if (E.amendements_ecartes) run.amendements_ecartes = list(E, 'amendements_ecartes').map(a => ({ tache: a.tache, id: a.id, raison: a.raison ?? '' }))
  // Added tasks: the summary does not know those of the rulings, already noted by the ruling command; we complete without removing.
  // A summary task missing from the progress file (close not written) gets in, with the task that created it if the summary gives it.
  let viewNeeded = false
  for (const x of list(E, 'taches_ajoutees')) {
    if (!x || !RE_ID.test(x.id || '')) continue
    if (!doc.taches.some(t => t.id === x.id)) { const before = doc.taches.length; add(doc, [x], RE_ID.test(x.ajoutee_par || '') ? x.ajoutee_par : null, tools); viewNeeded ||= doc.taches.length > before }
    if (!run.taches_ajoutees.some(y => y.id === x.id)) run.taches_ajoutees.push({ id: x.id, phase: x.phase, titre: x.titre })
  }
  for (const k of ['reportees', 'non_lancees', 'en_attente']) if (E[k]) run[k] = ids(k)
  if (E.en_attente_prerequis) run.en_attente_prerequis = list(E, 'en_attente_prerequis').map(x => ({ id: x.id, prerequis: x.prerequis || [] }))
  for (const d of list(E, 'decisions_office')) {
    if (doc.decisions_office.some(x => x.run === run.numero && x.tache === d.tache && x.titre === d.titre && x.option === d.option)) continue
    doc.decisions_office.push({ run: run.numero, tache: d.tache, titre: d.titre, option: d.option, description: d.description })
    J('decision-office', d.tache, `${d.tache} : « ${d.titre} », option ${d.option} prise d'office`)
  }
  // Summary issues: the stop issue and the issues to settle, matched with those the scribe already noted
  for (const [p, role] of [...(E.arbitrage ? [[E.arbitrage, 'arret']] : []), ...list(E, 'points_a_trancher').map(p => [p, 'a-trancher'])]) {
    const already = doc.points.find(x => x.run === run.numero && x.tache === p.tache && x.titre === p.titre)
    if (already) { already.role = role; continue }
    doc.points.push(issueOf(p, run.numero, p.tache, role))
    J('point', p.tache, `${p.tache} : point « ${p.titre} »${role === 'arret' ? ", qui arrête le run" : ''}`)
  }
  // Workflow exception (E:316): a summary task without a close in this run is closed here, from the summary
  const start = Date.parse(run.debut)
  for (const r of list(E, 'taches')) {
    const t = doc.taches.find(x => x.id === r.id)
    if (!t || !r.statut || !(t.etape || !t.fin || Date.parse(t.fin) < start)) continue
    Object.assign(t, { statut: r.statut, essais: r.essais ?? t.essais, branche: r.branche !== undefined ? r.branche : t.branche, blocage: r.blocage ?? [], fin: at, etape: null })
    J('statut', t.id, `${t.id} : ${r.statut}, clos en fin de run sans scribe${t.blocage.length ? ' — ' + t.blocage[0] : ''}`)
    viewNeeded = true
  }
  for (const t of doc.taches.filter(t => t.etape)) { J('etape', t.id, `${t.id} : étape « ${t.etape} » sans clôture à la fin du run`); t.etape = null }
  J(E.statut === 'erreur' ? 'erreur' : 'run', null, `run ${run.numero} : ${E.statut}${run.detail ? ' — ' + run.detail : ''}`)
  return { view: viewNeeded, message: `run ${run.numero} ${E.statut}${viewNeeded ? ' ; SUIVI.md régénéré, à commiter' : ''}` }
}

function pilot(doc, E, { J, at }) {
  const t = taskOf(doc, E.tache)
  if (!['fusionnée', 'annulée'].includes(E.statut)) refuse(`pilote : statut « ${E.statut} » non permis (fusionnée ou annulée)`)
  Object.assign(t, { statut: E.statut, etape: null, ...(E.statut === 'fusionnée' ? { fin: at, blocage: [] } : {}) })
  J('pilote', t.id, `${t.id} : ${E.statut} par le pilote${E.raison ? ' — ' + E.raison : ''}`)
  return { view: true, message: `${t.id} ${E.statut} ; SUIVI.md régénéré, à commiter` }
}

// ─── Read: plan status, as etat.mjs (0.6.3), with the current step when a run is going ──────────────────────
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`
const bar = (r, n) => { const k = Math.floor(r * n); return '█'.repeat(k) + '░'.repeat(n - k) }
const pct = (f, n) => Math.floor((100 * f) / n)
const ago = ts => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts))
  return s < 60 ? "à l'instant" : s < 3600 ? `il y a ${Math.floor(s / 60)} min` : s < 86400 ? `il y a ${Math.floor(s / 3600)} h` : `il y a ${Math.floor(s / 86400)} j`
}
const shorten = (xs, max) => (xs.length > max ? [...xs.slice(0, max - 1), `+${xs.length - max + 1}`] : xs)

function status(arg) {
  let ctx
  try { ctx = locate(arg) } catch (e) { return `orchestre:etat : ${e.message}` }
  const { root, dir, name, integration: integ } = ctx
  const L = planLint(ctx)
  if (!L.taches) return `orchestre:etat : ${L.erreurs[0]}`
  const handoff = readOrNull(join(dir, 'HANDOFF.md')) || ''
  // suivi.json if it exists, otherwise its rebuild in memory; nothing is written
  let doc = null, note = null
  try { doc = load(ctx) || rebuild(ctx, L, handoff, now()) } catch (e) { note = `suivi.json : ${e.message.split('\n')[0]}` }
  const S = new Map((doc ? doc.taches : []).map(t => [t.id, t]))
  const run = doc ? currentRun(doc) : null
  // git is the source of truth for « fusionnée »; otherwise the progress file, fresher than SUIVI.md during a run
  const statusOf = t => (t.statut === 'fusionnée' ? 'fusionnée' : S.get(t.id)?.statut ?? t.statut)
  const active = L.taches.map(t => ({ ...t, statut: statusOf(t) })).filter(t => t.statut !== 'annulée')
  if (!active.length) return `orchestre:etat : aucune tâche dans ${ctx.rel}`
  const done = t => t.statut === 'fusionnée'
  const ATTENTION = { 'besoin-humain': 'attend un humain', bloquée: 'bloquée', échec: 'en échec' }
  const inStep = t => run && S.get(t.id)?.etape

  const refs = (attempt(() => git(['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads/tache/'], root)) || '')
    .split('\n').filter(Boolean).map(l => { const [r, ts] = l.split('\t'); return { ref: r, ts: Number(ts), id: r.replace(/^tache\//, '').replace(/-r\d+$/, '') } })
  const head = attempt(() => git(['symbolic-ref', '-q', '--short', 'HEAD'], root).trim()) || ''
  const worktrees = new Set((attempt(() => git(['worktree', 'list', '--porcelain'], root)) || '').split(/\n\s*\n/).slice(1).map(b => (b.match(/^branch refs\/heads\/(.+)$/m) || [])[1]).filter(Boolean))
  const inProgress = []
  for (const t of active) {
    if (done(t)) continue
    const s = S.get(t.id)
    if (inStep(t)) {
      inProgress.push({ id: t.id, text: `${t.id} (${[s.etape, s.isole === true ? 'worktree' : s.isole === false ? 'checkout' : null, s.debut ? `démarrée ${ago(Date.parse(s.debut) / 1000)}` : null].filter(Boolean).join(', ')})` })
      continue
    }
    if (ATTENTION[t.statut]) continue
    const b = refs.filter(x => x.id === t.id).sort((x, y) => y.ts - x.ts)[0]
    if (!b) continue
    const ahead = Number(attempt(() => git(['rev-list', '--count', `${integ}..${b.ref}`], root).trim()) || 0)
    const where = b.ref === head ? 'checkout' : worktrees.has(b.ref) ? 'worktree' : null
    inProgress.push({ id: t.id, text: `${t.id} (${[where, ahead ? `dernier commit ${ago(b.ts)}` : 'démarrée'].filter(Boolean).join(', ')})` })
  }

  const exists = b => attempt(() => git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], root)) != null
  const base = ctx.base || ['main', 'master'].find(exists)
  const log = attempt(() => git(['log', '--format=%ct%x09%s', base && base !== integ ? `${base}..${integ}` : integ, '--'], root)) || ''
  const merge = log.split('\n').map(l => l.split('\t')).find(([, s]) => /^tâche \S+ :/.test(s || ''))

  const yourTurn = []
  for (const p of (L.prerequis || []).filter(x => x.statut === 'ouvert' && (x.bloque || []).length)) yourTurn.push(`${p.id} (${p.type}) bloque ${shorten(p.bloque, 4).join(', ')}`)
  for (const [st, what] of Object.entries(ATTENTION)) for (const t of active.filter(x => x.statut === st && !inStep(x))) yourTurn.push(`${t.id} ${what}`)
  const counts = parseHandoff(handoff).counts
  const count = type => Object.values(counts).reduce((n, c) => n + (c[type] ? c[type].mineur + c[type].majeur : 0), 0)
  const reviews = count('relecture'), tickets = count('ticket')
  if (reviews) yourTurn.push(`${plural(reviews, 'relecture')} avant la PR`)
  if (tickets) yourTurn.push(`${plural(tickets, 'ticket')} après la PR`)
  if (!L.ok) yourTurn.push(`plan-lint : ${plural((L.erreurs || []).length, 'erreur')}`)
  if (note) yourTurn.push(note)

  const phases = [...new Set(active.map(t => t.phase))].sort((a, b) => a - b)
  const started = ph => active.some(t => t.phase === ph && (done(t) || inProgress.some(e => e.id === t.id)))
  const current = phases.find(ph => active.some(t => t.phase === ph && !done(t)))
  const doneCount = active.filter(done).length
  const out = [
    `## ${name} — ${doneCount}/${plural(active.length, 'tâche')} · ${pct(doneCount, active.length)} %`,
    `\`${bar(doneCount / active.length, 24)}\` ${current == null ? 'plan terminé' : `phase ${current} ${started(current) ? 'en cours' : 'à lancer'}`}${merge ? ` · dernière fusion ${merge[1].match(/^tâche (\S+) :/)[1]} ${ago(Number(merge[0]))}` : ''}${run ? ` · run ${run.numero} (${run.mode}) ouvert ${ago(Date.parse(run.debut) / 1000)}` : ''}`,
    '',
    '| Phase | Avancement | Tâches |',
    '| :-- | :-- | :-- |',
  ]
  for (const ph of phases) {
    const ts = active.filter(t => t.phase === ph), f = ts.filter(done).length
    const sym = f === ts.length ? '✓' : ts.some(t => ATTENTION[t.statut] && !inStep(t)) ? '⚠' : started(ph) ? '●' : '○'
    out.push(`| ${sym} ${ph} | \`${bar(f / ts.length, 10)}\` ${pct(f, ts.length)} % | ${f}/${ts.length} |`)
  }
  if (inProgress.length) out.push('', `**En cours** : ${shorten(inProgress.map(e => e.text), 5).join(' · ')}`)
  out.push('', `**À toi** : ${yourTurn.length ? shorten(yourTurn, 6).join(' · ') : "rien pour l'instant"}`)
  return out.join('\n')
}

// ─── Entry ──────────────────────────────────────────────────────────────────────────────────────────────────────
// The object of --json if given, otherwise standard input
function input(json) {
  const source = json != null ? '--json' : 'entrée standard'
  if (json == null && process.stdin.isTTY) throw new UsageError('objet JSON attendu sur l\'entrée standard ou dans --json')
  const raw = json != null ? json : attempt(() => readFileSync(0, 'utf8')) || ''
  if (!raw.trim()) throw new UsageError(`objet JSON attendu sur l'entrée standard ou dans --json`)
  let E
  try { E = JSON.parse(raw) } catch (e) { throw new UsageError(`${source} : JSON invalide (${e.message})`) }
  if (!E || typeof E !== 'object' || Array.isArray(E)) throw new UsageError(`${source} : un objet JSON est attendu`)
  return E
}

const WRITES = { 'debut-run': runStart, etape: step, cloture: close, arbitrage: ruling, 'fin-run': runEnd, pilote: pilot }
const USAGE = 'usage : suivi.mjs <debut-run|etape|cloture|arbitrage|fin-run|pilote|vue|etat|valider> [<dossier-plan>] [--stdout] [--fichier <suivi.json>] [--json <objet>] ; pour les écritures, JSON dans --json ou sur l\'entrée standard'

function main() {
  const argv = process.argv.slice(2), cmd = argv[0]
  const fi = argv.indexOf('--fichier'), file = fi >= 0 ? argv[fi + 1] : null
  const ji = argv.indexOf('--json')
  if (ji >= 0 && ji + 1 >= argv.length) throw new UsageError('--json : objet JSON attendu après l\'option')
  const json = ji >= 0 ? argv[ji + 1] : null
  const arg = argv.slice(1).find((a, i, xs) => !a.startsWith('--') && xs[i - 1] !== '--fichier' && xs[i - 1] !== '--json')
  if (cmd === 'etat') {
    let text
    try { text = status(arg) } catch (e) { text = `orchestre:etat : ${String((e && e.message) || e).split('\n')[0]}` }
    console.log(text)
    return 0
  }
  if (cmd === 'valider') {
    const f = file ? resolve(file) : join(locate(arg).dir, 'suivi.json')
    if (!existsSync(f)) refuse(`${f} : absent ; il sera reconstruit à la prochaine écriture`)
    let doc
    try { doc = JSON.parse(readFileSync(f, 'utf8')) } catch (e) { refuse(`suivi.json illisible : ${e.message}`) }
    checkFormat(doc)
    // A /1 file is validated as it will be migrated: the /2 schema with modele_utilise at null
    const v1 = migrate(doc)
    const err = validate(doc)
    if (err.length) refuse(`suivi.json invalide :\n${err.map(e => '  - ' + e).join('\n')}`)
    console.log(`suivi : suivi.json valide (${v1 ? `${FORMAT_V1}, migré en ${FORMAT} à la prochaine écriture` : FORMAT}, ${plural(doc.taches.length, 'tâche')}, ${plural(doc.runs.length, 'run')})`)
    return 0
  }
  if (cmd === 'vue') {
    const ctx = locate(arg)
    if (argv.includes('--stdout')) {
      const L = planLint(ctx), handoff = readOrNull(join(ctx.dir, 'HANDOFF.md')) || '', at = now()
      const existing = load(ctx)
      if (!existing && !L.taches) throw new Refusal(`${L.erreurs[0]} : suivi.json absent, il ne se reconstruit pas sans plan-lint`)
      const doc = existing || rebuild(ctx, L, handoff, at)
      if (existing) sync(doc, L, ctx, logger(doc, at), { statuses: true })
      derive(doc, L, handoff)
      process.stdout.write(render(doc, readOrNull(join(ctx.dir, 'SUIVI.md'))))
      return 0
    }
    // Between two runs (pre-flight of /orchestre:lancer): SUIVI.md and git are the source of truth for statuses, as at the start of a run
    // (a task merged by hand without « suivi.mjs pilote » becomes « fusionnée »)
    const r = write(ctx, (doc, { L, ctx: c, J }) => { sync(doc, L, c, J, { statuses: true }); return { view: true } })
    console.log(`suivi : SUIVI.md régénéré (${plural(r.doc.taches.length, 'tâche')})`)
    return 0
  }
  const change = WRITES[cmd]
  if (!change) throw new UsageError(USAGE)
  const ctx = locate(arg), E = input(json)
  const r = write(ctx, (doc, tools) => change(doc, E, tools), { runStart: cmd === 'debut-run' })
  console.log(`suivi : ${r.message}`)
  return 0
}

const launched = process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))
if (launched) {
  try { process.exitCode = main() } catch (e) {
    if (e instanceof Refusal || e instanceof UsageError) { console.error(`suivi : ${e.message}`); process.exitCode = e.code } else { console.error(`suivi : erreur inattendue, rien n'est écrit : ${(e && e.stack) || e}`); process.exitCode = 1 }
  }
}
