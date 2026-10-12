// Le scénario de /suivi demo (plugins/orchestre/hooks/demo.mjs) joué par le vrai scripts/suivi.mjs : un dépôt
// jouet, puis deux runs pas à pas, sans agent ni modèle. tests/mod-suivi.test.mjs s'en sert pour vérifier que la
// démo du mod dit la même chose (notifications, journal). On peut aussi regarder une session ouverte dans le dépôt.
// Après chaque pas, la démo affiche ce que le mod doit montrer, calculé par son propre modèle (hooks/modele.mjs), en
// texte : dans Claude Code, le même bandeau est en couleurs et s'anime. Ce qui diffère dans la session vient du dessin
// ou du chargement du mod, pas des données.
// Usage : node tests/demo-suivi.mjs <dossier-à-créer> [--pas <ms>]      (4000 ms entre deux pas par défaut)
// Dans un terminal, la démo attend Entrée avant chaque run ; sans terminal (tests), elle enchaîne.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import * as M from '../plugins/orchestre/hooks/modele.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROGRESS = resolve(HERE, '../plugins/orchestre/scripts/suivi.mjs')
const MOD = resolve(HERE, '../plugins/orchestre')
const args = process.argv.slice(2)
const D = args.find(a => !a.startsWith('--')) && resolve(args.find(a => !a.startsWith('--')))
const frameIndex = args.indexOf('--pas')
const PAS = frameIndex >= 0 ? Number(args[frameIndex + 1]) : 4000
if (!D || !Number.isFinite(PAS) || PAS < 0) { console.error('usage : node tests/demo-suivi.mjs <dossier-à-créer> [--pas <ms>]'); process.exit(2) }
if (existsSync(D)) { console.error(`${D} existe déjà : donne un dossier qui n'existe pas`); process.exit(1) }

const git = (...a) => execFileSync('git', a, { cwd: D, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const pause = ms => new Promise(r => setTimeout(r, ms))
const entry = async text => {
  if (!process.stdin.isTTY) return
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  await new Promise(r => rl.question(text, () => r()))
  rl.close()
}

// ─── Le dépôt jouet : 5 tâches sur 2 phases ──────────────────────────────────────────────────────────────────────────
// Les mêmes tâches que /suivi demo, modèles compris (0.11.0)
const { TASKS, REJECTION, CHANGE } = await import('../plugins/orchestre/hooks/demo.mjs')
const frontmatter = t => `---\nid: ${t.id}\ntitre: ${t.titre}\nphase: ${t.phase}\nmodele: ${t.modele}\nraison_modele: démonstration\ndepend_de: [${t.dep.join(', ')}]\nfichiers_possedes:\n  - src/${t.id}.txt\nressources: []\nestimation_tokens: 0.4M\nverification:\n  - "test -f src/${t.id}.txt"\ndefinition_du_fini:\n  - "src/${t.id}.txt existe"\n---\n\nTâche de démonstration du suivi orchestre : rien n'est réalisé, la démo écrit le suivi elle-même.\n`

function createRepo() {
  const dir = join(D, 'plans', 'demo')
  mkdirSync(join(dir, 'taches'), { recursive: true })
  mkdirSync(join(D, 'src'))
  git('init', '-q')
  git('checkout', '-q', '-b', 'main')
  git('config', 'user.email', 'demo@orchestre.invalid'); git('config', 'user.name', 'demo orchestre'); git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(D, 'README.md'), "# Démo du mod de suivi d'orchestre\n\nDépôt jouet créé par tests/demo-suivi.mjs ; il peut être supprimé.\n")
  writeFileSync(join(D, 'src', '.gitkeep'), '')
  git('add', '.'); git('commit', '-qm', 'init')
  for (const t of TASKS) writeFileSync(join(dir, 'taches', `${t.id}.md`), frontmatter(t))
  const line = t => `| ${t.id} | ${t.titre} | ${t.phase} | — | ${t.dep.join(', ') || '—'} | ${t.modele} | à-faire | 0 | — | 0,4 M / — |`
  writeFileSync(join(dir, 'SUIVI.md'), `# SUIVI — demo\n\n| ID | Titre | Phase | Lot | Dépend de | Modèle | Statut | Essais | Branche | Tokens est. / réels |\n|----|----|----|----|----|----|----|----|----|----|\n${TASKS.map(line).join('\n')}\n\nStatuts : à-faire · ajoutée · fusionnée · bloquée · échec · besoin-humain · annulée\n`)
  writeFileSync(join(dir, 'HANDOFF.md'), '# HANDOFF — demo\n')
  writeFileSync(join(dir, 'orchestre.config.json'), JSON.stringify({ branche_integration: 'plan/demo', parallelisme_max: 2, mode_par_defaut: 'phase' }, null, 2) + '\n')
  git('checkout', '-q', '-b', 'plan/demo'); git('add', '.'); git('commit', '-qm', 'plan demo')
}

// ─── Les pas ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const suivi = (cmd, E) => {
  const r = spawnSync(process.execPath, [PROGRESS, cmd, 'plans/demo', '--json', JSON.stringify(E)], { cwd: D, encoding: 'utf8' })
  if (r.status !== 0) { console.error(`suivi.mjs ${cmd} a échoué (code ${r.status}) : ${r.stderr || r.stdout}`); process.exit(1) }
}
// La fusion, comme l'intégrateur : un commit « tâche <id> : » sur la branche d'intégration, que plan-lint reconnaît
const merge = id => {
  writeFileSync(join(D, 'src', `${id}.txt`), `${id}\n`)
  git('add', `src/${id}.txt`); git('commit', '-qm', `tâche ${id} : ${TASKS.find(t => t.id === id).titre}`)
}
const readFile = () => M.normalize(JSON.parse(readFileSync(join(D, 'plans', 'demo', 'suivi.json'), 'utf8')))
const CONFIG_RUN = { parallelisme: 2, corrections_max: 2, decisions_office_max: 3 }
const EMPTY_SUMMARY = { points_a_trancher: [], taches: [], non_lancees: [], reportees: [], taches_ajoutees: [], arbitrages_appliques: [], decisions_office: [], amendements_ecartes: [], en_attente: [], en_attente_prerequis: [] }
const modelOf = id => TASKS.find(t => t.id === id).modele
const worker = (id, isolated) => suivi('etape', { tache: id, etape: 'worker', isole: isolated, modele: modelOf(id) })
const SMTP = { tache: 'T03', titre: 'Clé SMTP de test', contexte: "les tests d'envoi ont besoin d'un serveur SMTP de test", humain: true, options: [] }

