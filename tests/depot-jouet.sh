#!/bin/sh
# Crée un dépôt jouet avec un plan d'une tâche, pour essayer le plugin orchestre de bout en bout en quelques minutes.
# Usage : sh tests/depot-jouet.sh <dossier-à-créer>
# Puis : cd <dossier> && claude, /orchestre:installer, session neuve, /orchestre:lancer plans/demo
set -eu
D="${1:?usage : sh tests/depot-jouet.sh <dossier-à-créer>}"
if [ -e "$D" ]; then echo "$D existe déjà" >&2; exit 1; fi
mkdir -p "$D/plans/demo/taches" "$D/src"
cd "$D"
git init -q
git checkout -q -b main 2>/dev/null || true
printf "# Dépôt jouet du plugin orchestre\n" > README.md
touch src/.gitkeep
cat > 'plans/demo/DISCOVERY.md' <<'FIN_DISCOVERY_MD'
# DISCOVERY — demo
## Contexte existant
Dépôt jouet, aucun outillage.
## Commandes vérifiées
- `sh <script>` : lance un script shell. Aucun échec préexistant.
## Carte rapide
- `src/` : scripts.
## Conventions constatées
## Pièges et solutions
## Recommandations de contexte (fin de run)
FIN_DISCOVERY_MD
cat > 'plans/demo/HANDOFF.md' <<'FIN_HANDOFF_MD'
# HANDOFF — demo
Entrées : `écart`, `angle-mort`, `décision`, `dette`, `besoin-humain`, `ticket`, classées `mineur` ou `majeur`.
FIN_HANDOFF_MD
cat > 'plans/demo/SUIVI.md' <<'FIN_SUIVI_MD'
| ID  | Titre          | Phase | Lot | Dépend de | Modèle | Statut  | Essais | Branche | Tokens est. / réels |
|-----|----------------|-------|-----|-----------|--------|---------|--------|---------|---------------------|
| T01 | Script bonjour | 1     | 1A  | —         | haiku  | à-faire | 0      | —       | 0,2 M / —           |

Statuts : à-faire · ajoutée · fusionnée · bloquée · échec · besoin-humain · annulée
FIN_SUIVI_MD
cat > 'plans/demo/orchestre.config.json' <<'FIN_ORCHESTRE_CONFIG_JSON'
{ "parallelisme_max": 1, "mode_par_defaut": "phase", "branche_integration": "plan/demo", "evaluateur": "systematique", "corrections_max": 2, "escalade": ["sonnet", "opus"], "decisions_office_max": 3, "plafond_session_pilote": 0.65 }
FIN_ORCHESTRE_CONFIG_JSON
cat > 'plans/demo/taches/T01-bonjour.md' <<'FIN_T01_BONJOUR_MD'
---
id: T01
titre: Script bonjour
phase: 1
modele: haiku
raison_modele: script d'une ligne, mécanique
effort: low
depend_de: []
lot_parallele: 1A
fichiers_possedes:
  - src/bonjour.sh
ressources: []
budget_contexte: 20%
estimation_tokens: 0.2M
max_tours: 15
verification:
  - "sh src/bonjour.sh"
  - "test -x src/bonjour.sh"
definition_du_fini:
  - "src/bonjour.sh affiche exactement « bonjour » (sortie de sh src/bonjour.sh)"
  - "src/bonjour.sh est exécutable (test -x src/bonjour.sh)"
---

## Prompt de lancement
Tu réalises T01 sur la branche tache/T01. Lis d'abord DISCOVERY.md.
Ne modifie rien hors de fichiers_possedes. Ne pose aucune question :
si tu es bloqué, termine avec le statut blocked et explique pourquoi.
Rends ton rapport au format demandé : statut, fichiers modifiés,
écarts au plan, découvertes utiles aux tâches suivantes.

## Contexte utile
Dépôt jouet qui sert à tester le plugin orchestre.

## Détail de réalisation
Crée src/bonjour.sh (`#!/bin/sh`, puis `echo bonjour`), rends-le exécutable (`chmod +x`), commite-le.

## Hors périmètre
Tout le reste du dépôt.
FIN_T01_BONJOUR_MD
cat > 'plans/demo/PREREQUIS.md' <<'FIN_PREREQUIS_MD'
# PREREQUIS — demo

| ID | Type | Prérequis | Statut | Preuve |
|----|------|-----------|--------|--------|
FIN_PREREQUIS_MD
git add -A
git config user.name >/dev/null 2>&1 || git config user.name "orchestre"
git config user.email >/dev/null 2>&1 || git config user.email "orchestre@localhost"
git commit -qm "dépôt jouet : plan demo"
git switch -qc plan/demo
git switch -q main
echo "Dépôt jouet prêt : $D (plan plans/demo, branche plan/demo)."
echo "Suite : cd \"$D\" && claude, puis /orchestre:installer, une session neuve, et /orchestre:lancer plans/demo."
