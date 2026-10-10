// Tests de etat.mjs (/orchestre:etat) sur un plan jouet, dans un dépôt git temporaire.
// Usage : node tests/etat.test.mjs [chemin de etat.mjs]
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'

const ETAT = resolve(process.argv[2] || 'plugins/orchestre/scripts/etat.mjs')
const racine = mkdtempSync(join(tmpdir(), 'etat-'))
const ailleurs = mkdtempSync(join(tmpdir(), 'hors-git-'))
const git = (...a) => execFileSync('git', a, { cwd: racine, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const etat = (args = [], cwd = racine) => { const r = spawnSync('node', [ETAT, ...args], { cwd, encoding: 'utf8' }); return { code: r.status, out: r.stdout.trim() } }
const tache = (id, phase, extra = '') => `---\nid: ${id}\ntitre: Tâche ${id}\nphase: ${phase}\nmodele: sonnet\ndepend_de: []\nfichiers_possedes:\n  - src/${id}/**\nressources: []${extra}\nestimation_tokens: 1.0M\nverification:\n  - "npm test"\ndefinition_du_fini:\n  - "le test passe"\n---\n`
const SUIVI = rows => `| ID | Titre | Phase | Statut | Essais | Branche |\n|----|-------|-------|--------|--------|---------|\n${rows.map(([id, ph, st]) => `| ${id} | Tâche ${id} | ${ph} | ${st} | 0 | — |`).join('\n')}\n`
let n = 0
const cas = (nom, fn) => { fn(); n++; console.log('ok ·', nom) }

try {
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(racine, 'README.md'), 'x\n'); git('add', '.'); git('commit', '-qm', 'init')
  const d = join(racine, 'plans', 'demo')
  mkdirSync(join(d, 'taches'), { recursive: true })
  const T = { T01: 1, T02: 1, T03: 2, T04: 2, T05: 2, T06: 2, T07: 3, T08: 3 }
  for (const [id, ph] of Object.entries(T)) writeFileSync(join(d, 'taches', `${id}-x.md`), tache(id, ph, id === 'T04' ? '\nprerequis: [D5]' : ''))
  writeFileSync(join(d, 'SUIVI.md'), SUIVI(Object.entries(T).map(([id, ph]) => [id, ph, id === 'T06' ? 'besoin-humain' : id === 'T08' ? 'annulée' : 'à-faire'])))
  writeFileSync(join(d, 'PREREQUIS.md'), '| ID | Type | Prérequis | Statut | Preuve |\n|----|------|-----------|--------|--------|\n| D5 | décision | Choisir le modèle | ouvert | — |\n')
  writeFileSync(join(d, 'HANDOFF.md'), '# Handoff\n\n## T01\n- relecture · majeur · agents/x/.env.example : ajouter MR_MAX\n- ticket · mineur · renommer le script\n\n## T02\nrelecture · majeur · commande `grep -q X a` refusée aux agents\n')
  writeFileSync(join(d, 'orchestre.config.json'), JSON.stringify({ branche_integration: 'plan/demo', branche_base: 'main' }))
  git('switch', '-qc', 'plan/demo'); git('add', '.'); git('commit', '-qm', 'plan')
  for (const id of ['T01', 'T02']) {
    git('switch', '-qc', `tache/${id}`); writeFileSync(join(racine, `${id}.txt`), id); git('add', '.'); git('commit', '-qm', `feat: ${id}`)
    git('switch', '-q', 'plan/demo'); git('merge', '-q', '--no-ff', `tache/${id}`, '-m', `tâche ${id} : Tâche ${id}`)
  }
  // T03 commencée avec un commit, T05 dans un worktree sans commit, T06 en attente d'un humain avec une branche
  git('switch', '-qc', 'tache/T03'); writeFileSync(join(racine, 'T03.txt'), 'T03'); git('add', '.'); git('commit', '-qm', 'feat: T03'); git('switch', '-q', 'plan/demo')
  git('branch', 'tache/T06')
  const wt = join(ailleurs, 'wt')
  git('worktree', 'add', '-q', '-b', 'tache/T05', wt, 'plan/demo')

  const avant = [git('status', '--porcelain'), git('rev-parse', 'HEAD'), git('symbolic-ref', 'HEAD')].join('|')

  cas('tableau complet : titre, barre, phases, en cours, à toi', () => {
    const r = etat(['plans/demo'])
    assert.equal(r.code, 0)
    const l = r.out.split('\n')
    assert.equal(l[0], '## demo — 2/7 tâches · 28 %')
    assert.match(l[1], /^`█{6}░{18}` phase 2 en cours · dernière fusion T02 (à l'instant|il y a \d+ min)$/)
    assert.ok(r.out.includes('| ✓ 1 | `██████████` 100 % | 2/2 |'), 'phase 1')
    assert.ok(r.out.includes('| ⚠ 2 | `░░░░░░░░░░` 0 % | 0/4 |'), 'phase 2 : T06 attend un humain')
    assert.ok(r.out.includes('| ○ 3 | `░░░░░░░░░░` 0 % | 0/1 |'), 'phase 3 : T08 annulée hors compte')
    assert.match(r.out, /\*\*En cours\*\* : T03 \(dernier commit (à l'instant|il y a \d+ min)\) · T05 \(worktree, démarrée\)$/m)
    assert.ok(r.out.includes('**À toi** : D5 (décision) bloque T04 · T06 attend un humain · 2 relectures avant la PR · 1 ticket après la PR'), 'à toi')
    assert.ok(!/T06 \(/.test(r.out), 'T06 en attente, pas en cours')
    assert.ok(r.out.split('\n').length <= 16, 'compact')
  })
  cas('lecture seule : ni statut, ni HEAD, ni branche changés ; aucun verrou laissé', () => {
    etat(['plans/demo'])
    assert.equal([git('status', '--porcelain'), git('rev-parse', 'HEAD'), git('symbolic-ref', 'HEAD')].join('|'), avant)
    assert.ok(!existsSync(join(racine, '.git', 'index.lock')))
  })
  cas('checkout sur une branche de tâche : « checkout » ; sans argument, le seul plan', () => {
    git('switch', '-q', 'tache/T03')
    const r = etat([])
    assert.match(r.out, /\*\*En cours\*\* : T03 \(checkout, dernier commit/)
    git('switch', '-q', 'plan/demo')
  })
  cas('depuis un sous-dossier : chemin relatif à la racine', () => {
    const r = etat(['plans/demo'], join(racine, 'plans'))
    assert.equal(r.out.split('\n')[0], '## demo — 2/7 tâches · 28 %')
  })
  cas('erreurs en une ligne, code 0 : plan introuvable, plusieurs plans, hors dépôt git', () => {
    let r = etat(['plans/absent']); assert.equal(r.code, 0); assert.equal(r.out, 'orchestre:etat : plan introuvable dans ce checkout : plans/absent')
    mkdirSync(join(racine, 'plans', 'autre', 'taches'), { recursive: true })
    r = etat([]); assert.equal(r.code, 0); assert.match(r.out, /^orchestre:etat : plusieurs plans \(plans\/autre, plans\/demo\)/)
    rmSync(join(racine, 'plans', 'autre'), { recursive: true })
    r = etat([], ailleurs); assert.equal(r.code, 0); assert.equal(r.out, 'orchestre:etat : pas dans un dépôt git')
  })
  cas('plan-lint en erreur : signalé dans « À toi »', () => {
    writeFileSync(join(d, 'taches', 'T09-x.md'), tache('T09', 3).replace('  - "npm test"\n', '').replace('verification:\n', 'verification: []\n'))
    const r = etat(['plans/demo'])
    assert.ok(r.out.includes('plan-lint : 1 erreur'), r.out)
    rmSync(join(d, 'taches', 'T09-x.md'))
  })
  cas('tâche sans modèle (0.11.0) : un avertissement de plan-lint, pas une erreur ; modèle inconnu : une erreur', () => {
    writeFileSync(join(d, 'taches', 'T09-x.md'), tache('T09', 3).replace('modele: sonnet\n', ''))
    let r = etat(['plans/demo'])
    assert.ok(r.out.includes('| ○ 3 | `░░░░░░░░░░` 0 % | 0/2 |') && !r.out.includes('plan-lint'), r.out)
    writeFileSync(join(d, 'taches', 'T09-x.md'), tache('T09', 3).replace('modele: sonnet', 'modele: gpt-5'))
    r = etat(['plans/demo'])
    assert.ok(r.out.includes('plan-lint : 1 erreur'), r.out)
    rmSync(join(d, 'taches', 'T09-x.md'))
  })
  cas('plan terminé', () => {
    for (const id of ['T03', 'T04', 'T05', 'T06', 'T07']) git('commit', '-q', '--allow-empty', '-m', `tâche ${id} : Tâche ${id}`)
    const r = etat(['plans/demo'])
    assert.equal(r.out.split('\n')[0], '## demo — 7/7 tâches · 100 %')
    assert.match(r.out.split('\n')[1], /^`█{24}` plan terminé · dernière fusion T07 /)
    assert.ok(!r.out.includes('**En cours**'))
  })
  console.log(`état : TOUT EST VERT (${n} cas)`)
} finally {
  rmSync(racine, { recursive: true, force: true }); rmSync(ailleurs, { recursive: true, force: true })
}
