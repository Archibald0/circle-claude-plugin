// The mod of the orchestre plugin: follows a run in the pilot session, read-only.
// It reads plans/<name>/progress.json (orchestre-progress/3), which only scripts/progress.mjs of orchestre writes, and draws:
//   - a banner above the prompt during a run (phase, progress, in progress, to review, duration);
//   - a suffix to the spinner (task and step in progress);
//   - /progress: a pane in cards (your turn, the run, the tasks as timelines, the log), or the same state as text;
//   - a notification only for what asks for someone: task that needs a human, blocked or failed, run stopped or in
//     error; with /progress sound, a sound too;
//   - on returning after 15 min without a prompt, what changed; a status line when the end banner is hidden;
//   - the pane opened by itself at the first run started during the session (0.13.0).
// It never writes in the repository: its only writes are in $.state (display), $.store (the sound) and the prompt (the
// actions of the pane prepare a text there, never sent).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Action, Card, Snapshot, Line, Section } from '../types'
import { FRAME_COUNT, DEMO_FRAME_MS, DEMO_PLAN, demoEnd, demoSnapshot, frameAt } from './demo.mjs'
import { IMPORTANT_TOAST_MS, DETAILS_GAP, DETAILS_LABEL, DETAILS_RESERVE, HIDE_GAP, HIDE_LABEL, HIDE_RESERVE, FORMAT, FORMATS, LEGACY_FORMATS, IMAGE_MS, banner, plainText, changes, cut, since, formatOf, isImportant, statusLine, normalize, news, pane, activeRun, runInProgress, runStartedSince, suffix, stateText } from './view-model.mjs'

const PANE_ID = 'orchestre'
// The sound played when something waits for you, with /progress sound (afplay on macOS; nothing on a Linux or Windows terminal)
const SOUND = 'sounds/waiting.wav'
// At the first prompt after this silence, a notification says what changed
const AWAY_MS = 15 * 60000
const NOTHING_TO_FOLLOW = 'to follow in this repository: no plans/<name>/progress.json. It appears at the first run of orchestre 0.12 or later. /progress demo plays the demo.'
const REREAD_MS = 2000
// An interrupted run ("no news") no longer moves: its age goes on every 30 s
const SLOW_MS = 30000
const snapshot = atom({ plugin: 'orchestre', key: 'snapshot' } as const, null)
const followedPlan = atom({ plugin: 'orchestre', key: 'plan' } as const, null)
const lastRead = atom({ plugin: 'orchestre', key: 'lastRead' } as const, 0)
const fullLog = atom({ plugin: 'orchestre', key: 'fullLog' } as const, false)
const hidden = atom({ plugin: 'orchestre', key: 'hidden' } as const, null)
const alert = atom({ plugin: 'orchestre', key: 'alert' } as const, null)
const autoOpened = atom({ plugin: 'orchestre', key: 'autoOpened' } as const, false)

// The buttons after the banner ("⤢ Details", "✕ Hide") are clicked, without a key: a digit typed alone in an empty prompt
// would have pressed them instead of writing it. Their labels and their room are in view-model.mjs.

// /clear, /resume and /branch reset $.state to its defaults without running session.start again: the person's two choices,
// and what was already said once, are kept here too, to restore them (classic.SessionStart). A reload of the module keeps
// $.state.
let chosenPlan: string | null = null
let chosenHidden: number | null = null
let alerted: string | null = null
// The pane opens by itself once per session, at the first run started since the session began (0.13.0): kept here and in
// $.state, so that neither /clear nor a reload of the module opens it again
let autoOpenedHere = false
let sessionStart: number | null = null

const parent = (p: string) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'

