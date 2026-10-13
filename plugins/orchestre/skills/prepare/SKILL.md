---
name: prepare
description: Writes a plan that /orchestre:run can execute (folder plans/<name>/) — converts a plan already written or drafts a new one from a goal —, has every decision settled, lists what must be ready (PREREQUISITES.md), then validates it with plan-lint. Installs orchestre in the repository first when its settings are missing. Use when the user types /orchestre:prepare or asks to prepare, write or convert a plan for the orchestrator.
argument-hint: "<existing plan (file or folder) | goal of the plan>"
model: opus
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs *)
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs *)
  - Bash(git status *)
  - Bash(git rev-parse *)
  - Bash(git ls-files *)
  - Bash(claude --version)
  - Bash(node --version)
  - Bash(command -v *)
  - Bash(printenv PATH)
---
# Prepare an orchestre plan

Role: planner. You change no application code. You never open a `.env`, a dump or a copy of real data: you spot them by their name. You produce `plans/<name>/` in the format described in `${CLAUDE_SKILL_DIR}/format.md`: read it in full before writing anything.

plan-lint, in this plugin: `node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs`.

This skill runs on opus (field `model`), which also chooses the model of each task. That setting only holds for the current turn: ask all your questions with the question tool, which keeps the turn. An answer typed in the prompt would hand back to the session's model.

Talk to the user in the language of the conversation; the questions and options quoted below are given in English, ask them in that language.

Input: `$ARGUMENTS`. A path that exists (file or folder): **conversion** of that plan. Otherwise: **goal** of a new plan. Nothing: ask which of the two.

A folder `plans/<name>/` already written for orchestre is not a plan to convert: in the format of orchestre 0.11 or earlier (`taches/`, `SUIVI.md`), say that `/orchestre:ready plans/<name>` migrates it to the 0.12 format, and stop; in the 0.12 format (`tasks/`), say it is already a plan, ready for `/orchestre:ready`, and stop.

## 0. Prerequisites

- A git repository on its base branch (`main`, unless the user names another), up to date, without uncommitted changes: otherwise, stop and say so.
- Install of orchestre in this repository: `node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs check` (below, `settings.mjs`), from the root of the repository. It compares the settings of Claude Code with the model of `/orchestre:install`, rule by rule.
  - "settings complete": go on without a word; a warning (`⚠`) in one line each.
  - "settings missing": orchestre was never installed here. Read `${CLAUDE_PLUGIN_ROOT}/skills/install/SKILL.md` and do its sections 1 to 5, as `/orchestre:install` without `--team`, on this base branch: each agreement with the question tool ("Yes (recommended)", "No"), its summary (section 7) in two lines at most. Then go on.
  - "settings incomplete" (an older install, or the plugin updated since): show its lines, then ask with the question tool "Write these settings into .claude/settings.local.json?", "Yes (recommended)" or "No". On "Yes": `settings.mjs apply`; copy its first line. Exit code 3: the Bash sandbox refuses writes to the settings files; give the user the command to run with `!` (`node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs apply`), then run `settings.mjs check` again.
  - Exit code 2: a settings file is not valid JSON; show the error, and offer to go on once the user has fixed it (run `settings.mjs check` again), or to go on without the install.
  - The user declines the install or the write: go on preparing the plan. Say in one line that `/orchestre:ready` and `/orchestre:run` will stop until `/orchestre:install` has written the settings, and repeat it in the summary (step 6).
- Name of the plan: short, in kebab-case, to have confirmed. If `plans/<name>/` already exists, stop and ask.
- Language of the plan's free text (`language`, see "Language" in `format.md`), with the question tool: "Language of the plan?", with two options: the language of the conversation first, recommended, then English; when the conversation is in English, the second option is the language of the source plan for a conversion, French otherwise. The tool adds "Other" on its own. Note it as a short code (`fr`, `en`, `es`…). From here on, you write the free text of the plan in that language: task titles, launch prompts and body sections, criteria of `definition_of_done`, `model_reason`, HANDOFF descriptions, Prerequisite and Evidence cells, DISCOVERY content. Keys, values, section titles, table headers and legends, commands and commit messages stay in English.

## 1. Explore, without changing the repository

Delegate the exploration to subagents and keep only their conclusions:

- existing context: `CLAUDE.md`, `AGENTS.md`, `.claude/rules/`, skills of the project or of the organization, README, manifests and CI;
- areas of the code the goal touches, data model and migrations;
- what the tests share (local database, port, service) and the real data present on the machine (dumps, production copies), spotted by the configuration and the file names: no task will touch them;
- installation, lint, build and test commands.

Then the baseline of the tests: run them once and note the failures already present, only if they write into no shared database (such as the development database) and read no real data. Otherwise, do not run them: ask the user to run them themselves with `!` and to paste the outcome.

Sum up in one page at most: that summary seeds DISCOVERY.md.

## 2a. Conversion of an existing plan

Read the source plan in full. Keep its splitting, its vocabulary and its decisions: you convert it into this format, you do not rewrite it. If the plan's `language` differs from the source plan's, translate its free text and keep its terms.

- A source task gives one orchestre task. Split it only if it exceeds half a context; merge a micro-task with its neighbor. Each change of splitting goes into the summary.
- `phase` and `depends_on` come from the order and the links of the source plan. What it does not say, take from the exploration: `owned_files`, `resources`, `verification` (real commands, checked at step 1), `definition_of_done` (criteria demonstrable by the diff or by a command), `model` and `model_reason` (see below), `effort` according to the difficulty.
- Model: a `haiku`, `sonnet` or `opus` given by the source plan is kept, with its reason. Otherwise (absent, `fable` or other), choose it with the criteria below and say so in the summary. A task the source plan put on `fable` will be offered checked at the fable question (2d).
- The text of the source task goes into "Implementation notes", its exclusions into "Out of scope".
- The decisions already taken in the source plan become entries `decision · major · …` in HANDOFF.md, under a heading `## source plan`.
- The decisions left open in the source plan, and everything missing (product choice, scope, access, secret): invent nothing, it is settled at step 3.

