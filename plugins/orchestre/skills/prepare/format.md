# Format of an orchestre plan

A plan is a folder `plans/<name>/`, committed on the integration branch `plan/<name>`, created from the base branch (`main` by default):

```
plans/<name>/
├── tasks/T01-<slug>.md …   # one task per file, template below
├── PROGRESS.md             # one row per task; only the scribe and progress.mjs write it afterwards
├── HANDOFF.md              # the header and the decisions already taken
├── PREREQUISITES.md        # what the plan expects from a human or from the environment
├── DISCOVERY.md            # seeded with the exploration
└── orchestre.config.json
```

plan-lint (`node <plugin>/scripts/plan-lint.mjs plans/<name>`) reads the frontmatter of the tasks and the Status column of PROGRESS.md; with `--integration`, a task whose commit "task <id>: " is on the integration branch, and not on the base branch, counts as merged. It refuses: a task without `id`, `phase`, `verification` or `definition_of_done`; a `model` other than `haiku`, `sonnet`, `opus` and `fable`; a duplicate id; an unknown or cyclic dependency, or one on a later phase; two tasks of the same phase, without a dependency between them nor a shared resource, that own the same files; an unknown or duplicate prerequisite, or one of unknown type or status, or a decision marked "done" that no "decision" entry of HANDOFF.md cites. It also says, phase by phase, which tasks wait for an open prerequisite. It warns, without blocking anything, about a remaining task without `model` or without `model_reason`, and about a compound verification command; it never judges the choice of a model. A remaining task on `fable`, or an `escalation` that contains it, is refused if `orchestre.config.json` says `"fable": false`, and only reported if the setting is missing.

A plan written by orchestre 0.11 or earlier (French format: `taches/`, `SUIVI.md`, `PREREQUIS.md`, French keys and values) is refused by plan-lint, which gives the `migrate.mjs` command. `/orchestre:ready` and `/orchestre:run` offer that migration at their pre-flight.

## Language

`language` in `orchestre.config.json` (`"en"` when absent) is the language of the plan's free text: task titles, the launch prompt and the body sections, the criteria of `definition_of_done`, `model_reason`, HANDOFF descriptions, the Prerequisite and Evidence cells of PREREQUISITES.md, the content of DISCOVERY.md, and, during a run, the reports of the agents and the summaries and questions of `/orchestre:run`. Everything else stays in English, whatever the language: keys, values (statuses, types, severities, models, modes), section titles, table headers and legends, branch names, commit messages and commands. `/orchestre:prepare` asks for it for each plan. A plan migrated from orchestre 0.11 gets `"language": "fr"`: its free text stays in French.

## Splitting rules

- Phase = stage of the work (for example: model and rights, interfaces, acceptance). A phase only starts when every task of the previous phases is merged or cancelled.
- Vertical slices, each under 50 % of a context. No micro-tasks: each task costs a worker, a verification, an evaluation, a merge and a progress update.
- The order of execution only comes from `phase`, `depends_on` and `resources`: two tasks of the same phase, without a dependency between them nor a shared resource, can run at the same time, each in a worktree if the parallelism chosen at launch allows it. They must then own no file in common. Declare resources (database, port, service) as narrowly as possible: two tasks that share one run one after the other. `parallel_batch` and the Batch column of PROGRESS.md are indicative: nothing reads them.
- Each criterion of the definition of done is demonstrated by the diff or by a `verification` command run in the context of the task. The first `verification` command also serves as the post-merge check: put the most representative one there.
- Each `verification` command is a simple command: no `cd`, `export` or assignment in front, no chaining (`&&`, `;`, `|`), no code evaluated inline (`node -e`, `python -c`…). An agent isolated in a worktree would see a compound command refused by Claude Code's isolation guard; plan-lint reports it. A verification that needs several steps becomes a script of the project, owned by the task or by a tooling task.
- No `verification` command reads real production or personal data. A rehearsal on real data (production dump) is a step for the human, written in the deployment procedure, with commands checked in the repository.
- A test does not write into a shared database such as the development database: it uses a dedicated test database, which the test script recreates.
- A last task of global review, on opus, read-only. It also checks that comments, DECISIONS and procedures tell the truth.
- Ids: capital letters then digits, a suffix of letters allowed (T01, T02, T02B). Tasks added during a run take a suffix.
- One model per task, with its reason: see "Model of each task".
- Token estimate per task: 0.5 × max_turns × targeted context size, plus 30 % for the verification and the evaluation. On the pilot, the actual figure was 3 to 8 times higher: an order of magnitude, not a budget.

