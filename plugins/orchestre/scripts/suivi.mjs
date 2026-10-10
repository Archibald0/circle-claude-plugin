#!/usr/bin/env node
// suivi (plugin orchestre 0.11.0) : seul écrivain de plans/<nom>/suivi.json (format orchestre-suivi/2) et de sa vue SUIVI.md.
// Node 18 ou plus, aucune dépendance. Contrat : 0.11.0/CONTRAT.md ; schéma : SCHEMA ci-dessous, copie de suivi.v2.schema.json.
// Un suivi.json au format orchestre-suivi/1 (0.10 et avant) est lu et migré en mémoire ; la première écriture le passe en /2.
//
// Usage : node <racine du plugin>/scripts/suivi.mjs <commande> [<dossier-plan>] [options]
// Les écritures lisent un objet JSON sur l'entrée standard, ou dans l'option --json '<objet>' (une seule commande à autoriser,
// sans heredoc ni pipe : c'est la forme que le workflow donne à ses agents). Sans dossier, le seul plan de plans/.
//   debut-run  { phase, mode, parallelisme, corrections_max, decisions_office_max, run_id? }
//              une fois par run, par son premier agent : relit le plan (plan-lint), passe un run resté en cours à « interrompu »
//   etape      { tache, etape, isole?, refus?, modele?, changement? }      étape : worker, vérification, évaluation, correction, fusion,
//              replanification, suivi ; worker remet à zéro les champs du run de la tâche ; correction ajoute refus { essai, par, manques } ;
//              modele : le modèle lancé (worker, correction), noté dans modele_utilise ; changement { de, vers, raison } : événement « modele »
//   cloture    { tache, statut, essais, branche, tokens_reels?, refus?, instables?, non_verifiables?, blocage?, relectures?,
//                decisions_office?, points?, taches_ajoutees?, amendements?, replanification? }      régénère SUIVI.md
//   arbitrage  { tache, titre, option, taches_ajoutees?, amendements?, amendements_ecartes? }      régénère SUIVI.md
//   fin-run    la valeur de retour du workflow (statut, detail, arbitrage, points_a_trancher, taches…) ;
//              clôt, d'après le bilan, les tâches restées sans clôture (exception du workflow, E:316) et régénère alors SUIVI.md
//   pilote     { tache, statut: "fusionnée" | "annulée", raison? }      geste du pilote ; régénère SUIVI.md
//   vue [--stdout]          régénère SUIVI.md (ou l'affiche sans rien écrire) ; statuts relus dans SUIVI.md et git, comme debut-run
//   etat                    l'avancement en Markdown compact, comme /orchestre:etat ; lecture seule, toujours code 0
//   valider [--fichier <f>] valide suivi.json contre le schéma
// Codes de sortie : 0 fait ; 1 écriture refusée, suivi.json et SUIVI.md inchangés ; 2 appel invalide.
//
// Garanties : verrou plans/<nom>/.suivi.lock (8 tâches au plus en parallèle) ; écriture dans .suivi.<pid>.tmp puis renommage ;
// validation de chaque écriture ; fichiers toujours dans le checkout principal, même appelé depuis un worktree ;
// suivi.json, .suivi.lock et .suivi.*.tmp ajoutés à .git/info/exclude s'ils ne sont pas déjà ignorés.
// suivi.json absent : reconstruit depuis SUIVI.md, HANDOFF.md et plan-lint ; les champs de run repartent vides.
import { readFileSync, writeFileSync, existsSync, readdirSync, openSync, closeSync, writeSync, renameSync, unlinkSync, statSync, mkdirSync, appendFileSync, realpathSync } from 'node:fs'
import { join, resolve, relative, dirname, basename, isAbsolute, sep } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const FORMAT = 'orchestre-suivi/2'
// Format de la 0.10 et avant : lu, puis migré (migrer)
export const FORMAT_V1 = 'orchestre-suivi/1'
const STATUTS = ['à-faire', 'ajoutée', 'fusionnée', 'bloquée', 'échec', 'besoin-humain', 'annulée']
const ETAPES = ['worker', 'vérification', 'évaluation', 'correction', 'fusion', 'replanification', 'suivi']
const FINS_DE_RUN = ['terminé', 'partiel', 'arbitrage', 'à-relancer', 'erreur']
const CLOTURES = ['fusionnée', 'bloquée', 'échec', 'besoin-humain']
const JOURNAL_MAX = 200
const RE_ID = /^[A-Z]+[0-9]+[A-Z]*$/
const FAIT = s => s === 'fusionnée' || s === 'annulée'
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
const LINT = join(dirname(fileURLToPath(import.meta.url)), 'plan-lint.mjs')

class Refus extends Error { constructor(m) { super(m); this.code = 1 } }
class Usage extends Error { constructor(m) { super(m); this.code = 2 } }
const refuser = m => { throw new Refus(m) }
const essai = f => { try { return f() } catch { return null } }
const lireOu = f => essai(() => readFileSync(f, 'utf8'))
const git = (args, cwd) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const reel = p => essai(() => realpathSync(p)) || resolve(p)
const court = (s, n = 140) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const longueur = s => [...s].length
const norm = s => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ')

