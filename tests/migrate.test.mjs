// Tests of migrate.mjs: a plan written and run by orchestre 0.11.0 (its real scripts, taken from git at dd14f89), converted to the
// format of 0.12, then read by the 0.12 scripts. In temporary git repositories.
// Usage: node tests/migrate.test.mjs [path of migrate.mjs]
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, chmodSync, symlinkSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MIGRATE = resolve(process.argv[2] || 'plugins/orchestre/scripts/migrate.mjs')
const SCRIPTS = dirname(MIGRATE)
const { LEGACY } = await import(join(SCRIPTS, 'progress.mjs'))
const { convertProgress } = await import(MIGRATE)
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporaries = []
const temp = p => { const d = mkdtempSync(join(tmpdir(), p)); temporaries.push(d); return d }
let n = 0
const test = (name, fn) => { fn(); n++; console.log('ok ·', name) }

// The scripts of orchestre 0.11.0, as they wrote plans in French
const OLD = temp('orchestre-0.11-')
for (const f of ['suivi.mjs', 'plan-lint.mjs']) {
  let text
  try { text = execFileSync('git', ['show', `dd14f89:plugins/orchestre/scripts/${f}`], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch { throw new Error(`these tests need the git history of orchestre 0.11.0 (commit dd14f89) to read scripts/${f}`) }
  writeFileSync(join(OLD, f), text)
}

// A plan as /orchestre:preparer 0.11 wrote it (format.md of 0.11)
const frTask = (id, { phase = 1, depend_de = '[]', prerequis = null } = {}) => `---
id: ${id}
titre: Tâche ${id}
phase: ${phase}
modele: sonnet          # haiku | sonnet | opus
raison_modele: "implémentation courante"
effort: high
depend_de: ${depend_de}
lot_parallele: ${phase}A
fichiers_possedes:
  - src/${id}/**
ressources: []
${prerequis ? `prerequis: ${prerequis}\n` : ''}budget_contexte: 40%
estimation_tokens: "1,0 M"
max_tours: 60
verification:
  - "npm test"
definition_du_fini:
  - "le test passe"
---

## Prompt de lancement
Tu réalises ${id} sur la branche tache/${id}. Lis d'abord DISCOVERY.md,
puis les fichiers listés dans Contexte utile.
Ne modifie rien hors de fichiers_possedes.

## Contexte utile
- src/${id}/index.ts : le point d'entrée.
## Détail de réalisation
Écris le module, puis son test.
## Hors périmètre
La documentation.
`
const FR = {
  'SUIVI.md': `# SUIVI — boutique

| ID  | Titre     | Phase | Lot | Dépend de | Modèle | Statut  | Essais | Branche | Tokens est. / réels |
|-----|-----------|-------|-----|-----------|--------|---------|--------|---------|---------------------|
| T01 | Tâche T01 | 1     | 1A  | —         | sonnet | à-faire | 0      | —       | 1,0 M / —           |
| T02 | Tâche T02 | 1     | 1A  | T01       | sonnet | à-faire | 0      | —       | 1,0 M / —           |
| T03 | Tâche T03 | 2     | 2A  | T02       | sonnet | à-faire | 0      | —       | 1,0 M / —           |

Statuts : à-faire · ajoutée · fusionnée · bloquée · échec · besoin-humain · annulée

## Notes du pilote

Rien à signaler.
`,
  'PREREQUIS.md': `# PREREQUIS — boutique

| ID | Type | Prérequis | Statut | Preuve |
|----|------|-----------|--------|--------|
| D5 | décision | Choisir le fournisseur de paiement | ouvert | — |
| H1 | Geste | Clé d'API dans \`.env\` \\| sandbox | fait | confirmé par Fabien le 30/09 |
| E1 | environnement | Base de test démarrée | abandonné | plus utile |

Types : décision · geste · environnement. Statuts : ouvert · fait · abandonné.
Vérifié par /orchestre:pret le 10/10 : phase 1 prête, phase 2 attend D5
`,
  'HANDOFF.md': `# HANDOFF — boutique
Entrées : \`écart\`, \`angle-mort\`, \`décision\`, \`dette\`, \`besoin-humain\`, \`ticket\`, \`relecture\`, classées \`mineur\` ou \`majeur\`.

## plan source

décision · majeur · D4 : paiement en une fois (tranchée par l'utilisateur)
relecture · majeur · .env.example : vérifier SESSION_SECRET avant la PR

## T01

- écart · mineur · le test e2e attend 2 s de plus
- angle-mort · majeur · le cas « panier vide » n'est pas vérifiable
`,
  'DISCOVERY.md': `# DISCOVERY — boutique
## Contexte existant
Une boutique Next.js.
## Commandes vérifiées
- \`npm test\` : vert.
## Carte rapide
## Conventions constatées
## Pièges et solutions
## Recommandations de contexte (fin de run)
`,
  'orchestre.config.json': JSON.stringify({ parallelisme_max: 4, mode_par_defaut: 'devia', branche_integration: 'plan/boutique', branche_base: 'main', evaluateur: 'systematique', corrections_max: 2, escalade: ['sonnet', 'opus'], fable: false, decisions_office_max: 3, plafond_session_pilote: 0.65, preparation: ['npm ci'], preparation_partagee: { db: ['npm run db:test'] } }, null, 2) + '\n',
}

function repo() {
  const root = temp('migrate-')
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'README.md'), 'x\n'); git('add', '.'); git('commit', '-qm', 'init')
  const d = join(root, 'plans', 'boutique')
  mkdirSync(join(d, 'taches'), { recursive: true })
  writeFileSync(join(d, 'taches', 'T01-panier.md'), frTask('T01'))
  writeFileSync(join(d, 'taches', 'T02-paiement.md'), frTask('T02', { depend_de: '[T01]', prerequis: '[D5]' }))
  writeFileSync(join(d, 'taches', 'T03-recette.md'), frTask('T03', { phase: 2, depend_de: '[T02]' }))
  for (const [f, text] of Object.entries(FR)) writeFileSync(join(d, f), text)
  git('switch', '-qc', 'plan/boutique'); git('add', '.'); git('commit', '-qm', 'plan boutique')
  const run = (script, args, input, env = {}, cwd = root) => { const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', input, env: { ...process.env, ...env } }); return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() } }
  return {
    root, git, d, read: f => readFileSync(join(d, f), 'utf8'),
    old: (cmd, E) => run(join(OLD, 'suivi.mjs'), [cmd, 'plans/boutique', '--json', JSON.stringify(E)]),
    migrate: (...args) => run(MIGRATE, args),
    migrateWith: (env, cwd, ...args) => run(MIGRATE, args, undefined, env, cwd),
    script: (name, ...args) => run(join(SCRIPTS, name), args),
    clean: () => git('status', '--porcelain', '--untracked-files=all'),
    snapshot: () => JSON.stringify(readdirSync(d, { recursive: true }).sort().map(f => [f, existsSync(join(d, f)) && !f.endsWith('taches') && !f.endsWith('tasks') ? readFileSync(join(d, f), 'utf8') : null])),
  }
}

try {
  // ─── A plan run by 0.11: T01 merged, run left in progress ─────────────────────────────────────────────────────────
  const R = repo()
  assert.equal(R.old('debut-run', { phase: 1, mode: 'devia', parallelisme: 2, corrections_max: 2, decisions_office_max: 3 }).code, 0)
  assert.equal(R.old('etape', { tache: 'T01', etape: 'worker', isole: false, modele: 'sonnet' }).code, 0)
  assert.equal(R.old('etape', { tache: 'T01', etape: 'correction', refus: { essai: 1, par: 'évaluation', manques: ['test manquant'] }, modele: 'opus', changement: { de: 'sonnet', vers: 'opus', raison: 'test e2e' } }).code, 0)
  R.git('switch', '-qc', 'tache/T01'); writeFileSync(join(R.root, 'T01.txt'), 'T01'); R.git('add', 'T01.txt'); R.git('commit', '-qm', 'feat: T01')
  R.git('switch', '-q', 'plan/boutique'); R.git('merge', '-q', '--no-ff', 'tache/T01', '-m', 'tâche T01 : Tâche T01')
  assert.equal(R.old('cloture', { tache: 'T01', statut: 'fusionnée', essais: 2, branche: 'tache/T01', relectures: ['docs/DEPLOY.md : relire'] }).code, 0)
  R.git('commit', '-qam', 'suivi(T01) : fusionnée')
  assert.equal(R.clean(), '', 'suivi.json of 0.11 is excluded from git')
  const before = R.snapshot()

  test('preview by default: the changes listed, nothing written', () => {
    const r = R.migrate('plans/boutique')
    assert.equal(r.code, 0, r.err)
    const l = r.out.split('\n')
    assert.equal(l[0], 'migrate plans/boutique: French format of orchestre 0.11 and earlier → 0.12 (preview, nothing written)')
    assert.equal(l[1], '  taches/ → tasks/: 3 task files (34 frontmatter keys, 12 section titles, 3 branch names)')
    assert.equal(l[2], '  SUIVI.md → PROGRESS.md: 8 column titles, 3 statuses, 3 token cells, legend, title')
    assert.equal(l[3], '  PREREQUIS.md → PREREQUISITES.md: 3 column titles, 3 types, 3 statuses, legend, "Checked by" line, title')
    assert.equal(l[4], '  HANDOFF.md: 4 entries, "Entries:" line, "## source plan"')
    assert.equal(l[5], '  DISCOVERY.md: 6 section titles')
    assert.equal(l[6], '  orchestre.config.json: 11 keys, default_mode "devia" → "deviation", evaluator "systematique" → "always", "language": "fr" added')
    assert.equal(l[7], '  suivi.json → progress.json (outside git): orchestre-suivi/2 → orchestre-progress/3, run 1 still "en-cours"')
    assert.match(l[8], /Run again with --write to migrate and commit\.$/)
    assert.equal(R.snapshot(), before); assert.equal(R.clean(), '')
  })

  test('--write refused while suivi.json notes a run "en-cours" (except --run-stopped), or when the plan folder has uncommitted changes; nothing written', () => {
    let r = R.migrate('plans/boutique', '--write')
    assert.equal(r.code, 1); assert.match(r.err, /^migrate: suivi\.json marks run 1 "en-cours" since \S+: migrate between two runs\. If it is stopped, run again with --run-stopped\.$/)
    assert.equal(R.snapshot(), before)
    assert.equal(R.old('fin-run', { statut: 'partiel', non_lancees: ['T02'] }).code, 0)
    writeFileSync(join(R.d, 'notes.txt'), 'brouillon\n')
    r = R.migrate('plans/boutique', '--write', '--run-stopped')
    assert.equal(r.code, 1); assert.match(r.err, /^migrate: plans\/boutique has uncommitted changes \(plans\/boutique\/notes\.txt\): commit or discard them first/)
    rmSync(join(R.d, 'notes.txt'))
    assert.equal(R.clean(), '')
  })

  test('--write: migrated and committed in one commit of the plan folder alone; other staged changes stay staged', () => {
    writeFileSync(join(R.root, 'other.txt'), 'staged elsewhere\n'); R.git('add', 'other.txt')
    const head0 = R.git('rev-parse', 'HEAD').trim()
    const r = R.migrate('plans/boutique', '--write')
    assert.equal(r.code, 0, r.err)
    assert.match(r.out.split('\n')[0], /^migrate plans\/boutique: French format of orchestre 0\.11 and earlier → 0\.12: migrated and committed \([0-9a-f]+ on plan\/boutique: "orchestre: migrate plan boutique to the 0\.12 format"\)$/)
    assert.equal(R.git('rev-parse', 'HEAD~1').trim(), head0)
    assert.equal(R.git('log', '-1', '--format=%s').trim(), 'orchestre: migrate plan boutique to the 0.12 format')
    assert.deepEqual(R.git('diff', '--name-status', '--no-renames', 'HEAD~1', 'HEAD').trim().split('\n').map(l => l.replace('\t', ' ')).sort(), [
      'A plans/boutique/PREREQUISITES.md', 'A plans/boutique/PROGRESS.md', 'A plans/boutique/tasks/T01-panier.md', 'A plans/boutique/tasks/T02-paiement.md', 'A plans/boutique/tasks/T03-recette.md',
      'D plans/boutique/PREREQUIS.md', 'D plans/boutique/SUIVI.md', 'D plans/boutique/taches/T01-panier.md', 'D plans/boutique/taches/T02-paiement.md', 'D plans/boutique/taches/T03-recette.md',
      'M plans/boutique/DISCOVERY.md', 'M plans/boutique/HANDOFF.md', 'M plans/boutique/orchestre.config.json',
    ], 'the plan folder alone')
    assert.equal(R.git('log', '-1', '--format=', '--name-status', '-M30%', '--', 'plans/boutique/tasks/T02-paiement.md', 'plans/boutique/taches/T02-paiement.md').trim().split('\t')[0].slice(0, 1), 'R', 'git log --follow finds a task file through the migration')
    assert.equal(R.clean(), 'A  other.txt\n', 'progress.json outside git; the other staged change is still staged, not committed')
    R.git('reset', '-q', 'other.txt'); rmSync(join(R.root, 'other.txt'))
    assert.deepEqual(readdirSync(R.d).sort(), ['DISCOVERY.md', 'HANDOFF.md', 'PREREQUISITES.md', 'PROGRESS.md', 'orchestre.config.json', 'progress.json', 'tasks'])
  })

  test('task files: English keys and section titles, branch names of the plan\'s tasks; values and free text kept (key names quoted in the prose too)', () => {
    const t = R.read('tasks/T02-paiement.md')
    assert.equal(t, `---
id: T02
title: Tâche T02
phase: 1
model: sonnet          # haiku | sonnet | opus
model_reason: "implémentation courante"
effort: high
depends_on: [T01]
parallel_batch: 1A
owned_files:
  - src/T02/**
resources: []
prerequisites: [D5]
context_budget: 40%
token_estimate: "1.0M"
max_turns: 60
verification:
  - "npm test"
definition_of_done:
  - "le test passe"
---

## Launch prompt
Tu réalises T02 sur la branche task/T02. Lis d'abord DISCOVERY.md,
puis les fichiers listés dans Contexte utile.
Ne modifie rien hors de fichiers_possedes.

## Useful context
- src/T02/index.ts : le point d'entrée.
## Implementation notes
Écris le module, puis son test.
## Out of scope
La documentation.
`)
  })

  test('PROGRESS.md, PREREQUISITES.md, HANDOFF.md, DISCOVERY.md: format translated, free text kept', () => {
    assert.equal(R.read('PROGRESS.md'), `# PROGRESS — boutique

| ID  | Title     | Phase | Batch | Depends on | Model  | Status | Attempts | Branch    | Tokens est. / actual  |
|-----|-----------|-------|-------|------------|--------|--------|----------|-----------|-----------------------|
| T01 | Tâche T01 | 1     | 1A    | —          | sonnet | merged | 2        | tache/T01 | 1.0M / see /workflows |
| T02 | Tâche T02 | 1     | 1A    | T01        | sonnet | todo   | 0        | —         | 1.0M / —              |
| T03 | Tâche T03 | 2     | 2A    | T02        | sonnet | todo   | 0        | —         | 1.0M / —              |

Statuses: todo · added · merged · blocked · failed · needs-human · cancelled

## Notes du pilote

Rien à signaler.
`, 'the branch of git history (tache/T01) is kept: it exists under that name')
    assert.equal(R.read('PREREQUISITES.md'), `# PREREQUISITES — boutique

| ID  | Type        | Prerequisite                       | Status  | Evidence                     |
|-----|-------------|------------------------------------|---------|------------------------------|
| D5  | decision    | Choisir le fournisseur de paiement | open    | —                            |
| H1  | manual      | Clé d'API dans \`.env\` \\| sandbox   | done    | confirmé par Fabien le 30/09 |
| E1  | environment | Base de test démarrée              | dropped | plus utile                   |

Types: decision · manual · environment. Statuses: open · done · dropped.
Checked by /orchestre:ready on 10/10: phase 1 prête, phase 2 attend D5
`)
    assert.equal(R.read('HANDOFF.md'), `# HANDOFF — boutique
Entries: \`deviation\`, \`blind-spot\`, \`decision\`, \`debt\`, \`needs-human\`, \`ticket\`, \`review\`, rated \`minor\` or \`major\`.

## source plan

decision · major · D4 : paiement en une fois (tranchée par l'utilisateur)
review · major · .env.example : vérifier SESSION_SECRET avant la PR

## T01

- deviation · minor · le test e2e attend 2 s de plus
- blind-spot · major · le cas « panier vide » n'est pas vérifiable
`)
    assert.equal(R.read('DISCOVERY.md'), FR['DISCOVERY.md'].replace('Contexte existant', 'Existing context').replace('Commandes vérifiées', 'Verified commands').replace('Carte rapide', 'Quick map').replace('Conventions constatées', 'Observed conventions').replace('Pièges et solutions', 'Pitfalls and fixes').replace('Recommandations de contexte (fin de run)', 'Context recommendations (end of run)'))
  })

  test('orchestre.config.json: English keys in the same order, values translated, "language": "fr" added', () => {
    assert.deepEqual(JSON.parse(R.read('orchestre.config.json')), { max_parallelism: 4, default_mode: 'deviation', integration_branch: 'plan/boutique', base_branch: 'main', evaluator: 'always', max_fixes: 2, escalation: ['sonnet', 'opus'], fable: false, max_auto_decisions: 3, pilot_context_cap: 0.65, setup: ['npm ci'], shared_setup: { db: ['npm run db:test'] }, language: 'fr' })
    assert.deepEqual(Object.keys(JSON.parse(R.read('orchestre.config.json'))), ['max_parallelism', 'default_mode', 'integration_branch', 'base_branch', 'evaluator', 'max_fixes', 'escalation', 'fable', 'max_auto_decisions', 'pilot_context_cap', 'setup', 'shared_setup', 'language'])
  })

  test('progress.json: orchestre-progress/3, valid, run history and model used kept, conversion noted', () => {
    const doc = JSON.parse(R.read('progress.json'))
    assert.equal(doc.format, 'orchestre-progress/3')
    assert.deepEqual(doc.runs.map(r => [r.number, r.mode, r.status, r.not_started]), [[1, 'deviation', 'partial', ['T02']]])
    const t1 = doc.tasks.find(t => t.id === 'T01')
    assert.deepEqual([t1.status, t1.model_used, t1.attempts, t1.branch, t1.actual_tokens, t1.rejections], ['merged', 'opus', 2, 'tache/T01', 'see /workflows', [{ attempt: 1, by: 'evaluation', gaps: ['test manquant'] }]])
    assert.deepEqual(doc.reviews.map(r => r.text), ['.env.example : vérifier SESSION_SECRET avant la PR', 'docs/DEPLOY.md : relire'])
    assert.ok(doc.log.some(e => e.kind === 'model' && e.text === 'T01 : sonnet → opus (test e2e)'), 'French log text kept')
    assert.equal(doc.log.at(-1).text, 'progress.json converted from orchestre-suivi/2 to orchestre-progress/3 by migrate.mjs')
    assert.deepEqual(doc.handoff, { 'source plan': { decision: { minor: 0, major: 1 }, review: { minor: 0, major: 1 } }, T01: { deviation: { minor: 1, major: 0 }, 'blind-spot': { minor: 0, major: 1 } } }, 'HANDOFF counts of 0.11, types, severities and sections translated')
    const v = R.script('progress.mjs', 'validate', 'plans/boutique')
    assert.equal(v.code, 0, v.err); assert.equal(v.out, 'progress: progress.json valid (orchestre-progress/3, 3 tasks, 1 run)')
  })

  test('read by the 0.12 scripts: plan-lint valid (merge "tâche T01 : " of 0.11 counted), view identical, status in English, worktrees', () => {
    const L = JSON.parse(R.script('plan-lint.mjs', 'plans/boutique', '--json', '--integration', 'plan/boutique').out)
    assert.equal(L.ok, true, JSON.stringify(L.errors)); assert.deepEqual(L.warnings, ['shared_setup: no task declares the resource "db"; its commands will never run'], 'shared_setup read under its new name')
    assert.deepEqual(L.tasks.map(t => [t.id, t.status, t.token_estimate, t.depends_on]), [['T01', 'merged', 1, []], ['T02', 'todo', 1, ['T01']], ['T03', 'todo', 1, ['T02']]])
    assert.deepEqual(L.prerequisites.map(p => [p.id, p.type, p.status, p.blocks]), [['D5', 'decision', 'open', ['T02']], ['H1', 'manual', 'done', []], ['E1', 'environment', 'dropped', []]])
    assert.equal(L.language, 'fr')
    const view = R.script('progress.mjs', 'view', 'plans/boutique', '--stdout')
    assert.equal(view.out + '\n', R.read('PROGRESS.md'), 'the table migrate writes is the one progress.mjs renders')
    const st = R.script('status.mjs', 'plans/boutique').out
    assert.match(st, /^## boutique — 1\/3 tasks · 33%\n`█{8}░{16}` phase 1 in progress · last merge T01 /)
    // The open reviews of progress.json (0.15.1): the one of HANDOFF.md and the one of the T01 close, as in /progress
    assert.ok(st.includes('**Your turn**: D5 (decision) blocks T02 · 2 reviews before the PR'), st)
    assert.equal(R.script('worktrees.mjs', 'clean', 'plans/boutique').out, 'worktrees plans/boutique: 0 removed, 0 kept')
    // The run goes on with the 0.12 scripts
    assert.equal(R.script('progress.mjs', 'run-start', 'plans/boutique', '--json', JSON.stringify({ phase: 1, mode: 'deviation', parallelism: 2, max_fixes: 2, max_auto_decisions: 3 })).code, 0)
    assert.equal(JSON.parse(R.read('progress.json')).runs.length, 2)
    assert.equal(R.clean(), '')
  })

  test('idempotent: a migrated plan is left as is', () => {
    const head = R.git('rev-parse', 'HEAD').trim(), snap = R.snapshot()
    for (const args of [['plans/boutique'], ['plans/boutique', '--write'], []]) {
      const r = R.migrate(...args)
      assert.equal(r.code, 0, r.err); assert.equal(r.out, 'migrate plans/boutique: already in the 0.12 format, nothing to migrate')
    }
    assert.equal(R.git('rev-parse', 'HEAD').trim(), head); assert.equal(R.snapshot(), snap)
  })

  test('a plan never run (no suivi.json), without orchestre.config.json: config created with "language": "fr"; an existing language is kept', () => {
    const S = repo()
    rmSync(join(S.d, 'orchestre.config.json')); S.git('commit', '-qam', 'no config')
    const r = S.migrate('plans/boutique', '--write')
    assert.equal(r.code, 0, r.err)
    assert.ok(r.out.includes('  orchestre.config.json (created): 0 keys, "language": "fr" added'), r.out)
    assert.ok(!r.out.includes('suivi.json'))
    assert.deepEqual(JSON.parse(S.read('orchestre.config.json')), { language: 'fr' })
    assert.ok(!existsSync(join(S.d, 'progress.json')))
    assert.equal(S.clean(), '')
    const L = JSON.parse(S.script('plan-lint.mjs', 'plans/boutique', '--json').out)
    assert.equal(L.ok, true, JSON.stringify(L.errors))
    const K = repo()
    writeFileSync(join(K.d, 'orchestre.config.json'), JSON.stringify({ language: 'en', escalade: ['opus'] })); K.git('commit', '-qam', 'config')
    assert.equal(K.migrate('plans/boutique', '--write').code, 0)
    assert.deepEqual(JSON.parse(K.read('orchestre.config.json')), { language: 'en', escalation: ['opus'] })
  })

  test('refusals: taches/ and tasks/ together, PROGRESS.md already there, unreadable suivi.json or config; invalid calls (code 2)', () => {
    const B = repo()
    mkdirSync(join(B.d, 'tasks')); writeFileSync(join(B.d, 'tasks', 'x.md'), 'x'); B.git('add', '.'); B.git('commit', '-qm', 'x')
    let r = B.migrate('plans/boutique')
    assert.equal(r.code, 1); assert.equal(r.err, 'migrate: plans/boutique: both taches/ and tasks/ exist: migration stopped halfway? Move the files by hand')
    rmSync(join(B.d, 'tasks'), { recursive: true }); B.git('commit', '-qam', 'y')
    writeFileSync(join(B.d, 'PROGRESS.md'), 'x'); B.git('add', '.'); B.git('commit', '-qm', 'z')
    r = B.migrate('plans/boutique'); assert.equal(r.code, 1); assert.match(r.err, /SUIVI\.md and PROGRESS\.md both exist/)
    B.git('rm', '-q', 'plans/boutique/PROGRESS.md'); B.git('commit', '-qm', 'w')
    writeFileSync(join(B.d, 'suivi.json'), '{ pas du json')
    writeFileSync(join(B.root, '.git', 'info', 'exclude'), '/plans/boutique/suivi.json\n')
    r = B.migrate('plans/boutique', '--write'); assert.equal(r.code, 1); assert.match(r.err, /^migrate: suivi\.json unreadable \(.*\): delete it, it will be rebuilt/)
    writeFileSync(join(B.d, 'suivi.json'), JSON.stringify({ format: 'orchestre-suivi/9' }))
    r = B.migrate('plans/boutique'); assert.equal(r.code, 1); assert.match(r.err, /suivi\.json is in format orchestre-suivi\/9, migrate reads orchestre-suivi\/2 and orchestre-suivi\/1/)
    rmSync(join(B.d, 'suivi.json'))
    writeFileSync(join(B.d, 'orchestre.config.json'), '{ "escalade": '); B.git('commit', '-qam', 'v')
    r = B.migrate('plans/boutique'); assert.equal(r.code, 1); assert.match(r.err, /^migrate: orchestre\.config\.json unreadable/)
    assert.ok(existsSync(join(B.d, 'taches')) && !existsSync(join(B.d, 'tasks')), 'nothing written')
    for (const args of [['plans/missing'], ['plans/boutique', '--force'], ['a', 'b']]) assert.equal(B.migrate(...args).code, 2, args.join(' '))
    const outside = temp('outside-')
    assert.match(spawnSync(process.execPath, [MIGRATE], { cwd: outside, encoding: 'utf8' }).stderr, /^migrate: not in a git repository/)
  })

  test("SUIVI.md of the pilot (0.6.3 scribe): rows under the legend converted in place, steps of the old legend translated, French free text kept", () => {
    const text = `# SUIVI — pilote

| ID  | Titre | Phase | Statut    | Essais | Branche   | Tokens est. / réels |
| --- | ----- | ----- | --------- | ------ | --------- | ------------------- |
| T00 | Outillage | 1 | fusionnée | 3 | tache/T00 | 1,2 M / voir /workflows |

**Total estimé : 23,1 M tokens**, dont 14,9 M sur sonnet.

Statuts : à-faire · en-cours · vérification · correction · fusion · fusionnée · besoin-humain
| T00B | Ajoutée par le scribe | 1 | fusionnée | 1 | tache/T00B | 0.3 M / voir /workflows |
`
    const n = { headers: 0, statuses: 0, tokens: 0, legend: 0, title: 0 }
    assert.equal(convertProgress(text, n), `# PROGRESS — pilote

| ID  | Title     | Phase | Status | Attempts | Branch    | Tokens est. / actual  |
| --- | --------- | ----- | ------ | -------- | --------- | --------------------- |
| T00 | Outillage | 1     | merged | 3        | tache/T00 | 1.2M / see /workflows |

**Total estimé : 23,1 M tokens**, dont 14,9 M sur sonnet.

Statuses: todo · in-progress · verification · fix · merge · merged · needs-human
| T00B | Ajoutée par le scribe | 1 | merged | 1 | tache/T00B | 0.3M / see /workflows |
`)
    assert.deepEqual(n, { headers: 5, statuses: 2, tokens: 2, legend: 1, title: 1 })
  })

  test('plan-lint names in its errors the same English keys as migrate.mjs (LEGACY.taskKeys, LEGACY.configKeys)', () => {
    const C = repo()
    rmSync(join(C.d, 'taches'), { recursive: true }); mkdirSync(join(C.d, 'tasks'))
    writeFileSync(join(C.d, 'tasks', 'T01-x.md'), frTask('T01', { prerequis: '[D5]' }))
    const L = JSON.parse(C.script('plan-lint.mjs', 'plans/boutique', '--json').out)
    const named = Object.fromEntries(L.errors.map(e => e.match(/French key "(\w+)" of orchestre 0\.11 and earlier: rename it "(\w+)"/)).filter(Boolean).map(m => [m[1], m[2]]))
    assert.deepEqual(named, { ...LEGACY.taskKeys, ...LEGACY.configKeys })
  })


  test('from a linked worktree: refused, nothing written (suivi.json lives in the main checkout)', () => {
    const W = repo()
    const wt = join(temp('migrate-wt-'), 'wt')
    W.git('worktree', 'add', '-q', '-b', 'tache/T03', wt, 'plan/boutique')
    const r = W.migrateWith({}, wt, 'plans/boutique', '--write')
    assert.equal(r.code, 1); assert.match(r.err, /^migrate: run migrate from the main checkout \(.*\), where the progress file of the plan lives, not from a linked worktree$/)
    assert.ok(existsSync(join(wt, 'plans', 'boutique', 'taches'))); assert.equal(W.git('log', '-1', '--format=%s', 'tache/T03').trim(), 'plan boutique')
  })

  test('a failure while writing restores the plan folder as it was (tracked files, new files, suivi.json); a rerun then migrates', () => {
    const F = repo()
    assert.equal(F.old('debut-run', { phase: 1, mode: 'phase', parallelisme: 1, corrections_max: 2, decisions_office_max: 3 }).code, 0)
    assert.equal(F.old('fin-run', { statut: 'partiel' }).code, 0)
    const snap = F.snapshot(), head = F.git('rev-parse', 'HEAD').trim()
    for (const step of ['tasks/T02-paiement.md', 'PROGRESS.md', 'HANDOFF.md', 'orchestre.config.json', 'progress.json', 'remove taches', 'remove SUIVI.md']) {
      const r = F.migrateWith({ ORCHESTRE_MIGRATE_FAIL_AFTER: step }, F.root, 'plans/boutique', '--write')
      assert.equal(r.code, 1, step); assert.equal(r.err, `migrate: migration failed (test failure after ${step}): the plan folder is restored as it was, nothing is migrated`)
      assert.equal(F.snapshot(), snap, step); assert.equal(F.clean(), '', step); assert.equal(F.git('rev-parse', 'HEAD').trim(), head)
    }
    assert.equal(F.migrate('plans/boutique', '--write').code, 0)
    assert.ok(existsSync(join(F.d, 'progress.json')) && !existsSync(join(F.d, 'suivi.json')))
  })

  test('files of the French format left next to tasks/ (another clone pulled the migration): plan-lint errs, migrate converts them only', () => {
    const O = repo()
    assert.equal(O.migrate('plans/boutique', '--write').code, 0)
    // The other clone: the migration commit pulled, its own suivi.json of 0.11 still there, and a SUIVI.md restored by hand
    const at = '2026-10-01T10:00:00+02:00'
    writeFileSync(join(O.d, 'suivi.json'), JSON.stringify({ format: 'orchestre-suivi/1', plan: 'boutique', dossier: 'plans/boutique', integration: 'plan/boutique', base: null, maj: at, taches: [], runs: [{ numero: 4, run_id: null, phase: 1, mode: 'auto', parallelisme: 1, corrections_max: 2, decisions_office_max: 3, statut: 'terminé', debut: at, fin: at, detail: null, arbitrages_appliques: [], amendements_ecartes: [], taches_ajoutees: [], reportees: [], non_lancees: [], en_attente: [], en_attente_prerequis: [] }], points: [], decisions_office: [], relectures: [], prerequis: [], handoff: {}, lint: { ok: true, erreurs: [] }, journal: [], journal_omis: 0 }))
    O.git('rm', '-q', '--cached', '-r', 'plans/boutique/PROGRESS.md'); O.git('commit', '-qm', 'drop'); rmSync(join(O.d, 'PROGRESS.md'))
    writeFileSync(join(O.d, 'SUIVI.md'), FR['SUIVI.md']); O.git('add', 'plans/boutique/SUIVI.md'); O.git('commit', '-qm', 'old view')
    // A plan of 0.12 without "language" means English: converting leftovers does not add "fr"
    const { language, ...cfg } = JSON.parse(O.read('orchestre.config.json')); assert.equal(language, 'fr')
    writeFileSync(join(O.d, 'orchestre.config.json'), JSON.stringify(cfg, null, 2) + '\n'); O.git('commit', '-qam', 'english')
    const L = JSON.parse(O.script('plan-lint.mjs', 'plans/boutique', '--json').out)
    assert.deepEqual(L.errors.map(e => e.split(':')[0]), ['SUIVI.md', 'suivi.json'])
    assert.match(L.errors[0], /^SUIVI\.md: file of the French format of orchestre 0\.11 next to tasks\/: run node ".*\/migrate\.mjs" plans\/boutique, which converts what is left$/)
    assert.equal(O.script('worktrees.mjs', 'clean', 'plans/boutique').code, 0, 'a finished run of suivi.json does not block the clean')
    let r = O.migrate('plans/boutique')
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.out.split('\n').slice(0, 3), ['migrate plans/boutique: files of the French format of 0.11 left next to tasks/ → 0.12 (preview, nothing written)', '  SUIVI.md → PROGRESS.md: 8 column titles, 3 statuses, 3 token cells, legend, title', '  suivi.json → progress.json (outside git): orchestre-suivi/1 → orchestre-progress/3'])
    assert.ok(!existsSync(join(O.d, 'progress.json')))
    r = O.migrate('plans/boutique', '--write')
    assert.equal(r.code, 0, r.err)
    assert.equal(JSON.parse(O.read('progress.json')).runs[0].number, 4)
    assert.equal(JSON.parse(O.read('orchestre.config.json')).language, undefined, 'no "language" added')
    assert.ok(!existsSync(join(O.d, 'SUIVI.md')) && !existsSync(join(O.d, 'suivi.json')))
    assert.equal(JSON.parse(O.script('plan-lint.mjs', 'plans/boutique', '--json').out).ok, true)
    assert.equal(O.migrate('plans/boutique').out, 'migrate plans/boutique: already in the 0.12 format, nothing to migrate')
  })

  test('CRLF files, a decision entry without severity (accepted by 0.11), an extra column, a binary file, and a "constructor" key', () => {
    const C = repo()
    const crlf = t => t.replace(/\n/g, '\r\n')
    for (const f of ['SUIVI.md', 'PREREQUIS.md', 'HANDOFF.md', 'DISCOVERY.md']) writeFileSync(join(C.d, f), crlf(FR[f]))
    writeFileSync(join(C.d, 'SUIVI.md'), crlf(FR['SUIVI.md'].replace('| Tokens est. / réels |\n|', '| Tokens est. / réels | Note |\n|').replace('|---------------------|\n', '|---------------------|------|\n').replace('| 1,0 M / —           |\n| T02', '| 1,0 M / —           | à voir |\n| T02')))
    writeFileSync(join(C.d, 'HANDOFF.md'), crlf(FR['HANDOFF.md'] + 'décision · D9 : sans gravité (tranchée par Fabien)\n'))
    writeFileSync(join(C.d, 'PREREQUIS.md'), crlf(FR['PREREQUIS.md'].replace('| E1 |', '| D9 | décision | Seuil | fait | HANDOFF |\n| E1 |')))
    writeFileSync(join(C.d, 'taches', 'T01-panier.md'), crlf(frTask('T01').replace('effort: high', 'effort: high\nconstructor: x').replace('La documentation.', 'La documentation, et la branche tache/Z99 d\'un autre plan.')))
    const png = randomBytes(2048); writeFileSync(join(C.d, 'taches', 'schema.png'), png)
    C.git('add', '.'); C.git('commit', '-qm', 'crlf')
    const r = C.migrate('plans/boutique', '--write')
    assert.equal(r.code, 0, r.err)
    assert.ok(r.out.includes('3 task files (34 frontmatter keys, 12 section titles, 3 branch names), 1 other file moved as is'), r.out)
    const sha = b => createHash('sha1').update(b).digest('hex')
    assert.equal(sha(readFileSync(join(C.d, 'tasks', 'schema.png'))), sha(png), 'binary file moved untouched')
    for (const f of ['PROGRESS.md', 'PREREQUISITES.md', 'HANDOFF.md', 'DISCOVERY.md', 'tasks/T01-panier.md']) assert.ok(!/[^\r]\n/.test(C.read(f)), `${f}: every line still ends with CRLF`)
    const pre = C.read('PREREQUISITES.md')
    assert.ok(pre.includes('Checked by /orchestre:ready on 10/10: phase 1 prête, phase 2 attend D5\r\n') && pre.includes('Types: decision · manual · environment. Statuses: open · done · dropped.\r\n'), pre)
    assert.ok(C.read('PROGRESS.md').includes('| Tokens est. / actual | Note   |\r\n'), 'extra column kept')
    assert.ok(C.read('PROGRESS.md').includes('| 1.0M / —             | à voir |\r\n'))
    assert.ok(C.read('HANDOFF.md').includes('decision · D9 : sans gravité (tranchée par Fabien)\r\n'))
    assert.ok(C.read('DISCOVERY.md').includes('## Existing context\r\n'))
    const t1 = C.read('tasks/T01-panier.md')
    assert.ok(t1.includes('constructor: x\r\n') && t1.includes('## Launch prompt\r\n') && t1.includes('title: Tâche T01\r\n'), t1)
    assert.ok(t1.includes('sur la branche task/T01.') && t1.includes('la branche tache/Z99 d\'un autre plan.'), 'only the branches of the plan\'s tasks')
    const L = JSON.parse(C.script('plan-lint.mjs', 'plans/boutique', '--json').out)
    assert.equal(L.ok, true, JSON.stringify(L.errors))
    assert.equal(L.prerequisites.find(p => p.id === 'D9').status, 'done', 'the decision without severity still counts in HANDOFF.md')
  })

  test('symbolic link or folder inside taches/: refused, nothing written', () => {
    const Y = repo()
    symlinkSync('../HANDOFF.md', join(Y.d, 'taches', 'T09-link.md')); Y.git('add', '.'); Y.git('commit', '-qm', 'link')
    let r = Y.migrate('plans/boutique', '--write')
    assert.equal(r.code, 1); assert.equal(r.err, 'migrate: taches/T09-link.md: a symbolic link, migrate does not follow it; replace it by the file, or move it by hand')
    Y.git('rm', '-q', 'plans/boutique/taches/T09-link.md'); mkdirSync(join(Y.d, 'taches', 'images')); writeFileSync(join(Y.d, 'taches', 'images', 'a.txt'), 'a'); Y.git('add', '.'); Y.git('commit', '-qm', 'dir')
    r = Y.migrate('plans/boutique')
    assert.equal(r.code, 1); assert.match(r.err, /taches\/images: a folder inside taches\//)
    assert.ok(existsSync(join(Y.d, 'taches')) && !existsSync(join(Y.d, 'tasks')))
  })

  test('commit refused by a hook: code 1, files migrated and staged; outside the integration branch: a note', () => {
    const K = repo()
    K.git('switch', '-q', 'main'); K.git('merge', '-q', '--ff-only', 'plan/boutique')
    let r = K.migrate('plans/boutique')
    assert.ok(r.out.includes('Note: the current branch is main, not the integration branch plan/boutique; the migration commit goes on main.'), r.out)
    writeFileSync(join(K.root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "no commit today" >&2\nexit 1\n'); chmodSync(join(K.root, '.git', 'hooks', 'pre-commit'), 0o755)
    r = K.migrate('plans/boutique', '--write')
    assert.equal(r.code, 1)
    assert.match(r.out, /^migrate plans\/boutique: French format of orchestre 0\.11 and earlier → 0\.12: files migrated and staged, but the commit failed \(no commit today\): commit plans\/boutique by hand$/m)
    assert.ok(K.clean().split('\n').filter(Boolean).every(l => /^[RAMD] /.test(l)), 'everything staged')
  })

  test('suivi.json with a full log: the conversion note keeps it at 200 events', () => {
    const J = repo()
    assert.equal(J.old('debut-run', { phase: 1, mode: 'phase', parallelisme: 1, corrections_max: 2, decisions_office_max: 3 }).code, 0)
    assert.equal(J.old('fin-run', { statut: 'partiel' }).code, 0)
    const sv = JSON.parse(J.read('suivi.json'))
    sv.journal = Array.from({ length: 200 }, (_, i) => ({ quand: sv.maj, genre: 'etape', tache: null, texte: `ancien ${i}` })); sv.journal_omis = 7
    writeFileSync(join(J.d, 'suivi.json'), JSON.stringify(sv))
    assert.equal(J.migrate('plans/boutique', '--write').code, 0)
    const doc = JSON.parse(J.read('progress.json'))
    assert.deepEqual([doc.log.length, doc.log_omitted, doc.log[0].text, doc.log[0].kind, doc.log.at(-1).kind], [200, 8, 'ancien 1', 'step', 'run'])
  })

  test('a plan at the root of the repository (plan-dir "."): migrated', () => {
    const root = temp('migrate-root-')
    const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '-q', '-b', 'plan/root'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
    mkdirSync(join(root, 'taches')); writeFileSync(join(root, 'taches', 'T01-x.md'), frTask('T01')); writeFileSync(join(root, 'SUIVI.md'), FR['SUIVI.md'])
    git('add', '.'); git('commit', '-qm', 'plan')
    const r = spawnSync(process.execPath, [MIGRATE, '.', '--write'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(existsSync(join(root, 'tasks', 'T01-x.md')) && existsSync(join(root, 'PROGRESS.md')))
    assert.equal(git('status', '--porcelain'), '')
  })

  console.log(`migrate: ALL GREEN (${n} tests)`)
} finally { for (const d of temporaries) rmSync(d, { recursive: true, force: true }) }
