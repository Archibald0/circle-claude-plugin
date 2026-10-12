// Tests of the mod under the engine (`claude plugin test plugins/orchestre`): a repository in memory, served by the hooks
// of the test under the plugin ($.fs, $.session.cwd), and a progress.json that changes between two reads.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { banner, width, normalize } from '../hooks/view-model.mjs'
import { FRAME_COUNT, frameInstant, demoSnapshot } from '../hooks/demo.mjs'

const ROOT = '/repo'
const PROGRESS = `${ROOT}/plans/demo/progress.json`
const T0 = Date.parse('2026-10-08T12:00:00+02:00')

const task = (id: string, phase: number, extra: object = {}) => ({ id, title: `Task ${id}`, phase, batch: null, depends_on: [], model: 'sonnet', model_used: null, status: 'todo', attempts: 0, branch: null, token_estimate: 1, actual_tokens: null, added_by: null, step: null, isolated: null, start: null, end: null, waiting: [], rejections: [], flaky: [], unverifiable: [], blocker: [], ...extra })
const run = (extra: object = {}) => ({ number: 1, run_id: null, phase: 1, mode: 'auto', parallelism: 2, max_fixes: 2, max_auto_decisions: 3, status: 'in-progress', start: '2026-10-08T11:30:00+02:00', end: null, detail: null, rulings_applied: [], discarded_amendments: [], added_tasks: [], deferred: [], not_started: [], waiting: [], waiting_on_prerequisites: [], ...extra })
const doc = (tasks: object[], extra: object = {}) => JSON.stringify({
  format: 'orchestre-progress/3', plan: 'demo', dir: 'plans/demo', integration: 'plan/demo', base: null, updated: '2026-10-08T11:59:00+02:00',
  tasks, runs: [run()],
  issues: [], auto_decisions: [], reviews: [], prerequisites: [], handoff: {}, lint: { ok: true, errors: [] }, log: [], log_omitted: 0, ...extra,
})

// What the engine does under any plugin: start the session, give its folder, register a command, draw.
// Under the banner, another mod draws too: it must stay visible.
function down(on: On, commandLine: 'ok' | 'taken' = 'ok') {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.attach', ($, e) => ({ clientId: e.clientId }))
  on('classic.SessionStart', () => ({}))
  on('session.cwd', () => ({ value: ROOT }))
  on('command.register', ($, e) => (commandLine === 'taken' ? { deny: `"/${e.name}" refused: another plugin registered it` } : { value: { command: e.name } }))
  on('ui.render', ($, e) => { const { Box, Text } = $.ui.resolve(e); return e.component === 'AbovePrompt' ? <Text>banner of another mod</Text> : <Box /> })
  on('prompt.submit', ($, e) => ({ text: e.text }))
}

// The world under the plugin: a progress.json file that is replaced, the interface calls noted
function world(on: On, commandLine: 'ok' | 'taken' = 'ok') {
  const file = { text: doc([task('T01', 1, { step: 'worker', isolated: true, start: '2026-10-08T11:31:00+02:00' }), task('T02', 1), task('T03', 2)]), mtime: 1 }
  const toasts: string[] = [], opened: string[] = [], filled: string[] = [], closed: string[] = [], statuses: (string | undefined)[] = [], sounds: string[] = []
  down(on, commandLine)
  on('ui.status', ($, e) => { statuses.push(e.text); return { value: undefined } })
  on('audio.play', ($, e) => { sounds.push('asset' in e.clip ? String(e.clip.asset) : '?'); return { value: undefined } })
  on('fs.exists', ($, e) => ({ value: e.path === `${ROOT}/plans` || e.path === PROGRESS }))
  on('fs.list', () => ({ value: [{ name: 'demo', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }, { name: 'README.md', kind: 'file' as const, size: 3, mtimeMs: 0, isLink: false }] }))
  on('fs.stat', ($, e) => (e.path === PROGRESS ? { value: { kind: 'file' as const, size: file.text.length, mtimeMs: file.mtime, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', ($, e) => (e.path === PROGRESS ? { value: file.text } : { deny: 'ENOENT' }))
  on('ui.toast', ($, e) => { toasts.push(e.text + (e.timeoutMs ? ` (${e.timeoutMs} ms)` : '')); return { value: undefined } })
  on('ui.open', ($, e) => { opened.push(e.id + (e.closeOnEscape ? ' (Esc closes)' : '')); return { value: { isPlaced: true as const } } })
  on('ui.close', ($, e) => { closed.push(e.id); return { value: undefined } })
  on('prompt.fill', ($, e) => { filled.push(`${e.mode}:${e.text}`); return { isFilled: true } })
  return { file, toasts, opened, filled, closed, statuses, sounds }
}

// The head of the banner during a run: a spinning wheel
const WHEEL = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] $/

const BAND = { component: 'AbovePrompt' as const, props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 140, scroll: { offset: 0, bodyRows: 9 }, view: {} } }
const PANE = { component: 'Pane' as const, requestId: 'orchestre', props: { title: 'Orchestre', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} } }
const CMD = (args: string, columns = 120) => ({ command: 'progress', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns } }) as never

