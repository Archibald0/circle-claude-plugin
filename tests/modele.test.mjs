// Settings template of /orchestre:installer: expected denials, and the exceptions of the .env templates placed after the rule they correct
import fs from 'node:fs'
import assert from 'node:assert/strict'

const template = JSON.parse(fs.readFileSync(new URL('../plugins/orchestre/skills/installer/settings.local.modele.json', import.meta.url), 'utf8'))
const deny = template.permissions.deny
for (const rule of ['Bash(git push *)', 'Bash(git -C * push *)', 'Read(./.env)', 'Read(./.env.*)']) assert.ok(deny.includes(rule), `refus manquant : ${rule}`)
// A "!" exception only cancels the rules listed before it in the same file
const envRule = deny.indexOf('Read(./.env.*)')
for (const file of ['.env.example', '.env.sample', '.env.template', '.env.dist']) {
  const exception = deny.indexOf(`Read(!${file})`)
  assert.ok(exception > envRule, `exception Read(!${file}) absente ou placée avant Read(./.env.*)`)
}
// Branch taken back: the worker checks that it contains the integration branch before merging it in
assert.ok(template.permissions.allow.includes('Bash(git merge-base *)'), 'autorisation manquante : git merge-base')
assert.equal(template.worktree.baseRef, 'head')
assert.equal(template.autoContinueAtUsageLimit, true)
console.log('modèle de réglages : TOUT EST VERT')