// The plans/ folder of the repository: the one of the session's folder, otherwise of a parent folder (4 at most)
async function repoRoot($: EngineInterface): Promise<string | null> {
  let dir = await $.session.cwd()
  for (let i = 0; i < 5; i++) {
    if (await $.fs.exists(`${dir}/plans`).catch(() => false)) return dir
    const up = parent(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

// The plan to follow: the one /progress plans/<name> chose, if it has a progress.json; otherwise the progress.json written
// last, that of the run in progress since the workflow writes it at each transition. Nothing is read here: a list and stats.
async function findPlan($: EngineInterface, base: string, file = 'progress.json'): Promise<string | null> {
  const chosen = await read($, followedPlan)
  if (chosen && (await $.fs.exists(`${base}/${chosen}/${file}`).catch(() => false))) return chosen
  const entries = await $.fs.list(`${base}/plans`).catch(() => [])
  let best: { plan: string; mtime: number } | null = null
  for (const d of entries.filter(x => x.kind === 'dir').slice(0, 50)) {
    const st = await $.fs.stat(`${base}/plans/${d.name}/${file}`).catch(() => null)
    if (st && (!best || st.mtimeMs > best.mtime)) best = { plan: `plans/${d.name}`, mtime: st.mtimeMs }
  }
  return best?.plan ?? null
}

// A plan of orchestre 0.11 or earlier: a suivi.json without a progress.json. The mod does not read it: it says how to migrate
// it. The plan given, otherwise the suivi.json written last.
async function legacyNote($: EngineInterface, given: string | null = null): Promise<string | null> {
  const base = await repoRoot($)
  if (!base) return null
  const plan = given ? ((await $.fs.exists(`${base}/${given}/suivi.json`).catch(() => false)) ? given : null) : await findPlan($, base, 'suivi.json')
  return plan ? `${plan} is in the 0.11 format (suivi.json): /orchestre:ready ${plan} or /orchestre:run ${plan} offers to migrate it.` : null
}

// The plan chosen by /progress plans/<name>, when another one is shown: why, in a line (empty if it is the one shown)
async function notFollowed($: EngineInterface, given: string, inst: Snapshot): Promise<string> {
  const shown = inst.dir || `plans/${inst.plan}`
  if (shown === given) return ''
  const base = await repoRoot($)
  const readable = !!base && (await $.fs.exists(`${base}/${given}/progress.json`).catch(() => false))
  const note = readable ? null : await legacyNote($, given)
  return `orchestre: ${readable ? `${given}/progress.json cannot be read by this mod` : `${given} has no progress.json`}; ${shown} is shown instead.${note ? `\n${note}` : ''}\n`
}

async function readJson($: EngineInterface, filePath: string): Promise<unknown> {
  try {
    const t = await $.fs.read(filePath)
    return typeof t === 'string' ? JSON.parse(t) : null
  } catch {
    return null // missing, too big or being renamed: the previous display stays
  }
}

// Says once something the person must act on (unknown format, plan of 0.11), keyed so as not to repeat it
async function alertOnce($: EngineInterface, key: string, message: string): Promise<void> {
  if (alerted === key || (await read($, alert)) === key) return
  alerted = key
  await update($, alert, () => key)
  $.ui.toast(message, { timeoutMs: IMPORTANT_TOAST_MS })
}

// Reads progress.json again if it changed (or if it is another file), updates the snapshot and notifies what deserves it.
// During the demo, nothing is read. A demo left on screen after a reload of the mod goes away if there is nothing to follow.
let lastFile: string | null = null
async function refresh($: EngineInterface, force: boolean): Promise<void> {
  if (demo) return
  const base = await repoRoot($)
  if (!base) return forgetDemo($)
  const plan = await findPlan($, base)
  if (!plan) {
    // Said once: no need to look for it again every 2 s
    const note = (alerted ?? (await read($, alert)))?.startsWith('legacy:') ? null : await legacyNote($)
    if (note) await alertOnce($, `legacy:${note}`, `orchestre: ${note}`)
    return forgetDemo($)
  }
  const f = `${base}/${plan}/progress.json`
  const st = await $.fs.stat(f).catch(() => null)
  if (!st) return forgetDemo($)
  if (!force && f === lastFile && st.mtimeMs === (await read($, lastRead))) return
  const doc = await readJson($, f)
  if (doc === null) return
  lastFile = f
  await update($, lastRead, () => st.mtimeMs)
  if (!FORMATS.includes(formatOf(doc) ?? '')) {
    const format = formatOf(doc)
    await alertOnce($, `format:${format}`, format && LEGACY_FORMATS.includes(format)
      ? `orchestre: ${plan}/progress.json is in a format of orchestre 0.11 (${format}); this mod reads ${FORMAT}: the next write of progress.mjs converts it.`
      : `orchestre: ${plan}/progress.json ${format ? `is in the format ${format}` : 'gives no format'}; this mod reads ${FORMATS.join(' and ')}. Update the orchestre plugin.`)
    return
  }
  const after = normalize(doc)
  if (!after) return
  const before = await read($, snapshot)
  await update($, snapshot, () => after)
  notify($, changes(before, after))
  await updateStatus($)
  await autoOpen($, after)
}

// The first run started during the session opens the pane, without taking the keyboard from the prompt. Where Claude Code
// keeps a pane opened by a mod on its own waiting (a terminal narrower than 144 columns), a notification says /progress.
async function autoOpen($: EngineInterface, inst: Snapshot): Promise<void> {
  if (autoOpenedHere || sessionStart == null || !runStartedSince(inst, sessionStart)) return
  autoOpenedHere = true
  if (await read($, autoOpened)) return
  await update($, autoOpened, () => true)
  if (!(await openPane($, inst, null, false))) $.ui.toast(`orchestre: run ${inst.run?.number} started. /progress opens its pane.`, { timeoutMs: IMPORTANT_TOAST_MS })
}

// Only what asks for someone becomes a notification (and a sound, if /progress sound turned it on); the rest can be read
// at the end of the banner and in the log of the pane
let soundOn = false
function notify($: EngineInterface, messages: string[]): void {
  const important = messages.filter(isImportant)
  for (const message of important) $.ui.toast(message, { timeoutMs: IMPORTANT_TOAST_MS })
  if (important.length && soundOn) void $.audio.play({ asset: SOUND }).catch(() => undefined)
}

// The status line: when the end banner is hidden and something is left to do (reviews, what waits)
let lastStatus: string | undefined
async function updateStatus($: EngineInterface): Promise<void> {
  const inst = await read($, snapshot)
  const runHidden = !!inst?.run && inst.run.status !== 'in-progress' && (await read($, hidden)) === inst.run.number
  const text = inst && runHidden ? statusLine(inst, await $.clock.now()) ?? undefined : undefined
  if (text === lastStatus) return
  lastStatus = text
  try { $.ui.status(text) } catch { /* no status line on this surface */ }
}

async function forgetDemo($: EngineInterface): Promise<void> {
  if ((await read($, snapshot))?.demo) await update($, snapshot, () => null)
}

// The demo mode (/progress demo): a run played in memory, frame by frame, with its notifications; the last frame stays a
// minute, then the real progress comes back. The "Hide" of a run of the demo does not hold for the real runs.
let demo: { start: number; frameMs: number; seen: number; finished: boolean } | null = null
// The pane opened during the demo has "(demo)" in its title: it closes when the demo hands back
let demoPane = false
async function startDemo($: EngineInterface): Promise<void> {
  demo = { start: await $.clock.now(), frameMs: DEMO_FRAME_MS, seen: -1, finished: false }
  chosenHidden = null
  await update($, hidden, () => null)
  await advanceDemo($)
}
async function advanceDemo($: EngineInterface): Promise<void> {
  if (!demo) return
  const now = await $.clock.now()
  if (now >= demoEnd(demo.start, demo.frameMs)) return quitDemo($)
  const k = Math.max(0, frameAt(now, demo.start, demo.frameMs))
  const before = await read($, snapshot)
  // After /clear, the current frame comes back without a notification
  if (k === demo.seen && before?.demo) return
  const following = demo.seen >= 0 && !!before?.demo
  demo.seen = k
  const after = demoSnapshot(k, demo.start, demo.frameMs)
  await update($, snapshot, () => after)
  if (following) notify($, changes(before, after))
  await updateStatus($)
  if (k === FRAME_COUNT - 1 && !demo.finished) {
    demo.finished = true
    $.ui.toast('Demo finished. The real progress comes back in a minute; /progress auto for right now.', { timeoutMs: IMPORTANT_TOAST_MS })
  }
}
async function quitDemo($: EngineInterface): Promise<void> {
  if (!demo) return
  demo = null
  if (demoPane) {
    demoPane = false
    await $.ui.close({ id: PANE_ID }).catch(() => undefined)
  }
  chosenHidden = null
  await update($, hidden, () => null)
  await update($, snapshot, () => null)
  await update($, lastRead, () => 0)
  lastFile = null
  await refresh($, true).catch(() => undefined)
  await updateStatus($)
}

// It only follows where something is drawn: the terminal (REPL), or a session the desktop app hosts, which starts without
// a surface and gets one when the app connects (session.attach). A `claude -p` reads nothing.
let started = false
async function startFollowing($: EngineInterface): Promise<void> {
  if (started) return
  started = true
  lastPrompt = await $.clock.now()
  sessionStart = lastPrompt
  // The sound setting, kept under "sound"; taken once from "son", its key before 0.12, then written under "sound"
  let saved = await $.store.get('sound').catch(() => null)
  if (saved == null) {
    const old = await $.store.get('son').catch(() => null)
    if (old != null) { saved = old === true; await $.store.set('sound', saved).catch(() => undefined) }
  }
  soundOn = saved === true
  await refresh($, true).catch(() => undefined)
  $.clock.every(REREAD_MS, () => { void refresh($, false).catch(() => undefined) })
  $.clock.every(IMAGE_MS, () => { void animate($).catch(() => undefined) })
  // Last: a name already taken makes the registration fail, and the progress must run anyway
  try {
    await $.command.register({ name: 'progress', description: 'Progress of the orchestre plan: what waits for you, the run, the tasks, the log', argumentHint: '[plans/<name> | auto | demo | sound] [text]', immediate: true })
  } catch (err) {
    $.ui.toast(`orchestre: /progress could not be added (${err instanceof Error ? err.message : String(err)}). The banner and the notifications stay on.`, { timeoutMs: IMPORTANT_TOAST_MS })
  }
}

// The animations: during an active run, and as long as a piece of news is less than 10 s old, everything is redrawn at each
// frame (spinner, pulsing bar, stopwatches, fading news). A run without news no longer moves: every 30 s.
let lastRedraw = 0
async function animate($: EngineInterface): Promise<void> {
  if (demo) await advanceDemo($)
  const inst = await read($, snapshot)
  if (!inst) return
  const now = await $.clock.now()
  const lively = !!activeRun(inst, now) || !!news(inst, now)
  if (!lively && !(runInProgress(inst) && now - lastRedraw >= SLOW_MS)) return
  lastRedraw = now
  $.ui.invalidate('ui.render')
}

// After /clear, /resume or /branch: the person's choices come back, and progress.json is read again right away
async function restore($: EngineInterface): Promise<void> {
  if (chosenPlan) await update($, followedPlan, () => chosenPlan)
  if (chosenHidden != null) await update($, hidden, () => chosenHidden)
  // The pane already opened by itself: kept in $.state too, so that a reload after /clear does not open it again
  if (autoOpenedHere) await update($, autoOpened, () => true)
  await refresh($, true).catch(() => undefined)
  await updateStatus($)
}

// The person's return: their first prompt after AWAY_MS of silence
let lastPrompt: number | null = null
// The openings of the pane: it says at the top what changed since the previous one
let lastOpening: number | null = null
let previousVisit: number | null = null

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (e.isInteractive || e.surface !== null) await startFollowing($)
    return r
  })

  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    await startFollowing($)
    return r
  })

  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    const r = await next(e)
    if (started) await restore($)
    return r
  })

  // On returning after a silence, what changed since the last prompt. The prompt goes first, always.
  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    const before = lastPrompt
    lastPrompt = now
    if (before == null || now - before < AWAY_MS) return r
    const inst = await read($, snapshot)
    const l = inst && !inst.demo ? since(inst, before, now) : null
    if (l) $.ui.toast(plainText(l), { timeoutMs: IMPORTANT_TOAST_MS })
    return r
  }).catch(($, e, next) => next(e))

  // /progress answers right away, even during a turn: the pane, or the state as text
  on('command.run', { command: 'progress' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    if (words.includes('sound')) {
      soundOn = !soundOn
      await $.store.set('sound', soundOn).catch(() => undefined)
      return { text: soundOn ? 'orchestre: sound on when something waits for you (macOS). /progress sound to turn it off.' : 'orchestre: sound off. /progress sound to turn it back on.' }
    }
    if (words.includes('demo')) {
      await startDemo($)
      return { text: `Demo started: the run of a made-up plan, ${DEMO_PLAN} (5 tasks, 2 phases), played in a little over a minute in the banner and the notifications, marked DEMO. /progress opens the pane; /progress auto goes back to the real progress.` }
    }
    const plan = words.find(m => m.startsWith('plans/'))
    if (plan) {
      chosenPlan = plan.replace(/\/+$/, '')
      await update($, followedPlan, () => chosenPlan)
    }
    if (words.includes('auto')) {
      chosenPlan = null
      await update($, followedPlan, () => null)
    }
    if (plan || words.includes('auto')) await quitDemo($)
    await refresh($, true).catch(() => undefined)
    const inst = await read($, snapshot)
    if (!inst) {
      const note = await legacyNote($, chosenPlan)
      return { text: `orchestre: nothing ${NOTHING_TO_FOLLOW}${note ? `\n${note}` : ''}` }
    }
    const elsewhere = chosenPlan ? await notFollowed($, chosenPlan, inst) : ''
    const now = await $.clock.now()
    if (words.includes('text')) return { text: elsewhere + stateText(inst, now) }
    return { text: elsewhere + ((await openPane($, inst)) ? `Progress of ${inst.plan} opened in the pane.` : stateText(inst, now)) }
  })

  // The banner: during a run, then the end state until it is hidden or a run starts again. The band is shared: what the
  // next mods draw (next) stays below. "⤢ Details" opens the pane, "✕ Hide" hides the end banner: two buttons to click,
  // at the end of the line.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const inst = await read($, snapshot)
    if (!inst || !inst.run || e.props.hasSurvey) return next(e)
    const finished = inst.run.status !== 'in-progress'
    if (finished && (await read($, hidden)) === inst.run.number) return next(e)
    const line = banner(inst, await $.clock.now(), e.props.bodyColumns, DETAILS_RESERVE + (finished ? HIDE_RESERVE : 0), true)
    if (!line) return next(e)
    const others = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const number = inst.run.number
    return (
      <Box flexDirection="column">
        <Box key="orchestre" flexDirection="row">
          {draw($, e, line, 'banner')}
          <Text>{DETAILS_GAP}</Text>
          <Button key="details" label={DETAILS_LABEL} plain hover={{ scope: 'orchestre-details', color: 'inverseText', backgroundColor: 'claude', bold: true }} onPress={() => openFromBanner($, null)} />
          {finished && <Text>{HIDE_GAP}</Text>}
          {finished && <Button key="hide" label={HIDE_LABEL} plain dimColor onPress={async () => { chosenHidden = number; await update($, hidden, () => number); await updateStatus($) }} />}
        </Box>
        {others}
      </Box>
    )
  })

  // The spinner: the task and step in progress, and the number of tasks running
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const inst = await read($, snapshot)
    const s = inst ? suffix(inst, await $.clock.now()) : null
    return s ? next({ ...e, props: { ...e.props, suffix: s } }) : next(e)
  })

  // The pane: a view in cards. y, r, t and l scroll to a card (l also shows the whole log); ← and → stay with Claude Code.
  // The lines of "Your turn" have the keys 1 to 9, what comes next after a finished run c or p.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const inst = await read($, snapshot)
    if (!inst) return <Text dimColor wrap="wrap">{`Nothing ${NOTHING_TO_FOLLOW}`}</Text>
    const now = await $.clock.now()
    const full = await read($, fullLog)
    const p = pane(inst, now, e.props.bodyColumns, { animated: true, fullLog: full, since: previousVisit })
    const yourTurnShown = p.cards.some(c => c.id === 'yourTurn')
    const nav: [Section, string, string][] = [...(yourTurnShown ? [['yourTurn', 'your turn', 'y'] as [Section, string, string]] : []), ['run', 'run', 'r'], ['tasks', 'tasks', 't'], ['log', full ? 'log (less)' : 'log', 'l']]
    return (
      <Box flexDirection="column">
        {p.header.map((l, i) => (i < 2 ? <Box key={`header-${i}`} flexDirection="row" justifyContent="center">{draw($, e, l, `header-${i}-l`)}</Box> : draw($, e, l, `header-${i}`)))}
        <Box key="nav" flexDirection="row" marginTop={1}>
          {nav.flatMap(([id, label, hotkey], i) => [
            ...(i ? [<Text key={`nav-between-${id}`}>{'  '}</Text>] : []),
            <Button key={`nav-${id}`} label={label} hotkey={hotkey} plain {...(i === 0 ? { autoFocus: true as const } : {})} onPress={() => goTo($, id)} />,
          ])}
          <Text key="nav-help" dimColor wrap="truncate">{'   · 1-9: act · Esc: close'}</Text>
        </Box>
        {p.cards.map(c => card($, e, c, p.borders))}
      </Box>
    )
  })
}