// A minute of animation at 150 ms: a few seconds of drawings under the kit
test('banner, /progress and notifications during a run, on the terminal and the desktop', { timeoutMs: 20000 }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'orchestre', surface, ...BAND })
    expect(await ui.find({ text: WHEEL })).toBeDefined()
    expect(await ui.find({ text: /0\/3/ })).toBeDefined()
    expect(await ui.find({ text: /◐ T01 / })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'work' }))?.props.color).toBe('suggestion')
    expect((await ui.find({ type: 'Text', text: /^█+$/ }))?.props.color).toBe('suggestion')
    expect(await ui.find({ text: /⏱ 30 min/ })).toBeDefined()
    expect(await ui.find({ text: /banner of another mod/ })).toBeDefined()
    await ui.unmount()
  }
  // Without a write of progress.json, the banner already shown is redrawn at each frame: the wheel spins, the duration goes on
  const mounted = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  const frame = async () => String((await mounted.find({ text: WHEEL }))?.children?.[0] ?? '')
  const before = await frame()
  await clock.advance(150)
  expect(await frame()).not.toBe(before)
  await clock.advance(60000)
  expect(await mounted.find({ text: /⏱ 31 min/ })).toBeDefined()
  await mounted.unmount()
  const text = await $.command.run(CMD('text'))
  expect(text.text ?? '').toMatch(/^▶ demo {2}◉○/)
  // T01 merged, T02 needs a human: one notification at the next read, for what asks for someone
  w.file.text = doc([task('T01', 1, { status: 'merged', attempts: 1 }), task('T02', 1, { status: 'needs-human', blocker: ['secret'] }), task('T03', 2)])
  w.file.mtime = 2
  await clock.advance(2100)
  expect(w.toasts).toEqual(['⚑ T02 needs a human (15000 ms)'])
})

// Run 1 stopped on an issue for a human on T02, a review and an auto-decision of T01
const STOPPED = doc([task('T01', 1, { status: 'merged', attempts: 2 }), task('T02', 1, { status: 'needs-human', blocker: ['secret missing'] })], {
  runs: [run({ mode: 'phase', status: 'awaiting-ruling', end: '2026-10-08T11:50:00+02:00', waiting: ['T02'] })],
  issues: [{ run: 1, task: 'T02', title: 'Missing secret', context: '', human: true, role: 'stop', status: 'open', chosen_option: null, options: [] }],
  reviews: [{ task: 'T01', phase: 1, text: '.env.example: add MR_MAX', run: 1, at: '2026-10-08T11:40:00+02:00' }],
  auto_decisions: [{ run: 1, task: 'T01', title: 'Threshold', option: 'A', description: 'cap at 30 s' }],
})

