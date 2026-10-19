# Upgrading orchestre

Update the plugin between two runs, never during one: `/plugin marketplace update circle`, then `/reload-plugins` ([Update](reference.md#update)). Version history: [`CHANGELOG.md`](../CHANGELOG.md). Back to the [README](../README.md).

## From 0.13 to 0.15

Nothing to do: no format changes, plans of 0.12 to 0.14 run as they are.

1. 0.14.0: in the `/progress` pane, 1 to 9 (or a click) show the whole text of a line of "Your turn" in a detail card; a second press acts.
2. 0.15.0: fewer tasks, each for a reason. `/orchestre:prepare`, the replanner and the pilot only give a piece of work a task of its own for parallel work, a contract, a risk or its size; the pilot asks before writing several tasks on the same files.
3. 0.15.1: a review before the PR or an auto-decision can be marked done with `/orchestre:done` (or `d` in the detail card of `/progress`); it then leaves "Your turn". The command carries its own permission (`allowed-tools`): nothing to add to the settings.

## From 0.12 to 0.13

0.13.0 checks and writes the settings through one script, `scripts/settings.mjs`, and `/orchestre:prepare` installs orchestre when it is missing.

1. Update the plugin. In each repository, the next `/orchestre:prepare`, `/orchestre:ready` or `/orchestre:run` finds the rules of 0.12 (the path of the scripts contains the version) and offers to replace them, in one agreement. `/orchestre:install` does it too.
2. `autoContinueAtUsageLimit`, which 0.12 and earlier wrote into `.claude/settings.local.json`: the settings reference of Claude Code gives it the scope "User or managed", so it most likely has no effect there; it is on by default. The plugin no longer writes it, and leaves the old line in place.
3. The `/progress` pane opens by itself at the first run started in the session.
4. 0.13.1: in the pane, `y`, `r` and `t` no longer scroll to a card, and the line of keys at the top is gone (↑ ↓, Page Up and Page Down scroll the pane). `l` stays, in the log card, for the whole log.

## From 0.11 to 0.12

0.12.0 moves the whole plugin to English, plan and progress formats included.

1. Update the plugin. The next `/orchestre:prepare`, `/orchestre:ready` or `/orchestre:run`, or `/orchestre:install`, finds through `scripts/settings.mjs` the rules of 0.11 (`Workflow(orchestre:executer-phase)`, the `suivi.mjs` rule). It offers to replace them with those of this version (`Workflow(orchestre:run-phase)`, the `progress.mjs` rule), with the rules of the model that are missing, in one agreement.
2. The commands change names:

   | 0.11 | 0.12 |
   | :- | :- |
   | `/orchestre:installer [--equipe]` | `/orchestre:install [--team]` |
   | `/orchestre:preparer` | `/orchestre:prepare` |
   | `/orchestre:pret [--sans-repetition]` | `/orchestre:ready [--no-dry-run]` |
   | `/orchestre:lancer [--reprendre]` | `/orchestre:run [--resume]` |
   | `/orchestre:etat` | `/orchestre:status` |
   | `/suivi` (`texte`, `son`, `demo`, `auto`) | `/progress` (`text`, `sound`, `demo`, `auto`) |

3. Plans: the scripts of 0.12 refuse a plan in the French format of 0.11 (`taches/`, `SUIVI.md`, `PREREQUIS.md`, `suivi.json`). `/orchestre:ready` or `/orchestre:run` detect it at their pre-flight and show a preview of the migration (`scripts/migrate.mjs`). After your agreement, they migrate it and commit the plan folder alone on the integration branch (`orchestre: migrate plan <name> to the 0.12 format`).
   - Keys, values, file names and section titles move to English (`tasks/`, `PROGRESS.md`, `PREREQUISITES.md`, `progress.json`). The free text stays as written, and the plan gets `"language": "fr"`.
   - The migration refuses a plan folder with uncommitted changes, and a run still marked in progress unless you confirm it is stopped.
4. Git history is not rewritten: the branches `tache/<id>` and the commits "tâche <id> : " stay, and the scripts still read them. A task started in 0.11 and not merged is not taken back: it starts again from the integration branch on `task/<id>`, and the old branch stays in git, for reference. `/orchestre:status` keeps showing that task in progress as long as the old branch exists.
5. The mod: `/suivi` becomes `/progress`. In the pane, `y` goes to "Your turn", `r` to the run (it went to "À toi"), `t` to the tasks, `l` to the log (it resumed the run), `c` prepares the resume of the run; `1` to `9` and `p` are unchanged. It only reads `progress.json`; for a plan of 0.11 not migrated yet, a notification says how to migrate it. The sound setting is kept.

orchestre 0.11 does not read a migrated plan: once a plan is migrated, it runs with 0.12 or later. For a plan shared with others, update every clone before migrating it. In a clone that pulls the migrated plan, run `/orchestre:ready plans/<name>` once: it converts the `suivi.json` that clone keeps outside git, which `plan-lint` refuses next to `tasks/`.
