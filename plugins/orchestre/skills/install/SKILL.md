---
name: install
description: Prepares the current repository for the orchestre plugin (project settings of Claude Code, checked and written by scripts/settings.mjs, .worktreeinclude, formatter exclusions, removal of a manual install or of the settings of an older version). /orchestre:prepare runs it when the settings are missing; to run when the user types /orchestre:install.
argument-hint: "[--team]"
disable-model-invocation: true
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs *)
  - Bash(claude --version)
  - Bash(node --version)
  - Bash(git rev-parse *)
  - Bash(git status *)
  - Bash(git ls-files *)
  - Bash(command -v *)
  - Bash(printenv PATH)
---
# Install orchestre in this repository

You prepare the current repository for `/orchestre:run`. You touch no application code. Before each write, show in a few lines what will change and wait for the user's agreement; same rule for each commit. You never read the content of a `.env`. Short messages, in the language of the conversation.

## 1. Check

Stop and explain what is missing if a point fails.

1. `git rev-parse --show-toplevel`: you are at the root of a git repository.
2. `claude --version`: 2.1.271 or later. `node --version`: 18 or later (plan-lint needs it).
3. Dynamic workflows are available: paid plan; on Pro, the Dynamic workflows line of `/config`.

## 2. Project settings of Claude Code

A plugin cannot set these settings itself: they go into `.claude/settings.local.json`, personal and not versioned. One script holds their model and writes them, `node ${CLAUDE_PLUGIN_ROOT}/scripts/settings.mjs` (below, `settings.mjs`), the same one `/orchestre:prepare`, `/orchestre:ready` and `/orchestre:run` run: never edit a settings file by hand.