test('/progress pane: a view in cards, its keys, its actions prepared in the prompt', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  w.file.text = STOPPED
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ ...(CMD('') as object), presentation: { isFullscreen: true, columns: 160 } } as never)
  expect(r.text ?? '').toBe('Progress of demo open in the pane.')
  expect(w.opened).toEqual(['orchestre (Esc closes)'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'orchestre', surface, ...PANE })
    // At the top, the overall state; then the keys that scroll, the focus on the first one
    expect(await ui.find({ type: 'Text', text: ' ⚠ 1 YOUR TURN ' })).toBeDefined()
    const nav = (id: string) => ui.find({ type: 'Button', key: `nav-${id}` })
    for (const [id, hotkey] of [['yourTurn', 'y'], ['run', 'r'], ['tasks', 't'], ['log', 'l']] as const) expect((await nav(id))?.props.hotkey).toBe(hotkey)
    expect((await nav('yourTurn'))?.props.label).toBe('your turn')
    expect((await nav('yourTurn'))?.props.autoFocus).toBe(true)
    expect(await ui.find({ type: 'Text', text: /· 1-9: act · Esc: close$/ })).toBeDefined()
    // The cards, in order, with their border: "Your turn" in amber, the stopped run in amber too
    expect((await ui.find({ type: 'Text', text: '⚠ Your turn' }))?.props.color).toBe('warning')
    expect(await ui.find({ type: 'Text', text: /^■ Run 1 · phase 1 · stop at each phase$/ })).toBeDefined()
    expect((await ui.find({ key: 'card-yourTurn' }))?.props.borderStyle).toBe('round')
    expect((await ui.find({ key: 'card-run' }))?.props.borderColor).toBe('warning')
    expect((await ui.find({ key: 'card-tasks' }))?.props.borderStyle).toBeUndefined()
    // One key per line of "Your turn"; what comes next after the run on c
    const action = (k: string) => ui.find({ type: 'Button', key: `action-${k}` })
    expect([(await action('1'))?.props.label, (await action('1'))?.props.hotkey]).toEqual(['T02 · Missing secret (human)', '1'])
    expect((await action('2'))?.props.label).toBe('T01 · .env.example: add MR_MAX')
    expect((await action('3'))?.props.label).toBe('T01 · Threshold: A (cap at 30 s)')
    expect([(await action('c'))?.props.label, (await action('c'))?.props.hotkey]).toEqual(['/orchestre:run plans/demo --resume', 'c'])
    expect(await action('p')).toBeUndefined()
    await ui.press({ key: 'action-1' })
    await ui.press({ key: 'action-2' })
    // l: the whole log, and the pane scrolls to it
    await ui.press({ key: 'nav-log' })
    expect((await nav('log'))?.props.label).toBe('log (less)')
    await ui.press({ key: 'nav-log' })
    expect((await nav('log'))?.props.label).toBe('log')
    await ui.unmount()
  }
  expect(w.filled).toEqual([
    'append:/orchestre:run plans/demo --resume', 'append:Review with me, before the PR (review of T01): .env.example: add MR_MAX',
    'append:/orchestre:run plans/demo --resume', 'append:Review with me, before the PR (review of T01): .env.example: add MR_MAX',
  ])
  // Scrolling to a card ($.ui.scroll) needs the layout of the engine, which the test kit does not have
  expect(w.toasts.filter(t => t === 'In the prompt: read it, complete it, then send it. Nothing was sent.').length).toBe(4)
  // Narrow: no more borders
  const narrow = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...PANE, props: { ...PANE.props, bodyColumns: 50 } })
  expect((await narrow.find({ key: 'card-run' }))?.props.borderStyle).toBeUndefined()
  await narrow.unmount()
  // Plan finished: what comes next is the PR draft, on p
  w.file.text = doc([task('T01', 1, { status: 'merged', attempts: 2 }), task('T02', 1, { status: 'merged', attempts: 1 })], {
    runs: [run({ number: 2, status: 'finished', start: '2026-10-08T11:52:00+02:00', end: '2026-10-08T11:58:00+02:00' })],
    reviews: [{ task: 'T01', phase: 1, text: '.env.example: add MR_MAX', run: 1, at: '2026-10-08T11:40:00+02:00' }],
  })
  w.file.mtime = 2
  await clock.advance(2100)
  const end = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...PANE })
  expect(await end.find({ type: 'Text', text: '⚑ To review before the PR' })).toBeDefined()
  expect(await end.find({ type: 'Button', key: 'action-c' })).toBeUndefined()
  await end.press({ key: 'action-p' })
  await end.unmount()
  expect(w.filled.at(-1) ?? '').toMatch(/^append:Plan demo: 2\/2 tasks merged, 1 run\.[\s\S]*- T01: \.env\.example: add MR_MAX/)
})

// 0.11.0: the model planned and the model used of each task
const MODELS = doc([
  task('T01', 1, { step: 'fix', isolated: true, attempts: 2, start: '2026-10-08T11:31:00+02:00', model_used: 'opus' }),
  task('T02', 1, { step: 'worker', isolated: true, start: '2026-10-08T11:32:00+02:00', model_used: 'sonnet' }),
  task('T03', 1, { model: 'haiku', model_used: null }),
], {
  log: [
    { at: '2026-10-08T11:31:00+02:00', kind: 'task', task: 'T01', text: 'T01 starts (worktree)' },
    { at: '2026-10-08T11:40:00+02:00', kind: 'rejection', task: 'T01', text: 'T01: attempt 1 rejected (evaluation): 1 gap(s)' },
    { at: '2026-10-08T11:40:00+02:00', kind: 'model', task: 'T01', text: 'T01: sonnet → opus (architecture gap)' },
    { at: '2026-10-08T11:40:00+02:00', kind: 'step', task: 'T01', text: 'T01: fix (attempt 2)' },
  ],
})

