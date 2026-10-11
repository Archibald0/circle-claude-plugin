// Tests of progress.mjs (progress.json in format orchestre-progress/3, conversion of the formats of 0.11 and earlier, view
// PROGRESS.md), in temporary git repositories.
// Usage: node tests/progress.test.mjs [path of progress.mjs]
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, unlinkSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync, spawn } from 'node:child_process'

const PROGRESS_MJS = resolve(process.argv[2] || 'plugins/orchestre/scripts/progress.mjs')
const STATUS_MJS = join(dirname(PROGRESS_MJS), 'status.mjs')
const LINT = join(dirname(PROGRESS_MJS), 'plan-lint.mjs')
const temporaries = []
const temp = p => { const d = mkdtempSync(join(tmpdir(), p)); temporaries.push(d); return d }
const width = s => [...s].length
let n = 0
const test = async (name, fn) => { await fn(); n++; console.log('ok ·', name) }

// model null: no model line in the frontmatter; reason: the model_reason line
const task = ({ id, title = `Task ${id}`, phase = 1, model = 'sonnet', reason = null, depends_on = [], batch = null, estimate = '1.0M', prerequisites = null }) => `---
id: ${id}
title: ${title}
phase: ${phase}
${model ? `model: ${model}\n` : ''}${reason ? `model_reason: ${reason}\n` : ''}depends_on: [${depends_on.join(', ')}]
${batch ? `parallel_batch: ${batch}\n` : ''}owned_files:
  - src/${id}/**
resources: []
${prerequisites ? `prerequisites: [${prerequisites}]\n` : ''}${estimate ? `token_estimate: ${estimate}\n` : ''}verification:
  - "npm test"
definition_of_done:
  - "the test passes"
---

## Launch prompt
You carry out ${id}.
`

// A toy git repository: main, an integration branch plan/<name> and a plan in plans/<name>
function repo(name, { tasks, progress, handoff = '', prerequisites = null, config = {} }) {
  const root = temp('progress-')
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'README.md'), 'x\n'); git('add', '.'); git('commit', '-qm', 'init')
  const d = join(root, 'plans', name)
  mkdirSync(join(d, 'tasks'), { recursive: true })
  for (const t of tasks) writeFileSync(join(d, 'tasks', `${t.id}-x.md`), task(t))
  if (progress != null) writeFileSync(join(d, 'PROGRESS.md'), progress)
  writeFileSync(join(d, 'HANDOFF.md'), handoff)
  if (prerequisites) writeFileSync(join(d, 'PREREQUISITES.md'), prerequisites)
  writeFileSync(join(d, 'orchestre.config.json'), JSON.stringify({ integration_branch: `plan/${name}`, ...config }))
  git('switch', '-qc', `plan/${name}`); git('add', '.'); git('commit', '-qm', 'plan')
  const plan = `plans/${name}`
  const stdin = E => (E === undefined ? '' : typeof E === 'string' ? E : JSON.stringify(E))
  return {
    root, git, d, plan,
    read: f => readFileSync(join(d, f), 'utf8'),
    doc: () => JSON.parse(readFileSync(join(d, 'progress.json'), 'utf8')),
    writeTask: t => writeFileSync(join(d, 'tasks', `${t.id}-x.md`), task(t)),
    progress: (cmd, E, { cwd = root, arg = plan, args = [] } = {}) => {
      const r = spawnSync(process.execPath, [PROGRESS_MJS, cmd, ...(arg ? [arg] : []), ...args], { cwd, encoding: 'utf8', input: stdin(E) })
      return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
    },
    launch: (cmd, E, cwd = root) => new Promise(res => {
      const c = spawn(process.execPath, [PROGRESS_MJS, cmd, plan], { cwd })
      let out = '', err = ''
      c.stdout.on('data', x => { out += x }); c.stderr.on('data', x => { err += x })
      c.on('close', code => res({ code, out, err }))
      c.stdin.end(stdin(E))
    }),
    lint: () => JSON.parse(spawnSync(process.execPath, [LINT, plan, '--json', '--integration', `plan/${name}`], { cwd: root, encoding: 'utf8' }).stdout),
    clean: () => git('status', '--porcelain', '--untracked-files=all'),
    leftovers: () => readdirSync(d).filter(f => f === '.progress.lock' || /^\.progress\..*\.tmp$/.test(f)),
  }
}
const RUN = { phase: 1, mode: 'phase', parallelism: 4, max_fixes: 2, max_auto_decisions: 3 }
const PROGRESS_TEMPLATE = ids => `# PROGRESS — demo

| ID  | Title | Phase | Batch | Depends on | Model | Status | Attempts | Branch | Tokens est. / actual |
|-----|-------|-------|-------|------------|-------|--------|----------|--------|----------------------|
${ids.map(id => `| ${id} | Task ${id} | 1 | 1A | — | sonnet | todo | 0 | — | 1.0M / — |`).join('\n')}

Statuses: todo · added · merged · blocked · failed · needs-human · cancelled
`

// The pilot's real SUIVI.md (plan acces-par-metier, 29/09) as migrate.mjs turns it into PROGRESS.md, up to the "Phases" section:
// 7 rows added by the scribe, not aligned, T07 that does not follow its amended frontmatter, T10 in "0.3 M"; French free text kept
const PILOT_PROGRESS = "# PROGRESS — acces-par-metier\n\n| ID  | Title                                       | Phase | Batch | Depends on    | Model  | Status    | Attempts | Branch    | Tokens est. / actual    |\n| --- | ------------------------------------------- | ----- | ----- | ------------- | ------ | --------- | -------- | --------- | ----------------------- |\n| T00 | Outillage — scripts de vérification         | 1     | 1A    | —             | sonnet | merged    | 3        | tache/T00 | 1.2M / see /workflows   |\n| T01 | Fondations — schéma, règles de droits, seed | 1     | 1B    | T00           | opus   | merged    | 2        | tache/T01 | 3.5M / see /workflows   |\n| T00B | Outillage — assainir .prettierignore        | 1     | 1A  | T00           | sonnet | merged | 1      | tache/T00B | 0.3M / —               |\n| T02 | Admin cloisonné — gardes serveur            | 2     | 2A    | T01           | sonnet | merged    | 1        | tache/T02 | 2.6M / see /workflows   |\n| T03 | Admin — notions par métier (écriture + UI)  | 2     | 2A    | T01           | sonnet | merged    | 1        | tache/T03 | 1.8M / see /workflows   |\n| T04 | Admin cloisonné — pages, nav, e2e           | 3     | 3A    | T02, T03      | sonnet | merged    | 2        | tache/T04 | 2.6M / see /workflows   |\n| T05 | Parcours membre filtré par métier           | 3     | 3B    | T02           | sonnet | merged    | 1        | tache/T05 | 2.6M / see /workflows   |\n| T05B | Correctif — lecture isSuperAdmin, test setActionCompletion | 3 | 3C | T04, T05 | sonnet | merged | 1 | tache/T05B | 0.5M / see /workflows |\n| T06 | Recette, répétition migration, build, docs  | 4     | 4A    | T03, T04, T05 | sonnet | merged    | 3        | tache/T06 | 2.6M / see /workflows   |\n| T06B | Restauration de répétition gardée — script versionné et test sur dump synthétique | 4 | 4A | T06 | sonnet | merged | 1 | tache/T06B | 1.2M / see /workflows |\n| T06C | Test de non-affichage des données par rehearsal-restore.sh | 4 | 4A | T06B | sonnet | merged | 1 | tache/T06C | 0.5M / see /workflows |\n| T07 | Revue globale                               | 4     | 4B    | T06C          | opus   | merged    | 1        | tache/T07 | 2.6M / see /workflows   |\n| T08 | Restauration de répétition atomique sur erreur de lecture, tests d'ON_ERROR_STOP et du filtre | 4 | 4C | T07 | sonnet | merged | 2 | tache/T08 | 1.2M / see /workflows |\n| T09 | Admin cloisonné — test versionné du périmètre, suppression de canAdminister, affectation de notion transactionnelle | 4 | 4C | T07 | sonnet | merged | 1 | tache/T09 | 2.1M / see /workflows |\n| T10 | Docs de reprise — déploiement avec répétition gardée, règle ADMIN_EMAILS, purge des copies locales | 4 | 4D | T08, T09 | sonnet | merged | 2 | tache/T10 | 0.3 M / see /workflows |\n\n**Total estimé : 23,1 M tokens**, dont 14,9 M sur sonnet et 6,1 M sur opus (T01 et T07).\n\nStatuses: todo · in-progress · verification · evaluation · fix · merge · merged · blocked · needs-human · added\n\n## Phases (étapes de réalisation)\n\n1. **Outillage et fondations** : T00, puis T01.\n2. **Gardes et affectation** : T02 et T03, en parallèle.\n3. **Interfaces et parcours** : T04 et T05.\n4. **Recette et revue** : T06, puis T07.\n\n## Calibration\n\nFormule : 0,5 × max_tours × (budget_contexte × fenêtre), plus 30 % pour la vérification et l'évaluation. On suppose une **fenêtre de 200 k tokens**. La phase 1 sert d'étalon : on compare le réel de T00 et T01 à l'estimation, puis on recalibre les phases suivantes.\n"
const PILOT = [
  ['T00', 'Outillage — scripts de vérification (e2e local, typecheck)', 1, 'sonnet', [], '1A', '1.2M'],
  ['T00B', 'Outillage — assainir .prettierignore (outillage orchestrateur non suivi) et reformater les fichiers de plan déjà committés', 1, 'sonnet', ['T00'], '1A', '0.3M'],
  ['T01', 'Fondations — schéma (super-admin + exclusions par métier), règles de droits pures, seed', 1, 'opus', ['T00'], '1B', '3.5M'],
  ['T02', 'Admin cloisonné — gardes serveur (access.ts, server actions, super-admin)', 2, 'sonnet', ['T01'], '2A', '2.6M'],
  ['T03', 'Admin — affecter / retirer une notion par métier (écriture + UI dans /admin/notions)', 2, 'sonnet', ['T01'], '2A', '1.8M'],
  ['T04', 'Admin cloisonné — pages, nav, sélecteur, table utilisateurs, e2e', 3, 'sonnet', ['T02', 'T03'], '3A', '2.6M'],
  ['T05', 'Parcours membre filtré par métier — éval, carte, missions, Cap, validation', 3, 'sonnet', ['T02'], '3B', '2.6M'],
  ['T05B', 'Correctif — lecture isSuperAdmin sur AdminUserRow, et test du filtre de visibilité de setActionCompletion', 3, 'sonnet', ['T04', 'T05'], '3C', '0.5M'],
  ['T06', 'Recette — parcours croisé, répétition de la migration sur dump prod, build, docs', 4, 'sonnet', ['T03', 'T04', 'T05'], '4A', '2.6M'],
  ['T06B', 'Restauration de répétition gardée — script versionné et test sur dump synthétique', 4, 'sonnet', ['T06'], '4A', '1.2M'],
  ['T06C', 'Test de non-affichage des données par rehearsal-restore.sh', 4, 'sonnet', ['T06B'], '4A', '0.5M'],
  ['T07', 'Revue globale — sécurité des droits, invariants, données prod, cohérence', 4, 'opus', ['T06', 'T06B', 'T06C'], '4B', '2.6M'],
  ['T08', "Restauration de répétition atomique sur erreur de lecture, tests d'ON_ERROR_STOP et du filtre", 4, 'sonnet', ['T07'], '4C', '1.2M'],
  ['T09', 'Admin cloisonné — test versionné du périmètre, suppression de canAdminister, affectation de notion transactionnelle', 4, 'sonnet', ['T07'], '4C', '2.1M'],
  ['T10', 'Docs de reprise — déploiement avec répétition gardée, règle ADMIN_EMAILS, purge des copies locales', 4, 'sonnet', ['T08', 'T09'], '4D', '0.3M'],
].map(([id, title, phase, model, depends_on, batch, estimate]) => ({ id, title, phase, model, depends_on, batch, estimate }))
const PILOT_HANDOFF = `# HANDOFF — acces-par-metier

Entries: \`deviation\`, \`blind-spot\`, \`decision\`, \`debt\`, \`needs-human\`, rated \`minor\` or \`major\`.

## source plan

review · major · .env.example : vérifier SESSION_SECRET avant la PR

## T00

decision · minor · snapshot de typecheck.sh sous $TMPDIR
blocker · major · e2e : 95 passed / 1 failed

## T01

deviation · major · teams: [] ajouté aux fixtures de notions-editor.test.tsx
- review · major · docs/DEPLOY.md : relire la procédure de sauvegarde
`
const tableLines = text => { const l = text.split('\n'), h = l.findIndex(x => x.startsWith('| ID')); let f = h; while (l[f + 1] && l[f + 1].startsWith('|')) f++; return { l, h, f } }
const cellsOf = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())