const RUN1 = [
  ['Run 1 lancé, phase 1', () => suivi('debut-run', { phase: 1, mode: 'phase', ...CONFIG_RUN })],
  ['T01 et T02 démarrent, chacune dans son worktree', () => { worker('T01', true); worker('T02', true) }],
  ['T01 en vérification', () => suivi('etape', { tache: 'T01', etape: 'vérification' })],
  ['T02 en vérification, T01 en évaluation', () => { suivi('etape', { tache: 'T02', etape: 'vérification' }); suivi('etape', { tache: 'T01', etape: 'évaluation' }) }],
  ["T02 refusée par l'évaluation : correction sur opus, que le replanificateur a choisi", () => suivi('etape', { tache: 'T02', etape: 'correction', refus: REJECTION, modele: 'opus', changement: CHANGE })],
  ['T01 en fusion', () => suivi('etape', { tache: 'T01', etape: 'fusion' })],
  ['T01 fusionnée, avec une relecture avant la PR', () => { merge('T01'); suivi('cloture', { tache: 'T01', statut: 'fusionnée', essais: 1, branche: 'tache/T01', relectures: ['.env.example : ajouter DEMO_URL'] }) }],
  ['T03 démarre ; T02 en vérification (essai 2)', () => { worker('T03', true); suivi('etape', { tache: 'T02', etape: 'vérification' }) }],
  ['T02 en fusion ; T03 en vérification', () => { suivi('etape', { tache: 'T02', etape: 'fusion' }); suivi('etape', { tache: 'T03', etape: 'vérification' }) }],
  ["T02 fusionnée au 2e essai, avec une décision prise d'office", () => { merge('T02'); suivi('cloture', { tache: 'T02', statut: 'fusionnée', essais: 2, branche: 'tache/T02', refus: [REJECTION], decisions_office: [{ titre: 'Longueur maximale du message', option: 'B', description: '2 000 caractères' }] }) }],
  ['T03 attend un humain : la clé SMTP de test manque', () => suivi('cloture', { tache: 'T03', statut: 'besoin-humain', essais: 1, branche: 'tache/T03', blocage: ['clé SMTP de test absente'], points: [SMTP] })],
  ['Fin du run 1 : arbitrage sur T03', () => suivi('fin-run', { ...EMPTY_SUMMARY, statut: 'arbitrage', phase: 1, mode: 'phase', arbitrage: SMTP, en_attente: ['T03'] })],
]
const RUN2 = [
  ["Run 2 lancé ; le premier scribe applique l'arbitrage de T03", () => { suivi('debut-run', { phase: 1, mode: 'auto', ...CONFIG_RUN }); suivi('arbitrage', { tache: 'T03', titre: SMTP.titre, option: 'A' }) }],
  ['T03 reprend', () => worker('T03', true)],
  ['T03 en vérification', () => suivi('etape', { tache: 'T03', etape: 'vérification' })],
  ['T03 fusionnée : la phase 1 est terminée', () => { merge('T03'); suivi('cloture', { tache: 'T03', statut: 'fusionnée', essais: 2, branche: 'tache/T03' }) }],
  ['Phase 2 : T04 et T05 démarrent', () => { worker('T04', true); worker('T05', false) }],
  ['T05 fusionnée, avec deux relectures avant la PR', () => { merge('T05'); suivi('cloture', { tache: 'T05', statut: 'fusionnée', essais: 1, branche: 'tache/T05', relectures: ['README.md : relire la section installation', 'docs/smtp.md : vérifier le nom de la variable'] }) }],
  ['T04 en vérification', () => suivi('etape', { tache: 'T04', etape: 'vérification' })],
  ['T04 fusionnée : la phase 2 est terminée', () => { merge('T04'); suivi('cloture', { tache: 'T04', statut: 'fusionnée', essais: 1, branche: 'tache/T04' }) }],
  ['Fin du run 2 : terminé', () => suivi('fin-run', { ...EMPTY_SUMMARY, statut: 'terminé', phase: 2, mode: 'auto', arbitrages_appliques: [{ tache: 'T03', titre: SMTP.titre, option: 'A' }] })],
]