test('task lines: the model used, "planned → used" when they differ, the planned one before the worker; changes in the log (0.11.0); formats not read', async ($, on) => {
  mock.clock(on, { now: T0 })
  const w = world(on)
  w.file.text = MODELS
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ ...(CMD('') as object), presentation: { isFullscreen: true, columns: 160 } } as never)
  expect(r.text ?? '').toMatch(/open in the pane/)
  expect(w.toasts.filter(t => /format/.test(t))).toEqual([])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'orchestre', surface, ...PANE })
    // T01: planned sonnet, fixed on opus; T02: sonnet, as planned; T03: haiku planned, not started yet
    const used = await ui.find({ type: 'Text', text: /^opus$/ })
    expect([used?.props.color, used?.props.bold]).toEqual(['merged', true])
    expect((await ui.find({ type: 'Text', text: /^sonnet → $/ }))?.props.dimColor).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^sonnet$/ }))?.props.color).toBe('subtle')
    expect((await ui.find({ type: 'Text', text: /^haiku$/ }))?.props.dimColor).toBe(true)
    expect((await ui.find({ type: 'Text', text: 'fix' }))?.props.color).toBe('warning')
    // The log: the model change, with its glyph
    await ui.press({ key: 'nav-log' })
    expect((await ui.find({ type: 'Text', text: /^⇄$/ }))?.props.color).toBe('merged')
    expect(await ui.find({ type: 'Text', text: /T01: sonnet → opus \(architecture gap\)/ })).toBeDefined()
    await ui.press({ key: 'nav-log' })
    await ui.unmount()
  }
  const text = await $.command.run(CMD('text'))
  expect(text.text ?? '').toMatch(/T01 .*sonnet → opus/)
  expect(text.text ?? '').toMatch(/T03 .*haiku/)
  // A format this mod does not read: said once, nothing else
  w.file.text = MODELS.replace('"orchestre-progress/3"', '"orchestre-progress/4"')
  w.file.mtime = 2
  await $.command.run(CMD('text'))
  await $.command.run(CMD('text'))
  expect(w.toasts.filter(t => /format/.test(t))).toEqual(['plans/demo/progress.json is in the format orchestre-progress/4; this mod reads orchestre-progress/3. Update the orchestre plugin. (15000 ms)'])
  // A progress.json still in a format of 0.11: the next write of progress.mjs converts it
  w.file.text = MODELS.replace('"orchestre-progress/3"', '"orchestre-suivi/2"')
  w.file.mtime = 3
  await $.command.run(CMD('text'))
  expect(w.toasts.filter(t => /format/.test(t)).at(-1)).toBe('plans/demo/progress.json is in the format orchestre-suivi/2 of orchestre 0.11; this mod reads orchestre-progress/3: the next write of progress.mjs converts it. (15000 ms)')
})

test('nothing to follow: no banner, /progress says it; a hosted session waits for its surface, a -p reads nothing', async ($, on) => {
  mock.clock(on, { now: T0 })
  const readBack: string[] = []
  down(on)
  on('fs.exists', ($, e) => { readBack.push(e.path); return { value: false } })
  on('fs.read', ($, e) => { readBack.push(e.path); return { deny: 'ENOENT' } })
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  expect(readBack).toEqual([])
  // The desktop app hosts the session without a surface at the start, then connects to it
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(readBack.length).toBeGreaterThan(0)
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /▶/ })).toBeUndefined()
  expect(await ui.find({ text: /banner of another mod/ })).toBeDefined()
  await ui.unmount()
  const r = await $.command.run(CMD('', 80))
  expect(r.text ?? '').toBe('orchestre: nothing to follow in this repository: no plans/<name>/progress.json. It appears at the first run of orchestre 0.12 or later. /progress demo plays the demo.')
})

test('a plan of 0.11 (suivi.json, no progress.json): not read, the way to migrate it said once', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const LEGACY = `${ROOT}/plans/demo/suivi.json`
  const toasts: string[] = [], read: string[] = []
  down(on)
  on('fs.exists', ($, e) => ({ value: e.path === `${ROOT}/plans` || e.path === LEGACY }))
  on('fs.list', () => ({ value: [{ name: 'demo', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.stat', ($, e) => (e.path === LEGACY ? { value: { kind: 'file' as const, size: 10, mtimeMs: 1, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.read', ($, e) => { read.push(e.path); return { deny: 'ENOENT' } })
  on('ui.toast', ($, e) => { toasts.push(e.text + (e.timeoutMs ? ` (${e.timeoutMs} ms)` : '')); return { value: undefined } })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(6100)
  const NOTE = 'plans/demo is in the 0.11 format (suivi.json): /orchestre:ready plans/demo or /orchestre:run plans/demo migrates it.'
  expect(toasts).toEqual([`orchestre: ${NOTE} (15000 ms)`])
  expect(read).toEqual([])
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /▶|■/ })).toBeUndefined()
  await ui.unmount()
  const r = await $.command.run(CMD(''))
  expect(r.text ?? '').toMatch(new RegExp(`^orchestre: nothing to follow in this repository: no plans/<name>/progress\\.json\\. .*\\n${NOTE.replace(/[.()/:]/g, '\\$&')}$`))
  expect(toasts.length).toBe(1)
})

