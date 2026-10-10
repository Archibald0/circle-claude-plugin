# Format d'un plan orchestre

Un plan est un dossier `plans/<nom>/`, commité sur la branche d'intégration `plan/<nom>`, créée depuis la branche de base (`main` par défaut) :

```
plans/<nom>/
├── taches/T01-<slug>.md …   # une tâche par fichier, gabarit ci-dessous
├── SUIVI.md                 # une ligne par tâche ; seul le scribe l'écrit ensuite
├── HANDOFF.md               # l'en-tête et les décisions déjà prises
├── PREREQUIS.md             # ce que le plan attend d'un humain ou de l'environnement
├── DISCOVERY.md             # amorcé avec l'exploration
└── orchestre.config.json
```

plan-lint (`node <plugin>/scripts/plan-lint.mjs plans/<nom>`) lit le frontmatter des tâches et la colonne Statut de SUIVI.md ; avec `--integration`, une tâche dont le commit « tâche <id> : » est sur la branche d'intégration, et pas sur la branche de base, compte comme fusionnée. Il refuse : tâche sans `id`, `phase`, `verification` ou `definition_du_fini` ; `modele` hors de `haiku`, `sonnet`, `opus` et `fable` ; identifiant en double ; dépendance inconnue, cyclique ou vers une phase ultérieure ; deux tâches d'une même phase, sans dépendance entre elles ni ressource commune, qui possèdent les mêmes fichiers ; un prérequis inconnu, en double, de type ou de statut inconnu, ou une décision marquée « fait » qu'aucune entrée « décision » de HANDOFF.md ne cite. Il dit aussi, phase par phase, quelles tâches attendent un prérequis ouvert. Il avertit, sans rien bloquer, d'une tâche restante sans `modele` ou sans `raison_modele`, et d'une commande de vérification composée ; il ne juge jamais le choix d'un modèle.

## Règles de découpage

- Phase = étape de réalisation (par exemple : modèle et droits, interfaces, recette). Une phase ne démarre que quand toutes les tâches des phases précédentes sont fusionnées ou annulées.
- Des tranches verticales, chacune sous 50 % de contexte. Pas de micro-tâches : chaque tâche coûte un worker, une vérification, une évaluation, une fusion et un suivi.
- L'ordre d'exécution ne vient que de `phase`, `depend_de` et `ressources` : deux tâches d'une même phase, sans dépendance entre elles ni ressource commune, peuvent tourner en même temps, chacune dans un worktree si le parallélisme choisi au lancement le permet. Elles ne doivent alors posséder aucun fichier en commun. Déclare les ressources (base, port, service) au plus juste : deux tâches qui en partagent une tournent l'une après l'autre. `lot_parallele` et la colonne Lot de SUIVI.md sont indicatifs : rien ne les lit.
- Chaque critère de la définition du fini se démontre par le diff ou par une commande de `verification` lancée dans le contexte de la tâche. La première commande de `verification` sert aussi de contrôle après fusion : mets-y la plus représentative.
- Chaque commande de `verification` est une commande simple : ni `cd`, `export` ou affectation en tête, ni enchaînement (`&&`, `;`, `|`), ni code évalué en ligne (`node -e`, `python -c`…). Un agent isolé dans un worktree se verrait refuser une commande composée par la garde d'isolement de Claude Code ; plan-lint la signale. Une vérification qui demande plusieurs étapes devient un script du projet, possédé par la tâche ou par une tâche d'outillage.
- Aucune commande de `verification` ne lit des données de production ou personnelles réelles. Une répétition sur données réelles (dump de prod) est une étape de l'humain, écrite dans la procédure de déploiement, avec des commandes vérifiées dans le dépôt.
- Un test n'écrit pas dans une base partagée comme la base de dev : il utilise une base de test dédiée, que le script de test recrée.
- Une dernière tâche de revue globale, sur opus, en lecture seule. Elle vérifie aussi que commentaires, DECISIONS et procédures disent vrai.
- Identifiants : lettres majuscules puis chiffres, suffixe de lettres permis (T01, T02, T02B). Les tâches ajoutées en cours de run prennent un suffixe.
- Un modèle par tâche, avec sa raison : voir « Modèle de chaque tâche ».
- Estimation de tokens par tâche : 0,5 × max_tours × taille de contexte visée, plus 30 % pour la vérification et l'évaluation. Sur le pilote, le réel a été de 3 à 8 fois plus élevé : c'est un ordre de grandeur, pas un budget.