## Model of each task

Each task carries `model` and `model_reason`, one line that says why this model. `/orchestre:prepare` fills both, with these criteria:

- `haiku` for mechanical work: renaming, documentation, configuration;
- `sonnet` by default to implement;
- `opus` for architecture, ambiguous tasks and those that touch several modules.

`fable` costs more, with no gain observed over opus so far. `/orchestre:prepare` never chooses it on its own: it asks the user whether to use it for this plan, notes the answer in `orchestre.config.json` (`"fable": true` or `false`), and only puts on `fable` the tasks the user designates. An existing plan on `fable`, without that setting, still runs: plan-lint reports it, and `/orchestre:ready` has it settled.

During a run, the worker runs on the task's model, as is. After a rejected attempt, the replanner chooses the model of the next fix, from the rejection, among haiku, sonnet and opus, never below the task's model, which serves as a floor (fable, for a task the user put there); without a valid answer from it, the `escalation` ladder applies. The choice only holds for the run: the plan is not changed, and the next run starts again from the plan's model. A task without `model` (older plan) runs as before orchestre 0.11.0: worker on sonnet, fixes along the ladder, without a call to the replanner.

## Task template

```markdown
---
id: T01
title: …
phase: 1
model: sonnet           # haiku | sonnet | opus; fable only on a task designated by the user, with "fable": true
model_reason: "…"       # one line: why this model
effort: high            # low | medium | high | xhigh | max
depends_on: []
parallel_batch: 1A
owned_files:
  - path/**
resources: []           # shared database, port…: serializes the tasks
prerequisites: []       # ids of PREREQUISITES.md: the task waits until they are done
context_budget: 40%
token_estimate: 1.0M
max_turns: 60
verification:
  - "<real command, found during the exploration>"
definition_of_done:
  - "<criterion demonstrable by the diff or by a verification command>"
---

## Launch prompt
You carry out T01 on the branch task/T01. Read DISCOVERY.md first,
then the files listed in Useful context.
Change nothing outside owned_files. Ask no question:
if you are blocked, finish with the status blocked and say why.
Return your report in the requested format: status, changed files,
deviations from the plan, findings useful to the next tasks.

## Useful context
## Implementation notes
## Out of scope
```

The section titles stay in English; their content, the title and the criteria are written in the plan's `language`.

Lists of the frontmatter: for commands and criteria, one line `  - "…"` per item, between double quotes (`\"` for a double quote, `\\` for a backslash). The short form `[a, b]` suits ids and resources; an item that contains a comma in it goes between quotes.

## PROGRESS.md

```markdown
# PROGRESS — <name>

| ID  | Title | Phase | Batch | Depends on | Model  | Status | Attempts | Branch | Tokens est. / actual |
|-----|-------|-------|-------|------------|--------|--------|----------|--------|----------------------|
| T01 | …     | 1     | 1A    | —          | sonnet | todo   | 0        | —      | 1.0M / —             |

Statuses: todo · added · merged · blocked · failed · needs-human · cancelled
```

## PREREQUISITES.md

Everything the plan expects from a human or from the environment before a task can start. Each task concerned cites these ids in `prerequisites`: while one of them is `open`, the task does not start, and the tasks of its phase that depend on it wait with it; the rest runs. It starts again on its own at the first run after the prerequisite moves to `done`.