// Date ISO 8601 avec le fuseau de la machine, à la seconde : 2026-10-05T10:16:00+02:00
export function maintenant(d = new Date()) {
  const p = n => String(n).padStart(2, '0'), o = -d.getTimezoneOffset(), a = Math.abs(o)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${o >= 0 ? '+' : '-'}${p(Math.floor(a / 60))}:${p(a % 60)}`
}

// ─── Schéma orchestre-suivi/2, sans les descriptions ────────────────────────────────────────────────────────────────
const ref = n => ({ $ref: `#/$defs/${n}` })
const tab = items => ({ type: 'array', items })
const objet = (required, properties, extra = {}) => ({ type: 'object', additionalProperties: false, required, properties, ...extra })
const ENTIER1 = { type: 'integer', minimum: 1 }
export const SCHEMA = {
  ...objet(['format', 'plan', 'dossier', 'integration', 'base', 'maj', 'taches', 'runs', 'points', 'decisions_office', 'relectures', 'prerequis', 'handoff', 'lint', 'journal', 'journal_omis'], {
    format: { const: FORMAT },
    plan: { type: 'string', minLength: 1 },
    dossier: { type: 'string', minLength: 1 },
    integration: { type: 'string', minLength: 1 },
    base: { type: ['string', 'null'] },
    maj: ref('date'),
    taches: tab(ref('tache')),
    runs: tab(ref('run')),
    points: tab(ref('point')),
    decisions_office: tab(ref('decisionOffice')),
    relectures: tab(ref('relecture')),
    prerequis: tab(ref('prerequis')),
    handoff: { type: 'object', additionalProperties: { type: 'object', additionalProperties: ref('compte') } },
    lint: objet(['ok', 'erreurs'], { ok: { type: 'boolean' }, erreurs: tab({ type: 'string' }) }),
    journal: { type: 'array', maxItems: JOURNAL_MAX, items: ref('evenement') },
    journal_omis: { type: 'integer', minimum: 0 },
  }),
  $defs: {
    date: { type: 'string', format: 'date-time' },
    dateOuNull: { oneOf: [ref('date'), { type: 'null' }] },
    idTache: { type: 'string', pattern: '^[A-Z]+[0-9]+[A-Z]*$' },
    textes: tab({ type: 'string' }),
    ids: tab(ref('idTache')),
    compte: objet(['mineur', 'majeur'], { mineur: { type: 'integer', minimum: 0 }, majeur: { type: 'integer', minimum: 0 } }),
    tache: objet(['id', 'titre', 'phase', 'lot', 'depend_de', 'modele', 'modele_utilise', 'statut', 'essais', 'branche', 'estimation_tokens', 'tokens_reels', 'ajoutee_par', 'etape', 'isole', 'debut', 'fin', 'attend', 'refus', 'instables', 'non_verifiables', 'blocage'], {
      id: ref('idTache'),
      titre: { type: 'string', minLength: 1 },
      phase: ENTIER1,
      lot: { type: ['string', 'null'] },
      depend_de: ref('ids'),
      modele: { type: ['string', 'null'], minLength: 1 },
      modele_utilise: { type: ['string', 'null'], minLength: 1 },
      statut: { enum: STATUTS },
      essais: { type: 'integer', minimum: 0 },
      branche: { type: ['string', 'null'] },
      estimation_tokens: { type: ['number', 'null'], minimum: 0 },
      tokens_reels: { type: ['string', 'null'] },
      ajoutee_par: { oneOf: [ref('idTache'), { type: 'null' }] },
      etape: { enum: [...ETAPES, null] },
      isole: { type: ['boolean', 'null'] },
      debut: ref('dateOuNull'),
      fin: ref('dateOuNull'),
      attend: tab({ type: 'string', minLength: 1 }),
      refus: tab(objet(['essai', 'par', 'manques'], { essai: ENTIER1, par: { enum: ['vérification', 'évaluation'] }, manques: ref('textes') })),
      instables: ref('textes'),
      non_verifiables: ref('textes'),
      blocage: ref('textes'),
    }),
    run: objet(['numero', 'run_id', 'phase', 'mode', 'parallelisme', 'corrections_max', 'decisions_office_max', 'statut', 'debut', 'fin', 'detail', 'arbitrages_appliques', 'amendements_ecartes', 'taches_ajoutees', 'reportees', 'non_lancees', 'en_attente', 'en_attente_prerequis'], {
      numero: ENTIER1,
      run_id: { type: ['string', 'null'] },
      phase: ENTIER1,
      mode: { enum: ['auto', 'devia', 'phase'] },
      parallelisme: { type: 'integer', minimum: 1, maximum: 8 },
      corrections_max: { type: 'integer', minimum: 0 },
      decisions_office_max: { type: 'integer', minimum: 0 },
      statut: { enum: ['en-cours', ...FINS_DE_RUN, 'interrompu'] },
      debut: ref('date'),
      fin: ref('dateOuNull'),
      detail: { type: ['string', 'null'] },
      arbitrages_appliques: tab(objet(['tache', 'titre', 'option'], { tache: ref('idTache'), titre: { type: 'string' }, option: { type: 'string' } })),
      amendements_ecartes: tab(objet(['tache', 'id', 'raison'], { tache: ref('idTache'), id: ref('idTache'), raison: { type: 'string' } })),
      taches_ajoutees: tab(objet(['id', 'phase', 'titre'], { id: ref('idTache'), phase: ENTIER1, titre: { type: 'string' } })),
      reportees: ref('ids'),
      non_lancees: ref('ids'),
      en_attente: ref('ids'),
      en_attente_prerequis: tab(objet(['id', 'prerequis'], { id: ref('idTache'), prerequis: tab({ type: 'string' }) })),
    }),
    point: objet(['run', 'tache', 'titre', 'contexte', 'humain', 'role', 'statut', 'option_choisie', 'options'], {
      run: ENTIER1,
      tache: ref('idTache'),
      titre: { type: 'string', minLength: 1 },
      contexte: { type: 'string' },
      humain: { type: 'boolean' },
      role: { enum: ['arret', 'a-trancher'] },
      statut: { enum: ['ouvert', 'tranché'] },
      option_choisie: { type: ['string', 'null'] },
      coupe_circuit: { type: 'boolean' },
      incoherence: { type: 'string' },
      options: tab(objet(['id', 'description'], { id: { type: 'string', minLength: 1 }, description: { type: 'string' }, impact: { type: 'string' }, recommande: { type: 'boolean' } })),
    }),
    decisionOffice: objet(['run', 'tache', 'titre', 'option', 'description'], { run: ENTIER1, tache: ref('idTache'), titre: { type: 'string' }, option: { type: 'string' }, description: { type: 'string' } }),
    relecture: objet(['tache', 'phase', 'texte', 'run', 'quand'], {
      tache: { oneOf: [ref('idTache'), { type: 'null' }] },
      phase: { type: ['integer', 'null'], minimum: 1 },
      texte: { type: 'string', minLength: 1 },
      run: { type: ['integer', 'null'], minimum: 1 },
      quand: ref('dateOuNull'),
    }),
    prerequis: objet(['id', 'type', 'statut', 'texte', 'bloque'], { id: ref('idTache'), type: { type: 'string' }, statut: { type: 'string' }, texte: { type: 'string' }, bloque: ref('ids') }),
    evenement: objet(['quand', 'genre', 'tache', 'texte'], {
      quand: ref('date'),
      genre: { enum: ['run', 'tache', 'etape', 'refus', 'statut', 'ajout', 'amendement', 'relecture', 'decision-office', 'point', 'arbitrage', 'pilote', 'erreur', 'modele'] },
      tache: { oneOf: [ref('idTache'), { type: 'null' }] },
      texte: { type: 'string', minLength: 1 },
    }),
  },
}

// Validation écrite à la main : le sous-ensemble de JSON Schema qu'utilise SCHEMA
const RE_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const decrire = x => (x === undefined ? 'rien' : typeof x === 'string' ? `« ${court(x, 40)} »` : court(JSON.stringify(x), 40))
const estDe = (t, x) => ({ null: x === null, boolean: typeof x === 'boolean', string: typeof x === 'string', integer: Number.isInteger(x), number: typeof x === 'number' && Number.isFinite(x), array: Array.isArray(x), object: !!x && typeof x === 'object' && !Array.isArray(x) })[t]
function verifier(s, x, ou, err) {
  if (s.$ref) s = SCHEMA.$defs[s.$ref.split('/').pop()]
  if (s.oneOf) {
    if (s.oneOf.filter(o => { const e = []; verifier(o, x, ou, e); return !e.length }).length !== 1) err.push(`${ou} : ${decrire(x)} ne correspond à aucune forme permise`)
    return
  }
  if ('const' in s && x !== s.const) return err.push(`${ou} : ${decrire(x)} au lieu de « ${s.const} »`)
  if (s.enum && !s.enum.includes(x)) return err.push(`${ou} : ${decrire(x)} n'est pas permis (${s.enum.map(e => e ?? 'null').join(', ')})`)
  if (s.type && ![].concat(s.type).some(t => estDe(t, x))) return err.push(`${ou} : ${[].concat(s.type).join(' ou ')} attendu, ${decrire(x)} reçu`)
  if (typeof x === 'string') {
    if (s.minLength && longueur(x) < s.minLength) err.push(`${ou} : texte vide`)
    if (s.pattern && !new RegExp(s.pattern).test(x)) err.push(`${ou} : ${decrire(x)} ne suit pas le motif ${s.pattern}`)
    if (s.format === 'date-time' && !(RE_DATE.test(x) && !Number.isNaN(Date.parse(x)))) err.push(`${ou} : ${decrire(x)} n'est pas une date ISO 8601 avec fuseau`)
  }
  if (typeof x === 'number') {
    if (s.minimum != null && x < s.minimum) err.push(`${ou} : ${x} est inférieur à ${s.minimum}`)
    if (s.maximum != null && x > s.maximum) err.push(`${ou} : ${x} est supérieur à ${s.maximum}`)
  }
  if (Array.isArray(x)) {
    if (s.maxItems != null && x.length > s.maxItems) err.push(`${ou} : ${x.length} éléments, ${s.maxItems} au plus`)
    if (s.items) x.forEach((y, i) => verifier(s.items, y, `${ou}[${i}]`, err))
  } else if (x && typeof x === 'object') {
    for (const k of s.required || []) if (x[k] === undefined) err.push(`${ou ? ou + '.' : ''}${k} : manquant`)
    for (const [k, y] of Object.entries(x)) {
      if (y === undefined) continue
      const sk = s.properties && s.properties[k]
      if (sk) verifier(sk, y, ou ? `${ou}.${k}` : k, err)
      else if (s.additionalProperties === false) err.push(`${ou ? ou + '.' : ''}${k} : champ inconnu du format ${FORMAT}`)
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') verifier(s.additionalProperties, y, ou ? `${ou}.${k}` : k, err)
    }
  }
}
export function valider(doc) { const err = []; verifier(SCHEMA, doc, '', err); return err }

// ─── Plan : checkout principal, configuration, plan-lint, frontmatter, HANDOFF.md ─────────────────────────────────────
// Le checkout principal est le premier bloc de « git worktree list --porcelain » (comme etat.mjs) : les fichiers de suivi y vivent toujours
function localiser(arg) {
  const cwd = process.cwd()
  const ici = essai(() => git(['rev-parse', '--show-toplevel'], cwd).trim())
  if (!ici) throw new Usage('pas dans un dépôt git')
  const principal = reel((essai(() => git(['worktree', 'list', '--porcelain'], cwd)) || '').match(/^worktree (.+)$/m)?.[1] || ici)
  let rel
  if (arg) {
    const abs = resolve(cwd, arg)
    // Relatif au checkout où l'on est (worktree compris), puis au checkout principal ; sinon tel quel, depuis la racine
    for (const base of [reel(ici), principal]) {
      const r = existsSync(abs) ? relative(base, reel(abs)) : null
      if (r != null && !r.startsWith('..') && !isAbsolute(r)) { rel = r; break }
    }
    if (rel == null) rel = relative(principal, resolve(principal, arg))
    if (!existsSync(join(principal, rel, 'taches'))) throw new Usage(`plan introuvable dans ce checkout : ${arg}`)
  } else {
    const p = join(principal, 'plans')
    const plans = existsSync(p) ? readdirSync(p).filter(n => existsSync(join(p, n, 'taches'))).sort() : []
    if (!plans.length) throw new Usage('aucun plan dans plans/ ; précise son dossier : plans/<nom>')
    if (plans.length > 1) throw new Usage(`plusieurs plans (${plans.map(n => 'plans/' + n).join(', ')}) ; précise lequel`)
    rel = join('plans', plans[0])
  }
  const dir = join(principal, rel), nom = basename(dir)
  const cfg = essai(() => JSON.parse(readFileSync(join(dir, 'orchestre.config.json'), 'utf8'))) || {}
  const integration = cfg.branche_integration || `plan/${nom}`, base = cfg.branche_base || null
  // Un nom de branche qui commence par « - » serait lu par git comme une option
  if ([integration, base].some(b => b && String(b).startsWith('-'))) throw new Usage('branche invalide dans orchestre.config.json')
  return { racine: principal, dir, rel: rel.split(sep).join('/') || '.', nom, integration, base }
}

// plan-lint fait foi pour le frontmatter (amendements compris), les statuts (git compris) et les prérequis
function planLint(ctx) {
  const r = spawnSync(process.execPath, [LINT, ctx.rel, '--json', '--integration', ctx.integration, ...(ctx.base ? ['--base', ctx.base] : [])], { cwd: ctx.racine, env: ENV, encoding: 'utf8', maxBuffer: 1 << 26 })
  const L = essai(() => JSON.parse(r.stdout))
  if (L && Array.isArray(L.taches)) return L
  return { ok: false, erreurs: [`plan-lint n'a pas rendu d'état (${String(r.stderr || r.stdout || 'sans message').trim().split('\n')[0]})`], taches: null, prerequis: null }
}

function unquote(v) {
  v = v.trim()
  if (v.startsWith('"')) { const m = v.match(/^"((?:[^"\\]|\\.)*)"/); return m ? m[1].replace(/\\(["\\])/g, '$1') : v }
  if (v.startsWith("'")) { const m = v.match(/^'((?:[^']|'')*)'/); return m ? m[1].replace(/''/g, "'") : v }
  return v.replace(/\s+#.*$/, '').trim()
}
// Ce que plan-lint ne rend pas : lot_parallele, et la présence d'estimation_tokens (plan-lint rend 0 pour une estimation absente)
function frontmatter(ctx, fichier) {
  const fm = (lireOu(resolve(ctx.racine, fichier)) || '').match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || ''
  const val = k => { const m = fm.match(new RegExp(`^${k}:[ \\t]*(.*)$`, 'm')); return m ? unquote(m[1]) : null }
  return { lot: val('lot_parallele') || null, estimation: !!val('estimation_tokens') }
}

