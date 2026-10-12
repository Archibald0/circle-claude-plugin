// The scenario of /progress demo (plugins/orchestre/hooks/demo.mjs) played by the real scripts/progress.mjs: a toy
// repository, then two runs step by step, without agent or model. tests/mod-progress.test.mjs uses it to check that the
// demo of the mod says the same thing (notifications, log). A session opened in the repository can also watch it.
// After each step, the demo prints what the mod must show, computed by its own view model (hooks/view-model.mjs), as text:
// in Claude Code, the same banner is in colors and moves. What differs in the session comes from the drawing or from the
// loading of the mod, not from the data.
// Usage: node tests/demo-progress.mjs <folder-to-create> [--frame <ms>]      (4000 ms between two steps by default)
// In a terminal, the demo waits for Enter before each run; without a terminal (tests), it goes on.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import * as M from '../plugins/orchestre/hooks/view-model.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROGRESS = resolve(HERE, '../plugins/orchestre/scripts/progress.mjs')
const MOD = resolve(HERE, '../plugins/orchestre')
const args = process.argv.slice(2)
const D = args.find(a => !a.startsWith('--')) && resolve(args.find(a => !a.startsWith('--')))
const frameIndex = args.indexOf('--frame')
const FRAME = frameIndex >= 0 ? Number(args[frameIndex + 1]) : 4000
if (!D || !Number.isFinite(FRAME) || FRAME < 0) { console.error('usage: node tests/demo-progress.mjs <folder-to-create> [--frame <ms>]'); process.exit(2) }
if (existsSync(D)) { console.error(`${D} already exists: give a folder that does not exist`); process.exit(1) }

