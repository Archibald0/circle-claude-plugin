// Tests de suivi.mjs (suivi.json au format orchestre-suivi/2, migration du /1, vue SUIVI.md), dans des dépôts git temporaires.
// Usage : node tests/suivi.test.mjs [chemin de suivi.mjs]
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, unlinkSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync, spawn } from 'node:child_process'

const SUIVI = resolve(process.argv[2] || 'plugins/orchestre/scripts/suivi.mjs')
const ETAT = join(dirname(SUIVI), 'etat.mjs')
const LINT = join(dirname(SUIVI), 'plan-lint.mjs')
const temporaires = []
const temp = p => { const d = mkdtempSync(join(tmpdir(), p)); temporaires.push(d); return d }
const longueur = s => [...s].length
let n = 0
const cas = async (nom, fn) => { await fn(); n++; console.log('ok ·', nom) }

// modele null : pas de ligne modele dans le frontmatter (0.11.0) ; raison : la ligne raison_modele
const tache = ({ id, titre = `Tâche ${id}`, phase = 1, modele = 'sonnet', raison = null, depend_de = [], lot = null, estimation = '1.0M', prerequis = null }) => `---
id: ${id}
titre: ${titre}
phase: ${phase}
${modele ? `modele: ${modele}\n` : ''}${raison ? `raison_modele: ${raison}\n` : ''}depend_de: [${depend_de.join(', ')}]
${lot ? `lot_parallele: ${lot}\n` : ''}fichiers_possedes:
  - src/${id}/**
ressources: []
${prerequis ? `prerequis: [${prerequis}]\n` : ''}${estimation ? `estimation_tokens: ${estimation}\n` : ''}verification:
  - "npm test"
definition_du_fini:
  - "le test passe"
---

## Prompt de lancement
Tu réalises ${id}.
`

// Un dépôt git jouet : main, une branche d'intégration plan/<nom> et un plan dans plans/<nom>
function depot(nom, { taches, suivi, handoff = '', prerequis = null, config = {} }) {
  const racine = temp('suivi-')
  const git = (...a) => execFileSync('git', a, { cwd: racine, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(racine, 'README.md'), 'x\n'); git('add', '.'); git('commit', '-qm', 'init')
  const d = join(racine, 'plans', nom)
  mkdirSync(join(d, 'taches'), { recursive: true })
  for (const t of taches) writeFileSync(join(d, 'taches', `${t.id}-x.md`), tache(t))
  if (suivi != null) writeFileSync(join(d, 'SUIVI.md'), suivi)
  writeFileSync(join(d, 'HANDOFF.md'), handoff)
  if (prerequis) writeFileSync(join(d, 'PREREQUIS.md'), prerequis)
  writeFileSync(join(d, 'orchestre.config.json'), JSON.stringify({ branche_integration: `plan/${nom}`, ...config }))
  git('switch', '-qc', `plan/${nom}`); git('add', '.'); git('commit', '-qm', 'plan')
  const plan = `plans/${nom}`
  const entree = E => (E === undefined ? '' : typeof E === 'string' ? E : JSON.stringify(E))
  return {
    racine, git, d, plan,
    lire: f => readFileSync(join(d, f), 'utf8'),
    doc: () => JSON.parse(readFileSync(join(d, 'suivi.json'), 'utf8')),
    ecrireTache: t => writeFileSync(join(d, 'taches', `${t.id}-x.md`), tache(t)),
    suivi: (cmd, E, { cwd = racine, arg = plan, args = [] } = {}) => {
      const r = spawnSync(process.execPath, [SUIVI, cmd, ...(arg ? [arg] : []), ...args], { cwd, encoding: 'utf8', input: entree(E) })
      return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
    },
    lancer: (cmd, E, cwd = racine) => new Promise(res => {
      const c = spawn(process.execPath, [SUIVI, cmd, plan], { cwd })
      let out = '', err = ''
      c.stdout.on('data', x => { out += x }); c.stderr.on('data', x => { err += x })
      c.on('close', code => res({ code, out, err }))
      c.stdin.end(entree(E))
    }),
    lint: () => JSON.parse(spawnSync(process.execPath, [LINT, plan, '--json', '--integration', `plan/${nom}`], { cwd: racine, encoding: 'utf8' }).stdout),
    propre: () => git('status', '--porcelain', '--untracked-files=all'),
    restes: () => readdirSync(d).filter(f => f === '.suivi.lock' || /^\.suivi\..*\.tmp$/.test(f)),
  }
}
const RUN = { phase: 1, mode: 'phase', parallelisme: 4, corrections_max: 2, decisions_office_max: 3 }
const SUIVI_GABARIT = ids => `# SUIVI — demo

| ID  | Titre | Phase | Lot | Dépend de | Modèle | Statut  | Essais | Branche | Tokens est. / réels |
|-----|-------|-------|-----|-----------|--------|---------|--------|---------|---------------------|
${ids.map(id => `| ${id} | Tâche ${id} | 1 | 1A | — | sonnet | à-faire | 0 | — | 1,0 M / — |`).join('\n')}

Statuts : à-faire · ajoutée · fusionnée · bloquée · échec · besoin-humain · annulée
`

// SUIVI.md réel du pilote (plan acces-par-metier, 29/09), jusqu'à la section « Phases » : 7 lignes ajoutées par le scribe
// non alignées, T07 qui ne suit pas son frontmatter amendé, T10 en « 0.3 M »
const PILOTE_SUIVI = "# SUIVI — acces-par-metier\n\n| ID  | Titre                                       | Phase | Lot | Dépend de     | Modèle | Statut    | Essais | Branche   | Tokens est. / réels     |\n| --- | ------------------------------------------- | ----- | --- | ------------- | ------ | --------- | ------ | --------- | ----------------------- |\n| T00 | Outillage — scripts de vérification         | 1     | 1A  | —             | sonnet | fusionnée | 3      | tache/T00 | 1,2 M / voir /workflows |\n| T01 | Fondations — schéma, règles de droits, seed | 1     | 1B  | T00           | opus   | fusionnée | 2      | tache/T01 | 3,5 M / voir /workflows |\n| T00B | Outillage — assainir .prettierignore        | 1     | 1A  | T00           | sonnet | fusionnée | 1      | tache/T00B | 0,3 M / —               |\n| T02 | Admin cloisonné — gardes serveur            | 2     | 2A  | T01           | sonnet | fusionnée | 1      | tache/T02 | 2,6 M / voir /workflows |\n| T03 | Admin — notions par métier (écriture + UI)  | 2     | 2A  | T01           | sonnet | fusionnée | 1      | tache/T03 | 1,8 M / voir /workflows |\n| T04 | Admin cloisonné — pages, nav, e2e           | 3     | 3A  | T02, T03      | sonnet | fusionnée | 2      | tache/T04 | 2,6 M / voir /workflows |\n| T05 | Parcours membre filtré par métier           | 3     | 3B  | T02           | sonnet | fusionnée | 1      | tache/T05 | 2,6 M / voir /workflows |\n| T05B | Correctif — lecture isSuperAdmin, test setActionCompletion | 3 | 3C | T04, T05 | sonnet | fusionnée | 1 | tache/T05B | 0,5 M / voir /workflows |\n| T06 | Recette, répétition migration, build, docs  | 4     | 4A  | T03, T04, T05 | sonnet | fusionnée | 3      | tache/T06 | 2,6 M / voir /workflows |\n| T06B | Restauration de répétition gardée — script versionné et test sur dump synthétique | 4 | 4A | T06 | sonnet | fusionnée | 1 | tache/T06B | 1,2 M / voir /workflows |\n| T06C | Test de non-affichage des données par rehearsal-restore.sh | 4 | 4A | T06B | sonnet | fusionnée | 1 | tache/T06C | 0,5 M / voir /workflows |\n| T07 | Revue globale                               | 4     | 4B  | T06C          | opus   | fusionnée | 1      | tache/T07 | 2,6 M / voir /workflows |\n| T08 | Restauration de répétition atomique sur erreur de lecture, tests d'ON_ERROR_STOP et du filtre | 4 | 4C | T07 | sonnet | fusionnée | 2 | tache/T08 | 1,2 M / voir /workflows |\n| T09 | Admin cloisonné — test versionné du périmètre, suppression de canAdminister, affectation de notion transactionnelle | 4 | 4C | T07 | sonnet | fusionnée | 1 | tache/T09 | 2,1 M / voir /workflows |\n| T10 | Docs de reprise — déploiement avec répétition gardée, règle ADMIN_EMAILS, purge des copies locales | 4 | 4D | T08, T09 | sonnet | fusionnée | 2 | tache/T10 | 0.3 M / voir /workflows |\n\n**Total estimé : 23,1 M tokens**, dont 14,9 M sur sonnet et 6,1 M sur opus (T01 et T07).\n\nStatuts : à-faire · en-cours · vérification · évaluation · correction · fusion · fusionnée · bloquée · besoin-humain · ajoutée\n\n## Phases (étapes de réalisation)\n\n1. **Outillage et fondations** : T00, puis T01.\n2. **Gardes et affectation** : T02 et T03, en parallèle.\n3. **Interfaces et parcours** : T04 et T05.\n4. **Recette et revue** : T06, puis T07.\n\n## Calibration\n\nFormule : 0,5 × max_tours × (budget_contexte × fenêtre), plus 30 % pour la vérification et l'évaluation. On suppose une **fenêtre de 200 k tokens**. La phase 1 sert d'étalon : on compare le réel de T00 et T01 à l'estimation, puis on recalibre les phases suivantes.\n"
const PILOTE = [
  ['T00', 'Outillage — scripts de vérification (e2e local, typecheck)', 1, 'sonnet', [], '1A', '1.2M'],
  ['T00B', 'Outillage — assainir .prettierignore (outillage orchestrateur non suivi) et reformater les fichiers de plan déjà committés', 1, 'sonnet', ['T00'], '1A', '0.3M'],
  ['T01', 'Fondations — schéma (super-admin + exclusions par métier), règles de droits pures, seed', 1, 'opus', ['T00'], '1B', '3.5M'],
  ['T02', 'Admin cloisonné — gardes serveur (access.ts, server actions, super-admin)', 2, 'sonnet', ['T01'], '2A', '2.6M'],
  ['T03', 'Admin — affecter / retirer une notion par métier (écriture + UI dans /admin/notions)', 2, 'sonnet', ['T01'], '2A', '1.8M'],
  ['T04', 'Admin cloisonné — pages, nav, sélecteur, table utilisateurs, e2e', 3, 'sonnet', ['T02', 'T03'], '3A', '2.6M'],
  ['T05', 'Parcours membre filtré par métier — éval, carte, missions, Cap, validation', 3, 'sonnet', ['T02'], '3B', '2.6M'],
  ['T05B', 'Correctif — lecture isSuperAdmin sur AdminUserRow, et test du filtre de visibilité de setActionCompletion', 3, 'sonnet', ['T04', 'T05'], '3C', '0.5M'],
  ['T06', 'Recette — parcours croisé, répétition de la migration sur dump prod, build, docs', 4, 'sonnet', ['T03', 'T04', 'T05'], '4A', '2.6M'],
  ['T06B', 'Restauration de répétition gardée — script versionné et test sur dump synthétique', 4, 'sonnet', ['T06'], '4A', '1.2M'],
  ['T06C', 'Test de non-affichage des données par rehearsal-restore.sh', 4, 'sonnet', ['T06B'], '4A', '0.5M'],
  ['T07', 'Revue globale — sécurité des droits, invariants, données prod, cohérence', 4, 'opus', ['T06', 'T06B', 'T06C'], '4B', '2.6M'],
  ['T08', "Restauration de répétition atomique sur erreur de lecture, tests d'ON_ERROR_STOP et du filtre", 4, 'sonnet', ['T07'], '4C', '1.2M'],
  ['T09', 'Admin cloisonné — test versionné du périmètre, suppression de canAdminister, affectation de notion transactionnelle', 4, 'sonnet', ['T07'], '4C', '2.1M'],
  ['T10', 'Docs de reprise — déploiement avec répétition gardée, règle ADMIN_EMAILS, purge des copies locales', 4, 'sonnet', ['T08', 'T09'], '4D', '0.3M'],
].map(([id, titre, phase, modele, depend_de, lot, estimation]) => ({ id, titre, phase, modele, depend_de, lot, estimation }))
const PILOTE_HANDOFF = `# HANDOFF — acces-par-metier

Entrées : \`écart\`, \`angle-mort\`, \`décision\`, \`dette\`, \`besoin-humain\`, classées \`mineur\` ou \`majeur\`.

## plan source

relecture · majeur · .env.example : vérifier SESSION_SECRET avant la PR

## T00

décision · mineur · snapshot de typecheck.sh sous $TMPDIR
blocage · majeur · e2e : 95 passed / 1 failed

## T01

écart · majeur · teams: [] ajouté aux fixtures de notions-editor.test.tsx
- relecture · majeur · docs/DEPLOY.md : relire la procédure de sauvegarde
`
const lignesTableau = texte => { const l = texte.split('\n'), h = l.findIndex(x => x.startsWith('| ID')); let f = h; while (l[f + 1] && l[f + 1].startsWith('|')) f++; return { l, h, f } }
const cellulesDe = ligne => ligne.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())

