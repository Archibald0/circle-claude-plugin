# orchestre configuration

What orchestre writes into a repository, how to share it with a team, and where the settings of a plan live. Back to the [README](../README.md) · [`reference.md`](reference.md).

## Repository settings

A plugin cannot set the settings the orchestrator needs. `/orchestre:install` writes them into the project, showing each change before making it; `/orchestre:prepare` runs it on its own when the settings are missing.

The settings rules have one model and one check, in a script: `scripts/settings.mjs`. `/orchestre:prepare`, `/orchestre:ready` and `/orchestre:run` run it too. It compares the settings Claude Code merges (personal, project, user) with the model, rule by rule, and writes only what is missing.

What `/orchestre:install` writes:

- **`.claude/settings.local.json`** (personal, not versioned), through `settings.mjs`. When git does not ignore that file yet, the script excludes it from git through `.git/info/exclude`. It holds:
  - `worktree.baseRef: "head"`: the worktrees start from the integration branch;
  - permissions for the workflow `orchestre:run-phase`, the plugin's scripts (`plan-lint`, progress, worktree cleanup), the agents' git commands and, if you accept them, the project's test and build commands;
  - denials: `git push`, the project's deployment tool, and reading `.env` and `.env.*` at the root of the repository. The versioned templates (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`) are excepted: the agents read and change them;
  - `env.PATH`, if the project's tools (node, pnpm, php…) cannot be found in the agents' shell. Without it, the agents would prefix their commands with `export PATH=…`, which the isolation guard of the worktrees refuses.
- **`.worktreeinclude`**: the unversioned files (`.env`…) to copy into the worktrees of parallel tasks.
- **Formatter and linter exclusions** of `plans/` and `.claude/`, committed after your agreement.

It also removes an old manual install of the orchestrator (v0.5 and earlier): its files after your agreement, its settings rules through `settings.mjs`, which also removes the rules of an older version of the plugin.

**Usage limits.** A run paused on a usage limit starts again on its own through `autoContinueAtUsageLimit`. It is a setting of the user, on by default in an interactive session signed in with a claude.ai subscription (in `/config`). The plugin does not write it; the check warns if your user settings turn it off.

**Permission mode.** The pilot ran in auto permission mode. In manual mode, any command that is not allowed suspends the run until you answer.

Limits of these settings (managed settings, Bash sandbox, `.env` in subfolders): [Known limits](reference.md#known-limits).

## Sharing with a team

`/orchestre:install --team` declares the marketplace and the plugin in `.claude/settings.json` (versioned). The people who open the repository are offered the plugin after accepting the trust of the folder.

- Each of them needs read access to this GitHub repository: [Access to the repository](reference.md#access-to-the-repository).
- Their first `/orchestre:prepare` offers their own settings, or `/orchestre:install` writes them.
- The permission rules stay in each person's `.claude/settings.local.json`. The paths of the scripts differ from one machine to the next, and a denial of `git push` in the versioned file would hold for the whole team.

## Plan settings: `orchestre.config.json`

Each plan has its own `plans/<name>/orchestre.config.json`, written by `/orchestre:prepare`. It holds the integration and base branches, the default mode, the parallelism, the fixes and their model ladder, the fable setting, the cap on auto-decisions, the context cap of the pilot session, the language of the plan, and the environment setup (`setup`, `shared_setup`). `/orchestre:ready` proposes the setup when it is missing.

Every key, with an example and its default where there is one: [`format.md`, `orchestre.config.json`](../plugins/orchestre/skills/prepare/format.md#orchestreconfigjson). The same file describes the rest of a plan: tasks, `PROGRESS.md`, `PREREQUISITES.md`, `HANDOFF.md` and `DISCOVERY.md`.
