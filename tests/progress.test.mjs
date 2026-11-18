// Tests of progress.mjs (progress.json in format orchestre-progress/4, conversion of /3 and of the formats of 0.11 and earlier, issue register ISSUES.json, rulings recorded, view
// PROGRESS.md), in temporary git repositories.
// Usage: node tests/progress.test.mjs [path of progress.mjs]
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, unlinkSync, utimesSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
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
    assert.equal(doc.format, 'orchestre-progress/4')
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
    prerequisites: '| ID | Type | Prerequisite | Status | Evidence |\n|----|------|--------------|--------|----------|\n| D5 | decision | Choose the model | open | — |\n\n## D5 · how\n1. Compare the two models.\n2. Answer /orchestre:ready.\n',
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
    assert.deepEqual(doc.prerequisites, [{ id: 'D5', type: 'decision', status: 'open', text: 'Choose the model', evidence: '—', how: ['Compare the two models.', 'Answer /orchestre:ready.'], blocks: ['T04'] }], 'the evidence and the steps of "## D5 · how" (0.17.0)')
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
    assert.ok(r.endsWith('\n\n**At run stop**: D5 (decision) blocks T04\n**Later**: 2 reviews after phase 1 · 1 ticket after the PR'), r)
    assert.equal(B.progress('run-end', { status: 'partial' }).code, 0)
    assert.equal(B.progress('status').out, statusMjs(), 'run closed: like status.mjs again')
  })

  await test('status: git wins over a stale progress.json, and an unknown progress.json is ignored, the same moment lines as status.mjs', () => {
    const f = join(B.d, 'progress.json')
    const keep = readFileSync(f, 'utf8')
    const moments = out => out.split('\n').filter(l => /^\*\*(Now|At run stop|Later|Your turn)\*\*/.test(l))
    // progress.mjs writes the reason of an unreadable file at the end of **Now**; status.mjs says nothing about it
    const noNote = out => out.replace(/ · progress\.json: [^\n]*/, '')
    const stale = JSON.parse(keep)
    stale.tasks = stale.tasks.map(t => (t.id === 'T01' ? { ...t, status: 'needs-human' } : t))
    writeFileSync(f, JSON.stringify(stale))
    let r = B.progress('status').out
    assert.match(r, /^## demo — 2\/7 tasks/, 'T01 merged in git, needs-human in the file')
    assert.ok(!moments(r).join('\n').includes('T01'), r)
    assert.deepEqual(moments(r), moments(statusMjs()))
    for (const raw of [JSON.stringify({ ...JSON.parse(keep), format: 'orchestre-progress/2' }), '{ not json']) {
      writeFileSync(f, raw)
      r = B.progress('status')
      assert.equal(r.code, 0)
      assert.deepEqual(moments(noNote(r.out)), moments(statusMjs()))
      assert.equal(noNote(r.out), statusMjs())
    }
    writeFileSync(f, keep)
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
    // 0.20.0: one line of JSON, and the plan committed by close itself
    const o = JSON.parse(r.out)
    assert.deepEqual({ ...o, commit: typeof o.commit, digest: typeof o.digest }, { task: 'T01', status: 'merged', commit: 'string', rejected: [], discarded: [], issues: [], pending: [], message: `T01 merged; PROGRESS.md regenerated; committed ${o.commit.slice(0, 7)}`, digest: 'string' })
    assert.equal(C.git('log', '-1', '--format=%H %s'), `${o.commit} progress(T01): merged\n`)
    t = tC('T01')
    assert.deepEqual([t.status, t.step, t.attempts, t.branch, t.actual_tokens], ['merged', null, 2, 'task/T01', 'see /workflows'])
    assert.ok(t.end >= t.start)
    assert.equal(progressRow('T01'), '| T01 | Task T01 | 1     | 1A    | —          | sonnet | merged | 2        | task/T01 | 1.0M / see /workflows |')
    assert.match(C.read('PROGRESS.md').split('\n')[3], /^\|-+\|-+\|/, 'compact separator of the template kept')
    assert.equal(C.clean(), '', 'PROGRESS.md committed by close (0.20.0)')
    assert.equal(C.git('show', '--name-only', '--format=', 'HEAD'), 'plans/demo/PROGRESS.md\n', 'only PROGRESS.md changed: no entry for HANDOFF.md')
    assert.equal(C.lint().tasks.find(x => x.id === 'T01').status, 'merged')
    const doc = C.doc()
    assert.deepEqual(doc.reviews, [{ task: 'T01', phase: 1, text: 'agents/x/.env.example: add MR_MAX', run: 1, at: t.end }])
    assert.deepEqual([...new Set(doc.log.map(e => e.kind))], ['run', 'task', 'step', 'rejection', 'status', 'review'])
    assert.ok(doc.log.some(e => e.text === 'T01: replanning finished'))
    assert.ok(doc.log.some(e => e.text === 'T01: attempt 1 rejected (evaluation): 1 gap(s)'))
    assert.equal(C.progress('validate').code, 0)
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
    // The main checkout is committed, never the worktree: the blocker in HANDOFF.md of the main checkout
    assert.equal(C.clean(), '')
    assert.ok(C.read('HANDOFF.md').endsWith('## T02\n\n- blocker · major · npm test: 2 failures\n'), C.read('HANDOFF.md'))
    assert.equal(C.git('log', '-1', '--format=%s'), 'progress(T02): blocked\n')
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
      issues: [{ title: 'Guard on the flag', context: 'the flag is optional', human: false, options: [{ id: 'A', description: 'Add a test', impact: 'low', recommended: true, entries: [{ type: 'debt', severity: 'minor', description: 'x' }], added_tasks: [] }, { id: 'B', description: 'Accept', amendments: [{ id: 'T04', reason: 'r' }, { id: 'T05', reason: 'r' }, { id: 'T04', reason: 'again' }], added_tasks: [{ id: 'T03E', phase: 2 }, { id: 'T03F' }] }] }],
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
    // /4: the issue has its id, each option its effect and the ids it amends; the dry run of close (0.20.0) decides valid:
    // A changes no task, B adds two tasks without their content
    assert.deepEqual(doc.issues, [{ id: 'T03-1', run: 2, task: 'T03', title: 'Guard on the flag', context: 'the flag is optional', human: false, role: 'open', status: 'settled', chosen_option: 'A', options: [
      { id: 'A', description: 'Add a test', impact: 'low', recommended: true, valid: true, invalid_reason: null, effect: 'a note in HANDOFF, no task changes', amends: [] },
      { id: 'B', description: 'Accept', valid: false, invalid_reason: 'dry run: no task file for T03E, and no content to create it; no task file for T03F, and no content to create it', effect: 'amends T04, T05; adds T03E in phase 2, T03F', amends: ['T04', 'T05'] }] }])
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
    assert.deepEqual([p.task, p.human, p.status, p.options.map(o => Object.keys(o).sort().join())], ['T05', true, 'open', ['amends,description,effect,id,impact,invalid_reason,recommended,valid']])
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

  await test('ack (0.15.1): a review or an auto-decision marked done, kept with its date; not brought back by HANDOFF.md nor by a close; refusals', () => {
    // Reviews as the scribe and HANDOFF.md leave them
    const seeded = C.doc()
    seeded.reviews = [{ task: 'T03', phase: 1, text: 'agents/x/.env.example: add MR_MAX', run: 2, at: null }, { task: 'T03', phase: 1, text: 'docs/DEPLOY.md: relire', run: 2, at: null }, { task: null, phase: null, text: 'README: relire', run: null, at: null }]
    writeFileSync(join(C.d, 'progress.json'), JSON.stringify(seeded, null, 2) + '\n')
    writeFileSync(join(C.d, 'HANDOFF.md'), '## source plan\n- review · minor · README: relire\n')
    const view = C.read('PROGRESS.md')
    let r = C.progress('ack', { kind: 'review', task: 'T03', text: 'agents/x/.env.example: add MR_MAX' })
    assert.deepEqual([r.code, r.out], [0, 'progress: review of T03 done; it leaves "Your turn"'], r.err)
    assert.equal(C.read('PROGRESS.md'), view, 'PROGRESS.md untouched')
    // A unique start, the source plan as "-"; again: nothing changes
    assert.equal(C.progress('ack', { kind: 'review', task: '-', text: 'README' }).code, 0)
    assert.equal(C.progress('ack', { kind: 'review', task: null, text: 'README: relire' }).out, 'progress: review of the source plan already done')
    // The decision, by its title
    assert.equal(C.progress('ack', { kind: 'decision', task: 'T03', text: 'Retry threshold' }).out, 'progress: auto-decision of T03 done; it leaves "Your turn"')
    let doc = C.doc()
    assert.deepEqual(doc.reviews.map(x => !!x.done), [true, false, true])
    assert.ok(doc.auto_decisions.every(x => typeof x.done === 'string'))
    assert.ok(doc.log.some(e => e.kind === 'pilot' && e.task === 'T03' && e.text === 'review of T03 done by the pilot: agents/x/.env.example: add MR_MAX'))
    assert.equal(C.progress('validate').code, 0)
    // The next run reads HANDOFF.md again: the review done is not brought back; status counts the one left open
    assert.equal(C.progress('run-start', RUN).code, 0)
    assert.equal(C.progress('close', { task: 'T03', status: 'merged', attempts: 1, branch: 'task/T03', reviews: ['agents/x/.env.example: add MR_MAX'] }).code, 0)
    doc = C.doc()
    assert.deepEqual([doc.reviews.length, doc.reviews.filter(x => !x.done).map(x => x.text)], [3, ['docs/DEPLOY.md: relire']])
    assert.ok(C.progress('status').out.includes('1 review after phase 1'))
    assert.equal(C.progress('run-end', { status: 'finished' }).code, 0)
    // Refusals: nothing written
    const before = C.read('progress.json')
    for (const [E, re] of [
      [{ kind: 'issue', task: 'T03', text: 'x' }, /kind "issue" not allowed/],
      [{ kind: 'review', task: 'T03', text: '' }, /text expected/],
      [{ kind: 'review', task: 'T03', text: 'nothing like it' }, /no review of T03 "nothing like it"/],
      [{ kind: 'review', task: 'bad', text: 'x' }, /not a task id/],
    ]) {
      r = C.progress('ack', E)
      assert.equal(r.code, 1, JSON.stringify(E)); assert.match(r.err, re)
    }
    seeded.reviews = [{ task: 'T05', phase: 1, text: 'a.env: x', run: 2, at: null }, { task: 'T05', phase: 1, text: 'a.env: y', run: 2, at: null }]
    writeFileSync(join(C.d, 'progress.json'), JSON.stringify({ ...JSON.parse(before), reviews: seeded.reviews }, null, 2) + '\n')
    r = C.progress('ack', { kind: 'review', task: 'T05', text: 'a.env' })
    assert.equal(r.code, 1); assert.match(r.err, /2 reviews of T05 start with "a.env": give the whole text/)
    writeFileSync(join(C.d, 'progress.json'), before)
    // HANDOFF.md, rewritten above, went into the commit of the close of T03 (0.20.0)
    assert.equal(C.clean(), '')
  })

  await test('ack in a list, ticket, reopen, relabel (0.16.0): one write, all or nothing; not brought back by HANDOFF.md nor a close; status counts the tickets', () => {
    const saved = C.read('progress.json'), handoff = C.read('HANDOFF.md')
    const seeded = JSON.parse(saved)
    seeded.reviews = [
      { task: 'T03', phase: 1, text: 'a.env.example: add A', run: 2, at: null },
      { task: 'T03', phase: 1, text: 'b.env.example: add B', run: 2, at: null },
      { task: 'T03', phase: 1, text: 'docs/DEPLOY.md: read again', run: 2, at: null },
      { task: null, phase: null, text: 'README: relire', run: null, at: null },
    ]
    seeded.auto_decisions = [{ run: 2, task: 'T03', title: 'Retry threshold', option: 'A', description: 'cap at 30 s' }]
    writeFileSync(join(C.d, 'progress.json'), JSON.stringify(seeded, null, 2) + '\n')
    writeFileSync(join(C.d, 'HANDOFF.md'), '## source plan\n- review · minor · README: relire\n- ticket · minor · monitoring of the retries\n')
    // A list: one write, one log line per item
    let r = C.progress('ack', { items: [{ kind: 'review', task: 'T03', text: 'a.env.example: add A' }, { kind: 'decision', task: 'T03', text: 'Retry threshold' }, { kind: 'review', task: 'T03', text: 'a.env.example: add A' }] })
    assert.deepEqual([r.code, r.out], [0, 'progress: 2 done; they leave "Your turn"; 1 already closed'], r.err)
    let doc = C.doc()
    assert.deepEqual([doc.reviews.map(x => !!x.done), !!doc.auto_decisions[0].done], [[true, false, false, false], true])
    // A list with one item unknown: refused whole, nothing written
    const kept = C.read('progress.json')
    r = C.progress('ack', { items: [{ kind: 'review', task: 'T03', text: 'b.env.example: add B' }, { kind: 'review', task: 'T03', text: 'nothing like it' }] })
    assert.equal(r.code, 1); assert.match(r.err, /ack: no review of T03 "nothing like it"/)
    assert.equal(C.read('progress.json'), kept, 'all or nothing')
    for (const [E, re] of [[{ items: [] }, /"items" must be a non-empty list/], [{ items: ['x'] }, /each item is an object/]]) {
      r = C.progress('ack', E); assert.equal(r.code, 1, JSON.stringify(E)); assert.match(r.err, re)
    }
    // Ticket: it leaves "Your turn"; an item already done stays done
    r = C.progress('ticket', { kind: 'review', task: 'T03', text: 'b.env' })
    assert.deepEqual([r.code, r.out], [0, 'progress: review of T03 moved to tickets; it leaves "Your turn"'], r.err)
    assert.equal(C.progress('ticket', { kind: 'review', task: 'T03', text: 'a.env.example: add A' }).out, 'progress: review of T03 already done')
    assert.equal(C.progress('ack', { kind: 'review', task: 'T03', text: 'b.env.example: add B' }).out, 'progress: review of T03 already moved to tickets')
    doc = C.doc()
    assert.equal(typeof doc.reviews[1].ticket, 'string'); assert.equal(doc.reviews[1].done, undefined)
    assert.ok(doc.log.some(e => e.kind === 'pilot' && e.text === 'review of T03 moved to tickets by the pilot: b.env.example: add B'))
    // status: one review left open, besides the source plan's; the ticket of HANDOFF.md and the one moved
    const st = C.progress('status').out
    assert.ok(st.includes('1 review after phase 1 · 1 review before the PR'), st); assert.ok(st.includes('2 tickets after the PR'), st)
    // Relabel: the text shown changes, the key stays; null goes back to the original
    r = C.progress('relabel', { kind: 'review', task: 'T03', text: 'docs/DEPLOY.md: read again', label: '  docs/DEPLOY.md: read   again (done in GitHub)  ' })
    assert.deepEqual([r.code, r.out], [0, 'progress: review of T03: text changed; HANDOFF.md keeps the original'], r.err)
    doc = C.doc()
    assert.deepEqual([doc.reviews[2].text, doc.reviews[2].label], ['docs/DEPLOY.md: read again', 'docs/DEPLOY.md: read again (done in GitHub)'])
    assert.equal(C.progress('relabel', { kind: 'review', task: 'T03', text: 'docs/DEPLOY.md', label: null }).out, 'progress: review of T03: original text back')
    assert.equal(C.doc().reviews[2].label, undefined)
    assert.equal(C.progress('relabel', { kind: 'review', task: 'T03', text: 'docs/DEPLOY.md', label: 'x' }).code, 0)
    assert.equal(C.progress('relabel', { kind: 'review', task: 'T03', text: 'docs/DEPLOY.md', label: 'docs/DEPLOY.md: read again' }).out, 'progress: review of T03: original text back', 'the original text: no label')
    for (const [E, re] of [[{ items: [{ kind: 'review', task: 'T03', text: 'x' }] }, /one item at a time/], [{ kind: 'review', task: 'T03', text: 'docs/DEPLOY.md', label: 3 }, /"label" must be a text/]]) {
      r = C.progress('relabel', E); assert.equal(r.code, 1, JSON.stringify(E)); assert.match(r.err, re)
    }
    // Reopen: back in "Your turn", from done or from a ticket; an item open stays open
    r = C.progress('reopen', { items: [{ kind: 'review', task: 'T03', text: 'a.env.example: add A' }, { kind: 'review', task: 'T03', text: 'b.env.example: add B' }] })
    assert.deepEqual([r.code, r.out], [0, 'progress: 2 open again; back in "Your turn"'], r.err)
    assert.equal(C.progress('reopen', { kind: 'decision', task: 'T03', text: 'Retry threshold' }).out, 'progress: auto-decision of T03 open again; back in "Your turn"')
    assert.equal(C.progress('reopen', { kind: 'decision', task: 'T03', text: 'Retry threshold' }).out, 'progress: auto-decision of T03 already open')
    doc = C.doc()
    assert.ok([...doc.reviews, ...doc.auto_decisions].every(x => x.done === undefined && x.ticket === undefined))
    // Closed again, then the next run reads HANDOFF.md and a close brings the same review: nothing comes back
    assert.equal(C.progress('ticket', { kind: 'review', task: 'T03', text: 'a.env' }).code, 0)
    assert.equal(C.progress('relabel', { kind: 'review', task: 'T03', text: 'b.env', label: 'b: in GitHub' }).code, 0)
    assert.equal(C.progress('run-start', RUN).code, 0)
    assert.equal(C.progress('close', { task: 'T03', status: 'merged', attempts: 1, branch: 'task/T03', reviews: ['a.env.example: add A', 'b.env.example: add B'] }).code, 0)
    doc = C.doc()
    assert.equal(doc.reviews.length, 4); assert.equal(typeof doc.reviews[0].ticket, 'string'); assert.equal(doc.reviews[1].label, 'b: in GitHub')
    assert.equal(C.progress('run-end', { status: 'finished' }).code, 0)
    assert.equal(C.progress('validate').code, 0)
    writeFileSync(join(C.d, 'progress.json'), saved); writeFileSync(join(C.d, 'HANDOFF.md'), handoff)
  })

  await test('close-plan, reopen-plan (0.16.1): refused during a run or with a task not merged; a run-start opens it again; status says it', () => {
    const saved = C.read('progress.json')
    const doc0 = JSON.parse(saved)
    // A task neither merged nor cancelled: refused, nothing written
    const pending = { ...doc0, runs: doc0.runs.map(x => ({ ...x, status: x.status === 'in-progress' ? 'finished' : x.status })), tasks: doc0.tasks.map((t, i) => ({ ...t, status: i ? 'merged' : 'todo', step: null })) }
    writeFileSync(join(C.d, 'progress.json'), JSON.stringify(pending, null, 2) + '\n')
    const kept = C.read('progress.json')
    let r = C.progress('close-plan', {})
    assert.equal(r.code, 1); assert.match(r.err, new RegExp(`close-plan: 1 task neither merged nor cancelled \\(${doc0.tasks[0].id} todo\\); cancel or merge it first`))
    assert.equal(C.read('progress.json'), kept, 'nothing written')
    // Every task merged, an item left open: closed, the item stays open
    const all = { ...doc0, tasks: doc0.tasks.map(t => ({ ...t, status: t.status === 'cancelled' ? 'cancelled' : 'merged', step: null })), runs: doc0.runs.map(x => ({ ...x, status: x.status === 'in-progress' ? 'finished' : x.status })), reviews: [{ task: null, phase: null, text: 'README: relire', run: null, at: null }], auto_decisions: [] }
    writeFileSync(join(C.d, 'progress.json'), JSON.stringify(all, null, 2) + '\n')
    r = C.progress('close-plan', {})
    assert.deepEqual([r.code, r.out], [0, 'progress: plan closed, 1 item left open (in the PR draft); /progress no longer follows it'], r.err)
    let doc = C.doc()
    assert.equal(typeof doc.closed, 'string'); assert.equal(doc.reviews[0].done, undefined)
    assert.ok(doc.log.some(e => e.kind === 'pilot' && e.task === null && e.text === 'plan closed by the pilot, 1 item left open in "Your turn"'))
    assert.equal(C.progress('close-plan', {}).out, 'progress: plan already closed')
    assert.equal(C.progress('validate').code, 0)
    // Reopen, then closed again
    assert.equal(C.progress('reopen-plan', {}).out, 'progress: plan open again; /progress follows it')
    assert.equal(C.doc().closed, undefined)
    assert.equal(C.progress('reopen-plan', {}).out, 'progress: plan already open')
    assert.equal(C.progress('close-plan', {}).code, 0)
    // A run that starts opens it again; while it runs, closing is refused
    assert.equal(C.progress('run-start', RUN).code, 0)
    doc = C.doc()
    assert.equal(doc.closed, undefined); assert.ok(doc.log.some(e => e.kind === 'run' && e.text === 'plan open again: a run starts'))
    r = C.progress('close-plan', {})
    assert.equal(r.code, 1); assert.match(r.err, /close-plan: run \d+ is in progress; a plan closes between two runs/)
    // status: "plan finished, closed"
    writeFileSync(join(C.d, 'progress.json'), JSON.stringify({ ...all, closed: '2026-11-02T12:00:00+01:00' }, null, 2) + '\n')
    const st = C.progress('status').out
    assert.match(st, /plan finished, closed/, st)
    writeFileSync(join(C.d, 'progress.json'), saved)
  })

  await test('--json: same effect as standard input, text escaped as the workflow of 0.17 wrote it; added task without a file skipped', () => {
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
    assert.equal(C.clean(), '', 'the closes committed the plan (0.20.0)')
    unlinkSync(join(C.d, 'progress.json'))
    assert.equal(C.progress('step', { task: 'T06', step: 'worker', isolated: false }).code, 0)
    let doc = C.doc()
    assert.deepEqual(doc.tasks.map(t => [t.id, t.status]), [['T01', 'merged'], ['T02', 'blocked'], ['T03', 'merged'], ['T03B', 'merged'], ['T03D', 'added'], ['T03C', 'added'], ['T04', 'merged'], ['T05', 'blocked'], ['T06', 'todo'], ['T07', 'todo'], ['T08', 'cancelled']])
    assert.deepEqual([doc.runs, doc.issues, doc.tasks.find(t => t.id === 'T03C').added_by], [[], [], null], 'the run fields start empty again')
    assert.equal(doc.tasks.find(t => t.id === 'T06').step, 'worker')
    writeFileSync(join(C.d, 'progress.json'), JSON.stringify({ ...doc, format: 'orchestre-progress/5' }))
    const before = C.read('progress.json')
    const r = C.progress('step', { task: 'T06', step: 'verification' })
    assert.equal(r.code, 1)
    assert.equal(r.err, 'progress: progress.json is in format orchestre-progress/5, this reader reads orchestre-progress/4, orchestre-progress/3, orchestre-suivi/2, orchestre-suivi/1')
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

  await test('git history of 0.11 in status: a commit "tâche <id> : " is the last merge, a branch tache/<id> is in progress', () => {
    const H = repo('history', { tasks: [{ id: 'T01' }, { id: 'T02' }], progress: PROGRESS_TEMPLATE(['T01', 'T02']) })
    H.git('commit', '-q', '--allow-empty', '-m', 'tâche T01 : Tâche T01')
    H.git('switch', '-qc', 'tache/T02'); writeFileSync(join(H.root, 'T02.txt'), 'T02'); H.git('add', 'T02.txt'); H.git('commit', '-qm', 'feat: T02'); H.git('switch', '-q', 'plan/history')
    const r = H.progress('status').out
    assert.match(r, /^## history — 1\/2 tasks · 50%\n`█{12}░{12}` phase 1 in progress · last merge T01 (just now|\d+ min ago)$/m)
    assert.match(r, /\*\*In progress\*\*: T02 \(last commit (just now|\d+ min ago)\)$/m)
    assert.equal(r, spawnSync(process.execPath, [STATUS_MJS, H.plan], { cwd: H.root, encoding: 'utf8' }).stdout.trim(), 'as status.mjs')
  })

  await test('PROGRESS.md missing: the first write that regenerates the view creates it, with its title, header and legend', () => {
    const N = repo('fresh', { tasks: [{ id: 'T01', batch: '1A' }] })
    assert.equal(N.progress('view').code, 0)
    assert.equal(N.read('PROGRESS.md'), `# PROGRESS — fresh

| ID  | Title    | Phase | Batch | Depends on | Model  | Status | Attempts | Branch | Tokens est. / actual |
|-----|----------|-------|-------|------------|--------|--------|----------|--------|----------------------|
| T01 | Task T01 | 1     | 1A    | —          | sonnet | todo   | 0        | —      | 1.0M / —             |

Statuses: todo · added · merged · blocked · failed · needs-human · cancelled
`)
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
    assert.equal(val.out, 'progress: progress.json valid (orchestre-suivi/2, converted to orchestre-progress/4 at the next write, 2 tasks, 1 run)')
    assert.equal(G.progress('status').code, 0)
    assert.equal(G.read('progress.json'), JSON.stringify(v2, null, 2) + '\n', 'reading and validation write nothing')
    // An invalid /2 stays refused
    writeFileSync(join(G.d, 'progress.json'), JSON.stringify({ ...v2, taches: [{ ...v2.taches[0], statut: 'peut-être' }] }))
    assert.match(G.progress('validate').err, /tasks\[0\]\.status: "peut-être" is not allowed/)
    writeFileSync(join(G.d, 'progress.json'), JSON.stringify(v2, null, 2) + '\n')
    const r = G.progress('step', { task: 'T02', step: 'verification' })
    assert.equal(r.code, 0, r.err)
    const doc = G.doc()
    assert.equal(doc.format, 'orchestre-progress/4')
    assert.deepEqual([doc.plan, doc.dir], ['legacy', 'plans/legacy'])
    const t1 = doc.tasks[0], t2 = doc.tasks[1]
    assert.deepEqual([t1.title, t1.status, t1.attempts, t1.branch, t1.actual_tokens, t1.model_used, t1.rejections], ['Tâche T01', 'merged', 2, 'tache/T01', 'see /workflows', 'opus', [{ attempt: 1, by: 'evaluation', gaps: ['commentaire faux'] }]], 'French free text kept: title, gaps; branch of git history kept')
    assert.deepEqual([t2.step, t2.isolated, t2.flaky, t2.waiting], ['verification', true, ['e2e'], []], 'T02 waits for nothing: T01 merged, and plan-lint knows no D5 (no PREREQUISITES.md)')
    assert.deepEqual(doc.prerequisites, [], 'prerequisites derived from plan-lint')
    assert.deepEqual(doc.handoff, {}, 'handoff counts derived from HANDOFF.md, empty here')
    const run = doc.runs[0]
    assert.deepEqual([run.number, run.mode, run.status, run.parallelism, run.max_fixes, run.max_auto_decisions], [1, 'deviation', 'in-progress', 2, 2, 3], 'the run in progress continues')
    assert.deepEqual([run.rulings_applied, run.discarded_amendments, run.not_started, run.waiting_on_prerequisites], [[{ task: 'T01', title: 'Garde', option: 'A' }], [{ task: 'T01', id: 'T02', reason: 'déjà là' }], ['T02'], [{ id: 'T02', prerequisites: ['D5'] }]])
    // An issue of 0.11 kept only the text of its options: like an issue of /3, without its actions (convertV3)
    assert.deepEqual(doc.issues, [{ id: 'T01-1', run: 1, task: 'T01', title: 'Garde', context: 'le flag', human: true, role: 'stop', status: 'settled', chosen_option: 'A', circuit_breaker: true, without_actions: true,
      options: [{ id: 'A', description: 'Ajouter un test', impact: 'faible', recommended: true, valid: false, invalid_reason: 'inherited from orchestre-progress/3 without its actions: settle it with a free answer', effect: '', amends: [] }] }])
    assert.deepEqual(doc.pending_rulings, [])
    assert.deepEqual(doc.auto_decisions, [{ run: 1, task: 'T01', title: 'Seuil', option: 'B', description: '30 s' }])
    assert.deepEqual(doc.reviews, [{ task: null, phase: null, text: '.env.example : relire', run: null, at: null }])
    assert.equal(doc.log_omitted, 3)
    assert.deepEqual(doc.log.slice(0, 3).map(e => [e.kind, e.text]), [['task', 'T01 démarre (checkout principal)'], ['auto-decision', '« Seuil », option B'], ['run', 'progress.json converted from orchestre-suivi/2 to orchestre-progress/4']])
    assert.equal(G.progress('step', { task: 'T02', step: 'evaluation' }).code, 0)
    assert.equal(G.doc().log.filter(e => /converted/.test(e.text)).length, 1, 'only once')
    assert.equal(G.progress('validate').out, 'progress: progress.json valid (orchestre-progress/4, 2 tasks, 1 run)')
  })

  await test('convertLegacy: every field and value of /2 translated, free text kept', async () => {
    const { convertLegacy } = await import(PROGRESS_MJS)
    const at = '2026-10-01T10:00:00+02:00', v2 = legacyV2(at)
    v2.points[0].incoherence = 'option inconnue'
    v2.runs[0].taches_ajoutees = [{ id: 'T01B', phase: 1, titre: 'Suite' }]
    const doc = convertLegacy(v2)
    assert.equal(convertLegacy({ format: 'orchestre-progress/3' }), null)
    assert.deepEqual(doc.issues[0].inconsistency, 'option inconnue')
    assert.deepEqual(doc.runs[0].added_tasks, [{ id: 'T01B', phase: 1, title: 'Suite' }])
    assert.deepEqual(doc.prerequisites, [{ id: 'D5', type: 'decision', status: 'open', text: 'Choisir', blocks: ['T02'] }])
    assert.deepEqual(doc.handoff, { 'source plan': { review: { minor: 0, major: 1 } }, T01: { deviation: { minor: 1, major: 0 } } })
    assert.deepEqual(doc.tasks.map(t => [t.status, t.step]), [['merged', null], ['todo', 'fix']])
    assert.deepEqual(Object.keys(doc), ['format', 'plan', 'dir', 'integration', 'base', 'updated', 'tasks', 'runs', 'issues', 'pending_rulings', 'auto_decisions', 'reviews', 'prerequisites', 'handoff', 'lint', 'log', 'log_omitted'])
    assert.deepEqual(doc.log.map(e => e.kind), ['task', 'auto-decision'])
  })

  await test('format orchestre-suivi/1 of 0.10: converted too, model used null, with a note', () => {
    const G = repo('legacy1', { tasks: [{ id: 'T01' }, { id: 'T02', depends_on: ['T01'] }], progress: PROGRESS_TEMPLATE(['T01', 'T02']) })
    const at = '2026-10-01T10:00:00+02:00', v2 = legacyV2(at)
    const v1 = { ...v2, format: 'orchestre-suivi/1', taches: v2.taches.map(({ modele_utilise, ...t }) => t) }
    writeFileSync(join(G.d, 'progress.json'), JSON.stringify(v1, null, 2) + '\n')
    assert.equal(G.progress('validate').out, 'progress: progress.json valid (orchestre-suivi/1, converted to orchestre-progress/4 at the next write, 2 tasks, 1 run)')
    assert.equal(G.progress('step', { task: 'T02', step: 'verification' }).code, 0)
    const doc = G.doc()
    assert.deepEqual(doc.tasks.map(t => [t.id, t.model, t.model_used]), [['T01', 'sonnet', null], ['T02', 'sonnet', null]])
    assert.equal(doc.log.filter(e => e.text === 'progress.json converted from orchestre-suivi/1 to orchestre-progress/4: model used unknown until now').length, 1)
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

  // ─── Triage: what the pilot closes alone at the end of a run (D5, D6) ───────────────────────────────────────────────
  const triaged = (R, opts) => { const r = R.progress('triage', undefined, opts); assert.equal(r.code, 0, r.err); return JSON.parse(r.out) }
  const brief = list => list.map(s => [s.reason, s.kind, s.task, s.text])
  const readsAndFiles = R => [R.read('progress.json'), R.read('PROGRESS.md')]

  await test('triage: the four safe cases, with their reason; the rest open by task; nothing written; safe passed to ack closes it in one write', () => {
    const wtDir = join(temp('triage-wt-'), 'wt'), goneDir = join(temp('triage-gone-'), 'gone')
    const T = repo('triage', {
      tasks: [{ id: 'T01' }, { id: 'T02' }, { id: 'T03' }],
      progress: PROGRESS_TEMPLATE(['T01', 'T02', 'T03']),
      handoff: '## source plan\n\n- review · major · `docs/x.md`: read the procedure\n- review · major · `docs/x.md`: same file, another wording\n- review · major · `docs/y.md`: unrelated\n- review · major · no backquote here\n- review · major · no backquote here either\n',
    })
    // The base branch main has README.md as the plan branch; only the plan branch has src/changed.txt
    mkdirSync(join(T.root, 'src'), { recursive: true })
    writeFileSync(join(T.root, 'src', 'changed.txt'), 'changed on the plan branch\n')
    T.git('add', 'src/changed.txt'); T.git('commit', '-qm', 'plan: a changed file')
    T.git('worktree', 'add', '-q', '-b', 'task/T02', wtDir)
    assert.equal(T.progress('run-start', RUN).code, 0)
    const unreadable = f => `${f}: unreadable by the agents, to review by the human before the PR`
    // T02 closes before T01: the groups of the answer follow the order of the plan, not the order of the closes
    assert.equal(T.progress('close', {
      task: 'T02', status: 'merged', attempts: 1, branch: 'task/T02',
      reviews: ['`src/a.ts`: same passage, but another task', `worktree ${wtDir} kept after the merge of T02 (modified files): look at it, then remove it`],
      auto_decisions: [{ title: 'Retry threshold', option: 'C', description: 'same title as a decision of T01' }],
    }).code, 0)
    assert.equal(T.progress('close', {
      task: 'T01', status: 'merged', attempts: 1, branch: 'task/T01',
      reviews: [
        '`src/a.ts` and `b`: check the migration', '`src/a.ts`: another wording of the same check', '`src/a.ts` again: third wording',
        unreadable('README.md'), unreadable('src/changed.txt'), unreadable('.claude/settings.json'), unreadable('../outside.txt'),
        '`README.md`: add the deny rule for git push to the settings, forbidden to the agents',
        'update the key of README.md: unreadable by the agents, change it before the PR',
        `worktree ${goneDir} kept after the merge of T01 (modified files): look at it, then remove it`,
      ],
      auto_decisions: [{ title: 'Retry threshold', option: 'A', description: 'cap at 30 s' }, { title: 'Other point', option: 'B', description: 'x' }],
    }).code, 0)
    assert.equal(T.progress('run-end', { status: 'finished' }).code, 0)
    assert.equal(T.progress('run-start', RUN).code, 0)
    // Run 2: the user settles the automatic decision of run 1; a decision of run 2 is settled in the same run: it is not replaced
    assert.equal(T.progress('ruling', { task: 'T01', title: 'Retry threshold', option: 'B' }).code, 0)
    assert.equal(T.progress('close', { task: 'T03', status: 'merged', attempts: 1, branch: 'task/T03', auto_decisions: [{ title: 'Same run', option: 'A', description: 'y' }] }).code, 0)
    assert.equal(T.progress('ruling', { task: 'T03', title: 'Same run', option: 'A' }).code, 0)
    assert.equal(T.progress('run-end', { status: 'finished' }).code, 0)

    const before = readsAndFiles(T), status = T.clean()
    let out = triaged(T)
    assert.deepEqual([out.plan, out.base, out.integration], ['triage', 'main', 'plan/triage'])
    assert.deepEqual(brief(out.safe), [
      ['duplicate', 'review', null, '`docs/x.md`: same file, another wording'],
      ['duplicate', 'review', 'T01', '`src/a.ts`: another wording of the same check'],
      ['duplicate', 'review', 'T01', '`src/a.ts` again: third wording'],
      ['superseded', 'decision', 'T01', 'Retry threshold'],
      ['no-diff', 'review', 'T01', unreadable('README.md')],
      ['no-diff', 'review', 'T01', unreadable('.claude/settings.json')],
      ['worktree-gone', 'review', 'T01', `worktree ${goneDir} kept after the merge of T01 (modified files): look at it, then remove it`],
    ])
    // Each with the item it doubles, or its reason
    assert.deepEqual(out.safe[0].of, { kind: 'review', task: null, text: '`docs/x.md`: read the procedure' })
    assert.deepEqual(out.safe[1].of, { kind: 'review', task: 'T01', text: '`src/a.ts` and `b`: check the migration' })
    assert.equal(out.safe[3].detail, 'settled by the user in run 2: option B, instead of A')
    assert.equal(out.safe[4].detail, 'README.md has no difference between main and plan/triage')
    assert.equal(out.safe[6].detail, `${goneDir} no longer exists`)
    assert.ok(out.safe.every(s => typeof s.detail === 'string' && s.detail))
    // The rest, grouped by task (source plan first, then the order of the plan): the file that differs, the file git cannot
    // compare (outside the repository: unknown is not "no difference"), the requests to change
    // a forbidden file even with no difference, a kept worktree, the decision of T02 that no ruling replaced
    assert.deepEqual(out.open.map(g => g.task), [null, 'T01', 'T02', 'T03'])
    assert.deepEqual(out.open.map(g => g.items.map(i => [i.kind, i.text])), [
      [['review', '`docs/x.md`: read the procedure'], ['review', '`docs/y.md`: unrelated'], ['review', 'no backquote here'], ['review', 'no backquote here either']],
      [['review', '`src/a.ts` and `b`: check the migration'], ['review', unreadable('src/changed.txt')], ['review', unreadable('../outside.txt')],
        ['review', '`README.md`: add the deny rule for git push to the settings, forbidden to the agents'],
        ['review', 'update the key of README.md: unreadable by the agents, change it before the PR'], ['decision', 'Other point']],
      [['review', '`src/a.ts`: same passage, but another task'], ['review', `worktree ${wtDir} kept after the merge of T02 (modified files): look at it, then remove it`], ['decision', 'Retry threshold']],
      [['decision', 'Same run']],
    ])
    assert.ok(out.open.every(g => g.items.every(i => i.task === g.task)))
    // Read-only: no write, no leftover
    assert.deepEqual(readsAndFiles(T), before); assert.equal(T.clean(), status); assert.deepEqual(T.leftovers(), [])
    // A kept worktree that is removed becomes safe
    T.git('worktree', 'remove', '--force', wtDir)
    out = triaged(T)
    assert.equal(out.safe.length, 8)
    assert.deepEqual(brief(out.safe).filter(s => s[1] === 'review' && s[2] === 'T02'), [['worktree-gone', 'review', 'T02', `worktree ${wtDir} kept after the merge of T02 (modified files): look at it, then remove it`]])
    // The items of safe are the input of ack: closed in one write
    const log = T.doc().log.length
    const r = T.progress('ack', { items: out.safe })
    assert.deepEqual([r.code, r.out], [0, 'progress: 8 done; they leave "Your turn"'], r.err)
    assert.equal(T.doc().log.length, log + 8)
    const doc = T.doc()
    assert.equal(doc.reviews.filter(x => x.done).length + doc.auto_decisions.filter(x => x.done).length, 8)
    out = triaged(T)
    assert.deepEqual(out.safe, [])
    assert.equal(out.open.flatMap(g => g.items).length, 13, 'what ack did not close is still offered')
    // triage is in the usage line of the script, which tests/commands.test.mjs reads
    const unknown = T.progress('nope')
    assert.equal(unknown.code, 2); assert.match(unknown.err, /\|view\|status\|triage\|validate>/)
  })

  await test('triage: without progress.json it reads HANDOFF.md and writes nothing; an unknown plan is refused (code 2); a closed item is out', () => {
    const R = repo('triage-bare', { tasks: [{ id: 'T01' }], progress: PROGRESS_TEMPLATE(['T01']), handoff: '## T01\n\n- review · major · `a.ts`: one\n- review · major · `a.ts`: two\n' })
    const out = triaged(R)
    assert.deepEqual(brief(out.safe), [['duplicate', 'review', 'T01', '`a.ts`: two']])
    assert.ok(!existsSync(join(R.d, 'progress.json')), 'triage creates no progress.json')
    assert.equal(R.clean(), '')
    const r = R.progress('triage', undefined, { arg: 'plans/unknown' })
    assert.equal(r.code, 2); assert.match(r.err, /plan not found/)
    // A review already done is not a duplicate any more, nor offered
    assert.equal(R.progress('run-start', RUN).code, 0)
    assert.equal(R.progress('ack', { kind: 'review', task: 'T01', text: '`a.ts`: one' }).code, 0)
    const after = triaged(R)
    assert.deepEqual(after.safe, [])
    assert.deepEqual(after.open, [{ task: 'T01', items: [{ kind: 'review', task: 'T01', text: '`a.ts`: two' }] }])
  })

  await test('triage: ack would close two reviews of one key, so none of them is safe; no base branch, no no-diff', () => {
    const R = repo('triage-key', { tasks: [{ id: 'T01' }], progress: PROGRESS_TEMPLATE(['T01']) })
    assert.equal(R.progress('run-start', RUN).code, 0)
    // Two reviews that differ by spaces only: ack matches on the squashed text, it would close both
    const seeded = R.doc()
    seeded.reviews = [{ task: 'T01', phase: 1, text: '`x`: check  it', run: 1, at: null }, { task: 'T01', phase: 1, text: '`x`: check it', run: 1, at: null }]
    writeFileSync(join(R.d, 'progress.json'), JSON.stringify(seeded, null, 2) + '\n')
    let out = triaged(R)
    assert.deepEqual(out.safe, [])
    assert.equal(out.open[0].items.length, 2)
    // No main, no master and no base in the configuration: the file cannot be compared, the review stays open
    R.git('branch', '-m', 'main', 'trunk')
    seeded.reviews = [{ task: 'T01', phase: 1, text: 'README.md: unreadable by the agents, to review by the human before the PR', run: 1, at: null }]
    writeFileSync(join(R.d, 'progress.json'), JSON.stringify(seeded, null, 2) + '\n')
    out = triaged(R)
    assert.equal(out.base, null)
    assert.deepEqual(out.safe, [])
    assert.equal(out.open[0].items.length, 1)
    // A base branch that is the integration branch compares nothing with itself: it proves no absence of difference
    writeFileSync(join(R.d, 'orchestre.config.json'), JSON.stringify({ integration_branch: 'plan/triage-key', base_branch: 'plan/triage-key' }))
    out = triaged(R)
    assert.deepEqual([out.base, out.safe], ['plan/triage-key', []])
    assert.equal(out.open[0].items.length, 1)
  })

  await test('triage: a review that falls under two cases is listed once', () => {
    const R = repo('triage-twice', {
      tasks: [{ id: 'T01' }], progress: PROGRESS_TEMPLATE(['T01']),
      handoff: '## T01\n\n- review · major · `README.md`: unreadable by the agents (first)\n- review · major · `README.md`: unreadable by the agents (second)\n',
    })
    const out = triaged(R)
    assert.deepEqual(brief(out.safe), [
      ['duplicate', 'review', 'T01', '`README.md`: unreadable by the agents (second)'],
      ['no-diff', 'review', 'T01', '`README.md`: unreadable by the agents (first)'],
    ])
    assert.deepEqual(out.open, [])
  })

  await test('triage: a file name with `[`, `*` or `?` is compared as written: kept open when it differs, safe when only a file its pattern would match differs', () => {
    const R = repo('triage-glob', { tasks: [{ id: 'T01' }], progress: PROGRESS_TEMPLATE(['T01']) })
    // On main and on the plan branch: six files whose names git would read as patterns, and the files these patterns match
    R.git('switch', '-q', 'main')
    mkdirSync(join(R.root, 'src'), { recursive: true })
    const SAME = ['src/a[1].txt', 'src/b*.txt', 'src/c?.txt'], CHANGED = ['src/d[1].txt', 'src/e*.txt', 'src/f?.txt'], MATCHED = ['src/a1.txt', 'src/bz.txt', 'src/cq.txt']
    for (const f of [...SAME, ...CHANGED, ...MATCHED]) writeFileSync(join(R.root, f), 'x\n')
    R.git('add', 'src'); R.git('commit', '-qm', 'files with patterns in their names')
    R.git('switch', '-q', 'plan/triage-glob'); R.git('merge', '-q', '--no-edit', 'main')
    // The plan branch changes the three CHANGED files, and the files that the SAME names match as patterns, not the SAME files
    for (const f of [...CHANGED, ...MATCHED]) writeFileSync(join(R.root, f), 'changed\n')
    R.git('add', 'src'); R.git('commit', '-qm', 'plan: changes')
    const unreadable = f => `${f}: unreadable by the agents, to review by the human before the PR`
    assert.equal(R.progress('run-start', RUN).code, 0)
    assert.equal(R.progress('close', { task: 'T01', status: 'merged', attempts: 1, branch: 'task/T01', reviews: [...SAME, ...CHANGED].map(unreadable) }).code, 0)
    const out = triaged(R)
    assert.equal(out.base, 'main')
    // Read as a pattern (without --literal-pathspecs), each SAME name matches a file that differs: they would stay open
    assert.deepEqual(brief(out.safe), SAME.map(f => ['no-diff', 'review', 'T01', unreadable(f)]))
    assert.deepEqual(out.open, [{ task: 'T01', items: CHANGED.map(f => ({ kind: 'review', task: 'T01', text: unreadable(f) })) }])
  })

  await test('triage: an unreadable progress.json exits 1, with its message on stderr, and writes nothing', () => {
    const R = repo('triage-bad', { tasks: [{ id: 'T01' }], progress: PROGRESS_TEMPLATE(['T01']) })
    assert.equal(R.progress('run-start', RUN).code, 0)
    writeFileSync(join(R.d, 'progress.json'), '{ not json')
    const before = readsAndFiles(R), status = R.clean()
    const r = R.progress('triage')
    assert.deepEqual([r.code, r.out], [1, ''])
    assert.match(r.err, /^progress: progress\.json unreadable/)
    assert.deepEqual(readsAndFiles(R), before); assert.equal(R.clean(), status); assert.deepEqual(R.leftovers(), [])
  })

  // ─── 0.20.0: orchestre-progress/4, the issue register ISSUES.json, rule and unrule (decision D1) ───────────────────────
  const INHERITED = 'inherited from orchestre-progress/3 without its actions: settle it with a free answer'
  const entry = (id, o = {}) => ({ id, task: id.replace(/-\d+$/, ''), title: `Issue ${id}`, context: '', human: false, options: [{ id: 'A', description: 'Do A', recommended: true, amendments: [{ id: 'T02', reason: 'r' }] }, { id: 'B', description: 'Do B' }], status: 'open', ruling: null, ...o })
  const putRegister = (R, issues) => writeFileSync(join(R.d, 'ISSUES.json'), JSON.stringify({ format: 'orchestre-issues/1', issues }, null, 2) + '\n')
  // Option B amends T02 with a dependency that does not exist: the dry run of close refuses it (0.20.0); a verdict given in the
  // input is not taken, the dry run decides
  const REFUSED_B = 'dry run: T02: unknown dependency T99'
  const ISSUE = (title, o = {}) => ({ title, context: 'c', human: false, options: [{ id: 'A', description: 'Do A', recommended: true, valid: false, invalid_reason: 'said by the caller' }, { id: 'B', description: 'Do B', amendments: [{ id: 'T02', depends_on: ['T99'], reason: 'r' }] }], ...o })
  // A program that loads progress.mjs and makes one write with it, as a subcommand does (the register has no subcommand that
  // writes it before T14)
  const writer = (R, body) => [process.execPath, ['--input-type=module', '-e', `import { write, locate } from ${JSON.stringify(pathToFileURL(PROGRESS_MJS).href)}
try { write(locate(${JSON.stringify(R.plan)}), (doc, t) => { ${body} }) } catch (e) { console.error(e.message); process.exitCode = 1 }`], { cwd: R.root, encoding: 'utf8' }]
  const writeWith = (R, body) => { const r = spawnSync(...writer(R, body)); return { code: r.status, err: r.stderr.trim() } }
  const writeLater = (R, body) => new Promise(res => { const c = spawn(...writer(R, body).slice(0, 2), { cwd: R.root }); let err = ''; c.stderr.on('data', x => { err += x }); c.on('close', code => res({ code, err })) })
  const yourTurn = out => out.split('\n').filter(l => /^\*\*(Now|At run stop|Later|Your turn)\*\*/.test(l)).join('\n')

  await test('/3 of 0.19: read, validated and shown as is; converted at the first write, each issue with its id, the open ones without their actions', async () => {
    const R = repo('v3', { tasks: [{ id: 'T01' }, { id: 'T02' }], progress: PROGRESS_TEMPLATE(['T01', 'T02']) })
    assert.equal(R.progress('run-start', RUN).code, 0)
    const v4 = R.doc()
    const issue = (task, title, status) => ({ run: 1, task, title, context: '', human: false, role: 'open', status, chosen_option: status === 'settled' ? 'A' : null, options: [{ id: 'A', description: 'Do A', impact: 'low', recommended: true }, { id: 'B', description: 'Do B' }] })
    const { pending_rulings, ...rest } = v4
    const v3 = { ...rest, format: 'orchestre-progress/3', issues: [issue('T01', 'First', 'settled'), issue('T02', 'Other task', 'open'), issue('T01', 'Second', 'open')] }
    assert.deepEqual(pending_rulings, [])
    writeFileSync(join(R.d, 'progress.json'), JSON.stringify(v3, null, 2) + '\n')
    const before = R.read('progress.json')
    assert.equal(R.progress('validate').out, 'progress: progress.json valid (orchestre-progress/3, converted to orchestre-progress/4 at the next write, 2 tasks, 1 run)')
    assert.equal(R.progress('run-end', { status: 'partial' }).code, 0)
    const shown = R.progress('status').out
    assert.match(shown, /\*\*Now\*\*: 2 issues to settle/, shown)
    // Written: /4, ids in the order of the file, task by task; the open issues and their options without actions
    const doc = R.doc()
    assert.notEqual(R.read('progress.json'), before)
    assert.equal(doc.format, 'orchestre-progress/4')
    assert.deepEqual(doc.issues.map(p => [p.id, p.title, p.status, p.without_actions]), [['T01-1', 'First', 'settled', true], ['T02-1', 'Other task', 'open', true], ['T01-2', 'Second', 'open', true]])
    assert.deepEqual(doc.issues[1].options, [{ id: 'A', description: 'Do A', impact: 'low', recommended: true, valid: false, invalid_reason: INHERITED, effect: '', amends: [] }, { id: 'B', description: 'Do B', valid: false, invalid_reason: INHERITED, effect: '', amends: [] }])
    assert.deepEqual(doc.pending_rulings, [])
    assert.equal(doc.log.filter(e => e.text === 'progress.json converted from orchestre-progress/3 to orchestre-progress/4; 2 open issues kept without their actions: settle them with a free answer').length, 1)
    assert.equal(R.progress('validate').out, 'progress: progress.json valid (orchestre-progress/4, 2 tasks, 1 run)')
    assert.equal(R.progress('status').out, shown, 'status says the same before and after the conversion')
    // Settled by a free answer only
    let r = R.progress('rule', { issue: 'T02-1', option: 'A' })
    assert.equal(r.code, 1)
    assert.equal(r.err, `progress: rule: option A of T02-1 is invalid: ${INHERITED}`)
    r = R.progress('rule', { issue: 'T02-1', text: 'Take option A, written by hand' })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(R.doc().pending_rulings.map(x => [x.issue, x.option, x.text]), [['T02-1', null, 'Take option A, written by hand']])
    // convertV3: only /3; the keys in their order, pending_rulings after issues
    const { convertV3 } = await import(PROGRESS_MJS)
    assert.equal(convertV3(v4), null); assert.equal(convertV3({ format: 'orchestre-suivi/2' }), null)
    const k = Object.keys(convertV3(v3))
    assert.deepEqual(k.slice(k.indexOf('issues'), k.indexOf('issues') + 2), ['issues', 'pending_rulings'])
    assert.deepEqual(convertV3(v3).issues[0].chosen_option, 'A', 'a settled issue keeps its option')
  })

  // One plan for the rulings: two issues on T01 (B refused by the dry run), one on T02
  const U = repo('rulings', { tasks: [{ id: 'T01' }, { id: 'T02' }, { id: 'T03' }], progress: PROGRESS_TEMPLATE(['T01', 'T02', 'T03']), handoff: '# HANDOFF — rulings\n' })
  assert.equal(U.progress('run-start', RUN).code, 0)
  assert.equal(U.progress('close', { task: 'T01', status: 'needs-human', attempts: 1, branch: 'task/T01', issues: [ISSUE('Guard'), ISSUE('Second', { human: true })] }).code, 0)
  assert.equal(U.progress('close', { task: 'T02', status: 'blocked', attempts: 1, branch: 'task/T02', issues: [ISSUE('Key', { options: [] })] }).code, 0)
  assert.equal(U.clean(), '', 'the closes committed the plan (0.20.0)')

  await test('close and run-end give each issue a stable id <task>-<n>; the copy of each option says its effect, and what the dry run said', () => {
    const doc = U.doc()
    assert.deepEqual(doc.issues.map(p => p.id), ['T01-1', 'T01-2', 'T02-1'])
    assert.deepEqual(doc.issues[0].options.map(o => [o.id, o.valid, o.invalid_reason, o.effect]), [['A', true, null, 'a note in HANDOFF, no task changes'], ['B', false, REFUSED_B, 'amends T02']])
    assert.equal(U.progress('run-end', { status: 'awaiting-ruling', stop_issue: { task: 'T01', title: 'Stop here', human: true, options: [] } }).code, 0)
    assert.deepEqual(U.doc().issues.map(p => [p.id, p.role]), [['T01-1', 'open'], ['T01-2', 'open'], ['T02-1', 'open'], ['T01-3', 'stop']])
    assert.equal(U.progress('run-start', RUN).code, 0)
  })

  await test('rule: one refusal per case, code 1, progress.json untouched; a list with one refused item writes nothing', () => {
    assert.equal(U.progress('ruling', { task: 'T01', title: 'Stop here', option: 'human' }).code, 0)
    const before = [U.read('progress.json'), U.read('PROGRESS.md')]
    const refused = [
      [{ issue: 'T09-1', option: 'A' }, 'rule: unknown issue T09-1'],
      [{ issue: 'T01', option: 'A' }, 'rule: "issue" must be the id of an issue, such as T02-1 ("T01" received)'],
      [{ issue: 'T01-3', option: 'A' }, 'rule: issue T01-3 already settled'],
      [{ issue: 'T01-1', option: 'Z' }, 'rule: option Z absent from issue T01-1 (A, B): give a text instead'],
      [{ issue: 'T02-1', option: 'A' }, 'rule: option A absent from issue T02-1 (it has no option): give a text instead'],
      [{ issue: 'T01-1', option: 'B' }, `rule: option B of T01-1 is invalid: ${REFUSED_B}`],
      [{ issue: 'T01-1' }, 'rule: T01-1: give "option" or "text", not neither'],
      [{ issue: 'T01-1', option: 'A', text: 'and this' }, 'rule: T01-1: give "option" or "text", not both'],
      [{ issue: 'T01-1', text: '   ' }, 'rule: T01-1: "text" must be a non-empty text'],
      [{ issue: 'T01-1', option: 1 }, 'rule: T01-1: "option" must be the id of an option'],
      [{ items: [{ issue: 'T01-1', option: 'A' }, { issue: 'T01-1', text: 'x' }] }, 'rule: issue T01-1 given twice'],
      [{ items: [{ issue: 'T01-1', option: 'A' }, { issue: 'T01-2', option: 'B' }] }, `rule: option B of T01-2 is invalid: ${REFUSED_B}`],
      [{ items: [] }, 'rule: "items" must be a non-empty list'],
      [{ items: ['T01-1'] }, 'rule: each item is an object { issue, option } or { issue, text }'],
    ]
    for (const [E, message] of refused) {
      const r = U.progress('rule', E)
      assert.equal(r.code, 1, JSON.stringify(E))
      assert.equal(r.err, `progress: ${message}`)
    }
    assert.deepEqual([U.read('progress.json'), U.read('PROGRESS.md')], before)
    assert.deepEqual(U.leftovers(), [])
  })

  await test('rule: a list recorded whole, in progress.json only, one log line each; the issue leaves Your turn of status; a second ruling refused', () => {
    const view = U.read('PROGRESS.md'), register = U.read('ISSUES.json')
    // T01, ruled in this run, no longer waits: its two issues count; the first issue of T02 goes with its line
    assert.match(yourTurn(U.progress('status').out), /\*\*At run stop\*\*: T02 blocked · 2 issues to settle/)
    let r = U.progress('rule', { items: [{ issue: 'T01-1', option: 'A' }, { issue: 'T02-1', text: '  Use the   staging key ' }] })
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, 'progress: 2 rulings recorded; they leave "Your turn"')
    const doc = U.doc()
    assert.deepEqual(doc.pending_rulings.map(({ at, ...x }) => x), [{ issue: 'T01-1', option: 'A', text: null }, { issue: 'T02-1', option: null, text: 'Use the staging key' }])
    assert.ok(doc.pending_rulings.every(x => x.at === doc.updated))
    assert.deepEqual(doc.log.slice(-2).map(e => [e.kind, e.task, e.text]), [['ruling', 'T01', 'T01-1: option A recorded'], ['ruling', 'T02', 'T02-1: a free answer recorded']])
    assert.deepEqual(doc.issues.map(p => p.status), ['open', 'open', 'open', 'settled'], 'the issues stay open until apply')
    assert.equal(U.clean(), '', 'nothing tracked by git written: neither ISSUES.json nor PROGRESS.md')
    assert.equal(U.read('PROGRESS.md'), view)
    assert.equal(U.read('ISSUES.json'), register, 'the register, written by close, untouched by rule')
    assert.match(yourTurn(U.progress('status').out), /\*\*At run stop\*\*: .*1 issue to settle/)
    r = U.progress('rule', { issue: 'T01-1', text: 'changed my mind' })
    assert.equal(r.code, 1)
    assert.equal(r.err, 'progress: rule: issue T01-1 already has a ruling recorded (option A); unrule it first')
    r = U.progress('rule', { issue: 'T01-2', option: 'A' })
    assert.equal(r.out, 'progress: T01-2: option A recorded; it leaves "Your turn"')
    assert.ok(!/issue/.test(yourTurn(U.progress('status').out)), U.progress('status').out)
    assert.equal(U.progress('validate').code, 0)
  })

  await test('unrule: removes a ruling not applied yet, and the issue is back in Your turn; refused once applied, without a ruling, unknown or given twice', () => {
    let r = U.progress('unrule', { issue: 'T01-2' })
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, 'progress: T01-2: ruling withdrawn; back in "Your turn"')
    assert.deepEqual(U.doc().pending_rulings.map(x => x.issue), ['T01-1', 'T02-1'])
    assert.deepEqual(U.doc().log.at(-1), { at: U.doc().updated, kind: 'ruling', task: 'T01', text: 'T01-2: option A withdrawn' })
    assert.match(yourTurn(U.progress('status').out), /1 issue to settle/)
    const before = U.read('progress.json')
    for (const [E, message] of [
      [{ issue: 'T01-2' }, 'unrule: no ruling recorded for T01-2'],
      [{ items: [{ issue: 'T01-1' }, { issue: 'T01-1' }] }, 'unrule: issue T01-1 given twice'],
      [{ issue: 'T07-1' }, 'unrule: unknown issue T07-1'],
      [{ issue: 'T01-3' }, 'unrule: the ruling of T01-3 is already applied (issue settled)'],
      [{ items: [{ issue: 'T01-1' }, { issue: 'T01-2' }] }, 'unrule: no ruling recorded for T01-2'],
    ]) {
      r = U.progress('unrule', E)
      assert.equal(r.code, 1, JSON.stringify(E)); assert.equal(r.err, `progress: ${message}`)
    }
    assert.equal(U.read('progress.json'), before)
    // Applied (as apply will do it): the register settles T02-1 with its commit, the ruling leaves pending_rulings
    putRegister(U, [entry('T01-1'), entry('T02-1', { options: [], status: 'settled', ruling: { option: null, text: 'Use the staging key', author: 'user', at: '2026-11-17T10:00:00+01:00', commit: 'abc1234' } })])
    const doc = U.doc(); doc.pending_rulings = doc.pending_rulings.filter(x => x.issue !== 'T02-1')
    writeFileSync(join(U.d, 'progress.json'), JSON.stringify(doc, null, 2) + '\n')
    r = U.progress('unrule', { issue: 'T02-1' })
    assert.equal(r.code, 1); assert.equal(r.err, 'progress: unrule: the ruling of T02-1 is already applied (issue settled)')
    r = U.progress('rule', { issue: 'T02-1', text: 'again' })
    assert.equal(r.err, 'progress: rule: issue T02-1 already settled', 'settled in the register, though open in the copy')
    r = U.progress('unrule', { items: [{ issue: 'T01-1' }] })
    assert.equal(r.out, 'progress: T01-1: ruling withdrawn; back in "Your turn"', 'a list of one says it as one')
    assert.deepEqual(U.doc().pending_rulings, [])
    // The register prevails for the options: B, refused by the dry run in the copy, has no verdict in the register
    assert.equal(U.progress('rule', { issue: 'T01-1', option: 'B' }).code, 0, 'the options of the register, not those of the copy')
    assert.equal(U.progress('unrule', { issue: 'T01-1' }).code, 0)
    // validate: one ruling per issue, an option or a text; one id per issue
    const keep = U.read('progress.json'), bad = U.doc(), r1 = { issue: 'T01-1', option: 'A', text: null, at: bad.updated }
    for (const [over, message] of [
      [{ pending_rulings: [r1, { ...r1, option: 'B' }] }, 'pending_rulings[1]: T01-1 given twice'],
      [{ pending_rulings: [{ ...r1, text: 'x' }] }, 'pending_rulings[0]: an option or a text, not both'],
      [{ pending_rulings: [{ ...r1, option: null }] }, 'pending_rulings[0]: an option or a text, not neither'],
      [{ issues: [bad.issues[0], bad.issues[0]] }, 'issues[1]: T01-1 given twice'],
    ]) {
      writeFileSync(join(U.d, 'progress.json'), JSON.stringify({ ...bad, ...over }))
      const v = U.progress('validate')
      assert.equal(v.code, 1); assert.equal(v.err, `progress: progress.json invalid:\n  - ${message}`)
    }
    writeFileSync(join(U.d, 'progress.json'), keep)
  })

  await test('ISSUES.json: absent, an empty register; read, and validated by validate and by every command that reads it; the register prevails', () => {
    const R = repo('register', { tasks: [{ id: 'T01' }, { id: 'T02' }, { id: 'T03' }], progress: PROGRESS_TEMPLATE(['T01', 'T02', 'T03']) })
    assert.equal(R.progress('run-start', RUN).code, 0)
    assert.equal(R.progress('validate').out, 'progress: progress.json valid (orchestre-progress/4, 3 tasks, 1 run)', 'without ISSUES.json, nothing said of it')
    assert.equal(R.progress('rule', { issue: 'T01-1', option: 'A' }).err, 'progress: rule: unknown issue T01-1', 'absent: an empty register')
    const settled = { status: 'settled', ruling: { option: 'A', text: null, author: 'auto', at: '2026-11-17T10:00:00+01:00', commit: null } }
    putRegister(R, [entry('T01-1'), entry('T01-2', settled), entry('T03-1', { status: 'dropped' })])
    assert.equal(R.progress('validate').out, 'progress: progress.json valid (orchestre-progress/4, 3 tasks, 1 run)\nprogress: ISSUES.json valid (orchestre-issues/1, 3 issues, 1 open)')
    assert.equal(R.progress('validate', undefined, { arg: null, args: ['--file', join(R.d, 'ISSUES.json')] }).out, 'progress: ISSUES.json valid (orchestre-issues/1, 3 issues, 1 open)')
    // An issue known by the register only (progress.json rebuilt): its options and status come from there
    assert.equal(R.progress('rule', { issue: 'T03-1', text: 'x' }).err, 'progress: rule: issue T03-1 already dropped')
    assert.equal(R.progress('rule', { issue: 'T01-2', text: 'x' }).err, 'progress: rule: issue T01-2 already settled')
    assert.equal(R.progress('rule', { issue: 'T01-1', option: 'C' }).err, 'progress: rule: option C absent from issue T01-1 (A, B): give a text instead')
    assert.equal(R.progress('rule', { issue: 'T01-1', option: 'A' }).code, 0)
    // A new issue of T01 comes after those of the register
    assert.equal(R.progress('close', { task: 'T01', status: 'needs-human', attempts: 1, branch: 'task/T01', issues: [ISSUE('Third')] }).code, 0)
    assert.deepEqual(R.doc().issues.map(p => p.id), ['T01-3'])
    // Invalid: refused by validate, and by rule, which reads it; progress.json untouched
    const bad = [
      [[entry('T01-1', { status: 'settled' })], 'issues[0]: settled without a ruling'],
      [[entry('T01-1', { ruling: settled.ruling })], 'issues[0]: open with a ruling'],
      [[entry('T01-1', { ...settled, ruling: { ...settled.ruling, option: 'Z' } })], 'issues[0].ruling: option Z is not an option of T01-1'],
      [[entry('T01-1', { ...settled, ruling: { ...settled.ruling, text: 'and a text' } })], 'issues[0].ruling: an option or a text, not both'],
      [[entry('T01-1'), entry('T01-1')], 'issues[1]: T01-1 given twice'],
      [[entry('T01-1', { options: [{ id: 'A', description: 'Do A' }, { id: 'A', description: 'Do A again' }] })], 'issues[0].options[1]: A given twice'],
      [[entry('T01-1', { status: 'settled', ruling: { option: 'A' } })], 'issues[0].ruling: {"option":"A"} matches no allowed form'],
      [[{ ...entry('T01-1'), id: 'T02-1' }], 'issues[0]: id T02-1 is not an issue of T01'],
      [[{ ...entry('T01-1'), owner: 'x' }], 'issues[0].owner: field unknown to format orchestre-issues/1'],
      [[{ ...entry('T01-1'), status: 'closed' }], 'issues[0].status: "closed" is not allowed (open, settled, dropped)'],
    ]
    const before = R.read('progress.json')
    for (const [issues, message] of bad) {
      putRegister(R, issues)
      const v = R.progress('validate')
      assert.equal(v.code, 1, message); assert.equal(v.err, `progress: ISSUES.json invalid:\n  - ${message}`)
      const r = R.progress('unrule', { issue: 'T01-1' })
      assert.equal(r.code, 1); assert.equal(r.err, `progress: ISSUES.json invalid:\n  - ${message}`)
    }
    writeFileSync(join(R.d, 'ISSUES.json'), JSON.stringify({ format: 'orchestre-issues/2', issues: [] }))
    assert.match(R.progress('validate').err, /^progress: ISSUES\.json invalid:\n {2}- format: "orchestre-issues\/2" instead of "orchestre-issues\/1"$/)
    writeFileSync(join(R.d, 'ISSUES.json'), '{ not json')
    assert.match(R.progress('rule', { issue: 'T01-3', text: 'x' }).err, /^progress: ISSUES\.json unreadable \(.*\): it is tracked by git, restore it$/)
    assert.equal(R.read('progress.json'), before)
    // A step does not read the register: an invalid register does not stop a run
    assert.equal(R.progress('step', { task: 'T02', step: 'worker' }).code, 0)
  })

  await test('ISSUES.json written under the lock: 6 writes in parallel, none lost; an invalid register refused with progress.json untouched', async () => {
    const R = repo('register-lock', { tasks: [1, 2, 3, 4, 5, 6].map(k => ({ id: `T0${k}` })), progress: PROGRESS_TEMPLATE([1, 2, 3, 4, 5, 6].map(k => `T0${k}`)) })
    assert.equal(R.progress('run-start', RUN).code, 0)
    const add = id => `t.register().issues.push(${JSON.stringify(entry(id))}); return { register: true }`
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(k => writeLater(R, add(`T0${k}-1`))))
    assert.ok(rs.every(r => r.code === 0), rs.map(r => r.err).join('\n'))
    const reg = JSON.parse(R.read('ISSUES.json'))
    assert.deepEqual(reg.issues.map(p => p.id).sort(), ['T01-1', 'T02-1', 'T03-1', 'T04-1', 'T05-1', 'T06-1'])
    assert.equal(reg.format, 'orchestre-issues/1')
    assert.deepEqual(R.leftovers(), [])
    assert.equal(R.progress('validate').out.split('\n')[1], 'progress: ISSUES.json valid (orchestre-issues/1, 6 issues, 6 open)')
    // Without { register: true }, a change of the register is not written
    const text = R.read('ISSUES.json')
    assert.equal(writeWith(R, 't.register().issues.length = 0').code, 0)
    assert.equal(R.read('ISSUES.json'), text)
    const before = R.read('progress.json')
    const r = writeWith(R, `doc.pending_rulings.push({ issue: 'T01-1', option: 'A', text: null, at: doc.updated }); t.register().issues[0].status = 'settled'; return { register: true }`)
    assert.equal(r.code, 1)
    assert.equal(r.err, 'write refused, progress.json and ISSUES.json unchanged:\n  - issues[0]: settled without a ruling')
    assert.deepEqual([R.read('progress.json'), R.read('ISSUES.json')], [before, text])
    assert.deepEqual(R.leftovers(), [])
  })

  // ─── 0.20.0: close writes and commits the plan, _digest ──────────────────────────────────────────────────────────────
  const { payloadDigest, amendText } = await import(PROGRESS_MJS)
  // T03 merged in git, T05 cancelled in PROGRESS.md: their amendments are discarded
  const K = repo('close', {
    tasks: [{ id: 'T01' }, { id: 'T02' }, { id: 'T03' }, { id: 'T04', phase: 2, depends_on: ['T01'] }, { id: 'T05', phase: 2 }],
    progress: PROGRESS_TEMPLATE(['T01', 'T02', 'T03', 'T04', 'T05']).replace('| T05 | Task T05 | 1 | 1A | — | sonnet | todo |', '| T05 | Task T05 | 1 | 1A | — | sonnet | cancelled |'),
    handoff: '# HANDOFF — close\n\n## T01\n\n- decision · minor · earlier entry\n\n## T02\n\n- debt · minor · other\n',
  })
  writeFileSync(join(K.d, 'DISCOVERY.md'), '# DISCOVERY — close\n'); K.git('add', '.'); K.git('commit', '-qm', 'discovery')
  K.git('commit', '-q', '--allow-empty', '-m', 'task T03: Task T03')
  assert.equal(K.progress('run-start', { ...RUN, mode: 'auto' }).code, 0)
  // Everything a refused close must leave as it was
  const snapshot = R => ({
    files: ['progress.json', 'PROGRESS.md', 'HANDOFF.md', 'DISCOVERY.md', 'ISSUES.json'].map(f => (existsSync(join(R.d, f)) ? R.read(f) : null)),
    tasks: readdirSync(join(R.d, 'tasks')).sort().map(f => [f, readFileSync(join(R.d, 'tasks', f), 'utf8')]),
    head: R.git('rev-parse', 'HEAD'), status: R.clean(), leftovers: R.leftovers(),
  })

  await test('close (0.20.0): refused with code 1, writing nothing, unless the main checkout is on the integration branch', () => {
    const E = { task: 'T02', status: 'blocked', attempts: 1, branch: 'task/T02', entries: [{ type: 'deviation', severity: 'minor', description: 'x' }] }
    K.git('switch', '-qc', 'task/T02')
    const before = snapshot(K)
    let r = K.progress('close', E)
    assert.equal(r.code, 1, r.out)
    assert.equal(r.err, 'progress: close: the main checkout is on the branch task/T02, not on the integration branch plan/close: nothing is written; run git switch plan/close first')
    assert.deepEqual(snapshot(K), before)
    K.git('switch', '-q', '--detach')
    r = K.progress('close', E)
    assert.equal(r.code, 1); assert.match(r.err, /on a detached HEAD, not on the integration branch plan\/close/)
    K.git('switch', '-q', 'plan/close'); K.git('branch', '-q', '-D', 'task/T02')
    assert.deepEqual(snapshot(K), before)
  })

  await test('_digest (0.20.0): every write subcommand that receives it checks it, altered refused with code 1 and nothing written; without it, accepted', () => {
    const before = snapshot(K)
    for (const cmd of ['run-start', 'step', 'close', 'ruling', 'rule', 'unrule', 'run-end', 'pilot', 'ack', 'ticket', 'reopen', 'relabel', 'close-plan', 'reopen-plan']) {
      const E = { task: 'T02', step: 'verification', _digest: '00000000' }
      const r = K.progress(cmd, E)
      assert.equal(r.code, 1, cmd)
      assert.equal(r.err, `progress: ${cmd}: payload altered in transit (_digest "00000000", ${payloadDigest(E)} computed): nothing is written`)
    }
    // A faithful digest on a copy changed in transit, or a digest that is not a text
    const E = { task: 'T02', step: 'verification' }, sent = { ...E, _digest: payloadDigest(E) }
    for (const altered of [{ ...sent, step: 'evaluation' }, { ...sent, _digest: Number.parseInt(sent._digest, 16) }]) {
      const r = K.progress('step', altered)
      assert.equal(r.code, 1); assert.match(r.err, /^progress: step: payload altered in transit/)
    }
    assert.deepEqual(snapshot(K), before)
    // Faithful, keys in another order: accepted, and _digest kept nowhere
    let r = K.progress('step', { _digest: sent._digest, step: 'verification', task: 'T02' })
    assert.equal(r.code, 0, r.err)
    assert.ok(!K.read('progress.json').includes('_digest'))
    r = K.progress('step', { task: 'T02', step: 'worker', isolated: false })
    assert.equal(r.code, 0, 'without _digest: the pilot and the pane')
  })

  await test('close (0.20.0): HANDOFF.md, tasks created, amendments, ISSUES.json with the dry run, PROGRESS.md and DISCOVERY.md, in one commit progress(<id>): <status>', () => {
    writeFileSync(join(K.d, 'DISCOVERY.md'), '# DISCOVERY — close\n\n- a finding the scribe wrote\n')
    const head = K.git('rev-parse', 'HEAD').trim()
    const T01B = task({ id: 'T01B', depends_on: ['T01'] }), T01D = task({ id: 'T01D' })
    const E = {
      task: 'T01', status: 'merged', attempts: 2, branch: 'task/T01',
      entries: [{ type: 'deviation', severity: 'minor', description: 'used X\n  instead of Y' }, { type: 'review', severity: 'major', description: '`a.md`: reread' }],
      reviews: ['`a.md`: reread'], rejections: [{ attempt: 1, by: 'evaluation', gaps: ['gap one', 'gap two'] }], unverifiable: ['UI look'], flaky: ['test x'],
      // T02B refused by plan-lint (its error names T02B, not T02, which the automatic decision amends); T01E holds the task T01F
      added_tasks: [{ id: 'T01B', title: 'Follow-up of T01', phase: 1, content: T01B }, { id: 'T02B', title: 'Bad dependency', phase: 1, content: task({ id: 'T02B', depends_on: ['T99'] }) }, { id: 'T01E', title: 'Wrong id', phase: 1, content: task({ id: 'T01F' }) }],
      amendments: [
        { id: 'T04', reason: 'needs the guard', definition_of_done: ['the guard is tested'], owned_files: ['src/guard/**'], verification: ['npm run lint', 'npm test'], depends_on: ['T01', 'T01B'] },
        { id: 'T03', reason: 'too late', definition_of_done: ['x'] }, { id: 'T05', reason: 'cancelled', verification: ['y'] }, { id: 'T77', reason: 'missing' }, { id: 'T02B', reason: 'more for T02B', definition_of_done: ['also'] },
        // T01E, which plan-lint does not read, is put back: its amendment goes with it, though no error names T01E
        { id: 'T01E', reason: 'for E', definition_of_done: ['e'] },
      ],
      // The workflow of 0.19 also passed the automatic decision here: it is not noted twice
      auto_decisions: [{ title: 'Auto pick', option: 'A', description: 'Add the test task' }],
      issues: [
        { title: 'Guard', context: 'c', human: false, options: [
          { id: 'A', description: 'Test it', recommended: true, amendments: [{ id: 'T02', reason: 'r', definition_of_done: ['guarded'] }] },
          { id: 'B', description: 'Depend on nothing', amendments: [{ id: 'T02', reason: 'r', depends_on: ['T99'] }] },
          { id: 'C', description: 'Wrong file', added_tasks: [{ id: 'T01G', title: 'G', phase: 1, content: task({ id: 'T01H' }) }] }] },
        { title: 'Auto pick', context: 'c2', human: false, auto: 'A', options: [
          { id: 'A', description: 'Add the test task', recommended: true, entries: [{ type: 'debt', severity: 'minor', description: 'auto entry' }], added_tasks: [{ id: 'T01D', title: 'Auto test', phase: 1, content: T01D }], amendments: [{ id: 'T02', reason: 'auto amend', verification: ['npm run e2e'], depends_on: ['T01'] }] },
          { id: 'B', description: 'Skip' }] },
      ],
    }
    const r = K.progress('close', E)
    assert.equal(r.code, 0, r.err)
    // The JSON output, its digest computed again
    const o = JSON.parse(r.out), commit = K.git('rev-parse', 'HEAD').trim()
    assert.deepEqual(o, {
      task: 'T01', status: 'merged', commit,
      rejected: [{ id: 'T77', reason: 'amends T77, a task missing from the plan' }, { id: 'T02B', reason: 'plan-lint: T02B: unknown dependency T99' }, { id: 'T01E', reason: 'plan-lint: no task T01E in T01E-wrong-id.md' }],
      discarded: [{ id: 'T03', reason: 'too late' }, { id: 'T05', reason: 'cancelled' }], issues: ['T01-1', 'T01-2'], pending: [],
      message: `T01 merged; PROGRESS.md regenerated; committed ${commit.slice(0, 7)}`, digest: o.digest,
    })
    assert.equal(o.digest, payloadDigest(o, 'digest'))
    // One commit, of the plan's files only; the task refused by plan-lint is not there
    assert.equal(K.git('log', '--format=%s', `${head}..HEAD`), 'progress(T01): merged\n')
    assert.deepEqual(K.git('show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['DISCOVERY.md', 'HANDOFF.md', 'ISSUES.json', 'PROGRESS.md', 'tasks/T01B-follow-up-of-t01.md', 'tasks/T01D-auto-test.md', 'tasks/T02-x.md', 'tasks/T04-x.md'].map(f => `plans/close/${f}`))
    assert.equal(K.clean(), '')
    assert.deepEqual(K.leftovers(), [])
    // HANDOFF.md: under ## T01, after its last entry, in the order of the scribe's instruction
    assert.equal(K.read('HANDOFF.md'), `# HANDOFF — close

## T01

- decision · minor · earlier entry
- deviation · minor · used X instead of Y
- review · major · \`a.md\`: reread
- rejection · minor · attempt 1, evaluation: gap one; gap two
- blind-spot · minor · criterion unverifiable in the context of the task: UI look
- debt · minor · flaky test, passed on the second run: test x
- decision · major · Auto pick: option A taken automatically (autonomous mode) — Add the test task
- debt · minor · auto entry
- amendment · major · T04: needs the guard
- amendment · major · T02: auto amend
- blind-spot · major · amendment not applied to T03: too late
- blind-spot · major · amendment not applied to T05: cancelled
- needs-human · major · T77 not applied: amends T77, a task missing from the plan
- needs-human · major · T02B not applied: plan-lint: T02B: unknown dependency T99
- needs-human · major · T01E not applied: plan-lint: no task T01E in T01E-wrong-id.md

## T02

- debt · minor · other
`)
    // Tasks: created as given, the refused one removed; amendments at the end of the lists, nothing removed, an item already there not repeated
    const file = f => readFileSync(join(K.d, 'tasks', f), 'utf8')
    assert.equal(file('T01B-follow-up-of-t01.md'), T01B); assert.equal(file('T01D-auto-test.md'), T01D)
    assert.ok(!readdirSync(join(K.d, 'tasks')).some(f => /^T0(2B|1E|1F|1G|1H)/.test(f)), readdirSync(join(K.d, 'tasks')).join())
    assert.equal(file('T04-x.md'), task({ id: 'T04', phase: 2, depends_on: ['T01'] }).replace('depends_on: [T01]', 'depends_on: [T01, T01B]').replace('  - src/T04/**\n', '  - src/T04/**\n  - "src/guard/**"\n').replace('  - "npm test"\n', '  - "npm test"\n  - "npm run lint"\n').replace('  - "the test passes"\n', '  - "the test passes"\n  - "the guard is tested"\n'))
    assert.equal(file('T02-x.md'), task({ id: 'T02' }).replace('depends_on: []', 'depends_on: [T01]').replace('  - "npm test"\n', '  - "npm test"\n  - "npm run e2e"\n'))
    for (const id of ['T03', 'T05']) assert.equal(file(`${id}-x.md`), task({ id, phase: id === 'T05' ? 2 : 1 }))
    // ISSUES.json: each issue whole, with the dry run of each option; the automatic decision settled by auto
    const doc = K.doc(), reg = JSON.parse(K.read('ISSUES.json'))
    assert.equal(reg.format, 'orchestre-issues/1')
    assert.deepEqual(reg.issues.map(p => [p.id, p.status, p.ruling, p.options.map(o => [o.id, o.valid, o.invalid_reason])]), [
      ['T01-1', 'open', null, [['A', true, null], ['B', false, 'dry run: T02: unknown dependency T99'], ['C', false, 'dry run: no task T01G in T01G-g.md']]],
      ['T01-2', 'settled', { option: 'A', text: null, author: 'auto', at: doc.updated, commit: null }, [['A', true, null], ['B', true, null]]],
    ])
    assert.deepEqual(reg.issues[1].options[0].added_tasks.map(x => x.id), ['T01D'], 'the actions of the options, whole')
    assert.equal(K.progress('validate').out, 'progress: progress.json valid (orchestre-progress/4, 7 tasks, 1 run)\nprogress: ISSUES.json valid (orchestre-issues/1, 2 issues, 1 open)')
    // progress.json: the copies, no option left with valid null; the automatic decision; the tasks added, not the refused one
    assert.deepEqual(doc.issues.map(p => [p.id, p.status, p.chosen_option, p.options.map(x => [x.valid, x.invalid_reason])]), [
      ['T01-1', 'open', null, [[true, null], [false, 'dry run: T02: unknown dependency T99'], [false, 'dry run: no task T01G in T01G-g.md']]], ['T01-2', 'settled', 'A', [[true, null], [true, null]]]])
    assert.deepEqual(doc.auto_decisions, [{ run: 1, task: 'T01', title: 'Auto pick', option: 'A', description: 'Add the test task' }])
    assert.deepEqual(doc.tasks.map(t => [t.id, t.status, t.added_by]), [['T01', 'merged', null], ['T01B', 'added', 'T01'], ['T01D', 'added', 'T01'], ['T02', 'todo', null], ['T03', 'merged', null], ['T04', 'todo', null], ['T05', 'cancelled', null]])
    assert.ok(doc.log.some(e => e.kind === 'error' && e.task === 'T02B' && e.text === 'T02B not applied after T01: plan-lint: T02B: unknown dependency T99'))
    assert.deepEqual(doc.reviews.map(x => x.text), ['`a.md`: reread'])
    assert.ok(K.lint().ok, JSON.stringify(K.lint().errors))
  })

  await test('close (0.20.0): a refusal after the plan was written puts every file back: unknown task, commit refused by a hook', () => {
    const before = snapshot(K)
    const E = { task: 'T88', status: 'merged', attempts: 1, entries: [{ type: 'deviation', severity: 'minor', description: 'z' }], added_tasks: [{ id: 'T09', title: 'New', phase: 1, content: task({ id: 'T09' }) }], amendments: [{ id: 'T02', reason: 'r', definition_of_done: ['more'] }], issues: [{ title: 'Q', options: [{ id: 'A', description: 'a' }] }] }
    let r = K.progress('close', E)
    assert.equal(r.code, 1, r.out); assert.equal(r.err, 'progress: unknown task in progress: T88')
    assert.deepEqual(snapshot(K), before)
    const hook = join(K.root, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 })
    try {
      r = K.progress('close', { ...E, task: 'T02', status: 'blocked' })
      assert.equal(r.code, 1, r.out); assert.equal(r.err, 'progress: close: commit refused (hook says no): nothing is written')
      assert.deepEqual(snapshot(K), before)
    } finally { unlinkSync(hook) }
    // Malformed input: refused before anything is written
    for (const [over, message] of [
      [{ entries: [{ type: 'deviation', severity: 'huge', description: 'x' }] }, 'close: entries[0] must be { type, severity: minor or major, description }'],
      [{ issues: [{ title: 'Q', auto: 'Z', options: [{ id: 'A', description: 'a' }] }] }, 'close: issue "Q": auto names option Z, which it does not have'],
      [{ issues: [{ options: [] }] }, 'close: issues[0] must be an object with a title'],
      [{ issues: [{ title: 'Q', options: ['A'] }] }, 'close: issues[0].options must be a list of objects'],
    ]) {
      r = K.progress('close', { task: 'T02', status: 'blocked', attempts: 1, ...over })
      assert.equal(r.code, 1, message); assert.equal(r.err, `progress: ${message}`)
    }
    assert.deepEqual(snapshot(K), before)
    // Accepted: an entry already written under its heading, word for word, is not written twice
    r = K.progress('close', { task: 'T02', status: 'blocked', attempts: 1, branch: 'task/T02', entries: [{ type: 'debt', severity: 'minor', description: 'other' }], blocker: ['b1'] })
    assert.equal(r.code, 0, r.err)
    assert.ok(K.read('HANDOFF.md').endsWith('## T02\n\n- debt · minor · other\n- blocker · major · b1\n'), K.read('HANDOFF.md'))
  })

  await test('close (0.20.0): an issue inherited from /3 is not dry-run and keeps its options invalid; no option of a new issue keeps valid null; ISSUES.json passes validate', () => {
    // An error plan-lint already raises (the model of T02): neither the dry run nor the check after close count it
    const R = repo('close-v3', { tasks: [{ id: 'T01' }, { id: 'T02', model: 'gpt' }], progress: PROGRESS_TEMPLATE(['T01', 'T02']) })
    assert.equal(R.progress('run-start', RUN).code, 0)
    assert.match(R.lint().errors.join(), /^T02: unknown model "gpt"/)
    const { pending_rulings, ...rest } = R.doc()
    const old = { run: 1, task: 'T01', title: 'Old', context: '', human: false, role: 'open', status: 'open', chosen_option: null, options: [{ id: 'A', description: 'Do A', recommended: true }] }
    writeFileSync(join(R.d, 'progress.json'), JSON.stringify({ ...rest, format: 'orchestre-progress/3', issues: [old] }, null, 2) + '\n')
    const r = R.progress('close', { task: 'T02', status: 'needs-human', attempts: 1, branch: 'task/T02', amendments: [{ id: 'T01', reason: 'r2', definition_of_done: ['more'] }], issues: [{ title: 'New', options: [{ id: 'A', description: 'a', valid: null }, { id: 'B', description: 'b', amendments: [{ id: 'T01', reason: 'r', verification: ['npm run x'] }] }] }] })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse(r.out).rejected, [])
    const doc = R.doc(), reg = JSON.parse(R.read('ISSUES.json'))
    assert.deepEqual([doc.issues[0].id, doc.issues[0].without_actions, doc.issues[0].options.map(o => [o.valid, o.invalid_reason])], ['T01-1', true, [[false, INHERITED]]])
    assert.deepEqual(doc.issues[1].options.map(o => o.valid), [true, true])
    assert.deepEqual(reg, { format: 'orchestre-issues/1', issues: [{ id: 'T02-1', task: 'T02', title: 'New', context: '', human: false, status: 'open', ruling: null, options: [
      { id: 'A', description: 'a', valid: true, invalid_reason: null, entries: [], added_tasks: [], amendments: [] },
      { id: 'B', description: 'b', valid: true, invalid_reason: null, entries: [], added_tasks: [], amendments: [{ id: 'T01', reason: 'r', verification: ['npm run x'] }] }] }] })
    assert.equal(R.progress('validate').out, 'progress: progress.json valid (orchestre-progress/4, 2 tasks, 1 run)\nprogress: ISSUES.json valid (orchestre-issues/1, 1 issue, 1 open)')
    assert.equal(JSON.parse(R.git('show', 'HEAD:plans/close-v3/ISSUES.json')).issues.length, 1, 'ISSUES.json committed')
    assert.equal(R.read('tasks/T01-x.md'), task({ id: 'T01' }).replace('  - "the test passes"\n', '  - "the test passes"\n  - "more"\n'), 'the dry run touches a copy, never the plan')
  })

  await test('close (0.20.0): a new error of plan-lint that names no task puts back every task created or amended, plan-lint without an answer too; a file of another task is never overwritten', () => {
    const R = repo('close-lint', { tasks: [{ id: 'T01' }, { id: 'T02' }], progress: PROGRESS_TEMPLATE(['T01', 'T02']) })
    assert.equal(R.progress('run-start', RUN).code, 0)
    // progress.mjs next to a plan-lint that adds an error naming no task as soon as tasks/ holds a T09, and answers nothing with a T08
    const bin = temp('lint-wrap-')
    writeFileSync(join(bin, 'progress.mjs'), readFileSync(PROGRESS_MJS, 'utf8'))
    writeFileSync(join(bin, 'plan-lint.mjs'), `import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
const files = readdirSync(process.argv[2] + '/tasks')
if (files.some(f => f.startsWith('T08'))) process.stdout.write('{')
else {
  const L = JSON.parse(spawnSync(process.execPath, [${JSON.stringify(LINT)}, ...process.argv.slice(2)], { encoding: 'utf8' }).stdout)
  if (files.some(f => f.startsWith('T09'))) { L.ok = false; L.errors.push('a new error that names no task') }
  process.stdout.write(JSON.stringify(L))
}
`)
    const close = E => { const r = spawnSync(process.execPath, [join(bin, 'progress.mjs'), 'close', R.plan], { cwd: R.root, encoding: 'utf8', input: JSON.stringify(E) }); return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() } }
    const T01 = R.read('tasks/T01-x.md')
    let r = close({ task: 'T02', status: 'blocked', attempts: 1, added_tasks: [{ id: 'T09', title: 'Nine', phase: 1, content: task({ id: 'T09' }) }], amendments: [{ id: 'T01', reason: 'r', definition_of_done: ['more'] }] })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse(r.out).rejected, [{ id: 'T09', reason: 'plan-lint: a new error that names no task' }, { id: 'T01', reason: 'plan-lint: a new error that names no task' }])
    assert.equal(R.read('tasks/T01-x.md'), T01); assert.ok(!existsSync(join(R.d, 'tasks', 'T09-nine.md')))
    r = close({ task: 'T02', status: 'blocked', attempts: 1, added_tasks: [{ id: 'T08', title: 'Eight', phase: 1, content: task({ id: 'T08' }) }] })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse(r.out).rejected.map(x => x.id), ['T08']); assert.match(JSON.parse(r.out).rejected[0].reason, /^plan-lint: plan-lint returned no state/)
    assert.ok(!existsSync(join(R.d, 'tasks', 'T08-eight.md')))
    assert.equal(R.clean(), '')
    // The file name an added task would take holds another task: refused, the file kept
    const other = task({ id: 'T06' })
    writeFileSync(join(R.d, 'tasks', 'T07-seven.md'), other)
    r = R.progress('close', { task: 'T02', status: 'blocked', attempts: 1, added_tasks: [{ id: 'T07', title: 'Seven', phase: 1, content: task({ id: 'T07' }) }] })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse(r.out).rejected, [{ id: 'T07', reason: 'T07-seven.md already exists for another task' }])
    assert.equal(R.read('tasks/T07-seven.md'), other)
  })

  await test('amendText and payloadDigest (0.20.0): items appended at the end of a list, inline or not, a list added when missing; a digest that ignores key order', () => {
    assert.equal(amendText('---\nid: X\ndepends_on: []\n---\nbody\n', { depends_on: ['T01', 'T01'], definition_of_done: ['a "b"'] }), '---\nid: X\ndepends_on: [T01]\ndefinition_of_done:\n  - "a \\"b\\""\n---\nbody\n')
    assert.equal(amendText('---\r\nid: X\r\nverification:\r\n    - "npm test"\r\nmodel: opus\r\n---\r\n', { verification: ['npm test', 'npm run e2e'], resources: ['db'] }), '---\r\nid: X\r\nverification:\r\n    - "npm test"\r\n    - "npm run e2e"\r\nmodel: opus\r\n---\r\n')
    assert.equal(amendText('no frontmatter', { depends_on: ['T01'] }), null)
    const p = { b: 1, a: [{ d: 'é', c: null }], _digest: 'x' }
    assert.equal(payloadDigest(p), payloadDigest({ a: [{ c: null, d: 'é' }], b: 1 }))
    for (const q of [{ ...p, b: 2 }, { ...p, a: [{ d: 'e', c: null }] }, { ...p, a: [{ c: null }, { d: 'é' }] }]) assert.notEqual(payloadDigest(q), payloadDigest(p))
    assert.notEqual(payloadDigest({ n: { _digest: 'kept' } }), payloadDigest({ n: {} }), 'only the top level loses its digest')
    assert.equal(payloadDigest({ digest: 'x', k: 1 }, 'digest'), payloadDigest({ k: 1 }))
    // A fixed vector, for the copy of the workflow (T17): FNV-1a of {"issues":[],"status":"merged","task":"T01"}
    assert.equal(payloadDigest({ task: 'T01', status: 'merged', issues: [] }), 'e4a3b3bf')
  })

  // ─── 0.20.0: apply reports the rulings recorded into the plan ──────────────────────────────────────────────────────────
  // T05 cancelled: an amendment of it is discarded. T01 raises three issues: the accounts-hub case (an added task that shares
  // the files of T02, without a dependency), a guard on T03, and a dependency of T02 on T03 that is valid alone but makes a
  // cycle once the guard is applied
  const A = repo('apply', {
    tasks: [{ id: 'T01' }, { id: 'T02' }, { id: 'T03' }, { id: 'T04' }, { id: 'T05' }],
    progress: PROGRESS_TEMPLATE(['T01', 'T02', 'T03', 'T04', 'T05']).replace('| T05 | Task T05 | 1 | 1A | — | sonnet | todo |', '| T05 | Task T05 | 1 | 1A | — | sonnet | cancelled |'),
    handoff: '# HANDOFF — apply\n',
  })
  assert.equal(A.progress('run-start', RUN).code, 0)
  const T01B = task({ id: 'T01B', title: 'Accounts hub page' }).replace('  - src/T01B/**\n', '  - src/T02/api.ts\n')
  const apply = (R = A) => { const r = R.progress('apply'); return { ...r, json: r.code === 0 ? JSON.parse(r.out) : null } }

  await test('apply (0.20.0): refused with code 1, writing nothing, unless the main checkout is on the integration branch; without a ruling recorded, writes nothing and exits 0', () => {
    const before = snapshot(A)
    let r = apply()
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.json, { applied: [], rejected: [], discarded: [], amended: [], added_tasks: [], commit: null, message: 'no ruling to apply', digest: r.json.digest })
    assert.equal(r.json.digest, payloadDigest(r.json, 'digest'))
    assert.deepEqual(snapshot(A), before, 'progress.json not even rewritten')
    A.git('switch', '-qc', 'task/T02')
    r = apply()
    assert.equal(r.code, 1, r.out); assert.equal(r.out, '')
    assert.equal(r.err, 'progress: apply: the main checkout is on the branch task/T02, not on the integration branch plan/apply: nothing is written; run git switch plan/apply first')
    A.git('switch', '-q', 'plan/apply'); A.git('branch', '-q', '-D', 'task/T02')
    assert.deepEqual(snapshot(A), before)
    assert.match(A.progress('nothing').err, /usage: progress\.mjs <[^>]*\|unrule\|apply\|run-end\|/, 'apply in the USAGE line')
  })

  await test('apply (0.20.0): three rulings, one refused by plan-lint: two applied in one commit "progress: rulings <ids>", the issue of the third open again with the reason; the accounts-hub case gets its dependency; apply twice writes nothing', () => {
    const E = {
      task: 'T01', status: 'needs-human', attempts: 1, branch: 'task/T01',
      issues: [
        { title: 'Accounts hub', context: 'the hub page', human: false, options: [
          { id: 'A', description: 'Add the hub page', recommended: true, added_tasks: [{ id: 'T01B', title: 'Accounts hub page', phase: 1, content: T01B }] }, { id: 'B', description: 'Leave it' }] },
        { title: 'Guard', context: 'c', human: false, options: [
          { id: 'A', description: 'Test the guard', entries: [{ type: 'debt', severity: 'minor', description: 'guard entry' }, { description: 'an entry without its type' }, { type: 'debt', severity: 'huge', description: 'x' }], amendments: [{ id: 'T03', reason: 'needs the guard', verification: ['npm run lint', 'npm test'], depends_on: ['T02'], definition_of_done: ['guarded'] }, { id: 'T05', reason: 'too late' }] }] },
        { title: 'Cycle', context: 'c', human: false, options: [{ id: 'A', description: 'T02 after T03', amendments: [{ id: 'T02', reason: 'after T03', depends_on: ['T03'] }] }] },
      ],
    }
    let r = A.progress('close', E)
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(A.doc().issues.map(p => [p.id, p.title, p.options[0].valid]), [['T01-1', 'Accounts hub', true], ['T01-2', 'Guard', true], ['T01-3', 'Cycle', true]], 'the dry run adds the dependency apply adds: the accounts-hub option is valid')
    assert.ok(!existsSync(join(A.d, 'tasks', 'T01B-accounts-hub-page.md')), 'an option is not applied by close')
    r = A.progress('rule', { items: [{ issue: 'T01-2', option: 'A' }, { issue: 'T01-3', option: 'A' }, { issue: 'T01-1', option: 'A' }] })
    assert.equal(r.code, 0, r.err)
    const pending = A.doc().pending_rulings, at = pending[0].at
    const head = A.git('rev-parse', 'HEAD').trim(), T02 = A.read('tasks/T02-x.md')
    r = apply()
    assert.equal(r.code, 0, r.err)
    const commit = A.git('rev-parse', 'HEAD').trim()
    const cycle = 'plan-lint: T02: dependency cycle; T03: dependency cycle'
    assert.deepEqual(r.json, {
      applied: [{ issue: 'T01-2', task: 'T01', option: 'A', text: null }, { issue: 'T01-1', task: 'T01', option: 'A', text: null }],
      rejected: [{ issue: 'T01-3', option: 'A', text: null, reason: cycle }],
      discarded: [{ id: 'T05', reason: 'too late' }],
      amended: [{ id: 'T03', verification: ['npm run lint'], depends_on: ['T02'] }, { id: 'T01B', verification: [], depends_on: ['T02'] }],
      added_tasks: [{ id: 'T01B', title: 'Accounts hub page', phase: 1 }],
      commit, message: `2 rulings applied (T01-2, T01-1); 1 refused (T01-3); committed ${commit.slice(0, 7)}`, digest: r.json.digest,
    })
    assert.equal(r.json.digest, payloadDigest(r.json, 'digest'))
    // One commit, of the plan's files
    assert.equal(A.git('log', '--format=%s', `${head}..HEAD`), 'progress: rulings T01-2, T01-1\n')
    assert.deepEqual(A.git('show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['HANDOFF.md', 'ISSUES.json', 'PROGRESS.md', 'tasks/T01B-accounts-hub-page.md', 'tasks/T03-x.md'].map(f => `plans/apply/${f}`))
    assert.equal(A.clean(), ''); assert.deepEqual(A.leftovers(), [])
    // HANDOFF.md: the decision of each ruling applied, then the actions of its option as close writes them
    assert.equal(A.read('HANDOFF.md'), `# HANDOFF — apply

## T01

- decision · major · Guard: option A settled by the user — Test the guard
- debt · minor · guard entry
- amendment · major · T03: needs the guard
- blind-spot · major · amendment not applied to T05: too late
- decision · major · Accounts hub: option A settled by the user — Add the hub page
- amendment · minor · T01B: depends on T02, added automatically: the two tasks of phase 1 share src/T02/api.ts, src/T02/**
`)
    // The tasks: T01B with its dependency, T03 amended, T02 put back as it was, T05 untouched
    assert.equal(A.read('tasks/T01B-accounts-hub-page.md'), T01B.replace('depends_on: []', 'depends_on: [T02]'))
    assert.equal(A.read('tasks/T03-x.md'), task({ id: 'T03' }).replace('depends_on: []', 'depends_on: [T02]').replace('  - "npm test"\n', '  - "npm test"\n  - "npm run lint"\n').replace('  - "the test passes"\n', '  - "the test passes"\n  - "guarded"\n'))
    assert.equal(A.read('tasks/T02-x.md'), T02); assert.equal(A.read('tasks/T05-x.md'), task({ id: 'T05' }))
    assert.ok(A.lint().ok, JSON.stringify(A.lint().errors))
    // ISSUES.json: the two issues settled with their ruling; the third open, its option invalid with the reason
    const reg = JSON.parse(A.read('ISSUES.json'))
    assert.deepEqual(reg.issues.map(p => [p.id, p.status, p.ruling, p.options[0].valid, p.options[0].invalid_reason]), [
      ['T01-1', 'settled', { option: 'A', text: null, author: 'user', at, commit: null }, true, null],
      ['T01-2', 'settled', { option: 'A', text: null, author: 'user', at, commit: null }, true, null],
      ['T01-3', 'open', null, false, cycle],
    ])
    // progress.json: the same in the copies, the rulings out of pending_rulings, T01B added after T01, the rulings of the run
    const doc = A.doc()
    assert.deepEqual(doc.issues.map(p => [p.id, p.status, p.chosen_option, p.options[0].valid, p.options[0].invalid_reason]), [['T01-1', 'settled', 'A', true, null], ['T01-2', 'settled', 'A', true, null], ['T01-3', 'open', null, false, cycle]])
    assert.deepEqual(doc.pending_rulings, [])
    assert.deepEqual(doc.tasks.map(t => [t.id, t.status, t.added_by, t.depends_on]), [['T01', 'needs-human', null, []], ['T01B', 'added', 'T01', ['T02']], ['T02', 'todo', null, []], ['T03', 'todo', null, ['T02']], ['T04', 'todo', null, []], ['T05', 'cancelled', null, []]])
    const run = doc.runs.at(-1)
    assert.deepEqual(run.rulings_applied, [{ task: 'T01', title: 'Guard', option: 'A' }, { task: 'T01', title: 'Accounts hub', option: 'A' }])
    assert.deepEqual(run.discarded_amendments, [{ task: 'T01', id: 'T05', reason: 'too late' }])
    assert.deepEqual(doc.log.filter(e => e.kind === 'ruling').slice(-3).map(e => e.text), ['T01-2: option A applied', `T01-3: option A not applied: ${cycle}; the issue is open again`, 'T01-1: option A applied'])
    assert.equal(A.progress('validate').out, 'progress: progress.json valid (orchestre-progress/4, 6 tasks, 1 run)\nprogress: ISSUES.json valid (orchestre-issues/1, 3 issues, 1 open)')
    // The issue reopened: back in Your turn, and rule refuses its option with the reason
    assert.match(yourTurn(A.progress('status').out), /1 issue to settle/)
    assert.equal(A.progress('rule', { issue: 'T01-3', option: 'A' }).err, `progress: rule: option A of T01-3 is invalid: ${cycle}`)
    // apply twice: nothing pending, nothing written
    const before = snapshot(A)
    r = apply()
    assert.equal(r.code, 0, r.err); assert.equal(r.json.message, 'no ruling to apply'); assert.equal(r.json.commit, null)
    assert.deepEqual(snapshot(A), before)
  })

  await test('apply (0.20.0): rulings it cannot apply (unknown or settled issue, option absent, invalid, without its actions, refused by applyActions) are refused one by one; a refused commit puts every file back', () => {
    // An issue known by progress.json only (the stop issue of a run end): its actions are unknown
    assert.equal(A.progress('run-end', { status: 'awaiting-ruling', stop_issue: { task: 'T02', title: 'Stop', human: false, options: [{ id: 'A', description: 'Go on' }] } }).code, 0)
    assert.equal(A.progress('run-start', RUN).code, 0)
    // Two issues of the register, set by hand: T02-2 amends a task missing from the plan; T02-3 is invalid since its ruling
    const reg = JSON.parse(A.read('ISSUES.json'))
    reg.issues.push(entry('T02-2', { options: [{ id: 'A', description: 'Amend T77', amendments: [{ id: 'T77', reason: 'x' }] }] }), entry('T02-3', { options: [{ id: 'A', description: 'Do A', valid: false, invalid_reason: 'said later' }] }),
      // T02-4 adds a task whose file holds another id: plan-lint does not read T02X, the file is removed
      entry('T02-4', { options: [{ id: 'A', description: 'Add T02X', added_tasks: [{ id: 'T02X', title: 'Wrong id', phase: 1, content: task({ id: 'T02Y' }) }] }] }))
    writeFileSync(join(A.d, 'ISSUES.json'), JSON.stringify(reg, null, 2) + '\n'); A.git('commit', '-qam', 'register by hand')
    const doc = A.doc(), at = doc.updated, ruling = (issue, option) => ({ issue, option, text: null, at })
    assert.deepEqual(doc.issues.filter(p => p.task === 'T02').map(p => p.id), ['T02-1'])
    doc.pending_rulings = [ruling('T01-3', 'Z'), ruling('T09-1', 'A'), ruling('T01-2', 'A'), ruling('T02-1', 'A'), ruling('T02-2', 'A'), ruling('T02-3', 'A'), ruling('T02-4', 'A')]
    writeFileSync(join(A.d, 'progress.json'), JSON.stringify(doc, null, 2) + '\n')
    const handoff = A.read('HANDOFF.md'), head = A.git('rev-parse', 'HEAD').trim()
    let r = apply()
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.json.rejected, [
      { issue: 'T01-3', option: 'Z', text: null, reason: 'option Z absent from issue T01-3' },
      { issue: 'T09-1', option: 'A', text: null, reason: 'unknown issue' },
      { issue: 'T01-2', option: 'A', text: null, reason: 'issue already settled' },
      { issue: 'T02-1', option: 'A', text: null, reason: 'no entry in ISSUES.json: the actions of option A are unknown; answer with a text' },
      { issue: 'T02-2', option: 'A', text: null, reason: 'amends T77, a task missing from the plan' },
      { issue: 'T02-3', option: 'A', text: null, reason: 'option A invalid: said later' },
      { issue: 'T02-4', option: 'A', text: null, reason: 'plan-lint: no task T02X in T02X-wrong-id.md' },
    ])
    assert.deepEqual([r.json.applied, r.json.amended, r.json.added_tasks], [[], [], []])
    assert.equal(A.read('HANDOFF.md'), handoff, 'nothing applied, nothing in HANDOFF.md')
    assert.ok(!existsSync(join(A.d, 'tasks', 'T02X-wrong-id.md')))
    assert.equal(A.git('log', '--format=%s', `${head}..HEAD`), 'progress: rulings refused T01-3, T09-1, T01-2, T02-1, T02-2, T02-3, T02-4\n')
    // Reopened with the reason: the option of the copy (T02-1) or of the register (T02-2) invalid; the others untouched
    const after = A.doc(), reg2 = JSON.parse(A.read('ISSUES.json')), opt = (ps, id) => ps.find(p => p.id === id).options[0]
    assert.deepEqual(after.pending_rulings, [])
    assert.deepEqual([opt(after.issues, 'T02-1').valid, opt(after.issues, 'T02-1').invalid_reason], [false, 'no entry in ISSUES.json: the actions of option A are unknown; answer with a text'])
    assert.deepEqual([opt(reg2.issues, 'T02-2').valid, opt(reg2.issues, 'T02-2').invalid_reason], [false, 'amends T77, a task missing from the plan'])
    assert.deepEqual([opt(after.issues, 'T01-3').invalid_reason, reg2.issues.find(p => p.id === 'T01-2').status], [`plan-lint: T02: dependency cycle; T03: dependency cycle`, 'settled'])
    assert.equal(A.clean(), '')
    // A commit refused by a hook: every file put back, the ruling still recorded
    assert.equal(A.progress('rule', { items: [{ issue: 'T01-3', text: 'Keep them apart' }, { issue: 'T02-2', text: 'Drop it' }] }).code, 0)
    const before = snapshot(A)
    const hook = join(A.root, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n', { mode: 0o755 })
    try {
      r = apply()
      assert.equal(r.code, 1, r.out); assert.equal(r.err, 'progress: apply: commit refused (hook says no): nothing is written')
      assert.deepEqual(snapshot(A), before)
    } finally { unlinkSync(hook) }
    r = apply()
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.json.applied.map(x => [x.issue, x.text]), [['T01-3', 'Keep them apart'], ['T02-2', 'Drop it']])
    assert.ok(A.read('HANDOFF.md').endsWith('- amendment · minor · T01B: depends on T02, added automatically: the two tasks of phase 1 share src/T02/api.ts, src/T02/**\n- decision · major · Cycle: settled by the user — Keep them apart\n\n## T02\n\n- decision · major · Issue T02-2: settled by the user — Drop it\n'), A.read('HANDOFF.md'))
  })

  await test('apply (0.20.0): a text ruling on an issue inherited from /3 (without_actions) is one decision · major entry, no task added nor amended; the issue settled in ISSUES.json, with its ruling, and in progress.json', () => {
    const R = repo('apply-v3', { tasks: [{ id: 'T01' }, { id: 'T02' }], progress: PROGRESS_TEMPLATE(['T01', 'T02']), handoff: '# HANDOFF — apply-v3\n' })
    assert.equal(R.progress('run-start', RUN).code, 0)
    const { pending_rulings, ...rest } = R.doc()
    const old = { run: 1, task: 'T01', title: 'Old', context: 'from 0.19', human: false, role: 'open', status: 'open', chosen_option: null, options: [{ id: 'A', description: 'Do A', recommended: true }] }
    writeFileSync(join(R.d, 'progress.json'), JSON.stringify({ ...rest, format: 'orchestre-progress/3', issues: [old] }, null, 2) + '\n')
    assert.equal(R.progress('rule', { issue: 'T01-1', text: 'Do it by hand' }).code, 0)
    assert.ok(!existsSync(join(R.d, 'ISSUES.json')))
    const at = R.doc().pending_rulings[0].at, tasks = snapshot(R).tasks, head = R.git('rev-parse', 'HEAD').trim()
    const r = apply(R)
    assert.equal(r.code, 0, r.err)
    const commit = R.git('rev-parse', 'HEAD').trim()
    assert.deepEqual(r.json, { applied: [{ issue: 'T01-1', task: 'T01', option: null, text: 'Do it by hand' }], rejected: [], discarded: [], amended: [], added_tasks: [], commit, message: `1 ruling applied (T01-1); committed ${commit.slice(0, 7)}`, digest: r.json.digest })
    assert.equal(R.read('HANDOFF.md'), '# HANDOFF — apply-v3\n\n## T01\n\n- decision · major · Old: settled by the user — Do it by hand\n')
    assert.deepEqual(snapshot(R).tasks, tasks, 'no task added nor amended')
    assert.equal(R.git('log', '--format=%s', `${head}..HEAD`), 'progress: rulings T01-1\n')
    assert.deepEqual(R.git('show', '--name-only', '--format=', 'HEAD').trim().split('\n'), ['plans/apply-v3/HANDOFF.md', 'plans/apply-v3/ISSUES.json'])
    // The register gets the issue, from its copy: settled, with its ruling
    assert.deepEqual(JSON.parse(R.read('ISSUES.json')), { format: 'orchestre-issues/1', issues: [{ id: 'T01-1', task: 'T01', title: 'Old', context: 'from 0.19', human: false,
      options: [{ id: 'A', description: 'Do A', recommended: true, valid: false, invalid_reason: INHERITED, entries: [], added_tasks: [], amendments: [] }],
      status: 'settled', ruling: { option: null, text: 'Do it by hand', author: 'user', at, commit: null } }] })
    const doc = R.doc()
    assert.deepEqual([doc.issues[0].status, doc.issues[0].chosen_option, doc.pending_rulings], ['settled', null, []])
    assert.deepEqual(doc.runs[0].rulings_applied, [{ task: 'T01', title: 'Old', option: 'free answer' }])
    assert.equal(R.progress('validate').out, 'progress: progress.json valid (orchestre-progress/4, 2 tasks, 1 run)\nprogress: ISSUES.json valid (orchestre-issues/1, 1 issue, 0 open)')
    assert.equal(R.clean(), '')
  })

  await test('close (0.20.0): a task it adds that shares files with a task of its phase, without a dependency, depends on it, noted in HANDOFF.md', () => {
    const T04B = task({ id: 'T04B', title: 'Shares T04' }).replace('  - src/T04B/**\n', '  - src/T04/x.ts\n')
    const r = A.progress('close', { task: 'T02', status: 'blocked', attempts: 1, branch: 'task/T02', added_tasks: [{ id: 'T04B', title: 'Shares T04', phase: 1, content: T04B }] })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse(r.out).rejected, [])
    assert.equal(A.read('tasks/T04B-shares-t04.md'), T04B.replace('depends_on: []', 'depends_on: [T04]'))
    assert.ok(A.read('HANDOFF.md').endsWith('## T02\n\n- decision · major · Issue T02-2: settled by the user — Drop it\n- amendment · minor · T04B: depends on T04, added automatically: the two tasks of phase 1 share src/T04/**, src/T04/x.ts\n'), A.read('HANDOFF.md'))
    assert.ok(A.lint().ok, JSON.stringify(A.lint().errors))
  })

  await test('apply (0.20.0): an error already in the plan (two tasks that share files) neither refuses an option nor gets a dependency; of two tasks an option adds that share files, the later one depends on the earlier one', () => {
    const R = repo('apply-known', { tasks: [{ id: 'T01' }, { id: 'T02' }], progress: PROGRESS_TEMPLATE(['T01', 'T02']), handoff: '# HANDOFF — apply-known\n' })
    writeFileSync(join(R.d, 'tasks', 'T02-x.md'), task({ id: 'T02' }).replace('  - src/T02/**\n', '  - src/T01/x.ts\n')); R.git('commit', '-qam', 'T02 shares the files of T01')
    assert.deepEqual(R.lint().overlaps, [{ a: 'T01', b: 'T02', files: ['src/T01/**', 'src/T01/x.ts'] }])
    assert.equal(R.progress('run-start', RUN).code, 0)
    const T03 = task({ id: 'T03', title: 'Shared one' }).replace('  - src/T03/**\n', '  - src/s/**\n'), T03B = task({ id: 'T03B', title: 'Shared two' }).replace('  - src/T03B/**\n', '  - src/s/b.ts\n')
    let r = R.progress('close', { task: 'T01', status: 'needs-human', attempts: 1, branch: 'task/T01', issues: [{ title: 'Split', options: [{ id: 'A', description: 'Two tasks', added_tasks: [{ id: 'T03', title: 'Shared one', phase: 1, content: T03 }, { id: 'T03B', title: 'Shared two', phase: 1, content: T03B }] }] }] })
    assert.equal(r.code, 0, r.err)
    assert.equal(R.doc().issues[0].options[0].valid, true, R.doc().issues[0].options[0].invalid_reason)
    assert.equal(R.progress('rule', { issue: 'T01-1', option: 'A' }).code, 0)
    r = apply(R)
    assert.equal(r.code, 0, r.err)
    assert.deepEqual([r.json.applied.map(x => x.issue), r.json.rejected, r.json.amended, r.json.added_tasks], [['T01-1'], [], [{ id: 'T03B', verification: [], depends_on: ['T03'] }], [{ id: 'T03', title: 'Shared one', phase: 1 }, { id: 'T03B', title: 'Shared two', phase: 1 }]])
    assert.equal(R.read('tasks/T03-shared-one.md'), T03); assert.equal(R.read('tasks/T03B-shared-two.md'), T03B.replace('depends_on: []', 'depends_on: [T03]'))
    assert.equal(R.read('tasks/T02-x.md'), task({ id: 'T02' }).replace('  - src/T02/**\n', '  - src/T01/x.ts\n'), 'no dependency between two tasks already there')
    assert.ok(R.read('HANDOFF.md').endsWith('- decision · major · Split: option A settled by the user — Two tasks\n- amendment · minor · T03B: depends on T03, added automatically: the two tasks of phase 1 share src/s/**, src/s/b.ts\n'), R.read('HANDOFF.md'))
    assert.deepEqual(R.lint().errors, ['T01 and T02 can run together and share files'])
  })

  // ─── 0.20.0 (T20C): fixes of apply, close and run-end before the release ────────────────────────────────────────────────
  const reader = (R, phase) => spawnSync(process.execPath, [LINT, R.plan, '--reader', '--phase', String(phase), '--integration', `plan/${R.plan.split('/')[1]}`], { cwd: R.root, encoding: 'utf8' })
  const section = (R, id) => { const l = R.read('HANDOFF.md').split('\n'), h = l.indexOf(`## ${id}`); let e = h + 1; while (e < l.length && !l[e].startsWith('## ')) e++; return l.slice(h + 1, e).filter(x => x.startsWith('- ')) }

  await test('apply (0.20.0): a task an option adds joins the phase of the run that applies it when its own phase is over, in its file, in the output and in HANDOFF.md; plan-lint --reader of that phase passes; a later phase is kept', () => {
    const R = repo('phase', { tasks: [{ id: 'T01' }, { id: 'T02', phase: 2 }], progress: PROGRESS_TEMPLATE(['T01', 'T02']), handoff: '# HANDOFF — phase\n' })
    assert.equal(R.progress('run-start', RUN).code, 0)
    const T01B = task({ id: 'T01B', title: 'Follow-up' }), T01C = task({ id: 'T01C', title: 'Later one', phase: 3 })
    let r = R.progress('close', { task: 'T01', status: 'merged', attempts: 1, branch: 'task/T01', issues: [
      { title: 'Follow-up', options: [{ id: 'A', description: 'Add it', added_tasks: [{ id: 'T01B', title: 'Follow-up', phase: 1, content: T01B }] }] },
      { title: 'Later', options: [{ id: 'A', description: 'Add it later', added_tasks: [{ id: 'T01C', title: 'Later one', phase: 3, content: T01C }] }] }] })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse(R.read('ISSUES.json')).issues.map(p => p.options[0].added_tasks[0].phase), [1, 3], 'the register keeps the phase close fixed')
    R.git('commit', '-q', '--allow-empty', '-m', 'task T01: Task T01')
    assert.equal(R.progress('run-end', { status: 'finished' }).code, 0)
    // The rulings, recorded between two runs, are applied at the start of phase 2
    assert.equal(R.progress('rule', { items: [{ issue: 'T01-1', option: 'A' }, { issue: 'T01-2', option: 'A' }] }).code, 0)
    assert.equal(R.progress('run-start', { ...RUN, phase: 2 }).code, 0)
    r = apply(R)
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.json.added_tasks, [{ id: 'T01B', title: 'Follow-up', phase: 2 }, { id: 'T01C', title: 'Later one', phase: 3 }])
    assert.equal(R.read('tasks/T01B-follow-up.md'), task({ id: 'T01B', title: 'Follow-up', phase: 2 }))
    assert.equal(R.read('tasks/T01C-later-one.md'), T01C)
    assert.deepEqual(section(R, 'T01'), [
      '- decision · major · Follow-up: option A settled by the user — Add it',
      '- amendment · minor · T01B: phase 1 raised to phase 2, the phase of the run that applies the ruling',
      '- decision · major · Later: option A settled by the user — Add it later',
    ])
    assert.deepEqual(R.doc().tasks.filter(t => t.added_by === 'T01').map(t => [t.id, t.phase]), [['T01B', 2], ['T01C', 3]])
    const rd = reader(R, 2)
    assert.equal(rd.status, 0, rd.stdout + rd.stderr)
    assert.deepEqual(JSON.parse(rd.stdout).tasks.map(t => t.id), ['T01B', 'T02'])
    // Without a run in progress, the phase of the last run: phase 2 here
    assert.equal(R.progress('run-end', { status: 'finished' }).code, 0)
    const T01D = task({ id: 'T01D', title: 'Between runs' })
    assert.equal(R.progress('run-start', { ...RUN, phase: 2 }).code, 0)
    assert.equal(R.progress('close', { task: 'T02', status: 'blocked', attempts: 1, branch: 'task/T02', issues: [{ title: 'Between', options: [{ id: 'A', description: 'Add D', added_tasks: [{ id: 'T01D', title: 'Between runs', phase: 1, content: T01D }] }] }] }).code, 0)
    assert.equal(R.progress('run-end', { status: 'partial' }).code, 0)
    assert.equal(R.progress('rule', { issue: 'T02-1', option: 'A' }).code, 0)
    r = apply(R)
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.json.added_tasks, [{ id: 'T01D', title: 'Between runs', phase: 2 }])
    assert.equal(R.read('tasks/T01D-between-runs.md'), task({ id: 'T01D', title: 'Between runs', phase: 2 }))
  })

  await test('close (0.20.0): run twice with the same input, it records no issue again (same run, task and title): same ids in the output, progress.json and ISSUES.json, the automatic decision noted once', () => {
    const R = repo('replay', { tasks: [{ id: 'T01' }, { id: 'T02' }], progress: PROGRESS_TEMPLATE(['T01', 'T02']), handoff: '# HANDOFF — replay\n' })
    assert.equal(R.progress('run-start', { ...RUN, mode: 'auto' }).code, 0)
    const E = { task: 'T01', status: 'merged', attempts: 1, branch: 'task/T01', auto_decisions: [{ title: 'Legacy pick', option: 'B', description: 'Old style' }], issues: [
      { title: 'Open one', options: [{ id: 'A', description: 'Do A', amendments: [{ id: 'T02', reason: 'r', definition_of_done: ['more'] }] }, { id: 'B', description: 'Do B' }] },
      { title: 'Decided', auto: 'A', options: [{ id: 'A', description: 'Note it', entries: [{ type: 'debt', severity: 'minor', description: 'noted' }], amendments: [{ id: 'T02', reason: 'auto', verification: ['npm run x'] }] }, { id: 'B', description: 'Skip' }] },
      // The same title twice in one close: two issues, matched one to one when the close runs again
      { title: 'Open one', options: [{ id: 'A', description: 'Again' }] }] }
    let r = R.progress('close', E)
    assert.equal(r.code, 0, r.err)
    const first = JSON.parse(r.out), doc1 = R.doc(), reg1 = R.read('ISSUES.json'), handoff = R.read('HANDOFF.md'), T02 = R.read('tasks/T02-x.md')
    assert.deepEqual(first.issues, ['T01-1', 'T01-2', 'T01-3'])
    r = R.progress('close', E)
    assert.equal(r.code, 0, r.err)
    const second = JSON.parse(r.out), doc2 = R.doc()
    assert.deepEqual(second.issues, first.issues)
    assert.equal(second.commit, null, 'nothing new to commit')
    assert.deepEqual(doc2.issues, doc1.issues)
    assert.equal(R.read('ISSUES.json'), reg1)
    assert.deepEqual(doc2.auto_decisions, [{ run: 1, task: 'T01', title: 'Legacy pick', option: 'B', description: 'Old style' }, { run: 1, task: 'T01', title: 'Decided', option: 'A', description: 'Note it' }])
    assert.deepEqual([R.read('HANDOFF.md'), R.read('tasks/T02-x.md')], [handoff, T02])
    assert.equal(R.clean(), '')
    // A new run: the same title is a new issue
    assert.equal(R.progress('run-end', { status: 'partial' }).code, 0)
    assert.equal(R.progress('run-start', RUN).code, 0)
    r = R.progress('close', { task: 'T01', status: 'merged', attempts: 1, branch: 'task/T01', issues: [E.issues[0]] })
    assert.deepEqual(JSON.parse(r.out).issues, ['T01-4'])
  })

  // progress.mjs next to a plan-lint that notes, at each call, whether .progress.lock exists; with HOOK set, its first call runs
  // that command (JSON: [args, input]) with the real progress.mjs
  const probe = () => {
    const bin = temp('lint-probe-')
    writeFileSync(join(bin, 'progress.mjs'), readFileSync(PROGRESS_MJS, 'utf8'))
    writeFileSync(join(bin, 'plan-lint.mjs'), `import { spawnSync } from 'node:child_process'
import { existsSync, appendFileSync, writeFileSync } from 'node:fs'
appendFileSync(process.env.PROBE_LOG, (existsSync(process.env.PROBE_LOCK) ? 'held' : 'free') + '\\n')
if (process.env.HOOK && !existsSync(process.env.PROBE_LOG + '.hook')) {
  writeFileSync(process.env.PROBE_LOG + '.hook', '')
  for (const [args, input] of JSON.parse(process.env.HOOK)) spawnSync(process.execPath, [${JSON.stringify(PROGRESS_MJS)}, ...args], { input: JSON.stringify(input), stdio: ['pipe', 'ignore', 'ignore'] })
}
const r = spawnSync(process.execPath, [${JSON.stringify(LINT)}, ...process.argv.slice(2)], { encoding: 'utf8', maxBuffer: 1 << 26 })
process.stdout.write(r.stdout)
process.exitCode = r.status
`)
    return (R, cmd, E, hook = null) => {
      const log = join(bin, `calls-${cmd}.txt`)
      for (const f of [log, log + '.hook']) if (existsSync(f)) unlinkSync(f)
      const env = { ...process.env, PROBE_LOG: log, PROBE_LOCK: join(R.d, '.progress.lock'), ...(hook ? { HOOK: JSON.stringify(hook) } : {}) }
      const r = spawnSync(process.execPath, [join(bin, 'progress.mjs'), cmd, R.plan], { cwd: R.root, encoding: 'utf8', env, ...(E === undefined ? {} : { input: JSON.stringify(E) }) })
      return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim(), calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] }
    }
  }

  await test('close and apply (0.20.0): no plan-lint call while .progress.lock is held (dry run, check of the tasks written, each ruling); a ruling changed while apply runs refuses it with code 1, every file put back', () => {
    const R = repo('lock', { tasks: [{ id: 'T01' }, { id: 'T02' }, { id: 'T03' }], progress: PROGRESS_TEMPLATE(['T01', 'T02', 'T03']), handoff: '# HANDOFF — lock\n' })
    assert.equal(R.progress('run-start', RUN).code, 0)
    const run = probe()
    // A close with a task created, an amendment and two options to dry-run
    let r = run(R, 'close', { task: 'T01', status: 'merged', attempts: 1, branch: 'task/T01', added_tasks: [{ id: 'T01B', title: 'B', phase: 1, content: task({ id: 'T01B' }) }], amendments: [{ id: 'T03', reason: 'r', definition_of_done: ['x'] }],
      issues: [{ title: 'One', options: [{ id: 'A', description: 'a', amendments: [{ id: 'T02', reason: 'r', verification: ['npm run a'] }] }, { id: 'B', description: 'b', added_tasks: [{ id: 'T01C', title: 'C', phase: 1, content: task({ id: 'T01C' }) }] }] },
        { title: 'Two', options: [{ id: 'A', description: 'a', amendments: [{ id: 'T03', reason: 'r', verification: ['npm run b'] }] }] }] })
    assert.equal(r.code, 0, r.err)
    assert.ok(r.calls.length >= 6, r.calls.join())
    assert.deepEqual([...new Set(r.calls)], ['free'], r.calls.join())
    assert.equal(R.progress('rule', { items: [{ issue: 'T01-1', option: 'B' }, { issue: 'T01-2', option: 'A' }] }).code, 0)
    // A ruling changed while apply works outside the lock (unrule, then rule with a text): apply refused, nothing written
    const before = snapshot(R)
    r = run(R, 'apply', undefined, [[['unrule', R.plan], { issue: 'T01-2' }], [['rule', R.plan], { issue: 'T01-2', text: 'Not that way' }]])
    assert.equal(r.code, 1, r.out)
    assert.equal(r.err, 'progress: apply: the ruling of T01-2 was withdrawn or changed while apply ran (unrule, rule): nothing is written; run apply again')
    const after = snapshot(R)
    assert.deepEqual({ ...after, files: after.files.filter((_, i) => i !== 0) }, { ...before, files: before.files.filter((_, i) => i !== 0) }, 'the plan as it was')
    assert.deepEqual(R.doc().pending_rulings.map(x => [x.issue, x.option, x.text]), [['T01-1', 'B', null], ['T01-2', null, 'Not that way']])
    assert.ok(!existsSync(join(R.d, 'tasks', 'T01C-c.md')))
    // Applied again: two rulings, no plan-lint under the lock
    r = run(R, 'apply')
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse(r.out).applied.map(x => [x.issue, x.option, x.text]), [['T01-1', 'B', null], ['T01-2', null, 'Not that way']])
    assert.ok(r.calls.length >= 2, r.calls.join())
    assert.deepEqual([...new Set(r.calls)], ['free'], r.calls.join())
    assert.ok(existsSync(join(R.d, 'tasks', 'T01C-c.md')))
    assert.equal(R.clean(), ''); assert.deepEqual(R.leftovers(), [])
  })

  await test('close (0.20.0): an automatic decision whose option cites a path that neither exists nor is owned by a task the close adds is rejected: issue open, nothing of the option written, a needs-human entry', () => {
    const R = repo('paths', { tasks: [{ id: 'T01' }, { id: 'T02' }, { id: 'T03' }], progress: PROGRESS_TEMPLATE(['T01', 'T02', 'T03']), handoff: '# HANDOFF — paths\n' })
    mkdirSync(join(R.root, 'src', 'T02'), { recursive: true }); writeFileSync(join(R.root, 'src', 'T02', 'a.ts'), 'x\n'); mkdirSync(join(R.root, 'src', 'lib')); writeFileSync(join(R.root, 'src', 'lib', 'u.ts'), 'u\n'); R.git('add', '.'); R.git('commit', '-qm', 'src')
    assert.equal(R.progress('run-start', { ...RUN, mode: 'auto' }).code, 0)
    const T01B = task({ id: 'T01B', title: 'New module' }).replace('  - src/T01B/**\n', '  - src/new/**\n')
    const decided = (title, o) => ({ title, auto: 'A', options: [{ id: 'A', ...o }, { id: 'B', description: 'Skip' }] })
    const E = { task: 'T01', status: 'merged', attempts: 1, branch: 'task/T01', auto_decisions: [{ title: 'Missing owned', option: 'A', description: 'Guard the missing file' }], issues: [
      // A missing owned_files path of an amendment: rejected
      decided('Missing owned', { description: 'Guard the missing file', entries: [{ type: 'debt', severity: 'minor', description: 'should not be written' }], added_tasks: [{ id: 'T01X', title: 'X', phase: 1, content: task({ id: 'T01X' }) }], amendments: [{ id: 'T02', reason: 'guard', owned_files: ['src/gone/**'] }] }),
      // A missing path cited in backquotes of a criterion, with a line number: rejected too
      decided('Missing cited', { description: 'See `src/T02/a.ts:3`', amendments: [{ id: 'T03', reason: 'cite', definition_of_done: ['`src/T02/b.ts:12` is tested'] }] }),
      // The same kind of path owned by a task the close adds, a placeholder, a branch, an existing file: accepted
      decided('Owned', { description: 'Write `src/new/x.ts` on `task/T01`, as `<plan>/tasks/` and `plans/<name>/tasks/` say (`src/x y`); see `src/T02/a.ts` and `https://x.y/a`', added_tasks: [{ id: 'T01B', title: 'New module', phase: 1, content: T01B }], amendments: [{ id: 'T03', reason: 'owned', owned_files: ['src/new/y.ts', 'src/lib/**'], verification: ['`src/new/z.ts` exists'] }] }),
    ] }
    const head = R.git('rev-parse', 'HEAD').trim()
    const r = R.progress('close', E)
    assert.equal(r.code, 0, r.err)
    const o = JSON.parse(r.out)
    assert.deepEqual(o.rejected, [
      { id: 'src/gone/**', reason: 'inconsistent auto-decision on issue "Missing owned", option A: src/gone/** does not exist and no task creates it' },
      { id: 'src/T02/b.ts:12', reason: 'inconsistent auto-decision on issue "Missing cited", option A: src/T02/b.ts:12 does not exist and no task creates it' },
    ])
    assert.deepEqual(o.issues, ['T01-1', 'T01-2', 'T01-3'])
    assert.deepEqual(section(R, 'T01'), [
      '- decision · major · Owned: option A taken automatically (autonomous mode) — Write `src/new/x.ts` on `task/T01`, as `<plan>/tasks/` and `plans/<name>/tasks/` say (`src/x y`); see `src/T02/a.ts` and `https://x.y/a`',
      '- amendment · major · T03: owned',
      '- amendment · minor · T01B: depends on T03, added automatically: the two tasks of phase 1 share src/new/**, src/new/y.ts',
      '- needs-human · major · inconsistent auto-decision: src/gone/** does not exist and no task creates it',
      '- needs-human · major · inconsistent auto-decision: src/T02/b.ts:12 does not exist and no task creates it',
    ])
    // Nothing of the rejected options: no task T01X, T02 untouched, T03 only amended by the accepted decision
    assert.ok(!readdirSync(join(R.d, 'tasks')).some(f => f.startsWith('T01X')))
    assert.equal(R.read('tasks/T02-x.md'), task({ id: 'T02' }))
    assert.ok(!R.read('tasks/T03-x.md').includes('is tested'))
    assert.ok(existsSync(join(R.d, 'tasks', 'T01B-new-module.md')))
    const doc = R.doc(), reg = JSON.parse(R.read('ISSUES.json'))
    assert.deepEqual(reg.issues.map(p => [p.id, p.status, p.ruling && p.ruling.author]), [['T01-1', 'open', null], ['T01-2', 'open', null], ['T01-3', 'settled', 'auto']])
    assert.deepEqual(doc.issues.map(p => [p.id, p.status, p.chosen_option]), [['T01-1', 'open', null], ['T01-2', 'open', null], ['T01-3', 'settled', 'A']])
    assert.deepEqual(doc.auto_decisions.map(d => d.title), ['Owned'], 'no automatic decision for the rejected ones, even given in auto_decisions')
    assert.equal(R.git('log', '--format=%s', `${head}..HEAD`), 'progress(T01): merged\n')
    assert.equal(R.clean(), '')
  })

  await test('run-end (0.20.0): keeps the rulings applied and the amendments discarded already noted in the run, adds those of the summary not there yet; triage still finds the ruling for superseded', () => {
    const R = repo('run-end', { tasks: [{ id: 'T01' }, { id: 'T02' }, { id: 'T05' }], progress: PROGRESS_TEMPLATE(['T01', 'T02', 'T05']).replace('| T05 | Task T05 | 1 | 1A | — | sonnet | todo |', '| T05 | Task T05 | 1 | 1A | — | sonnet | cancelled |'), handoff: '# HANDOFF — run-end\n' })
    // Run 1: an automatic decision on T01, "Choice"
    assert.equal(R.progress('run-start', { ...RUN, mode: 'auto' }).code, 0)
    assert.equal(R.progress('close', { task: 'T01', status: 'needs-human', attempts: 1, branch: 'task/T01', issues: [{ title: 'Choice', auto: 'A', options: [{ id: 'A', description: 'Auto' }, { id: 'B', description: 'User' }] }] }).code, 0)
    assert.equal(R.progress('run-end', { status: 'partial' }).code, 0)
    // Run 2: the same choice raised again, settled by the user through apply, which discards an amendment of T05 (cancelled)
    assert.equal(R.progress('run-start', RUN).code, 0)
    assert.equal(R.progress('close', { task: 'T02', status: 'blocked', attempts: 1, branch: 'task/T02', issues: [{ task: 'T01', title: 'Choice', options: [{ id: 'B', description: 'User', amendments: [{ id: 'T05', reason: 'too late' }] }] }] }).code, 0)
    assert.equal(R.progress('rule', { issue: 'T01-2', option: 'B' }).code, 0)
    const r = apply(R)
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(r.json.discarded, [{ id: 'T05', reason: 'too late' }])
    assert.equal(R.progress('run-end', { status: 'finished', rulings_applied: [], discarded_amendments: [{ task: 'T02', id: 'T03', reason: 'other' }] }).code, 0)
    let run = R.doc().runs[1]
    assert.deepEqual(run.rulings_applied, [{ task: 'T01', title: 'Choice', option: 'B' }])
    assert.deepEqual(run.discarded_amendments, [{ task: 'T01', id: 'T05', reason: 'too late' }, { task: 'T02', id: 'T03', reason: 'other' }])
    const t = R.progress('triage')
    assert.equal(t.code, 0, t.err)
    assert.deepEqual(JSON.parse(t.out).safe.map(x => [x.kind, x.task, x.text, x.reason]), [['decision', 'T01', 'Choice', 'superseded']])
    // A summary that gives rulings and amendments: those already noted kept, the new ones added, none twice
    assert.equal(R.progress('run-start', RUN).code, 0)
    assert.equal(R.progress('ruling', { task: 'T02', title: 'Old way', option: 'A', discarded_amendments: [{ id: 'T05', reason: 'gone' }] }).code, 0)
    assert.equal(R.progress('run-end', { status: 'finished', rulings_applied: [{ task: 'T02', title: 'Old way', option: 'A' }, { task: 'T02', title: 'Other', option: { id: 'C' } }], discarded_amendments: [{ task: 'T02', id: 'T05', reason: 'gone' }, { task: 'T02', id: 'T06', reason: 'six' }] }).code, 0)
    run = R.doc().runs[2]
    assert.deepEqual(run.rulings_applied, [{ task: 'T02', title: 'Old way', option: 'A' }, { task: 'T02', title: 'Other', option: 'C' }])
    assert.deepEqual(run.discarded_amendments, [{ task: 'T02', id: 'T05', reason: 'gone' }, { task: 'T02', id: 'T06', reason: 'six' }], 'an entry the summary repeats is not written twice')
  })

  await test('close and apply (0.20.0): the same option, taken by auto through close or settled by the user through apply, writes the same HANDOFF.md lines after its decision line', () => {
    const plan = () => repo('same', { tasks: [{ id: 'T01' }, { id: 'T02' }, { id: 'T03' }, { id: 'T05' }], progress: PROGRESS_TEMPLATE(['T01', 'T02', 'T03', 'T05']).replace('| T05 | Task T05 | 1 | 1A | — | sonnet | todo |', '| T05 | Task T05 | 1 | 1A | — | sonnet | cancelled |'), handoff: '# HANDOFF — same\n' })
    const option = { id: 'A', description: 'Do it all', entries: [{ type: 'debt', severity: 'minor', description: 'entry one' }, { description: 'an entry without its type' }, { type: 'review', severity: 'major', description: 'entry   two' }],
      added_tasks: [{ id: 'T01B', title: 'Shares T02', phase: 1, content: task({ id: 'T01B', title: 'Shares T02' }).replace('  - src/T01B/**\n', '  - src/T02/api.ts\n') }],
      amendments: [{ id: 'T03', reason: 'needs more', verification: ['npm run more'] }, { id: 'T05', reason: 'cancelled already' }] }
    const issue = { title: 'All', options: [option, { id: 'B', description: 'Nothing' }] }
    const close = { task: 'T01', status: 'needs-human', attempts: 1, branch: 'task/T01' }
    const X = plan(), Y = plan()
    assert.equal(X.progress('run-start', { ...RUN, mode: 'auto' }).code, 0)
    let r = X.progress('close', { ...close, issues: [{ ...issue, auto: 'A' }] })
    assert.equal(r.code, 0, r.err)
    assert.equal(Y.progress('run-start', RUN).code, 0)
    r = Y.progress('close', { ...close, issues: [issue] })
    assert.equal(r.code, 0, r.err)
    assert.equal(Y.progress('rule', { issue: 'T01-1', option: 'A' }).code, 0)
    r = apply(Y)
    assert.equal(r.code, 0, r.err)
    const [x, y] = [section(X, 'T01'), section(Y, 'T01')]
    assert.deepEqual([x[0], y[0]], ['- decision · major · All: option A taken automatically (autonomous mode) — Do it all', '- decision · major · All: option A settled by the user — Do it all'])
    assert.deepEqual(x.slice(1), y.slice(1))
    assert.deepEqual(x.slice(1), [
      '- debt · minor · entry one',
      '- review · major · entry two',
      '- amendment · major · T03: needs more',
      '- amendment · minor · T01B: depends on T02, added automatically: the two tasks of phase 1 share src/T02/api.ts, src/T02/**',
      '- blind-spot · major · amendment not applied to T05: cancelled already',
    ])
  })

  // ─── .progress.lock: a lock whose process still runs is never taken over (0.20.0, T20E) ──────────────────────────────
  const nap = ms => new Promise(res => setTimeout(res, ms))
  // Two commands, the second started once the first holds .progress.lock; each result carries its end time
  const whileLocked = async (R, first, second) => {
    const t0 = Date.now(), lock = join(R.d, '.progress.lock')
    const a = R.launch(...first).then(x => ({ ...x, at: Date.now() }))
    while (!existsSync(lock)) { assert.ok(Date.now() - t0 < 15000, 'the first command never took the lock'); await nap(5) }
    const t1 = Date.now()
    const b = R.launch(...second).then(x => ({ ...x, at: Date.now(), waited: Date.now() - t1 }))
    return Promise.all([a, b])
  }
  const withHook = async (R, body, fn) => {
    const hook = join(R.root, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, `#!/bin/sh\nsleep 1\n${body}`, { mode: 0o755 })
    try { return await fn() } finally { unlinkSync(hook) }
  }
  const ISSUES = n => Array.from({ length: n }, (_, i) => ({ title: `Q${i + 1}`, options: [{ id: 'A', description: 'a' }] }))
  const opened = (name, n) => {
    const R = repo(name, { tasks: [{ id: 'T01' }, { id: 'T02' }, { id: 'T03' }], progress: PROGRESS_TEMPLATE(['T01', 'T02', 'T03']), handoff: `# HANDOFF — ${name}\n` })
    assert.equal(R.progress('run-start', RUN).code, 0)
    assert.equal(R.progress('close', { task: 'T01', status: 'merged', attempts: 1, branch: 'task/T01', issues: ISSUES(n) }).code, 0)
    return R
  }

  await test('lock (0.20.0): a lock whose process still runs is kept whatever its age, the writer waits for that process; a lock without a readable pid older than 60 s is removed at once', async () => {
    const R = repo('lock-live', { tasks: [{ id: 'T01' }, { id: 'T02' }], progress: PROGRESS_TEMPLATE(['T01', 'T02']) })
    assert.equal(R.progress('run-start', RUN).code, 0)
    const lock = join(R.d, '.progress.lock'), old = new Date(Date.now() - 120000)
    // The sleeper is a child of this process that the event loop reaps: a zombie would still answer kill(pid, 0)
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' })
    await new Promise(res => sleeper.once('spawn', res))
    const exited = new Promise(res => sleeper.once('exit', () => res(Date.now())))
    writeFileSync(lock, `${sleeper.pid}\n`); utimesSync(lock, old, old)
    const t0 = Date.now()
    const r = await R.launch('step', { task: 'T01', step: 'worker', isolated: false })
    const end = Date.now(), gone = await exited
    assert.equal(r.code, 0, r.err)
    assert.ok(end - t0 >= 1000, `the write did not wait for the process that holds the lock: ${end - t0} ms`)
    assert.ok(end >= gone, 'the write ended before the process that holds the lock')
    assert.equal(R.doc().tasks.find(t => t.id === 'T01').step, 'worker')
    assert.deepEqual(R.leftovers(), [])
    // No readable pid, 2 minutes old: removed at once, the write goes through
    for (const content of ['', 'not a pid\n']) {
      writeFileSync(lock, content); utimesSync(lock, old, old)
      const s = Date.now(), q = R.progress('step', { task: 'T02', step: 'worker', isolated: false })
      assert.equal(q.code, 0, q.err); assert.ok(Date.now() - s < 5000, 'a stale lock without a pid was waited for')
      assert.deepEqual(R.leftovers(), [])
    }
  })

  await test('close and apply (0.20.0): a rule started during a slow commit under .progress.lock waits for it and is kept, the commit accepted or refused by the hook', async () => {
    const hold = (R, by, other) => withHook(R, by === 'accept' ? 'exit 0\n' : 'echo "hook says no" >&2\nexit 1\n', () => whileLocked(R, ...other))
    // close, commit accepted: T02 closed, the rule of T01-1 recorded
    const C = opened('lock-close', 2)
    let [c, u] = await hold(C, 'accept', [['close', { task: 'T02', status: 'merged', attempts: 1, branch: 'task/T02', entries: [{ type: 'debt', severity: 'minor', description: 'slow' }] }], ['rule', { issue: 'T01-1', option: 'A' }]])
    assert.equal(c.code, 0, c.err); assert.equal(u.code, 0, u.err)
    assert.ok(u.waited >= 500, `the rule did not wait for the lock: ${u.waited} ms`)
    assert.equal(C.doc().tasks.find(t => t.id === 'T02').status, 'merged')
    assert.deepEqual(C.doc().pending_rulings.map(x => x.issue), ['T01-1'])
    // close, commit refused: T03 not closed, files put back, the rule of T01-2 still there
    ;[c, u] = await hold(C, 'refuse', [['close', { task: 'T03', status: 'merged', attempts: 1, branch: 'task/T03', entries: [{ type: 'debt', severity: 'minor', description: 'slow' }] }], ['rule', { issue: 'T01-2', option: 'A' }]])
    assert.equal(c.code, 1, c.out); assert.equal(c.err.trim(), 'progress: close: commit refused (hook says no): nothing is written')
    assert.equal(u.code, 0, u.err)
    assert.ok(u.waited >= 500, `the rule did not wait for the lock: ${u.waited} ms`)
    assert.notEqual(C.doc().tasks.find(t => t.id === 'T03').status, 'merged', 'the refused close put progress.json back')
    assert.deepEqual(C.doc().pending_rulings.map(x => x.issue), ['T01-1', 'T01-2'])
    assert.deepEqual(C.leftovers(), [])
    // apply, commit refused: the rulings kept, a rule on another open issue made during the commit kept too
    const A = opened('lock-apply', 3)
    assert.equal(A.progress('rule', { issue: 'T01-1', option: 'A' }).code, 0)
    ;[c, u] = await hold(A, 'refuse', [['apply'], ['rule', { issue: 'T01-2', option: 'A' }]])
    assert.equal(c.code, 1, c.out); assert.equal(c.err.trim(), 'progress: apply: commit refused (hook says no): nothing is written')
    assert.equal(u.code, 0, u.err)
    assert.ok(u.waited >= 500, `the rule did not wait for the lock: ${u.waited} ms`)
    assert.deepEqual(A.doc().pending_rulings.map(x => x.issue), ['T01-1', 'T01-2'])
    assert.equal(JSON.parse(A.read('ISSUES.json')).issues.filter(p => p.status === 'open').length, 3, 'the register put back')
    assert.deepEqual(A.leftovers(), [])
  })

  console.log(`progress: ALL GREEN (${n} tests)`)
}

try { await main() } finally { for (const d of temporaries) rmSync(d, { recursive: true, force: true }) }
