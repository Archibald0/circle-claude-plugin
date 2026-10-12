# Changelog — plugin orchestre

Jusqu'à la 0.5, chaque version vient du pilote SPACE-Platform (plan `acces-par-metier`, 15 tâches, 4 phases). La 0.6.0 change l'empaquetage ; les suivantes viennent du premier projet mené avec le plugin (plan `mr-review-recall`).

## 0.12.0 — 2026-10-12: everything in English

The whole plugin moves to English, apart from its name, orchestre: commands, workflow, agents, plan and progress formats, mod, documentation. A plan of 0.11 is migrated once, with the user's agreement; a plan's free text is written in its `language`. Glossary validated by Fabien on 2026-10-11 (`0.12.0/GLOSSAIRE.md` in the working folder), contract of the progress in `0.12.0/CONTRACT.md` and `progress.v3.schema.json`. Earlier entries of this changelog stay in French, as written.

- Commands:

  | 0.11 | 0.12 |
  | :- | :- |
  | `/orchestre:installer [--equipe]` | `/orchestre:install [--team]` |
  | `/orchestre:preparer` | `/orchestre:prepare` |
  | `/orchestre:pret [--sans-repetition]` | `/orchestre:ready [--no-dry-run]` |
  | `/orchestre:lancer [--reprendre]` | `/orchestre:run [--resume]` |
  | `/orchestre:etat` | `/orchestre:status` |
  | `/suivi` (`texte`, `son`, `demo`, `auto`) | `/progress` (`text`, `sound`, `demo`, `auto`) |

