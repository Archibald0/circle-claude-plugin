---
name: pret
description: Vérifie qu'un plan orchestre est prêt à lancer, sans exécuter aucune tâche — environnement, prérequis de PREREQUIS.md (décisions à trancher sur-le-champ, gestes humains), répétition à blanc des vérifications sûres — et rend un verdict phase par phase. À lancer la veille, quand l'utilisateur tape /orchestre:pret.
argument-hint: <dossier-plan> [--sans-repetition]
disable-model-invocation: true
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs *)
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs *)
  - Bash(claude --version)
  - Bash(node --version)
  - Bash(date *)
  - Bash(git status *)
  - Bash(git rev-parse *)
  - Bash(git log *)
  - Bash(git ls-files *)
  - Bash(git check-ignore *)
---
# Prêt à lancer ?

Tu vérifies que le plan `$ARGUMENTS` peut tourner sans s'arrêter sur ce qu'on pouvait régler avant. Tu n'exécutes aucune tâche du plan et tu ne modifies aucun code applicatif. Tu n'écris que dans le dossier du plan (PREREQUIS.md, HANDOFF.md, DISCOVERY.md, et les tâches pas encore lancées pour un amendement), après accord. Tu ne lis jamais le contenu d'un `.env`, d'un dump ni d'une copie de données réelles. Messages courts.

Jamais pendant un run de l'orchestrateur : fais d'abord confirmer par l'utilisateur qu'aucun run n'est actif (`/workflows`), sinon arrête-toi. La répétition et les commits se font dans le checkout principal, où travaillent les agents.

plan-lint, dans ce plugin : `node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs`.

## 1. Environnement

Relève chaque point sans t'arrêter : ils vont au verdict.

1. `claude --version` : 2.1.271 ou plus. `node --version` : 18 ou plus. Les agents `orchestre:*` figurent parmi les types d'agents disponibles.
2. Réglages : `worktree.baseRef: "head"`, `autoContinueAtUsageLimit`, `git push` et l'outil de déploiement refusés, règles `Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs *)`, `Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/suivi.mjs *)` et `Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs *)` dans `allow`, outils des vérifications trouvés dans le shell des agents (`command -v`, sinon clé `env`). Ce qui manque relève de `/orchestre:installer`.
3. `orchestre.config.json` : branche d'intégration et branche de base (`branche_base`, `main` par défaut). Git : aucune modification non commitée sur les fichiers suivis ; la branche d'intégration existe et le dossier du plan y est commité. Place-toi dessus maintenant : le plan n'existe que là. `.worktreeinclude` liste les `.env` s'il y en a.
4. Dossiers non suivis (`git status --porcelain`) qu'un formateur ou un linter lancé sur tout le dépôt lirait dans le checkout principal : signale-les ; leur exclusion relève de `/orchestre:installer`. Worktrees des essais précédents : `node ${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs nettoyer <plan> --essai`, qui ne touche à rien ; ceux qui ont des modifications attendent l'utilisateur (commit ou abandon), les autres seront retirés par `/orchestre:lancer`.
5. Préparation de l'environnement, dans `orchestre.config.json` du plan :
   - `preparation` : les commandes qui remettent un dossier de travail à jour après un changement de branche ou une fusion, sans toucher à un service commun : installation des dépendances depuis le lockfile, génération de code (clients d'ORM, protobuf, types…). Chaque worker les lance au démarrage, dans son worktree ; l'intégrateur, après chaque fusion, avant le contrôle.
   - `preparation_partagee` : `{ "<ressource>": [commandes] }`, pour un service commun à tous les dossiers de travail (base de test, conteneur). Elles ne tournent que pour une tâche qui déclare cette ressource dans `ressources`, donc jamais deux à la fois.
   Si elles manquent, prépare une proposition d'après le dépôt (scripts du gestionnaire de paquets, Makefile, CI, README, DISCOVERY.md) : des commandes simples, sans `&&`, `;`, `|` ni `export`. Fais-la valider avec les prérequis (section 2), écris-la après accord, puis lance une fois chaque commande pour vérifier qu'elle passe, avec les règles de la répétition à blanc (section 3) : commandes sûres seulement, `git status` avant et après. Signale aussi les tâches dont la vérification touche un service commun sans déclarer sa ressource.
6. Mode de permission : en mode manuel, une commande de vérification non autorisée arrêtera le run sur une demande de permission. Liste celles qui ne sont pas autorisées.
7. Fichiers interdits aux agents : parmi les fichiers que citent les tâches restantes, repère ceux dont la lecture t'est refusée par les réglages. Ne contourne jamais l'interdiction. Un modèle versionné (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`) refusé alors que `.claude/settings.local.json` a `Read(./.env.*)` sans ses exceptions vient d'une installation d'avant la 0.6.2 : propose `/orchestre:installer`, qui les ajoute, plutôt qu'une relecture. Les autres iront en relecture par l'utilisateur avant la PR : vérifie qu'une entrée `relecture` de HANDOFF.md les annonce, sinon propose-la. Une commande de `verification` qui en lit un serait refusée au vérificateur et ne prouverait rien pendant le run : propose de la retirer de la tâche et de la noter dans cette entrée, pour que l'utilisateur la lance lui-même avant la PR.

## 2. Prérequis

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs <plan> --json --integration <branche>`, plus `--base <branche_base>` si la config en donne une : erreurs, `avertissements`, `prerequis`, `pret`. Une commande de vérification composée (avertissement) sera refusée à un agent isolé dans un worktree : propose de la réécrire en commandes simples, ou d'en faire un script du projet possédé par la tâche (ou par une tâche d'outillage), et écris l'amendement après accord.
2. Modèles : pour chaque tâche restante, le modèle et sa raison (`modele`, `raison_modele` dans les tâches de plan-lint), une ligne par tâche. Signale les tâches sans modèle, que plan-lint avertit : leur worker tournera sur sonnet, et leurs corrections suivront l'échelle `escalade` de la config, sans choix du replanificateur. Signale aussi celles qui ont un modèle sans raison. Ne juge pas les choix, sauf si l'utilisateur le demande. Un modèle à ajouter ou à changer se fait dans le frontmatter de la tâche, après accord, comme un amendement.
   - Fable : affiche le réglage `fable` d'`orchestre.config.json` (champ `fable` du JSON de plan-lint). S'il manque alors qu'une tâche restante est sur `fable` ou que `escalade` le contient (plan-lint l'avertit), pose la question de `/orchestre:preparer` : « Utiliser fable pour ce plan ? », « Non (recommandé) » (plus coûteux, sans gain constaté sur opus à ce jour) ou « Oui ». Écris la réponse dans `orchestre.config.json` après accord. Sur « Non », ou avec `"fable": false` déjà écrit (plan-lint en fait une erreur), propose de passer ces tâches sur `opus` (raison mise à jour) et de retirer fable d'`escalade`, et écris-le après accord.