// A card: border in its color (except below 60 columns, or without a color), title on the left, counter on the right
function card($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], c: Card, borders: boolean) {
  const { Box } = $.ui.resolve(e)
  const frame = borders && c.color ? { borderStyle: 'round', borderColor: c.color, paddingX: 1 } : {}
  return (
    <Box key={`card-${c.id}`} flexDirection="column" marginTop={1} {...frame}>
      <Box key={`card-${c.id}-top`} flexDirection="row" justifyContent="space-between">
        {draw($, e, c.title, `card-${c.id}-title`)}
        {c.meta.length ? draw($, e, c.meta, `card-${c.id}-meta`) : null}
      </Box>
      {c.lines.map((l, i) => draw($, e, l, `card-${c.id}-${i}`))}
    </Box>
  )
}

// Scrolls to a card; l also shows the whole log, or goes back to its last entries
async function goTo($: EngineInterface, id: Section): Promise<void> {
  if (id === 'log') await update($, fullLog, v => !v)
  scrollTo($, id)
}
// Right after the opening, the card may not be drawn yet: a second attempt a little later
function scrollTo($: EngineInterface, id: Section): void {
  const attempt = () => $.ui.scroll({ in: PANE_ID, to: { key: `card-${id}` }, block: 'start' })
  attempt().catch(() => { void $.clock.sleep(250).then(attempt).catch(() => undefined) })
}