const git = (...a) => execFileSync('git', a, { cwd: D, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const pause = ms => new Promise(r => setTimeout(r, ms))
const entry = async text => {
  if (!process.stdin.isTTY) return
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  await new Promise(r => rl.question(text, () => r()))
  rl.close()
}

// ─── The toy repository: 5 tasks over 2 phases ──────────────────────────────────────────────────────────────────────
// The same tasks as /progress demo, models included (0.11.0)
const { TASKS, REJECTION, CHANGE } = await import('../plugins/orchestre/hooks/demo.mjs')
const frontmatter = t => `---\nid: ${t.id}\ntitle: ${t.title}\nphase: ${t.phase}\nmodel: ${t.model}\nmodel_reason: demonstration\ndepends_on: [${t.dep.join(', ')}]\nowned_files:\n  - src/${t.id}.txt\nresources: []\ntoken_estimate: 0.4M\nverification:\n  - "test -f src/${t.id}.txt"\ndefinition_of_done:\n  - "src/${t.id}.txt exists"\n---\n\nDemonstration task of the orchestre progress: nothing is done, the demo writes the progress itself.\n`

function createRepo() {
  const dir = join(D, 'plans', 'demo')
  mkdirSync(join(dir, 'tasks'), { recursive: true })
  mkdirSync(join(D, 'src'))
  git('init', '-q')
  git('checkout', '-q', '-b', 'main')
  git('config', 'user.email', 'demo@orchestre.invalid'); git('config', 'user.name', 'demo orchestre'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(D, 'README.md'), '# Demo of the orchestre progress mod\n\nToy repository created by tests/demo-progress.mjs; it can be deleted.\n')
  writeFileSync(join(D, 'src', '.gitkeep'), '')
  git('add', '.'); git('commit', '-qm', 'init')
  for (const t of TASKS) writeFileSync(join(dir, 'tasks', `${t.id}.md`), frontmatter(t))
  const line = t => `| ${t.id} | ${t.title} | ${t.phase} | — | ${t.dep.join(', ') || '—'} | ${t.model} | todo | 0 | — | 0.4M / — |`
  writeFileSync(join(dir, 'PROGRESS.md'), `# PROGRESS — demo\n\n| ID | Title | Phase | Batch | Depends on | Model | Status | Attempts | Branch | Tokens est. / actual |\n|----|----|----|----|----|----|----|----|----|----|\n${TASKS.map(line).join('\n')}\n\nStatuses: todo · added · merged · blocked · failed · needs-human · cancelled\n`)
  writeFileSync(join(dir, 'HANDOFF.md'), '# HANDOFF — demo\n')
  writeFileSync(join(dir, 'orchestre.config.json'), JSON.stringify({ integration_branch: 'plan/demo', max_parallelism: 2, default_mode: 'phase' }, null, 2) + '\n')
  git('checkout', '-q', '-b', 'plan/demo'); git('add', '.'); git('commit', '-qm', 'plan demo')
}

// ─── The steps ───────────────────────────────────────────────────────────────────────────────────────────────────────
const progress = (cmd, E) => {
  const r = spawnSync(process.execPath, [PROGRESS, cmd, 'plans/demo', '--json', JSON.stringify(E)], { cwd: D, encoding: 'utf8' })
  if (r.status !== 0) { console.error(`progress.mjs ${cmd} failed (code ${r.status}): ${r.stderr || r.stdout}`); process.exit(1) }
}
// The merge, as the integrator does it: a commit "task <id>: " on the integration branch, which plan-lint recognizes
const merge = id => {
  writeFileSync(join(D, 'src', `${id}.txt`), `${id}\n`)
  git('add', `src/${id}.txt`); git('commit', '-qm', `task ${id}: ${TASKS.find(t => t.id === id).title}`)
}
const readFile = () => M.normalize(JSON.parse(readFileSync(join(D, 'plans', 'demo', 'progress.json'), 'utf8')))
const CONFIG_RUN = { parallelism: 2, max_fixes: 2, max_auto_decisions: 3 }
const EMPTY_SUMMARY = { open_issues: [], tasks: [], not_started: [], deferred: [], added_tasks: [], rulings_applied: [], auto_decisions: [], discarded_amendments: [], waiting: [], waiting_on_prerequisites: [] }
const modelOf = id => TASKS.find(t => t.id === id).model
const worker = (id, isolated) => progress('step', { task: id, step: 'worker', isolated, model: modelOf(id) })
const SMTP = { task: 'T03', title: 'Test SMTP key', context: 'the sending tests need a test SMTP server', human: true, options: [] }

const RUN1 = [
  ['Run 1 started, phase 1', () => progress('run-start', { phase: 1, mode: 'phase', ...CONFIG_RUN })],
  ['T01 and T02 start, each in its worktree', () => { worker('T01', true); worker('T02', true) }],
  ['T01 in verification', () => progress('step', { task: 'T01', step: 'verification' })],
  ['T02 in verification, T01 in evaluation', () => { progress('step', { task: 'T02', step: 'verification' }); progress('step', { task: 'T01', step: 'evaluation' }) }],
  ['T02 rejected by the evaluation: fix on opus, which the replanner chose', () => progress('step', { task: 'T02', step: 'fix', rejection: REJECTION, model: 'opus', change: CHANGE })],
  ['T01 in merge', () => progress('step', { task: 'T01', step: 'merge' })],
  ['T01 merged, with a review before the PR', () => { merge('T01'); progress('close', { task: 'T01', status: 'merged', attempts: 1, branch: 'task/T01', reviews: ['.env.example: add DEMO_URL'] }) }],
  ['T03 starts; T02 in verification (attempt 2)', () => { worker('T03', true); progress('step', { task: 'T02', step: 'verification' }) }],
  ['T02 in merge; T03 in verification', () => { progress('step', { task: 'T02', step: 'merge' }); progress('step', { task: 'T03', step: 'verification' }) }],
  ['T02 merged at the 2nd attempt, with an auto-decision', () => { merge('T02'); progress('close', { task: 'T02', status: 'merged', attempts: 2, branch: 'task/T02', rejections: [REJECTION], auto_decisions: [{ title: 'Maximum length of the message', option: 'B', description: '2,000 characters' }] }) }],
  ['T03 needs a human: the test SMTP key is missing', () => progress('close', { task: 'T03', status: 'needs-human', attempts: 1, branch: 'task/T03', blocker: ['test SMTP key missing'], issues: [SMTP] })],
  ['End of run 1: awaiting a ruling on T03', () => progress('run-end', { ...EMPTY_SUMMARY, status: 'awaiting-ruling', phase: 1, mode: 'phase', stop_issue: SMTP, waiting: ['T03'] })],
]
const RUN2 = [
  ['Run 2 started; the first scribe applies the ruling on T03', () => { progress('run-start', { phase: 1, mode: 'auto', ...CONFIG_RUN }); progress('ruling', { task: 'T03', title: SMTP.title, option: 'A' }) }],
  ['T03 starts again', () => worker('T03', true)],
  ['T03 in verification', () => progress('step', { task: 'T03', step: 'verification' })],
  ['T03 merged: phase 1 is finished', () => { merge('T03'); progress('close', { task: 'T03', status: 'merged', attempts: 2, branch: 'task/T03' }) }],
  ['Phase 2: T04 and T05 start', () => { worker('T04', true); worker('T05', false) }],
  ['T05 merged, with two reviews before the PR', () => { merge('T05'); progress('close', { task: 'T05', status: 'merged', attempts: 1, branch: 'task/T05', reviews: ['README.md: read the installation section again', 'docs/smtp.md: check the name of the variable'] }) }],
  ['T04 in verification', () => progress('step', { task: 'T04', step: 'verification' })],
  ['T04 merged: phase 2 is finished', () => { merge('T04'); progress('close', { task: 'T04', status: 'merged', attempts: 1, branch: 'task/T04' }) }],
  ['End of run 2: finished', () => progress('run-end', { ...EMPTY_SUMMARY, status: 'finished', phase: 2, mode: 'auto', rulings_applied: [{ task: 'T03', title: SMTP.title, option: 'A' }] })],
]

let before = null
const summary = () => { const i = readFile(); console.log(`\n    Run card expected in /progress (key r):\n${M.runCard(i, Date.now(), 100, false).lines.map(l => `      ${M.plainText(l)}`).join('\n')}`) }
async function play(steps, n0) {
  for (const [i, [what, run]] of steps.entries()) {
    run()
    const after = readFile()
    const now = Date.now()
    console.log(`\n${String(n0 + i).padStart(2)}. ${what}`)
    console.log(`    banner       ${M.plainText(M.banner(after, now, 120)) || '(none)'}`)
    const s = M.suffix(after, now)
    if (s) console.log(`    spinner      …${s}`)
    for (const n of M.changes(before, after)) console.log(`    notification ${n}`)
    before = after
    await pause(FRAME)
  }
}

createRepo()
console.log(`Demo repository created: ${D}

Before opening the session:
  claude --version              2.1.287 or later: mods are on by default from that version
  claude plugin test            run in a folder without a mod, must say "no hooks module to load" (mods allowed)

Open a Claude Code session in this folder, with the mod:
  cd "${D}" && claude --plugin-dir "${MOD}"
(or, if it is already installed from the marketplace: cd "${D}" && claude)
Accept the folder's trust prompt: without it, no mod loads.
Check with /plugin that it is loaded: the line under the tabs must name orchestre.
The mod reads progress.json again every 2 s: each step below must show in the session within 2 s.
Below, the expected text; in the session, the banner is in colors (one square per task, green when it is merged, blue
when it is in progress, amber when it waits for someone) and moves during the run.
The suffix of the spinner only shows while Claude works: during a run, ask it for example "run sleep 60 in Bash".

If nothing shows: with --plugin-dir, the transcript has a line "orchestre: … refused:" or "… hook skipped:" that says
why. Otherwise, start the session again with --debug-file mod.log and look for "orchestre:" in that file
(grep "orchestre:" mod.log).`)
await entry('\nEnter to start run 1… ')
await play(RUN1, 1)
summary()
console.log(`
Run 1 stopped awaiting a ruling. In the session, try:
  /progress         the pane in cards: y (your turn), r (the run), t (the tasks), l (the log); 1 to 9, c and p prepare an
                    action in the prompt; Esc closes it
  /progress text    the same state as text
  ✕ Hide            at the end of the banner, to click: the end banner goes away until the next run`)
await entry('\nEnter to start run 2… ')
await play(RUN2, RUN1.length + 1)
summary()
console.log(`
End of the demo: 5/5 tasks merged in 2 runs. The repository ${D} can be deleted.`)
