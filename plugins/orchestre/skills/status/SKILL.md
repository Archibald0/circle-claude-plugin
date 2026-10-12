---
name: status
description: Shows the progress of an orchestre plan as a compact table (phases, tasks in progress, what waits for the user), read-only, including during a run. To run when the user types /orchestre:status.
argument-hint: "[<plan-dir>]"
disable-model-invocation: true
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs *)
---
!`node ${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs $ARGUMENTS`

Your answer is the dashboard above, copied as is: nothing before, nothing after, neither summary nor comment. A line that starts with "orchestre:status:" is an error: copy it alone.

If you see instead a command that did not run (for example "[shell command execution disabled by policy]"), run `node ${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs $ARGUMENTS` once and copy its output the same way. Run nothing else and read no file: a run may be working in this checkout, and the table is enough. The step of each agent can be read in `/workflows`.
