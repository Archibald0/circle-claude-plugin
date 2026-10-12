#!/bin/sh
# Creates a toy repository with a one-task plan, to try the orchestre plugin end to end in a few minutes.
# Usage: sh tests/toy-repo.sh <folder-to-create>
# Then: cd <folder> && claude, /orchestre:install, a new session, /orchestre:run plans/demo
set -eu
DIR="${1:?usage: sh tests/toy-repo.sh <folder-to-create>}"
if [ -e "$DIR" ]; then echo "$DIR already exists" >&2; exit 1; fi
mkdir -p "$DIR/plans/demo/tasks" "$DIR/src"
cd "$DIR"
git init -q
git checkout -q -b main 2>/dev/null || true
printf "# Toy repository of the orchestre plugin\n" > README.md
touch src/.gitkeep
cat > 'plans/demo/DISCOVERY.md' <<'END_DISCOVERY_MD'
# DISCOVERY — demo
## Existing context
Toy repository, no tooling.
## Verified commands
- `sh <script>`: runs a shell script. No pre-existing failure.
## Quick map
- `src/`: scripts.
## Observed conventions
## Pitfalls and fixes
## Context recommendations (end of run)
END_DISCOVERY_MD
cat > 'plans/demo/HANDOFF.md' <<'END_HANDOFF_MD'
# HANDOFF — demo
Entries: `deviation`, `blind-spot`, `decision`, `debt`, `needs-human`, `ticket`, `review`, rated `minor` or `major`.
END_HANDOFF_MD
cat > 'plans/demo/PROGRESS.md' <<'END_PROGRESS_MD'
# PROGRESS — demo

| ID  | Title        | Phase | Batch | Depends on | Model | Status | Attempts | Branch | Tokens est. / actual |
|-----|--------------|-------|-------|------------|-------|--------|----------|--------|----------------------|
| T01 | Hello script | 1     | 1A    | —          | haiku | todo   | 0        | —      | 0.2M / —             |

Statuses: todo · added · merged · blocked · failed · needs-human · cancelled
END_PROGRESS_MD
cat > 'plans/demo/orchestre.config.json' <<'END_ORCHESTRE_CONFIG_JSON'
{ "max_parallelism": 1, "default_mode": "phase", "integration_branch": "plan/demo", "evaluator": "always", "max_fixes": 2, "escalation": ["sonnet", "opus"], "fable": false, "max_auto_decisions": 3, "pilot_context_cap": 0.65, "language": "en" }
END_ORCHESTRE_CONFIG_JSON
cat > 'plans/demo/tasks/T01-hello.md' <<'END_T01_HELLO_MD'
---
id: T01
title: Hello script
phase: 1
model: haiku
model_reason: one-line script, mechanical
effort: low
depends_on: []
parallel_batch: 1A
owned_files:
  - src/hello.sh
resources: []
context_budget: 20%
token_estimate: 0.2M
max_turns: 15
verification:
  - "sh src/hello.sh"
  - "test -x src/hello.sh"
definition_of_done:
  - "src/hello.sh prints exactly \"hello\" (output of sh src/hello.sh)"
  - "src/hello.sh is executable (test -x src/hello.sh)"
---

## Launch prompt
You carry out T01 on the branch task/T01. Read DISCOVERY.md first.
Change nothing outside owned_files. Ask no question:
if you are blocked, finish with the status blocked and say why.
Return your report in the requested format: status, changed files,
deviations from the plan, findings useful to the next tasks.

## Useful context
Toy repository used to test the orchestre plugin.

## Implementation notes
Create src/hello.sh (`#!/bin/sh`, then `echo hello`), make it executable (`chmod +x`), commit it.

## Out of scope
Everything else in the repository.
END_T01_HELLO_MD
cat > 'plans/demo/PREREQUISITES.md' <<'END_PREREQUISITES_MD'
# PREREQUISITES — demo

| ID | Type | Prerequisite | Status | Evidence |
|----|------|--------------|--------|----------|

Types: decision · manual · environment. Statuses: open · done · dropped.
END_PREREQUISITES_MD
git add -A
git config user.name >/dev/null 2>&1 || git config user.name "orchestre"
git config user.email >/dev/null 2>&1 || git config user.email "orchestre@localhost"
git commit -qm "toy repository: plan demo"
git switch -qc plan/demo
git switch -q main
echo "Toy repository ready: $DIR (plan plans/demo, branch plan/demo)."
echo "Next: cd \"$DIR\" && claude, then /orchestre:install, a new session, and /orchestre:run plans/demo."
