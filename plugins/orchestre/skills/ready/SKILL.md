---
name: ready
description: Checks that an orchestre plan is ready to run, without executing any task — environment, migration of a plan of orchestre 0.11, prerequisites of PREREQUISITES.md (decisions to settle on the spot, manual actions), dry run of the safe verifications — and gives a verdict phase by phase. To run the day before, when the user types /orchestre:ready.
argument-hint: <plan-dir> [--no-dry-run]
disable-model-invocation: true
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs *)
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs *)
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/migrate.mjs *)
  - Bash(claude --version)
  - Bash(node --version)
  - Bash(date *)
  - Bash(git status *)
  - Bash(git rev-parse *)
  - Bash(git log *)
  - Bash(git ls-files *)
  - Bash(git check-ignore *)
  - Bash(git branch --list *)
---
# Ready to run?

You check that the plan `$ARGUMENTS` can run without stopping on what could be settled beforehand. You execute no task of the plan and you change no application code. You only write in the plan folder (PREREQUISITES.md, HANDOFF.md, DISCOVERY.md, `orchestre.config.json`, and the tasks not started yet for an amendment), after agreement, apart from the migration of a plan of orchestre 0.11 (1.4), which `migrate.mjs` writes and commits. You never read the content of a `.env`, of a dump or of a copy of real data. Short messages.

Language: until you know the plan's language, and for a plan of orchestre 0.11 not migrated yet, talk to the user in the language of the conversation. From then on, talk to the user, and write the free text you add to the plan (HANDOFF descriptions, Prerequisite and Evidence cells, DISCOVERY content, verdict), in the plan's language: `language` of `orchestre.config.json`, `"en"` when absent, `"fr"` for a plan migrated from orchestre 0.11. Keys, values, section titles and commit messages stay in English.

Never during a run of the orchestrator: first have the user confirm that no run is active (`/workflows`), otherwise stop. The dry run and the commits happen in the main checkout, where the agents work.

plan-lint, in this plugin: `node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs`.

## 1. Environment

Note each point without stopping, except where it says so: they go to the verdict.

1. `claude --version`: 2.1.271 or later. `node --version`: 18 or later. The agents `orchestre:*` are among the available agent types.
2. Settings: `worktree.baseRef: "head"`, `autoContinueAtUsageLimit`, `git push` and the deployment tool denied, `Workflow(orchestre:run-phase)` and the rules `Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs *)`, `Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/progress.mjs *)` and `Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs *)` in `allow`, tools of the verifications found in the agents' shell (`command -v`, otherwise the `env` key). Settings of orchestre 0.11 (`Workflow(orchestre:executer-phase)`, `Bash(node <plugin path>/scripts/suivi.mjs *)`): the run would ask for permission at each progress command. What is missing or outdated is for `/orchestre:install`.
3. `orchestre.config.json`: integration branch (`integration_branch`; `branche_integration` in a plan of orchestre 0.11) and base branch (`base_branch`, `branche_base` in 0.11; `main` by default). Git: no uncommitted change on tracked files; the integration branch exists and the plan folder is committed on it. Switch to it now: the plan only exists there. `.worktreeinclude` lists the `.env` if there are any.
4. Plan format: `node ${CLAUDE_PLUGIN_ROOT}/scripts/migrate.mjs <plan>`, from the main checkout, on the integration branch. If the integration branch does not exist yet, do not migrate: say that `/orchestre:run` creates it from the base branch and then offers the migration, and stop the check here. Without option, the script only reads: if it answers "already in the 0.12 format, nothing to migrate", go on. Otherwise the plan, or part of it, is still in the French format of orchestre 0.11 or earlier (`<plan>/taches/`, or `SUIVI.md`, `PREREQUIS.md`, `suivi.json` or French keys left next to `<plan>/tasks/` by another clone), which the scripts of this version refuse:
   - Show its summary of the changes and say in one line that keys, values, file names and section titles move to English, that the free text stays as written and the plan gets `"language": "fr"`, and that the git history of 0.11 (branches `tache/*`, commits "tâche <id> : ") is not rewritten.
   - After agreement, run it again with `--write`: it migrates and commits the plan folder alone (`orchestre: migrate plan <name> to the 0.12 format`); copy its last lines. If it refuses because `suivi.json` marks a run "en-cours": the user confirmed at the start that no run is active, so run it again with `--write --run-stopped`, and say so in one line. Any other refusal or error, or a commit refused by a hook (code 1, files migrated and staged): show the message and stop.
   - If the user declines: stop here, the plan cannot be checked in that format.
   - Then `git branch --list "tache/*" --no-merged <integration branch>`, keeping the plan's task ids: these tasks were started in 0.11 and not merged. Say in one line that they will not be taken back: they start again from the integration branch on `task/<id>`, and the old branch stays in git, for reference.
