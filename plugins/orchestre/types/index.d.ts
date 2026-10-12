// Contrat du mod d'orchestre : ce qu'il garde dans $.state, et le modèle qu'il tire de suivi.json
// (orchestre-suivi/2, ou /1 d'avant la 0.11.0, voir hooks/modele.mjs). Dates en millisecondes depuis l'époque.

export type Status = 'à-faire' | 'ajoutée' | 'fusionnée' | 'bloquée' | 'échec' | 'besoin-humain' | 'annulée'

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
  // Modèle prévu par le plan, null s'il n'en donne pas ; dernier modèle lancé sur la tâche, null avant le worker (0.11.0)
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
  // Tâches dont ce run a appliqué un arbitrage (arbitrages_appliques)
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
  // Le run joué par /suivi demo, en mémoire : rien ne vient d'un suivi.json
  demo: boolean
  // La légende du pas de la démo (« pas 11/21 · T03 attend un humain », puis, à la ligne, le geste à essayer) ; null hors démo
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

// Un morceau de ligne : texte, couleur du thème (success, error, warning, suggestion, subtle, claude, merged, planMode,
// inverseText), gras, estompé, fond (une couleur du thème : pastilles « ⚠ à toi », « fusionnée »)
// a : la carte du panneau qu'ouvre un clic sur le morceau (bandeau), k la clé de son bouton ; x : l'action d'un morceau
// du panneau. Les deux sont dessinés en bouton
export type Piece = { t: string; c?: string; b?: boolean; d?: boolean; f?: string; a?: Section; k?: string; x?: Action }
export type Line = Piece[]

// Une action du panneau : un texte préparé dans le prompt, jamais envoyé ; sa touche (1 à 9, l, p), son aide
export type Action = { hotkey: string | null; prompt: string; help: string }

// Les cartes du panneau, dans l'ordre ; t, r, b et j y font défiler
export type Section = 'toi' | 'run' | 'taches' | 'journal'

// Une carte : titre et compteur sur la ligne du haut, bord de la couleur du thème (null : sans bord)
export type Card = { id: Section; color: string | null; title: Line; meta: Line; lines: Line[] }

declare module 'claude-code' {
  interface PluginState {
    'orchestre': {
      // Dernière lecture valide de suivi.json, null tant qu'aucun plan n'est suivi
      snapshot: Snapshot | null
      // Plan choisi par /suivi plans/<nom> ; null : le suivi.json écrit en dernier (/suivi auto y revient)
      plan: string | null
      // mtime de suivi.json à la dernière lecture : on ne relit que s'il a changé
      lastRead: number
      // Le journal du panneau en entier (touche j) plutôt que ses dernières entrées
      fullLog: boolean
      // Numéro du run dont le bandeau de fin a été masqué
      hidden: number | null
      // Format inconnu déjà signalé, pour ne le dire qu'une fois
      alert: string | null
    }
  }
}
