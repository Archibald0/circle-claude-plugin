// Tests of migrate.mjs: a plan written and run by orchestre 0.11.0 (its real scripts, taken from git at dd14f89), converted to the
// format of 0.12, then read by the 0.12 scripts. In temporary git repositories.
// Usage: node tests/migrate.test.mjs [path of migrate.mjs]
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
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
  const run = (script, args, input) => { const r = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', input }); return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() } }
  return {
    root, git, d, read: f => readFileSync(join(d, f), 'utf8'),
    old: (cmd, E) => run(join(OLD, 'suivi.mjs'), [cmd, 'plans/boutique', '--json', JSON.stringify(E)]),
    migrate: (...args) => run(MIGRATE, args),
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
    assert.equal(l[1], '  taches/ → tasks/: 3 task files (34 frontmatter keys, 12 section titles, 3 key names in the body, 3 branch names)')
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

  test('task files: English keys and section titles, branch and key names of the prompt; values and free text kept', () => {
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
Ne modifie rien hors de owned_files.

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
    assert.ok(st.includes('**Your turn**: D5 (decision) blocks T02 · 1 review before the PR'), st)
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

  console.log(`migrate: ALL GREEN (${n} tests)`)
} finally { for (const d of temporaries) rmSync(d, { recursive: true, force: true }) }