5. Untracked folders (`git status --porcelain`) that a formatter or a linter run on the whole repository would read in the main checkout: report them; their exclusion is for `/orchestre:install`. Worktrees of earlier attempts: `node ${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs clean <plan> --dry-run`, which touches nothing; those with changes wait for the user (commit or discard), the others will be removed by `/orchestre:run`.
6. Environment setup, in the plan's `orchestre.config.json`:
   - `setup`: the commands that bring a working folder up to date after a branch change or a merge, without touching a shared service: installation of the dependencies from the lockfile, code generation (ORM clients, protobuf, types…). Each worker runs them at start, in its worktree; the integrator, after each merge, before the check.
   - `shared_setup`: `{ "<resource>": [commands] }`, for a service shared by every working folder (test database, container). They only run for a task that declares that resource in `resources`, hence never two at a time.
   If they are missing, prepare a proposal from the repository (package manager scripts, Makefile, CI, README, DISCOVERY.md): simple commands, without `&&`, `;`, `|` or `export`. Have it validated with the prerequisites (section 2), write it after agreement, then run each command once to check that it passes, with the rules of the dry run (section 3): safe commands only, `git status` before and after. Also report the tasks whose verification touches a shared service without declaring its resource.
7. Permission mode: in manual mode, a verification command that is not allowed will stop the run on a permission request. List those that are not allowed.
8. Files forbidden to the agents: among the files the remaining tasks cite, spot those whose reading the settings refuse you. Never get around the ban. A versioned template (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`) refused while `.claude/settings.local.json` has `Read(./.env.*)` without its exceptions comes from an install from before orchestre 0.6.2: offer `/orchestre:install`, which adds them, rather than a review. The others will go to review by the user before the PR: check that a `review` entry of HANDOFF.md announces them, otherwise offer it. A `verification` command that reads one would be refused to the verifier and would prove nothing during the run: offer to remove it from the task and to note it in that entry, so that the user runs it themselves before the PR.

## 2. Prerequisites

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs <plan> --json --integration <branch>`, plus `--base <base_branch>` if the config gives one: `errors`, `warnings`, `prerequisites`, `ready`, `language`. Say the plan's `language` in one line (the language of its free text). A compound verification command (warning) will be refused to an agent isolated in a worktree: offer to rewrite it as simple commands, or to make it a script of the project owned by the task (or by a tooling task), and write the amendment after agreement.
2. Models: for each remaining task, the model and its reason (`model`, `model_reason` in plan-lint's tasks), one line per task. Report the tasks without a model, which plan-lint warns about: their worker will run on sonnet, and their fixes will follow the config's `escalation` ladder, without a choice by the replanner. Also report those with a model and no reason. Do not judge the choices, unless the user asks. A model to add or to change goes into the task's frontmatter, after agreement, like an amendment.
   - Fable: show the `fable` setting of `orchestre.config.json` (field `fable` of plan-lint's JSON). If it is missing while a remaining task is on `fable` or `escalation` contains it (plan-lint warns about it), ask the question of `/orchestre:prepare`: "Use fable for this plan?", "No (recommended)" (costs more, with no gain observed over opus so far) or "Yes". Write the answer in `orchestre.config.json` after agreement. On "No", or with `"fable": false` already written (plan-lint makes it an error), offer to move these tasks to `opus` (reason updated) and to remove fable from `escalation`, and write it after agreement.
3. No PREREQUISITES.md (plan written before orchestre 0.6.1): build it. Look in HANDOFF.md (entries `needs-human`, decisions announced but not taken), in the remaining tasks (decisions cited as to settle, accesses, secrets, external services, real data) and in the source plan if there is one. For each task, tell a real dependency from a mere mention of context. Offer the rows of the table and the `prerequisites` to add to the tasks, write them after agreement, then run plan-lint again.
4. Open decisions: offer to settle them now, with the question tool, in batches of 4 questions at most. Each question has 4 options at most: 3 choices at most, the recommended one first with its impact, then "Defer". The tool adds "Other" on its own. For each settled decision:
   - entry `decision · major · <ID>: … (settled by the user)` under `## source plan` in HANDOFF.md;
   - status `done` and evidence "HANDOFF" in PREREQUISITES.md;
   - if it changes a task not started yet, show the amendment and write it after agreement.
5. Open manual actions: say exactly what the user must do, with the prefix `!` for a command that touches a secret, real data or production. When they confirm it is done: status `done`, evidence "confirmed by the user on <date>" (`date +%F`), in the plan's language.
6. Open environment: if the evidence is a safe command (see the dry run), run it; otherwise, ask.
7. Run plan-lint again after each write.

## 3. Dry run (unless `--no-dry-run`)

Replay on the integration branch, once each, the `verification` commands of the remaining tasks of the next phase to run; of all the phases if the user asks.

- Only safe commands: no reading of real data, no write into a shared database (a test database the script recreates is allowed), no paid call (model API, billed service) nor call to an external service, no deployment, no rewriting of tracked files (a formatter without its check mode, a `--fix` option, a build that regenerates a versioned file), no stopping of a process (a command that frees a port by killing what holds it). When in doubt, do not run it and offer the user to run it themselves with `!`.
- Note `git status --porcelain` before the dry run and compare it after: if files changed or appeared, show them and offer to restore them, after agreement. Otherwise, the pre-flight of `/orchestre:run` will fail.
- A command about a file a remaining task must create (in its `owned_files`, absent from the repository): do not run it, note "created by <id>".
- One command at a time, without a pipe, to read the exit code (add `; echo "code=$?"`), 10 minutes at most each.
- Class each failure: tool or service missing, permission refused, failure already present before the plan, or other. "Already present before the plan" only if no task is merged yet, or if the command also fails on the base branch: check it in a temporary worktree (`git worktree add --detach <temporary folder> <base_branch>`, then `git worktree remove` on that folder). Offer to add those failures, and only them, to "Verified commands" in DISCOVERY.md: the evaluator will not count them against the tasks.

## 4. Verdict

1. The verdict, phase by phase: `ready`, or what it waits for (open prerequisites, end of an earlier phase, dry-run failure to settle), with the model of each task and its reason, and the tasks without a model. Recall the plan's `language`. Give plan-lint's token estimate, recalling that the actual figure was 3 to 8 times higher on the pilot (measured with `/usage`).
2. What remains to do, in order, and who does it.
3. Add at the end of PREREQUISITES.md the line "Checked by /orchestre:ready on <date>: <one-line verdict>" (`date +%F`; the verdict in the plan's language). With the user's agreement, commit the changed plan files on the integration branch (switch to it if needed), with the message `ready(<name>): <short verdict>`, the short verdict in English.
4. If the next phase is ready: `/orchestre:run plans/<name>` in a new session.