## Modèle de chaque tâche

Chaque tâche porte `modele` et `raison_modele`, une ligne qui dit pourquoi ce modèle. `/orchestre:preparer` les remplit tous les deux, avec ces critères :

- `haiku` pour le mécanique : renommage, documentation, configuration ;
- `sonnet` par défaut pour implémenter ;
- `opus` pour l'architecture, les tâches ambiguës et celles qui touchent plusieurs modules.

`fable` reste lu dans un plan existant ; `/orchestre:preparer` ne le choisit jamais.

Pendant un run, le worker tourne sur le modèle de la tâche, tel quel. Après un essai refusé, le replanificateur choisit le modèle de la correction suivante, d'après le refus, sans jamais descendre sous celui de la tâche, qui sert de plancher ; sans réponse valide de sa part, l'échelle `escalade` s'applique. Ce choix ne vaut que pour le run : le plan n'est pas modifié, et le run suivant repart du modèle du plan. Une tâche sans `modele` (plan plus ancien) tourne comme avant la 0.11.0 : worker sur sonnet, corrections selon l'échelle, sans appel au replanificateur.

## Gabarit de tâche

```markdown
---
id: T01
titre: …
phase: 1
modele: sonnet          # haiku | sonnet | opus (fable : plans existants seulement)
raison_modele: "…"      # une ligne : pourquoi ce modèle
effort: high            # low | medium | high | xhigh | max
depend_de: []
lot_parallele: 1A
fichiers_possedes:
  - chemin/**
ressources: []          # base, port… partagés : sérialise les tâches
prerequis: []           # identifiants de PREREQUIS.md : la tâche attend qu'ils soient faits
budget_contexte: 40%
estimation_tokens: 1.0M
max_tours: 60
verification:
  - "<commande réelle, trouvée pendant l'exploration>"
definition_du_fini:
  - "<critère démontrable par le diff ou par une commande de vérification>"
---

## Prompt de lancement
Tu réalises T01 sur la branche tache/T01. Lis d'abord DISCOVERY.md,
puis les fichiers listés dans Contexte utile.
Ne modifie rien hors de fichiers_possedes. Ne pose aucune question :
si tu es bloqué, termine avec le statut blocked et explique pourquoi.
Rends ton rapport au format demandé : statut, fichiers modifiés,
écarts au plan, découvertes utiles aux tâches suivantes.

## Contexte utile
## Détail de réalisation
## Hors périmètre
```

Listes du frontmatter : pour les commandes et les critères, une ligne `  - "…"` par élément, entre guillemets doubles (`\"` pour un guillemet, `\\` pour une barre oblique inverse). La forme courte `[a, b]` convient aux identifiants et aux ressources ; un élément qui y contient une virgule se met entre guillemets.

## SUIVI.md

```markdown
| ID  | Titre | Phase | Lot | Dépend de | Modèle | Statut  | Essais | Branche | Tokens est. / réels |
|-----|-------|-------|-----|-----------|--------|---------|--------|---------|---------------------|
| T01 | …     | 1     | 1A  | —         | sonnet | à-faire | 0      | —       | 1,0 M / —           |

Statuts : à-faire · ajoutée · fusionnée · bloquée · échec · besoin-humain · annulée
```

## PREREQUIS.md

Tout ce que le plan attend d'un humain ou de l'environnement avant qu'une tâche puisse partir. Chaque tâche concernée cite ces identifiants dans `prerequis` : tant que l'un d'eux est `ouvert`, elle ne part pas, et les tâches de sa phase qui en dépendent attendent avec elle ; le reste tourne. Elle repartira d'elle-même au premier run qui suit le passage du prérequis à `fait`.

```markdown
# PREREQUIS — <nom>

| ID | Type | Prérequis | Statut | Preuve |
|----|------|-----------|--------|--------|
| D5 | décision | Choisir le fournisseur de modèles de la phase 4 | ouvert | — |
| H1 | geste | Clé d'API du fournisseur dans `.env` (`PROVIDER_API_KEY`) | fait | confirmé par Fabien le 30/09 |
| E1 | environnement | Base de test démarrée (`docker compose up -d db`) | ouvert | `docker compose ps db` |

Types : décision · geste · environnement. Statuts : ouvert · fait · abandonné.
```

