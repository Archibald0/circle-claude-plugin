---
name: done
description: Marks a review before the PR or an auto-decision of an orchestre plan as done, so that it leaves "Your turn" in /progress and the count of /orchestre:status. To run when the user types /orchestre:done (the d key of the detail card of /progress prepares it).
argument-hint: "<plan-dir> review|decision <task|-> <text>"
disable-model-invocation: true
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/progress.mjs *)
---
You mark as done, in the progress of an orchestre plan, what `$ARGUMENTS` names. You change nothing else: no plan file, no HANDOFF.md, no code.

The arguments, in order: the plan folder (`plans/<name>`), the kind (`review` for a review before the PR, `decision` for an auto-decision), the task id (`-` for the source plan), then all the rest, which is the text of the review or the title of the decision, as written.

Run once `node ${CLAUDE_PLUGIN_ROOT}/scripts/progress.mjs ack <plan-dir> --json '<object>'`, with the object `{"kind": …, "task": …, "text": …}`: `task` is `null` for `-`, and an apostrophe of the text is written `\u0027` in the JSON, so that the single quotes around it hold. The script is safe during a run: it takes the lock of the progress file.

Your answer is its output line, copied as is, nothing else. A line "progress: ack: …" is a refusal (the item is not found, or the start of the text is not unique): copy it, then give the whole text if the user gave a start, and stop there. Do not mark something done that the user did not name.