1. `settings.mjs check` (plus `--team` if given): it compares the settings Claude Code merges (local, project, user) with the model, rule by rule, and lists what it would write, one line each. The model: `worktree.baseRef: "head"` (the worktrees of parallel tasks start from the plan's integration branch); in `allow`, the workflow `orchestre:run-phase`, the rules of the plugin's scripts for this version (the workflow's agents run the progress and the worktree cleanup themselves: without these rules, each would ask for permission, and the run would be suspended), the agents' git commands, `date` and `test -e`; in `deny`, `git push` and reading `.env` and `.env.*`, at every depth, except the versioned templates (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`), which the agents must be able to read and change. It also lists the rules of an older install, to remove: another version of the plugin, orchestre 0.11 and earlier, the manual install of v0.5. Exit code 2: a settings file is not valid JSON; show the error and stop, the user fixes the file. Its warnings (`⚠`) block nothing: copy them; a rule that comes from the user or organization settings cannot be changed from here.
2. Deployment tool: spot the project's one (config files, `package.json` scripts, CI: railway, vercel, fly, heroku, netlify, kubectl, terraform…) and have the user confirm it: rule `Bash(<tool> *)` in `deny`. Deployment stays a human action.
3. Project commands: spot the installation, test, lint, typecheck and build commands (`package.json`, `Makefile`, `composer.json`, `pyproject.toml`, CI…) and, if there are already plans, the `verification` commands of `plans/*/tasks/*.md` (and of `plans/*/taches/*.md`, a plan of orchestre 0.11 not migrated yet: `/orchestre:ready` or `/orchestre:run` will offer its migration). Offer to allow them, so that the agents do not stop on a permission request: one precise rule per command (`Bash(pnpm test *)`), never `Bash(*)` nor a whole package manager (`Bash(npm *)`). Keep those the user accepts, for `allow`.
4. Tools in the agents' shell: for each tool that the project commands spotted at point 3 launch (`node`, `pnpm`, `php`, `composer`, `python`, `go`…), `command -v <tool>`. If one is not found, the agents would prefix each command with `export PATH=…`, and Claude Code's isolation guard of the worktrees refuses a command composed that way. Find its folder (ask the user if it is not obvious: `~/.local/<tool>/bin`, `~/.nvm/versions/node/<version>/bin`, `/opt/homebrew/bin`, `~/.volta/bin`…), then offer the key `env.PATH`: `<folder>:<current value of printenv PATH>`, written in full (variables are not expanded there).
5. Write: the rules of points 2 to 4 go to the script as `--add '{"allow":[…],"deny":[…],"env":{"PATH":"…"}}'` (keys left out when empty; no apostrophe, or written `\u0027`). Show in one block what `settings.mjs check --add '<json>'` lists, then, after agreement, run `settings.mjs apply` with the same arguments (`--add`, `--team`) and copy its first line. It writes `.claude/settings.local.json` only (and `.claude/settings.json` with `--team`), keeps every other key and rule, and excludes from git, through `.git/info/exclude`, a local file that git neither ignores nor tracks. Exit code 3: the Bash sandbox refuses writes to the settings files of Claude Code; give the user the same command to run with `!`, then run `settings.mjs check` again.

Advice to give in one line: the pilot ran in auto permission mode; in manual mode, any command not allowed suspends the run until the user answers.

## 3. Worktrees

Tasks that run in parallel work in worktrees. If the tests need unversioned files (`.env`, `.env.local`, `.env.test`…), create or complete `.worktreeinclude` at the root, one path per line, with those that exist: Claude Code copies them into each worktree. List the names only, without reading the files.

## 4. Formatter and linter

If the project has a formatter or a linter (Prettier, Biome, ESLint, Ruff, PHP-CS-Fixer…), have `plans/` and `.claude/` excluded: the scribe writes into `plans/`, and a verification that read these folders would fail on files no task owns. Show the change, then commit it only if the user accepts, on the current branch, with the message `chore: exclude plans/ and .claude/ from the formatter and linter`.

## 5. Old manual install

Before the plugin, the orchestrator was copied into `.claude/` (up to v0.5, under French names). Look for:

- `.claude/skills/lancer/`, `.claude/workflows/executer-phase.js`, `.claude/orchestre/`;
- in `.claude/agents/`: `evaluateur.md`, `integrateur.md`, `lecteur-plan.md`, `replanificateur.md`, `scribe.md`, `verificateur.md`, `worker.md`, `worker-isole.md`.

Only keep a file if it really is the orchestrator: its description (for `skills/lancer/`, its `SKILL.md`) speaks of a "plan orchestre" or of the workflow `executer-phase`.

If there are some: explain that they duplicate the plugin (the project's `/lancer` command would launch the old version), list them, and offer to remove them. With the user's explicit agreement: `git rm -r` for tracked files (`git ls-files`), plain deletion for the others, then a commit on the current branch with the message `chore: remove the manual install of the orchestrator (replaced by the orchestre plugin)`. Its rules in `.claude/settings.local.json` (`Workflow(executer-phase)`, `Bash(node .claude/orchestre/plan-lint.mjs:*)`) are removed by `settings.mjs` (section 2). Touch nothing else in `.claude/`. A plan in progress, between two runs, does not prevent this removal: plans stay in `plans/`. Never during a run: have the user confirm that no run of the orchestrator is active (`/workflows`), otherwise stop.

## 6. Sharing with the team (only with `--team`)

So that the people who open this repository are offered the plugin, `settings.mjs` with `--team` also declares, in `.claude/settings.json` (versioned), the marketplace `circle` (`extraKnownMarketplaces`, the GitHub repository of the plugin) and the plugin (`enabledPlugins`), keeping the rest of the file; the permission rules stay in the personal file. This write goes with those of section 2: show the result, then commit `.claude/settings.json` with the user's agreement. Warn that everyone needs read access to the private GitHub repository; at their first `/orchestre:prepare`, the plugin offers each of them their own settings (or `/orchestre:install`).

## 7. Summary

Sum up in a few lines what was written and what remains to do (a commit). For each plan, the environment setup (`setup`, `shared_setup` in `orchestre.config.json`) is settled with `/orchestre:ready`, and so is the migration of a plan of orchestre 0.11. Then what comes next: a new session (Claude Code reloads the permission rules during the session, but its documentation does not say so of `worktree.baseRef`), `/orchestre:prepare` to write or convert a plan, `/orchestre:ready plans/<name>` the day before to check that everything is ready, `/orchestre:run plans/<name>` to execute it, `/orchestre:status` to follow the progress, even during a run.