async function main() {
  // ─── Pilote ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const P = depot('acces-par-metier', { taches: PILOTE, suivi: PILOTE_SUIVI, handoff: PILOTE_HANDOFF })

  await cas('reconstruction sans suivi.json : SUIVI.md, HANDOFF.md et plan-lint ; SUIVI.md et checkout intacts', () => {
    assert.ok(!existsSync(join(P.d, 'suivi.json')))
    const r = P.suivi('debut-run', { ...RUN, phase: 4, mode: 'auto', parallelisme: 1, decisions_office_max: 2 })
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, 'suivi : run 1 ouvert (phase 4, mode auto)')
    assert.equal(P.lire('SUIVI.md'), PILOTE_SUIVI, 'un début de run ne touche pas SUIVI.md')
    assert.equal(P.propre(), '', 'suivi.json est ignoré par git')
    const doc = P.doc()
    assert.equal(doc.format, 'orchestre-suivi/2')
    assert.deepEqual([doc.plan, doc.dossier, doc.integration, doc.base], ['acces-par-metier', 'plans/acces-par-metier', 'plan/acces-par-metier', null])
    assert.deepEqual(doc.taches.map(t => t.id), ['T00', 'T01', 'T00B', 'T02', 'T03', 'T04', 'T05', 'T05B', 'T06', 'T06B', 'T06C', 'T07', 'T08', 'T09', 'T10'], 'ordre des lignes de SUIVI.md')
    const t = id => doc.taches.find(x => x.id === id)
    assert.equal(t('T00').titre, 'Outillage — scripts de vérification', 'le titre court de SUIVI.md reste')
    assert.deepEqual([t('T00').essais, t('T00').branche, t('T00').tokens_reels, t('T00').estimation_tokens, t('T00').lot], [3, 'tache/T00', 'voir /workflows', 1.2, '1A'])
    assert.equal(t('T00B').tokens_reels, null)
    assert.deepEqual(t('T07').depend_de, ['T06', 'T06B', 'T06C'], 'le frontmatter fait foi')
    assert.ok(doc.taches.every(x => x.statut === 'fusionnée' && x.etape === null && x.ajoutee_par === null && x.attend.length === 0))
    assert.deepEqual(doc.runs.map(x => [x.numero, x.statut, x.phase, x.mode, x.fin]), [[1, 'en-cours', 4, 'auto', null]])
    assert.deepEqual(doc.relectures.map(x => [x.tache, x.phase, x.run, x.quand]), [[null, null, null, null], ['T01', 1, null, null]])
    assert.equal(doc.relectures[1].texte, 'docs/DEPLOY.md : relire la procédure de sauvegarde')
    assert.deepEqual(doc.handoff['plan source'], { relecture: { mineur: 0, majeur: 1 } })
    assert.deepEqual(doc.handoff.T00, { décision: { mineur: 1, majeur: 0 }, blocage: { mineur: 0, majeur: 1 } })
    assert.deepEqual(doc.lint, { ok: true, erreurs: [] })
    assert.match(doc.journal[0].texte, /^suivi\.json reconstruit depuis SUIVI\.md, HANDOFF\.md et plan-lint/)
    assert.match(doc.maj, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    assert.equal(P.suivi('valider').code, 0)
  })

  await cas('vue : le tableau du SUIVI.md du pilote est régénéré, le texte autour gardé octet pour octet', () => {
    const avant = lignesTableau(PILOTE_SUIVI)
    const sortie = P.suivi('vue', undefined, { args: ['--stdout'] })
    assert.equal(sortie.code, 0, sortie.err)
    assert.equal(P.lire('SUIVI.md'), PILOTE_SUIVI, '--stdout n\'écrit rien')
    const r = P.suivi('vue')
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, 'suivi : SUIVI.md régénéré (15 tâches)')
    const texte = P.lire('SUIVI.md'), apres = lignesTableau(texte)
    assert.equal(texte, sortie.out + '\n', '--stdout montre ce qui sera écrit')
    assert.equal(apres.l.slice(0, apres.h).join('\n'), avant.l.slice(0, avant.h).join('\n'), 'texte avant le tableau')
    assert.equal(apres.l.slice(apres.f + 1).join('\n'), avant.l.slice(avant.f + 1).join('\n'), 'texte après le tableau')
    const t0 = avant.l.slice(avant.h, avant.f + 1), t1 = apres.l.slice(apres.h, apres.f + 1)
    assert.equal(t1.length, 17)
    assert.equal(new Set(t1.map(longueur)).size, 1, 'toutes les lignes du tableau ont la même largeur')
    assert.match(t1[1], /^\| -{4} \| -+ \| -+ /, 'séparateur au style du fichier, ID à la largeur de T00B')
    assert.deepEqual(cellulesDe(t1[0]), cellulesDe(t0[0]), 'en-tête')
    // Diff d'espaces seulement, sauf les deux cellules fausses : T07 « Dépend de » et T10 « 0.3 M »
    for (let i = 2; i < t0.length; i++) {
      const a = cellulesDe(t0[i]), b = cellulesDe(t1[i])
      if (a[0] === 'T07') { assert.equal(b[4], 'T06, T06B, T06C'); a[4] = b[4] }
      if (a[0] === 'T10') { assert.equal(b[9], '0,3 M / voir /workflows'); a[9] = b[9] }
      assert.deepEqual(b, a, `ligne ${a[0]}`)
    }
    assert.ok(P.lint().taches.every(x => x.statut === 'fusionnée'), 'plan-lint relit la vue')
    assert.equal(P.suivi('vue').code, 0)
    assert.equal(P.lire('SUIVI.md'), texte, 'régénérer deux fois ne change rien')
  })

  // ─── État du plan, comme etat.mjs ───────────────────────────────────────────────────────────────────────────────
  const ailleurs = temp('suivi-wt-')
  const E8 = { T01: 1, T02: 1, T03: 2, T04: 2, T05: 2, T06: 2, T07: 3, T08: 3 }
  const B = depot('demo', {
    taches: Object.entries(E8).map(([id, phase]) => ({ id, phase, ...(id === 'T04' ? { prerequis: 'D5' } : {}) })),
    suivi: `| ID | Titre | Phase | Statut | Essais | Branche |\n|----|-------|-------|--------|--------|---------|\n${Object.entries(E8).map(([id, ph]) => `| ${id} | Tâche ${id} | ${ph} | ${id === 'T06' ? 'besoin-humain' : id === 'T08' ? 'annulée' : 'à-faire'} | 0 | — |`).join('\n')}\n`,
    prerequis: '| ID | Type | Prérequis | Statut | Preuve |\n|----|------|-----------|--------|--------|\n| D5 | décision | Choisir le modèle | ouvert | — |\n',
    handoff: '# Handoff\n\n## T01\n- relecture · majeur · agents/x/.env.example : ajouter MR_MAX\n- ticket · mineur · renommer le script\n\n## T02\nrelecture · majeur · commande `grep -q X a` refusée aux agents\n',
    config: { branche_base: 'main' },
  })
  for (const id of ['T01', 'T02']) {
    B.git('switch', '-qc', `tache/${id}`); writeFileSync(join(B.racine, `${id}.txt`), id); B.git('add', '.'); B.git('commit', '-qm', `feat: ${id}`)
    B.git('switch', '-q', 'plan/demo'); B.git('merge', '-q', '--no-ff', `tache/${id}`, '-m', `tâche ${id} : Tâche ${id}`)
  }
  B.git('switch', '-qc', 'tache/T03'); writeFileSync(join(B.racine, 'T03.txt'), 'T03'); B.git('add', '.'); B.git('commit', '-qm', 'feat: T03'); B.git('switch', '-q', 'plan/demo')
  B.git('branch', 'tache/T06')
  B.git('worktree', 'add', '-q', '-b', 'tache/T05', join(ailleurs, 'wt'), 'plan/demo')
  const etatMjs = (args = [B.plan]) => spawnSync(process.execPath, [ETAT, ...args], { cwd: B.racine, encoding: 'utf8' }).stdout.trim()

  await cas('etat : même contenu qu\'etat.mjs, sans suivi.json puis après un run clos ; lecture seule', () => {
    const attendu = etatMjs()
    assert.match(attendu, /^## demo — 2\/7 tâches · 28 %/)
    let r = B.suivi('etat')
    assert.equal(r.code, 0)
    assert.equal(r.out, attendu)
    assert.equal(B.suivi('etat', undefined, { arg: null }).out, etatMjs([]), 'sans argument, le seul plan')
    assert.ok(!existsSync(join(B.d, 'suivi.json')), 'etat n\'écrit rien')
    assert.equal(B.suivi('debut-run', { ...RUN, phase: 2 }).code, 0)
    assert.deepEqual(B.doc().taches.filter(t => t.statut === 'fusionnée').map(t => t.id), ['T01', 'T02'], 'git fait foi : commits « tâche <id> : » sur l\'intégration')
    assert.equal(B.suivi('fin-run', { statut: 'partiel', en_attente: ['T06'], en_attente_prerequis: [{ id: 'T04', prerequis: ['D5'] }] }).code, 0)
    r = B.suivi('etat')
    assert.equal(r.out, etatMjs(), 'avec un suivi.json sans run en cours')
    assert.equal(B.propre(), '')
    const doc = B.doc()
    assert.deepEqual(doc.runs[0].en_attente_prerequis, [{ id: 'T04', prerequis: ['D5'] }])
    assert.deepEqual(doc.taches.find(t => t.id === 'T04').attend, ['D5'], 'T04 attend D5')
    assert.deepEqual(doc.prerequis, [{ id: 'D5', type: 'décision', statut: 'ouvert', texte: 'Choisir le modèle', bloque: ['T04'] }])
    assert.equal(etatMjs(), attendu, 'etat.mjs inchangé par le suivi')
    assert.equal(B.suivi('etat', undefined, { arg: 'plans/absent' }).out, 'orchestre:etat : plan introuvable dans ce checkout : plans/absent')
  })

  await cas('etat pendant un run : l\'étape de chaque tâche, une tâche relancée sort de « À toi »', () => {
    assert.equal(B.suivi('debut-run', { ...RUN, phase: 2, mode: 'auto' }).code, 0)
    assert.equal(B.suivi('etape', { tache: 'T03', etape: 'worker', isole: true }).code, 0)
    assert.equal(B.suivi('etape', { tache: 'T03', etape: 'vérification' }).code, 0)
    assert.equal(B.suivi('etape', { tache: 'T06', etape: 'worker', isole: false }).code, 0)
    const r = B.suivi('etat').out
    assert.match(r.split('\n')[1], / · run 2 \(auto\) ouvert à l'instant$/)
    assert.match(r, /\*\*En cours\*\* : T03 \(vérification, worktree, démarrée à l'instant\) · T05 \(worktree, démarrée\) · T06 \(worker, checkout, démarrée à l'instant\)$/m)
    assert.ok(!r.includes('T06 attend un humain'), r)
    assert.ok(r.includes('**À toi** : D5 (décision) bloque T04 · 2 relectures avant la PR · 1 ticket après la PR'), r)
    assert.equal(B.suivi('fin-run', { statut: 'partiel' }).code, 0)
    assert.equal(B.suivi('etat').out, etatMjs(), 'run clos : de nouveau comme etat.mjs')
  })

  // ─── Écritures ──────────────────────────────────────────────────────────────────────────────────────────────────
  const IDS = ['T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08']
  const C = depot('demo', { taches: IDS.map(id => ({ id, lot: '1A' })), suivi: SUIVI_GABARIT(IDS), handoff: '# HANDOFF — demo\n' })
  const tC = id => C.doc().taches.find(t => t.id === id)
  const ligneSuivi = id => C.lire('SUIVI.md').split('\n').find(l => l.startsWith(`| ${id} `))

  await cas('debut-run, étapes et clôture : checkout propre pendant le run, SUIVI.md régénéré à la clôture seulement', () => {
    assert.equal(C.suivi('debut-run', RUN).out, 'suivi : run 1 ouvert (phase 1, mode phase)')
    const vue0 = C.lire('SUIVI.md')
    assert.equal(C.suivi('etape', { tache: 'T01', etape: 'worker', isole: false }).out, 'suivi : T01 → worker')
    for (const e of ['vérification', 'évaluation']) assert.equal(C.suivi('etape', { tache: 'T01', etape: e }).code, 0)
    assert.equal(C.suivi('etape', { tache: 'T01', etape: 'correction', refus: { essai: 1, par: 'évaluation', manques: ['commentaire faux sur le flag'] } }).code, 0)
    assert.equal(C.suivi('etape', { tache: 'T01', etape: 'fusion' }).code, 0)
    assert.equal(C.propre(), '', 'une étape ne touche que suivi.json, ignoré par git')
    assert.equal(C.lire('SUIVI.md'), vue0)
    let t = tC('T01')
    assert.deepEqual([t.etape, t.isole, t.essais, t.fin, t.refus], ['fusion', false, 2, null, [{ essai: 1, par: 'évaluation', manques: ['commentaire faux sur le flag'] }]])
    assert.match(t.debut, /^\d{4}-\d{2}-\d{2}T/)
    const r = C.suivi('cloture', { tache: 'T01', statut: 'fusionnée', essais: 2, branche: 'tache/T01', replanification: true, relectures: ['agents/x/.env.example : ajouter MR_MAX'] })
    assert.equal(r.out, 'suivi : T01 fusionnée ; SUIVI.md régénéré')
    t = tC('T01')
    assert.deepEqual([t.statut, t.etape, t.essais, t.branche, t.tokens_reels], ['fusionnée', null, 2, 'tache/T01', 'voir /workflows'])
    assert.ok(t.fin >= t.debut)
    assert.equal(ligneSuivi('T01'), '| T01 | Tâche T01 | 1     | 1A  | —         | sonnet | fusionnée | 2      | tache/T01 | 1,0 M / voir /workflows |')
    assert.match(C.lire('SUIVI.md').split('\n')[3], /^\|-+\|-+\|/, 'séparateur compact du gabarit gardé')
    assert.equal(C.propre(), ' M plans/demo/SUIVI.md\n', 'seul SUIVI.md est à commiter')
    assert.equal(C.lint().taches.find(x => x.id === 'T01').statut, 'fusionnée')
    const doc = C.doc()
    assert.deepEqual(doc.relectures, [{ tache: 'T01', phase: 1, texte: 'agents/x/.env.example : ajouter MR_MAX', run: 1, quand: t.fin }])
    assert.deepEqual([...new Set(doc.journal.map(e => e.genre))], ['run', 'tache', 'etape', 'refus', 'statut', 'relecture'])
    assert.ok(doc.journal.some(e => e.texte === 'T01 : replanification terminée'))
    assert.equal(C.suivi('valider').code, 0)
    C.git('commit', '-qam', 'suivi(T01) : fusionnée')
  })

  await cas('appel depuis un worktree : suivi.json et SUIVI.md du checkout principal', () => {
    const wt = join(temp('suivi-wt-'), 'wt')
    C.git('worktree', 'add', '-q', '-b', 'tache/T02', wt, 'plan/demo')
    mkdirSync(join(wt, 'src'))
    assert.equal(C.suivi('etape', { tache: 'T02', etape: 'worker', isole: true }, { cwd: wt }).code, 0)
    assert.equal(C.suivi('etape', { tache: 'T02', etape: 'vérification' }, { cwd: join(wt, 'src'), arg: '../plans/demo' }).code, 0)
    assert.ok(!existsSync(join(wt, 'plans', 'demo', 'suivi.json')))
    assert.deepEqual([tC('T02').etape, tC('T02').isole], ['vérification', true])
    const vueWt = readFileSync(join(wt, 'plans', 'demo', 'SUIVI.md'), 'utf8')
    assert.equal(C.suivi('cloture', { tache: 'T02', statut: 'bloquée', essais: 1, branche: 'tache/T02', blocage: ['npm test : 2 échecs'] }, { cwd: wt }).code, 0)
    assert.match(ligneSuivi('T02'), /\| bloquée +\| 1 +\| tache\/T02 \|/)
    assert.equal(readFileSync(join(wt, 'plans', 'demo', 'SUIVI.md'), 'utf8'), vueWt, 'le SUIVI.md du worktree ne bouge pas')
    assert.deepEqual(tC('T02').blocage, ['npm test : 2 échecs'])
    C.git('commit', '-qam', 'suivi(T02) : bloquée')
  })

  await cas('8 écritures en parallèle, sans perte ni verrou laissé', async () => {
    const avant = C.doc().journal.length
    const rs = await Promise.all(IDS.map(id => C.lancer('etape', { tache: id, etape: 'worker', isole: true })))
    assert.ok(rs.every(r => r.code === 0), rs.map(r => r.err).join('\n'))
    const doc = C.doc()
    assert.ok(doc.taches.every(t => t.etape === 'worker' && t.isole === true))
    assert.deepEqual([doc.taches[0].essais, doc.taches[0].refus, doc.taches[0].fin], [1, [], null], 'un nouveau worker repart à 1 essai')
    assert.equal(doc.journal.length - avant, 8)
    assert.deepEqual(doc.journal.slice(-8).map(e => e.tache).sort(), IDS)
    assert.deepEqual(C.restes(), [])
    assert.equal(C.suivi('valider').code, 0)
  })

  await cas('écriture invalide refusée : code 1 ou 2, suivi.json et SUIVI.md intacts', () => {
    const avant = [C.lire('suivi.json'), C.lire('SUIVI.md')]
    const refus = [
      ['etape', { tache: 'T03', etape: 'dodo' }, 1, /taches\[\d\]\.etape : « dodo » n'est pas permis/],
      ['etape', { tache: 'T99', etape: 'worker' }, 1, /tâche inconnue du suivi : T99/],
      ['cloture', { tache: 'T03', statut: 'fusionnée', essais: -1, branche: 'tache/T03' }, 1, /essais : -1 est inférieur à 0/],
      ['cloture', { tache: 'T03', statut: 'en-cours', essais: 1 }, 1, /statut « en-cours » non permis/],
      ['cloture', { tache: 'T03', statut: 'fusionnée', essais: 1, refus: [{ essai: 1, par: 'humeur', manques: [] }] }, 1, /refus\[0\]\.par/],
      ['debut-run', { ...RUN, mode: 'turbo' }, 1, /runs\[\d\]\.mode : « turbo »/],
      ['debut-run', { phase: 1, mode: 'phase' }, 1, /parallelisme : manquant/],
      ['fin-run', { statut: 'en-cours' }, 1, /statut « en-cours » inconnu/],
      ['pilote', { tache: 'T03', statut: 'bloquée' }, 1, /non permis \(fusionnée ou annulée\)/],
      ['etape', 'pas du JSON', 2, /JSON invalide/],
      ['etape', '', 2, /objet JSON attendu/],
      ['inconnue', {}, 2, /^suivi : usage/],
    ]
    for (const [cmd, E, code, motif] of refus) {
      const r = C.suivi(cmd, E)
      assert.equal(r.code, code, `${cmd} ${JSON.stringify(E)} : ${r.err}`)
      assert.match(r.err, motif)
    }
    assert.deepEqual([C.lire('suivi.json'), C.lire('SUIVI.md')], avant)
    assert.deepEqual(C.restes(), [])
    assert.equal(C.suivi('valider').code, 0)
  })

  await cas('run resté en cours : interrompu au début du run suivant, étapes remises à zéro, statuts relus', () => {
    // Écart entre suivi.json et SUIVI.md : au début d'un run, SUIVI.md et git font foi
    const ecart = C.doc(); ecart.taches.find(t => t.id === 'T02').statut = 'à-faire'
    writeFileSync(join(C.d, 'suivi.json'), JSON.stringify(ecart, null, 2) + '\n')
    const r = C.suivi('debut-run', RUN)
    assert.equal(r.out, 'suivi : run 2 ouvert (phase 1, mode phase)')
    const doc = C.doc()
    assert.deepEqual(doc.runs.map(x => [x.numero, x.statut, x.fin]), [[1, 'interrompu', null], [2, 'en-cours', null]])
    assert.ok(doc.taches.every(t => t.etape === null))
    assert.ok(doc.journal.some(e => e.genre === 'run' && e.texte === 'run 1 interrompu : resté en cours, sans fin de run'))
    assert.deepEqual(doc.taches.filter(t => t.statut !== 'à-faire').map(t => [t.id, t.statut]), [['T01', 'fusionnée'], ['T02', 'bloquée']], 'statuts relus dans SUIVI.md')
    assert.ok(doc.journal.some(e => e.genre === 'statut' && e.texte === 'T02 : à-faire → bloquée (SUIVI.md et git)'))
  })

  await cas('tâches ajoutées : après celle qui les a créées et ses tâches déjà nées ; points, arbitrage, décisions d\'office', () => {
    C.ecrireTache({ id: 'T03B', phase: 1, depend_de: ['T03'], estimation: '0.5M' })
    let r = C.suivi('cloture', {
      tache: 'T03', statut: 'fusionnée', essais: 1, branche: 'tache/T03',
      taches_ajoutees: [{ id: 'T03B', titre: 'Suite de T03', phase: 1 }],
      points: [{ titre: 'Garde sur le flag', contexte: 'le flag est optionnel', humain: false, options: [{ id: 'A', description: 'Ajouter un test', impact: 'faible', recommande: true, entrees: [{ type: 'dette', gravite: 'mineur', description: 'x' }], taches_ajoutees: [] }, { id: 'B', description: 'Accepter' }] }],
      decisions_office: [{ titre: 'Seuil de relance', option: 'A', description: 'plafond à 30 s' }],
    })
    assert.equal(r.code, 0, r.err)
    C.ecrireTache({ id: 'T03C', phase: 1, depend_de: ['T03'] })
    r = C.suivi('arbitrage', { tache: 'T03', titre: 'Garde sur le flag', option: { id: 'A', description: 'Ajouter un test' }, taches_ajoutees: [{ id: 'T03C', titre: 'Test du flag', phase: 1 }] })
    assert.equal(r.out, 'suivi : arbitrage T03 option A ; SUIVI.md régénéré')
    C.ecrireTache({ id: 'T03D', phase: 1, depend_de: ['T03B'] })
    assert.equal(C.suivi('cloture', { tache: 'T03B', statut: 'fusionnée', essais: 1, branche: 'tache/T03B', taches_ajoutees: [{ id: 'T03D', titre: 'Suite de T03B', phase: 1 }] }).code, 0)
    // Rappel du scribe : pas de doublon
    assert.equal(C.suivi('cloture', { tache: 'T03B', statut: 'fusionnée', essais: 1, branche: 'tache/T03B', taches_ajoutees: [{ id: 'T03D', titre: 'Suite de T03B', phase: 1 }] }).code, 0)
    const doc = C.doc()
    const ordre = ['T01', 'T02', 'T03', 'T03B', 'T03D', 'T03C', 'T04', 'T05', 'T06', 'T07', 'T08']
    assert.deepEqual(doc.taches.map(t => t.id), ordre)
    assert.deepEqual(C.lire('SUIVI.md').split('\n').filter(l => /^\| T\d/.test(l)).map(l => cellulesDe(l)[0]), ordre)
    assert.deepEqual(['T03B', 'T03C', 'T03D'].map(id => [doc.taches.find(t => t.id === id).statut, doc.taches.find(t => t.id === id).ajoutee_par]), [['fusionnée', 'T03'], ['ajoutée', 'T03'], ['ajoutée', 'T03B']])
    assert.deepEqual(doc.taches.find(t => t.id === 'T03D').attend, [])
    assert.deepEqual(doc.taches.find(t => t.id === 'T03C').depend_de, ['T03'])
    assert.equal(cellulesDe(ligneSuivi('T03B'))[9], '0,5 M / voir /workflows')
    assert.equal(cellulesDe(ligneSuivi('T03C'))[1], 'Test du flag')
    const L = C.lint()
    assert.deepEqual(['T03C', 'T03D'].map(id => L.taches.find(t => t.id === id).statut), ['ajoutée', 'ajoutée'])
    assert.deepEqual(doc.points, [{ run: 2, tache: 'T03', titre: 'Garde sur le flag', contexte: 'le flag est optionnel', humain: false, role: 'a-trancher', statut: 'tranché', option_choisie: 'A', options: [{ id: 'A', description: 'Ajouter un test', impact: 'faible', recommande: true }, { id: 'B', description: 'Accepter' }] }])
    assert.deepEqual(doc.decisions_office, [{ run: 2, tache: 'T03', titre: 'Seuil de relance', option: 'A', description: 'plafond à 30 s' }])
    const run = doc.runs[1]
    assert.deepEqual(run.arbitrages_appliques, [{ tache: 'T03', titre: 'Garde sur le flag', option: 'A' }])
    assert.deepEqual(run.taches_ajoutees.map(x => x.id), ['T03B', 'T03C', 'T03D'])
    assert.equal(doc.journal.filter(e => e.genre === 'ajout' && e.tache === 'T03D').length, 2)
    C.git('add', '-A'); C.git('commit', '-qm', 'suivi(T03B) : fusionnée')
  })

  await cas('fin de run : bilan, exception du workflow close la tâche, point d\'arrêt', () => {
    assert.equal(C.suivi('etape', { tache: 'T04', etape: 'worker', isole: false }).code, 0)
    assert.equal(C.suivi('etape', { tache: 'T05', etape: 'worker', isole: true }).code, 0)
    const vue0 = C.lire('SUIVI.md')
    const arret = { tache: 'T05', titre: 'Contrôle post-fusion en échec après T05', contexte: 'npm test', humain: true, options: [{ id: 'reparer', description: 'Réparer', impact: '', recommande: true, entrees: [] }] }
    const r = C.suivi('fin-run', {
      statut: 'arbitrage', phase: 1, mode: 'phase', arbitrage: arret, points_a_trancher: [],
      taches: [{ id: 'T04', statut: 'échec', essais: 0, branche: null, resume: 'Error: boom', blocage: ['erreur du workflow : Error: boom'] }],
      non_lancees: ['T06', 'T07', 'T08'], reportees: [], taches_ajoutees: [{ id: 'T03B', phase: 1, titre: 'Suite de T03' }], arbitrages_appliques: [{ tache: 'T03', titre: 'Garde sur le flag', option: 'A' }],
      decisions_office: [{ tache: 'T03', titre: 'Seuil de relance', option: 'A', description: 'plafond à 30 s' }], amendements_ecartes: [{ tache: 'T03', id: 'T01', raison: 'déjà fusionnée', definition_du_fini: ['x'] }],
      en_attente: [], en_attente_prerequis: [],
    })
    assert.equal(r.out, 'suivi : run 2 arbitrage ; SUIVI.md régénéré, à commiter')
    const doc = C.doc(), run = doc.runs[1]
    // Tâches ajoutées : le bilan (une seule) complète celles du run (trois, dont une d'arbitrage que le bilan ne connaît pas), sans les remplacer
    assert.deepEqual([run.statut, run.non_lancees, run.amendements_ecartes, run.taches_ajoutees.map(x => x.id)], ['arbitrage', ['T06', 'T07', 'T08'], [{ tache: 'T03', id: 'T01', raison: 'déjà fusionnée' }], ['T03B', 'T03C', 'T03D']])
    assert.ok(run.fin >= run.debut)
    const t4 = doc.taches.find(t => t.id === 'T04'), t5 = doc.taches.find(t => t.id === 'T05')
    assert.deepEqual([t4.statut, t4.etape, t4.blocage], ['échec', null, ['erreur du workflow : Error: boom']])
    assert.deepEqual([t5.statut, t5.etape], ['à-faire', null], 'étape sans clôture remise à zéro')
    assert.notEqual(C.lire('SUIVI.md'), vue0)
    assert.match(ligneSuivi('T04'), /\| échec +\| 0 +\|/)
    assert.equal(doc.decisions_office.length, 1, 'décision déjà notée par le scribe : pas de doublon')
    const p = doc.points.find(x => x.role === 'arret')
    assert.deepEqual([p.tache, p.humain, p.statut, p.options.map(o => Object.keys(o).sort().join())], ['T05', true, 'ouvert', ['description,id,impact,recommande']])
    assert.equal(C.suivi('fin-run', { statut: 'terminé' }).code, 1, 'plus de run en cours')
    C.git('commit', '-qam', 'suivi(T04) : échec')
  })

  await cas('pilote : fusionnée et annulée à la main, SUIVI.md régénéré', () => {
    assert.equal(C.suivi('pilote', { tache: 'T04', statut: 'fusionnée', raison: 'corrigée à la main, évaluation OK' }).out, 'suivi : T04 fusionnée ; SUIVI.md régénéré, à commiter')
    assert.equal(C.suivi('pilote', { tache: 'T08', statut: 'annulée', raison: 'hors périmètre' }).code, 0)
    const L = C.lint()
    assert.deepEqual(['T04', 'T08'].map(id => L.taches.find(t => t.id === id).statut), ['fusionnée', 'annulée'])
    assert.ok(C.doc().journal.some(e => e.genre === 'pilote' && e.texte === 'T08 : annulée par le pilote — hors périmètre'))
  })

  await cas('--json : même effet que l\'entrée standard, texte échappé comme le workflow l\'écrit ; tâche ajoutée sans fichier sautée', () => {
    const manques = ["l'option `--force` coûte $5", 'guillemets "doubles", barre \\ et accents éèà']
    const brut = JSON.stringify({ tache: 'T07', etape: 'correction', refus: { essai: 1, par: 'évaluation', manques } })
    // Échappement du workflow : rien qui ferme ou interprète des guillemets simples
    const echappe = brut.replace(/'/g, '\\u0027').replace(/`/g, '\\u0060').replace(/\$/g, '\\u0024')
    assert.ok(!/['`$]/.test(echappe))
    const r = C.suivi('etape', undefined, { args: ['--json', echappe] })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(tC('T07').refus, [{ essai: 1, par: 'évaluation', manques }])
    // Par le shell, entre guillemets simples, comme la commande d'un agent
    const sh = spawnSync('sh', ['-c', `"${process.execPath}" "${SUIVI}" etape ${C.plan} --json '${echappe}'`], { cwd: C.racine, encoding: 'utf8' })
    assert.equal(sh.status, 0, sh.stderr)
    assert.deepEqual(tC('T07').refus.map(x => x.manques), [manques, manques])
    assert.equal(C.suivi('etape', undefined, { args: ['--json'] }).code, 2)
    const inv = C.suivi('etape', undefined, { args: ['--json', '{x'] })
    assert.deepEqual([inv.code, /--json : JSON invalide/.test(inv.err)], [2, true])
    // Tâche ajoutée dont le scribe a retiré le fichier (refus de plan-lint, qu'il signale de son côté) : sautée et notée, le reste écrit
    const a = C.suivi('arbitrage', { tache: 'T03', titre: 'Seuil', option: 'B', taches_ajoutees: [{ id: 'T03Z', titre: 'Refusée par plan-lint', phase: 1 }] })
    assert.equal(a.code, 0, a.err)
    assert.equal(a.out, 'suivi : arbitrage T03 option B ; SUIVI.md régénéré ; non ajoutée, sans fichier de tâche : T03Z')
    const doc = C.doc()
    assert.ok(!doc.taches.some(t => t.id === 'T03Z') && !C.lire('SUIVI.md').includes('T03Z'))
    assert.ok(doc.journal.some(e => e.genre === 'erreur' && e.tache === 'T03Z'))
    assert.ok(doc.journal.some(e => e.genre === 'arbitrage' && e.tache === 'T03'))
    assert.equal(C.suivi('valider').code, 0)
  })

  await cas('journal : 200 événements au plus, journal_omis compte ceux qui sortent', () => {
    const doc = C.doc()
    doc.journal = Array.from({ length: 199 }, (_, i) => ({ quand: doc.maj, genre: 'etape', tache: null, texte: `ancien ${i}` }))
    doc.journal_omis = 5
    writeFileSync(join(C.d, 'suivi.json'), JSON.stringify(doc, null, 2) + '\n')
    assert.equal(C.suivi('etape', { tache: 'T05', etape: 'vérification' }).code, 0)
    let j = C.doc()
    assert.deepEqual([j.journal.length, j.journal_omis, j.journal[0].texte], [200, 5, 'ancien 0'])
    assert.equal(C.suivi('cloture', { tache: 'T05', statut: 'bloquée', essais: 1, branche: 'tache/T05', relectures: ['a : relire', 'b : relire'] }).code, 0)
    j = C.doc()
    assert.deepEqual([j.journal.length, j.journal_omis, j.journal[0].texte], [200, 8, 'ancien 3'])
    assert.equal(j.journal[199].genre, 'relecture')
    assert.equal(C.suivi('valider').code, 0)
  })

  await cas('suivi.json perdu : reconstruit à la première écriture ; format inconnu refusé', () => {
    C.git('add', '-A'); C.git('commit', '-qm', 'suivi')
    unlinkSync(join(C.d, 'suivi.json'))
    assert.equal(C.suivi('etape', { tache: 'T06', etape: 'worker', isole: false }).code, 0)
    let doc = C.doc()
    assert.deepEqual(doc.taches.map(t => [t.id, t.statut]), [['T01', 'fusionnée'], ['T02', 'bloquée'], ['T03', 'fusionnée'], ['T03B', 'fusionnée'], ['T03D', 'ajoutée'], ['T03C', 'ajoutée'], ['T04', 'fusionnée'], ['T05', 'bloquée'], ['T06', 'à-faire'], ['T07', 'à-faire'], ['T08', 'annulée']])
    assert.deepEqual([doc.runs, doc.points, doc.taches.find(t => t.id === 'T03C').ajoutee_par], [[], [], null], 'les champs de run repartent vides')
    assert.equal(doc.taches.find(t => t.id === 'T06').etape, 'worker')
    writeFileSync(join(C.d, 'suivi.json'), JSON.stringify({ ...doc, format: 'orchestre-suivi/3' }))
    const avant = C.lire('suivi.json')
    const r = C.suivi('etape', { tache: 'T06', etape: 'vérification' })
    assert.equal(r.code, 1)
    assert.equal(r.err, 'suivi : suivi.json est au format orchestre-suivi/3, ce lecteur lit orchestre-suivi/2 et orchestre-suivi/1')
    assert.equal(C.suivi('valider').code, 1)
    assert.equal(C.lire('suivi.json'), avant)
    // SUIVI.md avec un statut écrit à la main hors des 7 : la reconstruction cite la ligne
    unlinkSync(join(C.d, 'suivi.json'))
    writeFileSync(join(C.d, 'SUIVI.md'), C.lire('SUIVI.md').replace(/(\| T07 .*?\| )à-faire /, '$1en-cours '))
    const e = C.suivi('etape', { tache: 'T07', etape: 'worker' })
    assert.equal(e.code, 1)
    assert.match(e.err, /SUIVI\.md, ligne \d+ : statut inconnu « en-cours » pour T07/)
    assert.ok(!existsSync(join(C.d, 'suivi.json')))
    doc = null
  })

  await cas('fin de run : une tâche ajoutée du bilan absente du suivi (clôture non écrite) y entre, avec la tâche qui l\'a créée', () => {
    const F = depot('fin', { taches: [{ id: 'T01' }, { id: 'T02' }], suivi: SUIVI_GABARIT(['T01', 'T02']) })
    assert.equal(F.suivi('debut-run', RUN).code, 0)
    F.ecrireTache({ id: 'T02B', phase: 1, depend_de: ['T02'] })
    assert.equal(F.suivi('arbitrage', { tache: 'T02', titre: 'Garde', option: 'A', taches_ajoutees: [{ id: 'T02B', titre: 'Garde du flag', phase: 1 }] }).code, 0)
    // Créée par le scribe de T01, dont la clôture n'a pas été écrite
    F.ecrireTache({ id: 'T01B', phase: 1, depend_de: ['T01'] })
    const r = F.suivi('fin-run', { statut: 'arbitrage', taches: [{ id: 'T01', statut: 'fusionnée', essais: 1, branche: 'tache/T01' }], taches_ajoutees: [{ id: 'T01B', phase: 1, titre: 'Suite de T01', ajoutee_par: 'T01' }, { id: 'pas un id', phase: 1, titre: 'x' }] })
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, 'suivi : run 1 arbitrage ; SUIVI.md régénéré, à commiter')
    const doc = F.doc()
    assert.deepEqual(doc.runs[0].taches_ajoutees.map(x => x.id), ['T02B', 'T01B'])
    assert.deepEqual(doc.taches.map(t => [t.id, t.statut, t.ajoutee_par]), [['T01', 'fusionnée', null], ['T01B', 'ajoutée', 'T01'], ['T02', 'à-faire', null], ['T02B', 'ajoutée', 'T02']])
    assert.ok(/\| T01B \| Suite de T01 /.test(F.lire('SUIVI.md')))
    assert.equal(F.suivi('valider').code, 0)
  })

  await cas('vue entre deux runs : une tâche fusionnée à la main (commit « tâche <id> : » sans suivi.mjs pilote) passe à « fusionnée »', () => {
    const V = depot('vue', { taches: [{ id: 'T01' }, { id: 'T02' }], suivi: SUIVI_GABARIT(['T01', 'T02']) })
    assert.equal(V.suivi('debut-run', RUN).code, 0)
    V.git('commit', '-q', '--allow-empty', '-m', 'tâche T01 : Tâche T01')
    assert.equal(V.lint().taches.find(t => t.id === 'T01').statut, 'fusionnée', 'plan-lint lit git')
    assert.match(V.suivi('vue', undefined, { args: ['--stdout'] }).out, /\| T01 .*\| fusionnée \|/)
    assert.equal(V.suivi('vue').code, 0)
    assert.match(V.lire('SUIVI.md').split('\n').find(l => l.startsWith('| T01 ')), /\| fusionnée \|/)
    assert.equal(V.doc().taches.find(t => t.id === 'T01').statut, 'fusionnée')
    assert.ok(V.doc().journal.some(e => e.texte === 'T01 : à-faire → fusionnée (SUIVI.md et git)'))
  })

  await cas('plan-lint sans réponse (sortie coupée) : pas de reconstruction ; suivi.json existant, champs de plan gardés et une note au journal (0.8.1)', () => {
    const F = depot('lintko', { taches: [{ id: 'T01' }, { id: 'T02', estimation: '2.5M' }], suivi: SUIVI_GABARIT(['T01', 'T02']) })
    // Copie du script à côté d'un plan-lint qui rend un JSON coupé, comme dans un tube avant la 0.8.1
    const bin = temp('lint-coupe-')
    writeFileSync(join(bin, 'suivi.mjs'), readFileSync(SUIVI, 'utf8'))
    writeFileSync(join(bin, 'plan-lint.mjs'), "process.stdout.write('{\\n  \"ok\": true,\\n  \"taches\": [')\n")
    const coupe = (cmd, E) => { const r = spawnSync(process.execPath, [join(bin, 'suivi.mjs'), cmd, F.plan, '--json', JSON.stringify(E)], { cwd: F.racine, encoding: 'utf8' }); return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() } }
    const avant = F.lire('SUIVI.md')
    const r1 = coupe('debut-run', RUN)
    assert.equal(r1.code, 1, r1.out + r1.err)
    assert.match(r1.err, /plan-lint n'a pas rendu d'état \(\{\) : suivi\.json absent, il ne se reconstruit pas sans plan-lint/)
    assert.ok(!existsSync(join(F.d, 'suivi.json'))); assert.equal(F.lire('SUIVI.md'), avant); assert.deepEqual(F.restes(), [])
    assert.equal(F.suivi('debut-run', RUN).code, 0)
    assert.equal(coupe('etape', { tache: 'T01', etape: 'worker', isole: false }).code, 0)
    const r2 = coupe('cloture', { tache: 'T01', statut: 'bloquée', essais: 1, branche: 'tache/T01', blocage: ['x'] })
    assert.equal(r2.code, 0, r2.err)
    const doc = F.doc()
    assert.deepEqual(doc.taches.map(t => [t.id, t.statut, t.estimation_tokens]), [['T01', 'bloquée', 1], ['T02', 'à-faire', 2.5]])
    assert.equal(doc.lint.ok, false)
    assert.equal(doc.journal.filter(e => e.genre === 'erreur' && /plan-lint n'a pas rendu d'état/.test(e.texte)).length, 1, 'une seule note, pas une par écriture')
    assert.match(F.lire('SUIVI.md').split('\n').find(l => l.startsWith('| T02 ')), /\| 2,5 M \/ — +\|/)
    assert.match(F.lire('SUIVI.md').split('\n').find(l => l.startsWith('| T01 ')), /\| bloquée +\| 1 +\| tache\/T01 +\| 1,0 M \//)
    assert.equal(F.suivi('valider').code, 0)
  })

  await cas('lignes de tâches écrites sous la légende (scribe 0.6.3) : reprises dans le tableau, avec leurs cellules ; suivi.json 0.8.0 appauvri réparé (0.8.1)', () => {
    const texte = `# SUIVI — orph

| ID  | Titre | Phase | Lot | Dépend de | Modèle | Statut    | Essais | Branche | Tokens est. / réels |
|-----|-------|-------|-----|-----------|--------|-----------|--------|---------|---------------------|
| T01 | Court | 1     | 1A  | —         | sonnet | fusionnée | 1      | tache/T01 | — / voir /workflows |

Statuts : à-faire · ajoutée · fusionnée · bloquée · échec · besoin-humain · annulée
| T01B | Ajoutée par le scribe | 1 | 1B | T01 | sonnet | fusionnée | 3 | tache/T01B-r2 | 0,5 M / voir /workflows |
| T02 | Suite | 2 | 2A | T01 | sonnet | à-faire | 0 | — | 1,0 M / — |
`
    const F = depot('orph', { taches: [{ id: 'T01' }, { id: 'T01B', depend_de: ['T01'], estimation: '0.5M' }, { id: 'T02', phase: 2, depend_de: ['T01'] }], suivi: texte })
    assert.deepEqual(F.lint().taches.map(t => [t.id, t.statut]), [['T01', 'fusionnée'], ['T01B', 'fusionnée'], ['T02', 'à-faire']], 'plan-lint lit déjà les lignes sous la légende')
    // État laissé par une 0.8.0 dont plan-lint était coupé : suivi.json sans T01B ni T02, estimations effacées
    assert.equal(F.suivi('debut-run', RUN).code, 0)
    const d = F.doc()
    d.taches = d.taches.filter(t => t.id === 'T01').map(t => ({ ...t, estimation_tokens: null }))
    writeFileSync(join(F.d, 'suivi.json'), JSON.stringify(d, null, 2) + '\n')
    writeFileSync(join(F.d, 'SUIVI.md'), texte)
    const r = F.suivi('vue')
    assert.equal(r.code, 0, r.err)
    const doc = F.doc()
    assert.deepEqual(doc.taches.map(t => [t.id, t.titre, t.statut, t.essais, t.branche, t.estimation_tokens]), [
      ['T01', 'Court', 'fusionnée', 1, 'tache/T01', 1], ['T01B', 'Ajoutée par le scribe', 'fusionnée', 3, 'tache/T01B-r2', 0.5], ['T02', 'Suite', 'à-faire', 0, null, 1]])
    const lignes = F.lire('SUIVI.md').split('\n')
    const legende = lignes.findIndex(l => l.startsWith('Statuts :'))
    for (const id of ['T01', 'T01B', 'T02']) {
      const ou = lignes.map((l, i) => (l.startsWith(`| ${id} `) ? i : -1)).filter(i => i >= 0)
      assert.equal(ou.length, 1, `${id} une seule fois`); assert.ok(ou[0] < legende, `${id} dans le tableau, avant la légende`)
    }
    assert.equal(lignes.slice(legende + 1).filter(l => l.startsWith('|')).length, 0)
    assert.match(lignes.find(l => l.startsWith('| T01B ')), /\| tache\/T01B-r2 +\| 0,5 M \/ voir \/workflows +\|/)
    assert.equal(F.lint().ok, true)
    assert.equal(F.suivi('valider').code, 0)
    // Une ligne sous la légende dont l'ID n'est pas une tâche du plan reste du texte
    writeFileSync(join(F.d, 'SUIVI.md'), F.lire('SUIVI.md') + '| T99 | inconnue | 1 | — | — | sonnet | à-faire | 0 | — | — / — |\n')
    assert.equal(F.suivi('vue').code, 0)
    assert.equal(F.lire('SUIVI.md').split('\n').filter(l => l.startsWith('| T99 ')).length, 1)
    // Sans suivi.json : un tableau de notes sous la légende reste du texte ; une ligne qui reprend T02 la remplace, à sa place
    rmSync(join(F.d, 'suivi.json'))
    const notes = '\n## Notes du pilote\n\n| ID | Note |\n|----|------|\n| T01 | relancée à la main le 07/10 |\n| D1 | tranchée : option B |\n'
    writeFileSync(join(F.d, 'SUIVI.md'), texte.replace('| T02 | Suite | 2 | 2A | T01 | sonnet | à-faire | 0 | — | 1,0 M / — |\n', '| T02 | Suite | 2 | 2A | T01 | sonnet | à-faire | 0 | — | 1,0 M / — |\n| T02 | Suite reprise | 2 | 2A | T01 | sonnet | fusionnée | 4 | tache/T02 | 1,0 M / voir /workflows |\n') + notes)
    const r2 = F.suivi('debut-run', RUN)
    assert.equal(r2.code, 0, r2.err)
    assert.deepEqual(F.doc().taches.map(t => [t.id, t.statut, t.essais]), [['T01', 'fusionnée', 1], ['T01B', 'fusionnée', 3], ['T02', 'fusionnée', 4]])
    assert.equal(F.suivi('vue').code, 0)
    const fin = F.lire('SUIVI.md')
    assert.ok(fin.endsWith(notes), 'notes du pilote gardées octet pour octet')
    assert.equal(fin.split('\n').filter(l => l.startsWith('| T02 ')).length, 1)
  })

  // ─── 0.11.0 : modèle prévu par le plan, modèle utilisé, format orchestre-suivi/2 ───────────────────────────────────
  await cas('modèle utilisé (0.11.0) : noté par le worker et chaque correction, changement au journal ; changement incohérent refusé', () => {
    const M = depot('modeles', { taches: [{ id: 'T01', modele: 'sonnet', raison: 'implémentation simple' }, { id: 'T02', modele: 'opus' }], suivi: SUIVI_GABARIT(['T01', 'T02']) })
    assert.equal(M.suivi('debut-run', RUN).code, 0)
    const t = id => M.doc().taches.find(x => x.id === id)
    assert.deepEqual([t('T01').modele, t('T01').modele_utilise, t('T02').modele], ['sonnet', null, 'opus'], 'null avant le worker')
    assert.equal(M.suivi('etape', { tache: 'T01', etape: 'worker', isole: false, modele: 'sonnet' }).out, 'suivi : T01 → worker (sonnet)')
    assert.equal(t('T01').modele_utilise, 'sonnet')
    assert.equal(M.suivi('etape', { tache: 'T01', etape: 'vérification' }).code, 0)
    assert.equal(t('T01').modele_utilise, 'sonnet', 'une étape sans modèle le garde')
    const R = { essai: 1, par: 'évaluation', manques: ['architecture à revoir'] }
    const c = M.suivi('etape', { tache: 'T01', etape: 'correction', refus: R, modele: 'opus', changement: { de: 'sonnet', vers: 'opus', raison: 'manque d\'architecture' } })
    assert.equal(c.code, 0, c.err)
    let doc = M.doc()
    assert.equal(t('T01').modele_utilise, 'opus'); assert.equal(t('T01').modele, 'sonnet', 'le modèle du plan ne bouge pas')
    assert.deepEqual(doc.journal.filter(e => e.tache === 'T01').slice(-3).map(e => [e.genre, e.texte]), [
      ['refus', 'T01 : essai 1 refusé (évaluation) : 1 manque(s)'], ['modele', "T01 : sonnet → opus (manque d'architecture)"], ['etape', 'T01 : correction (essai 2)']])
    // Correction sur le même modèle : pas d'événement
    assert.equal(M.suivi('etape', { tache: 'T01', etape: 'correction', refus: { ...R, essai: 2 }, modele: 'opus' }).code, 0)
    assert.equal(M.doc().journal.filter(e => e.genre === 'modele').length, 1)
    // Changement incohérent ou mal formé : refusé, fichier intact
    const avant = M.lire('suivi.json')
    for (const E of [{ modele: 'opus', changement: { de: 'opus', vers: 'haiku', raison: 'x' } }, { modele: '' }, { changement: 'opus' }, { changement: { de: 'opus', raison: 'x' } }]) {
      const r = M.suivi('etape', { tache: 'T01', etape: 'correction', ...E })
      assert.equal(r.code, 1, JSON.stringify(E)); assert.match(r.err, /^suivi : etape : /)
    }
    assert.equal(M.lire('suivi.json'), avant)
    // Changement sans modele : le modèle d'arrivée vaut modele_utilise ; de absent : « — »
    assert.equal(M.suivi('etape', { tache: 'T01', etape: 'correction', changement: { vers: 'sonnet', raison: '' } }).code, 0)
    assert.deepEqual([t('T01').modele_utilise, M.doc().journal.filter(e => e.genre === 'modele').pop().texte], ['sonnet', 'T01 : — → sonnet'])
    // Un nouveau worker (run suivant) repart du modèle qu'il lance
    assert.equal(M.suivi('debut-run', RUN).code, 0)
    assert.equal(M.suivi('etape', { tache: 'T01', etape: 'worker', isole: true, modele: 'sonnet' }).code, 0)
    assert.equal(t('T01').modele_utilise, 'sonnet')
    assert.equal(M.suivi('etape', { tache: 'T02', etape: 'worker', isole: true }).code, 0)
    assert.equal(t('T02').modele_utilise, null, 'worker sans modèle : null')
    assert.equal(M.suivi('valider').code, 0)
    assert.equal(M.propre(), '', 'le modèle utilisé ne touche que suivi.json')
  })

  await cas('tâche sans modèle (0.11.0) : entre dans le suivi avec modele null, « — » dans SUIVI.md, relue telle quelle', () => {
    const S = depot('sansmodele', { taches: [{ id: 'T01', modele: null }, { id: 'T02' }], suivi: SUIVI_GABARIT(['T01', 'T02']).replace('| T01 | Tâche T01 | 1 | 1A | — | sonnet |', '| T01 | Tâche T01 | 1 | 1A | — | — |') })
    assert.equal(S.lint().ok, true, 'plan-lint : un avertissement, pas une erreur')
    assert.equal(S.suivi('debut-run', RUN).code, 0)
    assert.deepEqual(S.doc().taches.map(t => [t.id, t.modele, t.modele_utilise]), [['T01', null, null], ['T02', 'sonnet', null]])
    assert.ok(!S.doc().journal.some(e => e.genre === 'erreur'), 'pas de « non ajoutée au suivi »')
    assert.equal(S.suivi('etape', { tache: 'T01', etape: 'worker', isole: false, modele: 'sonnet' }).code, 0)
    assert.equal(S.suivi('cloture', { tache: 'T01', statut: 'fusionnée', essais: 1, branche: 'tache/T01' }).code, 0)
    const l = S.lire('SUIVI.md').split('\n').find(x => x.startsWith('| T01 '))
    assert.deepEqual(cellulesDe(l).slice(5, 7), ['—', 'fusionnée'], 'Modèle « — », pas « null » ni vide')
    // Reconstruction depuis SUIVI.md : « — » relu comme null ; un frontmatter qui gagne un modèle le donne au suivi
    rmSync(join(S.d, 'suivi.json'))
    S.ecrireTache({ id: 'T01', modele: 'haiku' })
    assert.equal(S.suivi('vue', undefined, { args: ['--stdout'] }).code, 0)
    S.ecrireTache({ id: 'T01', modele: null })
    assert.equal(S.suivi('vue').code, 0)
    assert.equal(S.doc().taches[0].modele, null)
    assert.equal(cellulesDe(S.lire('SUIVI.md').split('\n').find(x => x.startsWith('| T01 ')))[5], '—')
    S.ecrireTache({ id: 'T01', modele: 'haiku' })
    assert.equal(S.suivi('vue').code, 0)
    assert.equal(S.doc().taches[0].modele, 'haiku')
    // Un frontmatter qui perd son modèle : null dans le suivi existant, pas l'ancienne valeur
    S.ecrireTache({ id: 'T01', modele: null })
    assert.equal(S.suivi('vue').code, 0)
    assert.equal(S.doc().taches[0].modele, null)
    // Tâche sans modèle et sans ligne dans SUIVI.md (créée par un scribe) : elle entre dans le suivi, sans erreur au journal
    S.ecrireTache({ id: 'T03', modele: null })
    assert.equal(S.suivi('vue').code, 0)
    assert.deepEqual(S.doc().taches.map(t => [t.id, t.modele]), [['T01', null], ['T02', 'sonnet'], ['T03', null]])
    assert.ok(!S.doc().journal.some(e => e.genre === 'erreur'), 'pas de « non ajoutée au suivi »')
    // État en lecture : rien ne casse sans modèle
    assert.equal(S.suivi('etat').code, 0)
    assert.equal(S.suivi('valider').code, 0)
  })

  await cas('migration orchestre-suivi/1 → /2 (0.11.0) : lu et validé tel quel, écrit en /2 à la première écriture, avec modele_utilise et une note', () => {
    const G = depot('migration', { taches: [{ id: 'T01' }, { id: 'T02' }], suivi: SUIVI_GABARIT(['T01', 'T02']) })
    assert.equal(G.suivi('debut-run', RUN).code, 0)
    assert.equal(G.suivi('etape', { tache: 'T01', etape: 'worker', isole: false, modele: 'sonnet' }).code, 0)
    // Le fichier tel qu'une 0.10 l'aurait écrit : format /1, sans modele_utilise
    const v2 = G.doc(), v1 = { ...v2, format: 'orchestre-suivi/1', taches: v2.taches.map(({ modele_utilise, ...t }) => t) }
    writeFileSync(join(G.d, 'suivi.json'), JSON.stringify(v1, null, 2) + '\n')
    const val = G.suivi('valider')
    assert.equal(val.code, 0, val.err)
    assert.equal(val.out, 'suivi : suivi.json valide (orchestre-suivi/1, migré en orchestre-suivi/2 à la prochaine écriture, 2 tâches, 1 run)')
    assert.equal(G.suivi('etat').code, 0)
    assert.equal(G.lire('suivi.json'), JSON.stringify(v1, null, 2) + '\n', 'lecture et validation n\'écrivent rien')
    // Un /1 invalide reste refusé ; un modèle utilisé vide aussi
    writeFileSync(join(G.d, 'suivi.json'), JSON.stringify({ ...v1, taches: [{ ...v1.taches[0], statut: 'en-cours' }] }))
    assert.equal(G.suivi('valider').code, 1)
    writeFileSync(join(G.d, 'suivi.json'), JSON.stringify({ ...v2, taches: v2.taches.map(t => ({ ...t, modele_utilise: '' })) }))
    assert.match(G.suivi('valider').err, /modele_utilise : texte vide/)
    writeFileSync(join(G.d, 'suivi.json'), JSON.stringify(v1, null, 2) + '\n')
    const r = G.suivi('etape', { tache: 'T01', etape: 'vérification' })
    assert.equal(r.code, 0, r.err)
    const doc = G.doc()
    assert.equal(doc.format, 'orchestre-suivi/2')
    assert.deepEqual(doc.taches.map(t => [t.id, t.modele, t.modele_utilise, t.etape]), [['T01', 'sonnet', null, 'vérification'], ['T02', 'sonnet', null, null]], 'champ présent, null : le /1 ne le notait pas')
    assert.deepEqual(doc.runs.map(x => [x.numero, x.statut]), [[1, 'en-cours']], 'le run en cours continue')
    assert.equal(doc.journal.filter(e => e.texte === "suivi.json migré de orchestre-suivi/1 à orchestre-suivi/2 : modèle utilisé inconnu jusqu'ici").length, 1)
    assert.equal(G.suivi('etape', { tache: 'T01', etape: 'évaluation' }).code, 0)
    assert.equal(G.doc().journal.filter(e => /migré/.test(e.texte)).length, 1, 'une seule fois')
    assert.equal(G.suivi('valider').out, 'suivi : suivi.json valide (orchestre-suivi/2, 2 tâches, 1 run)')
  })

  console.log(`suivi : TOUT EST VERT (${n} cas)`)
}

try { await main() } finally { for (const d of temporaires) rmSync(d, { recursive: true, force: true }) }