// The pane, scrolled to a card if one is named. Opened during the demo, it will close with it. Opened by the mod on its own,
// it does not ask for the keyboard (focus accepts only true: left out).
async function openPane($: EngineInterface, inst: Snapshot, target: Section | null = null, focus = true): Promise<boolean> {
  const options = { id: PANE_ID, title: `Orchestre · ${inst.plan}${inst.demo ? ' (demo)' : ''}`, closeOnEscape: true as const }
  const opened = await $.ui.open(focus ? { ...options, focus: true as const } : options).catch(() => null)
  if (!opened?.isPlaced) return false
  demoPane = inst.demo
  const now = await $.clock.now()
  previousVisit = lastOpening
  lastOpening = now
  if (target) scrollTo($, target)
  return true
}

// A click in the banner: "⤢ Details", "to review", "your turn"
async function openFromBanner($: EngineInterface, target: Section | null): Promise<void> {
  const inst = await read($, snapshot)
  if (inst && !(await openPane($, inst, target))) $.ui.toast('The pane does not open here: /progress text gives the same state.')
}

// An action of the pane: its text goes into the prompt, after what is already typed there, and nothing is sent. During
// the demo, nothing goes into the prompt: a notification says what the key would do.
async function act($: EngineInterface, action: Action): Promise<void> {
  const inst = await read($, snapshot)
  if (inst?.demo) {
    $.ui.toast(`Demo: this key would prepare in the prompt "${cut(action.prompt, 90)}".`, { timeoutMs: IMPORTANT_TOAST_MS })
    return
  }
  const filled = await $.prompt.fill({ text: action.prompt, mode: 'append' })
  $.ui.toast(filled.isFilled ? 'In the prompt: read it, complete it, then send it. Nothing was sent.' : 'The prompt did not take the text.')
}

// A line of pieces: one Text per piece, in a row
function draw($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], line: Line, itemKey: string) {
  const { Box, Button, Text } = $.ui.resolve(e)
  if (!line.length) return <Text key={itemKey}> </Text>
  return (
    <Box key={itemKey} flexDirection="row">
      {line.map((m, i) => {
        const target = m.a, action = m.x
        // A mention of the banner leads to a card: a button, an amber badge on hover. An action of the pane: a button with
        // a key (1 to 9, c, p) that prepares its text in the prompt.
        if (target) return <Button key={`goto-${m.k ?? target}`} label={m.t} plain hover={{ scope: `orchestre-${m.k ?? target}`, color: 'inverseText', backgroundColor: 'warning', bold: true }} onPress={() => openFromBanner($, target)} />
        if (action) return <Button key={`action-${action.hotkey ?? `${itemKey}-${i}`}`} label={m.t} plain {...(action.hotkey ? { hotkey: action.hotkey } : {})} onPress={() => act($, action)} />
        return <Text key={`${itemKey}-${i}`} color={m.c} backgroundColor={m.f} bold={m.b} dimColor={m.d} wrap="truncate">{m.t}</Text>
      })}
    </Box>
  )
}