test('a desktop session not interactive at the start is followed', async ($, on) => {
  mock.clock(on, { now: T0 })
  const readBack: string[] = []
  down(on)
  on('fs.exists', ($, e) => { readBack.push(e.path); return { value: false } })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: false })
  expect(readBack.length).toBeGreaterThan(0)
})

// $.state kept by the test, to simulate /clear, /resume and /branch: all the values go back to their default
function state(on: On) {
  const values = new Map<string, { value: unknown; version: number }>()
  on('state.get', ($, e) => ({ value: values.get(e.key) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', ($, e) => {
    const before = values.get(e.key)?.version ?? 0
    if (e.ifVersion != null && e.ifVersion !== before) return { value: { isSet: false, version: before } } as never
    values.set(e.key, { value: e.value, version: before + 1 })
    return { value: { isSet: true, version: before + 1 } } as never
  })
  return { erase: () => values.clear(), put: (key: string, value: unknown) => { values.set(key, { value, version: 1 }) } }
}

// $.store kept by the test, with the values left by an earlier version of the mod
function store(on: On, initial: Record<string, unknown>) {
  const values = new Map(Object.entries(initial))
  on('store.get', ($, e) => ({ value: values.has(e.key) ? values.get(e.key) : null }) as never)
  on('store.set', ($, e) => { values.set(e.key, e.value); return { value: undefined } as never })
  return values
}

const FINISHED = doc([task('T01', 1, { status: 'merged', attempts: 1 }), task('T02', 1, { status: 'needs-human', blocker: ['secret'] })], {
  runs: [run({ mode: 'phase', status: 'awaiting-ruling', end: '2026-10-08T11:50:00+02:00', waiting: ['T02'] })],
  reviews: [{ task: 'T01', phase: 1, text: '.env.example: add MR_MAX', run: 1, at: '2026-10-08T11:40:00+02:00' }],
})

test('end of run: "✕ Hide" can be clicked, without a key, room of the buttons kept, still hidden after /clear', async ($, on) => {
  mock.clock(on, { now: T0 })
  const memory = state(on)
  const w = world(on)
  w.file.text = FINISHED
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  // A width where the labels fit with "⤢ Details" alone (12 cells), not with "✕ Hide" too (19)
  const inst = normalize(JSON.parse(FINISHED))!
  const toReview = (columns: number, reserve: number) => banner(inst, T0, columns, reserve)!.find(m => m.k === 'review')?.t
  let columns = width(banner(inst, T0, 1000)!) + 19
  while (columns > 40 && !(toReview(columns, 19) === '1' && toReview(columns, 12) === '1 to review')) columns--
  expect([toReview(columns, 19), toReview(columns, 12)]).toEqual(['1', '1 to review'])
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns: columns } })
  expect(await ui.find({ text: /■ / })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'goto-review' }))?.props.label).toBe('1')
  // Two buttons to click, with their icon, without a key
  const details = await ui.find({ key: 'details' }), hide = await ui.find({ key: 'hide' })
  expect([details?.props.label, details?.props.hotkey, hide?.props.label, hide?.props.hotkey]).toEqual(['⤢ Details', undefined, '✕ Hide', undefined])
  expect(w.statuses).toEqual([])
  await ui.press({ key: 'hide' })
  await ui.unmount()
  // Hidden, the banner leaves a trace in the status line: a review is left, and a task that waits
  expect(w.statuses).toEqual(['orchestre ■ 1/2 · ⚑ 1 · ⚠ 1'])
  const hidden = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await hidden.find({ text: /■ / })).toBeUndefined()
  expect(await hidden.find({ text: /banner of another mod/ })).toBeDefined()
  await hidden.unmount()
  // /clear resets $.state without running session.start again: the choice comes back with classic.SessionStart
  memory.erase()
  await $.classic.SessionStart({ source: 'clear' } as never)
  const after = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await after.find({ text: /■ / })).toBeUndefined()
  await after.unmount()
})

