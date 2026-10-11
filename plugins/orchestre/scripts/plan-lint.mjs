#!/usr/bin/env node
// plan-lint (plugin orchestre 0.11.0) : valide un dossier de plan et le compile en JSON. Node 18 ou plus, aucune dépendance.
// Usage : node <racine du plugin>/scripts/plan-lint.mjs <dossier-plan> [--json] [--phase N] [--integration <branche>] [--base <branche>]
// Avec --integration, une tâche dont le commit de fusion « tâche <id> : » est sur la branche d'intégration, et pas sur la branche de base
// (--base, sinon main, sinon master), compte comme fusionnée : git fait foi. La base écarte les fusions des plans précédents déjà dans main.
// Une tâche « annulée » dans SUIVI.md compte comme faite : elle ne bloque ni sa phase ni les tâches qui en dépendent.
// PREREQUIS.md (facultatif) : ce que le plan attend d'un humain ou de l'environnement. Une tâche cite les siens dans « prerequis » ;
// tant que l'un d'eux est « ouvert », elle attend (prerequis_ouverts) et le reste de la phase peut tourner.
// Avertissements (n'empêchent rien) : commandes de vérification ou de préparation composées, qu'un agent isolé dans un worktree
// se verrait refuser par la garde d'isolement de Claude Code ; ressource de préparation partagée qu'aucune tâche ne déclare ;
// tâche restante sans modele ou sans raison_modele (0.11.0). Un modele hors de MODELES est une erreur ; le choix lui-même n'est jamais jugé.
// Fable (0.11.0) : orchestre.config.json dit si l'utilisateur le permet (« fable » : true ou false, demandé par /orchestre:preparer).
// Une tâche restante sur fable, ou une escalade qui le contient : erreur avec fable: false, avertissement sans le réglage.
// orchestre.config.json (facultatif) : preparation, liste de commandes ; preparation_partagee, { ressource : [commandes] }.
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
// Un nom de branche ne commence jamais par « - » : sinon git le lirait comme une option (--output=… écrirait un fichier)
for (const [nom, b] of [["d'intégration", integ], ['de base', baseArg]]) if (b != null && (!b || b.startsWith('-'))) { console.error(`branche ${nom} invalide : ${b}`); process.exit(2) }
if (!existsSync(join(dir, 'taches'))) { console.error(`dossier de tâches introuvable : ${join(dir, 'taches')}`); process.exit(2) }

