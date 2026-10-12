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
  reviews: { task: string | null; phase: number | null; text: string; at: number | null }[]
  decisions: { task: string; title: string; option: string; description: string }[]
  issues: { task: string; title: string; human: boolean; role: string }[]
  prerequisites: { id: string; type: string; blocks: string[] }[]
  majorCounts: Record<string, number>
  tickets: number
  lint: { ok: boolean; errors: number }
  log: { at: number | null; kind: string; task: string | null; text: string }[]
}

// A piece of a line: text, theme color (success, error, warning, suggestion, subtle, claude, merged, planMode, inverseText),
// bold, dim, background (a theme color: the "⚠ your turn" and "merged" badges)
// a: the pane card a click on the piece opens (banner), k the key of its button; x: the action of a piece of the pane.
// Both are drawn as buttons
export type Piece = { t: string; c?: string; b?: boolean; d?: boolean; f?: string; a?: Section; k?: string; x?: Action }
export type Line = Piece[]

// An action of the pane: a text prepared in the prompt, never sent; its key (1 to 9, c, p), its help
export type Action = { hotkey: string | null; prompt: string; help: string }

// The cards of the pane, in order; y, r, t and l scroll to them
export type Section = 'yourTurn' | 'run' | 'tasks' | 'log'

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
      // Number of the run whose end banner was hidden
      hidden: number | null
      // Unknown format or plan of 0.11 already reported, to say it only once
      alert: string | null
    }
  }
}