test('banner: "to review" and "your turn" open the pane on the "Your turn" card, "Details" at the top', async ($, on) => {
  mock.clock(on, { now: T0 })
  const w = world(on)
  w.file.text = FINISHED
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'orchestre', surface, ...BAND })
    // The glyph keeps its color; the mention is a button (the kit does not render the hover style)
    expect((await ui.find({ type: 'Text', text: '⚠ ' }))?.props.color).toBe('warning')
    expect((await ui.find({ type: 'Button', key: 'goto-your-turn' }))?.props.label).toBe('1 your turn')
    expect((await ui.find({ type: 'Button', key: 'goto-review' }))?.props.label).toBe('1 to review')
    expect((await ui.find({ type: 'Button', key: 'details' }))?.props.label).toBe('⤢ Details')
    await ui.press({ key: 'goto-your-turn' })
    await ui.press({ key: 'goto-review' })
    await ui.press({ key: 'details' })
    await ui.unmount()
  }
  expect(w.opened).toEqual(Array(6).fill('orchestre (Esc closes)'))
})

test('notifications: only what asks for someone, with a sound after /progress sound', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const saved = store(on, {})
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect((await $.command.run(CMD('sound'))).text ?? '').toBe('orchestre: sound on when something waits for you (macOS). /progress sound to turn it off.')
  expect(saved.get('sound')).toBe(true)
  // T01 merged and a review (no notification), T02 needs a human (notification and sound)
  w.file.text = doc([task('T01', 1, { status: 'merged', attempts: 1 }), task('T02', 1, { status: 'needs-human', blocker: ['secret'] }), task('T03', 2)], { reviews: [{ task: 'T01', phase: 1, text: 'x', run: 1, at: '2026-10-08T11:59:00+02:00' }] })
  w.file.mtime = 2
  await clock.advance(2100)
  expect(w.toasts).toEqual(['⚑ T02 needs a human (15000 ms)'])
  expect(w.sounds).toEqual(['sounds/waiting.wav'])
  expect((await $.command.run(CMD('sound'))).text ?? '').toBe('orchestre: sound off. /progress sound to turn it back on.')
  expect(saved.get('sound')).toBe(false)
  w.file.text = doc([task('T01', 1, { status: 'merged', attempts: 1 }), task('T02', 1, { status: 'needs-human', blocker: ['secret'] }), task('T03', 2, { status: 'blocked' })])
  w.file.mtime = 3
  await clock.advance(2100)
  expect(w.toasts.at(-1)).toBe('✗ T03 blocked (15000 ms)')
  expect(w.sounds).toEqual(['sounds/waiting.wav'])
})

test('sound setting of 0.11 ("son"): taken once, then kept under "sound"', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const saved = store(on, { son: true })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  expect([saved.get('sound'), saved.get('son')]).toEqual([true, true])
  w.file.text = doc([task('T01', 1), task('T02', 1, { status: 'needs-human', blocker: ['secret'] }), task('T03', 2)])
  w.file.mtime = 2
  await clock.advance(2100)
  expect(w.sounds).toEqual(['sounds/waiting.wav'])
  // Turned off under "sound": the old key no longer counts
  await $.command.run(CMD('sound'))
  expect([saved.get('sound'), saved.get('son')]).toEqual([false, true])
})

test('sound setting: "sound" wins over the old "son"', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  store(on, { son: true, sound: false })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  w.file.text = doc([task('T01', 1), task('T02', 1, { status: 'needs-human', blocker: ['secret'] }), task('T03', 2)])
  w.file.mtime = 2
  await clock.advance(2100)
  expect(w.toasts).toEqual(['⚑ T02 needs a human (15000 ms)'])
  expect(w.sounds).toEqual([])
})

test('back after 15 min without a prompt: a notification says what changed', { timeoutMs: 60000 }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'start the run' } as never)
  await $.command.run(CMD(''))
  expect(w.toasts).toEqual([])
  // During the absence: T01 merged, T02 starts to wait
  const q = (min: number) => new Date(T0 + min * 60000).toISOString()
  // A finished run: 16 minutes of clock without an animation to draw
  w.file.text = doc([task('T01', 1, { status: 'merged', attempts: 1, end: q(5) }), task('T02', 1, { status: 'needs-human', blocker: ['secret'], end: q(9) }), task('T03', 2)], { runs: [run({ status: 'awaiting-ruling', start: q(-30), end: q(10) })], log: [
    { at: q(5), kind: 'status', task: 'T01', text: 'T01: merged (1 attempt)' },
    { at: q(9), kind: 'status', task: 'T02', text: 'T02: needs-human (1 attempt) — secret' },
  ] })
  w.file.mtime = 2
  await clock.advance(16 * 60000)
  const before = w.toasts.length
  await $.prompt.submit({ text: 'where are we?' } as never)
  expect(w.toasts.slice(before)).toEqual(['↩ While you were away (16 min): ✓ T01 merged · ⚠ T02 waits for you (15000 ms)'])
  // A prompt shortly after, even with news in the log: nothing
  w.file.text = w.file.text.replace('"log":[', `"log":[{"at":"${q(16.5)}","kind":"status","task":"T03","text":"T03: merged (1 attempt)"},`)
  w.file.mtime = 3
  await clock.advance(60000)
  await $.prompt.submit({ text: 'thanks' } as never)
  expect(w.toasts.length).toBe(before + 1)
  // The pane opened again says at the top what changed since its last opening
  await $.command.run(CMD(''))
  const p = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...PANE })
  expect(await p.find({ type: 'Text', text: 'While you were away (17 min)' })).toBeDefined()
  expect(await p.find({ type: 'Text', text: '⚠ T02 waits for you' })).toBeDefined()
  await p.unmount()
})

