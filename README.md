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

A long dev plan does not fit in one Claude Code session: the context fills up, and someone has to track what is done, what failed and what is left. orchestre splits the work into a plan of phases and tasks, and runs it with a team of agents. Each task is done on its own branch, in its own worktree when tasks run side by side, then verified, evaluated and merged into an integration branch, until that branch is ready for a pull request. You step in only when a decision is yours.

<!-- TODO(screenshot): take brand/screenshots/progress-panel.png on a real run (the /progress pane, with a "Your turn" card), then uncomment this block.
<p align="center">
  <img src="brand/screenshots/progress-panel.png" width="720" alt="The /progress pane during a run: a Your turn card with numbered actions, then the run, the tasks as timelines and the log">
  <br>
  <em>The /progress pane during a run: what waits for you comes first, one key per action.</em>
</p>
-->

## Use

Once orchestre is [installed](#install), at the root of your repository, on its base branch, with no uncommitted change:

```
/orchestre:prepare <goal or existing plan>   # write the plan: phases, tasks, decisions
/orchestre:ready plans/<name>                # the day before: settings, prerequisites, dry run
/orchestre:run plans/<name>                  # in a new session: one run per phase, up to the PR
/orchestre:status                            # where the plan stands, even during a run
/progress                                    # the live pane: what waits for you
```

- `/orchestre:prepare` installs orchestre in the repository first if needed. It gives each task a model, and asks every open decision; you can defer some.
- `/orchestre:run` asks the mode: stop at each phase (advised for a first plan), stop on a major deviation, or autonomous.
- At the end, `plan/<name>` is ready for a pull request. The summary lists the auto-decisions and the files to review, and `p` in `/progress` drafts the PR text. Pushing, merging into `main` and deploying stay with you.

Every option and key: [Reference](#reference).

## Why orchestre

- **Isolated work.** Each task has its own branch, `task/<id>`, and its own worktree when it runs alongside others. It is merged with `--no-ff` into `plan/<name>`. No agent pushes, merges into `main` or deploys.
- **Evaluation on evidence.** A verifier replays the task's verification commands. An evaluator on opus judges each criterion of done on the diff and those results, not on what the worker says it did. Up to two fixes follow by default (`max_fixes`), on the gaps found.
- **A model per task.** The preparation gives each task haiku, sonnet or opus, with a one-line reason; fable only on the tasks you choose. A fix never runs on a model below the task's.
- **Scripts for the state, agents for the work.** Node scripts without dependencies validate the plan (`plan-lint.mjs`), write the progress (`progress.mjs`) and the settings (`settings.mjs`), and clean up the worktrees. The agents write the code and make the judgment calls.
- **A human only when needed.** Real data, secrets, production and deployment stay yours. A file the agents may not touch becomes a review to do before the pull request, without stopping the run.
- **Resume and follow.** An interrupted run is never continued: the next `/orchestre:run` starts a new run from the plan and git, and skips the merged tasks. During a run, a banner above the prompt and the `/progress` pane show where things stand and what waits for you.

## Install

**Requirements**

- Claude Code 2.1.287 or later, with dynamic workflows: paid plans; on Pro, the *Dynamic workflows* line of `/config`. The commands need 2.1.271; the progress display needs 2.1.287.
- `git` and Node.js 18 or later.
- Read access to this GitHub repository, private for now: see [Access to the repository](docs/reference.md#access-to-the-repository).

This repository is the plugin marketplace `circle`; orchestre is its only plugin. Once per machine, in a Claude Code session:

```
/plugin marketplace add FabienDayuse/circle-claude-plugin
/plugin install orchestre@circle
/reload-plugins
```

To try orchestre on a toy repository first: [First try](docs/reference.md#first-try).

## Reference

| Command | What it does |
| :- | :- |
| `/orchestre:prepare <existing plan or goal>` | Converts a written plan, or writes a new one from a goal. Installs orchestre first if needed. |
| `/orchestre:install [--team]` | Writes the repository settings orchestre needs. `--team` also offers the plugin to the people who open the repository. |
| `/orchestre:ready plans/<name> [--no-dry-run]` | Checks that the plan can run, without running any task, and gives a verdict phase by phase. |
| `/orchestre:run plans/<name> [--resume]` | Runs the plan, one workflow run per phase. `--resume` first recalls where the plan stands. |
| `/orchestre:status [plans/<name>]` | Shows the progress of the plan as a table. Read-only, also during a run. |
| `/progress [plans/<name> \| auto]` | Opens the progress pane. A plan path picks the plan; `auto` follows the last one written. |
| `/progress text` | Gives the same state as text. |
| `/progress demo` | Plays two runs of a made-up plan in a little over a minute, without reading or writing the repository. |
| `/progress sound` | Turns on or off a sound when something waits for you (macOS). |

Keys of the `/progress` pane. An action key only prepares a text in the prompt: nothing is sent without you.

| Key | Action |
| :- | :- |
| `y` `r` `t` `l` | Scroll to "Your turn" (when shown), the run, the tasks or the log. `l` also switches between the short and the whole log. |
| `1` to `9` | Prepare the action of a line of "Your turn": resume the run, review a file, go over an auto-decision… |
| `c` | Prepare `/orchestre:run plans/<name> --resume`, after a run that ended before the plan is finished. |
| `p` | Prepare the pull request draft, once the plan is finished. |
| `Esc` | Close the pane. |

In the banner, "⤢ Details" opens the pane and, after a run, "✕ Hide" hides the banner. Both are clicked; they have no key.

More:

- [`docs/reference.md`](docs/reference.md): installation, each command in detail, the progress display, what a run does, known limits, development.
- [`docs/configuration.md`](docs/configuration.md): the settings orchestre writes into a repository, sharing with a team, `orchestre.config.json`.
- [`docs/upgrading.md`](docs/upgrading.md): from 0.12 and from 0.11.
- [Plan format, `format.md`](plugins/orchestre/skills/prepare/format.md): tasks, `PROGRESS.md`, `PREREQUISITES.md`, `HANDOFF.md`, `DISCOVERY.md`, `orchestre.config.json`.
- [`CHANGELOG.md`](CHANGELOG.md).

## Upgrading

Update between two runs, never during one: `/plugin marketplace update circle`, then `/reload-plugins`.

- **From 0.12.** The next `/orchestre:prepare`, `/orchestre:ready` or `/orchestre:run` offers to replace the settings rules of 0.12, in one agreement.
- **From 0.11.** The commands move to English (`/orchestre:lancer` becomes `/orchestre:run`, `/suivi` becomes `/progress`…). `/orchestre:ready` or `/orchestre:run` migrates each plan to the new format, after your agreement.

Details: [`docs/upgrading.md`](docs/upgrading.md).

---

<!-- TODO(license): choose the license with Dayuse, add a LICENSE file, then replace the line below. -->
License: not chosen yet.

orchestre is an independent project, not affiliated with or endorsed by Anthropic. Logo and visual identity: [`brand/`](brand/).
