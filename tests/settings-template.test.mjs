// Settings template of /orchestre:install: expected denials, and the exceptions of the .env templates placed after the rule they correct
import fs from 'node:fs'
import assert from 'node:assert/strict'

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const template = JSON.parse(read('../plugins/orchestre/skills/install/settings.local.template.json'))
const deny = template.permissions.deny
const allow = template.permissions.allow
for (const rule of ['Bash(git push *)', 'Bash(git -C * push *)', 'Read(./.env)', 'Read(./.env.*)']) assert.ok(deny.includes(rule), `missing denial: ${rule}`)
// A "!" exception only cancels the rules listed before it in the same file
const envRule = deny.indexOf('Read(./.env.*)')
for (const file of ['.env.example', '.env.sample', '.env.template', '.env.dist']) {
  const exception = deny.indexOf(`Read(!${file})`)
  assert.ok(exception > envRule, `exception Read(!${file}) missing or placed before Read(./.env.*)`)
}
// Branch taken back: the worker checks that it contains the integration branch before merging it in
assert.ok(allow.includes('Bash(git merge-base *)'), 'missing permission: git merge-base')
assert.equal(template.worktree.baseRef, 'head')
assert.equal(template.autoContinueAtUsageLimit, true)
// The workflow allowed is the plugin's one, by its name in run-phase.js (0.12.0), never the executer-phase of 0.11
const workflow = read('../plugins/orchestre/workflows/run-phase.js').match(/export const meta = \{\s*name: '([^']+)'/)
assert.ok(workflow, 'name of the workflow not found in run-phase.js')
assert.ok(allow.includes(`Workflow(orchestre:${workflow[1]})`), `missing permission: Workflow(orchestre:${workflow[1]})`)
const rules = JSON.stringify(template)
for (const old of ['executer-phase', 'suivi.mjs', 'etat.mjs']) assert.ok(!rules.includes(old), `rule of orchestre 0.11 left in the template: ${old}`)
console.log('settings template: ALL GREEN')
