#!/usr/bin/env node
// plan-lint (orchestre plugin 0.11.0): validates a plan folder and compiles it to JSON. Node 18 or later, no dependencies.
// Usage: node <plugin root>/scripts/plan-lint.mjs <plan-dir> [--json] [--phase N] [--integration <branch>] [--base <branch>]
// With --integration, a task whose merge commit « tâche <id> : » is on the integration branch, and not on the base branch
// (--base, else main, else master), counts as merged: git is the source of truth. The base excludes merges of earlier plans already in main.
// A task « annulée » in SUIVI.md counts as done: it blocks neither its phase nor the tasks that depend on it.
// PREREQUIS.md (optional): what the plan expects from a human or the environment. A task lists its own in « prerequis »;
// while one of them is « ouvert », the task waits (prerequis_ouverts) and the rest of the phase can run.
// Warnings (block nothing): compound verification or setup commands, which an agent isolated in a worktree would be refused
// by Claude Code's isolation guard; shared setup resource that no task declares; remaining task without modele or
// raison_modele (0.11.0). A modele outside MODELS is an error; the choice itself is never judged.
// Fable (0.11.0): orchestre.config.json says whether the user allows it (« fable »: true or false, asked by /orchestre:preparer).
// A remaining task on fable, or an escalation that contains it: error with fable: false, warning without the setting.
// orchestre.config.json (optional): preparation, a list of commands; preparation_partagee, { resource: [commands] }.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const dir = argv.find((a, i) => !a.startsWith('--') && !['--phase', '--integration', '--base'].includes(argv[i - 1]))
const ii = argv.indexOf('--integration')
const integ = ii >= 0 ? argv[ii + 1] : null
const bi = argv.indexOf('--base')
const baseArg = bi >= 0 ? argv[bi + 1] : null
const asJson = argv.includes('--json')
const pi = argv.indexOf('--phase')
const phaseF = pi >= 0 ? Number(argv[pi + 1]) : null
if (!dir) { console.error('usage : plan-lint <dossier-plan> [--json] [--phase N] [--integration <branche>] [--base <branche>]'); process.exit(2) }
// A branch name never starts with « - »: git would read it as an option (--output=… would write a file)
for (const [name, b] of [["d'intégration", integ], ['de base', baseArg]]) if (b != null && (!b || b.startsWith('-'))) { console.error(`branche ${name} invalide : ${b}`); process.exit(2) }
if (!existsSync(join(dir, 'taches'))) { console.error(`dossier de tâches introuvable : ${join(dir, 'taches')}`); process.exit(2) }

