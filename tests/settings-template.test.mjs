// Settings template of /orchestre:install: expected denials, and the exceptions of the .env templates placed after the rule they correct
import fs from 'node:fs'
import assert from 'node:assert/strict'

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const template = JSON.parse(read('../plugins/orchestre/skills/install/settings.local.template.json'))
const deny = template.permissions.deny
const allow = template.permissions.allow
// .env at any depth (0.18.0): a bare file name matches like .gitignore, Read(./.env) only the .env of the current folder
// (code.claude.com/docs/en/permissions)
for (const rule of ['Bash(git push *)', 'Bash(git -C * push *)', 'Read(.env)', 'Read(.env.*)']) assert.ok(deny.includes(rule), `missing denial: ${rule}`)
// A push written another way than "git push" (0.18.0): the forms the documentation of permissions cites, and a merge through gh
for (const rule of ['Bash(git -c * push *)', 'Bash(git --git-dir* push *)', 'Bash(git --work-tree* push *)', 'Bash(gh pr merge *)']) assert.ok(deny.includes(rule), `missing denial: ${rule}`)
assert.equal(deny.some(r => r.startsWith('Read(./')), false, 'a .env denial anchored at the current folder: Read(.env) covers every depth')
// A "!" exception only cancels the rules listed before it in the same file
const envRule = deny.indexOf('Read(.env.*)')
for (const file of ['.env.example', '.env.sample', '.env.template', '.env.dist']) {
  const exception = deny.indexOf(`Read(!${file})`)
  assert.ok(exception > envRule, `exception Read(!${file}) missing or placed before Read(.env.*)`)
}
// No wildcard between git and its subcommand in an allow rule (0.18.0): "Bash(git -C * diff *)" also matched
// "git -C . -c core.fsmonitor=<program> diff", and git runs that program (code.claude.com/docs/en/permissions)
for (const r of allow.filter(r => r.startsWith('Bash(git '))) assert.match(r, /^Bash\(git [a-z][a-z-]*(?: |\))/, `${r}: a git option or a wildcard before the subcommand`)
// Branch taken back: the worker checks that it contains the integration branch before merging it in
assert.ok(allow.includes('Bash(git merge-base *)'), 'missing permission: git merge-base')
assert.equal(template.worktree.baseRef, 'head')
// Resume on a usage limit: a setting of the user or the organization (scope "User or managed", code.claude.com/docs/en/settings-reference),
// on by default; it does not apply from .claude/settings.local.json, so the template leaves it out (0.13.0)
assert.equal(template.autoContinueAtUsageLimit, undefined)
// The workflow allowed is the plugin's one, by its name in run-phase.js (0.12.0), never the executer-phase of 0.11
const workflow = read('../plugins/orchestre/workflows/run-phase.js').match(/export const meta = \{\s*name: '([^']+)'/)
assert.ok(workflow, 'name of the workflow not found in run-phase.js')
assert.ok(allow.includes(`Workflow(orchestre:${workflow[1]})`), `missing permission: Workflow(orchestre:${workflow[1]})`)
const rules = JSON.stringify(template)
for (const old of ['executer-phase', 'suivi.mjs', 'etat.mjs']) assert.ok(!rules.includes(old), `rule of orchestre 0.11 left in the template: ${old}`)
// Every git command the workflow has its agents run is allowed: in manual permission mode, a missing rule suspends the run
const workflowSource = read('../plugins/orchestre/workflows/run-phase.js')
const gitCommands = [...workflowSource.matchAll(/`git (-C "[^"]*" )?([a-z-]+)/g)]
assert.ok(gitCommands.length > 10, 'git commands of the workflow not found')
for (const [, inFolder, sub] of gitCommands) {
  const allowed = inFolder ? allow.some(r => r.startsWith(`Bash(git -C * ${sub} `)) : allow.some(r => r.startsWith(`Bash(git ${sub} `) || r === `Bash(git ${sub})`)
  assert.ok(allowed, `git ${inFolder ? '-C <folder> ' : ''}${sub}, run by the agents of the workflow: no rule in the template`)
}
// The whole command, not only its subcommand (0.22.0): `git checkout -- <file>` has the subcommand of `git checkout HEAD -- *` and is still not allowed.
// Each backticked git command of the workflow and of agents/challenger.md (the other agent files are not read), cut at its first placeholder
// (<...> or ${...}), starts with the literal part (before its first "*") of an allow rule; a command with no placeholder may also equal that
// literal part without its trailing space. `git -C <folder> ` (folder quoted or not, placeholder or not) is stripped first, and the rest is
// compared with the literal part of a `Bash(git -C * <sub> *)` rule after `git -C * `.
const gitRules = allow.filter(r => r.startsWith('Bash(git ') && r.endsWith(')')).map(r => r.slice(5, -1))
const ruleAllows = (rule, cmd) => {
  const literal = rule.split('*')[0]
  return cmd.startsWith(literal) || (rule.includes('*') && cmd === literal.trimEnd())
}
const cutAtPlaceholder = s => s.split(/<|\$\{/)[0]
const folderForm = /^git -C (?:"[^"]*"|<[^>\s]*>|\S+) /
const commandAllowed = (cmd, rules) => {
  const folder = cmd.match(folderForm)
  if (!folder) return rules.some(rule => ruleAllows(rule, cutAtPlaceholder(cmd)))
  const rest = cutAtPlaceholder(cmd.slice(folder[0].length))
  return rules.some(rule => rule.startsWith('git -C * ') && ruleAllows(`git ${rule.slice('git -C * '.length)}`, `git ${rest}`))
}
const gitCommandsOf = text => [...text.matchAll(/`(git [^`]*)`/g)].map(m => m[1].replace(/\\$/, ''))
// The -C form with a placeholder folder keeps its rule, and is refused without it
assert.ok(commandAllowed('git -C "${r.path}" diff --quiet', ['git -C * diff *']))
assert.ok(commandAllowed('git -C <folder> diff', ['git -C * diff *']))
assert.ok(commandAllowed('git -C "a folder" diff --quiet', ['git -C * diff *']))
assert.ok(!commandAllowed('git -C "${r.path}" diff --quiet', ['git -C * log *']))
assert.ok(!commandAllowed('git -C <folder> diff', ['git diff *']))
for (const file of ['../plugins/orchestre/workflows/run-phase.js', '../plugins/orchestre/agents/challenger.md']) {
  const found = gitCommandsOf(read(file))
  assert.ok(found.length > 3, `git commands of ${file} not found`)
  for (const cmd of found) assert.ok(commandAllowed(cmd, gitRules), `${file}: \`${cmd}\` starts with no rule of the template`)
}
for (const [cmd, rule] of [['`test -e ', 'Bash(test -e *)']]) if (workflowSource.includes(cmd)) assert.ok(allow.includes(rule), `missing permission: ${rule}`)
console.log('settings template: ALL GREEN')