- Plan format (`skills/prepare/format.md`):
  - files: `tasks/` (was `taches/`), `PROGRESS.md` (`SUIVI.md`), `PREREQUISITES.md` (`PREREQUIS.md`); HANDOFF.md and DISCOVERY.md keep their names;
  - frontmatter keys: `title`, `model`, `model_reason`, `depends_on`, `parallel_batch`, `owned_files`, `resources`, `prerequisites`, `context_budget`, `token_estimate` (written `1.0M`), `max_turns`, `definition_of_done`;
  - statuses: `todo` · `added` · `merged` · `blocked` · `failed` · `needs-human` · `cancelled`; HANDOFF types `deviation`, `blind-spot`, `decision`, `debt`, `needs-human`, `ticket`, `review` (and `rejection`, `amendment`, `blocker` during a run), rated `minor` or `major`; section titles, table headers and legends in English;
  - `orchestre.config.json`: `max_parallelism`, `default_mode` (`auto`, `deviation`, `phase`; 0.11's `devia` is refused), `integration_branch`, `base_branch`, `evaluator` (`always`), `max_fixes`, `escalation`, `max_auto_decisions`, `pilot_context_cap`, `setup`, `shared_setup`, `fable`, and the new `language`.
- `language`: the language of the plan's free text (task titles, criteria, `model_reason`, HANDOFF descriptions, Prerequisite and Evidence cells, DISCOVERY), `"en"` when absent. `/orchestre:prepare` asks for it for each plan (the language of the conversation, recommended, or English), `/orchestre:ready` shows it, `/orchestre:run` passes it to the workflow, which writes it in the prompts of the agents that write free text. The pilot talks to the user in it. Keys, values, section titles, branches and commit messages stay in English.
- Scripts:
  - plan-lint: the format above; it refuses a plan of 0.11 (`taches/`) or a French key, naming `migrate.mjs` and the English key, as well as `SUIVI.md`, `PREREQUIS.md` or `suivi.json` left next to `tasks/`, and a `default_mode` outside `auto`, `deviation`, `phase`; it warns about an `evaluator` other than `always`. Its JSON is in English (`errors`, `warnings`, `tasks`, `all`, `max_phase`, `prerequisites`, `ready`, `fable`, `language`);
  - `progress.mjs` (was `suivi.mjs`): contract `orchestre-progress/3`, file `plans/<name>/progress.json` (was `suivi.json`), commands `run-start`, `step`, `close`, `ruling`, `run-end`, `pilot`, `view`, `status`, `validate`. It reads a file of `orchestre-suivi/2` or `/1` and converts it at its first write;
  - `status.mjs` (was `etat.mjs`), and `worktrees.mjs clean [--dry-run] [--run-stopped]` (was `nettoyer [--essai] [--run-arrete]`);
  - git history is read in both languages: merge commits "task <id>: " and "tâche <id> : ", branches `task/*` and `tache/*`.
- `migrate.mjs` (new) converts a plan of 0.11 once, from the main checkout:
  - preview by default; `--write` migrates and commits the plan folder alone (`orchestre: migrate plan <name> to the 0.12 format`);
  - it refuses a plan folder with uncommitted changes, a run still "en-cours" (unless `--run-stopped`), and a linked worktree; on a failure, it restores the plan folder and says nothing is migrated; it is idempotent;
  - keys, values, file names and section titles move to English, the free text stays as written, the plan gets `"language": "fr"`; CRLF files stay CRLF; git history is not rewritten.
- Migration at the pre-flight of `/orchestre:ready` and `/orchestre:run`: a plan with `taches/`, or French files left next to `tasks/` by another clone, is shown in a preview and migrated after agreement. The tasks started in 0.11 on `tache/<id>` and not merged are reported, never taken back.
- Workflow `orchestre:run-phase` (was `orchestre:executer-phase`):
  - args in English (`parallelism`, `max_fixes`, `escalation`, `max_auto_decisions`, `rulings`, `rerun`, `agent_prefix`, `progress`, `setup`, `shared_setup`, and the new `language`); return value and statuses in English (`finished`, `partial`, `awaiting-ruling`, `rerun`, `error`; `stop_issue`, `open_issues`, `progress_failures`);
  - `lint` is required: the fallback `.claude/orchestre/plan-lint.mjs` of the manual install (v0.5) is gone;
  - branches `task/<id>` and `task/<id>-r<n>`, merge commits "task <id>: <title>", the title made safe for the shell; a plan path with a space is quoted;
  - the keywords of sensitive deviations are in English and in French, as strong in both; the progress command is recognized among the forbidden commands by its exact path; the scribe adds HANDOFF entries word for word.
- Agents renamed: `plan-reader`, `worker`, `isolated-worker`, `verifier`, `evaluator`, `integrator`, `replanner`, `scribe`, `clerk` (were `lecteur-plan`, `worker`, `worker-isole`, `verificateur`, `evaluateur`, `integrateur`, `replanificateur`, `scribe`, `greffier`).
- Settings: the rules of 0.11 (`Workflow(orchestre:executer-phase)`, `suivi.mjs`) are replaced by `/orchestre:install` or at the pre-flight of `/orchestre:run`, like those of an older version. The template allows `Workflow(orchestre:run-phase)` and `Bash(git for-each-ref *)` (taking a branch back).
- Commit messages in English: `plan(<name>): initial plan`, `ready(<name>): <verdict>`, `progress(<id>): <status> by hand`, `progress: PROGRESS.md regenerated by progress.mjs`, `chore: exclude plans/ and .claude/ from the formatter and linter`; dates written with `date +%F`.
- Mod:
  - `/progress` (`text`, `demo`, `sound`, `auto`, `plans/<name>`); pane keys y (your turn), r (run), t (tasks), l (log), 1 to 9, c (resume of a stopped run), p (PR draft); buttons "⤢ Details" and "✕ Hide";
  - it reads `progress.json` in `orchestre-progress/3` only. A plan of 0.11 (`suivi.json`) is not read: a notification says once how to migrate it, `/progress plans/<name>` too, and says which plan is shown instead. A `progress.json` still in a format of 0.11 is converted at the next write of `progress.mjs`;
  - the sound setting is kept under `sound`, taken once from `son`;
  - "waits for a human", as `/orchestre:status` says it; the demo plays a plan named `showcase-site`, with the log texts of `progress.mjs`;
  - fixed on the way: a blocked task whose blocker said "merged" was shown with a green ✓ (the log and the news now read the status from the start of the text); the lines of the tasks card could be wider than the pane; a notification said once came back after `/clear`.
- Toy repository: `tests/toy-repo.sh` (was `depot-jouet.sh`), with an English plan.
- Tests:
  - plan-lint 24 cases, `/orchestre:status` 9, `progress.mjs` 27, `worktrees.mjs` 4, `migrate.mjs` 21 (new: plans written by the real scripts of 0.11, taken from `dd14f89`);
  - 103 scenarios of the workflow (93 in 0.11, none removed);
  - settings template, and `tests/commands.test.mjs` (new, 15 tests): the contract between the skills and the workflow, the scripts, the agents and the plan format;
  - 23 cases of the mod's view model, 21 tests of the mod under the engine;
  - `npm test` runs `test:scripts`, `test:workflow`, `test:commands` and `test:mod`;
  - each of the four batches was checked by mutations (75, 68, 102, and 142 of 144: an equivalent mutant and a cosmetic gap left), then reviewed by a separate agent, whose findings were fixed.

### Incompatible with 0.11

- The scripts of 0.12 refuse a plan in the format of 0.11 until it is migrated, and orchestre 0.11 does not read a migrated plan (its plan-lint looks for `taches/`). Once a plan is migrated, it runs with 0.12.
- A task started in 0.11 and not merged starts again from the integration branch: its branch `tache/<id>` stays in git, for reference.
- The settings rules of 0.11 do not allow the workflow and the scripts of 0.12: they are replaced at the first `/orchestre:install` or `/orchestre:run`.

### Upgrading from 0.11.0

1. Between two runs: `/plugin marketplace update circle`, then `/reload-plugins`.
2. In each repository: `/orchestre:install`, which replaces the rules of 0.11.
3. For each plan in progress: `/orchestre:ready plans/<name>`, which shows the migration and does it after agreement (`/orchestre:run` offers it too). A run of 0.11 left "en-cours": confirm that it is stopped when the command asks.
4. `/suivi` becomes `/progress`.

### Not verified in real use yet

- The five commands in English in Claude Code, and the questions they ask.
- The migration of a real plan of 0.11 at the pre-flight, then its run in 0.12.
- The `language` line: do the agents write their free text in the plan's language (`fr` for a migrated plan)?
- The mod in English in the terminal and the desktop app: the cards, the keys y, r, t, l, c and p, the sound.
- Still open from 0.11: does the `model` passed at the call replace the one of the agent's frontmatter; the `model: opus` of `/orchestre:prepare`; the replanner's choice of model; the cost per task (data to collect).

## 0.11.0 — 10/10/2026 : un modèle par tâche, choisi à la préparation

Plan validé par Fabien le 10/10 (session Chat) : Opus attribue un modèle à chaque tâche quand il prépare le plan, et le workflow l'applique sans le recalculer.

- Plan : chaque tâche porte `modele` (haiku, sonnet ou opus) et `raison_modele`, une ligne, dans le frontmatter existant (`format.md`, section « Modèle de chaque tâche »). `fable` reste valide pour les plans existants ; `/orchestre:preparer` ne le choisit jamais.
- `/orchestre:preparer` tourne sur opus : `model: opus` dans son frontmatter, champ que les skills de plugin acceptent (code.claude.com/docs/en/skills). Ce réglage ne vaut que pour le tour en cours, d'où la consigne de poser les questions avec l'outil de question, qui garde le tour. Le skill remplit les deux champs, raison obligatoire, selon ces critères :
  - haiku pour le mécanique (renommage, documentation, configuration) ;
  - sonnet par défaut pour implémenter ;
  - opus pour l'architecture, les tâches ambiguës et celles qui touchent plusieurs modules.
  Une conversion garde un modèle haiku, sonnet ou opus donné par le plan source.
- Fable, au choix de l'utilisateur (demande de Fabien du 11/10 : fable coûte plus cher sans être plus efficace qu'opus à ce jour) :
  - `/orchestre:preparer` demande « Utiliser fable pour ce plan ? », « Non » recommandé. Sur « Oui », il propose les tâches mises sur opus, et seules celles que l'utilisateur coche passent sur fable. La réponse va dans `orchestre.config.json` : `"fable": true` ou `false` ;
  - plan-lint : avec `"fable": false`, une tâche restante sur fable ou une `escalade` qui le contient est une erreur, dans tout le plan. Sans le réglage (plan d'avant), c'est un avertissement. Une valeur qui n'est pas un booléen est une erreur. Son JSON rend `fable` ;
  - `/orchestre:pret` affiche le réglage. S'il manque alors qu'une tâche est sur fable, il pose la question ; sur « Non », il propose de repasser ces tâches sur opus. `/orchestre:lancer` dit ce que veulent dire ces avertissements ;
  - le replanificateur ne choisit jamais fable, ni pour une correction ni pour une tâche qu'il ajoute : fable ne vient que d'une tâche désignée par l'utilisateur, comme plancher. Le workflow ne change pas.
- plan-lint :
  - un `modele` hors de haiku, sonnet, opus et fable est une erreur, tout comme un modèle illisible (une liste) ;
  - un `modele` absent (ou vide : `modele:`, `modele: ""`) ou une `raison_modele` absente ne donnent qu'un avertissement, pour les tâches restantes (avec `--phase`, celles de la phase) : « modèle manquant » n'est plus une erreur. Un modèle refusé ne reçoit pas, en plus, l'avertissement de la raison ;
  - il ne juge jamais le choix, et son JSON rend `raison_modele`.
- Workflow :
  - Tâche avec modèle : le worker tourne sur ce modèle, tel quel. Après chaque essai refusé suivi d'une correction, un appel « choix du modèle » au replanificateur (opus, lecture seule) reçoit le refus : manques, refus par la vérification ou par l'évaluation, modèle de l'essai, essais refusés avant lui. Il rend `{ modele, raison }`. Le workflow ne descend jamais sous le modèle de la tâche, qui sert de plancher. Si la réponse est absente ou invalide, l'échelle `escalade` s'applique. Le choix vaut pour le run.
  - Tâche sans modèle : comportement de la 0.10 (sonnet, puis l'échelle), sans appel au replanificateur.
  - Le worker et chaque correction passent leur modèle dans leur commande `etape`, et le changement s'il y en a un (`{ de, vers, raison }`).
  - Chaque choix va au log du run, avec sa raison, même quand le modèle ne change pas (choix relevé au plancher).
- Suivi : contrat `orchestre-suivi/2` (`0.11.0/CONTRAT.md` et `suivi.v2.schema.json`, dans le dossier de travail ; `SCHEMA` de suivi.mjs en reste la copie, hors descriptions) :
  - `tache.modele_utilise` : le dernier modèle lancé sur la tâche, null avant le worker ;
  - `tache.modele` : null quand le plan n'en donne pas, et une tâche sans modèle entre désormais dans le suivi ;
  - genre de journal `modele` : « T03 : sonnet → opus (raison) » ;
  - colonne Modèle de SUIVI.md : « — » pour un modèle null.
  suivi.mjs relit un fichier /1 et le migre en mémoire. La première écriture le passe en /2, avec une note au journal ; `valider` dit qu'il le sera.
- `/orchestre:pret` affiche le modèle et sa raison pour chaque tâche restante, et signale les tâches sans modèle ou sans raison. `/orchestre:lancer` ne présente plus les avertissements de plan-lint comme des commandes composées à réécrire : il dit en une ligne ce que veulent dire les modèles ou raisons absents.
- Mod :
  - il lit /1 et /2 ;
  - dans la carte des tâches, une colonne Modèle montre le modèle utilisé, « prévu → utilisé » quand ils diffèrent (« — → sonnet » sans modèle prévu), et le modèle prévu, estompé, avant le worker. Elle se prend sur la frise, puis sur le titre, quand la place manque (la frise garde ses 26 cellules dès 115 colonnes environ, et ce que fait la tâche garde 30 cellules quand c'est possible), et disparaît en deçà de 60 colonnes plus sa largeur ;
  - les changements de modèle s'affichent au journal (⇄) ;
  - dans `/suivi demo` et `tests/demo-suivi.mjs`, T05 tourne sur haiku et la correction de T02 passe de sonnet à opus.
- Replanificateur : une section « Choix du modèle d'une correction », et une tâche qu'il ajoute porte son modèle et sa raison.
- Dépôt jouet (`tests/depot-jouet.sh`) : T01 passe sur haiku, avec sa raison, et la config dit `"fable": false`. Dans `/workflows`, on voit si son worker tourne bien sur haiku, et non sur le sonnet du frontmatter de l'agent.
- Tests :
  - 93 scénarios du workflow (6 nouveaux, dont un avec le vrai suivi.mjs) ;
  - 19 cas de plan-lint, 8 de `/orchestre:etat` et 22 de suivi.mjs ;
  - 20 cas du modèle du mod et 16 tests sous le moteur ;
  - 82 mutations du nouveau code (workflow, suivi.mjs, plan-lint et son réglage fable, mod, démo, hooks), toutes détectées.

### Incompatible avec la 0.10

Un suivi.mjs 0.10.x ou antérieur refuse un suivi.json /2 (« suivi.json est au format orchestre-suivi/2, ce lecteur lit orchestre-suivi/1 »), et le mod d'une 0.10 le refuse aussi. Une fois un plan migré, on ne revient pas à une 0.10. Si c'est nécessaire, supprimer `plans/<nom>/suivi.json` : il se reconstruit depuis SUIVI.md, HANDOFF.md et plan-lint, sans les champs de run.

### Mettre à jour depuis la 0.10.1

1. Entre deux runs : `/plugin marketplace update circle`, puis `/reload-plugins`. Au lancement suivant, `/orchestre:lancer` propose de remplacer les règles d'autorisation des scripts, dont le chemin contient la version.
2. Un plan écrit avant la 0.11.0 a déjà un `modele` pour chaque tâche, puisque plan-lint l'exigeait. Ses corrections passent donc au choix du replanificateur. plan-lint avertit des `raison_modele` absentes, sans rien bloquer, et `/orchestre:pret` les liste. Une tâche sur fable, sans réglage `fable`, tourne encore ; `/orchestre:pret` fait trancher.
3. Le premier run migre `suivi.json` en /2.

### Pas encore vérifié en réel

- Le `model` passé à l'appel d'un agent remplace-t-il celui du frontmatter de l'agent (`worker.md` et `worker-isole.md` : sonnet) ?
- Le `model: opus` de `/orchestre:preparer` est-il appliqué, et tient-il pendant les questions ?
- Le choix du replanificateur en run réel : pertinence des raisons, coût de l'appel opus.
- Le coût par tâche : donnée à collecter.
- Le rendu des cartes avec la colonne du modèle.

## 0.10.1 — 10/10/2026 : boutons du bandeau à cliquer, avec une icône

Demandé par Fabien après la 0.10.0 : plus de touche 1 pour « Détail » ni de touche 0 pour « Masquer », mais une icône qui dit qu'on peut cliquer.

- « 1: Détail » devient « ⤢ Détail » (pastille orange au survol), « 0: Masquer » devient « ✕ Masquer » (estompé). Les deux se cliquent et n'ont plus de touche : un 1 ou un 0 tapé en premier dans un prompt vide s'écrit de nouveau dans le prompt.
- La place gardée au bout du bandeau passe de 12 à 11 cellules pour « ⤢ Détail », et de 12 à 10 pour « ✕ Masquer ».
- Dans le panneau, rien ne change : r, b, t, j, 1 à 9, l et p restent des touches, parce qu'elles ne touchent pas au prompt.
- La démo dit « clique « ⤢ Détail » au bout du bandeau » au premier pas.
- Tests : 19 cas du modèle et 15 tests sous le moteur ; 108 des 110 mutations détectées, dont « Détail garde la touche 1 » et « Masquer garde la touche 0 » ; les 2 autres ne changent que le défilement vers une carte, que le kit de test ne voit pas.

### Mettre à jour depuis la 0.10.0

Entre deux runs : `/plugin marketplace update circle`, puis `/reload-plugins`.

## 0.10.0 — 09/10/2026 : refonte du suivi, une vue en cartes

D'après l'artefact « Refonte du suivi Orchestre » (UI inspirée de Flightdeck) et les choix de Fabien : une vue en cartes, un bandeau sur une ligne, les pistes UX-1, UX-2, UX-3, UX-5, UX-6, UX-7, UX-8 et UX-9.

- Panneau `/suivi` en cartes, à la place des quatre onglets :
  - en tête, l'état global (« ORCHESTRE · PLAN · RUN 1 ARBITRAGE · ⚠ 1 À TOI ») et la légende des couleurs ;
  - « À toi » d'abord, quand quelque chose t'attend, et seulement alors ;
  - le run : phases en frise, barre par statut avec ses comptes, durée, essais de plus et décisions d'office, temps passé dans chaque étape, et la suite quand il est fini ;
  - les tâches : une ligne par phase, et sous les phases actives une ligne par tâche avec sa frise sur le temps du run ;
  - le journal en colonnes (âge, source colorée, message), ses 6 dernières entrées, ou tout avec j.
  - Chaque carte a un bord arrondi de sa couleur (ambre pour « À toi », orange Claude pour un run en cours, vert pour un run fini, rouge pour une erreur), sauf sous 60 colonnes.
  - r, b, t et j font défiler jusqu'à une carte (`$.ui.scroll`). ← et → restent à Claude Code.
- UX-1, « À toi » devient une liste d'actions : une ligne par chose, une touche de 1 à 9, et une action selon le type, préparée dans le prompt, jamais envoyée :
  - point à trancher ou tâche qui attend un humain : `/orchestre:lancer plans/<nom> --reprendre`, qui repose la question (le pilote fait trancher avec l'outil de question) ;
  - tâche bloquée ou en échec sans point : « Explique le blocage de T03 (…) et propose une suite. » ;
  - prérequis ouvert : `/orchestre:pret plans/<nom>` ; plan-lint en erreur : une demande au pilote ;
  - relecture : « Relis avec moi, avant la PR (relecture de T01) : … » ; décision d'office : « Revois avec moi la décision prise d'office pour T02 : … ».
- UX-2, un bandeau qui ne bouge plus : « 2/5 » prend la largeur de « 5/5 », et l'étape en cours tient dans une case fixe (celle de « vérification +9 »). « replanification », rare, la dépasse.
- UX-3, pendant ton absence : au premier prompt après 15 min sans prompt, une notification dit ce qui a changé (« ↩ Depuis 16 min : ✓ T01 fusionnée · ⚠ T02 t'attend ») ; le panneau rouvert le dit en tête, depuis sa dernière ouverture (après une minute au moins).
- UX-5, le temps de chaque étape : la frise de chaque tâche est coloriée par étape, datée par le journal (« T01 démarre » pour la réalisation, « T01 : vérification » pour les suivantes), et la carte du run donne le temps total par étape. Le mod lit désormais tout le journal de suivi.json (200 entrées au plus) au lieu des 40 dernières.
- UX-6, des notifications à deux niveaux : une notification seulement pour une tâche qui attend un humain, bloquée ou en échec, un run arrêté ou en erreur. Fusions, fins de phase, runs lancés ou terminés et relectures se lisent au bout du bandeau et dans le journal. `/suivi son` ajoute un son à ces notifications (macOS, `afplay` ; rien sur un terminal Linux ou Windows), coupé par défaut, gardé d'une session à l'autre ($.store).
- UX-7, la suite en une touche : un run fini propose `/orchestre:lancer plans/<nom> --reprendre` (touche l), un plan terminé le brouillon de PR (touche p).
- UX-8, une trace quand le bandeau est masqué : après « Masquer », la ligne d'état garde « orchestre ✓ 5/5 · ⚑ 3 » tant qu'il reste une relecture ou une tâche qui attend.
- UX-9, une démo commentée : l'en-tête du panneau donne le pas (« pas 11/21 · T03 attend un humain ») et, à certains pas, le geste à essayer. Dans la démo, une touche d'action dit ce qu'elle préparerait, sans rien mettre dans le prompt.
- Tests : 19 cas du modèle et 15 tests sous le moteur ; 106 des 108 mutations du modèle, de la démo et des hooks sont détectées, les 2 autres ne changent que le défilement vers une carte. Le kit de test n'a pas la mise en page du moteur : le défilement vers une carte (`$.ui.scroll`) n'y est pas vérifié, ni le style de survol.

### Mettre à jour depuis la 0.9.1

1. Entre deux runs : `/plugin marketplace update circle`, puis `/reload-plugins`.
2. `/suivi demo`, puis `/suivi` pendant la démo, pour voir les cartes et essayer les touches.

### Pas encore vérifié en réel

- Le rendu des cartes dans le terminal du Mac (bords, largeurs, frise) et le défilement vers une carte, juste après l'ouverture du panneau compris (un second essai est fait 250 ms plus tard).
- Le son sur le Mac (`afplay`).
- Le seuil de 15 min pour « pendant ton absence » : à régler à l'usage.

## 0.9.1 — 09/10/2026 : bandeau cliquable, onglets et fin de démo

Retours de Fabien sur `/suivi demo`, vue sur le Mac en 0.9.0.

- Bandeau :
  - « ⚑ n à relire » et « ⚠ n à toi » viennent juste après l'avancement, avant les tâches en cours : ils ne bougent plus à chaque étape, le texte des tâches n'ayant jamais la même longueur.
  - Ils se cliquent : « à relire » ouvre le panneau sur l'onglet À relire, « à toi » sur le Bilan (tâches qui attendent avec leur raison, prérequis ouverts, points à trancher). Un bouton n'a pas de fond coloré au repos : le glyphe garde sa couleur, la pastille ambre vient au survol.
  - « /suivi pour le détail » devient le bouton « 1: Détail », qui ouvre le panneau sur l'onglet déjà choisi. La touche 1 marche aussi tapée seule dans un prompt vide, comme 0 pour « Masquer » : un prompt vide où l'on tape d'abord « 1 » ouvre le panneau.
- Panneau :
  - les quatre onglets restent des boutons, dans le même ordre : ↑↓ et Tab les parcourent sans sauter, le focus part de l'onglet ouvert, les autres sont estompés. L'onglet ouvert est rappelé en pastille, au début d'une ligne d'aide : « t r j b : onglet · Échap : fermer ».
  - ← et → ne changent pas d'onglet : dans un panneau, ces touches sont à Claude Code, et un mod ne peut pas les capter (seul un élément `Client` lit les touches). ← peut donc faire sortir du panneau.
  - Panneau vide : « Rien à suivre dans ce dépôt : aucun plans/<nom>/suivi.json… /suivi demo joue la démo. », au lieu de « Aucun suivi.json lu pour l'instant. ».
- Fin de démo : le panneau ouvert pendant la démo, titré « (démo) », se ferme quand le vrai suivi reprend, une minute après le dernier pas ou à `/suivi auto`. Un panneau ouvert avant la démo reste ouvert.
- Tests : 18 cas du modèle et 13 tests sous le moteur, dont un nouveau sur les clics du bandeau ; les 83 mutations du modèle, de la démo et des hooks, rejouées sur le code final, sont toutes détectées. Le kit de test ne rend pas le style de survol (`hover`).

### Mettre à jour depuis la 0.9.0

1. Entre deux runs : `/plugin marketplace update circle`, puis `/reload-plugins`.
2. `/suivi demo` pour voir le bandeau cliquable.

### Pas encore vérifié en réel

- Le clic dans le bandeau sur le terminal du Mac : d'après la doc des mods, un clic donne le focus au bandeau ; sinon, Ctrl+X puis Tab, et Entrée.
- La pastille ambre au survol des mentions.

## 0.9.0 — 09/10/2026 : le mod de suivi entre dans orchestre

Le plugin `orchestre-suivi` (0.2.0) est fusionné dans `orchestre` : une seule installation, une seule version. « Unknown command: /suivi », vu sur le Mac le 09/10 avec orchestre 0.8.0 et orchestre-suivi 0.2.0, voulait dire que le mod n'était pas chargé ; la cause (installation du second plugin, version de Claude Code ou réglage) n'est pas établie. Avec un seul plugin, installer ou mettre à jour `orchestre` apporte `/suivi`.

- Le mod est maintenant dans `plugins/orchestre/` : `hooks/` (`hooks.json`, `register.tsx`, `modele.mjs`, `demo.mjs`), `types/index.d.ts`, déclaré dans `plugin.json` par `"types"`, et `tests/suivi.test.tsx`. Son contenu est celui d'orchestre-suivi 0.2.0 (historique en annexe ci-dessous).
- Ce qui change de nom : le mod s'appelle `orchestre` (ligne des mods actifs de `/plugin`, lignes `orchestre:` du journal de débogage), son état est rangé sous `orchestre` dans `$.state`, le panneau a l'identifiant `orchestre`, et ses notifications commencent par « orchestre : ». Le format de `suivi.json` garde son nom, `orchestre-suivi/1` : c'est le contrat entre `suivi.mjs` et le mod, il ne change pas.
- La marketplace ne liste plus `orchestre-suivi`. S'il est encore installé, il faut le désinstaller : sinon les deux mods réclament `/suivi`, et deux bandeaux s'affichent pendant un run.
- Le comportement d'une version de Claude Code antérieure à 2.1.287 face au module de hooks n'a pas été essayé (prérequis du plugin : 2.1.271).
- Dépôt : `tests/orchestre-suivi.test.mjs` devient `tests/mod-suivi.test.mjs` ; `npm run validate` valide un seul plugin et lance `claude plugin test plugins/orchestre` ; `.gitignore` écarte les types et le `tsconfig.json` que le moteur écrit dans un plugin chargé par `--plugin-dir`.
- Tests : `npm test` (87 scénarios du workflow, 17 cas de plan-lint, 7 de `/orchestre:etat`, 19 de `suivi.mjs`, 4 de `worktrees.mjs`, le modèle de réglages, 18 cas du modèle du mod) et `npm run validate` (12 tests du mod sous le moteur) passent ; les 65 mutations du modèle, de la démo et des hooks, rejouées sur le code déplacé, sont toutes détectées. Vérifié avec Claude Code 2.1.295.

### Mettre à jour depuis la 0.8.1

1. Entre deux runs : `/plugin marketplace update circle`.
2. Si `orchestre-suivi` est installé : `/plugin uninstall orchestre-suivi@circle`.
3. `/reload-plugins`, ou une session neuve.
4. Vérifier : `claude plugin list` montre `orchestre@circle` en 0.9.0, `/plugin` nomme `orchestre` sur la ligne des mods actifs, et `/suivi demo` joue la démo.

### Pas encore vérifié en réel

- Le chargement du mod sur le Mac, et son dessin réel (bandeau, spinner, panneau, couleurs, animation) : `/suivi demo` sert à le vérifier.

## 0.8.1 — 08/10/2026 : sortie de plan-lint coupée à 64 Ko

Trouvé en session test sur MonitIA (124 lignes dans SUIVI.md) : `/orchestre:etat` et `suivi.mjs etat` affichaient « plan-lint n'a pas rendu d'état ({) ». Le tableau de SUIVI.md avait aussi perdu toutes ses estimations (« — / voir /workflows »), et 12 lignes de tâches étaient restées sous la légende.

- plan-lint : la sortie n'est plus coupée. `process.exit()`, juste après l'écriture du JSON, coupait la sortie à 65 536 octets dans un tube. C'est le cas d'un gros plan lu sans `--phase` (etat.mjs, suivi.mjs, `/orchestre:pret`). Le code de sortie passe maintenant par `process.exitCode`, avec la même valeur. etat.mjs fait de même, et les deux scripts qui lisent plan-lint acceptent une sortie jusqu'à 64 Mo.
- `suivi.mjs`, quand plan-lint ne rend rien :
  - sans suivi.json, plus de reconstruction : l'écriture est refusée (code 1) et rien n'est écrit. C'est ce qui avait fabriqué un suivi sans estimations ni statuts relus dans git ;
  - avec suivi.json, les champs de plan, les statuts de git et les prérequis sont gardés tels quels, et le journal le note une fois.
- `suivi.mjs` reprend dans le tableau les lignes de tâches écrites sous la légende par un scribe d'avant la 0.8.0, avec leurs cellules (titre, essais, branche, tokens réels). plan-lint les lisait déjà ; la vue les laissait hors du tableau.
  - Seule compte une ligne qui a au moins les cellules de l'en-tête et un statut connu. Une ligne d'un autre tableau (notes, décisions) reste du texte, et n'empêche pas la reconstruction de suivi.json.
  - Une ligne qui reprend une tâche déjà lue la remplace, à sa place, comme plan-lint qui garde la dernière.
- plan-lint : une ligne d'un autre tableau sous la légende, avec moins de cellules que l'en-tête ou sans statut, n'est plus lue comme une tâche. Un tableau de notes qui citait une tâche fusionnée la faisait repasser à « à-faire ». Ce défaut existait depuis la 0.6.3.
- plan-lint `--json` : le JSON tient sur une ligne et, avec `--phase`, ne rend que les avertissements des tâches de la phase. C'est ce que lit le lecteur-plan par l'outil Bash, qui ne montre qu'un aperçu d'une sortie trop longue. Sur un plan d'essai de 160 tâches à vérifications composées, `--phase 3` passe de 68 931 à 22 401 octets, et le plan entier de 129 915 à 102 334. Le seuil exact de l'outil Bash est une donnée à collecter.
- Relu par un agent séparé, sur scénarios : les cas qu'il a trouvés (tableau de notes, doublon sous la légende) sont dans les tests.
- Tests : 17 cas de plan-lint, dont un JSON de plus de 64 Ko lu par un tube ; 19 cas de suivi.mjs, dont plan-lint coupé et lignes sous la légende ; 12 mutations du correctif, toutes détectées.

### Mettre à jour depuis la 0.8.0

1. Entre deux runs : `/plugin marketplace update circle`, puis `/reload-plugins` ou une session neuve.
2. Au lancement suivant, le pré-vol de `/orchestre:lancer` régénère SUIVI.md par `suivi.mjs vue`. Les estimations reviennent du frontmatter, et les lignes restées sous la légende entrent dans le tableau. Ce SUIVI.md est à commiter une fois, après accord.

## 0.8.0 — 08/10/2026 : suivi dynamique et environnement des worktrees

Elle part de la 0.6.3 : il n'y a ni 0.6.4 ni 0.7.0. Deux volets : le suivi dynamique (`suivi.json`), et les correctifs tirés d'un projet réel mené en 0.6.3 (MonitIA), qui ralentissaient le plus le flux : environnement des dossiers de travail périmé, branches tenues par les worktrees des essais précédents, commandes refusées par la garde d'isolement des worktrees de Claude Code, scratchpad commun. Contrat `orchestre-suivi/1`, choix tranchés et retours du projet : dossier `0.8.0/` du dossier de travail (CONTRAT.md, ECARTS.md, RETOURS-monitia.md).

### Suivi dynamique

- `scripts/suivi.mjs` : seul écrivain de `plans/<nom>/suivi.json` (hors git, par `.git/info/exclude`) et de la vue SUIVI.md, dont il ne régénère que le tableau. Node 18, aucune dépendance. Commandes `debut-run`, `etape`, `cloture`, `arbitrage`, `fin-run`, `pilote`, `vue`, `etat`, `valider` ; l'objet JSON sur l'entrée standard ou dans `--json '<objet>'`. Verrou, fichier temporaire renommé, validation de chaque écriture (refus : code 1, fichiers intacts). Un `suivi.json` perdu se reconstruit depuis SUIVI.md, HANDOFF.md et plan-lint.
- Branché dans le workflow, par `args.suivi` (le chemin du script, passé par `/orchestre:lancer`). Le workflow ne lance rien : il écrit dans la consigne de chaque agent la commande à lancer, en une ligne (objet JSON entre guillemets simples, apostrophe, accent grave et dollar en échappements `\u`), et lit son résultat dans `suivi_ok`. Les textes passés au suivi tiennent sur une ligne et sont coupés à 240 caractères (extraits de commande) ; HANDOFF.md garde le texte entier.
  - Ouverture du run (`debut-run`) : le premier agent du run, soit le premier scribe d'arbitrage, soit le lecteur-plan. Un arbitrage est ainsi noté dans le run qui l'applique. Ouverture refusée : le run rend `erreur` avant toute tâche.
  - Étapes : première commande du worker (avec `isole`), du vérificateur, de l'évaluateur, de la correction (avec son refus), de l'intégrateur et du scribe. Une étape ratée ne fausse que l'affichage : le run continue, et elle va dans `suivi_echecs`.
  - Clôture et arbitrage : le scribe lance `cloture` ou `arbitrage` juste avant son commit ; le script régénère SUIVI.md, que le scribe n'édite plus. La clôture porte statut, essais, branche, refus, tests instables, critères non vérifiables, blocage, relectures, points (sans leurs actions), décisions d'office, tâches ajoutées, amendements, et la fin de la replanification. Une clôture ou un arbitrage non écrit arrête le run pour un humain, comme un scribe en échec ; leur `suivi_ok` est requis dans le schéma, comme `ouverture_ok` pour l'agent qui ouvre le run.
  - Fin de run : nouvel agent `orchestre:greffier` (haiku), une fois par run, à toute sortie qui suit l'ouverture : `fin-run` avec le bilan (sans les actions ni les résumés), puis commit de SUIVI.md seul (`git commit … -- <plan>/SUIVI.md`) s'il a changé. C'est le cas d'une tâche close par une exception du workflow, que `fin-run` clôt d'après le bilan, en gardant les essais et la branche du suivi. Un greffier qui lève ou ne répond pas ne fait pas perdre le bilan.
  - Sans `args.suivi`, consignes et suivi de la 0.6.3 à l'identique.
- `suivi.mjs` :
  - une tâche ajoutée dont le fichier n'existe pas (retirée par le scribe sur un refus de plan-lint, qu'il signale de son côté) est sautée et notée au journal, au lieu de faire refuser toute la clôture ;
  - `fin-run` complète les tâches ajoutées du run au lieu de les remplacer (le bilan ne connaît pas celles des arbitrages), et fait entrer dans le suivi une tâche ajoutée par une clôture non écrite ;
  - `vue` relit les statuts dans SUIVI.md et git, comme `debut-run` : une tâche fusionnée à la main sans `pilote` passe à « fusionnée ».
- `/orchestre:lancer` : passe `suivi` ; au pré-vol, contrôle la règle `Bash(node …/suivi.mjs *)` et l'agent `orchestre:greffier`, et régénère SUIVI.md par `suivi.mjs vue`, commité seul après accord ; lit `suivi_echecs` ; les gestes du pilote (tâche fusionnée à la main, annulée) passent par `suivi.mjs pilote` ; `--reprendre` affiche `suivi.mjs etat`.
- `/orchestre:installer` : ajoute la règle du suivi avec celle de plan-lint ; `/orchestre:pret` la contrôle.
- Agents : une règle commune pour la commande de suivi (la lancer telle quelle, une seule fois, et rendre son résultat ; elle n'écrit que le suivi, hors git ; refusée ou en échec, elle ne compte nulle part ailleurs). Le workflow écarte aussi une commande de suivi citée parmi les commandes refusées au vérificateur.
- Tests : 15 scénarios du workflow avec le suivi, dont 4 qui lancent le vrai `suivi.mjs` dans un dépôt temporaire (refus et blocage, exception, clôture complète puis arbitrage, tâche ajoutée par un arbitrage) ; 17 cas pour `suivi.mjs`.
- `/orchestre:etat` reste en place ; `suivi.mjs etat` en donne le même contenu, plus l'étape de chaque tâche pendant un run.

### Environnement des dossiers de travail

- Préparation de l'environnement, déclarée par le projet dans `orchestre.config.json` (le plugin ne connaît aucune stack) :
  - `preparation` : commandes qui remettent un dossier de travail à jour (dépendances, code généré). Chaque worker les lance sur sa branche, avant tout autre travail ; l'intégrateur, entre la fusion et le contrôle post-fusion, et `git status` doit rester vide après elles ; une correction les relance si elle touche aux dépendances ou au code généré. Sur MonitIA, le contrôle post-fusion échouait sur du code généré périmé à chaque fusion d'une migration (5 arrêts dans une phase), et un worker isolé testait sur une base de test non préparée.
  - `preparation_partagee` : `{ "<ressource>": [commandes] }` pour un service commun (base de test) ; lancées seulement par les agents d'une tâche qui déclare cette ressource, donc jamais deux à la fois.
  - `/orchestre:pret` les propose d'après le dépôt et les essaie ; `/orchestre:preparer` les écrit dans un plan neuf ; `/orchestre:lancer` les passe au workflow et signale leur absence ; plan-lint vérifie leur forme.
- Worktrees des essais précédents : nouveau script `scripts/worktrees.mjs nettoyer`. Il retire les worktrees propres des tâches du plan (sans `--force`, verrou levé, branche gardée), garde et signale ceux qui ont du travail non commité, ne touche ni au checkout principal ni au dossier d'où il est lancé, et refuse tant que `suivi.json` note un run en cours (`--run-arrete` après confirmation). Le greffier le lance en fin de run, `/orchestre:lancer` au pré-vol. Sur MonitIA, 24 worktrees tenaient les branches de 17 tâches, d'où des branches `-r2` à `-r4`.
- Reprise d'une branche : remise à jour par `git merge --no-edit <intégration>` (vérifiée par `git merge-base --is-ancestor`), jamais par un rebase, que le classifieur du mode auto refuse (« Git Destructive »). Nouvelle autorisation `Bash(git merge-base *)` dans le modèle de l'installeur.
- Garde d'isolement des worktrees (Claude Code) : elle refuse aux agents isolés toute commande qu'elle ne peut pas prouver confinée au worktree (321 refus sur MonitIA). worker-isole reçoit des règles de commandes simples : pas de `cd`, d'`export` ni d'affectation en tête, pas d'enchaînement ni de sous-commande, pas de code évalué en ligne ni de script jetable hors du worktree, pas de `; echo $?` (le code de sortie est dans le résultat de l'outil), pas de filtre sur une sortie d'échec ; une commande refusée se découpe, elle ne se contourne pas.
- `/orchestre:installer` : si un outil du projet est introuvable dans le shell des agents, propose une clé `env` (PATH) dans `.claude/settings.local.json`. Sur MonitIA, Node hors du PATH faisait préfixer chaque commande par `export PATH=…`, que la garde refuse.
- plan-lint : avertissements (non bloquants) sur les commandes de vérification et de préparation composées, à évaluation en ligne ou en chemin absolu, et sur une ressource de préparation qu'aucune tâche ne déclare ; champ `avertissements` du JSON.
- Fichiers temporaires des workers dans `<scratchpad>/<id>/`, jamais dans le dépôt ; un worker ne lance pas un fichier écrit par un autre. Sur MonitIA, un worker avait lancé le script d'un autre, qui a modifié un troisième worktree.
- Workers : jamais de rebase, de reset ni de réécriture d'historique.

### Mettre à jour depuis la 0.6.3

1. `/plugin marketplace update circle`, puis `/reload-plugins` ou une session neuve.
2. Dans chaque dépôt : `/orchestre:installer` (règles de `suivi.mjs` et `worktrees.mjs`, `git merge-base`, clé `env` si besoin), puis une session neuve.
3. Pour chaque plan : `/orchestre:pret plans/<nom>` (préparation de l'environnement, vérifications composées).
4. `/orchestre:lancer plans/<nom>` : au pré-vol, il retire les worktrees propres des essais précédents et régénère le tableau de SUIVI.md, à commiter une fois.

### Pas encore vérifié en réel

- La garde d'isolement accepte-t-elle les commandes de suivi (`node <suivi.mjs> etape … --json '…'`), un `git merge-base` ou un script du projet lancé depuis le worktree ?
- L'écriture de `suivi.json` dans le checkout principal depuis un worktree isolé.
- Le coût des appels de suivi et de la préparation par tâche : donnée à collecter.

## 0.6.3 — 29/09/2026 : état du plan

- Nouvelle commande `/orchestre:etat [plans/<nom>]` : l'avancement du plan en un tableau compact.
  - Une ligne par phase, avec sa barre de progression.
  - Les tâches en cours : branche `tache/<id>`, dans le checkout ou un worktree, âge du dernier commit.
  - Ce qui attend l'utilisateur : prérequis ouverts et tâches qu'ils bloquent, tâches en attente d'un humain, bloquées ou en échec, relectures avant la PR, tickets, erreurs de plan-lint.
  - Sans argument, le seul plan de `plans/`.
- Faite pour la session pilote pendant un run : elle ne fait que lire (aucun switch, aucune écriture, git sans verrou optionnel), à partir de plan-lint et de git. Le script `scripts/etat.mjs` calcule tout, et Claude ne fait que recopier une quinzaine de lignes. L'étape de chaque agent reste dans `/workflows`.
- Vérifié avec Claude Code 2.1.285, avec et sans argument : la commande injectée dans la skill est autorisée par `allowed-tools`, le tableau est recopié tel quel et le dépôt reste inchangé.
- Tests : 7 cas pour l'état dans un dépôt jouet (`tests/etat.test.mjs`), dans `npm test`.

## 0.6.2 — 29/09/2026 : fichiers interdits aux agents

Au premier run réel (mr-review-recall, phase 2), les agents n'avaient pas le droit de lire les `.env.example` qu'une tâche devait modifier : la règle `Read(./.env.*)` que `/orchestre:installer` écrit dans `.claude/settings.local.json` les couvre aussi, à toutes les profondeurs. Le blocage remontait comme un point à trancher. Pendant ce run, la session pilote recevait aussi des demandes sur le dépôt (vérifier un fichier, afficher un diff) alors que les agents travaillaient dans le checkout principal.

- Fichier que les agents n'ont pas le droit de lire ou d'écrire, ou commande qu'ils n'ont pas le droit de lancer (réglages de l'organisation ou du projet) : aucun agent ne contourne l'interdiction, et le run ne s'arrête pas, sauf dans les deux cas notés plus bas. Il en sort une entrée `relecture · majeur` de HANDOFF.md, que l'humain fait avant la PR, sans replanification ni écart sensible, dans les trois modes. Nouveau champ de rapport : `relectures`.
  - Le worker décrit la modification attendue dans un écart de type `relecture`.
  - Le vérificateur cite une commande refusée dans `interdites` : elle ne compte pas en échec et ne déclenche aucune correction. Le contrôle post-fusion prend la première commande permise. Une « interdite » qui n'est pas une commande de la tâche compte en échec ; une tâche dont aucune commande n'est permise finit bloquée, sans correction ni fusion, car rien ne la prouve.
  - L'évaluateur cite un fichier illisible dans `illisibles` : ce n'est ni un manque ni un critère non vérifiable. Un fichier cité une fois reste en relecture aux évaluations suivantes.
  - Le replanificateur reclasse en relecture une interdiction que le worker a remontée comme un écart ordinaire (champ `relectures`). Le reclassement ne lève l'écart sensible que si seule la mention d'un `.env` le rendait sensible : un écart reclassé qui cite aussi une base, la prod ou un secret arrête le run pour un humain, quels que soient les autres points.
- `/orchestre:lancer` : les relectures vont dans le résumé de phase. À la fin, elles sont listées avec la commande à lancer soi-même dans un terminal à part : un secret glissé dans l'un de ces fichiers n'entre jamais dans le contexte du pilote.
- `/orchestre:lancer` se place à la racine du dépôt au début de chaque phase. Pendant un run, il ne touche pas au checkout principal : ni `switch`, `checkout`, `stash`, `reset` ni commit, aucune écriture, et `git status` seulement avec `GIT_OPTIONAL_LOCKS=0`. Une demande sur le dépôt attend la fin du run.
- `/orchestre:installer` : les refus de lecture gardent `.env` et `.env.*`, avec une exception pour chaque modèle versionné : `Read(!.env.example)`, `Read(!.env.sample)`, `Read(!.env.template)`, `Read(!.env.dist)`. Une exception n'annule que les règles placées avant elle dans le même fichier : elles suivent donc `Read(./.env.*)`. Sur un projet déjà installé, la commande propose de les ajouter ; `/orchestre:lancer` et `/orchestre:pret` signalent l'ancienne règle. Vérifié sur Claude Code 2.1.285 : les `.env.example` deviennent lisibles et modifiables à toutes les profondeurs, tandis que `.env`, `agents/x/.env` et `.env.local` restent refusés.
- `/orchestre:preparer` et `/orchestre:pret` repèrent les fichiers interdits aux agents dès la planification : une tâche ne les possède pas, aucune commande de vérification ne les lit, et une entrée `relecture` les annonce.
- Corrections :
  - Après une correction, les écarts des essais précédents étaient perdus, car le rapport de correction remplaçait celui du worker : un écart majeur remonté au premier essai, un contrat changé par exemple, échappait au replanificateur. Ils sont maintenant cumulés d'un essai à l'autre. Le worker de correction les reçoit pour ne pas les répéter, et reçoit aussi les découvertes précédentes, qu'il rend à jour ; s'il ne rend pas de découvertes, les précédentes restent. Valait déjà pour la v0.5.
  - Conséquence assumée : un écart sensible remonté à un essai reste sensible même si la correction l'a réparé. Il donne un point (arrêt en arrêt sur déviation, décision d'office en autonome, point à trancher en arrêt par phase), ou un arrêt humain si le replanificateur n'en rend aucun.
  - Une correction sans réponse (limite d'usage, erreur d'API) faisait finir la tâche en échec sans aucun rapport, avec la raison « worker sans réponse ». Elle finit maintenant en échec avec le rapport des essais précédents (écarts, relectures, branche) et la raison « correction sans réponse ».
- Scribe : une entrée `relecture`, `ticket` ou `angle-mort` déjà présente mot pour mot sous le même titre ne s'ajoute pas une seconde fois, à la relance d'une tâche par exemple. Les refus et blocages s'ajoutent toujours, car ils comptent les essais.
- Tests : 67 scénarios (15 nouveaux), 13 cas plan-lint, 30 mutations détectées, chacune par un cas qui échoue.

## 0.6.1 — 29/09/2026 : prêt à lancer

Tout ce qu'un humain doit décider ou faire est repéré à la planification, écrit dans le plan et contrôlé par plan-lint avant chaque phase. Au premier run réel (mr-review-recall), quatre décisions ouvertes du plan source n'avaient été posées ni à la conversion ni au lancement.

- `PREREQUIS.md` dans le plan : une ligne par prérequis (décision, geste humain ou environnement), avec son statut (`ouvert`, `fait`, `abandonné`) et sa preuve. Chaque tâche cite les siens dans `prerequis:`.
- plan-lint : refuse un prérequis inconnu, en double, pris par une tâche, de type ou de statut inconnu ; une décision au statut `fait` qu'aucune entrée de HANDOFF.md commençant par `décision ·` ne cite ; une décision ouverte qu'aucune tâche restante ne cite ; un PREREQUIS.md sans tableau reconnu ou avec une ligne ignorée. Il signale un geste ou un environnement ouvert que rien ne cite, et compte une tâche « besoin-humain » comme en attente. Le JSON donne `prerequis_ouverts` par tâche, `prerequis` (avec les tâches bloquées) et `pret` par phase. La sortie texte affiche un bloc « Prêt à lancer ». Un `\|` est permis dans une cellule de tableau.
- Workflow : une tâche dont un prérequis est ouvert ne part pas, même relancée ; les tâches de sa phase qui en dépendent attendent avec elle, et le reste tourne. Nouveau champ de rapport : `en_attente_prerequis`.
- `/orchestre:preparer` : le plafond de 3 questions disparaît. Il pose toutes les décisions ouvertes, par lots de 4, avec une option « Reporter », inventorie gestes et environnement dans PREREQUIS.md, et conclut phase par phase si le plan est prêt à lancer.
- Nouvelle commande `/orchestre:pret` : environnement, prérequis (décisions tranchées sur-le-champ, gestes à faire), répétition à blanc des vérifications sûres, verdict par phase. Pour un plan écrit avant la 0.6.1, elle construit d'abord PREREQUIS.md.
- `/orchestre:lancer` : contrôle des prérequis au pré-vol et avant chaque phase, preuve des prérequis d'environnement rejouée ; en arrêt par phase, le résumé de la phase va dans le texte même de la question de fin de phase, si bien que le pilote ne peut plus le sauter. Une phase `partiel` avec des tâches ajoutées ou reportées est relancée d'elle-même.
- Le replanificateur lit PREREQUIS.md : un point sur un prérequis ouvert est humain, et une tâche ajoutée cite ses prérequis. Le lecteur du plan doit rendre `prerequis_ouverts` pour chaque tâche.
- Répétition à blanc : un échec n'est classé « déjà présent » que si aucune tâche n'est fusionnée ou s'il se reproduit sur la branche de base ; l'état git est comparé avant et après.
- Tests : 52 scénarios (5 nouveaux), 13 cas plan-lint (4 nouveaux), 13 mutations détectées, une par garde-fou nouveau.

## 0.6.0 — 29/09/2026 : plugin

L'orchestrateur devient un plugin installable depuis la marketplace `circle`, au lieu d'une copie dans le `.claude/` de chaque projet. La logique d'orchestration est celle de la v0.5, avec les corrections listées plus bas.

- Commandes namespacées : `/orchestre:lancer` (ex-`/lancer`), workflow `orchestre:executer-phase`, agents `orchestre:<agent>`.
- Nouvelle commande `/orchestre:installer` : réglages du projet (`worktree.baseRef`, `autoContinueAtUsageLimit`, autorisations et refus), `.worktreeinclude`, exclusions du formateur, retrait d'une installation manuelle, partage avec l'équipe (`--equipe`).
- Nouvelle commande `/orchestre:preparer` : convertit un plan déjà écrit ou en rédige un nouveau, au format de l'orchestrateur, puis le valide avec plan-lint. Elle reprend le modèle de brief de planification de la v0.5.
- Workflow : nouveaux `args`, passés par `/orchestre:lancer` : `lint` (chemin de plan-lint dans le plugin ; sans lui, l'ancien `.claude/orchestre/plan-lint.mjs`), `prefixe_agents` (`orchestre:` par défaut ; `''` pour une installation manuelle) et `base` (branche de base, lue par plan-lint). `horodatage`, que rien ne lisait, disparaît.
- plan-lint : `--base` (sinon `main`, sinon `master`) ; refuse une branche qui commence par `-` (git l'aurait lue comme une option : `--output=…` écrivait un fichier) et un dossier sans `taches/`.

Corrections issues de la relecture de la v0.6, dont plusieurs valaient déjà pour la v0.5 :

- **Mode** : il vaut `auto`, `devia` ou `phase`, et toute autre valeur arrête le run. Avant, une valeur inconnue retombait sans bruit en arrêt par phase : « arrêt sur déviation » ne marchait que si le pilote devinait `devia`. `/orchestre:lancer` passe maintenant les codes exacts.
- **Fusions d'un plan précédent** : plan-lint ne compte plus que les commits « tâche <id> : » de la branche d'intégration absents de la branche de base. Avant, dès le deuxième plan d'un dépôt, les fusions du premier, déjà dans `main`, faisaient passer pour fusionnées les tâches de même identifiant. Nouveau champ de config : `branche_base`.
- **Amendement d'une tâche déjà fusionnée** : il est écarté et consigné en angle mort, et le run continue. C'est le cas d'un arbitrage tranché après que sa tâche a tourné, ou, en autonome, d'une tâche d'une autre phase. Avant, le scribe le refusait et le run s'arrêtait.
- **Reprise d'une tâche** : une seule règle, dans le checkout principal comme en worktree. Le worker reprend la branche la plus récente, ou en crée une nouvelle `tache/<id>-r<n>` si un worktree la tient encore, et rend son nom exact. Avant, une reprise dans le checkout principal échouait sur une branche tenue par un worktree.
- **Parallélisme de 1** : plus de worktree, donc plus de réinstallation des dépendances pour rien.
- **Erreur du workflow pendant une tâche** : sa raison arrive dans `blocage`.
- **`arbitrages_appliques`** : des objets `{ tache, titre, option }` au lieu de `tache/option`, ambigu ; un arbitrage appliqué avec des refus s'annonce « appliqué en partie ».
- **plan-lint** : une virgule entre guillemets ne coupe plus un élément de liste courte ; « 1 tâche » au singulier.
- **Skills** :
  - `/orchestre:installer` écrit les réglages après accord, ne retire jamais l'ancienne installation pendant un run, et reconnaît tous ses fichiers ;
  - `/orchestre:preparer` n'ouvre ni `.env` ni dump, et ne lance les tests que s'ils ne touchent ni base partagée ni données réelles.
- **Tests** : 47 scénarios simulés, dont 10 nouveaux pour le plugin et les corrections ; 9 cas de plan-lint versionnés (`tests/plan-lint.test.mjs`) ; 11 mutations, une par correction, toutes détectées ; un dépôt jouet pour un essai réel (`tests/depot-jouet.sh`).
- Vérifié : `claude plugin validate` du plugin et de la marketplace, installation depuis la marketplace, inventaire (3 skills, 8 agents) ; sur un plugin de test, workflow de plugin appelé par son nom, agent du plugin résolu depuis `agent({ agentType: '<plugin>:<agent>' })`, `${CLAUDE_PLUGIN_ROOT}` substitué dans le corps d'un agent et d'une skill. Pas encore de run complet sous forme de plugin.

## 0.5.0 — 29/09/2026 : après la phase 4

- Écarts sensibles (données, base, prod, secret) majeurs d'office ; sans point de décision, arrêt pour un humain.
- Cohérence des décisions d'office : une option qui cite une tâche que rien ne crée n'est pas appliquée et le run s'arrête ; le scribe vérifie les fichiers cités. plan-lint rend `tous` et `phase_max`.
- Statut `besoin-humain` : une tâche en attente d'un humain ne repart qu'avec `args.relancer`.
- Données réelles : aucun agent n'ouvre, ne restaure ni ne copie de données de production ou personnelles réelles ; un test ne modifie pas une base partagée.
- Textes vrais : l'évaluateur vérifie commentaires, DECISIONS et procédures.
- Convergence : en dernière phase, les points qui ne protègent pas le déploiement deviennent des tickets.
- Qualité d'abord : évaluateur et replanificateur sur opus, vérificateur et scribe sur sonnet.
- 37 scénarios simulés, 25 mutations détectées.

## 0.4.0 — 28/09/2026 : après la phase 2

- Points à trancher avec options et actions prêtes à appliquer ; en mode autonome, l'option recommandée est prise d'office.
- Garde-fous : point humain, coupe-circuit (`decisions_office_max`), compte rendu obligatoire du scribe, plan-lint après chaque création ou amendement.
- Arbitrages de l'utilisateur appliqués par le scribe (`args.arbitrages`), statut `à-relancer`.
- worker-isole installe les dépendances dans son worktree.

## 0.3.0 — 28/09/2026 : après les évaluations de T00

- Le vérificateur rend code de sortie et extrait de chaque commande, que l'évaluateur reçoit comme preuves ; le rapport du worker est un livrable, pas une preuve.
- Refus consignés (`refus · mineur`) ; critères non vérifiables notés en angle mort au lieu d'un KO.

## 0.2.0 — 28/09/2026 : après la phase 1

- Relance tolérée des tests instables, raison exacte des blocages, reprise de la branche d'une tâche relancée, retour du scribe sur la branche d'intégration, correction d'une tâche bloquée depuis la session pilote.

## 0.1.0 — 27/09/2026

- Premier workflow `executer-phase` : un run par phase, worktrees pour les tâches parallèles, `effort` transmis, plan-lint `--integration`.

## Annexe : historique du plugin orchestre-suivi, fusionné en 0.9.0

Versions publiées du mod quand il était un plugin à part, recopiées sans changement, titres décalés d'un niveau.

### orchestre-suivi 0.2.0 — 09/10/2026 : couleurs, animation et `/suivi demo`

0.1.0 a été publiée sans être vue en réel ; cette version ajoute ce qu'il faut pour la voir dans n'importe quelle session.

- Bandeau au-dessus du prompt pendant un run : phases, barre d'avancement, tâche et étape en cours, relectures, tâches qui attendent, durée du run, dernière nouvelle ; à la fin du run, son statut, jusqu'à « Masquer » (touche 0) ou au run suivant. Il tient dans la largeur de la bande : l'aide, la nouvelle, le détail de l'étape, puis les libellés, la barre, la durée et le numéro du run partent tour à tour.
- En couleurs et animé, d'après la maquette validée le 08/10 (couleurs du thème de la personne) :
  - barre par statut : une ou plusieurs cases par tâche, ou en proportion sur un gros plan, vertes quand elles sont fusionnées, bleues quand elles sont en cours (elles pulsent), ambre quand elles attendent un humain, rouges quand elles sont bloquées ou en échec, grises sinon ; dans le panneau et le Bilan, une case ■ par tâche de chaque phase ;
  - phases en points (● faite, ◉ celle du run, ○ à venir), ou « phase 3/27 » au-delà de 10 phases ;
  - roue qui tourne en tête du bandeau et ◐◓◑◒ pour les tâches en cours, avec leur chrono ; redessin toutes les 150 ms pendant un run actif et tant qu'une nouvelle a moins de 10 s, toutes les 30 s pour un run sans nouvelles, rien sinon ;
  - dernière nouvelle au bout du bandeau (« ✓ T01 fusionnée », « ⚑ T03 attend un humain », « ▶ run 2 lancé ») : la plus importante de la dernière écriture, vive 5 s puis estompée jusqu'à 10 s ; « Dernières nouvelles » au bas de l'onglet Tâches ;
  - pastilles sur fond coloré : « ⚠ à toi » en ambre, l'onglet ouvert, une tâche tout juste fusionnée (« fusionnée » en vert, 5 s) ; une couleur par étape (réalisation, vérification, évaluation, correction, fusion).
- Mode démo : `/suivi demo`, dans n'importe quelle session, joue en mémoire deux runs d'un plan fictif (`site-vitrine`, 5 tâches, 2 phases) en un peu plus d'une minute : bandeau marqué DÉMO, notifications, arrêt sur un arbitrage avec une pause de 12 s, reprise, fin. Rien n'est lu ni écrit dans le dépôt pendant la démo ; le vrai suivi reprend une minute après le dernier pas, ou à `/suivi auto`. Un « Masquer » de la démo ne vaut pas pour les vrais runs ; une démo figée par un rechargement du mod s'efface.
- Les documents de la démo suivent le schéma du contrat (vérifié par `suivi.mjs valider` à chaque pas), et `tests/demo-suivi.mjs` joue le même scénario avec le vrai `suivi.mjs` : les tests vérifient les mêmes notifications et le même journal, entrée pour entrée.
- Le mode démo a remplacé `tests/demo-suivi.mjs` comme façon de voir le mod ; le script reste pour les tests.
- Tests : 18 cas du modèle sur des `suivi.json` écrits par le vrai `suivi.mjs`, dont `/suivi demo` comparée au vrai `suivi.mjs` (`npm test`) ; 12 tests sous le moteur (`claude plugin test`), sur le terminal et le bureau, dont `/clear` simulé par un `$.state` tenu par le test, l'animation sous une horloge simulée et la démo de bout en bout ; 65 mutations du modèle, de la démo et des hooks, rejouées sur le code final, toutes détectées. Vérifié avec le kit de test de Claude Code 2.1.294.

#### Pas encore vérifié en réel

- Le chargement du mod sur le Mac (Claude Code 2.1.287 ou plus attendu ; `/plugin` doit le nommer parmi les mods actifs).
- Le dessin réel du bandeau, du spinner et du panneau, couleurs et animation comprises (le kit de test valide les arbres, pas le rendu) : `/suivi demo` sert à le vérifier. Le coût d'un redessin toutes les 150 ms pendant un run est une donnée à collecter.
- Le coût d'une relecture toutes les 2 s sur un gros `suivi.json` (au-delà de 4 Mio, `$.fs.read` refuse et l'affichage garde la lecture précédente).

### orchestre-suivi 0.1.0 — 08/10/2026 : premier mod de suivi

Le mod suit un run du plugin `orchestre` (0.8 ou plus) dans la session pilote, sous Claude Code 2.1.287 ou plus (version à partir de laquelle les mods sont actifs par défaut, d'après la doc des mods), d'après les maquettes validées (bandeau, panneau, relectures, bilan). Il lit `plans/<nom>/suivi.json` au format `orchestre-suivi/1`, écrit par `scripts/suivi.mjs` d'orchestre, et n'écrit rien dans le dépôt.

- Plan suivi : celui de `/suivi plans/<nom>`, sinon le `suivi.json` écrit en dernier dans `plans/` (`/suivi auto` y revient). Le dossier `plans/` est cherché dans le dossier de la session et ses parents. Relecture toutes les 2 s, seulement si le fichier a changé.
- Bandeau au-dessus du prompt pendant un run : phase, barre d'avancement, tâches en cours, relectures, tâches qui attendent, durée du run ; à la fin du run, son statut, jusqu'à « Masquer » (touche 0) ou au run suivant. Il tient dans la largeur de la bande : l'aide, puis les libellés, la barre, la durée et le numéro du run partent tour à tour.
- Spinner : la tâche et l'étape en cours, et le nombre de tâches qui tournent.
- `/suivi` répond même pendant un tour : un panneau à quatre onglets (Tâches, À relire, Journal, Bilan ; touches t, r, j, b), ou le même état en texte avec `/suivi texte` ou là où un panneau ne se place pas. Le Bilan propose « Préparer la PR dans le prompt » (touche p) : un brouillon avec les relectures, les décisions d'office et ce qui attend, jamais envoyé.
- Notifications : run lancé ou arrêté, phase terminée, tâche qui attend un humain, bloquée ou en échec, nouvelle relecture, point d'arrêt.
- Choix faits faute de donnée dans suivi.json : pas de titre de phase (« Phase N ») ; les « écarts conservés » des maquettes deviennent le nombre d'entrées majeures de HANDOFF.md par type ; les heures sont des âges (« il y a 12 min »), le fuseau du mod n'étant pas vérifié.
- Suivi des sessions : une session interactive, ou hébergée par l'app de bureau (lecture au `session.attach` quand elle démarre sans surface) ; un `claude -p` ne lit rien.
- Pendant un run, le bandeau se redessine toutes les 30 s même sans nouvelle écriture de `suivi.json` : la durée avance. Un run resté « en-cours » sans écriture depuis 45 min est montré « ◌ sans nouvelles depuis … » (session fermée en plein run), sans tâche en cours ni suffixe au spinner.
- Une notification par tâche pour ses relectures (« ⚑ T02 : 2 relectures avant la PR ») ; le point d'arrêt noté par le scribe à la clôture est signalé quand la fin du run en fait un arrêt ; une phase dont toutes les tâches sont annulées n'est plus comptée ; le brouillon de PR s'ajoute à ce qui est déjà tapé dans le prompt.
- Relu par un agent avant livraison : ces neuf défauts relevés, tous corrigés.
- Trouvés en jouant la démo (`tests/demo-suivi.mjs`), corrigés : un run en mode auto montrait encore sa phase de départ en phase 2 (le bandeau suit maintenant la plus haute phase des tâches que le run a démarrées ou closes, et la fin de run dit « phases 1 à 2 ») ; la durée d'une phase ne comptait que les runs partis de cette phase (elle va maintenant, dans chaque run, du premier démarrage au dernier achèvement de ses tâches) ; une tâche dont le run venait de trancher le point, ou qu'il avait relancée, restait « à toi ».
- Aligné sur la doc des mods (code.claude.com/docs/en/plugins/mods, pages interface, référence, API, tests et dépannage), lue en entier :
  - la bande au-dessus du prompt est partagée : ce que les mods suivants y dessinent reste affiché sous le bandeau ;
  - « Masquer » a la touche 0, qui marche aussi tapée seule dans un prompt vide, sans focus sur la bande ;
  - `/suivi` est enregistrée en dernier, dans un try/catch : un nom déjà pris ne bloque plus la lecture ni le bandeau, et une notification le dit ;
  - le bandeau tient dans `bodyColumns`, la place du bouton « Masquer » comprise ;
  - après `/clear`, `/resume` ou `/branch`, qui remettent `$.state` à zéro sans relancer `session.start` : le plan choisi par `/suivi plans/<nom>` et le « Masquer » reviennent, et `suivi.json` est relu tout de suite (`classic.SessionStart`) ;
  - Échap ferme le panneau ; les notifications qui demandent quelqu'un (attend un humain, bloquée, en échec, run arrêté ou en erreur) restent 15 s au lieu de 4.
- Démo : `node tests/demo-suivi.mjs <dossier>` crée un dépôt jouet et y joue deux runs avec le vrai `suivi.mjs`, sans agent ni modèle ; après chaque pas, elle affiche ce que le mod doit montrer, calculé par son modèle.
- Tests : 14 cas du modèle sur des `suivi.json` écrits par le vrai `suivi.mjs`, dont la démo jouée sans pause (`npm test`) ; 7 tests sous le moteur (`claude plugin test`), sur le terminal et le bureau, dont `/clear` simulé par un `$.state` tenu par le test ; 34 mutations du modèle et des hooks, rejouées sur le code final, toutes détectées. Vérifié avec le kit de test de Claude Code 2.1.294.

#### Pas encore vérifié en réel

- Le chargement du mod sur le Mac (Claude Code 2.1.287 ou plus attendu ; `/plugin` doit le nommer parmi les mods actifs).
- Le dessin réel du bandeau, du spinner et du panneau (le kit de test valide les arbres, pas le rendu) : la démo sert à le vérifier.
- Le coût d'une relecture toutes les 2 s sur un gros `suivi.json` (au-delà de 4 Mio, `$.fs.read` refuse et l'affichage garde la lecture précédente).
