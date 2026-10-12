---
name: install
description: Prepares the current repository for the orchestre plugin (project settings of Claude Code, .worktreeinclude, formatter exclusions, removal of a manual install or of the settings of an older version). To run once per repository, when the user types /orchestre:install.
argument-hint: "[--team]"
disable-model-invocation: true
allowed-tools:
  - Bash(claude --version)
  - Bash(node --version)
  - Bash(git rev-parse *)
  - Bash(git status *)
  - Bash(git ls-files *)
  - Bash(git check-ignore *)
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

A plugin cannot set these settings itself: they go into `.claude/settings.local.json`, personal and not versioned.

1. Prepare the merge, into that file, of the content of `${CLAUDE_SKILL_DIR}/settings.local.template.json`, without removing anything that exists nor creating a duplicate, with the additions of points 2 to 4; show the result, then write it after agreement:
   - `worktree.baseRef: "head"`: the worktrees of parallel tasks start from the plan's integration branch, not from `main`;
   - `autoContinueAtUsageLimit: true`: a run paused on a usage limit starts again on its own;
   - `allow`: the workflow `orchestre:run-phase`, the git commands of the agents, `date`, `test -e`;
   - `deny`: `git push` and reading `.env` and `.env.*`, at every depth, except the versioned templates (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`), which the agents must be able to read and change. The `Read(!…)` exceptions come right after `Read(./.env.*)`, in the same file: placed before, or in another settings file, they cancel nothing.
   - Install from before orchestre 0.6.2: if `Read(./.env.*)` is already there without these exceptions, add them right after it. If a rule that covers `.env.*` comes from another file (user or organization settings), say so: it cannot be cancelled from here, and the files it covers will go to review before the PR.
2. Add to `allow` the rules of the plugin's scripts for this version: `Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-lint.mjs *)`, `Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/progress.mjs *)` and `Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/worktrees.mjs *)`. The workflow's agents run the progress and the worktree cleanup themselves: without these rules, each would ask for permission, and the run would be suspended. Remove the rules of an older version of the plugin: the same rule with another version number in the path, and, from orchestre 0.11 and earlier, `Workflow(orchestre:executer-phase)` and `Bash(node <plugin path>/scripts/suivi.mjs *)`, replaced by the workflow and progress rules above.
3. Deployment tool: spot the project's one (config files, `package.json` scripts, CI: railway, vercel, fly, heroku, netlify, kubectl, terraform…) and have the user confirm it. Add it to `deny` (`Bash(<tool> *)`): deployment stays a human action.
4. Project commands: spot the installation, test, lint, typecheck and build commands (`package.json`, `Makefile`, `composer.json`, `pyproject.toml`, CI…) and, if there are already plans, the `verification` commands of `plans/*/tasks/*.md` (and of `plans/*/taches/*.md`, a plan of orchestre 0.11 not migrated yet: `/orchestre:ready` or `/orchestre:run` will offer its migration). Offer to allow them, so that the agents do not stop on a permission request: one precise rule per command (`Bash(pnpm test *)`), never `Bash(*)` nor a whole package manager (`Bash(npm *)`). Add those the user accepts.
5. `git check-ignore -q .claude/settings.local.json`: if the file is not ignored, offer to add it to `.gitignore`.
6. Tools in the agents' shell: for each tool that the project commands spotted at point 4 launch (`node`, `pnpm`, `php`, `composer`, `python`, `go`…), `command -v <tool>`. If one is not found, the agents would prefix each command with `export PATH=…`, and Claude Code's isolation guard of the worktrees refuses a command composed that way. Find its folder (ask the user if it is not obvious: `~/.local/<tool>/bin`, `~/.nvm/versions/node/<version>/bin`, `/opt/homebrew/bin`, `~/.volta/bin`…), then offer to add to `.claude/settings.local.json` the key `"env": { "PATH": "<folder>:<current value of printenv PATH>" }`, written in full (variables are not expanded there). Show it and write it after agreement; it will hold for the next sessions.

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

If there are some: explain that they duplicate the plugin (the project's `/lancer` command would launch the old version), list them, and offer to remove them. With the user's explicit agreement: `git rm -r` for tracked files (`git ls-files`), plain deletion for the others, then a commit on the current branch with the message `chore: remove the manual install of the orchestrator (replaced by the orchestre plugin)`. Also remove from `.claude/settings.local.json` the rules of the old install: `Workflow(executer-phase)` and `Bash(node .claude/orchestre/plan-lint.mjs:*)`. Touch nothing else in `.claude/`. A plan in progress, between two runs, does not prevent this removal: plans stay in `plans/`. Never during a run: have the user confirm that no run of the orchestrator is active (`/workflows`), otherwise stop.

## 6. Sharing with the team (only with `--team`)

So that the people who open this repository are offered the plugin, add to `.claude/settings.json` (versioned):

```json
{
  "extraKnownMarketplaces": {
    "circle": { "source": { "source": "github", "repo": "FabienDayuse/circle-claude-plugin" } }
  },
  "enabledPlugins": { "orchestre@circle": true }
}
```

Merge without removing anything, show the result, commit with the user's agreement. Warn that everyone needs read access to the private GitHub repository, and must run `/orchestre:install` for their own settings.

## 7. Summary

Sum up in a few lines what was written and what remains to do (commit, `.gitignore`). For each plan, the environment setup (`setup`, `shared_setup` in `orchestre.config.json`) is settled with `/orchestre:ready`, and so is the migration of a plan of orchestre 0.11. Then what comes next: open a new session so that the settings apply, `/orchestre:prepare` to write or convert a plan, `/orchestre:ready plans/<name>` the day before to check that everything is ready, `/orchestre:run plans/<name>` to execute it, `/orchestre:status` to follow the progress, even during a run.
