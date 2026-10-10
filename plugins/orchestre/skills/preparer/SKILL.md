---
name: preparer
description: Écrit un plan exécutable par /orchestre:lancer (dossier plans/<nom>/) — convertit un plan déjà écrit ou en rédige un nouveau à partir d'un objectif —, fait trancher toutes les décisions, inventorie ce qui doit être prêt (PREREQUIS.md), puis le valide avec plan-lint. À utiliser quand l'utilisateur tape /orchestre:preparer ou demande de préparer, d'écrire ou de convertir un plan pour l'orchestrateur.
argument-hint: "<plan existant (fichier ou dossier) | objectif du plan>"
model: opus
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs *)
  - Bash(git status *)
  - Bash(git rev-parse *)
---
# Préparer un plan orchestre

Rôle : planificateur. Tu ne modifies aucun code applicatif. Tu n'ouvres jamais un `.env`, un dump ni une copie de données réelles : tu les repères par leur nom. Tu produis `plans/<nom>/` au format décrit dans `${CLAUDE_SKILL_DIR}/format.md` : lis-le en entier avant d'écrire quoi que ce soit.

plan-lint, dans ce plugin : `node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs`.

Ce skill tourne sur opus (champ `model`), qui choisit aussi le modèle de chaque tâche. Ce réglage ne vaut que pour le tour en cours : pose toutes tes questions avec l'outil de question, qui garde le tour. Une réponse tapée dans le prompt rendrait la main au modèle de la session.

Entrée : `$ARGUMENTS`. Un chemin qui existe (fichier ou dossier) : **conversion** de ce plan. Sinon : **objectif** d'un nouveau plan. Rien : demande lequel des deux.

## 0. Préalables

- Dépôt git sur sa branche de base (`main`, sauf si l'utilisateur en indique une autre) à jour, sans modification non commitée : sinon, arrête-toi et dis-le.
- Nom du plan : court, en kebab-case, à faire confirmer. Si `plans/<nom>/` existe déjà, arrête-toi et demande.

## 1. Explorer, sans modifier le dépôt

Délègue l'exploration à des subagents et garde seulement leurs conclusions :

- contexte existant : `CLAUDE.md`, `AGENTS.md`, `.claude/rules/`, skills du projet ou de l'organisation, README, manifestes et CI ;
- zones du code que l'objectif touche, modèle de données et migrations ;
- ce que les tests partagent (base locale, port, service) et les données réelles présentes sur la machine (dumps, copies de prod), repérés par la configuration et les noms de fichiers : aucune tâche n'y touchera ;
- commandes d'installation, de lint, de build et de test.

Puis la référence des tests : lance-les une fois et note les échecs déjà présents, seulement s'ils n'écrivent dans aucune base partagée (comme la base de dev) et ne lisent aucune donnée réelle. Sinon, ne les lance pas : demande à l'utilisateur de les lancer lui-même avec `!` et d'en coller le bilan.

Résume en une page au plus : ce résumé amorce DISCOVERY.md.

## 2a. Conversion d'un plan existant

Lis le plan source en entier. Garde son découpage, son vocabulaire et ses décisions : tu le traduis, tu ne le réécris pas.

- Une tâche source donne une tâche orchestre. Découpe-la seulement si elle dépasse la moitié d'un contexte ; fusionne une micro-tâche avec sa voisine. Chaque changement de découpage va dans le bilan.
- `phase` et `depend_de` viennent de l'ordre et des liens du plan source. Ce qu'il ne dit pas, tire-le de l'exploration : `fichiers_possedes`, `ressources`, `verification` (commandes réelles, vérifiées à l'étape 1), `definition_du_fini` (critères démontrables par le diff ou par une commande), `modele` et `raison_modele` (voir plus bas), `effort` selon la difficulté.
- Modèle : un `haiku`, `sonnet` ou `opus` donné par le plan source est gardé, avec sa raison. Sinon (absent, `fable` ou autre), choisis-le selon les critères ci-dessous et dis-le dans le bilan.
- Le texte de la tâche source va dans « Détail de réalisation », ses exclusions dans « Hors périmètre ».
- Les décisions déjà prises dans le plan source deviennent des entrées `décision · majeur · …` dans HANDOFF.md, sous un titre `## plan source`.
- Les décisions restées ouvertes dans le plan source, et tout ce qui manque (choix produit, périmètre, accès, secret) : n'invente rien, cela se règle à l'étape 3.

## 2b. Nouveau plan

Découpe selon les règles de `format.md`, modèle de chaque tâche compris (critères ci-dessous). Une question qui change le découpage lui-même se pose avant de découper, selon la règle de l'étape 3.

## 2c. Modèle de chaque tâche

Chaque tâche reçoit `modele` et `raison_modele`, une ligne obligatoire qui dit pourquoi ce modèle :

- `haiku` pour le mécanique : renommage, documentation, configuration ;
- `sonnet` par défaut pour implémenter ;
- `opus` pour l'architecture, les tâches ambiguës et celles qui touchent plusieurs modules.

Ne choisis jamais `fable`. La revue globale finale est sur `opus`. Le workflow lance le worker sur ce modèle, tel quel ; après un essai refusé, le replanificateur choisit le modèle de la correction, jamais en dessous de celui-ci.

