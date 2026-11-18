# orchestre reference

The detail behind the [README](../README.md). Settings written into a repository: [`configuration.md`](configuration.md). Coming from an earlier version: [`upgrading.md`](upgrading.md). Plan format: [`format.md`](../plugins/orchestre/skills/prepare/format.md).

- [Installation](#installation)
- [Commands](#commands)
- [The progress display](#the-progress-display)
- [What a run does](#what-a-run-does)
- [Known limits](#known-limits)
- [Development](#development)

## Installation

This repository is the Claude Code plugin marketplace `circle` ([Claude Code plugins](https://code.claude.com/docs/en/plugins)). It holds one plugin, `orchestre`.

### Requirements

- Claude Code 2.1.271 or later, with dynamic workflows: paid plans; on Pro, the *Dynamic workflows* line of `/config`.
- The progress display (banner, `/progress`) is a mod, made of function hooks: it needs Claude Code 2.1.287 or later (`claude --version`), the version from which mods are on by default ([mods documentation](https://code.claude.com/docs/en/plugins/mods/overview)).
- `git` and Node.js 18 or later on the machine: the plan check (`plan-lint`) and the progress are Node scripts without dependencies.

### Install

Once per machine, in a Claude Code session:

```
/plugin marketplace add Archibald0/circle-claude-plugin
/plugin install orchestre@circle
/reload-plugins
```

Or from a terminal:

```sh
claude plugin marketplace add Archibald0/circle-claude-plugin
claude plugin install orchestre@circle
```

Check: `claude plugin list` shows `orchestre@circle` enabled, and `/orchestre:` offers `install`, `prepare`, `ready`, `run` and `status`. `/plugin` says whether the progress display is loaded: the line under the tabs names the active mods, `orchestre` among them.

### Update

Between two runs, never during one:

```
/plugin marketplace update circle
/reload-plugins
```

Or from a terminal: `claude plugin update orchestre@circle`, then a new session.

- An update only arrives if the version in `plugins/orchestre/.claude-plugin/plugin.json` changed. Otherwise, the command answers that the plugin is already up to date.
- Automatic update: `/plugin` → *Marketplaces* → `circle` → *Enable auto-update*.
- The path of the plugin's scripts contains the version number. After an update, `scripts/settings.mjs` finds the rules of the older version, and `/orchestre:prepare`, `/orchestre:ready` and `/orchestre:run` offer to replace them, in one agreement.
- Installed version: `claude plugin list`.

Version notes: [`upgrading.md`](upgrading.md).

### First try

A toy repository with one task checks the install end to end in a few minutes:

```sh
git clone https://github.com/Archibald0/circle-claude-plugin.git && cd circle-claude-plugin
sh tests/toy-repo.sh ~/tmp/orchestre-toy
cd ~/tmp/orchestre-toy && claude
```

Then `/orchestre:install`, a new session, `/orchestre:ready plans/demo` and `/orchestre:run plans/demo`. The plan is already written there, so `/orchestre:prepare` does not apply.

## Commands

`/orchestre:prepare`, `/orchestre:ready` and `/orchestre:run` are used in that order. `/orchestre:install` runs from `/orchestre:prepare` when needed, `/orchestre:status` shows where a plan stands, and `/orchestre:done` closes the reviews and the auto-decisions left at the end.

### `/orchestre:prepare`: write or convert a plan

It starts by checking the install:

- orchestre was never installed in the repository: it runs `/orchestre:install`, each write and each commit after your agreement;
- an older version or an update of the plugin left the settings incomplete: it shows the rules to add or replace, and writes them after one agreement.

If you decline, the preparation goes on. Then `/orchestre:ready` and `/orchestre:run` stop until `/orchestre:install` has run when the settings are missing, and offer to write the missing rules themselves when they are incomplete.

Two uses:

- `/orchestre:prepare docs/my-plan.md` converts a plan already written (file or folder). The splitting, the vocabulary and the decisions of the source plan are kept. What is missing (owned files, verification commands, definition of done) comes from an exploration of the repository. The summary gives a correspondence table, source plan → tasks.
- `/orchestre:prepare add the CSV export of the bookings` explores the repository, splits and writes a new plan.

Then, in order:

- **Language.** It asks the language of the plan's free text (`language`: task titles, criteria, HANDOFF descriptions…). Keys, statuses, section titles and commit messages stay in English.
- **Models.** Each task gets a model and a line that justifies it (`model`, `model_reason`): haiku for mechanical work (renaming, documentation, configuration), sonnet by default to implement, opus for architecture, ambiguous tasks and those that touch several modules. The skill itself runs on opus (field `model`), for the turn.
- **Fable.** It asks whether to use fable for this plan. "No" is recommended: it costs more, with no gain observed over opus so far. On "Yes", only the tasks you check move to fable. The answer goes into `orchestre.config.json` (`fable`), which `plan-lint` enforces.
- **Decisions.** Every open decision is asked, in batches of 4, without a cap. Only those you choose to defer stay open.
- **Prerequisites.** What an agent will never do (access, secret, paid account, real data) and the environment the verifications need go into `PREREQUISITES.md`. Each task cites what it waits for.
- **Validation.** `plan-lint` validates the plan, a skeptical subagent reviews it, then it is committed on the branch `plan/<name>` after your agreement.

### `/orchestre:install`: prepare the repository

Once per repository, at its root. `/orchestre:prepare` runs it on its own when the settings are missing. A plugin cannot set the settings the orchestrator needs, so the command writes them into the project, showing each change before making it. What it writes, and why: [`configuration.md`](configuration.md). `--team` also declares the plugin for the repository's team: [Sharing with a team](configuration.md#sharing-with-a-team).

### `/orchestre:ready plans/<name>`: check that everything is ready

The day before the launch, without executing any task, it checks:

- **the environment**: settings, tools, git, formatter, untracked folders, permissions of the verification commands. `scripts/settings.mjs` checks the settings. Left incomplete by an older version or an update of the plugin, they are written on the spot after your agreement. Missing, the check stops and sends to `/orchestre:install`;
- **the plan format**: a plan of orchestre 0.11 is migrated here, after agreement (see [`upgrading.md`](upgrading.md#from-011-to-012));
- **the prerequisites**: the decisions still open, to settle on the spot, and the actions that are yours, with how to do them (the section `## <ID> · how` of PREREQUISITES.md, which the `/progress` pane shows; offered when it is missing);
- **a dry run** of the safe verification commands (no shared database, real data, paid call or deployment). It reveals the missing tools or permissions and the failures already present;
- **the environment setup**, in `orchestre.config.json`: `setup` (dependencies, generated code: run by each worker on its branch and by the integrator after each merge, before the check) and `shared_setup` (a common service such as a test database, per declared resource). The command proposes one from the repository if it is missing;
- **the free disk space** (0.19.0): `scripts/worktrees.mjs space` compares the free space of the disk with the size of the working folder (ignored files included, `.git` excluded) times the parallelism. One line, with `⚠` only when space is lacking; `space: not measured (<reason>)` when the measure fails (no `statfsSync` before Node 18.15). It never blocks;
- **the rulings and prerequisites noted outside a run** (0.21.0): the answers recorded with `rule` and the prerequisites noted with `did`, read in `progress.json` and reported, never applied: `/orchestre:run` applies them at its pre-flight;
- **the compound verification commands**, which `plan-lint` reports: an agent isolated in a worktree would see them refused.

It gives a verdict phase by phase, for example "phases 1 to 3 ready; phase 4: T12 waits for D5". During the run, a task whose prerequisite is still open does not start, and the rest of the phase runs. `--no-dry-run` skips the dry run.

### `/orchestre:run plans/<name>`: execute

In a new session. The pre-flight checks the version, the settings (as `/orchestre:ready` does), git, the plan format (it migrates a plan of 0.11), the worktrees left by earlier attempts (cleaned up) and the free disk space for the parallel worktrees (`worktrees.mjs space`, a warning only), `plan-lint` and the prerequisites of the phase, the formatter and the progress. Then it asks the mode and the number of simultaneous tasks, and launches one run of the workflow per phase. The three modes:

- **stop at each phase**: issues to settle, then a summary of the phase in the question "go on?". Advised for a first plan;
- **stop on deviation**: the run stops on any major deviation, for a ruling. Since 0.21.0 it first waits for that ruling, `ruling_wait_minutes` minutes (15 by default) at most: no new task starts, the tasks in flight finish, and an issue settled in time, from the pane or with `rule`, is applied during the run, which then goes on. Released with `[ Decide later ]`, past its deadline or with a wait that failed, it stops as before. A human issue stops the run at once; `ruling_wait_minutes: 0` keeps the behavior of 0.20;
- **autonomous**: the safest option of each major issue is taken automatically. Any issue for a human stops the run, and the run also stops beyond 3 auto-decisions.

During a run, the pilot session does not touch the main checkout, where the agents work: a request about the repository waits for the end of the run. A file the agents may not read or write (project or organization settings), or a command they may not run, does not stop the run. It becomes a review, to do yourself before the PR, with the command given at the end.

The state of the plan and of its runs is kept in `plans/<name>/progress.json` (outside git). Only `scripts/progress.mjs` writes it, together with the `PROGRESS.md` view. To resume in a new session: `/orchestre:run plans/<name> --resume`; the state is in the plan and in git. At the end, the integration branch is ready for a PR: merging into `main` and deploying stay human actions.

**Agents not answering** (0.19.0). When two agent calls in a row come back without an answer (login expired, usage limit, network), the run stops at once with status `error` and a `detail` that starts with `agents not answering:`, instead of turning every task into phantom issues. The tasks in flight stop without a close: their status and branch do not move, and they are listed in `interrupted`. Check `claude` (`/login`) and the usage limit, then launch a new run. The breaker itself leaves no issue to settle; a `stop_issue` or `open_issues` in the return were recorded before the trip and are settled as usual. A task merged just before the trip is not taken up by the next run: it comes out in `merged_unclosed`, with its `id`, `branch`, `deviations`, `reviews`, `unverifiable` criteria and `issues`, which `/orchestre:run` lists and has settled before the new run. `merged_unclosed` is always present on a breaker return, empty when no task was merged before the trip. Its `issues` also hold the issues that autonomous mode had decided automatically, as full issues with their options: their decisions, added tasks and amendments were never written, so none of them counts as applied until settled. A task interrupted at its own merge (the integrator call that tripped the breaker) is in `interrupted` and also in `merged_unclosed`, with `merge: "unknown"`: `git merge` may have run before the integrator stopped answering. Before the new run, `/orchestre:run` checks for its commit `task <id>:` on the integration branch. Found, the task is merged: its entry is handled as above, and since its post-merge check never ran, its verifications are run on the integration branch, as for `repair`. Not found, the next run takes the task up from its branch.

**Post-merge check skipped** (0.19.0). For a task that ran in the main checkout, when the merged tree is identical to the branch the verifier checked (`git diff --quiet <branch> HEAD`), the integrator runs neither the setup nor the check again (`check_skipped`; the log says so). It asks nothing of you. A task in a worktree always gets its check.

**Scope check** (0.19.0). `plan-lint <plan> --scope <id> --branch <branch> --integration <branch>` is a read-only check of a task branch: it prints one JSON line with the fields `task`, `branch`, `files` (every file the branch changed), the files changed outside `owned_files` (`outside`), the test files deleted or renamed (`tests_removed`, a heuristic on the path: any path containing `test` or `spec`, so `docs/latest.md` counts too), the skipped-test markers added (`skips_added`, each with its `marker`) and its fingerprint `digest`. The verification runs it: a file outside `owned_files` rejects the attempt, and the evaluator must back each `pass` with one proof per criterion (`diff`, `test`, `command` or `report`). Gaps are reported, never an error (exit code 0); `--scope` cannot be combined with `--json` or `--reader`. It reads `owned_files` more strictly than the overlap check: an entry with `*` owns the paths that start with the text before the `*`; an entry without `*` owns its path and what is under it as a directory (`docs/sc.md` does not own `docs/sc.md.bak`); an entry with nothing before its `*` (`*.md`) owns nothing, so every file it would match comes out in `outside` and fails the verification.

**End-of-run triage** (0.19.0). `progress.mjs triage <plan>` sorts the open reviews and auto-decisions without writing anything, and prints JSON `{ plan, base, integration, safe, open }`. `safe` is what `/orchestre:run` closes alone, each item with its `reason`: `duplicate` (same task, same first backquoted passage), `superseded` (an automatic decision replaced by a later ruling of yours), `no-diff` (a review "unreadable by the agents" whose file no longer differs between the base and the integration branch), `worktree-gone` (a review "worktree … kept" whose folder no longer exists). They close in one write, passed as `{ "items": <safe> }` to `ack`. `open` lists everything else by task, and the command never closes it: a review that asks you to change a forbidden file always stays there. The triage runs at the end of each phase and at the end of the command. `open` is offered to you, task by task ("Done", "Ticket", "Keep open"), in phase mode at the end of each phase, before the end-of-phase question, and at the end of the command. Autonomous and deviation mode do not stop on it at the end of a phase: they close `safe`, say in one line per task how many items stay open, and go on to the next phase. Exit code 2: plan not found or ambiguous; 1: `progress.json` unreadable (message on stderr), which `/orchestre:run` reports as "triage not available" and closes nothing.

**Issue register and rulings** (0.20.0). `plans/<name>/ISSUES.json` (`orchestre-issues/1`) is tracked by git and written by `scripts/progress.mjs` alone; `progress.mjs validate` checks it. One entry per issue: `id` (`<task>-<n>`, stable), `task`, `title`, `context`, `human`, `options`, `status` (`open`, `settled` or `dropped`) and `ruling` (`option` or `text`, `author` `user` or `auto`, `at`, `commit`). Each option keeps its HANDOFF `entries`, `added_tasks` and `amendments`, and the verdict of a dry run: when an issue is raised, the script applies the option to a temporary copy of the plan and runs plan-lint, which gives `valid` and `invalid_reason`. `progress.json` keeps a short copy of each open issue for display, with `effect` (one sentence) and `amends` (ids) per option, and `pending_rulings`, the answers recorded and not applied yet. `ruling.commit` stays null in ISSUES.json, for a user ruling and for `auto`: the ruling is written in the commit that applies it, whose hash is not known before that commit. The commit is in the `commit` field of the output of `apply` (of `close` for `auto`), and its message is `progress: rulings <ids>` (`progress(<id>): <status>` for `auto`).

- `progress.mjs rule <plan>`: records your answer to an open issue, `{"issue":"<id>","option":"<option id>"}` or `{"issue":"<id>","text":"<answer>"}`; several as `{"items":[…]}`, recorded whole or not at all. It writes `progress.json` only, so it is safe during a run, and the issue leaves "Your turn" and `/orchestre:status`. Refused: an unknown or settled issue, an issue that already has a ruling, an invalid option (with its reason). An issue inherited from a `/3` file has no valid option: answer with a text. So does an issue of `progress.json` that has no entry in ISSUES.json (a stop issue the run end recorded because the close of its task was not written): the actions of its options are unknown, so the run end marks each option `valid: false` (`raised without its actions (its close was not written): settle it with a free answer`), and `rule` refuses any option of such an issue with that reason (code 1), since `apply` would refuse it.
- `progress.mjs unrule <plan>`: `{"issue":"<id>"}` or `{"items":[…]}`, withdraws a ruling recorded and not applied yet; refused once applied.
- `progress.mjs apply <plan>`: no input. Applies the recorded rulings to the plan, on the integration branch only, in one commit `progress: rulings <ids>`: HANDOFF.md (`decision · major · … settled by the user`, then the actions of the option, with the same lines as `close`), the task files, ISSUES.json and PROGRESS.md. A task an option adds joins the phase of the run that applies it when its own phase is earlier (`amendment · minor · <id>: phase <a> raised to phase <b>…`). The workflow runs it at the start of each run, through the plan reader. A ruling it cannot apply is listed in `rejected`, the others are applied. It reopens the issue (open again, the option `valid: false` with the reason) when plan-lint or an action refuses the option, or when the issue has no entry in ISSUES.json; it drops the ruling, marking nothing, on an unknown or already settled issue, an absent option or an option already invalid. Either way the run stops before any task (see the workflow return below). Code 1, nothing written, the rulings kept: the main checkout is not on the integration branch, the commit is refused, or a ruling was withdrawn or changed while it ran.
- `progress.mjs close <plan>`: run by the clerk, or by the scribe after DISCOVERY.md, at the close of each task, on the integration branch only. Its input, besides `task`, `status`, `attempts`, `branch`, `blocker`, `rejections`, `unverifiable`, `flaky` and `reviews`: `entries`, the HANDOFF entries `{ type, severity, description }`, written word for word (the reviews among them); `added_tasks`, `{ id, title, phase, content }`, a task file being written only when `content` is given; `discarded_amendments`, the amendments the workflow could not make (task merged, cancelled or running), noted `blind-spot · major · amendment not applied to <id>: …`; and `issues`, whole, each option with its `entries`, `added_tasks` and `amendments`. An issue with `auto: <option id>` is an automatic decision: close applies that option (`decision · major · <title>: option <id> taken automatically (autonomous mode) — …`, then the actions of the option). close writes HANDOFF.md under `## <task>` (a line already there is not written twice), the tasks created, the amendments, ISSUES.json (each option of a new issue with its dry run) and PROGRESS.md, and commits them, with DISCOVERY.md when it changed, in one commit `progress(<id>): <status>`. Run twice, it adds no issue. Its output is one line of JSON, `{ task, status, commit, rejected, discarded, issues, pending, message, digest }`: `rejected`, `{ id, reason }` for each task or amendment plan-lint refuses (put back) and `{ id, issue, title, reason }` for each path an automatic decision cites that neither exists nor is owned by a task the close creates, `issue` being the id of its issue and `title` its title (that decision is not applied, its issue stays open, and HANDOFF.md gets `needs-human · major · inconsistent auto-decision: <path> does not exist and no task creates it`; the workflow no longer counts it among the automatic decisions of the run); `discarded`, the amendments of a merged or cancelled task; `issues`, the ids of the issues of this close; `pending`, the issues with a ruling recorded and not applied yet; `digest`, the fingerprint against which the workflow checks the agent's copy. A `rejected` that is not empty stops the run for a human (`Progress of <id>: tasks, amendments or decisions rejected`); a copy that does not match its digest too (`Progress of <id>: output of close not read`), and the pilot reads the commit instead of running close again.
- The progress lock (0.20.0): `close` and `apply` commit under `plans/<name>/.progress.lock`, so that a refused commit puts progress.json and ISSUES.json back before any other writer reads them. A slow pre-commit hook of the project therefore makes the other progress commands (`rule`, `step`, …) wait, and refuse after 20 s (`lock … held by process … for more than 20 s`); a `rule` made during the commit is kept, whether the commit is accepted or refused. A lock whose process still runs is never removed, whatever its age; one is removed only when its process no longer runs, or when its pid cannot be read and it is older than 60 s.
- A task added by `close`, its dry run or `apply` that shares files with a task of its phase, without a dependency between them (`plan-lint --json`, `overlaps`), gets a `depends_on` on that task instead of being refused, noted `amendment · minor · <id>: depends on <other>, added automatically: …` in HANDOFF.md. A task added during a run never starts in that run.
- Every write of `progress.mjs` that carries a `_digest` is checked against the payload and refused when they differ (`payload altered in transit`, nothing written); the workflow runs the call once more.

`/orchestre:run` settles each issue with the question tool, then records the answer with `rule`; `apply` writes it into the plan at the pre-flight of the next run, or during a run (0.21.0, below). An invalid option is not offered, and its reason is said; with at least two issues whose recommended option is valid, the first question is `Accept the N recommended options?`. `/orchestre:run --resume` lists the rulings recorded and not applied yet. Two issues take a hand path: those of `merged_unclosed` (a circuit breaker return) reached neither `progress.json` nor ISSUES.json, so `rule` refuses them, and those of a task whose progress was not committed (stop `Progress of <id> not committed`) have no entry in ISSUES.json. For the first, the pilot writes the chosen option itself (`decision · major · <title>: option <id> settled by the user — <description>` under the task in HANDOFF.md, then its added tasks and amendments), runs plan-lint until "valid plan", then commits on the integration branch.

**Answering during the run** (0.21.0). A run no longer has to stop for an issue that can wait. `progress.mjs close` gives each open issue that is not human a deadline, `ruling_wait_minutes` after it was raised (15 by default, 0 to never wait, an integer from 0 to 60 checked by plan-lint), and lists the tasks not started yet that its valid options amend (`holds`); its output carries them in `waits`.

- `progress.mjs wait <plan>`: `{"task":"<id>","issues":["<id>",…]}`, run by the clerk for a task that waits. It blocks until each issue has a ruling (recorded or applied), is released or reaches its deadline, 100 seconds at most per call, then prints `{ task, settled, released, timeout, again, digest }`; `again` means the 100 seconds passed first, and the clerk runs it again, the deadline staying the one of `progress.json`. A human issue is refused. The first call notes the task in the `waiting` of each issue.
- `progress.mjs release <plan>`: `{"issue":"<id>"}`, the `[ Decide later ]` of the pane. The tasks the issue holds start without waiting for it; the issue stays open.
- `progress.mjs did <plan>` and `progress.mjs undid <plan>`: `{"prerequisite":"<id>"}`, the `[ ✓ I did it ]` of the pane and its `[ Undo ]`. A manual or environment prerequisite is noted done in `progress.json` (`pending_done`), and the next `apply` writes it into PREREQUISITES.md (`done`, `confirmed by the user on <date>`) in the same commit as the rulings; `apply` then also prints `done: [ids]`. `did` refuses a decision prerequisite, and `apply` drops, with a log line, a `did` whose prerequisite is no longer open. `undid` removes a `did` that was not written yet.
- `progress.json` stays `orchestre-progress/4`: 0.21.0 only adds optional fields (`until`, `holds`, `waiting`, `started_without`, `released` on an issue, `pending_done` at the top, and a log kind `wait`). A `/4` file of 0.20.0 stays valid, but 0.20.0 refuses a file that 0.21.0 wrote (`field unknown`).
- In the workflow, in `phase` and `auto` modes, a task held by an open non-human issue waits once it is ready and once its dependencies are done, and no apply is running (`<id> · wait` agent), up to the deadline, while the rest of the phase goes on. A ruling recorded while tasks run is applied right after the next close, or before a held task starts (`rulings · apply` agent, one at a time, in the main checkout). Released or past its deadline, the task starts without the ruling, noted in the log (`<id> starts (main checkout) without <n> rulings`). A wait that fails does not stop the run: the task starts without its rulings; a wait that gets no answer twice in a row trips the circuit breaker.
- An amendment that an apply makes during the run to a task already running is not added to its verification: if the task merges, its close lists it in `discarded_amendments`; otherwise it stays in the task file for the next run.
- A run that stops (stop issue or circuit breaker) starts no new wait or apply, and lets those running finish, up to their deadline, so that a late wait does not mark its task `waiting` after the end of the run.
- Three human stops come from an apply during the run: `Rulings not applied during the run`, `Rulings applied during the run: output of apply not read` and `Rulings refused by apply during the run`. An issue settled by an apply during the run leaves `open_issues` in the return.
- Mode `deviation`: see the modes list above. When the run stops while issues still wait, the first becomes `stop_issue` and the others go to `open_issues`; an issue ruled during the run but not applied before the stop stays there, and the next pre-flight applies its ruling.
- The pane (0.21.0): an issue's detail card carries its answers. Each option is a button (`[ A · recommended ]`, `[ B ]`…) with the effect of the recommended one in grey; an option the dry run refuses, or an issue without entry in ISSUES.json, is grey with its reason. `[ Other… ]` records a free answer, `[ Ask Claude ]` fills the prompt, `[ Decide later ]` releases the held task, `[ Accept the N recommended ]` rules them all at once (a human issue with a valid recommended option included), and `[ ✓ I did it ]` notes a manual action done. A line `last: <id> · option A recorded  [ Undo ]` becomes `applied` once `apply` wrote it. During a run, an issue that has options counts as `now` (one without options stays `at run stop`). A waiting task shows `‖` and a countdown (`holds AH04 · starts without it in 14:47`), the banner says `‖ AH04 waits for you`, and two notifications follow `/progress sound`: the arrival of the issues a task waits for and its start without a ruling. A task released by `[ Decide later ]` starts without a notification. The pane acts through `rule`, `unrule`, `release`, `did` and `undid`, which write `progress.json` only: nothing touches the checkout during a run.

**Workflow return** (0.20.0). `rulings_applied` lists the rulings `apply` applied at the start of the run, `[{ issue, task, option, text }]` (`option` null for a free answer, `text` null for an option). `rulings_refused`, `[{ issue, option, text, reason }]`, comes with status `awaiting-ruling` and no `stop_issue`: no task started, the other rulings are applied, and `/orchestre:run` says why each was refused and has settled again the issues still open. A `detail` that starts with "progress: rulings not applied (apply)": apply failed, nothing is written and no task started; the pilot settles its cause (the main checkout on the integration branch, a hook that refused the commit), and the rulings stay recorded for the next run. A `detail` that starts with "progress: output of apply not read": apply ran and committed, but the copy of its output did not match its digest, and no task started; the pilot reads the last commit `progress: rulings …` on the integration branch and the issues of `progress.json` before a new run.

The pilot ran in auto permission mode. In manual mode, any command that is not allowed suspends the run until you answer.

### `/orchestre:status [plans/<name>]`: see where the plan stands

At any time, including in the pilot session during a run: the command only reads, without switch, write or git lock. Without an argument, it takes the only plan in `plans/`. A script computes the table and Claude copies it as is. It reads the task statuses, steps, dates, runs, issues and auto-decisions from `progress.json` (contract `/3`); git stays the source of truth for a merged task (the commit "task <id>:" on the integration branch). Without a readable `progress.json`, or with a format it does not know, it falls back to `plan-lint` and the reviews of `HANDOFF.md`. Here, the plan of `tests/demo-progress.mjs` after its first run, with a ticket added to `HANDOFF.md`:

```text
## demo — 2/5 tasks · 40%
`█████████░░░░░░░░░░░░░░░` phase 1 in progress · last merge T02 just now

| Phase | Progress | Tasks |
| :-- | :-- | :-- |
| ⚠ 1 | `██████░░░░` 66% | 2/3 |
| ○ 2 | `░░░░░░░░░░` 0% | 0/2 |

**Now**: T03 waits for a human
**Later**: 1 review after phase 1 · 1 auto-decision before phase 2 · 1 ticket after the PR
```

✓ phase finished, ● started, ⚠ a task there waits for a human, is blocked or failed, ○ not started. While tasks are started, a line **In progress** lists them, for example "T04 (worktree, last commit 3 min ago)". A task is in progress when its branch `task/<id>` (or `tache/<id>` of 0.11) exists; the exact step of each agent can be read in `/workflows`. The reviews counted are the open reviews of `progress.json`, and the `review` entries of `HANDOFF.md` without it, two reviews of the same task that quote the same first passage counting as one. What waits for you is on up to three lines, by moment (0.19.0), as in the `/progress` pane:

- **Now**: what you can act on now;
- **At run stop**: during a run, the issues, the decisions to take and the plan-lint errors, which wait for the session;
- **Later**: what has a later moment, such as `EV1 before phase 2`, `2 reviews after phase 1`, `H3 before the next run` (`before the first run` without any run: a prerequisite that holds back no task left), `1 review before the PR`, and the tickets.

A line without an item is not written; when nothing waits, the single line `**Your turn**: nothing for now`.

### `/orchestre:done plans/<name>`: close what is left in "Your turn"

The reviews before the PR and the auto-decisions stay in "Your turn" until you close them; `/orchestre:status` counts them too. In the `/progress` pane, the buttons of the detail card do it one by one, without a turn ([The buttons of "Your turn"](#banner-pane-notifications)). The command does it in one answer:

- `/orchestre:done plans/<name>`, the plan alone, lists what is still open, numbered, the reviews of merged tasks first, and waits for a line such as `1-6 done, 8 ticket, all decisions done`. `done` marks an item done, `ticket` moves it to the tickets to open after the PR, `keep` leaves it open; what the answer leaves out stays open. A review is named by its number or a range: `all` covers the auto-decisions only. A number outside the list or an unknown action: nothing is written, and the command asks again.
- `/orchestre:done plans/<name> review|decision <task|-> <text>` marks one item done; with `ticket` before the kind, moves it to tickets. `-` stands for the source plan; the text can be a unique start of it. This is what the pane puts in the prompt when Claude Code finds no node to run `progress.mjs`.

The command writes through `progress.mjs` only, safe during a run, and carries its own permission (`allowed-tools`): nothing to add to the settings. An item closed stays in `progress.json` with its date, so that neither the next run nor a close brings it back.

## The progress display

The progress mod follows the run without a turn of Claude. It only reads `plans/<name>/progress.json`. `/orchestre:status` gives the plan, `/workflows` the step of each agent.

It draws in the terminal and in the Code tab of the desktop app. In the VS Code extension panel, under `claude -p` and in a cloud session, nothing is drawn.

### Banner, pane, notifications

- **Opening.** The pane opens by itself at the first run started in the session, without taking the keyboard from the prompt. Claude Code keeps a pane opened that way waiting in a terminal narrower than 144 columns (110 once you have opened it yourself), until the terminal is widened; a notification then says that `/progress` opens it.
- **The banner**, above the prompt: progress, then what waits for you ("⚑ to review", "⚠ your turn", which can be clicked), then the task in progress. "⤢ Details", at the end, opens the pane. At the end of a run, "✕ Hide" hides the banner; the status line then keeps "orchestre ✓ 5/5 · ⚑ 3" as long as something is left to do. These buttons are clicked; they have no key.
- **The spinner** gets a suffix: the task and step in progress, and the number of tasks running.
- **The pane**, in cards: "Your turn" first, when something waits for you, then the run, the tasks as timelines and the log. ↑ ↓, Page Up and Page Down scroll the pane; `l`, the counter of the log card, switches between its last entries and the whole log. The keys `1` to `9` show a line of "Your turn" in the detail card; a second press closes it. The card opens on when and where to act, in blue (0.17.0); its when follows the label of the item (0.19.0): "Now" for what can be done now, "At run stop" for what waits for the session during a run (an issue, a decision to take, a plan-lint error), "Before phase 3" for a prerequisite that holds back a task of phase 3, "After phase 2" for a review, "Before the PR" once everything is merged; "This session", "Outside Claude" for a manual action, or "the PR on GitHub" for a review, with what it waits for (a review waits for the run to stop: the agents work in the main checkout). Then the whole text, and under it the blocker, the tasks a prerequisite holds back, its steps and its evidence (`check`), the command the first button prepares, and the buttons. Beyond 9 items, "Your turn" goes by pages of 9 (`[ Next 3 › ]`). The run card gives what comes next after a run: `[ Resume command in the prompt ]`, or `[ PR draft in the prompt ]` once the plan is finished. `Esc` closes the pane. ← and → stay with Claude Code. `/progress text` gives the same state as text.
- **When to act** (0.19.0). Each line of "Your turn" ends with a label: `now`, `at run stop` (during a run, an issue, a decision to take or a plan-lint error waits for the session), `after phase 2`, `before phase 3`, `before the PR`, and `before the next run` (`before the first run` without any run) for a prerequisite that holds back no task left. A blocked, failed or waiting task stays `now`, except during a run when it carries an open issue: it is then `at run stop`, as its issue. The list is sorted by label, with a grey `── later ───` line under what is for now. The title counter starts with `N now ·`, the header badge, the banner (`⚠ N your turn`) and the status line count only what is for now, and the card says `✓ Nothing waits for you now` when nothing can be done yet. The detail card says the same moment as the label, and that of a prerequisite says what waits behind it (`blocks AH05E; phases 3 and 4 (10 tasks) wait behind it`). Two reviews of the same task that quote the same first passage show as one item, in the list and in the PR draft; `[ ✓ Done ]` and `[ → Ticket ]` close every review it stands for, and `[ Undo ]` brings them all back.
- **The tasks card** (0.19.0) gives the titles more room, in a narrow pane above all: a task not started writes its title over the room of its timeline and duration (29 cells at 58 columns instead of 10), a started task keeps 20 cells, its duration and its step but loses its timeline under 80 columns, and `waits for AH06 +3` never cuts an id.
- **The buttons of "Your turn"** (0.16.0), in brackets, without a key. In the detail card, the first one prepares the item's request in the prompt (`[ Review with Claude ]`, `[ Go over with Claude ]`, `[ Resume the run ]`…); nothing is sent without you. On a review before the PR or an auto-decision, three more act at once, without a turn of Claude: `[ ✓ Done ]` (it leaves "Your turn" and is ticked in the PR draft), `[ → Ticket ]` (it joins the tickets to open after the PR, listed in the PR draft) and `[ ✎ Edit text ]` (a field, then `[ Save ]`; HANDOFF.md keeps the original, so the next run does not bring the item back). `[ Undo ]`, under "Your turn", cancels the last of them. These buttons run `scripts/progress.mjs` of the plugin, the only writer of `progress.json`, from the root of the repository (`ack`, `ticket`, `relabel`, `reopen`), with the node of the PATH, otherwise `/opt/homebrew/bin/node` or `/usr/local/bin/node`. When Claude Code finds no node (an app started from the Dock may not have the PATH of the terminal), a notification says so and `[ ✓ Done ]` and `[ → Ticket ]` put in the prompt the `/orchestre:done` that does the same; `claude plugin validate plugins/orchestre` lists this call (`$.process.run`).
- **Close what is left at the end of a plan.** `/orchestre:done plans/<name>`, the plan alone, lists the reviews and the auto-decisions still open, numbered, those of merged tasks first, and closes them on a one-line answer: `1-6 done, 8 ticket, all decisions done` (`keep` leaves an item open). A review is named by its number or a range: `all` covers the auto-decisions only.
- **Notifications** come only for a task that waits for a human, is blocked or failed, and for a run stopped or in error. `/progress sound` adds a sound (macOS). At the first prompt after 15 min without a prompt, a notification says what changed.
- **Close the plan** (0.16.1). Once every task is merged or cancelled and no run is in progress, the run card offers `[ Close the plan ]`. The banner and the status line go at once; the pane shows "✓ Plan closed", with `[ PR draft in the prompt ]` and `[ Reopen ]`, and closes at your next prompt. From then on nothing shows for the plan, in this session or the next ones: `/progress` says it is closed, and `/progress plans/<name>` shows it again, with `[ Reopen ]`. What is left open in "Your turn" stays open, in the PR draft. A run that starts on the plan opens it again on its own. The button runs `progress.mjs close-plan` (and `reopen-plan`), which notes the date in `progress.json` (`closed`); `/orchestre:status` then says "plan finished, closed".
- **The plan followed** is the one whose `progress.json` was written last, skipping the plans closed. `/progress plans/<name>` picks a plan, closed or not; `/progress auto` goes back to the last one written.

### See it without a run

In any session where the mod is loaded, with or without a plan:

```
/progress demo
```

The mod plays in memory two runs of a made-up plan of 5 tasks, `showcase-site`, in a little over a minute: animated banner in colors, marked DEMO, notifications, a stop awaiting a ruling (a 12 s pause to open `/progress`), the resume, the end. The header of the pane gives the frame and, at some frames, what to try. A button says what it would do, without putting anything in the prompt or writing anything. Nothing is read or written in the repository meanwhile. A minute after the last frame, the real progress comes back; `/progress auto` goes back to it right away. The scenario is that of `tests/demo-progress.mjs`, which plays it with the real `progress.mjs`: the tests check that both give the same notifications and the same log.

### Troubleshooting

If the mod shows nothing ([mods troubleshooting](https://code.claude.com/docs/en/plugins/mods/troubleshoot)):

- `claude --version`: 2.1.287 or later;
- `claude plugin test`, run in a folder without a mod, must say "no hooks module to load"; otherwise a setting (`disableAllHooks`) or a policy of the organization blocks mods;
- the trust prompt of the folder must have been accepted;
- `/plugin` must name `orchestre` on the line of the active mods;
- "Unknown command: /progress": the mod is not loaded, see the points above; `claude plugin list` must show `orchestre@circle` in 0.12.0 or later (`/progress` was `/suivi` before);
- with `--plugin-dir`, a line of the transcript says why a drawing is refused (`refused:`) or a hook skipped (`hook skipped:`). For an installed mod, these lines only go to the log: `claude --debug-file mod.log`, then look for `orchestre` in `mod.log`.

## What a run does

The plugin runs a dev plan split into tasks (`plans/<name>/`, one file per task) from a pilot Claude Code session. A run equals a phase: each run of the workflow `orchestre:run-phase` covers work by subagents, verification, evaluation, fixes, merge into an integration branch and progress. For each ready task (dependencies merged, prerequisites done, resources free):

| Step | Agent | Model | Role |
| :- | :- | :- | :- |
| Reading | `plan-reader` | haiku | `plan-lint --reader` as JSON: tasks of the phase, statuses, dependencies; the workflow checks the copy against its digest, reads the plan a second time when it does not match, then stops before any task |
| Start, in a worktree | `clerk` | haiku | notes the start of the task in the progress, from the main checkout, before its worker is launched: Claude Code's isolation guard refuses a progress command to an agent isolated in a worktree |
| Work | `worker`, or `isolated-worker` in a worktree if tasks run in parallel | the task's model, as is (sonnet if it has none) | carries out the task on `task/<id>`, runs its verifications, returns a report |
| Verification | `verifier` | sonnet | checks that the task's files are committed (a file of the task left uncommitted is a failure), then replays the verification commands: exit code and excerpt of each |
| Evaluation | `evaluator` | opus | judges each criterion of done on evidence (diff, results of the verifier) |
| Model choice | `replanner` | opus | after a rejected attempt, chooses the model of the fix from the rejection; the task's model is the floor; without a valid answer, the `escalation` ladder |
| Fixes | `worker` | model chosen; without a model in the plan: sonnet then opus (`escalation`) | 2 fixes at most (`max_fixes`), on the gaps found |
| Merge | `integrator` | sonnet | `--no-ff` into `plan/<name>`, then the post-merge check; removes the task's worktree without force, and keeps it, as a review, when git finds uncommitted work there |
| Replanning | `replanner` | opus | rates the deviations, prepares the issues to settle with their options |
| Progress | `clerk`, or `scribe` | haiku, or sonnet | a task with neither findings nor flaky tests is closed by the clerk; otherwise the scribe adds the findings to `DISCOVERY.md`, then runs the close. `progress.mjs close` itself writes `HANDOFF.md`, the tasks created or amended, `ISSUES.json` and `PROGRESS.md`, and commits them (0.20.0) |
| End of run | `clerk` | haiku | closes the run with `progress.mjs run-end`, commits `PROGRESS.md` if it changed, removes the clean worktrees of the tasks (`worktrees.mjs`) |

Each task carries its model and the reason for it, chosen by opus when the plan is prepared. After a rejected attempt, the replanner chooses the model of the fix, never below the task's.

**Progress.** `plans/<name>/progress.json`, outside git, holds the state of the plan and of its runs (contract `orchestre-progress/4` since 0.20.0; a `/3` file is read and converted at the next write). Only `scripts/progress.mjs` writes it, together with the `PROGRESS.md` view. The workflow launches nothing itself: each agent first runs the step command its instructions carry (for the worker and each fix, it also records the model launched). The worker isolated in a worktree carries none: the clerk runs its step from the main checkout, just before it starts (0.18.2). The first agent of the run opens it, the scribe closes the task, the clerk closes the run.

**Safeguards.**

- No agent is allowed to push, merge into `main` or deploy. The settings deny `git push` in its usual forms (`git push`, `git -C <folder> push`, `git -c <option> push`, `git --git-dir=… push`, `git --work-tree=… push`) and `gh pr merge`; the workers have no MCP tools (`disallowedTools: mcp__*`); the instructions of every agent forbid it. A permission rule does not see every way a command can be written (code.claude.com/docs/en/permissions): with the Bash sandbox of Claude Code on (`/sandbox`), the commands and the processes they start reach only the hosts you allow.
- No agent opens, restores or copies real production or personal data: these actions are the human's.
- A deviation that touches data, a database, production or a secret is always major.
- No agent gets around a read or write ban: the file concerned goes to human review before the PR.
- No agent rewrites history (rebase, reset): a branch taken back receives the integration branch by a merge.
- A worktree that holds uncommitted work is never removed.
- Two plans of a repository never share a task id: the branches `task/<id>` belong to the repository. `/orchestre:prepare` gives a new plan a free prefix, and `plan-lint` refuses a plan that has never run while a branch `task/<id>` of one of its ids exists.
- An interrupted run is not resumed: a new one is launched, and the tasks already merged are skipped.

**Origin.** The orchestration was worked out on a pilot of 15 tasks in 4 phases (SPACE-Platform, plan `acces-par-metier`). Version history: [`CHANGELOG.md`](../CHANGELOG.md).

## Known limits

- The plugin first ran for real on 2026-09-29, on a plan of 37 tasks: phases 1 and 2 ran in 0.6.0. The prerequisites and `/orchestre:ready` (0.6.1) and the reviews (0.6.2) have not run for real yet. Nor has 0.12.0: the commands in English, the migration of a real plan of 0.11 and the mod in English were only checked by the tests. Nor has 0.13.0: the install from `/orchestre:prepare`, the settings written during a session and the pane opened by itself.
- The reviews are read by no agent: without you before the PR, a file forbidden to the agents goes out without a review.
- A ban that the worker reports as an ordinary deviation is only reclassified as a review if its description cites neither a database, nor production, nor a secret (`DATABASE_URL`, `JWT_SECRET`…). Otherwise the run stops for a human.
- `/orchestre:ready` spots the "safe" commands on the strength of the configuration and of `DISCOVERY.md`. When in doubt, it asks you to run them yourself with `!`.
- The settings (worktree, permissions) cannot come from a plugin: `scripts/settings.mjs` writes them into each project, from `/orchestre:install`, `/orchestre:prepare`, `/orchestre:ready` or `/orchestre:run`. Its check does not read the managed settings of an organization. Claude Code reloads the permission rules during the session; for `worktree.baseRef`, its documentation does not say, hence a run in a new session. If the Bash sandbox is on, it refuses the writes of the script into the settings files: the command gives the line to run yourself at the prompt with `!`, which runs outside the sandbox.
- The denials of the template, `Read(.env)` and `Read(.env.*)`, match at any depth (`apps/api/.env` included) and bind the file tools of Claude Code (code.claude.com/docs/en/permissions). They do not reach a script or a test that opens the file itself: for that, turn on the Bash sandbox of Claude Code and add the `.env` files to its `filesystem.denyRead`.
- The progress commands of the agents carry their JSON in a heredoc whose delimiter is quoted (0.18.0): the Bash tool of Claude Code decodes the `\uXXXX` sequences of a command before the shell reads it, which broke the `--json '…'` of 0.17 on a text with an apostrophe, a backtick or a `$`. The tests run these commands through a shell that decodes `\u` the same way. On a real run, Claude Code's isolation guard refused that heredoc to the workers isolated in a worktree ("too complex to verify that it stays inside the worktree"), and their tasks showed as not started while they ran: since 0.18.2 an isolated worker carries no progress command, and the clerk notes its start from the main checkout. Whether the rule `Bash(node <plugin>/scripts/progress.mjs *)` covers the heredoc form in manual permission mode is still to check on a real run.
- The actual tokens are not collected automatically: read them in `/workflows`, task by task. On the pilot, the actual figure was 3 to 8 times the estimate.
- In autonomous mode, the auto-decisions are only reviewed at the PR. The circuit breaker caps their number, not their quality.
- Sensitive deviations are spotted by keywords (data, database, production, secret…, in English and in French). The filter catches wide, but does not see a risk worded otherwise.
- Two tasks that share a database or a port run one after the other.
## Development

### Repository content

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
docs/                                reference, configuration, upgrading
brand/                               README banner and screenshot, social preview of the repository
.github/workflows/release.yml        tag and GitHub Release of each version
```

### Develop

- Try a change without installing it: `claude --plugin-dir plugins/orchestre`, then `/reload-plugins` after each change.
- Tests: `npm test` runs four groups, which can also be run alone:
  - `npm run test:scripts`: 35 cases of `plan-lint`, 22 of `/orchestre:status`, 70 of `progress.mjs`, 14 of `worktrees.mjs`, 21 of `migrate.mjs` and 22 of `settings.mjs`, in temporary git repositories;
  - `npm run test:workflow`: 162 scenarios of the workflow, with simulated agents, 8 of which run the real `progress.mjs` and `worktrees.mjs` (and one the real `plan-lint.mjs`) in a temporary repository;
  - `npm run test:commands`: the settings template, and 32 tests of the contract between the skills, the agents and the rest of the plugin;
  - `npm run test:mod`: 47 cases of the mod's view model on `progress.json` files written by `progress.mjs`, `/progress demo` compared with the real `progress.mjs` included.
- Validation: `npm run validate` (`claude plugin validate` on the plugin and on the marketplace, then `claude plugin test` of the plugin, which runs the 30 tests of the mod under the engine).
- Try the mod without installing it: `claude --plugin-dir plugins/orchestre`, then `/progress demo`; or, on a real `progress.json`, `node tests/demo-progress.mjs <folder>` in another terminal.
- The workflow script has no access to files and cannot import anything; `Date.now()`, `Math.random()` and `new Date()` are forbidden there. `planDigest` is therefore written twice, in `scripts/plan-lint.mjs` and in `workflows/run-phase.js`: change both, `tests/commands.test.mjs` checks they are the same. Before changing it, load the reference `/workflow-authoring`.

### Publish a version

1. Raise `version` in `plugins/orchestre/.claude-plugin/plugin.json`: without that, nobody gets the update.
2. Add the entry to `CHANGELOG.md`, under a heading `## <version> — <date>: <title>`, and update the version of the `orchestre` badge at the top of `README.md`.
3. `npm test && npm run validate`.
4. Commit and push to `main`. The Release workflow (`.github/workflows/release.yml`) then runs `npm test`, tags the commit `orchestre--v<version>` and opens the GitHub Release, with the `CHANGELOG.md` section of the version as notes. It fails, without a tag, when `CHANGELOG.md` has no section for the version or a test fails: fix and push again, the tag goes on the fixed commit.
5. On each machine: `/plugin marketplace update circle`.

Tags follow the convention of Claude Code, `<plugin>--v<version>`, so that a plugin which depends on orchestre with a version range can resolve it. To stay on one version, add the marketplace at its tag: `/plugin marketplace add Archibald0/circle-claude-plugin#orchestre--v0.13.0`. To open the Release of an older tag: *Actions* > *Release* > *Run workflow*, with the version.