let before = null
const summary = () => { const i = readFile(); console.log(`\n    Carte du run attendue dans /suivi (touche b) :\n${M.runCard(i, Date.now(), 100, false).lines.map(l => `      ${M.plainText(l)}`).join('\n')}`) }
async function play(frameMs, n0) {
  for (const [i, [what, faire]] of frameMs.entries()) {
    faire()
    const after = readFile()
    const now = Date.now()
    console.log(`\n${String(n0 + i).padStart(2)}. ${what}`)
    console.log(`    bandeau      ${M.plainText(M.banner(after, now, 120)) || '(aucun)'}`)
    const s = M.suffix(after, now)
    if (s) console.log(`    spinner      …${s}`)
    for (const n of M.changes(before, after)) console.log(`    notification ${n}`)
    before = after
    await pause(PAS)
  }
}

createRepo()
console.log(`Dépôt de démo créé : ${D}

Avant d'ouvrir la session :
  claude --version              2.1.287 ou plus : les mods sont actifs par défaut à partir de cette version
  claude plugin test            lancé dans un dossier sans mod, doit dire « no hooks module to load » (mods permis)

Ouvre une session Claude Code dans ce dossier, avec le mod :
  cd "${D}" && claude --plugin-dir "${MOD}"
(ou, s'il est déjà installé depuis la marketplace : cd "${D}" && claude)
Accepte l'invite de confiance du dossier : sans elle, aucun mod ne se charge.
Vérifie avec /plugin qu'il est chargé : la ligne sous les onglets doit nommer orchestre.
Le mod relit suivi.json toutes les 2 s : chaque pas ci-dessous doit apparaître dans la session en 2 s au plus.
Ci-dessous, le texte attendu ; dans la session, le bandeau est en couleurs (une case par tâche, verte quand elle est
fusionnée, bleue quand elle est en cours, ambre quand elle attend quelqu'un) et s'anime pendant le run.
Le suffixe du spinner ne se voit que pendant que Claude travaille : pendant un run, demande-lui par exemple
« lance sleep 60 dans Bash ».

Si rien n'apparaît : avec --plugin-dir, la transcription porte une ligne « orchestre: … refused: » ou
« … hook skipped: » qui dit pourquoi. Sinon, relance la session avec --debug-file mod.log et cherche
« orchestre: » dans ce fichier (grep "orchestre:" mod.log).`)
await entry('\nEntrée pour lancer le run 1… ')
await play(RUN1, 1)
summary()
console.log(`
Le run 1 s'est arrêté sur un arbitrage. Dans la session, essaie :
  /suivi            le panneau en cartes : r (À toi), b (le run), t (les tâches), j (le journal) ; 1 à 9, l et p préparent une action dans le prompt ;
                    Échap le ferme
  /suivi texte      le même état en texte
  ✕ Masquer         au bout du bandeau, à cliquer : le bandeau de fin disparaît
                    jusqu'au run suivant`)
await entry('\nEntrée pour lancer le run 2… ')
await play(RUN2, RUN1.length + 1)
summary()
console.log(`
Fin de la démo : 5/5 tâches fusionnées en 2 runs. Le dépôt ${D} peut être supprimé.`)