## 3. Faire trancher, puis inventorier ce qui doit être prêt

Rien de ce qui peut se savoir avant le run ne doit se découvrir pendant.

1. **Décisions.** Liste toutes les décisions ouvertes : celles laissées en suspens par le plan source, et celles que l'exploration fait apparaître (choix produit, périmètre, contrat, technologie, sécurité, données). Pose-les toutes, sans plafond, avec l'outil de question : par lots de 4 questions au plus, une question par décision. Chaque question a 4 options au plus : 3 choix au plus, le recommandé en premier avec son impact, puis « Reporter ». L'outil ajoute de lui-même « Autre », pour une réponse libre.
   - Une décision tranchée devient une entrée `décision · majeur · <ID> : … (tranchée par l'utilisateur)` sous `## plan source` dans HANDOFF.md. Garde l'identifiant du plan source (D5), sinon numérote D1, D2… Si elle change une tâche, écris la tâche en conséquence.
   - Une décision reportée devient une ligne `décision`, statut `ouvert`, de PREREQUIS.md ; les tâches qu'elle touche la citent dans `prerequis` et l'attendront.
2. **Gestes humains.** Tout ce qu'un agent ne fera jamais : un accès (dépôt, service, cloud), un secret ou une clé d'API, un compte ou des crédits payants, des données réelles (dump, copie de prod), un déploiement, une validation par un tiers. Une ligne `geste` par besoin, avec la preuve attendue. Demande à l'utilisateur ceux qui sont déjà faits ; ne lis jamais un secret pour le vérifier.
3. **Environnement.** Les services, outils et données de test dont les vérifications ont besoin (base de test, conteneur, binaire, jeu de données) : une ligne `environnement`, avec une commande sûre comme preuve quand il y en a une.
4. **Fichiers interdits aux agents.** Si une lecture t'est refusée par les réglages (du projet, de l'utilisateur ou de l'organisation), ne contourne jamais l'interdiction. Un modèle versionné (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`) refusé par la règle `Read(./.env.*)` d'une installation d'avant la 0.6.2 relève de `/orchestre:installer`, qui ajoute ses exceptions, et non d'une relecture. Une tâche qui devrait modifier un fichier qui reste interdit ne le possède pas (`fichiers_possedes`) : la modification revient à l'utilisateur avant la PR. Décris-la dans la section « Hors périmètre » de la tâche, et note une entrée `relecture · majeur · <fichier> : <modification attendue>` sous `## plan source` dans HANDOFF.md. Aucune commande de `verification` ne lit un fichier interdit : le vérificateur se la verrait refuser, et elle ne prouverait rien pendant le run. Mets-la dans l'entrée `relecture`, pour que l'utilisateur la lance lui-même avant la PR.
5. Chaque tâche cite dans `prerequis` les identifiants dont elle a besoin, et seulement ceux-là.

## 4. Écrire

Écris `plans/<nom>/` : les tâches dans `taches/`, chacune avec `modele` et `raison_modele`, `SUIVI.md` (toutes les tâches à « à-faire »), `HANDOFF.md`, `PREREQUIS.md` (tableau vide si le plan n'attend rien), `DISCOVERY.md` amorcé avec l'étape 1, `orchestre.config.json` avec `branche_integration: "plan/<nom>"`, la branche de base dans `branche_base`, et la préparation de l'environnement (`preparation`, `preparation_partagee`, voir le format) tirée du dépôt : des commandes simples, à faire valider par l'utilisateur. Termine le plan par une tâche de revue globale sur opus, en lecture seule.

## 5. Valider

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs plans/<nom>` : corrige jusqu'à « plan valide ».
2. Relecture critique par un subagent sceptique : dépendances manquantes, tâches trop grosses ou trop petites, fini flou ou indémontrable, lots parallèles qui se marchent dessus (fichiers ou ressources), ressources oubliées, modèle sans raison ou contraire aux critères, vérification qui toucherait des données réelles ou une base partagée, et surtout ce qu'un agent ne pourra pas faire seul sans que PREREQUIS.md le dise (accès, secret, décision, service). Corrige, puis relance plan-lint.
3. Avec l'accord de l'utilisateur : crée la branche `plan/<nom>` depuis la branche de base et commite uniquement `plans/<nom>/`, avec le message `plan(<nom>) : plan initial`. Relance plan-lint avec `--integration plan/<nom>` (et `--base <branche>` si la base n'est pas `main`).

## 6. Bilan

Rends le tableau de SUIVI.md, puis la raison du modèle de chaque tâche (une ligne par tâche), puis la ligne d'estimation et le bloc « Prêt à lancer » de plan-lint. Liste ensuite les prérequis ouverts, c'est-à-dire ce qu'il reste à faire avant de lancer, avec la première phase que chacun bloque. Ajoute les relectures à prévoir avant la PR. Pour une conversion, ajoute la table de correspondance (tâche ou section du plan source → tâche orchestre) et ce qui a été découpé, fusionné ou ajouté (revue globale comprise). Suite : `/orchestre:installer` si le dépôt n'est pas encore préparé, `/orchestre:pret plans/<nom>` la veille du lancement, puis, dans une session neuve, `/orchestre:lancer plans/<nom>`, avec un premier run en mode « arrêt par phase ».