const arr = x => (Array.isArray(x) ? x : x ? [x] : [])
// Commande composée : enchaînement ou sous-commande, cd/export/affectation en tête, code évalué en ligne par un interpréteur,
// script en chemin absolu. Le texte entre guillemets ne compte pas, sauf une substitution entre guillemets doubles ; « \; » non plus.
const sansGuillemets = c => c.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""')
const sansApostrophes = c => c.replace(/'[^']*'/g, "''")
const INTERPRETES = 'node|nodejs|deno|bun|tsx|ts-node|python[0-9.]*|ruby|perl|php|bash|sh|zsh|pwsh|powershell'
const EN_LIGNE = new RegExp(`(^|[\\s/])(${INTERPRETES})\\s+(?:-{1,2}[\\w-]+\\s+)*(-e|-c|-p|-r|--eval|--print|-Command)\\s+["'\`]`)
function composee(c) {
  const s = String(c), nu = sansGuillemets(s).replace(/\\;/g, ''), raisons = []
  if (/&&|\|\||;|\|/.test(nu) || /\$\(|`|<\(/.test(sansApostrophes(s))) raisons.push('enchaînement ou sous-commande')
  if (/^\s*(cd|export)\s/.test(s) || /^\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s/.test(s)) raisons.push('cd, export ou affectation en tête')
  if (EN_LIGNE.test(s) || /(^|\s)deno\s+eval\s/.test(s)) raisons.push('code évalué en ligne')
  if (/(^|\s)\/[^\s'"]+\.(sh|bash|mjs|cjs|js|ts|py|rb|php|pl)(\s|$)/.test(sansGuillemets(s))) raisons.push('script en chemin absolu')
  return raisons
}
const courte = c => (String(c).length > 100 ? String(c).slice(0, 99) + '…' : String(c))
const fait = s => s === 'fusionnée' || s === 'annulée'
// Modèles d'une tâche (0.11.0) : /orchestre:preparer choisit haiku, sonnet ou opus ; fable seulement sur les tâches que l'utilisateur désigne
const MODELES = ['haiku', 'sonnet', 'opus', 'fable']
// Champ texte du frontmatter : une valeur vide (« modele: ») se lit comme une liste vide, donc comme absente
const texteFm = x => (typeof x === 'string' && x.trim() ? x.trim() : null)
// Modèle d'une tâche : absent (rien, ou une valeur vide), valide, ou refusé par une erreur
const etatModele = x => (texteFm(x) === null && (x === undefined || typeof x === 'string' || (Array.isArray(x) && !x.length)) ? 'absent' : MODELES.includes(texteFm(x)) ? 'valide' : 'refusé')
function unquote(v) {
  v = v.trim()
  if (v.startsWith('"')) { const m = v.match(/^"((?:[^"\\]|\\.)*)"/); return m ? m[1].replace(/\\(["\\])/g, '$1') : v }
  if (v.startsWith("'")) { const m = v.match(/^'((?:[^']|'')*)'/); return m ? m[1].replace(/''/g, "'") : v }
  return v.replace(/\s+#.*$/, '').trim()
}
// Liste courte [a, "b, c"] : les virgules entre guillemets ne séparent pas les éléments
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
// Cellules d'une ligne de tableau Markdown ; « \\| » est un « | » dans une cellule
const cellules = line => {
  const l = line.trim(), p = l.split(/(?<!\\)\|/)
  if (p.length && p[0].trim() === '') p.shift()
  if (/(?<!\\)\|$/.test(l)) p.pop()
  return p.map(c => c.trim().replace(/\\\|/g, '|'))
}
function statuts() {
  const p = join(dir, 'SUIVI.md'), map = {}
  if (!existsSync(p)) return map
  let cols = null
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = cellules(line)
    if (!cols && cells.includes('ID') && cells.includes('Statut')) { cols = { id: cells.indexOf('ID'), st: cells.indexOf('Statut'), n: cells.length }; continue }
    // Une ligne d'un autre tableau (moins de cellules que l'en-tête, ou sans statut) n'est pas une tâche (0.8.1)
    if (cols && cells.length >= cols.n && cells[cols.st] && /^[A-Z]+\d+[A-Z]*$/.test(cells[cols.id] || '')) map[cells[cols.id]] = cells[cols.st]
  }
  return map
}
const tokens = s => { const m = String(s || '').match(/([\d.,]+)\s*M/i); return m ? Number(m[1].replace(',', '.')) : 0 }
const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const TYPES = { decision: 'décision', geste: 'geste', environnement: 'environnement' }
const STATUTS = { ouvert: 'ouvert', fait: 'fait', abandonne: 'abandonné' }
function prerequis() {
  const p = join(dir, 'PREREQUIS.md'), liste = []
  if (!existsSync(p)) return null
  let cols = null, lignes = 0
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = cellules(line)
    const idx = k => cells.findIndex(x => norm(x) === norm(k))
    if (!cols && idx('ID') >= 0 && idx('Statut') >= 0) { cols = Object.fromEntries(['ID', 'Type', 'Prérequis', 'Statut', 'Preuve'].map(k => [k, idx(k)])); continue }
    const c = k => (cols && cols[k] >= 0 ? cells[cols[k]] || '' : '')
    if (!cols || cells.every(x => /^:?-*:?$/.test(x))) continue
    lignes++
    if (/^[A-Z]+\d+[A-Z]*$/.test(c('ID'))) liste.push({ id: c('ID'), type: TYPES[norm(c('Type'))] || c('Type'), texte: c('Prérequis'), statut: STATUTS[norm(c('Statut'))] || c('Statut'), preuve: c('Preuve') })
    else erreurs.push(`PREREQUIS.md : ligne ignorée, identifiant invalide « ${c('ID')} » (lettres majuscules puis chiffres, comme D5)`)
  }
  if (!cols) erreurs.push('PREREQUIS.md : aucun tableau reconnu (en-têtes ID, Type, Prérequis, Statut, Preuve)')
  return liste
}

const erreurs = [], avertissements = [], T = new Map(), tdir = join(dir, 'taches')
for (const f of readdirSync(tdir).filter(f => f.endsWith('.md')).sort()) {
  const fm = frontmatter(readFileSync(join(tdir, f), 'utf8'))
  if (!fm || !fm.id) { erreurs.push(`${f} : frontmatter absent ou sans id`); continue }
  if (T.has(fm.id)) erreurs.push(`${fm.id} : identifiant en double`)
  T.set(fm.id, { ...fm, fichier: join(tdir, f), phase: Number(fm.phase) })
}
const st = statuts()
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const existe = b => { try { git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]); return true } catch { return false } }
if (integ) {
  const base = baseArg || ['main', 'master'].find(existe)
  if (baseArg && !existe(baseArg)) erreurs.push(`branche de base introuvable : ${baseArg}`)
  try {
    const log = git(['log', '--format=%s', base && base !== integ ? `${base}..${integ}` : integ, '--'])
    for (const m of log.matchAll(/^tâche (\S+) :/gm)) st[m[1]] = 'fusionnée'
  } catch { erreurs.push(`branche d'intégration introuvable : ${integ}`) }
}
for (const t of T.values()) {
  if (!t.phase) erreurs.push(`${t.id} : phase manquante`)
  // Modèle absent (rien, « modele: », « modele: "" ») : avertissement plus bas (le worker tournera sur sonnet, puis l'échelle
  // d'escalade) ; valeur inconnue ou liste : erreur
  if (etatModele(t.modele) === 'refusé' && texteFm(t.modele) !== null) erreurs.push(`${t.id} : modèle inconnu « ${texteFm(t.modele)} » (${MODELES.join(', ')})`)
  else if (etatModele(t.modele) === 'refusé') erreurs.push(`${t.id} : modèle illisible (un seul nom : ${MODELES.join(', ')})`)
  if (!arr(t.verification).length) erreurs.push(`${t.id} : aucune commande de vérification`)
  if (!arr(t.definition_du_fini).length) erreurs.push(`${t.id} : définition du fini absente`)
  for (const d of arr(t.depend_de)) {
    if (!T.has(d)) erreurs.push(`${t.id} : dépendance inconnue ${d}`)
    else if (T.get(d).phase > t.phase) erreurs.push(`${t.id} : dépend de ${d}, d'une phase ultérieure`)
  }
}
const anc = (id, seen = new Set()) => { for (const d of arr(T.get(id)?.depend_de)) if (T.has(d) && !seen.has(d)) { seen.add(d); anc(d, seen) } return seen }
for (const id of T.keys()) if (anc(id).has(id)) erreurs.push(`${id} : cycle de dépendances`)
const racine = p => p.split('#')[0].trim().replace(/\*.*$/, '')
const chevauche = (a, b) => arr(a).some(x => arr(b).some(y => { const p = racine(x), q = racine(y); return p === q || p.startsWith(q) || q.startsWith(p) }))
const ids = [...T.keys()]
for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
  const a = T.get(ids[i]), b = T.get(ids[j])
  if (a.phase !== b.phase || anc(a.id).has(b.id) || anc(b.id).has(a.id)) continue
  if (arr(a.ressources).some(r => arr(b.ressources).includes(r))) continue
  if (chevauche(a.fichiers_possedes, b.fichiers_possedes)) erreurs.push(`${a.id} et ${b.id} peuvent tourner ensemble et partagent des fichiers`)
}
if (phaseF != null) for (const t of T.values()) if (t.phase < phaseF && !fait(st[t.id] || 'à-faire')) erreurs.push(`${t.id} (phase ${t.phase}) n'est ni fusionnée ni annulée : la phase ${phaseF} ne peut pas démarrer`)

// Prérequis : identifiants, types et statuts connus ; une décision « fait » est écrite dans HANDOFF.md, où les agents la lisent
const P = prerequis(), PR = new Map()
const handoff = existsSync(join(dir, 'HANDOFF.md')) ? readFileSync(join(dir, 'HANDOFF.md'), 'utf8').split(/\r?\n/) : []
const cite = (l, id) => new RegExp(`(^|[^A-Za-z0-9])${id}([^A-Za-z0-9]|$)`).test(l)
for (const x of P || []) {
  if (PR.has(x.id)) erreurs.push(`prérequis ${x.id} : identifiant en double`)
  if (T.has(x.id)) erreurs.push(`prérequis ${x.id} : identifiant déjà pris par une tâche`)
  if (!Object.values(TYPES).includes(x.type)) erreurs.push(`prérequis ${x.id} : type inconnu « ${x.type} » (décision, geste ou environnement)`)
  if (!Object.values(STATUTS).includes(x.statut)) erreurs.push(`prérequis ${x.id} : statut inconnu « ${x.statut} » (ouvert, fait ou abandonné)`)
  if (x.type === 'décision' && x.statut === 'fait' && !handoff.some(l => /^\s*(?:[-*]\s*)?d[ée]cision\s*·/i.test(l) && cite(l, x.id))) erreurs.push(`prérequis ${x.id} : décision marquée « fait » sans entrée « décision » qui la cite dans HANDOFF.md`)
  PR.set(x.id, x)
}
for (const t of T.values()) for (const id of arr(t.prerequis)) if (!PR.has(id)) erreurs.push(`${t.id} : prérequis inconnu ${id}${P ? '' : ' (pas de PREREQUIS.md)'}`)
const ouverts = t => arr(t.prerequis).filter(id => PR.has(id) && PR.get(id).statut === 'ouvert')
// Prêt à lancer, phase par phase : une tâche attend ses prérequis ouverts, ou une tâche de sa phase qui attend ;
// une phase attend la fin de la précédente si une tâche y attend
const restant = t => !fait(st[t.id] || 'à-faire')
const pret = []
let phaseBloquee = null
for (const ph of [...new Set([...T.values()].filter(restant).map(t => t.phase))].sort((a, b) => a - b)) {
  const ts = [...T.values()].filter(t => t.phase === ph && restant(t))
  const attend = new Map(ts.filter(t => ouverts(t).length || st[t.id] === 'besoin-humain').map(t => [t.id, [...(st[t.id] === 'besoin-humain' ? ['besoin-humain'] : []), ...ouverts(t)]]))
  for (let change = true; change;) {
    change = false
    for (const t of ts) if (!attend.has(t.id)) { const d = arr(t.depend_de).filter(x => attend.has(x)); if (d.length) { attend.set(t.id, d); change = true } }
  }
  pret.push({ phase: ph, apres_phase: phaseBloquee, taches: ts.length, en_attente: [...attend].map(([id, a]) => ({ id, attend: a })) })
  if (attend.size && phaseBloquee == null) phaseBloquee = ph
}

const taches = [...T.values()].filter(t => phaseF == null || t.phase === phaseF).map(t => ({
  id: t.id, titre: t.titre || '', fichier: t.fichier, phase: t.phase, ...(texteFm(t.modele) ? { modele: texteFm(t.modele) } : {}), ...(texteFm(t.raison_modele) ? { raison_modele: texteFm(t.raison_modele) } : {}), effort: t.effort || '',
  depend_de: arr(t.depend_de), ressources: arr(t.ressources), statut: st[t.id] || 'à-faire',
  verification: arr(t.verification), estimation_tokens: tokens(t.estimation_tokens), prerequis_ouverts: ouverts(t),
}))
// Toutes les tâches, quelle que soit la phase demandée : l'orchestrateur vérifie les tâches citées par une décision d'office
const tous = [...T.values()].map(t => ({ id: t.id, phase: t.phase, statut: st[t.id] || 'à-faire' }))
const phase_max = Math.max(0, ...[...T.values()].map(t => t.phase || 0))
const bloque = id => [...T.values()].filter(t => restant(t) && arr(t.prerequis).includes(id)).map(t => t.id)
const prereqs = [...PR.values()].map(x => ({ ...x, bloque: bloque(x.id) }))
// Une décision reportée qu'aucune tâche restante ne cite ne bloquerait rien : un agent la trancherait à la place de l'humain
for (const x of prereqs) if (x.type === 'décision' && x.statut === 'ouvert' && !x.bloque.length) erreurs.push(`prérequis ${x.id} : décision ouverte qu'aucune tâche restante ne cite dans « prerequis » (ajoute-la aux tâches qu'elle touche, ou passe-la à « abandonné »)`)
const orphelins = prereqs.filter(x => x.type !== 'décision' && x.statut === 'ouvert' && !x.bloque.length)

// Commandes de vérification des tâches restantes : composées, elles seraient refusées à un agent isolé dans un worktree
const refusable = 'un agent isolé dans un worktree se la verra refuser (garde d\'isolement de Claude Code) : en faire une commande simple, ou un script du projet'
// Avec --phase, seulement les tâches de la phase : le lecteur-plan n'a besoin que d'elles, et la sortie reste courte (0.8.1)
for (const t of T.values()) if (!fait(st[t.id] || 'à-faire') && (phaseF == null || t.phase === phaseF)) for (const c of arr(t.verification)) {
  const r = composee(c)
  if (r.length) avertissements.push(`${t.id} : vérification « ${courte(c)} » (${r.join(', ')}) : ${refusable}`)
}
// Modèle et raison des tâches restantes (0.11.0) : /orchestre:preparer les écrit ; un plan plus ancien tourne quand même
for (const t of T.values()) if (!fait(st[t.id] || 'à-faire') && (phaseF == null || t.phase === phaseF)) {
  if (etatModele(t.modele) === 'absent') avertissements.push(`${t.id} : pas de modele (${MODELES.slice(0, 3).join(', ')}) : le worker tournera sur sonnet, et ses corrections suivront l'échelle d'escalade`)
  else if (etatModele(t.modele) === 'valide' && !texteFm(t.raison_modele)) avertissements.push(`${t.id} : modele ${texteFm(t.modele)} sans raison_modele (une ligne qui justifie le choix)`)
}
// Préparation de l'environnement (orchestre.config.json) : forme, commandes simples, ressources déclarées par une tâche
let config = null
if (existsSync(join(dir, 'orchestre.config.json'))) {
  try { config = JSON.parse(readFileSync(join(dir, 'orchestre.config.json'), 'utf8')) } catch (e) { erreurs.push(`orchestre.config.json illisible : ${e.message}`) }
}
const estListe = x => Array.isArray(x) && x.every(c => typeof c === 'string' && c.trim())
if (config && config.preparation !== undefined) {
  if (!estListe(config.preparation)) erreurs.push('orchestre.config.json : « preparation » doit être une liste de commandes')
  else for (const c of config.preparation) { const r = composee(c); if (r.length) avertissements.push(`preparation : « ${courte(c)} » (${r.join(', ')}) : ${refusable}`) }
}
if (config && config.preparation_partagee !== undefined) {
  const pp = config.preparation_partagee
  if (!pp || typeof pp !== 'object' || Array.isArray(pp) || !Object.values(pp).every(estListe)) erreurs.push('orchestre.config.json : « preparation_partagee » doit associer à chaque ressource une liste de commandes')
  else for (const [res, cs] of Object.entries(pp)) {
    if (![...T.values()].some(t => arr(t.ressources).includes(res))) avertissements.push(`preparation_partagee : aucune tâche ne déclare la ressource « ${res} » ; ses commandes ne seront jamais lancées`)
    for (const c of cs) { const r = composee(c); if (r.length) avertissements.push(`preparation_partagee (${res}) : « ${courte(c)} » (${r.join(', ')}) : ${refusable}`) }
  }
}
// Fable : permis seulement si l'utilisateur l'a dit (fable: true). Avec fable: false, une tâche restante sur fable ou une escalade
// qui le contient bloque, dans tout le plan ; sans le réglage (plan d'avant), un avertissement fait trancher l'utilisateur
const fable = config && config.fable !== undefined ? config.fable : null
if (fable !== null && typeof fable !== 'boolean') erreurs.push('orchestre.config.json : « fable » doit valoir true ou false')
else if (fable !== true) {
  const surFable = [...T.values()].filter(t => !fait(st[t.id] || 'à-faire') && texteFm(t.modele) === 'fable')
  const escFable = !!config && Array.isArray(config.escalade) && config.escalade.includes('fable')
  if (fable === false) {
    for (const t of surFable) erreurs.push(`${t.id} : modèle fable, refusé par orchestre.config.json (fable: false) : passer la tâche sur opus, ou fable: true si l'utilisateur le veut`)
    if (escFable) erreurs.push('orchestre.config.json : « escalade » contient fable, refusé par fable: false')
  } else {
    for (const t of surFable.filter(t => phaseF == null || t.phase === phaseF)) avertissements.push(`${t.id} : modèle fable, sans réglage « fable » dans orchestre.config.json : à trancher avec l'utilisateur (/orchestre:pret)`)
    if (escFable) avertissements.push("orchestre.config.json : « escalade » contient fable, sans réglage « fable » : à trancher avec l'utilisateur (/orchestre:pret)")
  }
}
const pretVu = pret.filter(p => phaseF == null || p.phase === phaseF)
// JSON sur une ligne : lu par des scripts et des agents, il reste ainsi sous les seuils d'affichage de l'outil Bash plus longtemps (0.8.1)
if (asJson) console.log(JSON.stringify({ ok: erreurs.length === 0, erreurs, avertissements, taches, tous, phase_max, prerequis: prereqs, pret: pretVu, fable: typeof fable === 'boolean' ? fable : null }))
else {
  if (erreurs.length) console.log(erreurs.map(e => '✗ ' + e).join('\n'))
  else {
    const parPhase = {}
    for (const t of taches) if (!fait(t.statut)) parPhase[t.phase] = (parPhase[t.phase] || 0) + t.estimation_tokens
    const fmt = n => n.toFixed(1).replace('.', ',') + ' M'
    console.log(`✓ plan valide : ${T.size} tâche${T.size > 1 ? 's' : ''}. Reste à faire, en tokens estimés : ` +
      Object.entries(parPhase).map(([p, n]) => `phase ${p} ${fmt(n)}`).join(' · ') +
      ` · total ${fmt(Object.values(parPhase).reduce((a, b) => a + b, 0))}`)
    if (!P) console.log('ℹ pas de PREREQUIS.md : aucun prérequis déclaré (voir /orchestre:pret)')
    for (const x of orphelins) console.log(`⚠ prérequis ${x.id} (${x.type}) ouvert, mais aucune tâche restante ne le cite`)
    const ouv = prereqs.filter(x => x.statut === 'ouvert' && x.bloque.length)
    if (ouv.length) console.log('Prérequis ouverts : ' + ouv.map(x => `${x.id} (${x.type}) → ${x.bloque.join(', ')}`).join(' · '))
    if (P || ouv.length) {
      console.log('Prêt à lancer :')
      for (const p of pretVu) {
        const quoi = [
          ...(p.apres_phase != null ? [`attend la fin de la phase ${p.apres_phase}`] : []),
          ...(p.en_attente.length === p.taches ? ['aucune tâche ne peut partir'] : []),
          ...p.en_attente.map(e => `${e.id} attend ${e.attend.join(', ')}`),
        ]
        console.log(`- phase ${p.phase} : ${quoi.length ? quoi.join(' ; ') : 'prête'}`)
      }
    }
  }
}
if (!asJson) for (const a of avertissements) console.log('⚠ ' + a)
// Pas de process.exit() ici : dans un tube, il couperait la sortie à 64 Ko (le JSON d'un gros plan, 0.8.1)
process.exitCode = erreurs.length ? 1 : 0