async function main() {
  // ─── Pilot ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const P = repo('acces-par-metier', { tasks: PILOT, progress: PILOT_PROGRESS, handoff: PILOT_HANDOFF })

  await test('rebuild without progress.json: PROGRESS.md, HANDOFF.md and plan-lint; PROGRESS.md and checkout untouched', () => {
    assert.ok(!existsSync(join(P.d, 'progress.json')))
    const r = P.progress('run-start', { ...RUN, phase: 4, mode: 'auto', parallelism: 1, max_auto_decisions: 2 })
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, 'progress: run 1 opened (phase 4, mode auto)')
    assert.equal(P.read('PROGRESS.md'), PILOT_PROGRESS, 'a run start does not touch PROGRESS.md')
    assert.equal(P.clean(), '', 'progress.json is ignored by git')
    const doc = P.doc()
    assert.equal(doc.format, 'orchestre-progress/3')
    assert.deepEqual([doc.plan, doc.dir, doc.integration, doc.base], ['acces-par-metier', 'plans/acces-par-metier', 'plan/acces-par-metier', null])
    assert.deepEqual(doc.tasks.map(t => t.id), ['T00', 'T01', 'T00B', 'T02', 'T03', 'T04', 'T05', 'T05B', 'T06', 'T06B', 'T06C', 'T07', 'T08', 'T09', 'T10'], 'order of the rows of PROGRESS.md')
    const t = id => doc.tasks.find(x => x.id === id)
    assert.equal(t('T00').title, 'Outillage — scripts de vérification', 'the short title of PROGRESS.md stays')
    assert.deepEqual([t('T00').attempts, t('T00').branch, t('T00').actual_tokens, t('T00').token_estimate, t('T00').batch], [3, 'tache/T00', 'see /workflows', 1.2, '1A'])
    assert.equal(t('T00B').actual_tokens, null)
    assert.deepEqual(t('T07').depends_on, ['T06', 'T06B', 'T06C'], 'the frontmatter is the source of truth')
    assert.ok(doc.tasks.every(x => x.status === 'merged' && x.step === null && x.added_by === null && x.waiting.length === 0))
    assert.deepEqual(doc.runs.map(x => [x.number, x.status, x.phase, x.mode, x.end]), [[1, 'in-progress', 4, 'auto', null]])
    assert.deepEqual(doc.reviews.map(x => [x.task, x.phase, x.run, x.at]), [[null, null, null, null], ['T01', 1, null, null]])
    assert.equal(doc.reviews[1].text, 'docs/DEPLOY.md : relire la procédure de sauvegarde')
    assert.deepEqual(doc.handoff['source plan'], { review: { minor: 0, major: 1 } })
    assert.deepEqual(doc.handoff.T00, { decision: { minor: 1, major: 0 }, blocker: { minor: 0, major: 1 } })
    assert.deepEqual(doc.lint, { ok: true, errors: [] })
    assert.match(doc.log[0].text, /^progress\.json rebuilt from PROGRESS\.md, HANDOFF\.md and plan-lint/)
    assert.match(doc.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    assert.equal(P.progress('validate').code, 0)
  })

  await test("view: the table of the pilot's PROGRESS.md is regenerated, the text around it kept byte for byte", () => {
    const before = tableLines(PILOT_PROGRESS)
    const output = P.progress('view', undefined, { args: ['--stdout'] })
    assert.equal(output.code, 0, output.err)
    assert.equal(P.read('PROGRESS.md'), PILOT_PROGRESS, '--stdout writes nothing')
    const r = P.progress('view')
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, 'progress: PROGRESS.md regenerated (15 tasks)')
    const text = P.read('PROGRESS.md'), after = tableLines(text)
    assert.equal(text, output.out + '\n', '--stdout shows what will be written')
    assert.equal(after.l.slice(0, after.h).join('\n'), before.l.slice(0, before.h).join('\n'), 'text before the table')
    assert.equal(after.l.slice(after.f + 1).join('\n'), before.l.slice(before.f + 1).join('\n'), 'text after the table')
    const t0 = before.l.slice(before.h, before.f + 1), t1 = after.l.slice(after.h, after.f + 1)
    assert.equal(t1.length, 17)
    assert.equal(new Set(t1.map(width)).size, 1, 'all the rows of the table have the same width')
    assert.match(t1[1], /^\| -{4} \| -+ \| -+ /, 'separator in the style of the file, ID at the width of T00B')
    assert.deepEqual(cellsOf(t1[0]), cellsOf(t0[0]), 'header')
    // Whitespace diff only, except the two wrong cells: T07 "Depends on" and T10 "0.3 M"
    for (let i = 2; i < t0.length; i++) {
      const a = cellsOf(t0[i]), b = cellsOf(t1[i])
      if (a[0] === 'T07') { assert.equal(b[4], 'T06, T06B, T06C'); a[4] = b[4] }
      if (a[0] === 'T10') { assert.equal(b[9], '0.3M / see /workflows'); a[9] = b[9] }
      assert.deepEqual(b, a, `row ${a[0]}`)
    }
    assert.ok(P.lint().tasks.every(x => x.status === 'merged'), 'plan-lint rereads the view')
    assert.equal(P.progress('view').code, 0)
    assert.equal(P.read('PROGRESS.md'), text, 'regenerating twice changes nothing')
  })

  // ─── Plan status, as status.mjs ─────────────────────────────────────────────────────────────────────────────────
  const elsewhere = temp('progress-wt-')
  const E8 = { T01: 1, T02: 1, T03: 2, T04: 2, T05: 2, T06: 2, T07: 3, T08: 3 }
  const B = repo('demo', {
    tasks: Object.entries(E8).map(([id, phase]) => ({ id, phase, ...(id === 'T04' ? { prerequisites: 'D5' } : {}) })),
    progress: `| ID | Title | Phase | Status | Attempts | Branch |\n|----|-------|-------|--------|----------|--------|\n${Object.entries(E8).map(([id, ph]) => `| ${id} | Task ${id} | ${ph} | ${id === 'T06' ? 'needs-human' : id === 'T08' ? 'cancelled' : 'todo'} | 0 | — |`).join('\n')}\n`,
    prerequisites: '| ID | Type | Prerequisite | Status | Evidence |\n|----|------|--------------|--------|----------|\n| D5 | decision | Choose the model | open | — |\n',
    handoff: '# Handoff\n\n## T01\n- review · major · agents/x/.env.example: add MR_MAX\n- ticket · minor · rename the script\n\n## T02\nreview · major · command `grep -q X a` refused to agents\n',
    config: { base_branch: 'main' },
  })
  for (const id of ['T01', 'T02']) {
    B.git('switch', '-qc', `task/${id}`); writeFileSync(join(B.root, `${id}.txt`), id); B.git('add', '.'); B.git('commit', '-qm', `feat: ${id}`)
    B.git('switch', '-q', 'plan/demo'); B.git('merge', '-q', '--no-ff', `task/${id}`, '-m', `task ${id}: Task ${id}`)
  }
  B.git('switch', '-qc', 'task/T03'); writeFileSync(join(B.root, 'T03.txt'), 'T03'); B.git('add', '.'); B.git('commit', '-qm', 'feat: T03'); B.git('switch', '-q', 'plan/demo')
  B.git('branch', 'task/T06')
  B.git('worktree', 'add', '-q', '-b', 'task/T05', join(elsewhere, 'wt'), 'plan/demo')
  const statusMjs = (args = [B.plan]) => spawnSync(process.execPath, [STATUS_MJS, ...args], { cwd: B.root, encoding: 'utf8' }).stdout.trim()

  await test('status: same content as status.mjs, without progress.json then after a closed run; read-only', () => {
    const expected = statusMjs()
    assert.match(expected, /^## demo — 2\/7 tasks · 28%/)
    let r = B.progress('status')
    assert.equal(r.code, 0)
    assert.equal(r.out, expected)
    assert.equal(B.progress('status', undefined, { arg: null }).out, statusMjs([]), 'without an argument, the only plan')
    assert.ok(!existsSync(join(B.d, 'progress.json')), 'status writes nothing')
    assert.equal(B.progress('run-start', { ...RUN, phase: 2 }).code, 0)
    assert.deepEqual(B.doc().tasks.filter(t => t.status === 'merged').map(t => t.id), ['T01', 'T02'], 'git is the source of truth: commits "task <id>: " on the integration branch')
    assert.equal(B.progress('run-end', { status: 'partial', waiting: ['T06'], waiting_on_prerequisites: [{ id: 'T04', prerequisites: ['D5'] }] }).code, 0)
    r = B.progress('status')
    assert.equal(r.out, statusMjs(), 'with a progress.json without a run in progress')
    assert.equal(B.clean(), '')
    const doc = B.doc()
    assert.deepEqual(doc.runs[0].waiting_on_prerequisites, [{ id: 'T04', prerequisites: ['D5'] }])
    assert.deepEqual(doc.tasks.find(t => t.id === 'T04').waiting, ['D5'], 'T04 waits for D5')
    assert.deepEqual(doc.prerequisites, [{ id: 'D5', type: 'decision', status: 'open', text: 'Choose the model', blocks: ['T04'] }])
    assert.equal(statusMjs(), expected, 'status.mjs unchanged by the progress file')
    assert.equal(B.progress('status', undefined, { arg: 'plans/missing' }).out, 'orchestre:status: plan not found in this checkout: plans/missing')
  })

  await test('status during a run: the step of each task, a rerun task leaves "Your turn"', () => {
    assert.equal(B.progress('run-start', { ...RUN, phase: 2, mode: 'auto' }).code, 0)
    assert.equal(B.progress('step', { task: 'T03', step: 'worker', isolated: true }).code, 0)
    assert.equal(B.progress('step', { task: 'T03', step: 'verification' }).code, 0)
    assert.equal(B.progress('step', { task: 'T06', step: 'worker', isolated: false }).code, 0)
    const r = B.progress('status').out
    assert.match(r.split('\n')[1], / · run 2 \(auto\) opened just now$/)
    assert.match(r, /\*\*In progress\*\*: T03 \(verification, worktree, started just now\) · T05 \(worktree, started\) · T06 \(worker, checkout, started just now\)$/m)
    assert.ok(!r.includes('T06 waits for a human'), r)
    assert.ok(r.includes('**Your turn**: D5 (decision) blocks T04 · 2 reviews before the PR · 1 ticket after the PR'), r)
    assert.equal(B.progress('run-end', { status: 'partial' }).code, 0)
    assert.equal(B.progress('status').out, statusMjs(), 'run closed: like status.mjs again')
  })

  // ─── Writes ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const IDS = ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08']
  const C = repo('demo', { tasks: IDS.map(id => ({ id, batch: '1A' })), progress: PROGRESS_TEMPLATE(IDS), handoff: '# HANDOFF — demo\n' })
  const tC = id => C.doc().tasks.find(t => t.id === id)
  const progressRow = id => C.read('PROGRESS.md').split('\n').find(l => l.startsWith(`| ${id} `))

  await test('run-start, steps and close: clean checkout during the run, PROGRESS.md regenerated at the close only', () => {
    assert.equal(C.progress('run-start', RUN).out, 'progress: run 1 opened (phase 1, mode phase)')
    const view0 = C.read('PROGRESS.md')
    assert.equal(C.progress('step', { task: 'T01', step: 'worker', isolated: false }).out, 'progress: T01 → worker')
    for (const e of ['verification', 'evaluation']) assert.equal(C.progress('step', { task: 'T01', step: e }).code, 0)
    assert.equal(C.progress('step', { task: 'T01', step: 'fix', rejection: { attempt: 1, by: 'evaluation', gaps: ['wrong comment on the flag'] } }).code, 0)
    assert.equal(C.progress('step', { task: 'T01', step: 'merge' }).code, 0)
    assert.equal(C.clean(), '', 'a step only touches progress.json, ignored by git')
    assert.equal(C.read('PROGRESS.md'), view0)
    let t = tC('T01')
    assert.deepEqual([t.step, t.isolated, t.attempts, t.end, t.rejections], ['merge', false, 2, null, [{ attempt: 1, by: 'evaluation', gaps: ['wrong comment on the flag'] }]])
    assert.match(t.start, /^\d{4}-\d{2}-\d{2}T/)
    const r = C.progress('close', { task: 'T01', status: 'merged', attempts: 2, branch: 'task/T01', replanning: true, reviews: ['agents/x/.env.example: add MR_MAX'] })
    assert.equal(r.out, 'progress: T01 merged; PROGRESS.md regenerated')
    t = tC('T01')
    assert.deepEqual([t.status, t.step, t.attempts, t.branch, t.actual_tokens], ['merged', null, 2, 'task/T01', 'see /workflows'])
    assert.ok(t.end >= t.start)
    assert.equal(progressRow('T01'), '| T01 | Task T01 | 1     | 1A    | —          | sonnet | merged | 2        | task/T01 | 1.0M / see /workflows |')
    assert.match(C.read('PROGRESS.md').split('\n')[3], /^\|-+\|-+\|/, 'compact separator of the template kept')
    assert.equal(C.clean(), ' M plans/demo/PROGRESS.md\n', 'only PROGRESS.md is to commit')
    assert.equal(C.lint().tasks.find(x => x.id === 'T01').status, 'merged')
    const doc = C.doc()
    assert.deepEqual(doc.reviews, [{ task: 'T01', phase: 1, text: 'agents/x/.env.example: add MR_MAX', run: 1, at: t.end }])
    assert.deepEqual([...new Set(doc.log.map(e => e.kind))], ['run', 'task', 'step', 'rejection', 'status', 'review'])
    assert.ok(doc.log.some(e => e.text === 'T01: replanning finished'))
    assert.ok(doc.log.some(e => e.text === 'T01: attempt 1 rejected (evaluation): 1 gap(s)'))
    assert.equal(C.progress('validate').code, 0)
    C.git('commit', '-qam', 'progress(T01): merged')
  })

  await test('call from a worktree: progress.json and PROGRESS.md of the main checkout', () => {
    const wt = join(temp('progress-wt-'), 'wt')
    C.git('worktree', 'add', '-q', '-b', 'task/T02', wt, 'plan/demo')
    mkdirSync(join(wt, 'src'))
    assert.equal(C.progress('step', { task: 'T02', step: 'worker', isolated: true }, { cwd: wt }).code, 0)
    assert.equal(C.progress('step', { task: 'T02', step: 'verification' }, { cwd: join(wt, 'src'), arg: '../plans/demo' }).code, 0)
    assert.ok(!existsSync(join(wt, 'plans', 'demo', 'progress.json')))
    assert.deepEqual([tC('T02').step, tC('T02').isolated], ['verification', true])
    const viewWt = readFileSync(join(wt, 'plans', 'demo', 'PROGRESS.md'), 'utf8')
    assert.equal(C.progress('close', { task: 'T02', status: 'blocked', attempts: 1, branch: 'task/T02', blocker: ['npm test: 2 failures'] }, { cwd: wt }).code, 0)
    assert.match(progressRow('T02'), /\| blocked +\| 1 +\| task\/T02 \|/)
    assert.equal(readFileSync(join(wt, 'plans', 'demo', 'PROGRESS.md'), 'utf8'), viewWt, 'the PROGRESS.md of the worktree does not move')
    assert.deepEqual(tC('T02').blocker, ['npm test: 2 failures'])
    C.git('commit', '-qam', 'progress(T02): blocked')
  })

  await test('8 writes in parallel, without loss or lock left', async () => {
    const before = C.doc().log.length
    const rs = await Promise.all(IDS.map(id => C.launch('step', { task: id, step: 'worker', isolated: true })))
    assert.ok(rs.every(r => r.code === 0), rs.map(r => r.err).join('\n'))
    const doc = C.doc()
    assert.ok(doc.tasks.every(t => t.step === 'worker' && t.isolated === true))
    assert.deepEqual([doc.tasks[0].attempts, doc.tasks[0].rejections, doc.tasks[0].end], [1, [], null], 'a new worker starts again at 1 attempt')
    assert.equal(doc.log.length - before, 8)
    assert.deepEqual(doc.log.slice(-8).map(e => e.task).sort(), IDS)
    assert.deepEqual(C.leftovers(), [])
    assert.equal(C.progress('validate').code, 0)
  })

  await test('invalid write refused: code 1 or 2, progress.json and PROGRESS.md untouched', () => {
    const before = [C.read('progress.json'), C.read('PROGRESS.md')]
    const refused = [
      ['step', { task: 'T03', step: 'nap' }, 1, /tasks\[\d\]\.step: "nap" is not allowed/],
      ['step', { task: 'T99', step: 'worker' }, 1, /unknown task in progress: T99/],
      ['close', { task: 'T03', status: 'merged', attempts: -1, branch: 'task/T03' }, 1, /attempts: -1 is less than 0/],
      ['close', { task: 'T03', status: 'in-progress', attempts: 1 }, 1, /status "in-progress" not allowed/],
      ['close', { task: 'T03', status: 'merged', attempts: 1, rejections: [{ attempt: 1, by: 'mood', gaps: [] }] }, 1, /rejections\[0\]\.by/],
      ['close', { task: 'T03', status: 'fusionnée', attempts: 1 }, 1, /status "fusionnée" not allowed/],
      ['run-start', { ...RUN, mode: 'turbo' }, 1, /runs\[\d\]\.mode: "turbo"/],
      ['run-start', { ...RUN, mode: 'devia' }, 1, /runs\[\d\]\.mode: "devia" is not allowed \(auto, deviation, phase\)/],
      ['run-start', { phase: 1, mode: 'phase' }, 1, /parallelism: missing/],
      ['run-end', { status: 'in-progress' }, 1, /unknown status "in-progress" \(finished, partial, awaiting-ruling, rerun, error\)/],
      ['pilot', { task: 'T03', status: 'blocked' }, 1, /not allowed \(merged or cancelled\)/],
      ['step', 'not JSON', 2, /invalid JSON/],
      ['step', '', 2, /JSON object expected/],
      ['etape', { task: 'T03', step: 'worker' }, 2, /^progress: usage/],
      ['unknown', {}, 2, /^progress: usage/],
    ]
    for (const [cmd, E, code, pattern] of refused) {
      const r = C.progress(cmd, E)
      assert.equal(r.code, code, `${cmd} ${JSON.stringify(E)}: ${r.err}`)
      assert.match(r.err, pattern)
    }
    assert.deepEqual([C.read('progress.json'), C.read('PROGRESS.md')], before)
    assert.deepEqual(C.leftovers(), [])
    assert.equal(C.progress('validate').code, 0)
  })

  await test('run left in progress: interrupted at the start of the next run, steps reset, statuses reread', () => {
    // Gap between progress.json and PROGRESS.md: at the start of a run, PROGRESS.md and git are the source of truth
    const gap = C.doc(); gap.tasks.find(t => t.id === 'T02').status = 'todo'
    writeFileSync(join(C.d, 'progress.json'), JSON.stringify(gap, null, 2) + '\n')
    const r = C.progress('run-start', RUN)
    assert.equal(r.out, 'progress: run 2 opened (phase 1, mode phase)')
    const doc = C.doc()
    assert.deepEqual(doc.runs.map(x => [x.number, x.status, x.end]), [[1, 'interrupted', null], [2, 'in-progress', null]])
    assert.ok(doc.tasks.every(t => t.step === null))
    assert.ok(doc.log.some(e => e.kind === 'run' && e.text === 'run 1 interrupted: left in progress, without a run end'))
    assert.deepEqual(doc.tasks.filter(t => t.status !== 'todo').map(t => [t.id, t.status]), [['T01', 'merged'], ['T02', 'blocked']], 'statuses reread from PROGRESS.md')
    assert.ok(doc.log.some(e => e.kind === 'status' && e.text === 'T02: todo → blocked (PROGRESS.md and git)'))
  })

  await test('added tasks: after the one that created them and its tasks already born; issues, ruling, auto-decisions', () => {
    C.writeTask({ id: 'T03B', phase: 1, depends_on: ['T03'], estimate: '0.5M' })
    let r = C.progress('close', {
      task: 'T03', status: 'merged', attempts: 1, branch: 'task/T03',
      added_tasks: [{ id: 'T03B', title: 'Follow-up of T03', phase: 1 }],
      issues: [{ title: 'Guard on the flag', context: 'the flag is optional', human: false, options: [{ id: 'A', description: 'Add a test', impact: 'low', recommended: true, entries: [{ type: 'debt', severity: 'minor', description: 'x' }], added_tasks: [] }, { id: 'B', description: 'Accept' }] }],
      auto_decisions: [{ title: 'Retry threshold', option: 'A', description: 'cap at 30 s' }],
    })
    assert.equal(r.code, 0, r.err)
    C.writeTask({ id: 'T03C', phase: 1, depends_on: ['T03'] })
    r = C.progress('ruling', { task: 'T03', title: 'Guard on the flag', option: { id: 'A', description: 'Add a test' }, added_tasks: [{ id: 'T03C', title: 'Test of the flag', phase: 1 }] })
    assert.equal(r.out, 'progress: ruling T03 option A; PROGRESS.md regenerated')
    C.writeTask({ id: 'T03D', phase: 1, depends_on: ['T03B'] })
    assert.equal(C.progress('close', { task: 'T03B', status: 'merged', attempts: 1, branch: 'task/T03B', added_tasks: [{ id: 'T03D', title: 'Follow-up of T03B', phase: 1 }] }).code, 0)
    // Scribe called again: no duplicate
    assert.equal(C.progress('close', { task: 'T03B', status: 'merged', attempts: 1, branch: 'task/T03B', added_tasks: [{ id: 'T03D', title: 'Follow-up of T03B', phase: 1 }] }).code, 0)
    const doc = C.doc()
    const order = ['T01', 'T02', 'T03', 'T03B', 'T03D', 'T03C', 'T04', 'T05', 'T06', 'T07', 'T08']
    assert.deepEqual(doc.tasks.map(t => t.id), order)
    assert.deepEqual(C.read('PROGRESS.md').split('\n').filter(l => /^\| T\d/.test(l)).map(l => cellsOf(l)[0]), order)
    assert.deepEqual(['T03B', 'T03C', 'T03D'].map(id => [doc.tasks.find(t => t.id === id).status, doc.tasks.find(t => t.id === id).added_by]), [['merged', 'T03'], ['added', 'T03'], ['added', 'T03B']])
    assert.deepEqual(doc.tasks.find(t => t.id === 'T03D').waiting, [])
    assert.deepEqual(doc.tasks.find(t => t.id === 'T03C').depends_on, ['T03'])
    assert.equal(cellsOf(progressRow('T03B'))[9], '0.5M / see /workflows')
    assert.equal(cellsOf(progressRow('T03C'))[1], 'Test of the flag')
    const L = C.lint()
    assert.deepEqual(['T03C', 'T03D'].map(id => L.tasks.find(t => t.id === id).status), ['added', 'added'])
    assert.deepEqual(doc.issues, [{ run: 2, task: 'T03', title: 'Guard on the flag', context: 'the flag is optional', human: false, role: 'open', status: 'settled', chosen_option: 'A', options: [{ id: 'A', description: 'Add a test', impact: 'low', recommended: true }, { id: 'B', description: 'Accept' }] }])
    assert.deepEqual(doc.auto_decisions, [{ run: 2, task: 'T03', title: 'Retry threshold', option: 'A', description: 'cap at 30 s' }])
    const run = doc.runs[1]
    assert.deepEqual(run.rulings_applied, [{ task: 'T03', title: 'Guard on the flag', option: 'A' }])
    assert.deepEqual(run.added_tasks.map(x => x.id), ['T03B', 'T03C', 'T03D'])
    assert.equal(doc.log.filter(e => e.kind === 'added' && e.task === 'T03D').length, 2)
    assert.ok(doc.log.some(e => e.kind === 'auto-decision' && e.text === 'T03: "Retry threshold", option A taken automatically'))
    assert.ok(doc.log.some(e => e.kind === 'ruling' && e.text === 'T03: "Guard on the flag" settled, option A'))
    C.git('add', '-A'); C.git('commit', '-qm', 'progress(T03B): merged')
  })

  await test('run end: summary, the workflow exception closes the task, stop issue', () => {
    assert.equal(C.progress('step', { task: 'T04', step: 'worker', isolated: false }).code, 0)
    assert.equal(C.progress('step', { task: 'T05', step: 'worker', isolated: true }).code, 0)
    const view0 = C.read('PROGRESS.md')
    const stop = { task: 'T05', title: 'Post-merge check failed after T05', context: 'npm test', human: true, options: [{ id: 'repair', description: 'Repair', impact: '', recommended: true, entries: [] }] }
    const r = C.progress('run-end', {
      status: 'awaiting-ruling', phase: 1, mode: 'phase', stop_issue: stop, open_issues: [],
      tasks: [{ id: 'T04', status: 'failed', attempts: 0, branch: null, summary: 'Error: boom', blocker: ['workflow error: Error: boom'] }],
      not_started: ['T06', 'T07', 'T08'], deferred: [], added_tasks: [{ id: 'T03B', phase: 1, title: 'Follow-up of T03' }], rulings_applied: [{ task: 'T03', title: 'Guard on the flag', option: 'A' }],
      auto_decisions: [{ task: 'T03', title: 'Retry threshold', option: 'A', description: 'cap at 30 s' }], discarded_amendments: [{ task: 'T03', id: 'T01', reason: 'already merged', definition_of_done: ['x'] }],
      waiting: [], waiting_on_prerequisites: [],
    })
    assert.equal(r.out, 'progress: run 2 awaiting-ruling; PROGRESS.md regenerated, to commit')
    const doc = C.doc(), run = doc.runs[1]
    // Added tasks: the summary (a single one) completes those of the run (three, one of them from a ruling the summary does not know), without replacing them
    assert.deepEqual([run.status, run.not_started, run.discarded_amendments, run.added_tasks.map(x => x.id)], ['awaiting-ruling', ['T06', 'T07', 'T08'], [{ task: 'T03', id: 'T01', reason: 'already merged' }], ['T03B', 'T03C', 'T03D']])
    assert.ok(run.end >= run.start)
    const t4 = doc.tasks.find(t => t.id === 'T04'), t5 = doc.tasks.find(t => t.id === 'T05')
    assert.deepEqual([t4.status, t4.step, t4.blocker], ['failed', null, ['workflow error: Error: boom']])
    assert.deepEqual([t5.status, t5.step], ['todo', null], 'step without a close reset')
    assert.notEqual(C.read('PROGRESS.md'), view0)
    assert.match(progressRow('T04'), /\| failed +\| 0 +\|/)
    assert.equal(doc.auto_decisions.length, 1, 'decision already noted by the scribe: no duplicate')
    const p = doc.issues.find(x => x.role === 'stop')
    assert.deepEqual([p.task, p.human, p.status, p.options.map(o => Object.keys(o).sort().join())], ['T05', true, 'open', ['description,id,impact,recommended']])
    assert.ok(doc.log.some(e => e.kind === 'issue' && e.text === 'T05: issue "Post-merge check failed after T05", which stops the run'))
    assert.ok(doc.log.some(e => e.text === 'T04: failed, closed at the run end without a scribe — workflow error: Error: boom'))
    assert.ok(doc.log.some(e => e.text === 'T05: step "worker" without a close at the end of the run'))
    assert.equal(C.progress('run-end', { status: 'finished' }).code, 1, 'no run in progress any more')
    C.git('commit', '-qam', 'progress(T04): failed')
  })

  await test('pilot: merged and cancelled by hand, PROGRESS.md regenerated', () => {
    assert.equal(C.progress('pilot', { task: 'T04', status: 'merged', reason: 'fixed by hand, evaluation OK' }).out, 'progress: T04 merged; PROGRESS.md regenerated, to commit')
    assert.equal(C.progress('pilot', { task: 'T08', status: 'cancelled', reason: 'out of scope' }).code, 0)
    const L = C.lint()
    assert.deepEqual(['T04', 'T08'].map(id => L.tasks.find(t => t.id === id).status), ['merged', 'cancelled'])
    assert.ok(C.doc().log.some(e => e.kind === 'pilot' && e.text === 'T08: cancelled by the pilot — out of scope'))
  })

  await test('--json: same effect as standard input, text escaped as the workflow writes it; added task without a file skipped', () => {
    const gaps = ["the option `--force` costs $5", 'quotes "double", backslash \\ and accents éèà']
    const raw = JSON.stringify({ task: 'T07', step: 'fix', rejection: { attempt: 1, by: 'evaluation', gaps } })
    // Escaping of the workflow: nothing that closes or interprets single quotes
    const escaped = raw.replace(/'/g, '\\u0027').replace(/`/g, '\\u0060').replace(/\$/g, '\\u0024')
    assert.ok(!/['`$]/.test(escaped))
    const r = C.progress('step', undefined, { args: ['--json', escaped] })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(tC('T07').rejections, [{ attempt: 1, by: 'evaluation', gaps }])
    // Through the shell, inside single quotes, as an agent's command
    const sh = spawnSync('sh', ['-c', `"${process.execPath}" "${PROGRESS_MJS}" step ${C.plan} --json '${escaped}'`], { cwd: C.root, encoding: 'utf8' })
    assert.equal(sh.status, 0, sh.stderr)
    assert.deepEqual(tC('T07').rejections.map(x => x.gaps), [gaps, gaps])
    assert.equal(C.progress('step', undefined, { args: ['--json'] }).code, 2)
    const inv = C.progress('step', undefined, { args: ['--json', '{x'] })
    assert.deepEqual([inv.code, /--json: invalid JSON/.test(inv.err)], [2, true])
    // Added task whose file the scribe removed (plan-lint refusal, which it reports on its side): skipped and noted, the rest written
    const a = C.progress('ruling', { task: 'T03', title: 'Threshold', option: 'B', added_tasks: [{ id: 'T03Z', title: 'Refused by plan-lint', phase: 1 }] })
    assert.equal(a.code, 0, a.err)
    assert.equal(a.out, 'progress: ruling T03 option B; PROGRESS.md regenerated; not added, without a task file: T03Z')
    const doc = C.doc()
    assert.ok(!doc.tasks.some(t => t.id === 'T03Z') && !C.read('PROGRESS.md').includes('T03Z'))
    assert.ok(doc.log.some(e => e.kind === 'error' && e.task === 'T03Z'))
    assert.ok(doc.log.some(e => e.kind === 'ruling' && e.task === 'T03'))
    assert.equal(C.progress('validate').code, 0)
  })

  await test('log: 200 events at most, log_omitted counts those that leave', () => {
    const doc = C.doc()
    doc.log = Array.from({ length: 199 }, (_, i) => ({ at: doc.updated, kind: 'step', task: null, text: `old ${i}` }))
    doc.log_omitted = 5
    writeFileSync(join(C.d, 'progress.json'), JSON.stringify(doc, null, 2) + '\n')
    assert.equal(C.progress('step', { task: 'T05', step: 'verification' }).code, 0)
    let j = C.doc()
    assert.deepEqual([j.log.length, j.log_omitted, j.log[0].text], [200, 5, 'old 0'])
    assert.equal(C.progress('close', { task: 'T05', status: 'blocked', attempts: 1, branch: 'task/T05', reviews: ['a: reread', 'b: reread'] }).code, 0)
    j = C.doc()
    assert.deepEqual([j.log.length, j.log_omitted, j.log[0].text], [200, 8, 'old 3'])
    assert.equal(j.log[199].kind, 'review')
    assert.equal(C.progress('validate').code, 0)
  })

  await test('progress.json lost: rebuilt at the first write; unknown format refused', () => {
    C.git('add', '-A'); C.git('commit', '-qm', 'progress')
    unlinkSync(join(C.d, 'progress.json'))
    assert.equal(C.progress('step', { task: 'T06', step: 'worker', isolated: false }).code, 0)
    let doc = C.doc()
    assert.deepEqual(doc.tasks.map(t => [t.id, t.status]), [['T01', 'merged'], ['T02', 'blocked'], ['T03', 'merged'], ['T03B', 'merged'], ['T03D', 'added'], ['T03C', 'added'], ['T04', 'merged'], ['T05', 'blocked'], ['T06', 'todo'], ['T07', 'todo'], ['T08', 'cancelled']])
    assert.deepEqual([doc.runs, doc.issues, doc.tasks.find(t => t.id === 'T03C').added_by], [[], [], null], 'the run fields start empty again')
    assert.equal(doc.tasks.find(t => t.id === 'T06').step, 'worker')
    writeFileSync(join(C.d, 'progress.json'), JSON.stringify({ ...doc, format: 'orchestre-progress/4' }))
    const before = C.read('progress.json')
    const r = C.progress('step', { task: 'T06', step: 'verification' })
    assert.equal(r.code, 1)
    assert.equal(r.err, 'progress: progress.json is in format orchestre-progress/4, this reader reads orchestre-progress/3, orchestre-suivi/2, orchestre-suivi/1')
    assert.equal(C.progress('validate').code, 1)
    assert.equal(C.read('progress.json'), before)
    // PROGRESS.md with a status written by hand outside the 7: the rebuild names the row
    unlinkSync(join(C.d, 'progress.json'))
    writeFileSync(join(C.d, 'PROGRESS.md'), C.read('PROGRESS.md').replace(/(\| T07 .*?\| )todo /, '$1in-progress '))
    const e = C.progress('step', { task: 'T07', step: 'worker' })
    assert.equal(e.code, 1)
    assert.match(e.err, /PROGRESS\.md, line \d+: unknown status "in-progress" for T07/)
    assert.ok(!existsSync(join(C.d, 'progress.json')))
    doc = null
  })

  await test('run end: an added task of the summary missing from progress (close not written) gets in, with the task that created it', () => {
    const F = repo('end', { tasks: [{ id: 'T01' }, { id: 'T02' }], progress: PROGRESS_TEMPLATE(['T01', 'T02']) })
    assert.equal(F.progress('run-start', RUN).code, 0)
    F.writeTask({ id: 'T02B', phase: 1, depends_on: ['T02'] })
    assert.equal(F.progress('ruling', { task: 'T02', title: 'Guard', option: 'A', added_tasks: [{ id: 'T02B', title: 'Guard of the flag', phase: 1 }] }).code, 0)
    // Created by the scribe of T01, whose close was not written
    F.writeTask({ id: 'T01B', phase: 1, depends_on: ['T01'] })
    const r = F.progress('run-end', { status: 'awaiting-ruling', tasks: [{ id: 'T01', status: 'merged', attempts: 1, branch: 'task/T01' }], added_tasks: [{ id: 'T01B', phase: 1, title: 'Follow-up of T01', added_by: 'T01' }, { id: 'not an id', phase: 1, title: 'x' }] })
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, 'progress: run 1 awaiting-ruling; PROGRESS.md regenerated, to commit')
    const doc = F.doc()
    assert.deepEqual(doc.runs[0].added_tasks.map(x => x.id), ['T02B', 'T01B'])
    assert.deepEqual(doc.tasks.map(t => [t.id, t.status, t.added_by]), [['T01', 'merged', null], ['T01B', 'added', 'T01'], ['T02', 'todo', null], ['T02B', 'added', 'T02']])
    assert.ok(/\| T01B \| Follow-up of T01 /.test(F.read('PROGRESS.md')))
    assert.equal(F.progress('validate').code, 0)
  })

  await test('view between two runs: a task merged by hand (commit "task <id>: " without progress.mjs pilot) becomes "merged"; "tâche <id> : " of 0.11 too', () => {
    const V = repo('view', { tasks: [{ id: 'T01' }, { id: 'T02' }], progress: PROGRESS_TEMPLATE(['T01', 'T02']) })
    assert.equal(V.progress('run-start', RUN).code, 0)
    V.git('commit', '-q', '--allow-empty', '-m', 'task T01: Task T01')
    V.git('commit', '-q', '--allow-empty', '-m', 'tâche T02 : Tâche T02')
    assert.deepEqual(V.lint().tasks.map(t => t.status), ['merged', 'merged'], 'plan-lint reads git')
    assert.match(V.progress('view', undefined, { args: ['--stdout'] }).out, /\| T01 .*\| merged \|/)
    assert.equal(V.progress('view').code, 0)
    assert.match(V.read('PROGRESS.md').split('\n').find(l => l.startsWith('| T01 ')), /\| merged \|/)
    assert.equal(V.doc().tasks.find(t => t.id === 'T01').status, 'merged')
    assert.ok(V.doc().log.some(e => e.text === 'T01: todo → merged (PROGRESS.md and git)'))
    assert.ok(V.doc().log.some(e => e.text === 'T02: todo → merged (PROGRESS.md and git)'))
  })

  await test('plan-lint without an answer (output cut): no rebuild; existing progress.json, plan fields kept and a note in the log (0.8.1)', () => {
    const F = repo('lintko', { tasks: [{ id: 'T01' }, { id: 'T02', estimate: '2.5M' }], progress: PROGRESS_TEMPLATE(['T01', 'T02']) })
    // Copy of the script next to a plan-lint that returns a cut JSON, as in a pipe before 0.8.1
    const bin = temp('lint-cut-')
    writeFileSync(join(bin, 'progress.mjs'), readFileSync(PROGRESS_MJS, 'utf8'))
    writeFileSync(join(bin, 'plan-lint.mjs'), "process.stdout.write('{\\n  \"ok\": true,\\n  \"tasks\": [')\n")
    const cut = (cmd, E) => { const r = spawnSync(process.execPath, [join(bin, 'progress.mjs'), cmd, F.plan, '--json', JSON.stringify(E)], { cwd: F.root, encoding: 'utf8' }); return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() } }
    const before = F.read('PROGRESS.md')
    const r1 = cut('run-start', RUN)
    assert.equal(r1.code, 1, r1.out + r1.err)
    assert.match(r1.err, /plan-lint returned no state \(\{\): progress\.json missing, it cannot be rebuilt without plan-lint/)
    assert.ok(!existsSync(join(F.d, 'progress.json'))); assert.equal(F.read('PROGRESS.md'), before); assert.deepEqual(F.leftovers(), [])
    assert.equal(F.progress('run-start', RUN).code, 0)
    assert.equal(cut('step', { task: 'T01', step: 'worker', isolated: false }).code, 0)
    const r2 = cut('close', { task: 'T01', status: 'blocked', attempts: 1, branch: 'task/T01', blocker: ['x'] })
    assert.equal(r2.code, 0, r2.err)
    const doc = F.doc()
    assert.deepEqual(doc.tasks.map(t => [t.id, t.status, t.token_estimate]), [['T01', 'blocked', 1], ['T02', 'todo', 2.5]])
    assert.equal(doc.lint.ok, false)
    assert.equal(doc.log.filter(e => e.kind === 'error' && /plan-lint returned no state/.test(e.text)).length, 1, 'a single note, not one per write')
    assert.match(F.read('PROGRESS.md').split('\n').find(l => l.startsWith('| T02 ')), /\| 2\.5M \/ — +\|/)
    assert.match(F.read('PROGRESS.md').split('\n').find(l => l.startsWith('| T01 ')), /\| blocked +\| 1 +\| task\/T01 +\| 1\.0M \//)
    assert.equal(F.progress('validate').code, 0)
  })

  await test('task rows written under the legend (scribe 0.6.3): taken back into the table, with their cells; impoverished progress.json repaired (0.8.1)', () => {
    const text = `# PROGRESS — orph

| ID  | Title | Phase | Batch | Depends on | Model | Status | Attempts | Branch | Tokens est. / actual |
|-----|-------|-------|-------|------------|-------|--------|----------|--------|----------------------|
| T01 | Short | 1     | 1A    | —          | sonnet | merged | 1      | task/T01 | — / see /workflows |

Statuses: todo · added · merged · blocked · failed · needs-human · cancelled
| T01B | Added by the scribe | 1 | 1B | T01 | sonnet | merged | 3 | task/T01B-r2 | 0.5M / see /workflows |
| T02 | Next | 2 | 2A | T01 | sonnet | todo | 0 | — | 1.0M / — |
`
    const F = repo('orph', { tasks: [{ id: 'T01' }, { id: 'T01B', depends_on: ['T01'], estimate: '0.5M' }, { id: 'T02', phase: 2, depends_on: ['T01'] }], progress: text })
    assert.deepEqual(F.lint().tasks.map(t => [t.id, t.status]), [['T01', 'merged'], ['T01B', 'merged'], ['T02', 'todo']], 'plan-lint already reads the rows under the legend')
    // State left by a 0.8.0 whose plan-lint was cut: progress.json without T01B or T02, estimates erased
    assert.equal(F.progress('run-start', RUN).code, 0)
    const d = F.doc()
    d.tasks = d.tasks.filter(t => t.id === 'T01').map(t => ({ ...t, token_estimate: null }))
    writeFileSync(join(F.d, 'progress.json'), JSON.stringify(d, null, 2) + '\n')
    writeFileSync(join(F.d, 'PROGRESS.md'), text)
    const r = F.progress('view')
    assert.equal(r.code, 0, r.err)
    const doc = F.doc()
    assert.deepEqual(doc.tasks.map(t => [t.id, t.title, t.status, t.attempts, t.branch, t.token_estimate]), [
      ['T01', 'Short', 'merged', 1, 'task/T01', 1], ['T01B', 'Added by the scribe', 'merged', 3, 'task/T01B-r2', 0.5], ['T02', 'Next', 'todo', 0, null, 1]])
    const lines = F.read('PROGRESS.md').split('\n')
    const legend = lines.findIndex(l => l.startsWith('Statuses:'))
    for (const id of ['T01', 'T01B', 'T02']) {
      const where = lines.map((l, i) => (l.startsWith(`| ${id} `) ? i : -1)).filter(i => i >= 0)
      assert.equal(where.length, 1, `${id} only once`); assert.ok(where[0] < legend, `${id} in the table, before the legend`)
    }
    assert.equal(lines.slice(legend + 1).filter(l => l.startsWith('|')).length, 0)
    assert.match(lines.find(l => l.startsWith('| T01B ')), /\| task\/T01B-r2 +\| 0\.5M \/ see \/workflows +\|/)
    assert.equal(F.lint().ok, true)
    assert.equal(F.progress('validate').code, 0)
    // A row under the legend whose ID is not a task of the plan stays text
    writeFileSync(join(F.d, 'PROGRESS.md'), F.read('PROGRESS.md') + '| T99 | unknown | 1 | — | — | sonnet | todo | 0 | — | — / — |\n')
    assert.equal(F.progress('view').code, 0)
    assert.equal(F.read('PROGRESS.md').split('\n').filter(l => l.startsWith('| T99 ')).length, 1)
    // Without progress.json: a table of notes under the legend stays text; a row that repeats T02 replaces it, in its place
    rmSync(join(F.d, 'progress.json'))
    const notes = '\n## Pilot notes\n\n| ID | Note |\n|----|------|\n| T01 | rerun by hand on 07/10 |\n| D1 | settled: option B |\n'
    writeFileSync(join(F.d, 'PROGRESS.md'), text.replace('| T02 | Next | 2 | 2A | T01 | sonnet | todo | 0 | — | 1.0M / — |\n', '| T02 | Next | 2 | 2A | T01 | sonnet | todo | 0 | — | 1.0M / — |\n| T02 | Next, taken back | 2 | 2A | T01 | sonnet | merged | 4 | task/T02 | 1.0M / see /workflows |\n') + notes)
    const r2 = F.progress('run-start', RUN)
    assert.equal(r2.code, 0, r2.err)
    assert.deepEqual(F.doc().tasks.map(t => [t.id, t.status, t.attempts]), [['T01', 'merged', 1], ['T01B', 'merged', 3], ['T02', 'merged', 4]])
    assert.equal(F.progress('view').code, 0)
    const end = F.read('PROGRESS.md')
    assert.ok(end.endsWith(notes), 'pilot notes kept byte for byte')
    assert.equal(end.split('\n').filter(l => l.startsWith('| T02 ')).length, 1)
  })

  // ─── Model planned by the plan, model used ───────────────────────────────────────────────────────────────────────
  await test('model used: noted by the worker and each fix, change in the log; inconsistent change refused', () => {
    const M = repo('models', { tasks: [{ id: 'T01', model: 'sonnet', reason: 'simple implementation' }, { id: 'T02', model: 'opus' }], progress: PROGRESS_TEMPLATE(['T01', 'T02']) })
    assert.equal(M.progress('run-start', RUN).code, 0)
    const t = id => M.doc().tasks.find(x => x.id === id)
    assert.deepEqual([t('T01').model, t('T01').model_used, t('T02').model], ['sonnet', null, 'opus'], 'null before the worker')
    assert.equal(M.progress('step', { task: 'T01', step: 'worker', isolated: false, model: 'sonnet' }).out, 'progress: T01 → worker (sonnet)')
    assert.equal(t('T01').model_used, 'sonnet')
    assert.equal(M.progress('step', { task: 'T01', step: 'verification' }).code, 0)
    assert.equal(t('T01').model_used, 'sonnet', 'a step without a model keeps it')
    const R = { attempt: 1, by: 'evaluation', gaps: ['architecture to rework'] }
    const c = M.progress('step', { task: 'T01', step: 'fix', rejection: R, model: 'opus', change: { from: 'sonnet', to: 'opus', reason: 'missing architecture' } })
    assert.equal(c.code, 0, c.err)
    let doc = M.doc()
    assert.equal(t('T01').model_used, 'opus'); assert.equal(t('T01').model, 'sonnet', 'the model of the plan does not move')
    assert.deepEqual(doc.log.filter(e => e.task === 'T01').slice(-3).map(e => [e.kind, e.text]), [
      ['rejection', 'T01: attempt 1 rejected (evaluation): 1 gap(s)'], ['model', 'T01: sonnet → opus (missing architecture)'], ['step', 'T01: fix (attempt 2)']])
    // Fix on the same model: no event
    assert.equal(M.progress('step', { task: 'T01', step: 'fix', rejection: { ...R, attempt: 2 }, model: 'opus' }).code, 0)
    assert.equal(M.doc().log.filter(e => e.kind === 'model').length, 1)
    // Inconsistent or malformed change: refused, file untouched
    const before = M.read('progress.json')
    for (const E of [{ model: 'opus', change: { from: 'opus', to: 'haiku', reason: 'x' } }, { model: '' }, { change: 'opus' }, { change: { from: 'opus', reason: 'x' } }]) {
      const r = M.progress('step', { task: 'T01', step: 'fix', ...E })
      assert.equal(r.code, 1, JSON.stringify(E)); assert.match(r.err, /^progress: step: /)
    }
    assert.equal(M.read('progress.json'), before)
    // Change without model: the target model is model_used; from absent: "—"
    assert.equal(M.progress('step', { task: 'T01', step: 'fix', change: { to: 'sonnet', reason: '' } }).code, 0)
    assert.deepEqual([t('T01').model_used, M.doc().log.filter(e => e.kind === 'model').pop().text], ['sonnet', 'T01: — → sonnet'])
    // A new worker (next run) starts again from the model it launches
    assert.equal(M.progress('run-start', RUN).code, 0)
    assert.equal(M.progress('step', { task: 'T01', step: 'worker', isolated: true, model: 'sonnet' }).code, 0)
    assert.equal(t('T01').model_used, 'sonnet')
    assert.equal(M.progress('step', { task: 'T02', step: 'worker', isolated: true }).code, 0)
    assert.equal(t('T02').model_used, null, 'worker without a model: null')
    assert.equal(M.progress('validate').code, 0)
    assert.equal(M.clean(), '', 'the model used only touches progress.json')
  })

  await test('task without a model: enters progress with model null, "—" in PROGRESS.md, reread as is', () => {
    const S = repo('nomodel', { tasks: [{ id: 'T01', model: null }, { id: 'T02' }], progress: PROGRESS_TEMPLATE(['T01', 'T02']).replace('| T01 | Task T01 | 1 | 1A | — | sonnet |', '| T01 | Task T01 | 1 | 1A | — | — |') })
    assert.equal(S.lint().ok, true, 'plan-lint: a warning, not an error')
    assert.equal(S.progress('run-start', RUN).code, 0)
    assert.deepEqual(S.doc().tasks.map(t => [t.id, t.model, t.model_used]), [['T01', null, null], ['T02', 'sonnet', null]])
    assert.ok(!S.doc().log.some(e => e.kind === 'error'), 'no "not added to progress"')
    assert.equal(S.progress('step', { task: 'T01', step: 'worker', isolated: false, model: 'sonnet' }).code, 0)
    assert.equal(S.progress('close', { task: 'T01', status: 'merged', attempts: 1, branch: 'task/T01' }).code, 0)
    const l = S.read('PROGRESS.md').split('\n').find(x => x.startsWith('| T01 '))
    assert.deepEqual(cellsOf(l).slice(5, 7), ['—', 'merged'], 'Model "—", not "null" nor empty')
    // Rebuild from PROGRESS.md: "—" reread as null; a frontmatter that gains a model gives it to the progress file
    rmSync(join(S.d, 'progress.json'))
    S.writeTask({ id: 'T01', model: 'haiku' })
    assert.equal(S.progress('view', undefined, { args: ['--stdout'] }).code, 0)
    S.writeTask({ id: 'T01', model: null })
    assert.equal(S.progress('view').code, 0)
    assert.equal(S.doc().tasks[0].model, null)
    assert.equal(cellsOf(S.read('PROGRESS.md').split('\n').find(x => x.startsWith('| T01 ')))[5], '—')
    S.writeTask({ id: 'T01', model: 'haiku' })
    assert.equal(S.progress('view').code, 0)
    assert.equal(S.doc().tasks[0].model, 'haiku')
    // A frontmatter that loses its model: null in the existing progress file, not the old value
    S.writeTask({ id: 'T01', model: null })
    assert.equal(S.progress('view').code, 0)
    assert.equal(S.doc().tasks[0].model, null)
    // Task without a model and without a row in PROGRESS.md (created by a scribe): it enters progress, without an error in the log
    S.writeTask({ id: 'T03', model: null })
    assert.equal(S.progress('view').code, 0)
    assert.deepEqual(S.doc().tasks.map(t => [t.id, t.model]), [['T01', null], ['T02', 'sonnet'], ['T03', null]])
    assert.ok(!S.doc().log.some(e => e.kind === 'error'), 'no "not added to progress"')
    // Status read: nothing breaks without a model
    assert.equal(S.progress('status').code, 0)
    assert.equal(S.progress('validate').code, 0)
  })

  // ─── Formats of orchestre 0.11 and earlier ───────────────────────────────────────────────────────────────────────
  // A suivi.json as a 0.11 would have written it, in French, renamed progress.json; /1 as a 0.10 would have written it
  const legacyV2 = at => ({
    format: 'orchestre-suivi/2', plan: 'legacy', dossier: 'plans/legacy', integration: 'plan/legacy', base: null, maj: at,
    taches: [
      { id: 'T01', titre: 'Tâche T01', phase: 1, lot: '1A', depend_de: [], modele: 'sonnet', modele_utilise: 'opus', statut: 'fusionnée', essais: 2, branche: 'tache/T01', estimation_tokens: 1, tokens_reels: 'voir /workflows', ajoutee_par: null, etape: null, isole: false, debut: at, fin: at, attend: [], refus: [{ essai: 1, par: 'évaluation', manques: ['commentaire faux'] }], instables: [], non_verifiables: [], blocage: [] },
      { id: 'T02', titre: 'Tâche T02', phase: 1, lot: null, depend_de: ['T01'], modele: 'sonnet', modele_utilise: 'sonnet', statut: 'à-faire', essais: 1, branche: null, estimation_tokens: null, tokens_reels: null, ajoutee_par: null, etape: 'correction', isole: true, debut: at, fin: null, attend: [], refus: [], instables: ['e2e'], non_verifiables: [], blocage: [] },
    ],
    runs: [{ numero: 1, run_id: null, phase: 1, mode: 'devia', parallelisme: 2, corrections_max: 2, decisions_office_max: 3, statut: 'en-cours', debut: at, fin: null, detail: null, arbitrages_appliques: [{ tache: 'T01', titre: 'Garde', option: 'A' }], amendements_ecartes: [{ tache: 'T01', id: 'T02', raison: 'déjà là' }], taches_ajoutees: [], reportees: [], non_lancees: ['T02'], en_attente: [], en_attente_prerequis: [{ id: 'T02', prerequis: ['D5'] }] }],
    points: [{ run: 1, tache: 'T01', titre: 'Garde', contexte: 'le flag', humain: true, role: 'arret', statut: 'tranché', option_choisie: 'A', coupe_circuit: true, options: [{ id: 'A', description: 'Ajouter un test', impact: 'faible', recommande: true }] }],
    decisions_office: [{ run: 1, tache: 'T01', titre: 'Seuil', option: 'B', description: '30 s' }],
    relectures: [{ tache: null, phase: null, texte: '.env.example : relire', run: null, quand: null }],
    prerequis: [{ id: 'D5', type: 'décision', statut: 'ouvert', texte: 'Choisir', bloque: ['T02'] }],
    handoff: { 'plan source': { relecture: { mineur: 0, majeur: 1 } }, T01: { écart: { mineur: 1, majeur: 0 } } },
    lint: { ok: true, erreurs: [] },
    journal: [{ quand: at, genre: 'tache', tache: 'T01', texte: 'T01 démarre (checkout principal)' }, { quand: at, genre: 'decision-office', tache: 'T01', texte: '« Seuil », option B' }],
    journal_omis: 3,
  })

  await test('format orchestre-suivi/2 of 0.11 (French): read and validated as is, written in /3 at the first write, keys and values translated, free text kept', () => {
    const G = repo('legacy', { tasks: [{ id: 'T01' }, { id: 'T02', depends_on: ['T01'] }], progress: PROGRESS_TEMPLATE(['T01', 'T02']) })
    const at = '2026-10-01T10:00:00+02:00', v2 = legacyV2(at)
    writeFileSync(join(G.d, 'progress.json'), JSON.stringify(v2, null, 2) + '\n')
    const val = G.progress('validate')
    assert.equal(val.code, 0, val.err)
    assert.equal(val.out, 'progress: progress.json valid (orchestre-suivi/2, converted to orchestre-progress/3 at the next write, 2 tasks, 1 run)')
    assert.equal(G.progress('status').code, 0)
    assert.equal(G.read('progress.json'), JSON.stringify(v2, null, 2) + '\n', 'reading and validation write nothing')
    // An invalid /2 stays refused
    writeFileSync(join(G.d, 'progress.json'), JSON.stringify({ ...v2, taches: [{ ...v2.taches[0], statut: 'peut-être' }] }))
    assert.match(G.progress('validate').err, /tasks\[0\]\.status: "peut-être" is not allowed/)
    writeFileSync(join(G.d, 'progress.json'), JSON.stringify(v2, null, 2) + '\n')
    const r = G.progress('step', { task: 'T02', step: 'verification' })
    assert.equal(r.code, 0, r.err)
    const doc = G.doc()
    assert.equal(doc.format, 'orchestre-progress/3')
    assert.deepEqual([doc.plan, doc.dir], ['legacy', 'plans/legacy'])
    const t1 = doc.tasks[0], t2 = doc.tasks[1]
    assert.deepEqual([t1.title, t1.status, t1.attempts, t1.branch, t1.actual_tokens, t1.model_used, t1.rejections], ['Tâche T01', 'merged', 2, 'tache/T01', 'see /workflows', 'opus', [{ attempt: 1, by: 'evaluation', gaps: ['commentaire faux'] }]], 'French free text kept: title, gaps; branch of git history kept')
    assert.deepEqual([t2.step, t2.isolated, t2.flaky, t2.waiting], ['verification', true, ['e2e'], []], 'T02 waits for nothing: T01 merged, and plan-lint knows no D5 (no PREREQUISITES.md)')
    assert.deepEqual(doc.prerequisites, [], 'prerequisites derived from plan-lint')
    assert.deepEqual(doc.handoff, {}, 'handoff counts derived from HANDOFF.md, empty here')
    const run = doc.runs[0]
    assert.deepEqual([run.number, run.mode, run.status, run.parallelism, run.max_fixes, run.max_auto_decisions], [1, 'deviation', 'in-progress', 2, 2, 3], 'the run in progress continues')
    assert.deepEqual([run.rulings_applied, run.discarded_amendments, run.not_started, run.waiting_on_prerequisites], [[{ task: 'T01', title: 'Garde', option: 'A' }], [{ task: 'T01', id: 'T02', reason: 'déjà là' }], ['T02'], [{ id: 'T02', prerequisites: ['D5'] }]])
    assert.deepEqual(doc.issues, [{ run: 1, task: 'T01', title: 'Garde', context: 'le flag', human: true, role: 'stop', status: 'settled', chosen_option: 'A', circuit_breaker: true, options: [{ id: 'A', description: 'Ajouter un test', impact: 'faible', recommended: true }] }])
    assert.deepEqual(doc.auto_decisions, [{ run: 1, task: 'T01', title: 'Seuil', option: 'B', description: '30 s' }])
    assert.deepEqual(doc.reviews, [{ task: null, phase: null, text: '.env.example : relire', run: null, at: null }])
    assert.equal(doc.log_omitted, 3)
    assert.deepEqual(doc.log.slice(0, 3).map(e => [e.kind, e.text]), [['task', 'T01 démarre (checkout principal)'], ['auto-decision', '« Seuil », option B'], ['run', 'progress.json converted from orchestre-suivi/2 to orchestre-progress/3']])
    assert.equal(G.progress('step', { task: 'T02', step: 'evaluation' }).code, 0)
    assert.equal(G.doc().log.filter(e => /converted/.test(e.text)).length, 1, 'only once')
    assert.equal(G.progress('validate').out, 'progress: progress.json valid (orchestre-progress/3, 2 tasks, 1 run)')
  })

  await test('format orchestre-suivi/1 of 0.10: converted too, model used null, with a note', () => {
    const G = repo('legacy1', { tasks: [{ id: 'T01' }, { id: 'T02', depends_on: ['T01'] }], progress: PROGRESS_TEMPLATE(['T01', 'T02']) })
    const at = '2026-10-01T10:00:00+02:00', v2 = legacyV2(at)
    const v1 = { ...v2, format: 'orchestre-suivi/1', taches: v2.taches.map(({ modele_utilise, ...t }) => t) }
    writeFileSync(join(G.d, 'progress.json'), JSON.stringify(v1, null, 2) + '\n')
    assert.equal(G.progress('validate').out, 'progress: progress.json valid (orchestre-suivi/1, converted to orchestre-progress/3 at the next write, 2 tasks, 1 run)')
    assert.equal(G.progress('step', { task: 'T02', step: 'verification' }).code, 0)
    const doc = G.doc()
    assert.deepEqual(doc.tasks.map(t => [t.id, t.model, t.model_used]), [['T01', 'sonnet', null], ['T02', 'sonnet', null]])
    assert.equal(doc.log.filter(e => e.text === 'progress.json converted from orchestre-suivi/1 to orchestre-progress/3: model used unknown until now').length, 1)
  })

  await test('plan in the French format of 0.11 (taches/): refused with the migrate.mjs command, nothing written', () => {
    const root = temp('progress-fr-')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    mkdirSync(join(root, 'plans', 'fr', 'taches'), { recursive: true })
    for (const [args, code] of [[['run-start', 'plans/fr', '--json', JSON.stringify(RUN)], 2], [['step'], 2]]) {
      const r = spawnSync(process.execPath, [PROGRESS_MJS, ...args], { cwd: root, encoding: 'utf8' })
      assert.equal(r.status, code, r.stderr)
      assert.match(r.stderr, /^progress: plan in the French format of orchestre 0\.11 and earlier \(taches\/\): migrate it with node ".*\/migrate\.mjs" plans\/fr\n$/)
    }
    const st = spawnSync(process.execPath, [PROGRESS_MJS, 'status'], { cwd: root, encoding: 'utf8' })
    assert.equal(st.status, 0); assert.match(st.stdout, /^orchestre:status: plan in the French format/)
    assert.deepEqual(readdirSync(join(root, 'plans', 'fr')), ['taches'])
  })

  console.log(`progress: ALL GREEN (${n} tests)`)
}

try { await main() } finally { for (const d of temporaries) rmSync(d, { recursive: true, force: true }) }
