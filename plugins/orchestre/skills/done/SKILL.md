---
name: done
description: Closes the reviews before the PR and the auto-decisions of an orchestre plan, so that they leave "Your turn" in /progress and the count of /orchestre:status. With the plan folder alone, lists what is still open and applies a one-line answer (done, ticket, keep). To run when the user types /orchestre:done (the /progress pane prepares it when it cannot run progress.mjs itself), and at the end of a plan.
argument-hint: "<plan-dir> [ticket] [review|decision <task|-> <text>]"
disable-model-invocation: true
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/progress.mjs *)
---
You close, in the progress of an orchestre plan, the reviews before the PR and the auto-decisions that `$ARGUMENTS` names or that the user picks. You change nothing else: no plan file, no HANDOFF.md, no code. Each write goes through `node ${CLAUDE_PLUGIN_ROOT}/scripts/progress.mjs ack <plan-dir> --json '<object>'`, or `ticket` in place of `ack`; an apostrophe of a text is written `\u0027` in the JSON, so that the single quotes around it hold. The script is safe during a run: it takes the lock of the progress file.

The arguments, in order: the plan folder (`plans/<name>`); then, optionally, `ticket`; then the kind (`review` for a review before the PR, `decision` for an auto-decision), the task id (`-` for the source plan), then all the rest, which is the text of the review or the title of the decision, as written.

## One item

With a kind, a task and a text: run once `ack` (or `ticket` when the arguments start with `ticket`) with the object `{"kind": …, "task": …, "text": …}`, `task` being `null` for `-`. `ack` marks it done; `ticket` moves it to the tickets to open after the PR, which the PR draft of `/progress` lists. Your answer is its output line, copied as is, nothing else. A line "progress: ack: …" or "progress: ticket: …" is a refusal (the item is not found, or the start of the text is not unique): copy it, then give the whole text if the user gave a start, and stop there. Do not close something the user did not name.

## The triage (the plan folder alone)

1. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/progress.mjs validate <plan-dir>`, then read `<plan-dir>/progress.json` once. If it is missing or invalid, say so in one line and stop.
2. List what is open: the `reviews`, then the `auto_decisions`, without a `done` nor a `ticket` field. Number them from 1, in that order, the reviews of merged tasks first (status `merged` in `tasks`), then those of the other tasks, then those of the source plan (task null). One line each: number, task (or "source plan"), the text shown (`label` if there is one, otherwise the review's `text`, or for a decision `title: option (description)`). Under two headings, "Reviews before the PR" and "Auto-decisions". Nothing open: say so and stop.
3. Ask for the answer in one line, with an example built on this list: `1-6 done, 8 ticket, all decisions done`. The actions are `done`, `ticket` and `keep`; the targets are numbers and ranges, and `all decisions` for all the auto-decisions. A review is named by its number or a range only: it concerns files or commands the agents could not touch, often a secret, so `all` never covers the reviews. What the answer leaves out stays open. Then stop and wait for the answer: this is the end of your turn.
4. On the answer: a number outside the list, an unknown action, or `all` aimed at reviews: say which part is refused, write nothing, and ask again. Otherwise, one `ack` for all the items done and one `ticket` for all the items moved, each with `{"items": [{"kind": …, "task": …, "text": …}, …]}` (`text`: the review's text, or the decision's title, not the label), and nothing for `keep`. A list is applied whole or not at all: on a refusal, copy its line and stop.
5. Your answer: the output lines of the script, then one line, "<n> done, <m> moved to tickets, <k> left open."