- Identifiants : lettres majuscules puis chiffres (D5, H1, E1), comme pour les tâches, et distincts de ceux des tâches.
- `décision` : un choix qui change une tâche. Il se tranche à la planification ; seule une décision que l'utilisateur choisit de reporter reste ouverte, et elle doit alors être citée dans `prerequis` par les tâches qu'elle touche (plan-lint refuse une décision ouverte que rien ne cite). Tranchée, elle s'écrit dans HANDOFF.md, où les agents la lisent, en entrée qui commence par son type : `décision · majeur · <ID> : …`. Elle passe alors à `fait`, avec la preuve « HANDOFF ».
- `geste` : ce qu'un agent ne fait jamais — un accès, un secret, un compte payant, des données réelles, un déploiement.
- `environnement` : un service, un outil ou des données de test dont les vérifications ont besoin.
- `Preuve` : ce qui montre que c'est fait — l'entrée de HANDOFF, un fichier, une commande sûre, ou la confirmation de l'utilisateur. Jamais le contenu d'un secret.
- Un `|` dans une cellule s'écrit `\|`. `abandonné` vaut `fait` : le prérequis n'est plus nécessaire.
- `/orchestre:pret` ajoute en fin de fichier une ligne « Vérifié par /orchestre:pret le <date> : <verdict> ».

## HANDOFF.md

```markdown
# HANDOFF — <nom>
Entrées : `écart`, `angle-mort`, `décision`, `dette`, `besoin-humain`, `ticket`, `relecture`, classées `mineur` ou `majeur`.
```

Les entrées se rangent sous un titre `## <id de tâche>`, au format `type · gravité · description`. En cours de run, l'orchestrateur ajoute aussi les types `refus`, `amendement` et `blocage`. Une `relecture` porte sur un fichier que les agents n'ont pas le droit de lire ou d'écrire (réglages du projet ou de l'organisation), ou sur une commande qu'ils n'ont pas le droit de lancer : l'humain la fait avant la PR, sans que le run s'arrête. `/orchestre:preparer` en écrit dès la planification, l'orchestrateur en cours de run.

## DISCOVERY.md

```markdown
# DISCOVERY — <nom>
## Contexte existant
## Commandes vérifiées
## Carte rapide
## Conventions constatées
## Pièges et solutions
## Recommandations de contexte (fin de run)
```

Les échecs de tests déjà présents avant le plan vont dans « Commandes vérifiées » : ils ne comptent pas contre les tâches.

## orchestre.config.json

```json
{
  "parallelisme_max": 4,
  "mode_par_defaut": "phase",
  "branche_integration": "plan/<nom>",
  "branche_base": "main",
  "evaluateur": "systematique",
  "corrections_max": 2,
  "escalade": ["sonnet", "opus"],
  "decisions_office_max": 3,
  "plafond_session_pilote": 0.65,
  "preparation": ["<installation des dépendances depuis le lockfile>", "<génération de code>"],
  "preparation_partagee": { "<ressource>": ["<préparation du service commun, par exemple la base de test>"] }
}
```

- `mode_par_defaut` : `auto` (autonome), `devia` (arrêt sur déviation) ou `phase` (arrêt par phase).
- `branche_base` : branche d'où part la branche d'intégration ; `main` par défaut, à préciser si le dépôt en utilise une autre.
- `evaluateur` est indicatif : l'évaluation est toujours systématique.
- `plafond_session_pilote` : part du contexte de la session pilote au-delà de laquelle `/orchestre:lancer` propose de reprendre dans une session neuve.
- `preparation` : commandes du projet qui remettent un dossier de travail à jour, sans toucher à un service commun (dépendances, code généré). Chaque worker les lance une fois sur sa branche, l'intégrateur après chaque fusion, avant le contrôle post-fusion. Sans elles, un worktree ou une fusion peut garder des dépendances ou du code généré périmés.
- `preparation_partagee` : pour chaque ressource déclarée par les tâches (`ressources`), les commandes qui préparent ce service commun (migration de la base de test…). Elles ne tournent que pour une tâche qui déclare la ressource, donc sous son verrou.
- Des commandes simples, comme les vérifications. Le plugin ne connaît aucune stack : il lance ce que le projet déclare.
