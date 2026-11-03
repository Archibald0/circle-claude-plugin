// Contract of the orchestre mod: what it keeps in $.state, and the model it draws from progress.json
// (orchestre-progress/3, see hooks/view-model.mjs). Dates in milliseconds since the epoch.

export type Status = 'todo' | 'added' | 'merged' | 'blocked' | 'failed' | 'needs-human' | 'cancelled'

export type TaskView = {
  id: string
  title: string
  phase: number
  status: Status
  attempts: number
  step: string | null
  isolated: boolean
  start: number | null
  end: number | null
  waiting: string[]
  blocker: string[]
  // Model planned by the plan, null if it gives none; last model launched on the task, null before the worker (0.11.0)
  model: string | null
  modelUsed: string | null
}

export type RunView = {
  number: number
  phase: number
  mode: string
  parallelism: number
  status: string
  start: number | null
  end: number | null
  detail: string | null
  // Tasks whose ruling this run applied (rulings_applied)
  ruledTasks: string[]
}

export type PhaseView = {
  number: number
  total: number
  done: number
  inProgress: number
  attention: number
  attempts: number
  retries: { id: string; attempts: number }[]
  duration: number | null
}

export type Snapshot = {
  // The run played by /progress demo, in memory: nothing comes from a progress.json
  demo: boolean
  // The legend of the demo frame ("frame 11/21 · T03 needs a human", then, on the next line, what to try); null outside the demo
  legend: string | null
  plan: string
  dir: string
  updated: number | null
  tasks: TaskView[]
  runs: RunView[]
  run: RunView | null
  // Open only; label: the text the pilot gave it in the pane (0.16.0), null or absent: its own
  reviews: { task: string | null; phase: number | null; text: string; at: number | null; label?: string | null }[]
  decisions: { task: string; title: string; option: string; description: string; label?: string | null }[]
  // Reviews and auto-decisions the pilot closed: done (0.15.1) or moved to tickets (0.16.0); text: its key (the review's
  // text, the decision's title), shown: what the PR draft says of it. Absent in a snapshot built by hand: none
  closed?: ClosedItem[]
  // Date the pilot closed the plan ([ Close the plan ], 0.16.1); null or absent: open. A closed plan is no longer followed
  // on its own: no banner, no status line, and the pane closes at the next prompt
  planClosed?: number | null
  issues: { task: string; title: string; human: boolean; role: string }[]
  // Open only. text: the Prerequisite column; evidence: the Evidence column; how: the steps of "## <ID> · how" (0.17.0).
  // Absent in a snapshot built by hand: empty
  prerequisites: { id: string; type: string; text?: string; evidence?: string; how?: string[]; blocks: string[] }[]
  majorCounts: Record<string, number>
  tickets: number
  lint: { ok: boolean; errors: number }
  log: { at: number | null; kind: string; task: string | null; text: string }[]
}

export type ClosedItem = { kind: 'review' | 'decision'; task: string | null; text: string; shown: string; as: 'done' | 'ticket' }

// What progress.mjs needs to find a review or an auto-decision (0.16.0): its kind, task (null: the source plan) and key
// (the review's text, the decision's title); shown: the text the pane shows, original: the one it shows without a label,
// edited: shown is a label the pilot gave
export type ItemRef = { kind: 'review' | 'decision'; task: string | null; text: string; shown: string; original: string; edited: boolean }

// A piece of a line: text, theme color (success, error, warning, suggestion, subtle, claude, merged, planMode, inverseText),
// bold, dim, background (a theme color: the "⚠ your turn" and "merged" badges)
// a: the pane card a click on the piece opens (banner), k the key of its button; x: the action of a piece of the pane.
// Both are drawn as buttons. in: a text field in its place (0.16.0), t being its text for the width and the text form
export type Piece = { t: string; c?: string; b?: boolean; d?: boolean; f?: string; a?: Section; k?: string; x?: Action; in?: { key: string; value: string; submitLabel: string } }
export type Line = Piece[]

// An action of the pane: a text prepared in the prompt, never sent; its key (1 to 9 on the lines of "Your turn"), its help
export type Action = { hotkey: string | null; prompt: string; help: string; key?: string; mode?: 'select'; op?: ActionOp; ref?: ItemRef; page?: number; bracket?: true }
// key: the item of "Your turn" it comes from; mode select: a first press shows the detail card, a second one closes it
// (0.16.0; it acted in 0.14.0). op (0.16.0): what the button does instead of preparing the prompt: done, ticket (progress.mjs
// run by the mod; prompt: the /orchestre:done it falls back to), edit, save, cancel (the text field), undo, page (to page).
// bracket: a Button drawn in brackets, its piece text "[ label ]"
// closePlan, reopenPlan (0.16.1): progress.mjs close-plan, reopen-plan
export type ActionOp = 'done' | 'ticket' | 'edit' | 'save' | 'cancel' | 'undo' | 'page' | 'closePlan' | 'reopenPlan'

// The last action of the pane, with its Undo button (0.16.0)
export type LastAction = { text: string; kind: 'done' | 'ticket' | 'edit' }

// An item of "Your turn": its key stays the same while it is there, its group says where it comes from
// ack, toTicket: the /orchestre:done that marks a review or an auto-decision done, or moves it to tickets, put in the prompt
// when the mod cannot run progress.mjs itself (0.16.0); ref: what progress.mjs needs to find it
// For the detail card (0.17.0): kind, what it is ("manual action", "review"…); what, its text without the id in front;
// when, the moment to act ("Now", "Before phase 3"…), and where, the place to act from, both drawn from the state of the
// plan; blocks, the tasks a prerequisite holds back; how and check, the steps and the evidence of a prerequisite
export type YourTurnItem = { key: string; group: 'settle' | 'review' | 'decision'; task: string; g: Piece; text: string; detail?: string; prompt: string; help: string; ack?: string; toTicket?: string; ref?: ItemRef; kind: string; what: string; when: string; where: string; blocks?: string[]; how?: string[]; check?: string }

// The cards of the pane, in order; the banner opens the pane at one of them
// closed: the card of a plan closed by the pilot (0.16.1)
export type Section = 'detail' | 'yourTurn' | 'closed' | 'run' | 'tasks' | 'log'

// A card: title and counter on the top line, border in the theme color (null: no border)
export type Card = { id: Section; color: string | null; title: Line; meta: Line; lines: Line[] }

declare module 'claude-code' {
  interface PluginState {
    'orchestre': {
      // Last valid read of progress.json, null while no plan is followed
      snapshot: Snapshot | null
      // Plan chosen by /progress plans/<name>; null: the progress.json written last (/progress auto goes back to it)
      plan: string | null
      // mtime of progress.json at the last read: it is only read again if it changed
      lastRead: number
      // The whole log in the pane (key l) rather than its last entries
      fullLog: boolean
      // The key of the item of "Your turn" shown in the detail card, null: no detail card (0.14.0)
      selected: string | null
      // The page of "Your turn" shown, from 0 (0.16.0)
      page: number
      // The text of the item of the detail card is being edited (0.16.0)
      editing: boolean
      // The last action of the pane, which Undo cancels; null: none (0.16.0)
      last: LastAction | null
      // Number of the run whose end banner was hidden
      hidden: number | null
      // Unknown format or plan of 0.11 already reported, to say it only once
      alert: string | null
      // The pane already opened by itself in this session, at the first run started since it began (0.13.0)
      autoOpened: boolean
    }
  }
}