3. Pas de PREREQUIS.md (plan écrit avant la v0.6.1) : construis-le. Cherche dans HANDOFF.md (entrées `besoin-humain`, décisions annoncées mais pas prises), dans les tâches restantes (décisions citées comme à trancher, accès, secrets, services externes, données réelles) et dans le plan source s'il existe. Pour chaque tâche, distingue une vraie dépendance d'une simple mention de contexte. Propose les lignes du tableau et les `prerequis` à ajouter aux tâches, écris-les après accord, puis relance plan-lint.
4. Décisions ouvertes : propose de les trancher maintenant, avec l'outil de question, par lots de 4 questions au plus. Chaque question a 4 options au plus : 3 choix au plus, le recommandé en premier avec son impact, puis « Reporter ». L'outil ajoute de lui-même « Autre ». Pour chaque décision tranchée :
   - entrée `décision · majeur · <ID> : … (tranchée par l'utilisateur)` sous `## plan source` dans HANDOFF.md ;
   - statut `fait` et preuve « HANDOFF » dans PREREQUIS.md ;
   - si elle change une tâche pas encore lancée, montre l'amendement et écris-le après accord.
5. Gestes ouverts : dis exactement ce que l'utilisateur doit faire, avec le préfixe `!` pour une commande qui touche un secret, des données réelles ou la prod. Quand il confirme que c'est fait : statut `fait`, preuve « confirmé par l'utilisateur le <date> » (`date +%d/%m/%Y`).
6. Environnement ouvert : si la preuve est une commande sûre (voir la répétition), lance-la ; sinon, demande.
7. Relance plan-lint après chaque écriture.

## 3. Répétition à blanc (sauf avec `--sans-repetition`)

Rejoue sur la branche d'intégration, une fois chacune, les commandes de `verification` des tâches restantes de la prochaine phase à lancer ; de toutes les phases si l'utilisateur le demande.

- Seulement les commandes sûres : aucune lecture de données réelles, aucune écriture dans une base partagée (une base de test que le script recrée est permise), aucun appel payant (API de modèle, service facturé) ni à un service externe, aucun déploiement, aucune réécriture de fichiers suivis (un formateur sans son mode de contrôle, une option `--fix`, un build qui régénère un fichier versionné), aucun arrêt de processus (une commande qui libère un port en tuant ce qui l'occupe). Dans le doute, ne la lance pas et propose à l'utilisateur de la lancer lui-même avec `!`.
- Relève `git status --porcelain` avant la répétition et compare-le après : si des fichiers ont changé ou sont apparus, montre-les et propose de les restaurer, après accord. Sinon, le pré-vol de `/orchestre:lancer` échouera.
- Une commande qui porte sur un fichier qu'une tâche restante doit créer (dans ses `fichiers_possedes`, absent du dépôt) : ne la lance pas, note « créée par <id> ».
- Une commande à la fois, sans pipe pour lire le code de sortie (ajoute `; echo "code=$?"`), 10 minutes au plus chacune.
- Classe chaque échec : outil ou service manquant, permission refusée, échec déjà présent avant le plan, ou autre. « Déjà présent avant le plan » seulement si aucune tâche n'est encore fusionnée, ou si la commande échoue aussi sur la branche de base : vérifie-le dans un worktree temporaire (`git worktree add --detach <dossier temporaire> <branche_base>`, puis `git worktree remove` sur ce dossier). Propose d'ajouter ces échecs-là, et eux seuls, à « Commandes vérifiées » dans DISCOVERY.md : l'évaluateur ne les comptera pas contre les tâches.

## 4. Verdict

1. Le verdict, phase par phase : `prête`, ou ce qu'elle attend (prérequis ouverts, fin d'une phase précédente, échec de répétition à régler), avec le modèle de chaque tâche et sa raison, et les tâches sans modèle. Donne l'estimation de tokens de plan-lint, en rappelant que le réel a été de 3 à 8 fois plus élevé sur le pilote (mesuré avec `/usage`).
2. Ce qui reste à faire, dans l'ordre, et qui le fait.
3. Ajoute à la fin de PREREQUIS.md la ligne « Vérifié par /orchestre:pret le <date> : <verdict en une ligne> ». Avec l'accord de l'utilisateur, commite les fichiers du plan modifiés sur la branche d'intégration (place-toi dessus si besoin), avec le message `pret(<nom>) : <verdict court>`.
4. Si la prochaine phase est prête : `/orchestre:lancer plans/<nom>` dans une session neuve.