// Entrées « type · gravité · description », rangées sous « ## <id> » ou « ## plan source » (scribe.md)
function lireHandoff(texte) {
  const comptes = {}, relectures = []
  let section = null
  for (const ligne of String(texte || '').split(/\r?\n/)) {
    const h = ligne.match(/^##\s+(.+?)\s*$/)
    if (h) { section = h[1]; continue }
    const m = ligne.match(/^\s*(?:[-*]\s*)?([\p{L}][\p{L}-]*)\s*·\s*(mineur|majeur)\s*·\s*(.*)$/iu)
    if (!m) continue
    const type = m[1].toLowerCase(), gravite = m[2].toLowerCase(), cle = section ?? '(avant les sections)'
    const c = ((comptes[cle] ||= {})[type] ||= { mineur: 0, majeur: 0 })
    c[gravite]++
    if (type === 'relecture' && m[3].trim()) relectures.push({ tache: RE_ID.test(section || '') ? section : null, texte: m[3].trim() })
  }
  return { comptes, relectures }
}

// ─── SUIVI.md : le tableau seul, le texte autour gardé octet pour octet ───────────────────────────────────────────────
// Cellules d'une ligne de tableau Markdown ; « \| » est un « | » dans une cellule (comme plan-lint)
const cellules = line => {
  const l = line.trim(), p = l.split(/(?<!\\)\|/)
  if (p.length && p[0].trim() === '') p.shift()
  if (/(?<!\\)\|$/.test(l)) p.pop()
  return p.map(c => c.trim().replace(/\\\|/g, '|'))
}
const echapper = s => String(s).replace(/\|/g, '\\|')
const COLONNES = { id: 'ID', titre: 'Titre', phase: 'Phase', lot: 'Lot', 'depend de': 'Dépend de', modele: 'Modèle', statut: 'Statut', essais: 'Essais', branche: 'Branche', tokens: 'Tokens est. / réels' }
const cleColonne = nom => { const n = norm(nom); return n.startsWith('tokens') ? 'tokens' : n in COLONNES ? n : null }
const LEGENDE = `Statuts : ${STATUTS.join(' · ')}`

// Le tableau : de la ligne d'en-tête qui contient ID et Statut (repère de plan-lint) à la dernière ligne qui suit et commence par « | »
function tableau(texte) {
  const lignes = texte.split('\n'), net = l => l.replace(/\r$/, '')
  const h = lignes.findIndex(l => net(l).trim().startsWith('|') && cellules(net(l)).includes('ID') && cellules(net(l)).includes('Statut'))
  if (h < 0) return null
  let fin = h
  while (fin + 1 < lignes.length && net(lignes[fin + 1]).trim().startsWith('|')) fin++
  const estSep = i => i <= fin && cellules(net(lignes[i])).every(x => /^:?-+:?$/.test(x))
  const sepI = estSep(h + 1) ? h + 1 : -1
  const lignesT = []
  for (let i = h + 1; i <= fin; i++) if (i !== sepI) lignesT.push({ n: i + 1, cells: cellules(net(lignes[i])) })
  // Lignes de tâches écrites après le tableau (sous la légende, par un scribe d'avant la 0.8.0) : plan-lint les lit,
  // la vue les reprend dans le tableau (0.8.1). Une ligne dont l'ID n'est pas une tâche reste du texte.
  // Seule compte une ligne qui a au moins les cellules de l'en-tête et un statut connu : une ligne d'un autre tableau
  // (notes, décisions) reste du texte.
  const entete = cellules(net(lignes[h])), iId = entete.indexOf('ID'), iSt = entete.indexOf('Statut'), orphelines = []
  for (let i = fin + 1; i < lignes.length; i++) {
    if (!net(lignes[i]).trim().startsWith('|')) continue
    const cells = cellules(net(lignes[i]))
    if (cells.length >= entete.length && RE_ID.test(cells[iId] || '') && STATUTS.includes(cells[iSt] || '')) orphelines.push({ i, n: i + 1, cells })
  }
  return { lignes, h, fin, entete, sep: sepI >= 0 ? net(lignes[sepI]) : null, lignesT, orphelines, crlf: lignes[h].endsWith('\r'), retrait: net(lignes[h]).match(/^\s*/)[0] }
}

// Sens inverse, pour la reconstruction : les cellules lues par le nom de leur colonne ; un statut hors des 7 est une erreur
function lireSuivi(texte) {
  const tb = texte == null ? null : tableau(texte)
  if (!tb) return null
  const k = tb.entete.map(cleColonne), col = (cells, c) => (k.indexOf(c) >= 0 ? cells[k.indexOf(c)] ?? '' : '')
  const vide = v => !v || v === '—' || v === '-'
  const lignes = [], vus = new Set()
  for (const { n, cells, orpheline } of [...tb.lignesT, ...tb.orphelines.map(o => ({ ...o, orpheline: true }))]) {
    const id = col(cells, 'id')
    if (!RE_ID.test(id)) continue
    if (vus.has(id) && !orpheline) refuser(`SUIVI.md, ligne ${n} : ${id} en double`)
    vus.add(id)
    const statut = col(cells, 'statut')
    if (!STATUTS.includes(statut)) refuser(`SUIVI.md, ligne ${n} : statut inconnu « ${statut} » pour ${id} (${STATUTS.join(', ')})`)
    const tok = col(cells, 'tokens'), i = tok.indexOf(' / '), reels = i >= 0 ? tok.slice(i + 3).trim() : ''
    const phase = Number(col(cells, 'phase')), essais = Number(col(cells, 'essais'))
    const l = {
      id, titre: col(cells, 'titre') || id, statut, essais: Number.isInteger(essais) && essais >= 0 ? essais : 0,
      branche: vide(col(cells, 'branche')) ? null : col(cells, 'branche'), tokens_reels: vide(reels) ? null : reels,
      phase: Number.isInteger(phase) && phase >= 1 ? phase : undefined, modele: vide(col(cells, 'modele')) ? null : col(cells, 'modele'),
      lot: vide(col(cells, 'lot')) ? null : col(cells, 'lot'), depend_de: vide(col(cells, 'depend de')) ? [] : col(cells, 'depend de').split(/\s*,\s*/).filter(Boolean),
    }
    // Une ligne sous la légende qui reprend une tâche déjà lue la remplace, à sa place : plan-lint lit aussi la dernière
    const j = lignes.findIndex(x => x.id === id)
    if (j >= 0) lignes[j] = l
    else lignes.push(l)
  }
  return lignes
}

const millions = n => (n == null ? '—' : `${n.toFixed(1).replace('.', ',')} M`)
function cellule(t, k) {
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

// La vue : colonnes de l'en-tête existant dans son ordre, une ligne par tâche, cellules complétées à la largeur de leur colonne
export function vue(doc, texte) {
  const tb = texte == null ? null : tableau(texte)
  const entete = tb ? tb.entete : Object.values(COLONNES)
  const cles = entete.map(cleColonne)
  const anciens = new Map()
  if (tb) { const iId = cles.indexOf('id'); for (const l of [...tb.orphelines, ...tb.lignesT]) if (RE_ID.test(l.cells[iId] || '')) anciens.set(l.cells[iId], l.cells) }
  // Une colonne inconnue garde la cellule actuelle de la tâche, retrouvée par son ID
  const corps = doc.taches.map(t => cles.map((k, j) => echapper(k ? cellule(t, k) : (anciens.get(t.id) || [])[j] ?? '')))
  const tete = entete.map(echapper)
  const larg = tete.map((c, j) => Math.max(3, longueur(c), ...corps.map(r => longueur(r[j]))))
  const remplir = (c, j) => c + ' '.repeat(larg[j] - longueur(c))
  const sepCells = tb && tb.sep ? cellules(tb.sep) : []
  const espace = tb && tb.sep ? /^\s*\|\s/.test(tb.sep) : false
  const tiret = (j, w) => { const a = sepCells[j] || '', g = a.startsWith(':'), d = a.length > 1 && a.endsWith(':'); return (g ? ':' : '-') + '-'.repeat(Math.max(0, w - 2)) + (d ? ':' : '-') }
  const fin = tb && tb.crlf ? '\r' : '', retrait = tb ? tb.retrait : ''
  const lignes = [
    retrait + '| ' + tete.map(remplir).join(' | ') + ' |' + fin,
    retrait + (espace ? '| ' + larg.map((w, j) => tiret(j, w)).join(' | ') + ' |' : '|' + larg.map((w, j) => tiret(j, w + 2)).join('|') + '|') + fin,
    ...corps.map(r => retrait + '| ' + r.map(remplir).join(' | ') + ' |' + fin),
  ]
  if (tb) {
    const iId = cles.indexOf('id'), dansDoc = new Set(doc.taches.map(t => t.id))
    const reprises = new Set(tb.orphelines.filter(l => dansDoc.has(l.cells[iId])).map(l => l.i))
    return [...tb.lignes.slice(0, tb.h), ...lignes, ...tb.lignes.slice(tb.fin + 1).filter((_, k) => !reprises.has(tb.fin + 1 + k))].join('\n')
  }
  if (texte != null) return texte.replace(/\n*$/, '\n\n') + lignes.join('\n') + '\n'
  return `# SUIVI — ${doc.plan}\n\n${lignes.join('\n')}\n\n${LEGENDE}\n`
}

// ─── Document ─────────────────────────────────────────────────────────────────────────────────────────────────────
const nouvelleTache = x => ({
  id: x.id, titre: x.titre || x.id, phase: x.phase, lot: x.lot ?? null, depend_de: x.depend_de ?? [], modele: x.modele ?? null, modele_utilise: null,
  statut: x.statut ?? 'à-faire', essais: x.essais ?? 0, branche: x.branche ?? null, estimation_tokens: x.estimation_tokens ?? null,
  tokens_reels: x.tokens_reels ?? null, ajoutee_par: x.ajoutee_par ?? null, etape: null, isole: null, debut: null, fin: null,
  attend: [], refus: [], instables: [], non_verifiables: [], blocage: [],
})
const docVide = (ctx, quand) => ({
  format: FORMAT, plan: ctx.nom, dossier: ctx.rel, integration: ctx.integration, base: ctx.base, maj: quand,
  taches: [], runs: [], points: [], decisions_office: [], relectures: [], prerequis: [], handoff: {}, lint: { ok: true, erreurs: [] }, journal: [], journal_omis: 0,
})
const noter = (doc, quand) => (genre, tache, texte) => doc.journal.push({ quand, genre, tache: tache ?? null, texte: court(texte, 300) })
const runEnCours = doc => doc.runs.filter(r => r.statut === 'en-cours').pop() || null
const tacheDe = (doc, id) => doc.taches.find(t => t.id === id) || refuser(`tâche inconnue du suivi : ${id}`)
const liste = (E, k) => (E[k] == null ? [] : Array.isArray(E[k]) ? E[k] : refuser(`entrée : « ${k} » doit être une liste`))

// Place une tâche : après la dernière tâche de phase inférieure ou égale ; une tâche ajoutée, après celle qui l'a fait naître
// et après celles que cette tâche a déjà fait naître (descendance comprise)
function inserer(doc, t, parent) {
  let pos = -1
  if (parent && doc.taches.some(x => x.id === parent)) {
    const desc = new Set([parent])
    for (let change = true; change;) { change = false; for (const x of doc.taches) if (x.ajoutee_par && desc.has(x.ajoutee_par) && !desc.has(x.id)) { desc.add(x.id); change = true } }
    doc.taches.forEach((x, i) => { if (desc.has(x.id)) pos = i })
  } else doc.taches.forEach((x, i) => { if (x.phase <= t.phase) pos = i })
  doc.taches.splice(pos + 1, 0, t)
}

// Champs de plan d'une tâche : plan-lint (frontmatter, amendements compris), plus lot_parallele et la présence de l'estimation
function champsPlan(ctx, lt) {
  const fm = frontmatter(ctx, lt.fichier)
  return {
    ...(Number.isInteger(lt.phase) && lt.phase >= 1 ? { phase: lt.phase } : {}),
    // Sans modèle dans le frontmatter : null (0.11.0) ; le workflow lance alors sonnet, puis l'échelle d'escalade
    modele: typeof lt.modele === 'string' && lt.modele.trim() ? lt.modele.trim() : null,
    depend_de: (lt.depend_de || []).map(String), lot: fm.lot, estimation_tokens: fm.estimation ? lt.estimation_tokens : null,
  }
}

// Champs de plan depuis plan-lint. Statuts aussi au début d'un run et à la reconstruction : git et SUIVI.md font foi
function synchroniser(doc, L, ctx, J, { statuts }) {
  if (!L.taches) return
  const parId = new Map(L.taches.map(t => [t.id, t]))
  let lignes = null
  const ligne = id => { lignes = lignes || new Map((essai(() => lireSuivi(lireOu(join(ctx.dir, 'SUIVI.md')))) || []).map(l => [l.id, l])); return lignes.get(id) }
  doc.taches = doc.taches.filter(t => parId.has(t.id) || (J('tache', t.id, `${t.id} retirée du suivi : aucun fichier de tâche dans ${ctx.rel}/taches/`), false))
  for (const lt of L.taches) {
    const plan = champsPlan(ctx, lt)
    let t = doc.taches.find(x => x.id === lt.id)
    if (!t) {
      if (!plan.phase) { J('erreur', null, `${lt.id} non ajoutée au suivi : phase absente du frontmatter`); continue }
      if (!STATUTS.includes(lt.statut)) refuser(`SUIVI.md : statut inconnu « ${lt.statut} » pour ${lt.id} (${STATUTS.join(', ')})`)
      const l = ligne(lt.id)
      t = nouvelleTache({ id: lt.id, titre: lt.titre, statut: lt.statut, ...(l ? { titre: l.titre, essais: l.essais, branche: l.branche, tokens_reels: l.tokens_reels } : {}), ...plan })
      inserer(doc, t, null)
      J('ajout', t.id, `${t.id} ajoutée au suivi depuis son fichier de tâche (phase ${t.phase})`)
      continue
    }
    Object.assign(t, plan)
    if (statuts && lt.statut !== t.statut) {
      if (!STATUTS.includes(lt.statut)) refuser(`SUIVI.md : statut inconnu « ${lt.statut} » pour ${lt.id} (${STATUTS.join(', ')})`)
      J('statut', t.id, `${t.id} : ${t.statut} → ${lt.statut} (SUIVI.md et git)`)
      t.statut = lt.statut
    }
  }
}

// Relectures de HANDOFF.md absentes du suivi (écrites par /orchestre:preparer, ou avant la perte de suivi.json)
function fusionnerRelectures(doc, handoff) {
  for (const r of lireHandoff(handoff).relectures) {
    if (doc.relectures.some(x => x.tache === r.tache && x.texte === r.texte)) continue
    doc.relectures.push({ tache: r.tache, phase: doc.taches.find(t => t.id === r.tache)?.phase ?? null, texte: r.texte, run: null, quand: null })
  }
}

// Champs dérivés, recalculés à chaque écriture et valables à la date maj
function deriver(doc, L, handoff) {
  if (Array.isArray(L.prerequis)) doc.prerequis = L.prerequis.filter(p => RE_ID.test(p.id)).map(p => ({ id: p.id, type: String(p.type ?? ''), statut: String(p.statut ?? ''), texte: String(p.texte ?? ''), bloque: p.bloque || [] }))
  doc.lint = { ok: !!L.ok, erreurs: (L.erreurs || []).map(String) }
  doc.handoff = lireHandoff(handoff).comptes
  const st = new Map(doc.taches.map(t => [t.id, t.statut]))
  for (const t of doc.taches) {
    t.attend = FAIT(t.statut) ? [] : [...t.depend_de.filter(d => !FAIT(st.get(d))), ...doc.prerequis.filter(p => p.statut === 'ouvert' && p.bloque.includes(t.id)).map(p => p.id)]
  }
}

function reconstruire(ctx, L, handoff, quand) {
  const doc = docVide(ctx, quand), J = noter(doc, quand)
  for (const l of lireSuivi(lireOu(join(ctx.dir, 'SUIVI.md'))) || []) doc.taches.push(nouvelleTache(l))
  synchroniser(doc, L, ctx, J, { statuts: true })
  fusionnerRelectures(doc, handoff)
  J('run', null, 'suivi.json reconstruit depuis SUIVI.md, HANDOFF.md et plan-lint : dates, étapes, refus et journal repartent vides')
  return doc
}

// orchestre-suivi/1 → /2 (0.11.0) : modele_utilise part de null (le modèle lancé n'était pas noté) ; modele garde sa valeur.
// Rend true si le document était en /1. Un autre format est refusé, sans deviner.
export function migrer(doc) {
  if (!doc || doc.format !== FORMAT_V1) return false
  doc.format = FORMAT
  for (const t of Array.isArray(doc.taches) ? doc.taches : []) if (t && typeof t === 'object' && !Array.isArray(t) && t.modele_utilise === undefined) t.modele_utilise = null
  return true
}
const formatLu = doc => { if (!doc || (doc.format !== FORMAT && doc.format !== FORMAT_V1)) refuser(`suivi.json est au format ${doc && doc.format}, ce lecteur lit ${FORMAT} et ${FORMAT_V1}`) }
const MIGRE = Symbol('migré de /1')

function charger(ctx) {
  const f = join(ctx.dir, 'suivi.json')
  if (!existsSync(f)) return null
  let doc
  try { doc = JSON.parse(readFileSync(f, 'utf8')) } catch (e) { refuser(`suivi.json illisible (${e.message}) : corrige-le, ou supprime-le pour qu'il soit reconstruit depuis SUIVI.md, HANDOFF.md et plan-lint`) }
  formatLu(doc)
  if (migrer(doc)) doc[MIGRE] = true
  return doc
}

// suivi.json et ses fichiers de travail hors de git : sinon un checkout « modifié » au pré-vol, ou un git switch bloqué
function ignorer(ctx) {
  const commun = essai(() => git(['rev-parse', '--git-common-dir'], ctx.racine).trim())
  if (!commun) return
  const ignore = p => essai(() => git(['check-ignore', '-q', p], ctx.racine)) != null
  const manquants = [['suivi.json', 'suivi.json'], ['.suivi.lock', '.suivi.lock'], ['.suivi.0.tmp', '.suivi.*.tmp']].filter(([ex]) => !ignore(`${ctx.rel}/${ex}`)).map(([, m]) => `/${ctx.rel}/${m}`)
  if (!manquants.length) return
  const f = join(resolve(ctx.racine, commun), 'info', 'exclude'), avant = lireOu(f) || ''
  mkdirSync(dirname(f), { recursive: true })
  appendFileSync(f, `${avant && !avant.endsWith('\n') ? '\n' : ''}# orchestre : suivi du plan ${ctx.rel}, hors git\n${manquants.join('\n')}\n`)
}

// Verrou : création exclusive ; un verrou dont le processus ne tourne plus, ou vieux d'une minute, est retiré
const dormir = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const vivant = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
function sousVerrou(ctx, fn) {
  const p = join(ctx.dir, '.suivi.lock'), limite = Date.now() + 20000
  for (;;) {
    try { const fd = openSync(p, 'wx'); writeSync(fd, `${process.pid}\n`); closeSync(fd); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const pid = Number((lireOu(p) || '').split('\n')[0]) || 0, age = essai(() => Date.now() - statSync(p).mtimeMs)
      if ((pid && !vivant(pid)) || (age != null && age > 60000)) { essai(() => unlinkSync(p)); continue }
      if (Date.now() > limite) refuser(`verrou ${ctx.rel}/.suivi.lock tenu par le processus ${pid || '?'} depuis plus de 20 s ; s'il ne tourne plus, supprime le fichier`)
      dormir(10 + Math.floor(Math.random() * 30))
    }
  }
  try { return fn() } finally { essai(() => unlinkSync(p)) }
}
// Fichier temporaire renommé : un lecteur ne voit jamais un fichier à moitié écrit
function ecrireFichier(ctx, nom, contenu) {
  const tmp = join(ctx.dir, `.suivi.${process.pid}.${nom === 'SUIVI.md' ? 'vue.' : ''}tmp`)
  try { writeFileSync(tmp, contenu); renameSync(tmp, join(ctx.dir, nom)) } finally { essai(() => unlinkSync(tmp)) }
}

const tronquer = doc => { const k = doc.journal.length - JOURNAL_MAX; if (k > 0) { doc.journal.splice(0, k); doc.journal_omis += k } }

// Une écriture : plan-lint et HANDOFF.md lus hors verrou, puis sous verrou : lecture, changement, dérivés, validation, écriture.
// changer(doc, outils) rend { vue: true } pour une transition durable : SUIVI.md régénéré, champs de plan relus.
function ecrire(ctx, changer, { debutRun = false } = {}) {
  const L = planLint(ctx), handoff = lireOu(join(ctx.dir, 'HANDOFF.md')) || ''
  return sousVerrou(ctx, () => {
    const quand = maintenant()
    const existant = charger(ctx)
    if (!existant && !L.taches) refuser(`${L.erreurs[0]} : suivi.json absent, il ne se reconstruit pas sans plan-lint ; rien n'est écrit`)
    const doc = existant || reconstruire(ctx, L, handoff, quand)
    const J = noter(doc, quand)
    if (existant && existant[MIGRE]) J('run', null, `suivi.json migré de ${FORMAT_V1} à ${FORMAT} : modèle utilisé inconnu jusqu'ici`)
    if (!L.taches) { const note = `${L.erreurs[0]} : champs de plan, statuts de git et prérequis gardés tels quels`; if (!doc.journal.slice(-20).some(e => e.texte === court(note, 300))) J('erreur', null, note) }
    if (!existant || debutRun) ignorer(ctx)
    const r = changer(doc, { L, handoff, quand, J, ctx }) || {}
    if (r.vue && existant) synchroniser(doc, L, ctx, J, { statuts: false })
    deriver(doc, L, handoff)
    doc.maj = quand
    tronquer(doc)
    const err = valider(doc)
    if (err.length) refuser(`écriture refusée, suivi.json inchangé :\n${err.slice(0, 12).map(e => '  - ' + e).join('\n')}${err.length > 12 ? `\n  - … ${err.length - 12} de plus` : ''}`)
    const texteVue = r.vue ? vue(doc, lireOu(join(ctx.dir, 'SUIVI.md'))) : null
    ecrireFichier(ctx, 'suivi.json', JSON.stringify(doc, null, 2) + '\n')
    if (texteVue != null) ecrireFichier(ctx, 'SUIVI.md', texteVue)
    return { doc, ...r }
  })
}

// ─── Commandes d'écriture ─────────────────────────────────────────────────────────────────────────────────────────
function debutRun(doc, E, { L, handoff, J, quand, ctx }) {
  for (const r of doc.runs.filter(r => r.statut === 'en-cours')) { r.statut = 'interrompu'; J('run', null, `run ${r.numero} interrompu : resté en cours, sans fin de run`) }
  for (const t of doc.taches.filter(t => t.etape)) { J('etape', t.id, `${t.id} : étape « ${t.etape} » interrompue avec son run`); t.etape = null }
  synchroniser(doc, L, ctx, J, { statuts: true })
  fusionnerRelectures(doc, handoff)
  const numero = (doc.runs.length ? doc.runs[doc.runs.length - 1].numero : 0) + 1
  doc.runs.push({
    numero, run_id: E.run_id ?? null, phase: E.phase, mode: E.mode, parallelisme: E.parallelisme, corrections_max: E.corrections_max, decisions_office_max: E.decisions_office_max,
    statut: 'en-cours', debut: quand, fin: null, detail: null, arbitrages_appliques: [], amendements_ecartes: [], taches_ajoutees: [], reportees: [], non_lancees: [], en_attente: [], en_attente_prerequis: [],
  })
  J('run', null, `run ${numero} : phase ${E.phase}, mode ${E.mode}, ${E.parallelisme} en parallèle`)
  return { message: `run ${numero} ouvert (phase ${E.phase}, mode ${E.mode})` }
}

// Modèle lancé par le worker ou une correction (0.11.0), et le changement de modèle que le workflow a décidé
const texteOuNull = (x, champ) => (x == null ? null : typeof x === 'string' && x.trim() ? x.trim() : refuser(`etape : « ${champ} » doit être un texte non vide`))
function changementDe(E, modele) {
  const c = E.changement
  if (c == null) return null
  if (typeof c !== 'object' || Array.isArray(c)) refuser('etape : « changement » doit être un objet { de, vers, raison }')
  const vers = texteOuNull(c.vers, 'changement.vers') ?? modele
  if (!vers) refuser('etape : changement sans modèle d\'arrivée (changement.vers ou modele)')
  if (modele && vers !== modele) refuser(`etape : changement vers ${vers}, mais modele vaut ${modele}`)
  return { de: texteOuNull(c.de, 'changement.de'), vers, raison: c.raison == null ? '' : String(c.raison).replace(/\s+/g, ' ').trim() }
}
function etape(doc, E, { J, quand }) {
  const t = tacheDe(doc, E.tache)
  const modele = texteOuNull(E.modele, 'modele'), ch = changementDe(E, modele)
  if (E.isole !== undefined) t.isole = E.isole
  if (E.etape === 'worker') {
    Object.assign(t, { etape: 'worker', debut: quand, fin: null, essais: 1, refus: [], instables: [], non_verifiables: [], blocage: [], modele_utilise: ch ? ch.vers : modele })
    J('tache', t.id, `${t.id} démarre (${t.isole === true ? 'worktree' : t.isole === false ? 'checkout principal' : 'lieu non précisé'})`)
    if (ch) J('modele', t.id, `${t.id} : ${ch.de ?? '—'} → ${ch.vers}${ch.raison ? ` (${ch.raison})` : ''}`)
  } else {
    t.etape = E.etape
    if (E.etape === 'correction' && E.refus) {
      t.refus.push(E.refus)
      if (Number.isInteger(E.refus.essai)) t.essais = Math.max(t.essais, E.refus.essai + 1)
      J('refus', t.id, `${t.id} : essai ${E.refus.essai} refusé (${E.refus.par}) : ${(E.refus.manques || []).length} manque(s)`)
    }
    if (modele || ch) t.modele_utilise = ch ? ch.vers : modele
    if (ch) J('modele', t.id, `${t.id} : ${ch.de ?? '—'} → ${ch.vers}${ch.raison ? ` (${ch.raison})` : ''}`)
    J('etape', t.id, `${t.id} : ${E.etape}${E.etape === 'correction' ? ` (essai ${t.essais})` : ''}`)
  }
  return { message: `${t.id} → ${E.etape}${t.modele_utilise && (modele || ch) ? ` (${t.modele_utilise})` : ''}` }
}

const optionSansActions = o => ({ id: o.id, description: o.description ?? '', ...(o.impact !== undefined ? { impact: o.impact } : {}), ...(o.recommande !== undefined ? { recommande: o.recommande } : {}) })
const pointDe = (p, run, tache, role) => ({
  run, tache: p.tache ?? tache, titre: p.titre, contexte: p.contexte ?? '', humain: !!p.humain, role: p.role ?? role, statut: 'ouvert', option_choisie: null,
  options: (p.options || []).map(optionSansActions), ...(p.coupe_circuit ? { coupe_circuit: true } : {}), ...(p.incoherence ? { incoherence: p.incoherence } : {}),
})
const numeroRun = doc => runEnCours(doc)?.numero ?? refuser('aucun run en cours : lance d\'abord debut-run')

// Tâches créées par une clôture ou un arbitrage : le fichier de tâche existe déjà (le scribe l'a écrit), plan-lint le lit.
// Rappelée pour une tâche déjà là (scribe relancé, suivi reconstruit), elle n'est pas dupliquée.
function ajouter(doc, items, parent, { L, J, ctx }) {
  const run = runEnCours(doc), sautees = []
  for (const x of items) {
    if (!x || !RE_ID.test(x.id || '')) refuser(`tâche ajoutée sans identifiant valide : ${JSON.stringify(x)}`)
    const lt = (L.taches || []).find(t => t.id === x.id)
    // Sans fichier de tâche (le scribe l'a retiré sur un refus de plan-lint, et le signale de son côté) : sautée, notée au journal.
    // Refuser toute l'écriture ferait perdre la clôture de la tâche qui l'a proposée.
    // Sans fichier, seule une tâche que l'appelant décrit en entier (phase et modèle) entre : ni le workflow ni le bilan ne le font
    if (!lt && !(x.phase && x.modele)) { J('erreur', x.id, `${x.id} non ajoutée au suivi : aucun fichier de tâche lu par plan-lint (ajout proposé par ${parent ?? 'le bilan du run'})`); sautees.push(x.id); continue }
    const plan = lt ? champsPlan(ctx, lt) : { phase: x.phase, modele: x.modele, depend_de: x.depend_de ?? [], lot: x.lot ?? null, estimation_tokens: x.estimation_tokens ?? null }
    let t = doc.taches.find(y => y.id === x.id)
    if (!t) t = nouvelleTache({ id: x.id, titre: x.titre, statut: 'ajoutée', ...plan })
    else if (t.ajoutee_par !== parent) doc.taches.splice(doc.taches.indexOf(t), 1)
    if (!doc.taches.includes(t)) { t.ajoutee_par = parent; inserer(doc, t, parent) }
    Object.assign(t, plan, { titre: x.titre || t.titre })
    if (t.statut === 'à-faire') t.statut = 'ajoutée'
    if (run && !run.taches_ajoutees.some(y => y.id === t.id)) run.taches_ajoutees.push({ id: t.id, phase: t.phase, titre: t.titre })
    J('ajout', t.id, `${t.id} ajoutée par ${parent ?? 'le bilan du run'} (phase ${t.phase}) : ${t.titre}`)
  }
  return sautees
}
const sans = ids => (ids.length ? ` ; non ajoutée${ids.length > 1 ? 's' : ''}, sans fichier de tâche : ${ids.join(', ')}` : '')
const noterAmendements = (E, J, tache) => {
  for (const a of liste(E, 'amendements')) J('amendement', a.id ?? null, `${a.id} amendée après ${tache} : ${a.raison ?? 'sans raison'}`)
}

function cloture(doc, E, outils) {
  const { J, quand } = outils
  const t = tacheDe(doc, E.tache)
  if (!CLOTURES.includes(E.statut)) refuser(`cloture : statut « ${E.statut} » non permis (${CLOTURES.join(', ')})`)
  const nrun = () => numeroRun(doc)
  if (E.replanification) J('etape', t.id, `${t.id} : replanification terminée`)
  Object.assign(t, {
    statut: E.statut, essais: E.essais ?? t.essais, branche: E.branche !== undefined ? E.branche : t.branche,
    tokens_reels: E.tokens_reels !== undefined ? E.tokens_reels : 'voir /workflows', fin: quand, etape: null,
    refus: E.refus ?? t.refus, instables: E.instables ?? t.instables, non_verifiables: E.non_verifiables ?? t.non_verifiables,
    blocage: E.blocage ?? (E.statut === 'fusionnée' ? [] : t.blocage),
  })
  J('statut', t.id, `${t.id} : ${E.statut} (${t.essais} essai${t.essais > 1 ? 's' : ''})${t.blocage.length ? ' — ' + t.blocage[0] : ''}`)
  for (const r of liste(E, 'relectures')) {
    const texte = typeof r === 'string' ? r : r && (r.texte ?? r.relecture)
    if (doc.relectures.some(x => x.tache === t.id && x.texte === texte)) continue
    doc.relectures.push({ tache: t.id, phase: t.phase, texte, run: runEnCours(doc)?.numero ?? null, quand })
    J('relecture', t.id, `${t.id} : relecture avant la PR — ${texte}`)
  }
  for (const d of liste(E, 'decisions_office')) {
    doc.decisions_office.push({ run: nrun(), tache: d.tache ?? t.id, titre: d.titre, option: d.option, description: d.description })
    J('decision-office', t.id, `${t.id} : « ${d.titre} », option ${d.option} prise d'office`)
  }
  for (const p of liste(E, 'points')) {
    doc.points.push(pointDe(p, nrun(), t.id, 'a-trancher'))
    J('point', t.id, `${t.id} : point « ${p.titre} »${p.humain ? ' (humain)' : ''}`)
  }
  const sautees = ajouter(doc, liste(E, 'taches_ajoutees'), t.id, outils)
  noterAmendements(E, J, t.id)
  return { vue: true, message: `${t.id} ${E.statut} ; SUIVI.md régénéré${sans(sautees)}` }
}

function arbitrage(doc, E, outils) {
  const { J } = outils
  const t = tacheDe(doc, E.tache)
  const option = E.option && typeof E.option === 'object' ? E.option.id : E.option
  if (!option || !E.titre) refuser('arbitrage : tache, titre et option attendus')
  const p = doc.points.filter(x => x.tache === t.id && x.titre === E.titre && x.statut === 'ouvert').pop()
  if (p) Object.assign(p, { statut: 'tranché', option_choisie: String(option) })
  J('arbitrage', t.id, `${t.id} : « ${E.titre} » tranché, option ${option}${p ? '' : ' (point absent du suivi)'}`)
  const run = runEnCours(doc)
  if (run && !run.arbitrages_appliques.some(a => a.tache === t.id && a.titre === E.titre && a.option === String(option))) run.arbitrages_appliques.push({ tache: t.id, titre: E.titre, option: String(option) })
  for (const a of liste(E, 'amendements_ecartes')) {
    if (run) run.amendements_ecartes.push({ tache: t.id, id: a.id, raison: a.raison ?? '' })
    J('amendement', a.id ?? null, `amendement de ${a.id} écarté (${t.id}) : ${a.raison ?? 'sans raison'}`)
  }
  const sautees = ajouter(doc, liste(E, 'taches_ajoutees'), t.id, outils)
  noterAmendements(E, J, t.id)
  return { vue: true, message: `arbitrage ${t.id} option ${option} ; SUIVI.md régénéré${sans(sautees)}` }
}

function finRun(doc, E, outils) {
  const { J, quand } = outils
  const run = runEnCours(doc) || refuser('aucun run en cours : lance d\'abord debut-run')
  if (!FINS_DE_RUN.includes(E.statut)) refuser(`fin-run : statut « ${E.statut} » inconnu (${FINS_DE_RUN.join(', ')})`)
  run.statut = E.statut
  run.fin = quand
  run.detail = E.detail == null ? null : Array.isArray(E.detail) ? E.detail.map(String).join(' ; ') : String(E.detail)
  // Listes du bilan (E:356-360) : elles font foi pour ce run
  const ids = k => liste(E, k).map(x => (typeof x === 'string' ? x : x && x.id))
  if (E.arbitrages_appliques) run.arbitrages_appliques = liste(E, 'arbitrages_appliques').map(a => ({ tache: a.tache, titre: a.titre, option: String(a.option && typeof a.option === 'object' ? a.option.id : a.option) }))
  if (E.amendements_ecartes) run.amendements_ecartes = liste(E, 'amendements_ecartes').map(a => ({ tache: a.tache, id: a.id, raison: a.raison ?? '' }))
  // Tâches ajoutées : le bilan ne connaît pas celles des arbitrages, déjà notées par la commande arbitrage ; on complète sans retirer.
  // Une tâche du bilan absente du suivi (clôture non écrite) y entre, avec la tâche qui l'a créée si le bilan la donne.
  let vueAFaire = false
  for (const x of liste(E, 'taches_ajoutees')) {
    if (!x || !RE_ID.test(x.id || '')) continue
    if (!doc.taches.some(t => t.id === x.id)) { const avant = doc.taches.length; ajouter(doc, [x], RE_ID.test(x.ajoutee_par || '') ? x.ajoutee_par : null, outils); vueAFaire ||= doc.taches.length > avant }
    if (!run.taches_ajoutees.some(y => y.id === x.id)) run.taches_ajoutees.push({ id: x.id, phase: x.phase, titre: x.titre })
  }
  for (const k of ['reportees', 'non_lancees', 'en_attente']) if (E[k]) run[k] = ids(k)
  if (E.en_attente_prerequis) run.en_attente_prerequis = liste(E, 'en_attente_prerequis').map(x => ({ id: x.id, prerequis: x.prerequis || [] }))
  for (const d of liste(E, 'decisions_office')) {
    if (doc.decisions_office.some(x => x.run === run.numero && x.tache === d.tache && x.titre === d.titre && x.option === d.option)) continue
    doc.decisions_office.push({ run: run.numero, tache: d.tache, titre: d.titre, option: d.option, description: d.description })
    J('decision-office', d.tache, `${d.tache} : « ${d.titre} », option ${d.option} prise d'office`)
  }
  // Points du bilan : le point d'arrêt et les points à trancher, rapprochés de ceux que le scribe a déjà notés
  for (const [p, role] of [...(E.arbitrage ? [[E.arbitrage, 'arret']] : []), ...liste(E, 'points_a_trancher').map(p => [p, 'a-trancher'])]) {
    const deja = doc.points.find(x => x.run === run.numero && x.tache === p.tache && x.titre === p.titre)
    if (deja) { deja.role = role; continue }
    doc.points.push(pointDe(p, run.numero, p.tache, role))
    J('point', p.tache, `${p.tache} : point « ${p.titre} »${role === 'arret' ? ", qui arrête le run" : ''}`)
  }
  // Exception du workflow (E:316) : une tâche du bilan sans clôture dans ce run est close ici, d'après le bilan
  const debut = Date.parse(run.debut)
  for (const r of liste(E, 'taches')) {
    const t = doc.taches.find(x => x.id === r.id)
    if (!t || !r.statut || !(t.etape || !t.fin || Date.parse(t.fin) < debut)) continue
    Object.assign(t, { statut: r.statut, essais: r.essais ?? t.essais, branche: r.branche !== undefined ? r.branche : t.branche, blocage: r.blocage ?? [], fin: quand, etape: null })
    J('statut', t.id, `${t.id} : ${r.statut}, clos en fin de run sans scribe${t.blocage.length ? ' — ' + t.blocage[0] : ''}`)
    vueAFaire = true
  }
  for (const t of doc.taches.filter(t => t.etape)) { J('etape', t.id, `${t.id} : étape « ${t.etape} » sans clôture à la fin du run`); t.etape = null }
  J(E.statut === 'erreur' ? 'erreur' : 'run', null, `run ${run.numero} : ${E.statut}${run.detail ? ' — ' + run.detail : ''}`)
  return { vue: vueAFaire, message: `run ${run.numero} ${E.statut}${vueAFaire ? ' ; SUIVI.md régénéré, à commiter' : ''}` }
}

function pilote(doc, E, { J, quand }) {
  const t = tacheDe(doc, E.tache)
  if (!['fusionnée', 'annulée'].includes(E.statut)) refuser(`pilote : statut « ${E.statut} » non permis (fusionnée ou annulée)`)
  Object.assign(t, { statut: E.statut, etape: null, ...(E.statut === 'fusionnée' ? { fin: quand, blocage: [] } : {}) })
  J('pilote', t.id, `${t.id} : ${E.statut} par le pilote${E.raison ? ' — ' + E.raison : ''}`)
  return { vue: true, message: `${t.id} ${E.statut} ; SUIVI.md régénéré, à commiter` }
}

// ─── Lecture : état du plan, comme etat.mjs (0.6.3), avec l'étape en cours quand un run tourne ──────────────────────
const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`
const barre = (r, n) => { const k = Math.floor(r * n); return '█'.repeat(k) + '░'.repeat(n - k) }
const pct = (f, n) => Math.floor((100 * f) / n)
const depuis = ts => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts))
  return s < 60 ? "à l'instant" : s < 3600 ? `il y a ${Math.floor(s / 60)} min` : s < 86400 ? `il y a ${Math.floor(s / 3600)} h` : `il y a ${Math.floor(s / 86400)} j`
}
const raccourcir = (xs, max) => (xs.length > max ? [...xs.slice(0, max - 1), `+${xs.length - max + 1}`] : xs)

function etat(arg) {
  let ctx
  try { ctx = localiser(arg) } catch (e) { return `orchestre:etat : ${e.message}` }
  const { racine, dir, nom, integration: integ } = ctx
  const L = planLint(ctx)
  if (!L.taches) return `orchestre:etat : ${L.erreurs[0]}`
  const handoff = lireOu(join(dir, 'HANDOFF.md')) || ''
  // suivi.json s'il existe, sinon sa reconstruction en mémoire ; rien n'est écrit
  let doc = null, note = null
  try { doc = charger(ctx) || reconstruire(ctx, L, handoff, maintenant()) } catch (e) { note = `suivi.json : ${e.message.split('\n')[0]}` }
  const S = new Map((doc ? doc.taches : []).map(t => [t.id, t]))
  const run = doc ? runEnCours(doc) : null
  // git fait foi pour « fusionnée » ; sinon le suivi, plus frais que SUIVI.md pendant un run
  const statut = t => (t.statut === 'fusionnée' ? 'fusionnée' : S.get(t.id)?.statut ?? t.statut)
  const actives = L.taches.map(t => ({ ...t, statut: statut(t) })).filter(t => t.statut !== 'annulée')
  if (!actives.length) return `orchestre:etat : aucune tâche dans ${ctx.rel}`
  const fait = t => t.statut === 'fusionnée'
  const ATTENTION = { 'besoin-humain': 'attend un humain', bloquée: 'bloquée', échec: 'en échec' }
  const enEtape = t => run && S.get(t.id)?.etape

  const refs = (essai(() => git(['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads/tache/'], racine)) || '')
    .split('\n').filter(Boolean).map(l => { const [r, ts] = l.split('\t'); return { ref: r, ts: Number(ts), id: r.replace(/^tache\//, '').replace(/-r\d+$/, '') } })
  const tete = essai(() => git(['symbolic-ref', '-q', '--short', 'HEAD'], racine).trim()) || ''
  const worktrees = new Set((essai(() => git(['worktree', 'list', '--porcelain'], racine)) || '').split(/\n\s*\n/).slice(1).map(b => (b.match(/^branch refs\/heads\/(.+)$/m) || [])[1]).filter(Boolean))
  const enCours = []
  for (const t of actives) {
    if (fait(t)) continue
    const s = S.get(t.id)
    if (enEtape(t)) {
      enCours.push({ id: t.id, texte: `${t.id} (${[s.etape, s.isole === true ? 'worktree' : s.isole === false ? 'checkout' : null, s.debut ? `démarrée ${depuis(Date.parse(s.debut) / 1000)}` : null].filter(Boolean).join(', ')})` })
      continue
    }
    if (ATTENTION[t.statut]) continue
    const b = refs.filter(x => x.id === t.id).sort((x, y) => y.ts - x.ts)[0]
    if (!b) continue
    const avance = Number(essai(() => git(['rev-list', '--count', `${integ}..${b.ref}`], racine).trim()) || 0)
    const ou = b.ref === tete ? 'checkout' : worktrees.has(b.ref) ? 'worktree' : null
    enCours.push({ id: t.id, texte: `${t.id} (${[ou, avance ? `dernier commit ${depuis(b.ts)}` : 'démarrée'].filter(Boolean).join(', ')})` })
  }

  const existe = b => essai(() => git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], racine)) != null
  const base = ctx.base || ['main', 'master'].find(existe)
  const log = essai(() => git(['log', '--format=%ct%x09%s', base && base !== integ ? `${base}..${integ}` : integ, '--'], racine)) || ''
  const fusion = log.split('\n').map(l => l.split('\t')).find(([, s]) => /^tâche \S+ :/.test(s || ''))

  const aToi = []
  for (const p of (L.prerequis || []).filter(x => x.statut === 'ouvert' && (x.bloque || []).length)) aToi.push(`${p.id} (${p.type}) bloque ${raccourcir(p.bloque, 4).join(', ')}`)
  for (const [st, quoi] of Object.entries(ATTENTION)) for (const t of actives.filter(x => x.statut === st && !enEtape(x))) aToi.push(`${t.id} ${quoi}`)
  const comptes = lireHandoff(handoff).comptes
  const nb = type => Object.values(comptes).reduce((n, c) => n + (c[type] ? c[type].mineur + c[type].majeur : 0), 0)
  const rel = nb('relecture'), tic = nb('ticket')
  if (rel) aToi.push(`${pluriel(rel, 'relecture')} avant la PR`)
  if (tic) aToi.push(`${pluriel(tic, 'ticket')} après la PR`)
  if (!L.ok) aToi.push(`plan-lint : ${pluriel((L.erreurs || []).length, 'erreur')}`)
  if (note) aToi.push(note)

  const phases = [...new Set(actives.map(t => t.phase))].sort((a, b) => a - b)
  const commencee = ph => actives.some(t => t.phase === ph && (fait(t) || enCours.some(e => e.id === t.id)))
  const courante = phases.find(ph => actives.some(t => t.phase === ph && !fait(t)))
  const faites = actives.filter(fait).length
  const out = [
    `## ${nom} — ${faites}/${pluriel(actives.length, 'tâche')} · ${pct(faites, actives.length)} %`,
    `\`${barre(faites / actives.length, 24)}\` ${courante == null ? 'plan terminé' : `phase ${courante} ${commencee(courante) ? 'en cours' : 'à lancer'}`}${fusion ? ` · dernière fusion ${fusion[1].match(/^tâche (\S+) :/)[1]} ${depuis(Number(fusion[0]))}` : ''}${run ? ` · run ${run.numero} (${run.mode}) ouvert ${depuis(Date.parse(run.debut) / 1000)}` : ''}`,
    '',
    '| Phase | Avancement | Tâches |',
    '| :-- | :-- | :-- |',
  ]
  for (const ph of phases) {
    const ts = actives.filter(t => t.phase === ph), f = ts.filter(fait).length
    const sym = f === ts.length ? '✓' : ts.some(t => ATTENTION[t.statut] && !enEtape(t)) ? '⚠' : commencee(ph) ? '●' : '○'
    out.push(`| ${sym} ${ph} | \`${barre(f / ts.length, 10)}\` ${pct(f, ts.length)} % | ${f}/${ts.length} |`)
  }
  if (enCours.length) out.push('', `**En cours** : ${raccourcir(enCours.map(e => e.texte), 5).join(' · ')}`)
  out.push('', `**À toi** : ${aToi.length ? raccourcir(aToi, 6).join(' · ') : "rien pour l'instant"}`)
  return out.join('\n')
}

