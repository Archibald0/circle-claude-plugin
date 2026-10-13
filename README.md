<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/readme-banner-dark.gif">
    <img src="brand/readme-banner-light.gif" width="552" height="128" alt="orchestre logo: a pixel-art music stand whose staff fills up with notes, next to the name orchestre">
  </picture>
</p>

<p align="center">
  <strong>Write the plan. orchestre plays it through.</strong><br>
  A plugin for Claude Code.
</p>

# Circle — Claude Code plugins

Private marketplace of [Claude Code](https://code.claude.com/docs/en/plugins) plugins. It holds one plugin:

| Plugin | Version | Role |
| :- | :- | :- |
| `orchestre` | 0.13.0 | Runs a dev plan split into tasks (`plans/<name>/`, one file per task) from a pilot Claude Code session. Each phase of the plan is a run of the workflow `orchestre:run-phase`: work by subagents, verification, evaluation, fixes, merge into an integration branch, progress. Each task carries its model and the reason for it, chosen by Opus when the plan is prepared; after a rejected attempt, the replanner chooses the model of the fix, never below the task's. The plugin includes a progress mod, read-only on `plans/<name>/progress.json`: an animated banner above the prompt during a run, a suffix to the spinner, `/progress` (a pane in cards: what waits for you, with one action per line, the run, the tasks as timelines, the log; or `/progress text`), a commented `/progress demo`, notifications for what asks for someone, what changed while you were away. |

The orchestration was worked out on a pilot of 15 tasks in 4 phases (SPACE-Platform, plan `acces-par-metier`). Version history: [CHANGELOG.md](CHANGELOG.md). Coming from an earlier version: see [Upgrading from 0.12](#upgrading-from-012) and [Upgrading from 0.11](#upgrading-from-011).

## Requirements

- Claude Code 2.1.271 or later, with dynamic workflows: paid plans; on Pro, the *Dynamic workflows* line of `/config`.
- `git` and Node.js 18 or later on the machine: the plan check (`plan-lint`) and the progress are Node scripts without dependencies.
- Read access to this private GitHub repository, usable without a prompt, since Claude Code clones with the machine's `git`:
  - either a GitHub SSH key loaded in `ssh-agent`;
  - or `gh auth login` then `gh auth setup-git`, and `export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` to clone over HTTPS.

## Install (once per machine)

In a Claude Code session:

```
/plugin marketplace add FabienDayuse/circle-claude-plugin
/plugin install orchestre@circle
/reload-plugins
```

Or from a terminal:

```sh
claude plugin marketplace add FabienDayuse/circle-claude-plugin
claude plugin install orchestre@circle
```

Check: `claude plugin list` shows `orchestre@circle` enabled, and `/orchestre:` offers `install`, `prepare`, `ready`, `run` and `status`.

The progress (banner, `/progress`) is a mod, made of function hooks: it needs Claude Code 2.1.287 or later (`claude --version`), the version from which mods are on by default ([mods documentation](https://code.claude.com/docs/en/plugins/mods/overview)). It draws in the terminal and in the Code tab of the desktop app; in the VS Code extension panel, under `claude -p` and in a cloud session, nothing is drawn. `/plugin` says whether it is loaded: the line under the tabs names the active mods, `orchestre` among them.

## Use

Four commands, in order, and a fifth one to see where a plan stands:

### 1. `/orchestre:install`: prepare the repository

Once per repository, at its root; `/orchestre:prepare` runs it on its own when the settings are missing. A plugin cannot set the settings the orchestrator needs: the command writes them into the project, showing each change before making it. Their model and their check are in one script, `scripts/settings.mjs`, which `/orchestre:prepare`, `/orchestre:ready` and `/orchestre:run` run too: it compares the settings Claude Code merges (personal, project, user) with the model, rule by rule, and writes only what is missing.

- `.claude/settings.local.json` (personal, not versioned; excluded from git through `.git/info/exclude` when git does not ignore it yet): `worktree.baseRef: "head"` (the worktrees start from the integration branch), permissions for the workflow `orchestre:run-phase`, the plugin's scripts (plan-lint, progress, worktree cleanup), the agents' git commands and, if you accept them, the project's test and build commands; `git push`, the project's deployment tool and reading `.env` and `.env.*` at the root of the repository are denied, except the versioned templates (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`), which the agents read and change.
- `.worktreeinclude`: the unversioned files (`.env`…) to copy into the worktrees of parallel tasks.
- Exclusion of `plans/` and `.claude/` from the project's formatter and linter.
- If the project's tools (node, pnpm, php…) cannot be found in the agents' shell, an `env` key (PATH) in `.claude/settings.local.json`: without it, the agents would prefix their commands with `export PATH=…`, which the isolation guard of the worktrees refuses.
- Removal of an old manual install of the orchestrator (v0.5 and earlier), and of the settings rules of an older version of the plugin.

A run paused on a usage limit starts again on its own: `autoContinueAtUsageLimit`, a setting of the user (on by default in an interactive session signed in with a claude.ai subscription, in `/config`), which the plugin does not write; the check warns if your user settings turn it off.

The pilot ran in auto permission mode. In manual mode, any command that is not allowed suspends the run until you answer.

### 2. `/orchestre:prepare`: write or convert a plan

It starts by checking the install: if orchestre was never installed in the repository, it runs `/orchestre:install` (each write and each commit after your agreement); if an older version or an update of the plugin left the settings incomplete, it shows the rules to add or replace and writes them after one agreement. If you decline, the preparation goes on, and `/orchestre:ready` and `/orchestre:run` stop until `/orchestre:install` has run.

- `/orchestre:prepare docs/my-plan.md`: converts a plan already written (file or folder). The splitting, the vocabulary and the decisions of the source plan are kept; what is missing (owned files, verification commands, definition of done) comes from an exploration of the repository. The summary gives a correspondence table, source plan → tasks.
- `/orchestre:prepare add the CSV export of the bookings`: explores the repository, splits and writes a new plan.

It first asks the language of the plan's free text (`language`: task titles, criteria, HANDOFF descriptions…); keys, statuses, section titles and commit messages stay in English. Then every open decision is asked, in batches of 4, without a cap; only those you choose to defer stay open. What an agent will never do (access, secret, paid account, real data) and the environment the verifications need go into `PREREQUISITES.md`, and each task cites what it waits for. Each task gets a model and a line that justifies it (`model`, `model_reason`): haiku for mechanical work (renaming, documentation, configuration), sonnet by default to implement, opus for architecture, ambiguous tasks and those that touch several modules. The skill itself runs on opus (field `model`), for the turn. It asks whether to use fable for this plan ("No" recommended: it costs more, with no gain observed over opus so far); on "Yes", only the tasks you check move to fable. The answer goes into `orchestre.config.json` (`fable`), which plan-lint enforces. The plan is validated by plan-lint, reviewed by a skeptical subagent, then committed on the branch `plan/<name>` after agreement. The format is described in [`plugins/orchestre/skills/prepare/format.md`](plugins/orchestre/skills/prepare/format.md).

### 3. `/orchestre:ready plans/<name>`: check that everything is ready

The day before the launch, without executing any task:

- the environment: settings (checked by `scripts/settings.mjs`: left incomplete by an older version or an update of the plugin, they are written on the spot after your agreement; missing, the check stops and sends to `/orchestre:install`), tools, git, formatter, untracked folders, permissions of the verification commands;
- the plan format: a plan of orchestre 0.11 is migrated here, after agreement (see [Upgrading from 0.11](#upgrading-from-011));
- the prerequisites: the decisions still open, to settle on the spot, and the actions that are yours, with how to do them;
- a dry run of the safe verification commands (no shared database, real data, paid call or deployment), which reveals the missing tools or permissions and the failures already present;
- the environment setup, in `orchestre.config.json`: `setup` (dependencies, generated code: run by each worker on its branch and by the integrator after each merge, before the check) and `shared_setup` (a common service such as a test database, per declared resource). The command proposes one from the repository if it is missing;
- the compound verification commands, which plan-lint reports: an agent isolated in a worktree would see them refused.

It gives a verdict phase by phase, for example "phases 1 to 3 ready; phase 4: T12 waits for D5". During the run, a task whose prerequisite is still open does not start, and the rest of the phase runs. `--no-dry-run` skips the dry run.

### 4. `/orchestre:run plans/<name>`: execute

In a new session. Pre-flight (version, settings, checked as by `/orchestre:ready`, git, migration of a plan of 0.11, cleanup of the worktrees left by earlier attempts, plan-lint and prerequisites of the phase, formatter, progress), choice of the mode and of the number of simultaneous tasks, then one run of the workflow per phase:

- **stop at each phase**: issues to settle, then a summary of the phase in the question "go on?" (advised for a first plan);
- **stop on deviation**: the run stops on any major deviation, for a ruling;
- **autonomous**: the safest option of each major issue is taken automatically; any issue for a human stops the run, and the run also stops beyond 3 auto-decisions.

During a run, the pilot session does not touch the main checkout, where the agents work: a request about the repository waits for the end of the run. A file the agents may not read or write (project or organization settings), or a command they may not run, does not stop the run: it becomes a review, to do yourself before the PR, with the command given at the end.

The state of the plan and of its runs is kept in `plans/<name>/progress.json` (outside git), which only `scripts/progress.mjs` writes, together with the PROGRESS.md view. To resume in a new session: `/orchestre:run plans/<name> --resume` (the state is in the plan and in git). At the end, the integration branch is ready for a PR: merging into `main` and deploying stay human actions.

### 5. `/orchestre:status [plans/<name>]`: see where the plan stands

At any time, including in the pilot session during a run: the command only reads, without switch, write or git lock. Without an argument, it takes the only plan in `plans/`. A script computes the table from plan-lint and git, and Claude copies it as is. Here, the plan of `tests/demo-progress.mjs` after its first run, with a review and a ticket added to HANDOFF.md:

```text
## demo — 2/5 tasks · 40%
`█████████░░░░░░░░░░░░░░░` phase 1 in progress · last merge T02 just now

| Phase | Progress | Tasks |
| :-- | :-- | :-- |
| ⚠ 1 | `██████░░░░` 66% | 2/3 |
| ○ 2 | `░░░░░░░░░░` 0% | 0/2 |

**Your turn**: T03 waits for a human · 1 review before the PR · 1 ticket after the PR
```

✓ phase finished, ● started, ⚠ a task there waits for a human, is blocked or failed, ○ not started. While tasks are started, a line **In progress** lists them, for example "T04 (worktree, last commit 3 min ago)": a task is in progress when its branch `task/<id>` (or `tache/<id>` of 0.11) exists; the exact step of each agent can be read in `/workflows`. The reviews counted are all the `review` entries of HANDOFF.md.

### Follow a run: `/progress`

The mod follows the run without a turn of Claude; `/orchestre:status` gives the plan, `/workflows` the step of each agent. The pane opens by itself at the first run started in the session, without taking the keyboard from the prompt. Claude Code keeps a pane opened that way waiting in a terminal narrower than 144 columns (110 once you have opened it yourself), until the terminal is widened; a notification then says that `/progress` opens it.

- The banner, above the prompt: progress, then what waits for you ("⚑ to review", "⚠ your turn", which can be clicked), then the task in progress; "⤢ Details", at the end, opens the pane. At the end of a run, "✕ Hide" hides the banner; the status line then keeps "orchestre ✓ 5/5 · ⚑ 3" as long as something is left to do. These buttons are clicked; they have no key.
- The pane, in cards: "Your turn" first, when something waits for you, then the run, the tasks and the log. y, r, t and l scroll to a card (l also shows the whole log). The keys 1 to 9 prepare in the prompt the action of a line of "Your turn" (resume the run, review a file, go over an auto-decision…), c the resume of a stopped run, p the PR draft: nothing is sent without you. ← and → stay with Claude Code. `/progress text` gives the same state as text.
- Notifications: only for a task that waits for a human, is blocked or failed, and for a run stopped or in error; `/progress sound` adds a sound (macOS). At the first prompt after 15 min without a prompt, a notification says what changed.
- The mod follows the `progress.json` written last; `/progress plans/<name>` picks a plan, `/progress auto` goes back to the last one written.

### First try

A toy repository with one task, to check the install end to end in a few minutes:

```sh
git clone git@github.com:FabienDayuse/circle-claude-plugin.git && cd circle-claude-plugin
sh tests/toy-repo.sh ~/tmp/orchestre-toy
cd ~/tmp/orchestre-toy && claude
```

Then `/orchestre:install`, a new session, `/orchestre:ready plans/demo` and `/orchestre:run plans/demo`.

### See the mod without a run

In any session where the mod is loaded, with or without a plan:

```
/progress demo
```

The mod plays in memory two runs of a made-up plan of 5 tasks, `showcase-site`, in a little over a minute: animated banner in colors, marked DEMO, notifications, a stop awaiting a ruling (a 12 s pause to open `/progress`), the resume, the end. The header of the pane gives the frame and, at some frames, what to try; an action key says what it would do, without putting anything in the prompt. Nothing is read or written in the repository meanwhile. A minute after the last frame, the real progress comes back; `/progress auto` goes back to it right away. The scenario is that of `tests/demo-progress.mjs`, which plays it with the real `progress.mjs`: the tests check that both give the same notifications and the same log.

If the mod shows nothing ([mods troubleshooting](https://code.claude.com/docs/en/plugins/mods/troubleshoot)):

- `claude --version`: 2.1.287 or later;
- `claude plugin test`, run in a folder without a mod, must say "no hooks module to load"; otherwise a setting (`disableAllHooks`) or a policy of the organization blocks mods;
- the trust prompt of the folder must have been accepted;
- `/plugin` must name `orchestre` on the line of the active mods;
- "Unknown command: /progress": the mod is not loaded, see the points above; `claude plugin list` must show `orchestre@circle` in 0.12.0 or later (`/progress` was `/suivi` before);
- with `--plugin-dir`, a line of the transcript says why a drawing is refused (`refused:`) or a hook skipped (`hook skipped:`); for an installed mod, these lines only go to the log: `claude --debug-file mod.log`, then look for `orchestre` in `mod.log`.

## Update

Between two runs, never during one:

```
/plugin marketplace update circle
/reload-plugins
```

Or from a terminal: `claude plugin update orchestre@circle`, then a new session.

- An update only arrives if the version in `plugins/orchestre/.claude-plugin/plugin.json` changed: otherwise, the command answers that the plugin is already up to date.
- Automatic update: `/plugin` → *Marketplaces* → `circle` → *Enable auto-update*. For a private repository, it needs a git credential already saved (SSH key in `ssh-agent`, or `gh auth setup-git`); otherwise it fails silently and keeps the version in place.
- The path of the plugin's scripts contains the version number: after an update, `scripts/settings.mjs` finds the rules of the older version, and `/orchestre:prepare`, `/orchestre:ready` and `/orchestre:run` offer to replace them, in one agreement.
- Installed version: `claude plugin list`.

## Upgrading from 0.12

0.13.0 checks and writes the settings through one script, `scripts/settings.mjs`, and `/orchestre:prepare` installs orchestre when it is missing. Between two runs:

1. Update the plugin (above). In each repository, the next `/orchestre:prepare`, `/orchestre:ready` or `/orchestre:run` finds the rules of 0.12 (the path of the scripts contains the version) and offers to replace them, in one agreement; `/orchestre:install` does it too.
2. `autoContinueAtUsageLimit`, which 0.12 and earlier wrote into `.claude/settings.local.json`: the settings reference of Claude Code gives it the scope "User or managed", so it most likely has no effect there; it is on by default. The plugin no longer writes it, and leaves the old line in place.
3. The `/progress` pane opens by itself at the first run started in the session.

## Upgrading from 0.11

0.12.0 moves the whole plugin to English, plan and progress formats included. Between two runs:

1. Update the plugin (above). The next `/orchestre:prepare`, `/orchestre:ready` or `/orchestre:run`, or `/orchestre:install`, finds through `scripts/settings.mjs` the rules of 0.11 (`Workflow(orchestre:executer-phase)`, the `suivi.mjs` rule) and offers to replace them with those of this version (`Workflow(orchestre:run-phase)`, the `progress.mjs` rule), with the rules of the model that are missing, in one agreement.
2. The commands change names:

   | 0.11 | 0.12 |
   | :- | :- |
   | `/orchestre:installer [--equipe]` | `/orchestre:install [--team]` |
   | `/orchestre:preparer` | `/orchestre:prepare` |
   | `/orchestre:pret [--sans-repetition]` | `/orchestre:ready [--no-dry-run]` |
   | `/orchestre:lancer [--reprendre]` | `/orchestre:run [--resume]` |
   | `/orchestre:etat` | `/orchestre:status` |
   | `/suivi` (`texte`, `son`, `demo`, `auto`) | `/progress` (`text`, `sound`, `demo`, `auto`) |

3. Plans: the scripts of 0.12 refuse a plan in the French format of 0.11 (`taches/`, `SUIVI.md`, `PREREQUIS.md`, `suivi.json`). `/orchestre:ready` or `/orchestre:run` detect it at their pre-flight, show a preview of the migration (`scripts/migrate.mjs`), then, after your agreement, migrate it and commit the plan folder alone on the integration branch (`orchestre: migrate plan <name> to the 0.12 format`). Keys, values, file names and section titles move to English (`tasks/`, `PROGRESS.md`, `PREREQUISITES.md`, `progress.json`); the free text stays as written, and the plan gets `"language": "fr"`. The migration refuses a plan folder with uncommitted changes, and a run still marked in progress unless you confirm it is stopped.
4. Git history is not rewritten: the branches `tache/<id>` and the commits "tâche <id> : " stay, and the scripts still read them. A task started in 0.11 and not merged is not taken back: it starts again from the integration branch on `task/<id>`, and the old branch stays in git, for reference; `/orchestre:status` keeps showing that task in progress as long as the old branch exists.
5. The mod: `/suivi` becomes `/progress`. In the pane, y goes to "Your turn", r to the run (it went to "À toi"), t to the tasks, l to the log (it resumed the run), c resumes a stopped run, 1 to 9 and p are unchanged. It only reads `progress.json`; for a plan of 0.11 not migrated yet, a notification says how to migrate it. The sound setting is kept.

orchestre 0.11 does not read a migrated plan: once a plan is migrated, it runs with 0.12. For a plan shared with others, update every clone to 0.12 before migrating it; in a clone that pulls the migrated plan, run `/orchestre:ready plans/<name>` once: it converts the `suivi.json` that clone keeps outside git, which plan-lint refuses next to `tasks/`.

## Share with the team of a repository

`/orchestre:install --team` declares the marketplace and the plugin in `.claude/settings.json` (versioned). The people who open the repository are offered the plugin after accepting the trust of the folder. Each of them needs read access to this GitHub repository; their first `/orchestre:prepare` offers their own settings, or `/orchestre:install` writes them. The permission rules stay in each person's `.claude/settings.local.json`: the paths of the scripts differ from one machine to the next, and a denial of `git push` in the versioned file would hold for the whole team.

## What a run does

A run equals a phase. For each ready task (dependencies merged, prerequisites done, resources free):

| Step | Agent | Model | Role |
| :- | :- | :- | :- |
| Reading | `plan-reader` | haiku | plan-lint as JSON: tasks of the phase, statuses, dependencies |
| Work | `worker`, or `isolated-worker` in a worktree if tasks run in parallel | the task's model, as is (sonnet if it has none) | carries out the task on `task/<id>`, runs its verifications, returns a report |
| Verification | `verifier` | sonnet | replays the verification commands: exit code and excerpt of each |
| Evaluation | `evaluator` | opus | judges each criterion of done on evidence (diff, results of the verifier) |
| Model choice | `replanner` | opus | after a rejected attempt, chooses the model of the fix from the rejection; the task's model is the floor; without a valid answer, the `escalation` ladder |
| Fixes | `worker` | model chosen; without a model in the plan: sonnet then opus (`escalation`) | 2 fixes at most (`max_fixes`), on the gaps found |
| Merge | `integrator` | sonnet | `--no-ff` into `plan/<name>`, then the post-merge check |
| Replanning | `replanner` | opus | rates the deviations, prepares the issues to settle with their options |
| Progress | `scribe` | sonnet | the only one to write HANDOFF, DISCOVERY and the tasks created or amended; closes the task through `progress.mjs`, which regenerates PROGRESS.md |
| End of run | `clerk` | haiku | closes the run with `progress.mjs run-end`, commits PROGRESS.md if it changed, removes the clean worktrees of the tasks (`worktrees.mjs`) |

Progress: `plans/<name>/progress.json`, outside git, holds the state of the plan and of its runs (contract `orchestre-progress/3`); only `scripts/progress.mjs` writes it, together with the PROGRESS.md view. The workflow launches nothing itself: each agent first runs the step command its instructions carry (for the worker and each fix, it also records the model launched); the first agent of the run opens it, the scribe closes the task, the clerk closes the run.

Safeguards: no agent pushes, merges into `main` or deploys; no agent opens, restores or copies real production or personal data (these actions are the human's); a deviation that touches data, a database, production or a secret is always major; no agent gets around a read or write ban, and the file concerned goes to human review before the PR; no agent rewrites history (rebase, reset): a branch taken back receives the integration branch by a merge; a worktree that holds uncommitted work is never removed; an interrupted run is not resumed, a new one is launched, and the tasks already merged are skipped.

## Repository content

```
.claude-plugin/marketplace.json      catalog of the "circle" marketplace
plugins/orchestre/
├── .claude-plugin/plugin.json       manifest (name, version, contract of the types)
├── skills/install/                  /orchestre:install, settings template
├── skills/prepare/                  /orchestre:prepare, format of a plan (format.md)
├── skills/ready/                    /orchestre:ready
├── skills/run/                      /orchestre:run
├── skills/status/                   /orchestre:status
├── agents/                          the 9 agents of the workflow
├── workflows/run-phase.js           the workflow, one run per phase
├── scripts/                         plan-lint.mjs (validates and compiles a plan), status.mjs (/orchestre:status),
│                                    progress.mjs (progress.json and PROGRESS.md), worktrees.mjs (cleanup of the
│                                    worktrees), migrate.mjs (plans of 0.11 to the 0.12 format), settings.mjs (the
│                                    settings of Claude Code checked against the model of /orchestre:install, and written)
├── hooks/hooks.json                 declares the module of the mod
├── hooks/register.tsx               the mod: files, timer, drawing, /progress
├── hooks/view-model.mjs             reading of progress.json and layout, without the engine
├── hooks/demo.mjs                   /progress demo: the run played in memory, frame by frame, and its legend
├── sounds/waiting.wav               the sound of /progress sound
├── types/index.d.ts                 contract of the mod's state ($.state)
└── tests/progress.test.tsx          tests under the engine (claude plugin test)
tests/
├── scenarios.mjs                    simulated scenarios of the workflow
├── plan-lint.test.mjs               plan-lint on toy plans
├── status.test.mjs                  /orchestre:status on a toy repository
├── progress.test.mjs                progress.mjs in temporary repositories
├── worktrees.test.mjs               worktrees.mjs in temporary repositories
├── migrate.test.mjs                 migrate.mjs on plans written by the real scripts of 0.11
├── settings.test.mjs                settings.mjs in temporary repositories, the install of 0.11 included
├── settings-template.test.mjs       settings template of /orchestre:install
├── commands.test.mjs                contract between the skills and the workflow, scripts, agents and plan format
├── mod-progress.test.mjs            view model of the mod on progress.json files written by progress.mjs
├── toy-repo.sh                      toy repository for a real try
└── demo-progress.mjs                the scenario of /progress demo played by the real progress.mjs (tests)
```

## Develop

- Try a change without installing it: `claude --plugin-dir plugins/orchestre`, then `/reload-plugins` after each change.
- Tests: `npm test` runs four groups, which can also be run alone:
  - `npm run test:scripts`: 24 cases of plan-lint, 9 of `/orchestre:status`, 27 of `progress.mjs`, 4 of `worktrees.mjs`, 21 of `migrate.mjs` and 21 of `settings.mjs`, in temporary git repositories;
  - `npm run test:workflow`: 103 scenarios of the workflow, with simulated agents, 6 of which run the real `progress.mjs` and `worktrees.mjs` in a temporary repository;
  - `npm run test:commands`: the settings template, and 15 tests of the contract between the skills and the rest of the plugin;
  - `npm run test:mod`: 24 cases of the mod's view model on `progress.json` files written by `progress.mjs`, `/progress demo` compared with the real `progress.mjs` included.
- Validation: `npm run validate` (`claude plugin validate` on the plugin and on the marketplace, then `claude plugin test` of the plugin, which runs the 25 tests of the mod under the engine).
- Try the mod without installing it: `claude --plugin-dir plugins/orchestre`, then `/progress demo`; or, on a real `progress.json`, `node tests/demo-progress.mjs <folder>` in another terminal.
- The workflow script has no access to files and cannot import anything; `Date.now()`, `Math.random()` and `new Date()` are forbidden there. Before changing it, load the reference `/workflow-authoring`.
- Publish a version:
  1. raise `version` in `plugins/orchestre/.claude-plugin/plugin.json`: without that, nobody gets the update;
  2. add the entry to `CHANGELOG.md` and update the version in the table at the top of this README;
  3. `npm test && npm run validate`;
  4. commit and push to `main`;
  5. on each machine: `/plugin marketplace update circle`.

## Known limits

- The plugin first ran for real on 2026-09-29, on a plan of 37 tasks: phases 1 and 2 ran in 0.6.0. The prerequisites and `/orchestre:ready` (0.6.1) and the reviews (0.6.2) have not run for real yet. Nor has 0.12.0: the commands in English, the migration of a real plan of 0.11 and the mod in English were only checked by the tests. Nor has 0.13.0: the install from `/orchestre:prepare`, the settings written during a session and the pane opened by itself.
- The reviews are read by no agent: without you before the PR, a file forbidden to the agents goes out without a review.
- A ban that the worker reports as an ordinary deviation is only reclassified as a review if its description cites neither a database, nor production, nor a secret (`DATABASE_URL`, `JWT_SECRET`…): otherwise the run stops for a human.
- `/orchestre:ready` spots the "safe" commands on the strength of the configuration and of DISCOVERY.md: when in doubt, it asks you to run them yourself with `!`.
- The settings (worktree, permissions) cannot come from a plugin: `scripts/settings.mjs` writes them into each project, from `/orchestre:install`, `/orchestre:prepare`, `/orchestre:ready` or `/orchestre:run`. Its check does not read the managed settings of an organization. Claude Code reloads the permission rules during the session; for `worktree.baseRef`, its documentation does not say, hence a run in a new session. If the Bash sandbox is on, it refuses the writes of the script into the settings files: the command gives the line to run yourself at the prompt with `!`, which runs outside the sandbox.
- The denials of the template cover `.env` and `.env.*` at the root of the repository only: `Read(./.env)` matches the file in the current folder (code.claude.com/docs/en/permissions), so a `.env` in a subfolder (`apps/api/.env`) can be read by the agents. Add a rule for it with `/orchestre:install`, or a `Read(.env)` without `./`, which matches at any depth.
- The actual tokens are not collected automatically: read them in `/workflows`, task by task. On the pilot, the actual figure was 3 to 8 times the estimate.
- In autonomous mode, the auto-decisions are only reviewed at the PR; the circuit breaker caps their number, not their quality.
- Sensitive deviations are spotted by keywords (data, database, production, secret…, in English and in French): the filter catches wide, but does not see a risk worded otherwise.
- Two tasks that share a database or a port run one after the other.
- Claude Code may report at startup the permission rules `Bash(git -C * diff *)` and `Bash(git -C * log *)` (wildcard before the subcommand): the evaluator uses them to read the diff of a worktree.