const arr = x => (Array.isArray(x) ? x : x ? [x] : [])
// Compound command: chaining or subcommand, cd/export/assignment first, code evaluated inline by an interpreter,
// script by absolute path. Quoted text does not count, except a substitution inside double quotes; « \; » neither.
const withoutQuotes = c => c.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""')
const withoutSingleQuotes = c => c.replace(/'[^']*'/g, "''")
const INTERPRETERS = 'node|nodejs|deno|bun|tsx|ts-node|python[0-9.]*|ruby|perl|php|bash|sh|zsh|pwsh|powershell'
const INLINE = new RegExp(`(^|[\\s/])(${INTERPRETERS})\\s+(?:-{1,2}[\\w-]+\\s+)*(-e|-c|-p|-r|--eval|--print|-Command)\\s+["'\`]`)
function compound(c) {
  const s = String(c), bare = withoutQuotes(s).replace(/\\;/g, ''), reasons = []
  if (/&&|\|\||;|\|/.test(bare) || /\$\(|`|<\(/.test(withoutSingleQuotes(s))) reasons.push('enchaînement ou sous-commande')
  if (/^\s*(cd|export)\s/.test(s) || /^\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(s)) reasons.push('cd, export ou affectation en tête')
  if (INLINE.test(s) || /(^|\s)deno\s+eval\s/.test(s)) reasons.push('code évalué en ligne')
  if (/(^|\s)\/[^\s'"]+\.(sh|bash|mjs|cjs|js|ts|py|rb|php|pl)(\s|$)/.test(withoutQuotes(s))) reasons.push('script en chemin absolu')
  return reasons
}
const short = c => (String(c).length > 100 ? String(c).slice(0, 99) + '…' : String(c))
const done = s => s === 'fusionnée' || s === 'annulée'
// Models of a task (0.11.0): /orchestre:preparer picks haiku, sonnet or opus; fable only on the tasks the user designates
const MODELS = ['haiku', 'sonnet', 'opus', 'fable']
// Frontmatter text field: an empty value (« modele: ») reads as an empty list, hence as absent
const fmText = x => (typeof x === 'string' && x.trim() ? x.trim() : null)
// Model of a task: absent (nothing, or an empty value), valid, or rejected by an error
const modelState = x => (fmText(x) === null && (x === undefined || typeof x === 'string' || (Array.isArray(x) && !x.length)) ? 'absent' : MODELS.includes(fmText(x)) ? 'valid' : 'rejected')
function unquote(v) {
  v = v.trim()
  if (v.startsWith('"')) { const m = v.match(/^"((?:[^"\\]|\\.)*)"/); return m ? m[1].replace(/\\(["\\])/g, '$1') : v }
  if (v.startsWith("'")) { const m = v.match(/^'((?:[^']|'')*)'/); return m ? m[1].replace(/''/g, "'") : v }
  return v.replace(/\s+#.*$/, '').trim()
}
// Inline list [a, "b, c"]: commas inside quotes do not split items
function inlineList(v) {
  const s = v.trim()
  if (!s.startsWith('[')) return null
  const out = []
  let cur = '', q = null
  for (let i = 1; i < s.length; i++) {
    const c = s[i]
    if (q) {
      cur += c
      if (q === '"' && c === '\\') { cur += s[++i] ?? ''; continue }
      if (c === q) { if (q === "'" && s[i + 1] === "'") { cur += s[++i]; continue } q = null }
    } else if (c === '"' || c === "'") { q = c; cur += c }
    else if (c === ',' || c === ']') { if (cur.trim()) out.push(unquote(cur)); cur = ''; if (c === ']') return out }
    else cur += c
  }
  return null
}
function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const out = {}
  let key = null
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && key) { if (!Array.isArray(out[key])) out[key] = []; out[key].push(unquote(item[1])); continue }
    const kv = line.match(/^([a-z_]+):\s*(.*)$/)
    if (kv) { key = kv[1]; const l = inlineList(kv[2]); out[key] = l !== null ? l : kv[2].trim() === '' ? [] : unquote(kv[2]) }
  }
  return out
}
// Cells of a Markdown table row; « \\| » is a « | » inside a cell
const cells = line => {
  const l = line.trim(), p = l.split(/(?<!\\)\|/)
  if (p.length && p[0].trim() === '') p.shift()
  if (/(?<!\\)\|$/.test(l)) p.pop()
  return p.map(c => c.trim().replace(/\\\|/g, '|'))
}
function statuses() {
  const p = join(dir, 'SUIVI.md'), map = {}
  if (!existsSync(p)) return map
  let cols = null
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const row = cells(line)
    if (!cols && row.includes('ID') && row.includes('Statut')) { cols = { id: row.indexOf('ID'), st: row.indexOf('Statut'), n: row.length }; continue }
    // A row of another table (fewer cells than the header, or no status) is not a task (0.8.1)
    if (cols && row.length >= cols.n && row[cols.st] && /^[A-Z]+\d+[A-Z]*$/.test(row[cols.id] || '')) map[row[cols.id]] = row[cols.st]
  }
  return map
}
const tokens = s => { const m = String(s || '').match(/([\d.,]+)\s*M/i); return m ? Number(m[1].replace(',', '.')) : 0 }
const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const TYPES = { decision: 'décision', geste: 'geste', environnement: 'environnement' }
const PREREQ_STATUSES = { ouvert: 'ouvert', fait: 'fait', abandonne: 'abandonné' }
function prerequisites() {
  const p = join(dir, 'PREREQUIS.md'), list = []
  if (!existsSync(p)) return null
  let cols = null
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const row = cells(line)
    const idx = k => row.findIndex(x => norm(x) === norm(k))
    if (!cols && idx('ID') >= 0 && idx('Statut') >= 0) { cols = Object.fromEntries(['ID', 'Type', 'Prérequis', 'Statut', 'Preuve'].map(k => [k, idx(k)])); continue }
    const c = k => (cols && cols[k] >= 0 ? row[cols[k]] || '' : '')
    if (!cols || row.every(x => /^:?-*:?$/.test(x))) continue
    if (/^[A-Z]+\d+[A-Z]*$/.test(c('ID'))) list.push({ id: c('ID'), type: TYPES[norm(c('Type'))] || c('Type'), texte: c('Prérequis'), statut: PREREQ_STATUSES[norm(c('Statut'))] || c('Statut'), preuve: c('Preuve') })
    else errors.push(`PREREQUIS.md : ligne ignorée, identifiant invalide « ${c('ID')} » (lettres majuscules puis chiffres, comme D5)`)
  }
  if (!cols) errors.push('PREREQUIS.md : aucun tableau reconnu (en-têtes ID, Type, Prérequis, Statut, Preuve)')
  return list
}

const errors = [], warnings = [], T = new Map(), tdir = join(dir, 'taches')
for (const f of readdirSync(tdir).filter(f => f.endsWith('.md')).sort()) {
  const fm = frontmatter(readFileSync(join(tdir, f), 'utf8'))
  if (!fm || !fm.id) { errors.push(`${f} : frontmatter absent ou sans id`); continue }
  if (T.has(fm.id)) errors.push(`${fm.id} : identifiant en double`)
  T.set(fm.id, { ...fm, fichier: join(tdir, f), phase: Number(fm.phase) })
}
const st = statuses()
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const exists = b => { try { git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]); return true } catch { return false } }
if (integ) {
  const base = baseArg || ['main', 'master'].find(exists)
  if (baseArg && !exists(baseArg)) errors.push(`branche de base introuvable : ${baseArg}`)
  try {
    const log = git(['log', '--format=%s', base && base !== integ ? `${base}..${integ}` : integ, '--'])
    for (const m of log.matchAll(/^tâche (\S+) :/gm)) st[m[1]] = 'fusionnée'
  } catch { errors.push(`branche d'intégration introuvable : ${integ}`) }
}
for (const t of T.values()) {
  if (!t.phase) errors.push(`${t.id} : phase manquante`)
  // Model absent (nothing, « modele: », « modele: "" »): warning below (the worker will run on sonnet, then the escalation
  // ladder); unknown value or list: error
  if (modelState(t.modele) === 'rejected' && fmText(t.modele) !== null) errors.push(`${t.id} : modèle inconnu « ${fmText(t.modele)} » (${MODELS.join(', ')})`)
  else if (modelState(t.modele) === 'rejected') errors.push(`${t.id} : modèle illisible (un seul nom : ${MODELS.join(', ')})`)
  if (!arr(t.verification).length) errors.push(`${t.id} : aucune commande de vérification`)
  if (!arr(t.definition_du_fini).length) errors.push(`${t.id} : définition du fini absente`)
  for (const d of arr(t.depend_de)) {
    if (!T.has(d)) errors.push(`${t.id} : dépendance inconnue ${d}`)
    else if (T.get(d).phase > t.phase) errors.push(`${t.id} : dépend de ${d}, d'une phase ultérieure`)
  }
}
const ancestors = (id, seen = new Set()) => { for (const d of arr(T.get(id)?.depend_de)) if (T.has(d) && !seen.has(d)) { seen.add(d); ancestors(d, seen) } return seen }
for (const id of T.keys()) if (ancestors(id).has(id)) errors.push(`${id} : cycle de dépendances`)
const root = p => p.split('#')[0].trim().replace(/\*.*$/, '')
const overlaps = (a, b) => arr(a).some(x => arr(b).some(y => { const p = root(x), q = root(y); return p === q || p.startsWith(q) || q.startsWith(p) }))
const ids = [...T.keys()]
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
  const a = T.get(ids[i]), b = T.get(ids[j])
  if (a.phase !== b.phase || ancestors(a.id).has(b.id) || ancestors(b.id).has(a.id)) continue
  if (arr(a.ressources).some(r => arr(b.ressources).includes(r))) continue
  if (overlaps(a.fichiers_possedes, b.fichiers_possedes)) errors.push(`${a.id} et ${b.id} peuvent tourner ensemble et partagent des fichiers`)
}
if (phaseF != null) for (const t of T.values()) if (t.phase < phaseF && !done(st[t.id] || 'à-faire')) errors.push(`${t.id} (phase ${t.phase}) n'est ni fusionnée ni annulée : la phase ${phaseF} ne peut pas démarrer`)

// Prerequisites: known ids, types and statuses; a « fait » decision is written in HANDOFF.md, where agents read it
const P = prerequisites(), PR = new Map()
const handoff = existsSync(join(dir, 'HANDOFF.md')) ? readFileSync(join(dir, 'HANDOFF.md'), 'utf8').split(/\r?\n/) : []
const cites = (l, id) => new RegExp(`(^|[^A-Za-z0-9])${id}([^A-Za-z0-9]|$)`).test(l)
for (const x of P || []) {
  if (PR.has(x.id)) errors.push(`prérequis ${x.id} : identifiant en double`)
  if (T.has(x.id)) errors.push(`prérequis ${x.id} : identifiant déjà pris par une tâche`)
  if (!Object.values(TYPES).includes(x.type)) errors.push(`prérequis ${x.id} : type inconnu « ${x.type} » (décision, geste ou environnement)`)
  if (!Object.values(PREREQ_STATUSES).includes(x.statut)) errors.push(`prérequis ${x.id} : statut inconnu « ${x.statut} » (ouvert, fait ou abandonné)`)
  if (x.type === 'décision' && x.statut === 'fait' && !handoff.some(l => /^\s*(?:[-*]\s*)?d[ée]cision\s*·/i.test(l) && cites(l, x.id))) errors.push(`prérequis ${x.id} : décision marquée « fait » sans entrée « décision » qui la cite dans HANDOFF.md`)
  PR.set(x.id, x)
}
for (const t of T.values()) for (const id of arr(t.prerequis)) if (!PR.has(id)) errors.push(`${t.id} : prérequis inconnu ${id}${P ? '' : ' (pas de PREREQUIS.md)'}`)
const open = t => arr(t.prerequis).filter(id => PR.has(id) && PR.get(id).statut === 'ouvert')
// Ready to run, phase by phase: a task waits for its open prerequisites, or for a task of its phase that waits;
// a phase waits for the end of the previous one if a task waits there
const remaining = t => !done(st[t.id] || 'à-faire')
const ready = []
let blockedPhase = null
for (const ph of [...new Set([...T.values()].filter(remaining).map(t => t.phase))].sort((a, b) => a - b)) {
  const ts = [...T.values()].filter(t => t.phase === ph && remaining(t))
  const waits = new Map(ts.filter(t => open(t).length || st[t.id] === 'besoin-humain').map(t => [t.id, [...(st[t.id] === 'besoin-humain' ? ['besoin-humain'] : []), ...open(t)]]))
  for (let changed = true; changed;) {
    changed = false
    for (const t of ts) if (!waits.has(t.id)) { const d = arr(t.depend_de).filter(x => waits.has(x)); if (d.length) { waits.set(t.id, d); changed = true } }
  }
  ready.push({ phase: ph, apres_phase: blockedPhase, taches: ts.length, en_attente: [...waits].map(([id, a]) => ({ id, attend: a })) })
  if (waits.size && blockedPhase == null) blockedPhase = ph
}

const tasks = [...T.values()].filter(t => phaseF == null || t.phase === phaseF).map(t => ({
  id: t.id, titre: t.titre || '', fichier: t.fichier, phase: t.phase, ...(fmText(t.modele) ? { modele: fmText(t.modele) } : {}), ...(fmText(t.raison_modele) ? { raison_modele: fmText(t.raison_modele) } : {}), effort: t.effort || '',
  depend_de: arr(t.depend_de), ressources: arr(t.ressources), statut: st[t.id] || 'à-faire',
  verification: arr(t.verification), estimation_tokens: tokens(t.estimation_tokens), prerequis_ouverts: open(t),
}))
// All tasks, whatever the requested phase: the orchestrator checks the tasks named by an auto-decision
const all = [...T.values()].map(t => ({ id: t.id, phase: t.phase, statut: st[t.id] || 'à-faire' }))
const maxPhase = Math.max(0, ...[...T.values()].map(t => t.phase || 0))
const blocks = id => [...T.values()].filter(t => remaining(t) && arr(t.prerequis).includes(id)).map(t => t.id)
const prereqs = [...PR.values()].map(x => ({ ...x, bloque: blocks(x.id) }))
// A deferred decision that no remaining task cites would block nothing: an agent would settle it instead of the human
for (const x of prereqs) if (x.type === 'décision' && x.statut === 'ouvert' && !x.bloque.length) errors.push(`prérequis ${x.id} : décision ouverte qu'aucune tâche restante ne cite dans « prerequis » (ajoute-la aux tâches qu'elle touche, ou passe-la à « abandonné »)`)
const orphans = prereqs.filter(x => x.type !== 'décision' && x.statut === 'ouvert' && !x.bloque.length)

// Verification commands of remaining tasks: compound, they would be refused to an agent isolated in a worktree
const refusable = 'un agent isolé dans un worktree se la verra refuser (garde d\'isolement de Claude Code) : en faire une commande simple, ou un script du projet'
// With --phase, only the tasks of the phase: the plan reader needs only them, and the output stays short (0.8.1)
for (const t of T.values()) if (!done(st[t.id] || 'à-faire') && (phaseF == null || t.phase === phaseF)) for (const c of arr(t.verification)) {
  const r = compound(c)
  if (r.length) warnings.push(`${t.id} : vérification « ${short(c)} » (${r.join(', ')}) : ${refusable}`)
}
// Model and reason of remaining tasks (0.11.0): /orchestre:preparer writes them; an older plan still runs
for (const t of T.values()) if (!done(st[t.id] || 'à-faire') && (phaseF == null || t.phase === phaseF)) {
  if (modelState(t.modele) === 'absent') warnings.push(`${t.id} : pas de modele (${MODELS.slice(0, 3).join(', ')}) : le worker tournera sur sonnet, et ses corrections suivront l'échelle d'escalade`)
  else if (modelState(t.modele) === 'valid' && !fmText(t.raison_modele)) warnings.push(`${t.id} : modele ${fmText(t.modele)} sans raison_modele (une ligne qui justifie le choix)`)
}
// Environment setup (orchestre.config.json): shape, simple commands, resources declared by a task
let config = null
if (existsSync(join(dir, 'orchestre.config.json'))) {
  try { config = JSON.parse(readFileSync(join(dir, 'orchestre.config.json'), 'utf8')) } catch (e) { errors.push(`orchestre.config.json illisible : ${e.message}`) }
}
const isList = x => Array.isArray(x) && x.every(c => typeof c === 'string' && c.trim())
if (config && config.preparation !== undefined) {
  if (!isList(config.preparation)) errors.push('orchestre.config.json : « preparation » doit être une liste de commandes')
  else for (const c of config.preparation) { const r = compound(c); if (r.length) warnings.push(`preparation : « ${short(c)} » (${r.join(', ')}) : ${refusable}`) }
}
if (config && config.preparation_partagee !== undefined) {
  const sp = config.preparation_partagee
  if (!sp || typeof sp !== 'object' || Array.isArray(sp) || !Object.values(sp).every(isList)) errors.push('orchestre.config.json : « preparation_partagee » doit associer à chaque ressource une liste de commandes')
  else for (const [res, cs] of Object.entries(sp)) {
    if (![...T.values()].some(t => arr(t.ressources).includes(res))) warnings.push(`preparation_partagee : aucune tâche ne déclare la ressource « ${res} » ; ses commandes ne seront jamais lancées`)
    for (const c of cs) { const r = compound(c); if (r.length) warnings.push(`preparation_partagee (${res}) : « ${short(c)} » (${r.join(', ')}) : ${refusable}`) }
  }
}
// Fable: allowed only if the user said so (fable: true). With fable: false, a remaining task on fable or an escalation
// that contains it blocks, across the whole plan; without the setting (older plan), a warning makes the user decide
const fable = config && config.fable !== undefined ? config.fable : null
if (fable !== null && typeof fable !== 'boolean') errors.push('orchestre.config.json : « fable » doit valoir true ou false')
else if (fable !== true) {
  const onFable = [...T.values()].filter(t => !done(st[t.id] || 'à-faire') && fmText(t.modele) === 'fable')
  const escFable = !!config && Array.isArray(config.escalade) && config.escalade.includes('fable')
  if (fable === false) {
    for (const t of onFable) errors.push(`${t.id} : modèle fable, refusé par orchestre.config.json (fable: false) : passer la tâche sur opus, ou fable: true si l'utilisateur le veut`)
    if (escFable) errors.push('orchestre.config.json : « escalade » contient fable, refusé par fable: false')
  } else {
    for (const t of onFable.filter(t => phaseF == null || t.phase === phaseF)) warnings.push(`${t.id} : modèle fable, sans réglage « fable » dans orchestre.config.json : à trancher avec l'utilisateur (/orchestre:pret)`)
    if (escFable) warnings.push("orchestre.config.json : « escalade » contient fable, sans réglage « fable » : à trancher avec l'utilisateur (/orchestre:pret)")
  }
}
const readyShown = ready.filter(p => phaseF == null || p.phase === phaseF)
// JSON on one line: read by scripts and agents, it thus stays under the Bash tool's display thresholds longer (0.8.1)
if (asJson) console.log(JSON.stringify({ ok: errors.length === 0, erreurs: errors, avertissements: warnings, taches: tasks, tous: all, phase_max: maxPhase, prerequis: prereqs, pret: readyShown, fable: typeof fable === 'boolean' ? fable : null }))
else {
  if (errors.length) console.log(errors.map(e => '✗ ' + e).join('\n'))
  else {
    const byPhase = {}
    for (const t of tasks) if (!done(t.statut)) byPhase[t.phase] = (byPhase[t.phase] || 0) + t.estimation_tokens
    const fmt = n => n.toFixed(1).replace('.', ',') + ' M'
    console.log(`✓ plan valide : ${T.size} tâche${T.size > 1 ? 's' : ''}. Reste à faire, en tokens estimés : ` +
      Object.entries(byPhase).map(([p, n]) => `phase ${p} ${fmt(n)}`).join(' · ') +
      ` · total ${fmt(Object.values(byPhase).reduce((a, b) => a + b, 0))}`)
    if (!P) console.log('ℹ pas de PREREQUIS.md : aucun prérequis déclaré (voir /orchestre:pret)')
    for (const x of orphans) console.log(`⚠ prérequis ${x.id} (${x.type}) ouvert, mais aucune tâche restante ne le cite`)
    const openShown = prereqs.filter(x => x.statut === 'ouvert' && x.bloque.length)
    if (openShown.length) console.log('Prérequis ouverts : ' + openShown.map(x => `${x.id} (${x.type}) → ${x.bloque.join(', ')}`).join(' · '))
    if (P || openShown.length) {
      console.log('Prêt à lancer :')
      for (const p of readyShown) {
        const what = [
          ...(p.apres_phase != null ? [`attend la fin de la phase ${p.apres_phase}`] : []),
          ...(p.en_attente.length === p.taches ? ['aucune tâche ne peut partir'] : []),
          ...p.en_attente.map(e => `${e.id} attend ${e.attend.join(', ')}`),
        ]
        console.log(`- phase ${p.phase} : ${what.length ? what.join(' ; ') : 'prête'}`)
      }
    }
  }
}
if (!asJson) for (const a of warnings) console.log('⚠ ' + a)
// No process.exit() here: in a pipe, it would cut the output at 64 KB (the JSON of a big plan, 0.8.1)
process.exitCode = errors.length ? 1 : 0