// ─── Entrée ──────────────────────────────────────────────────────────────────────────────────────────────────────
// L'objet de --json s'il est donné, sinon l'entrée standard
function entree(json) {
  const source = json != null ? '--json' : 'entrée standard'
  if (json == null && process.stdin.isTTY) throw new Usage('objet JSON attendu sur l\'entrée standard ou dans --json')
  const brut = json != null ? json : essai(() => readFileSync(0, 'utf8')) || ''
  if (!brut.trim()) throw new Usage(`objet JSON attendu sur l'entrée standard ou dans --json`)
  let E
  try { E = JSON.parse(brut) } catch (e) { throw new Usage(`${source} : JSON invalide (${e.message})`) }
  if (!E || typeof E !== 'object' || Array.isArray(E)) throw new Usage(`${source} : un objet JSON est attendu`)
  return E
}

const ECRITURES = { 'debut-run': debutRun, etape, cloture, arbitrage, 'fin-run': finRun, pilote }
const USAGE = 'usage : suivi.mjs <debut-run|etape|cloture|arbitrage|fin-run|pilote|vue|etat|valider> [<dossier-plan>] [--stdout] [--fichier <suivi.json>] [--json <objet>] ; pour les écritures, JSON dans --json ou sur l\'entrée standard'

function principal() {
  const argv = process.argv.slice(2), cmd = argv[0]
  const fi = argv.indexOf('--fichier'), fichier = fi >= 0 ? argv[fi + 1] : null
  const ji = argv.indexOf('--json')
  if (ji >= 0 && ji + 1 >= argv.length) throw new Usage('--json : objet JSON attendu après l\'option')
  const json = ji >= 0 ? argv[ji + 1] : null
  const arg = argv.slice(1).find((a, i, xs) => !a.startsWith('--') && xs[i - 1] !== '--fichier' && xs[i - 1] !== '--json')
  if (cmd === 'etat') {
    let texte
    try { texte = etat(arg) } catch (e) { texte = `orchestre:etat : ${String((e && e.message) || e).split('\n')[0]}` }
    console.log(texte)
    return 0
  }
  if (cmd === 'valider') {
    const f = fichier ? resolve(fichier) : join(localiser(arg).dir, 'suivi.json')
    if (!existsSync(f)) refuser(`${f} : absent ; il sera reconstruit à la prochaine écriture`)
    let doc
    try { doc = JSON.parse(readFileSync(f, 'utf8')) } catch (e) { refuser(`suivi.json illisible : ${e.message}`) }
    formatLu(doc)
    // Un fichier /1 est validé tel qu'il sera migré : le schéma /2 avec modele_utilise à null
    const v1 = migrer(doc)
    const err = valider(doc)
    if (err.length) refuser(`suivi.json invalide :\n${err.map(e => '  - ' + e).join('\n')}`)
    console.log(`suivi : suivi.json valide (${v1 ? `${FORMAT_V1}, migré en ${FORMAT} à la prochaine écriture` : FORMAT}, ${pluriel(doc.taches.length, 'tâche')}, ${pluriel(doc.runs.length, 'run')})`)
    return 0
  }
  if (cmd === 'vue') {
    const ctx = localiser(arg)
    if (argv.includes('--stdout')) {
      const L = planLint(ctx), handoff = lireOu(join(ctx.dir, 'HANDOFF.md')) || '', quand = maintenant()
      const existant = charger(ctx)
      if (!existant && !L.taches) throw new Refus(`${L.erreurs[0]} : suivi.json absent, il ne se reconstruit pas sans plan-lint`)
      const doc = existant || reconstruire(ctx, L, handoff, quand)
      if (existant) synchroniser(doc, L, ctx, noter(doc, quand), { statuts: true })
      deriver(doc, L, handoff)
      process.stdout.write(vue(doc, lireOu(join(ctx.dir, 'SUIVI.md'))))
      return 0
    }
    // Entre deux runs (pré-vol de /orchestre:lancer) : SUIVI.md et git font foi pour les statuts, comme au début d'un run
    // (une tâche fusionnée à la main sans « suivi.mjs pilote » passe à « fusionnée »)
    const r = ecrire(ctx, (doc, { L, ctx: c, J }) => { synchroniser(doc, L, c, J, { statuts: true }); return { vue: true } })
    console.log(`suivi : SUIVI.md régénéré (${pluriel(r.doc.taches.length, 'tâche')})`)
    return 0
  }
  const changer = ECRITURES[cmd]
  if (!changer) throw new Usage(USAGE)
  const ctx = localiser(arg), E = entree(json)
  const r = ecrire(ctx, (doc, outils) => changer(doc, E, outils), { debutRun: cmd === 'debut-run' })
  console.log(`suivi : ${r.message}`)
  return 0
}

const lance = process.argv[1] && reel(process.argv[1]) === reel(fileURLToPath(import.meta.url))
if (lance) {
  try { process.exitCode = principal() } catch (e) {
    if (e instanceof Refus || e instanceof Usage) { console.error(`suivi : ${e.message}`); process.exitCode = e.code } else { console.error(`suivi : erreur inattendue, rien n'est écrit : ${(e && e.stack) || e}`); process.exitCode = 1 }
  }
}