test('/progress already taken by another plugin: the progress starts anyway and says it', async ($, on) => {
  mock.clock(on, { now: T0 })
  const w = world(on, 'taken')
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: WHEEL })).toBeDefined()
  await ui.unmount()
  expect(w.toasts.some(t => t.startsWith('orchestre: /progress could not be added'))).toBe(true)
})

test('after /clear: the plan chosen by /progress plans/<name> comes back, and progress.json is read again right away', async ($, on) => {
  mock.clock(on, { now: T0 })
  const memory = state(on)
  const OTHER = `${ROOT}/plans/other/progress.json`
  const files: Record<string, { text: string; mtime: number }> = {
    [PROGRESS]: { text: doc([task('T01', 1, { step: 'worker', isolated: true })]), mtime: 2 },
    [OTHER]: { text: doc([task('A01', 1, { step: 'worker', isolated: true })], { plan: 'other', dir: 'plans/other' }), mtime: 1 },
  }
  down(on)
  on('fs.exists', ($, e) => ({ value: e.path === `${ROOT}/plans` || e.path in files }))
  on('fs.list', () => ({ value: ['demo', 'other'].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }))
  on('fs.stat', ($, e) => { const f = files[e.path]; return f ? { value: { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtime, isLink: false } } : { deny: 'ENOENT' } })
  on('fs.read', ($, e) => { const f = files[e.path]; return f ? { value: f.text } : { deny: 'ENOENT' } })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const choice = await $.command.run(CMD('plans/other text'))
  expect(choice.text ?? '').toMatch(/^▶ other /)
  // What /clear leaves: $.state at its default values, the timer still there but not passed yet
  memory.erase()
  await $.classic.SessionStart({ source: 'clear' } as never)
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: WHEEL })).toBeDefined()
  expect(await ui.find({ text: /^other$/ })).toBeDefined()
  await ui.unmount()
})

test('run left "in-progress" without news: no more animation, but its age goes on every 30 s', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  w.file.text = doc([task('T01', 1, { step: 'worker', isolated: true, start: '2026-10-08T11:05:00+02:00' })], { updated: '2026-10-08T11:10:00+02:00' })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /^◌ $/ })).toBeDefined()
  expect(await ui.find({ text: /no news for 50 min/ })).toBeDefined()
  await clock.advance(61000)
  expect(await ui.find({ text: /no news for 51 min/ })).toBeDefined()
  await ui.unmount()
})