```markdown
# PREREQUISITES — <name>

| ID | Type | Prerequisite | Status | Evidence |
|----|------|--------------|--------|----------|
| D5 | decision | Choose the model provider of phase 4 | open | — |
| H1 | manual | Provider API key in `.env` (`PROVIDER_API_KEY`) | done | confirmed by the user on 2026-09-30 |
| E1 | environment | Test database started (`docker compose up -d db`) | open | `docker compose ps db` |

Types: decision · manual · environment. Statuses: open · done · dropped.
```

- Ids: capital letters then digits (D5, H1, E1), as for tasks, and distinct from the tasks' ids.
- `decision`: a choice that changes a task. It is settled at planning time; only a decision the user chooses to defer stays open, and it must then be cited in `prerequisites` by the tasks it affects (plan-lint refuses an open decision that nothing cites). Settled, it is written in HANDOFF.md, where the agents read it, as an entry that starts with its type: `decision · major · <ID>: …`. It then moves to `done`, with the evidence "HANDOFF".
- `manual`: what an agent never does — an access, a secret, a paid account, real data, a deployment.
- `environment`: a service, a tool or test data the verifications need.
- `Evidence`: what shows it is done — the HANDOFF entry, a file, a safe command, or the user's confirmation. Never the content of a secret.
- A `|` in a cell is written `\|`. `dropped` counts as `done`: the prerequisite is no longer needed.
- `/orchestre:ready` adds at the end of the file a line "Checked by /orchestre:ready on <date>: <verdict>".

## HANDOFF.md

```markdown
# HANDOFF — <name>
Entries: `deviation`, `blind-spot`, `decision`, `debt`, `needs-human`, `ticket`, `review`, rated `minor` or `major`.
```

Entries are filed under a heading `## <task id>`, or `## source plan` for those written before the run, in the format `type · severity · description`. During a run, the orchestrator also adds the types `rejection`, `amendment` and `blocker`. A `review` is about a file the agents may not read or write (project or organization settings), or about a command they may not run: the human does it before the PR, without the run stopping. `/orchestre:prepare` writes some at planning time, the orchestrator during a run.

## DISCOVERY.md

```markdown
# DISCOVERY — <name>
## Existing context
## Verified commands
## Quick map
## Observed conventions
## Pitfalls and fixes
## Context recommendations (end of run)
```

The test failures already present before the plan go in "Verified commands": they do not count against the tasks.

## orchestre.config.json

```json
{
  "max_parallelism": 4,
  "default_mode": "phase",
  "integration_branch": "plan/<name>",
  "base_branch": "main",
  "evaluator": "always",
  "max_fixes": 2,
  "escalation": ["sonnet", "opus"],
  "fable": false,
  "max_auto_decisions": 3,
  "pilot_context_cap": 0.65,
  "language": "en",
  "setup": ["<install the dependencies from the lockfile>", "<code generation>"],
  "shared_setup": { "<resource>": ["<setup of the shared service, for example the test database>"] }
}
```

- `default_mode`: `auto` (autonomous), `deviation` (stop on deviation) or `phase` (stop at each phase).
- `base_branch`: the branch the integration branch starts from; `main` by default, to set if the repository uses another one.
- `evaluator` is indicative: the evaluation is always systematic.
- `fable`: `true` if the user allows fable for this plan, `false` otherwise; asked by `/orchestre:prepare` (or `/orchestre:ready` for an older plan). With `false`, plan-lint refuses a remaining task on `fable` and an `escalation` that contains it.
- `pilot_context_cap`: share of the pilot session's context beyond which `/orchestre:run` offers to go on in a new session.
- `language`: language of the free text (see "Language"), a short code such as `en` or `fr`; `"en"` when absent.
- `setup`: commands of the project that bring a working folder up to date, without touching a shared service (dependencies, generated code). Each worker runs them once on its branch, the integrator after each merge, before the post-merge check. Without them, a worktree or a merge can keep stale dependencies or generated code.
- `shared_setup`: for each resource declared by the tasks (`resources`), the commands that prepare that shared service (migration of the test database…). They only run for a task that declares the resource, hence under its lock.
- Simple commands, like the verifications. The plugin knows no stack: it runs what the project declares.