## 2b. New plan

Split along the rules of `format.md`, model of each task included (criteria below). A question that changes the splitting itself is asked before splitting, along the rule of step 3.

## 2c. Model of each task

Each task gets `model` and `model_reason`, a required line that says why this model:

- `haiku` for mechanical work: renaming, documentation, configuration;
- `sonnet` by default to implement;
- `opus` for architecture, ambiguous tasks and those that touch several modules.

Never choose `fable` on your own: only on the tasks the user designates (2d). The final global review is on `opus`. The workflow launches the worker on this model, as is; after a rejected attempt, the replanner chooses the model of the fix, never below this one.

## 2d. Fable

Once the models are chosen, ask with the question tool: "Use fable for this plan?", with two options, in this order:

- "No (recommended)": fable costs more, with no gain observed over opus so far; the hardest tasks stay on opus;
- "Yes, on the tasks I choose".

On "No": `"fable": false` in `orchestre.config.json`, and no task on `fable`. On "Yes": `"fable": true`, then offer the tasks you put on `opus` (global review included), with multiple-choice questions of 4 tasks at most, with the title and the reason of each. Those the user checks move to `fable`, with the reason "fable at the user's request, instead of opus: <reason for opus>", in the plan's language. The others stay on `opus`. Never put `fable` in `escalation`.

## 3. Have everything settled, then list what must be ready

Nothing that can be known before the run must be discovered during it.

1. **Decisions.** List every open decision: those left pending by the source plan, and those the exploration brings up (product choice, scope, contract, technology, security, data). Ask them all, without a cap, with the question tool: in batches of 4 questions at most, one question per decision. Each question has 4 options at most: 3 choices at most, the recommended one first with its impact, then "Defer". The tool adds "Other" on its own, for a free answer.
   - A settled decision becomes an entry `decision · major · <ID>: … (settled by the user)` under `## source plan` in HANDOFF.md, the description in the plan's language. Keep the id of the source plan (D5), otherwise number D1, D2… If it changes a task, write the task accordingly.
   - A deferred decision becomes a `decision` row, status `open`, of PREREQUISITES.md; the tasks it affects cite it in `prerequisites` and will wait for it.
2. **Manual actions.** Everything an agent will never do: an access (repository, service, cloud), a secret or an API key, an account or paid credits, real data (dump, production copy), a deployment, a validation by a third party. One `manual` row per need, with the expected evidence. Ask the user which are already done; never read a secret to check it.
3. **Environment.** The services, tools and test data the verifications need (test database, container, binary, dataset): an `environment` row, with a safe command as evidence when there is one.
4. **Files forbidden to the agents.** If a read is refused to you by the settings (of the project, of the user or of the organization), never get around the ban. A versioned template (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`) refused by the rule `Read(./.env.*)` of an install from before orchestre 0.6.2 is for `/orchestre:install`, which adds its exceptions, not for a review. A task that would have to change a file that stays forbidden does not own it (`owned_files`): the change is the user's, before the PR. Describe it in the "Out of scope" section of the task, and note an entry `review · major · <file>: <expected change>` under `## source plan` in HANDOFF.md. No `verification` command reads a forbidden file: the verifier would see it refused, and it would prove nothing during the run. Put it in the `review` entry, so that the user runs it themselves before the PR.
5. Each task cites in `prerequisites` the ids it needs, and only those.

## 4. Write

Write `plans/<name>/`: the tasks in `tasks/`, each with `model` and `model_reason`; `PROGRESS.md` (every task at `todo`); `HANDOFF.md`; `PREREQUISITES.md` (empty table if the plan expects nothing); `DISCOVERY.md` seeded with step 1; `orchestre.config.json` with `integration_branch: "plan/<name>"`, the base branch in `base_branch`, `language` (step 0), `fable` (2d), and the environment setup (`setup`, `shared_setup`, see the format) taken from the repository: simple commands, to have validated by the user. End the plan with a global review task on opus, read-only.

## 5. Validate

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs plans/<name>`: fix until "valid plan".
2. Critical review by a skeptical subagent: missing dependencies, tasks too big or too small, vague or undemonstrable done criteria, parallel batches that step on each other (files or resources), forgotten resources, model without a reason or against the criteria, verification that would touch real data or a shared database, free text not in the plan's language, and above all what an agent will not be able to do alone without PREREQUISITES.md saying so (access, secret, decision, service). Fix, then run plan-lint again.
3. With the user's agreement: create the branch `plan/<name>` from the base branch and commit only `plans/<name>/`, with the message `plan(<name>): initial plan`. Run plan-lint again with `--integration plan/<name>` (and `--base <branch>` if the base is not `main`).

## 6. Summary

Give the table of PROGRESS.md, then the reason for each task's model (one line per task), the `fable` setting and the `language` of the plan, then the estimate line and the "Ready to run" block of plan-lint. List next the open prerequisites, that is what remains to do before launching, with the first phase each one blocks. Add the reviews to plan before the PR. For a conversion, add the correspondence table (task or section of the source plan → orchestre task) and what was split, merged or added (global review included). Next: `/orchestre:install` if the settings were declined at step 0, `/orchestre:ready plans/<name>` the day before the launch, then, in a new session, `/orchestre:run plans/<name>`, with a first run in "stop at each phase" mode.