test('/progress demo, without a repository: a run played in memory, marked DEMO, its notifications, then back to the real progress', { timeoutMs: 30000 }, async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const toasts: string[] = [], readBack: string[] = [], opened: string[] = [], closed: string[] = [], filled: string[] = []
  down(on)
  on('prompt.fill', ($, e) => { filled.push(e.text); return { isFilled: true } })
  on('fs.exists', ($, e) => { readBack.push(e.path); return { value: false } })
  on('ui.toast', ($, e) => { toasts.push(e.text + (e.timeoutMs ? ` (${e.timeoutMs} ms)` : '')); return { value: undefined } })
  on('ui.open', ($, e) => { opened.push(e.title ?? ''); return { value: { isPlaced: true as const } } })
  on('ui.close', ($, e) => { closed.push(e.id); return { value: undefined } })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const r = await $.command.run(CMD('demo'))
  expect(r.text ?? '').toMatch(/^Demo started: the run of a made-up plan, showcase-site/)
  expect((await $.command.run(CMD(''))).text ?? '').toBe('Progress of showcase-site open in the pane.')
  expect(opened).toEqual(['Orchestre · showcase-site (demo)'])
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect((await ui.find({ type: 'Text', text: ' DEMO ' }))?.props.backgroundColor).toBe('merged')
  expect(await ui.find({ text: /^showcase-site$/ })).toBeDefined()
  expect(await ui.find({ text: WHEEL })).toBeDefined()
  expect((await $.command.run(CMD('text'))).text ?? '').toMatch(/^▶ {2}DEMO {2}showcase-site/)
  // During the demo, no progress.json is looked for
  const before = readBack.length
  await clock.advance(frameInstant(FRAME_COUNT - 1, 0) + 500)
  expect(readBack.length).toBe(before)
  expect(await ui.find({ text: /^✓ $/ })).toBeDefined()
  // Only what asks for someone becomes a notification
  expect(toasts).toContain('⚑ T03 needs a human (15000 ms)')
  expect(toasts).toContain('Run stopped: T03, Test SMTP key (15000 ms)')
  expect(toasts.some(t => t.startsWith('Phase 1 finished'))).toBe(false)
  expect(toasts.some(t => t.startsWith('Run 2 (phases 1 to 2): finished'))).toBe(false)
  expect(toasts.at(-1) ?? '').toBe('Demo finished. The real progress comes back in a minute; /progress auto for right now. (15000 ms)')
  await ui.unmount()
  // In the demo, an action of the pane says what it would do, without putting anything in the prompt
  const p = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...PANE })
  expect(await p.find({ type: 'Text', text: /^frame 21\/21 · End of run 2: finished$/ })).toBeDefined()
  expect(await p.find({ type: 'Text', text: /^→ key p: the PR draft in the prompt$/ })).toBeDefined()
  expect((await p.find({ type: 'Text', text: ' DEMO ' }))?.props.backgroundColor).toBe('merged')
  await p.press({ key: 'action-p' })
  await p.unmount()
  expect(filled).toEqual([])
  expect(toasts.at(-1) ?? '').toMatch(/^Demo: this key would prepare in the prompt "Plan showcase-site: 5\/5 tasks merged/)
  // A minute after the end, the real progress comes back: here, nothing to follow; the pane of the demo closes
  expect(closed).toEqual([])
  await clock.advance(60000)
  expect(readBack.length).toBeGreaterThan(before)
  expect(closed).toEqual(['orchestre'])
  const empty = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...PANE })
  expect(await empty.find({ type: 'Text', text: /^Nothing to follow in this repository: no plans\/<name>\/progress\.json\. .*\/progress demo plays the demo\.$/ })).toBeDefined()
  await empty.unmount()
  const after = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await after.find({ type: 'Text', text: ' DEMO ' })).toBeUndefined()
  await after.unmount()
})

test('/progress demo in a followed repository: the real plan waits, /progress auto goes back to it', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run(CMD('demo'))
  // progress.json changes during the demo: nothing is read, no notification of the real plan
  w.file.text = doc([task('T01', 1, { status: 'merged', attempts: 1 }), task('T02', 1, { status: 'needs-human', blocker: ['secret'] }), task('T03', 2)])
  w.file.mtime = 2
  await clock.advance(2100)
  expect(w.toasts.some(t => t.includes('T02 needs'))).toBe(false)
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /^showcase-site$/ })).toBeDefined()
  await ui.unmount()
  // The pane opened during the demo closes when going back to the real progress; a pane opened outside the demo does not
  await $.command.run(CMD(''))
  expect(w.closed).toEqual([])
  expect((await $.command.run(CMD('auto text'))).text ?? '').toMatch(/^▶ demo {2}/)
  expect(w.closed).toEqual(['orchestre'])
  await $.command.run(CMD(''))
  await $.command.run(CMD('auto'))
  expect(w.closed).toEqual(['orchestre'])
  const real = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await real.find({ type: 'Text', text: ' DEMO ' })).toBeUndefined()
  expect(await real.find({ text: /^demo$/ })).toBeDefined()
  await real.unmount()
})

test('"Hide" during the demo does not hide the real run of the same number', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  w.file.text = FINISHED
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  // A pane opened before the demo stays open when it hands back
  await $.command.run(CMD(''))
  await $.command.run(CMD('demo'))
  // Run 1 of the demo stops awaiting its ruling: it is hidden
  await clock.advance(frameInstant(11, 0) + 100)
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await ui.find({ text: /^showcase-site$/ })).toBeDefined()
  await ui.press({ key: 'hide' })
  await ui.unmount()
  await $.command.run(CMD('auto'))
  expect(w.closed).toEqual([])
  const real = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await real.find({ text: /^■ $/ })).toBeDefined()
  expect(await real.find({ text: /^demo$/ })).toBeDefined()
  await real.unmount()
})

test('reload of the mod in the middle of the demo, with nothing to follow: the frozen demo goes away', async ($, on) => {
  mock.clock(on, { now: T0 })
  const memory = state(on)
  down(on)
  on('fs.exists', () => ({ value: false }))
  // What $.state keeps from before the reload: the last frame of the demo
  memory.put('snapshot', demoSnapshot(5, T0 - 20000))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'orchestre', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: ' DEMO ' })).toBeUndefined()
  await ui.unmount()
})
