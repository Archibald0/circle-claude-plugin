// Contrat du mod d'orchestre : ce qu'il garde dans $.state, et le modèle qu'il tire de suivi.json
// (orchestre-suivi/2, ou /1 d'avant la 0.11.0, voir hooks/modele.mjs). Dates en millisecondes depuis l'époque.

export type Statut = 'à-faire' | 'ajoutée' | 'fusionnée' | 'bloquée' | 'échec' | 'besoin-humain' | 'annulée'

export type TacheVue = {
  id: string
  titre: string
  phase: number
  statut: Statut
  essais: number
  etape: string | null
  isole: boolean
  debut: number | null
  fin: number | null
  attend: string[]
  blocage: string[]
  // Modèle prévu par le plan, null s'il n'en donne pas ; dernier modèle lancé sur la tâche, null avant le worker (0.11.0)
  modele: string | null
  modeleUtilise: string | null
}

export type RunVue = {
  numero: number
  phase: number
  mode: string
  parallelisme: number
  statut: string
  debut: number | null
  fin: number | null
  detail: string | null
  // Tâches dont ce run a appliqué un arbitrage (arbitrages_appliques)
  arbitres: string[]
}

export type PhaseVue = {
  numero: number
  total: number
  faites: number
  enCours: number
  attention: number
  essais: number
  relances: { id: string; essais: number }[]
  duree: number | null
}

export type Instantane = {
  // Le run joué par /suivi demo, en mémoire : rien ne vient d'un suivi.json
  demo: boolean
  // La légende du pas de la démo (« pas 11/21 · T03 attend un humain », puis, à la ligne, le geste à essayer) ; null hors démo
  legende: string | null
  plan: string
  dossier: string
  maj: number | null
  taches: TacheVue[]
  runs: RunVue[]
  run: RunVue | null
  relectures: { tache: string | null; phase: number | null; texte: string; quand: number | null }[]
  decisions: { tache: string; titre: string; option: string; description: string }[]
  points: { tache: string; titre: string; humain: boolean; role: string }[]
  prerequis: { id: string; type: string; bloque: string[] }[]
  majeures: Record<string, number>
  tickets: number
  lint: { ok: boolean; erreurs: number }
  journal: { quand: number | null; genre: string; tache: string | null; texte: string }[]
}

// Un morceau de ligne : texte, couleur du thème (success, error, warning, suggestion, subtle, claude, merged, planMode,
// inverseText), gras, estompé, fond (une couleur du thème : pastilles « ⚠ à toi », « fusionnée »)
// a : la carte du panneau qu'ouvre un clic sur le morceau (bandeau), k la clé de son bouton ; x : l'action d'un morceau
// du panneau. Les deux sont dessinés en bouton
export type Morceau = { t: string; c?: string; b?: boolean; d?: boolean; f?: string; a?: Section; k?: string; x?: Action }
export type Ligne = Morceau[]

// Une action du panneau : un texte préparé dans le prompt, jamais envoyé ; sa touche (1 à 9, l, p), son aide
export type Action = { touche: string | null; prompt: string; aide: string }

// Les cartes du panneau, dans l'ordre ; t, r, b et j y font défiler
export type Section = 'toi' | 'run' | 'taches' | 'journal'

// Une carte : titre et compteur sur la ligne du haut, bord de la couleur du thème (null : sans bord)
export type Carte = { id: Section; couleur: string | null; titre: Ligne; meta: Ligne; lignes: Ligne[] }

declare module 'claude-code' {
  interface PluginState {
    'orchestre': {
      // Dernière lecture valide de suivi.json, null tant qu'aucun plan n'est suivi
      instantane: Instantane | null
      // Plan choisi par /suivi plans/<nom> ; null : le suivi.json écrit en dernier (/suivi auto y revient)
      plan: string | null
      // mtime de suivi.json à la dernière lecture : on ne relit que s'il a changé
      lu: number
      // Le journal du panneau en entier (touche j) plutôt que ses dernières entrées
      journal: boolean
      // Numéro du run dont le bandeau de fin a été masqué
      masque: number | null
      // Format inconnu déjà signalé, pour ne le dire qu'une fois
      alerte: string | null
    }
  }
}
