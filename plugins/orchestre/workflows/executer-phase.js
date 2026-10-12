export const meta = {
  name: 'executer-phase',
  description: "Exécute une phase d'un plan (dossier plans/<nom>) : workers, vérification, évaluation, corrections, fusion et suivi. Lancé par /orchestre:lancer.",
  phases: [{ title: 'Lecture du plan' }, { title: 'Tâches' }, { title: 'Clôture' }],
}

// Orchestrator 0.11.0 (orchestre plugin)
// args: { plan, phase, mode: 'auto'|'devia'|'phase', parallelisme, integration, base, decisions, corrections_max, escalade, decisions_office_max, arbitrages, relancer, lint, prefixe_agents, suivi }
// base: branch the integration branch starts from (main by default, read by plan-lint)
// arbitrages: options chosen by the user since the previous run, [{ tache, titre, option }]; the scribe applies them before the plan is read
// relancer: ids of "besoin-humain" tasks the user restarts, after their decision
// suivi (0.8.0): path of scripts/suivi.mjs, sole writer of suivi.json and of the SUIVI.md view (contract orchestre-suivi/2 since 0.11.0,
//   which migrates a /1 file).
//   The workflow launches nothing: it writes in its agents' instructions the command to run, and reads its result in suivi_ok.
//   Without suivi: progress as in 0.6.3, the scribe edits SUIVI.md itself.
// preparation (0.8.0): project commands that bring a working folder up to date (dependencies, generated code), taken from
//   orchestre.config.json by /orchestre:lancer; run by each worker after its branch, and by the integrator between the merge
//   and the post-merge check. The plugin knows no stack: it runs what the project declares.
// preparation_partagee: { <resource>: [commands] } for a shared service (test database); run only by the agents
//   of a task that declares this resource, hence under its lock: two tasks never prepare the same database at the same time.
// Models (0.11.0): the worker runs on the task's modele (plan-lint), as is. After each rejected attempt, the replanner
//   chooses the model of the next fix from the rejection; the task's model is a floor, and without a valid answer
//   the escalade ladder applies. The choice holds for the run. Task without modele: sonnet, then the ladder, without a call (0.10 and earlier).
//   The worker and each fix pass their model, and the change if there is one, in their etape command.
const A = args || {}
const PLAN = A.plan
const PHASE = Number(A.phase)
const MODE = A.mode || 'phase'
const PAR = Math.max(1, Math.min(Number(A.parallelisme) || 4, 8))
const INTEG = A.integration
const MAXFIX = A.corrections_max ?? 2
const ESC = A.escalade || ['sonnet', 'opus']
const DECISIONS = A.decisions || []
const MAX_AUTO = A.decisions_office_max ?? 3
const DONE = s => s === 'fusionnée' || s === 'annulée'
const RULINGS = (A.arbitrages || []).filter(a => a && a.option)
const RERUN = new Set(A.relancer || [])
// Plugin: namespaced agents ("orchestre:worker") and plan-lint shipped with the plugin; /orchestre:lancer passes lint and prefixe_agents
// Manual install in .claude/ (v0.5 and earlier): prefixe_agents '' and the default lint
const AG = n => (A.prefixe_agents ?? 'orchestre:') + n
const LINT = A.lint || '.claude/orchestre/plan-lint.mjs'
const LINTCMD = /\s/.test(LINT) ? `node "${LINT}"` : `node ${LINT}`
const BASE = A.base ? ` --base ${A.base}` : ''
const PROGRESS = A.suivi || null
const PROGRESS_CMD = PROGRESS && (/\s/.test(PROGRESS) ? `node "${PROGRESS}"` : `node ${PROGRESS}`)
const PLANARG = /\s/.test(PLAN || '') ? `"${PLAN}"` : PLAN
// JSON object in single quotes: apostrophe, backtick and dollar as \u escapes, nothing else in it is interpreted by the shell.
// A single command, without heredoc or pipe: the rule Bash(node <suivi.mjs> *) is enough
const forShell = x => `'${JSON.stringify(x).replace(/'/g, '\\u0027').replace(/`/g, '\\u0060').replace(/\$/g, '\\u0024')}'`
const progressCmd = (cmd, E) => `${PROGRESS_CMD} ${cmd} ${PLANARG} --json ${forShell(E)}`
// Cleaning of the worktrees of earlier attempts, by the clerk at the end of the run: scripts/worktrees.mjs, next to suivi.mjs
const WORKTREES = PROGRESS && PROGRESS.replace(/suivi\.mjs$/, 'worktrees.mjs')
const WTCMD = WORKTREES && (/\s/.test(WORKTREES) ? `node "${WORKTREES}"` : `node ${WORKTREES}`)
// Environment setup (see args): project commands, non-empty strings
const commands = x => (Array.isArray(x) ? x : []).filter(c => typeof c === 'string' && c.trim())
const SETUP = commands(A.preparation)
const SHARED_SETUP = Object.fromEntries(Object.entries(A.preparation_partagee && typeof A.preparation_partagee === 'object' && !Array.isArray(A.preparation_partagee) ? A.preparation_partagee : {}).map(([r, c]) => [r, commands(c)]).filter(([, c]) => c.length))
const setupOf = t => [...SETUP, ...(t.ressources || []).flatMap(r => SHARED_SETUP[r] || [])]
// Texts passed to progress: on one line, and cut (command excerpts of 30 lines); HANDOFF.md keeps the whole text.
// A short command is copied without mistakes; a newline copied as is would break the JSON
const oneLine = x => String(x ?? '').replace(/\s+/g, ' ').trim()
const short = (x, n = 240) => { const s = oneLine(x); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const shorts = xs => (xs || []).map(x => short(x))
// Integers expected by the progress schema (args may carry strings)
const integer = (x, min) => Math.max(min, Math.trunc(Number(x)) || 0)
// Sensitive deviation (data, database, prod, secret): major automatically, whatever the replanner's rating
// Sensitive deviations, spotted by keywords; SENSITIVE_NOT_ENV is used when a forbidden file is reclassified as a review
const SENSITIVE_NOT_ENV = /base de (données|dev|prod)|\bbdd\b|database|\bdump\b|\bprod\b|production|données (personnelles|réelles|de prod|utilisateur)|personal data|\bpii\b|rgpd|gdpr|secret|mot de passe|password|api[ -]?key|clé (d')?api|credential|pg_restore|pg_dump|database_url/i
const SENSITIVE = new RegExp(SENSITIVE_NOT_ENV.source + '|\\.env\\b', 'i')
if (!PLAN || !PHASE || !INTEG) return { statut: 'erreur', detail: 'args requis : plan, phase, integration' }
if (!['auto', 'devia', 'phase'].includes(MODE)) return { statut: 'erreur', detail: `mode inconnu : ${MODE} (auto, devia ou phase)` }

// Report schemas
const S = (properties, required) => ({ type: 'object', properties, required })
const str = { type: 'string' }, bool = { type: 'boolean' }, strs = { type: 'array', items: str }
// Result of the progress command run by the agent (0.8.0); ouverture_ok for the first agent of the run, which runs debut-run
const PROGRESS_P = { suivi_ok: bool, suivi_erreur: str }
const PLAN_S = S({ ok: bool, erreurs: strs, taches: { type: 'array', items: S({ id: str, titre: str, fichier: str, phase: { type: 'integer' }, modele: str, raison_modele: str, effort: str, depend_de: strs, ressources: strs, statut: str, verification: strs, prerequis_ouverts: strs }, ['id', 'fichier', 'depend_de', 'statut', 'verification', 'prerequis_ouverts']) }, tous: { type: 'array', items: S({ id: str, phase: { type: 'integer' }, statut: str }, ['id']) }, phase_max: { type: 'integer' }, ouverture_ok: bool, suivi_erreur: str }, ['ok', 'taches'])
const REPORT_S = S({
  statut: { type: 'string', enum: ['done', 'partial', 'blocked'] }, resume: str, branche: str, commit: str, chemin: str, fichiers_modifies: strs,
  ecarts: { type: 'array', items: S({ type: { type: 'string', enum: ['écart', 'angle-mort', 'décision', 'dette', 'besoin-humain', 'relecture'] }, description: str, taches_impactees: strs }, ['type', 'description']) },
  decouvertes: { type: 'array', items: S({ categorie: str, contenu: str }, ['categorie', 'contenu']) }, blocage: str, ...PROGRESS_P,
}, ['statut', 'resume', 'branche', 'chemin'])
const RESULT_S = S({ commande: str, code: { type: 'integer' }, extrait: str }, ['commande', 'code', 'extrait'])
const VERIF_S = S({ ok: bool, resultats: { type: 'array', items: RESULT_S }, echecs: { type: 'array', items: S({ commande: str, extrait: str }, ['commande']) }, instables: strs, interdites: strs, ...PROGRESS_P }, ['ok', 'resultats'])
const EVAL_S = S({ verdict: { type: 'string', enum: ['ok', 'ko'] }, manques: strs, non_verifiables: strs, illisibles: strs, ...PROGRESS_P }, ['verdict'])
const INTEG_S = S({ ok: bool, fusionne: bool, controle_ok: bool, conflit: bool, commit: str, detail: str, ...PROGRESS_P }, ['ok', 'fusionne'])
const SCRIBE_S = S({ ok: bool, commit: str, refuses: { type: 'array', items: S({ id: str, raison: str }, ['id', 'raison']) }, ecartes: { type: 'array', items: S({ id: str, raison: str }, ['id', 'raison']) }, ...PROGRESS_P, ouverture_ok: bool }, ['ok'])
const CLERK_S = S({ suivi_ok: bool, suivi_erreur: str, commit: str, detail: str, worktrees: str }, ['suivi_ok'])
// Choice of a fix's model (0.11.0): haiku, sonnet or opus; fable only comes from a task the user put on it
// (orchestre.config.json: fable: true, checked by plan-lint), as a floor
const CHOICE_MODELS = ['haiku', 'sonnet', 'opus']
const CHOICE_S = S({ modele: { type: 'string', enum: CHOICE_MODELS }, raison: str }, ['modele', 'raison'])
// With progress, the command's result is required when it decides what follows: run start (first agent), close and ruling (scribe)
const requireFields = (schema, ...fields) => (PROGRESS ? { ...schema, required: [...schema.required, ...fields] } : schema)
const ENTRIES_S = { type: 'array', items: S({ type: str, gravite: { type: 'string', enum: ['mineur', 'majeur'] }, description: str }, ['type', 'gravite', 'description']) }
const TASKS_S = { type: 'array', items: S({ id: str, titre: str, phase: { type: 'integer' }, contenu: str }, ['id', 'titre', 'phase', 'contenu']) }
const AMENDS_S = { type: 'array', items: S({ id: str, definition_du_fini: strs, fichiers_possedes: strs, verification: strs, depend_de: strs, raison: str }, ['id', 'raison']) }
const OPTION_S = S({ id: str, description: str, impact: str, recommande: bool, entrees: ENTRIES_S, taches_ajoutees: TASKS_S, amendements: AMENDS_S }, ['id', 'description'])
const REPLAN_S = S({
  majeur: bool,
  points: { type: 'array', items: S({ titre: str, contexte: str, humain: bool, options: { type: 'array', items: OPTION_S } }, ['titre', 'options']) },
  entrees: ENTRIES_S,
  taches_ajoutees: TASKS_S,
  relectures: { type: 'array', items: S({ relecture: str, ecart: str }, ['relecture']) },
}, ['majeur', 'entrees'])

// A single agent at a time in the main checkout (merges, progress)
let queue = Promise.resolve()
const exclusive = fn => { const p = queue.then(fn); queue = p.catch(() => null); return p }
const ORDER = ['haiku', 'sonnet', 'opus', 'fable']
const atLeast = (m, base) => ORDER[Math.max(ORDER.indexOf(m), ORDER.indexOf(base || 'sonnet'))] || m
const bullets = xs => (xs || []).map(x => '- ' + x).join('\n')
const effort = t => (t.effort ? { effort: t.effort } : {})
const unique = xs => [...new Map(xs.map(x => [JSON.stringify(x), x])).values()]
// A fix report does not repeat the deviations of earlier attempts: they are accumulated, so that none escapes the replanner
const accumulate = (before, after) => ({ ...after, ecarts: unique([...(before.ecarts || []), ...(after.ecarts || [])]), decouvertes: after.decouvertes ?? before.decouvertes })
// Command cited by an agent, compared with the task's: without the "cd <working folder> &&" the verifier adds
// (another leading cd is part of the command), without the echo of the exit code, spaces collapsed
const withoutPrefix = (x, dir) => { const m = x.match(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/); return m && dir && m[1].replace(/^["']|["']$/g, '') === dir ? x.slice(m[0].length) : x }
const normalize = (c, dir) => withoutPrefix(String(c || '').trim(), dir).replace(/\s*;\s*echo\s+["']?code=\$\?["']?\s*$/, '').replace(/\s+/g, ' ').trim()
const sameCommand = (a, b, dir) => normalize(a, dir) === normalize(b, dir)
// A review cites a file if one of its words is that path, and not a path that contains it
const pathOf = x => x.replace(/^\.\//, '').replace(/\.+$/, '')
const cite = (d, f) => String(d).split(/[\s,;:()«»"'`]+/).some(x => x && pathOf(x) === pathOf(f))

// Prompts
// Progress (0.8.0): the command the agent runs as is, and what it reports from it
const reportProgress = 'Rends suivi_ok=true si elle sort en code 0 ; sinon suivi_ok=false et la première ligne de son erreur dans suivi_erreur.'
const pStep = (id, step, extra = {}, report = true) => (PROGRESS ? `Suivi du plan : ta première commande, avant toute autre, est \`${progressCmd('etape', { tache: id, etape: step, ...extra })}\`. Lance-la telle quelle, une seule fois. ${report ? reportProgress : 'Son résultat ne compte pas : suivi_ok porte sur la commande de clôture, plus bas.'} Elle ne fait pas partie du travail demandé : refusée ou en échec, elle ne va dans aucun autre champ de ton rapport. Puis continue, quel que soit son résultat.
` : '')
const pRunStart = stop => `Suivi du plan : ta première commande, avant toute autre, ouvre le run : \`${progressCmd('debut-run', { phase: integer(PHASE, 1), mode: MODE, parallelisme: PAR, corrections_max: integer(MAXFIX, 0), decisions_office_max: integer(MAX_AUTO, 0) })}\`. Lance-la telle quelle, une seule fois. Si elle sort en code 0, rends ouverture_ok=true et continue. Sinon, arrête-toi là sans rien faire d'autre : ${stop}, ouverture_ok=false, et la première ligne de son erreur dans suivi_erreur.
`
// SUIVI.md regenerated by the script, just before the scribe's commit
const pView = (cmd, E, effect) => `
- SUIVI.md : n'y touche jamais toi-même. Juste avant le commit, une fois tout le reste écrit, lance \`${progressCmd(cmd, E)}\`, telle quelle, une seule fois : ${effect}. ${reportProgress} Si elle échoue, commite quand même les autres fichiers.`
// A task's branch: new, or taken back from the most recent one (a branch held by another worktree is not taken back, we start from it).
// A branch taken back is brought up to date by a merge of the integration branch, never by a rebase (classified destructive)
const pBranch = t => `Branche : si aucune branche \`tache/${t.id}\` n'existe, crée-la avec \`git switch -c tache/${t.id}\`. Sinon (tentative précédente), reprends le travail le plus récent : \`git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/heads/tache/${t.id} 'refs/heads/tache/${t.id}-r*'\` donne en premier la branche la plus récente ; si aucun worktree ne l'utilise (\`git worktree list\`), place-toi dessus avec \`git switch <branche>\`, sinon crée à partir d'elle \`tache/${t.id}-r<n>\`, avec le premier n libre à partir de 2 (\`git switch -c tache/${t.id}-r<n> <branche>\`). Branche reprise : si \`git merge-base --is-ancestor ${INTEG} HEAD\` sort en code 1, elle ne contient pas les dernières fusions ; mets-la à jour avec \`git merge --no-edit ${INTEG}\`. Un conflit dans tes fichiers possédés se résout ; ailleurs, \`git merge --abort\` et statut blocked. Jamais de rebase ni de reset. Commite tout ton travail sur la branche où tu es et rends son nom exact dans « branche ».`
// Environment setup, declared by the project; a failed command does not stop silently
const pSetup = (t, when, onFailure) => { const c = setupOf(t); return c.length ? `
Préparation de l'environnement, ${when} : lance une à une, telles quelles, ces commandes du projet : ${c.map(x => '`' + x + '`').join(', ')}. ${onFailure}` : '' }
const pWorker = (t, isolated, model) => `${pStep(t.id, 'worker', { isole: !!isolated, modele: model })}Tâche ${t.id} du plan ${PLAN}. Lis d'abord ${PLAN}/DISCOVERY.md et les décisions de ${PLAN}/HANDOFF.md, puis ${t.fichier}, et suis son « Prompt de lancement ».
${isolated ? "Tu es dans un worktree isolé : la garde d'isolement de Claude Code n'y accepte que des commandes simples (voir tes règles)." : `Tu es dans le checkout principal, sur ${INTEG}.`} ${pBranch(t)}${pSetup(t, 'une fois sur ta branche, avant tout autre travail', "Si l'une échoue, continue, et décris l'échec (commande et extrait de sa sortie) dans un écart. Si elles modifient des fichiers suivis que tu ne possèdes pas, ne les commite pas et décris-le dans un écart.")}
Décisions prises : ${JSON.stringify(runDecisions())}.
Un fichier que tes permissions t'interdisent de lire ou de modifier (réglages de l'organisation ou du projet) : ne contourne jamais l'interdiction, par aucune commande ni script ; décris la modification attendue dans un écart de type « relecture », l'humain la fera avant la PR.
Lance les commandes de vérification de la tâche avant de rendre la main.
Rapport : statut, résumé, branche, dernier commit, chemin absolu du dossier de travail (pwd), fichiers modifiés, écarts au plan, découvertes utiles aux tâches suivantes.`
const pVerif = (t, r) => `${pStep(t.id, 'vérification')}Vérifie la tâche ${t.id}, branche ${r.branche}. Exécute une par une, sans rien modifier, chaque commande ci-dessous, préfixée par \`cd "${r.chemin}" &&\` :
${bullets(t.verification)}
Les échecs listés comme préexistants dans ${PLAN}/DISCOVERY.md ne comptent pas. Une commande que tes permissions refusent (réglages de l'organisation ou du projet) : ne la contourne jamais, par aucune autre commande ni script, et ne la compte pas en échec ; cite-la dans « interdites », telle qu'elle figure dans la liste ci-dessus, sans le préfixe \`cd\` ; l'humain la lancera avant la PR. Si une commande de test échoue, relance-la une seule fois : si elle passe, la vérification passe, mais cite chaque test qui a échoué puis réussi dans « instables ». Pour lire un code de sortie, ne pipe pas la commande : ajoute \`; echo "code=$?"\`. Rends ok ; dans « resultats », pour chaque commande, même réussie, la commande, son code de sortie (celui de la relance s'il y en a eu une) et l'extrait qui le prouve (ligne de bilan, 10 lignes au plus) ; dans « echecs », pour chaque échec qui compte, la commande et un extrait utile de sa sortie (30 lignes au plus). Ne lance jamais une commande qui lit des données de production ou personnelles réelles (dump de prod, base de prod ou copie de prod) : compte-la en échec, avec l'extrait « besoin-humain : données réelles, geste réservé à l'humain ».`
const pEval = (t, r, v) => `${pStep(t.id, 'évaluation')}Évalue la tâche ${t.id}. Lis la définition du fini dans ${t.fichier}, puis le diff \`git -C "${r.chemin}" diff ${INTEG}...${r.branche}\`.
Résultats du vérificateur, relevés sur cette branche juste avant toi ; ils valent preuve d'exécution : ${JSON.stringify((v && v.resultats) || [])}.${v && (v.instables || []).length ? ` Tests passés seulement à la relance, comptés comme passés : ${JSON.stringify(v.instables)}.` : ''}
${(v && (v.interdites || []).length) ? `Commandes refusées aux agents par leurs permissions, que l'humain lancera avant la PR : ${JSON.stringify(v.interdites)}. Un critère que seules elles démontrent n'est ni un manque ni un critère non vérifiable.
` : ''}Rapport du worker ; c'est un livrable, pas une preuve : ses affirmations d'exécution ne démontrent rien. ${JSON.stringify({ resume: r.resume, decouvertes: r.decouvertes || [], ecarts: r.ecarts || [] })}
Pour chaque critère, cherche une preuve : fichier:ligne du diff, test qui le couvre, ou résultat du vérificateur ci-dessus. Un critère qui demande un contenu de rapport est rempli si ce contenu figure dans le rapport du worker. SUIVI.md, HANDOFF.md et DISCOVERY.md ne sont écrits par le scribe qu'en fin de tâche : leur état ne prouve rien, dans un sens comme dans l'autre. Un critère qu'aucune commande de vérification ni le diff ne peut démontrer dans le contexte de cette tâche, quoi que fasse le worker (par exemple un comportement en worktree pour une tâche du checkout principal), n'est pas un manque : cite-le dans « non_verifiables » avec la raison. C'est rare : un critère seulement non prouvé reste un manque. Un fichier du diff que tes permissions t'interdisent de lire (réglages de l'organisation ou du projet) : ne contourne jamais l'interdiction ; ce n'est ni un manque ni un critère non vérifiable : cite-le dans « illisibles », l'humain le relira avant la PR. Un critère qui ne se démontre qu'en lisant un tel fichier suit la même règle. Vérifie aussi que les commentaires, en-têtes, entrées de DECISIONS et procédures ajoutés ou modifiés par le diff disent vrai : ils décrivent ce que le code fait vraiment, et chaque commande d'une procédure destinée à un humain existe dans le dépôt et fait ce que le texte annonce. Un texte faux est un manque. Verdict ko si un seul critère démontrable n'est pas démontré ; liste alors les manques précis. Ne modifie rien.`
const pFix = (t, r, gaps, rejection, choice) => `${pStep(t.id, 'correction', { refus: rejection && { ...rejection, manques: shorts(rejection.manques) }, modele: choice.modele, ...(choice.changement ? { changement: choice.changement } : {}) })}Correction de la tâche ${t.id}. Travaille dans ${r.chemin}, sur la branche ${r.branche} : préfixe chaque commande par \`cd "${r.chemin}" &&\` et édite les fichiers par leur chemin absolu sous ce dossier. Relis ${t.fichier} et ${PLAN}/DISCOVERY.md.
Manques à corriger :
${bullets(gaps)}
Mêmes règles que la tâche : fichiers possédés seulement, commits sur ${r.branche}, rien dans les fichiers de suivi${PROGRESS ? ' (la commande de suivi ci-dessus mise à part)' : ''}, ni fusion dans une autre branche ni push.${setupOf(t).length ? ` Si ta correction change les dépendances ou ce qui se génère, relance d'abord, dans ce dossier, ces commandes de préparation du projet : ${setupOf(t).map(x => '\`' + x + '\`').join(', ')}.` : ''} Relance les vérifications, puis rends le même format de rapport.${(r.ecarts || []).length ? `
Écarts déjà remontés aux essais précédents, gardés dans le suivi : ${JSON.stringify(r.ecarts)}. Ne les répète pas ; si ta correction en annule un, dis-le dans un écart.` : ''}${(r.decouvertes || []).length ? `
Découvertes des essais précédents : ${JSON.stringify(r.decouvertes)}. Rends dans ton rapport la liste à jour : celles qui tiennent toujours, sans celles que ta correction rend fausses, plus les nouvelles.` : ''}`
const pMerge = (t, r, isolated, check) => `${pStep(t.id, 'fusion')}Fusionne la tâche ${t.id} dans le checkout principal : \`git switch ${INTEG}\`, puis \`git merge --no-ff ${r.branche} -m "tâche ${t.id} : ${t.titre}"\`.
En cas de conflit : \`git merge --abort\`, puis rends ok=false, fusionne=false, conflit=true et les fichiers en cause.
Sinon, rends fusionne=true.${pSetup(t, `sur ${INTEG}, après la fusion et avant le contrôle`, "Si l'une échoue, ne lance pas le contrôle : rends controle_ok=false, avec « préparation : » suivi de la commande et d'un extrait de sa sortie dans detail. Après elles, \`git status --porcelain\` doit être vide : une préparation ne modifie aucun fichier suivi et ne laisse aucun fichier non ignoré ; sinon, ne lance pas le contrôle et rends controle_ok=false, avec « préparation : fichiers modifiés » et leur liste dans detail.")}
Puis lance sur ${INTEG} cette commande de contrôle, sans pipe (ajoute \`; echo "code=$?"\`) : ${check}. Rends controle_ok selon son code de sortie, un extrait utile dans detail en cas d'échec, et ok=true seulement si la fusion et le contrôle ont réussi.${isolated ? `
Supprime ensuite le worktree : \`git worktree unlock "${r.chemin}"\` (ignore l'erreur), puis \`git worktree remove --force "${r.chemin}"\`. Garde la branche.` : ''}`
// Choice of the model of the next fix (0.11.0): the attempt's rejection, the earlier rejections and their models
const pChoice = (t, rejection, before, previous) => `Choix du modèle de la correction ${rejection.essai} de la tâche ${t.id} (${t.fichier}). Modèle prévu par le plan : ${t.modele}${t.raison_modele ? ` (« ${oneLine(t.raison_modele)} »)` : ''} ; c'est un plancher : la correction ne tournera jamais sur un modèle plus faible. L'essai ${rejection.essai}, sur ${before}, a été refusé par ${rejection.par === 'vérification' ? 'la vérification' : "l'évaluation"}. Manques : ${JSON.stringify(rejection.manques)}.${previous.length ? ` Essais refusés avant lui : ${JSON.stringify(previous)}.` : ''}
Rends modele (haiku, sonnet ou opus) et raison, en une ligne : haiku pour un manque mécanique (texte, format, renommage, configuration), sonnet pour un manque d'implémentation, opus pour un manque d'architecture, ambigu, qui touche plusieurs modules, ou qui revient après une correction sur le même modèle. Tu peux lire le fichier de la tâche. Ne classe aucun écart, ne prépare aucun point et ne modifie rien.`
const pReplan = (t, r, status, gaps, unverifiable, sensitive = []) => `Replanification après ${t.id} (statut : ${status}, phase ${PHASE}${LAST ? ', dernière phase du plan' : ''}, mode ${MODE}). Tâche : ${t.fichier} ; son code est sur la branche ${r.branche}${status === 'fusionnée' ? `, fusionnée dans ${INTEG} (checkout principal)` : `, dans ${r.chemin}`}. Écarts remontés : ${JSON.stringify(r.ecarts || [])}. Manques : ${JSON.stringify(gaps)}. Critères non vérifiables dans le contexte de la tâche : ${JSON.stringify(unverifiable || [])}.${sensitive.length ? ` Écarts sensibles (données, base, prod, secret), majeurs d'office : rends un point pour chacun, sauf pour un écart qui ne porte que sur un fichier interdit aux agents (voir plus bas) : ${JSON.stringify(sensitive)}.` : ''}
Lis ${PLAN}/SUIVI.md, les décisions de ${PLAN}/HANDOFF.md, ${PLAN}/PREREQUIS.md s'il existe, et les tâches restantes de ${PLAN}/taches/. Classe chaque écart mineur ou majeur selon ta grille et rends une entrée par écart, sauf pour ceux que tu rends dans « relectures ».
Pour chaque écart majeur et chaque critère non vérifiable, rends un point dans « points » : titre, contexte, 2 ou 3 options dont une seule recommandée. Chaque option porte ses actions : entrées HANDOFF, tâches à ajouter (phase ${PHASE} ou plus, jamais une phase passée ; une tâche ajoutée cite dans « prerequis » les prérequis de PREREQUIS.md dont elle a besoin), amendements de tâches pas encore lancées, autres que ${t.id} (critères, fichiers possédés, commandes de vérification ou dépendances à ajouter, jamais rien à retirer). Pour une tâche déjà fusionnée, propose une tâche à ajouter plutôt qu'un amendement. Une option ne cite que des tâches et des fichiers qui existent déjà ou qu'elle crée elle-même. Aucune option ne fait lire, restaurer ou copier des données de production ou personnelles réelles par un agent : ce geste revient à l'humain. Recommande l'option la plus prudente pour la sécurité et les données : un test ou une garde de plus plutôt qu'un risque accepté.${MODE === 'auto' ? ` Mode autonome : l'option recommandée sera appliquée telle quelle, sans relecture humaine avant la PR.` : ''}${LAST ? ` Dernière phase : ne propose une tâche que pour un point qui protège le déploiement, la sécurité ou les données ; pour les autres, une entrée de type « ticket » (à ouvrir après la PR), sans tâche.` : ''}
Un fichier que les agents n'ont pas le droit de lire ou d'écrire (réglages de l'organisation ou du projet), et qu'il suffit à l'humain de relire ou de modifier avant la PR, n'est jamais un point ni une entrée : rends-le dans « relectures », avec dans « relecture » le fichier et ce que l'humain doit y relire ou modifier, et dans « ecart » la description, recopiée telle quelle, de l'écart remonté qu'elle remplace, s'il ne porte que sur ce fichier et n'est pas de type besoin-humain. Un écart qui porte aussi sur autre chose reste un écart. S'il faut un geste humain avant de pouvoir continuer (un secret manquant pour lancer les tests, par exemple), c'est un besoin humain, pas une relecture. Marque « humain » un point qu'aucun agent ne peut trancher (accès, secret, production, données réelles, choix produit), un point qui porte sur un prérequis ouvert de PREREQUIS.md (décision reportée par l'utilisateur, geste humain), un écart de type besoin-humain, ou un problème d'environnement ou d'outillage dont la cause n'est pas démontrée par une sortie de commande citée ci-dessus. Ne modifie rien.`

// Shared instructions for the scribe: created tasks, amendments, check by plan-lint, report
const pUpdates = (id, updates, view = '') => `${updates.taches.length ? `
- Nouvelles tâches : crée-les dans ${PLAN}/taches/ avec le contenu fourni, tel quel, et ${PROGRESS ? 'ne touche pas à SUIVI.md : la commande de suivi ci-dessous y ajoute leur ligne' : 'ajoute leur ligne à SUIVI.md, statut « ajoutée »'} : ${JSON.stringify(updates.taches)}` : ''}${updates.amendements.length ? `
- Amendements, pour des tâches pas encore lancées : dans le frontmatter de chaque tâche visée, ajoute les éléments listés à la fin de la liste correspondante (definition_du_fini, fichiers_possedes, verification, depend_de), sans rien retirer ni reformuler, puis note « amendement · majeur · <id> : <raison> » sous « ## ${id} » dans HANDOFF.md. N'amende pas une tâche absente du plan : rends-la dans « refuses ». Une tâche « fusionnée » ou « annulée » dans SUIVI.md ne s'amende plus : note « angle-mort · majeur · amendement non appliqué à <id> : <raison> » sous « ## ${id} » dans HANDOFF.md et rends-la dans « ecartes », pas dans « refuses ». Amendements : ${JSON.stringify(updates.amendements)}` : ''}${updates.ecartes.length ? `
- Amendements non appliqués, car la tâche visée est déjà lancée ou terminée : note chacun sous « ## ${id} » dans HANDOFF.md, en « angle-mort · majeur · amendement non appliqué à <id> : <raison> » : ${JSON.stringify(updates.ecartes)}` : ''}${(updates.office || []).length ? `
- Décisions prises d'office dans ce suivi : ${JSON.stringify(updates.office)}. Pour chaque chemin de fichier qu'elles citent, vérifie qu'il existe dans le dépôt (\`test -e <chemin>\`) ou qu'une tâche créée ici le possède ; sinon, note « besoin-humain · majeur · décision d'office incohérente : <chemin> n'existe pas et aucune tâche ne le crée » sous « ## ${id} » dans HANDOFF.md et rends la décision dans « refuses ».` : ''}${updates.taches.length || updates.amendements.length ? `
- Puis lance \`${LINTCMD} ${PLAN} --integration ${INTEG}${BASE}\`. Toute erreur qui vise une tâche créée ou amendée ici : remets cette tâche dans son état d'origine (\`git checkout HEAD -- <fichier>\` pour un fichier amendé ; pour une tâche créée, retire son fichier${PROGRESS ? '' : ' et sa ligne de SUIVI.md'}).
- Chaque tâche créée ou amendée que tu n'as pas pu appliquer, ou que tu as remise dans son état d'origine : note « besoin-humain · majeur · <id> non appliquée : <raison> » sous « ## ${id} » dans HANDOFF.md, et rends-la dans « refuses ».` : ''}${view}
Rends ok=true une fois le commit fait, avec son hash, « refuses » (vide si tout est appliqué) et « ecartes » (vide si aucun amendement ne visait une tâche fusionnée ou annulée).`
const pScribe = (t, status, attempts, r, updates, gaps, { instables: flaky = [], refus: rejections = [], nonVerif: unverifiable = [] } = {}, closeInput = null) => `${PROGRESS ? `${pStep(t.id, 'suivi', {}, false)}Dans le checkout principal, place-toi ensuite sur la branche d'intégration : \`git switch ${INTEG}\`. Mets à jour le suivi du plan ${PLAN}, puis commite SUIVI.md, HANDOFF.md et DISCOVERY.md, et les tâches créées ou amendées, avec le message « suivi(${t.id}) : ${status} ».` : `Dans le checkout principal, commence par \`git switch ${INTEG}\`. Mets à jour le suivi du plan ${PLAN}, puis commite ces seuls fichiers, et les tâches créées ou amendées, avec le message « suivi(${t.id}) : ${status} ».
- SUIVI.md : ligne ${t.id} → statut « ${status} », essais ${attempts}, branche ${r ? r.branche : '—'} ; tokens réels : « voir /workflows ».`}
- HANDOFF.md : sous « ## ${t.id} », ajoute ces entrées : ${JSON.stringify(updates.entrees)}${gaps.length ? `, et ce blocage : ${JSON.stringify(gaps)}` : ''}.${(rejections || []).length ? `
- HANDOFF.md, toujours sous « ## ${t.id} » : une entrée « refus · mineur · essai <n>, <par> : <manques séparés par « ; »> » pour chacun de ces essais refusés puis corrigés : ${JSON.stringify(rejections)}` : ''}${unverifiable.length ? `
- HANDOFF.md, toujours sous « ## ${t.id} » : une entrée « angle-mort · mineur · critère non vérifiable dans le contexte de la tâche : <critère et raison> » pour chacun de ceux-ci : ${JSON.stringify(unverifiable)}` : ''}
- DISCOVERY.md : intègre ces découvertes sans doublon, dans la bonne section : ${JSON.stringify((r && r.decouvertes) || [])}.${(flaky || []).length ? `
- Tests instables (passés à la relance) : ajoute-les dans DISCOVERY.md, section Pièges, et une entrée « dette · mineur » dans HANDOFF.md : ${JSON.stringify(flaky)}` : ''}${pUpdates(t.id, updates, PROGRESS ? pView('cloture', closeInput, 'elle clôt la tâche dans suivi.json et régénère le tableau de SUIVI.md') : '')}`
const pRuling = (a, updates, opens = false) => PROGRESS ? `${opens ? pRunStart('rends ok=false') : ''}Dans le checkout principal, ${opens ? 'ensuite, ' : ''}commence par \`git switch ${INTEG}\`. Applique l'arbitrage de l'utilisateur au plan ${PLAN}, puis commite SUIVI.md, HANDOFF.md et les tâches créées ou amendées, avec le message « suivi(${a.tache}) : arbitrage ${a.option.id} ».
- HANDOFF.md : sous « ## ${a.tache} » (crée ce titre s'il manque), ajoute ces entrées : ${JSON.stringify(updates.entrees)}.${pUpdates(a.tache, updates, pView('arbitrage', {
  tache: a.tache, titre: a.titre, option: a.option.id,
  ...(updates.taches.length ? { taches_ajoutees: updates.taches.map(x => ({ id: x.id, titre: x.titre, phase: x.phase })) } : {}),
  ...(updates.amendements.length ? { amendements: updates.amendements.map(m => ({ id: m.id, raison: m.raison })) } : {}),
}, "elle note l'arbitrage dans suivi.json et régénère le tableau de SUIVI.md"))}` : `Dans le checkout principal, commence par \`git switch ${INTEG}\`. Applique l'arbitrage de l'utilisateur au plan ${PLAN}, puis commite ces seuls fichiers, et les tâches créées ou amendées, avec le message « suivi(${a.tache}) : arbitrage ${a.option.id} ».
- HANDOFF.md : sous « ## ${a.tache} » (crée ce titre s'il manque), ajoute ces entrées : ${JSON.stringify(updates.entrees)}.${pUpdates(a.tache, updates)}`
const pReader = opens => `${opens ? pRunStart('rends ok=false et taches vide') : ''}Exécute \`${LINTCMD} ${PLAN} --json --phase ${PHASE} --integration ${INTEG}${BASE}\` et rends son JSON tel quel${opens ? ', avec ouverture_ok' : ''}.`
// End of run: the clerk runs fin-run with the summary, then commits SUIVI.md if it changed (task closed without a scribe, exception E:316)
const withoutActions = p => ({
  tache: p.tache, titre: short(p.titre), contexte: short(p.contexte), humain: !!p.humain, ...(p.coupe_circuit ? { coupe_circuit: true } : {}), ...(p.incoherence ? { incoherence: short(p.incoherence) } : {}),
  options: (p.options || []).map(o => ({ id: o.id, description: short(o.description), ...(o.impact !== undefined ? { impact: short(o.impact) } : {}), ...(o.recommande !== undefined ? { recommande: !!o.recommande } : {}) })),
})
// What fin-run reads from the summary: without the options' actions or the workers' summaries, for a short command
const progressSummary = v => ({
  statut: v.statut, detail: v.detail == null ? null : short(Array.isArray(v.detail) ? v.detail.join(' ; ') : v.detail, 600), ...(v.arbitrage ? { arbitrage: withoutActions(v.arbitrage) } : {}), points_a_trancher: (v.points_a_trancher || []).map(withoutActions),
  // essais 0: task closed by an exception (catch of runTask), without known attempts or branch; progress keeps its own
  taches: (v.taches || []).map(x => ({ id: x.id, statut: x.statut, ...(x.essais ? { essais: x.essais, branche: x.branche ?? null } : {}), ...(x.blocage ? { blocage: shorts(x.blocage) } : {}) })),
  decisions_office: (v.decisions_office || []).map(d => ({ ...d, description: short(d.description) })), arbitrages_appliques: v.arbitrages_appliques || [],
  amendements_ecartes: (v.amendements_ecartes || []).map(e => ({ tache: e.tache, id: e.id, raison: short(e.raison) })),
  taches_ajoutees: (v.taches_ajoutees || []).map(x => ({ ...x, ...(parents.has(x.id) ? { ajoutee_par: parents.get(x.id) } : {}) })), reportees: v.reportees || [], non_lancees: v.non_lancees || [], en_attente: v.en_attente || [], en_attente_prerequis: v.en_attente_prerequis || [],
})
const pClerk = v => `Fin du run : phase ${PHASE} du plan ${PLAN}, statut « ${v.statut} ». Dans le checkout principal, dans cet ordre :
1. \`git switch ${INTEG}\`.
2. \`${progressCmd('fin-run', progressSummary(v))}\`, telle quelle, une seule fois. ${reportProgress}
3. \`git diff --quiet HEAD -- ${PLAN}/SUIVI.md\` : s'il sort en code 1, SUIVI.md a changé : \`git commit -m "suivi : fin du run de la phase ${PHASE}" -- ${PLAN}/SUIVI.md\`, qui ne commite que ce fichier, et rends son hash dans commit. Sinon, pas de commit.
4. \`${WTCMD} nettoyer ${PLANARG}\` : il retire les worktrees propres que les tâches du plan ont laissés (branches gardées). Rends sa sortie, ou son message d'erreur, dans worktrees.
Si le point 1 échoue, lance quand même le point 2, saute les points 3 et 4 et dis pourquoi dans detail. Si le commit échoue, dis pourquoi dans detail. Sinon, laisse detail vide. Ne lance rien d'autre et ne modifie aucun autre fichier.`

// Run state
let stop = null
const issues = [], added = [], results = [], autoDecisions = [], deferred = [], discardedRun = [], rulingsApplied = []
// Progress (0.8.0): run opened by debut-run, and failed script calls (only the display suffers, except close and ruling)
let opened = false
const progressFailures = []
// Added task → task whose close created it, for fin-run (a close not written leaves them out of progress)
const parents = new Map()
const noteProgress = (task, step, x) => { if (PROGRESS && x && x.suivi_ok !== true) progressFailures.push({ tache: task, etape: step, erreur: x.suivi_erreur || (x.suivi_ok === false ? 'échec sans message' : 'résultat non rapporté') }) }
// Amended tasks whose progress is not yet committed (counter per task): they only start afterwards
const amended = new Map()
// The first issue stops the run; the next ones go to points_a_trancher. bucket: the issues of the current close, for progress
const stopOn = (p, bucket) => { if (bucket) bucket.push(p); if (!stop) stop = p; else issues.push(p) }
// An added task never runs in a phase already past
const toPhase = x => { const p = Math.max(Number(x.phase) || PHASE, PHASE); return { ...x, phase: p, contenu: String(x.contenu || '').replace(/^phase:\s*\d+/m, `phase: ${p}`) } }
// Options keep their actions: the chosen option comes back as is in args.arbitrages
const issueOf = (t, pt) => ({ tache: t.id, titre: pt.titre, contexte: pt.contexte || '', humain: !!pt.humain, options: pt.options || [] })
const humanIssue = (id, title, context, options = []) => ({ tache: id, titre: title, contexte: context, humain: true, options })
const runDecisions = () => [...DECISIONS, ...RULINGS.map(a => `${a.titre} : ${a.option.description} (arbitré par l'utilisateur)`), ...autoDecisions.map(o => `${o.titre} : ${o.description} (prise d'office)`)]

// Every exit after the run start goes through finish: the clerk closes the run in progress (fin-run)
let worktrees = null
async function finish(v) {
  if (PROGRESS && opened) {
    // A clerk that throws must not lose the summary: issues and actions live only in the return value
    let g = null
    try { g = await agent(pClerk(v), { label: 'fin de run · suivi', agentType: AG('greffier'), model: 'haiku', schema: CLERK_S }) } catch (err) { progressFailures.push({ tache: null, etape: 'fin-run', erreur: `greffier en erreur : ${String(err)}` }); g = undefined }
    if (g === null) progressFailures.push({ tache: null, etape: 'fin-run', erreur: 'greffier sans réponse' })
    else if (g) {
      noteProgress(null, 'fin-run', g)
      if (g.detail) progressFailures.push({ tache: null, etape: 'fin-run', erreur: `SUIVI.md non commité : ${g.detail}` })
      if (g.worktrees) worktrees = g.worktrees
    }
  }
  return PROGRESS ? { ...v, suivi_echecs: progressFailures, ...(worktrees ? { worktrees } : {}) } : v
}
// Run start refused by the script (lock, unreadable SUIVI.md or suivi.json…): every following write would fail, nothing starts
const notOpened = x => {
  const error = x.suivi_erreur || (x.ouverture_ok === false ? 'échec sans message' : 'résultat non rapporté')
  return { statut: 'erreur', phase: PHASE, mode: MODE, detail: `suivi : run non ouvert (debut-run), aucune tâche lancée — ${error}`, arbitrages_appliques: rulingsApplied, suivi_echecs: [...progressFailures, { tache: null, etape: 'debut-run', erreur: error }] }
}

phase('Lecture du plan')
// User rulings: the scribe writes the decision and applies the actions of the chosen option.
// With progress, the first of them opens the run: the ruling is noted in the run that applies it
for (const [i, a] of RULINGS.entries()) {
  const o = a.option
  const opens = !!PROGRESS && i === 0
  const updates = { entrees: [{ type: 'décision', gravite: 'majeur', description: `${a.titre} : option ${o.id} arbitrée par l'utilisateur — ${o.description}` }, ...(o.entrees || [])], taches: (o.taches_ajoutees || []).map(toPhase), amendements: o.amendements || [], ecartes: [], office: [] }
  const s = await agent(pRuling(a, updates, opens), { label: `arbitrage ${a.tache} · suivi`, agentType: AG('scribe'), model: 'sonnet', schema: opens ? requireFields(SCRIBE_S, 'suivi_ok', 'ouverture_ok') : requireFields(SCRIBE_S, 'suivi_ok') })
  if (opens && s) { if (s.ouverture_ok !== true) return notOpened(s); opened = true }
  if (s && s.ok) rulingsApplied.push({ tache: a.tache, titre: a.titre, option: o.id })
  // Amendment of a task merged in the meantime: discarded and recorded, the run goes on
  if (s) discardedRun.push(...(s.ecartes || []).map(e => ({ tache: a.tache, ...e })))
  noteProgress(a.tache, 'arbitrage', s && s.ok ? s : null)
  // Ruling applied but not noted in progress: stop, as for a close
  const progressKo = !!PROGRESS && !!s && s.ok && s.suivi_ok !== true
  if (!s || !s.ok || (s.refuses || []).length || progressKo) return await finish({ statut: 'arbitrage', phase: PHASE, mode: MODE, arbitrage: humanIssue(a.tache, `Arbitrage « ${a.titre} » ${s && s.ok ? 'appliqué en partie' : 'non appliqué'}`, !s ? 'scribe sans réponse' : (s.refuses || []).length || !progressKo ? JSON.stringify(s.refuses || []) : `HANDOFF.md et tâches commités, mais suivi.json et SUIVI.md non écrits : ${s.suivi_erreur || 'résultat non rapporté'}`), arbitrages_appliques: rulingsApplied, amendements_ecartes: discardedRun, taches: [], points_a_trancher: [], decisions_office: [] })
}
// Without a ruling, the plan reader opens the run
const readerOpens = !!PROGRESS && !RULINGS.length
const plan = await agent(pReader(readerOpens), { label: 'lecteur-plan', agentType: AG('lecteur-plan'), model: 'haiku', schema: readerOpens ? requireFields(PLAN_S, 'ouverture_ok') : PLAN_S })
if (readerOpens && plan) { if (plan.ouverture_ok !== true) return notOpened(plan); opened = true }
if (!plan || !plan.ok) return await finish({ statut: 'erreur', phase: PHASE, detail: plan ? plan.erreurs : 'lecteur-plan sans réponse', arbitrages_appliques: rulingsApplied })
const T = new Map(plan.taches.map(t => [t.id, t]))
const done = new Set(plan.taches.filter(t => DONE(t.statut)).map(t => t.id))
const deps = t => (t.depend_de || []).filter(d => T.has(d))
const ancestors = (id, seen = new Set()) => { for (const d of deps(T.get(id))) if (!seen.has(d)) { seen.add(d); ancestors(d, seen) } return seen }
const shares = (a, b) => (a.ressources || []).some(r => (b.ressources || []).includes(r))
const canOverlap = (a, b) => a.id !== b.id && !ancestors(a.id).has(b.id) && !ancestors(b.id).has(a.id) && !shares(a, b)
// All the plan's tasks (consistency of auto-decisions) and last phase (convergence)
const ALL = plan.tous && plan.tous.length ? plan.tous : plan.taches
const PREFIXES = [...new Set(ALL.map(x => (String(x.id).match(/^[A-Z]+/) || [''])[0]).filter(Boolean))]
const RE_ID = new RegExp(`\\b(?:${PREFIXES.join('|') || 'T'})\\d+[A-Z]*\\b`, 'g')
// Task of another phase already merged or cancelled: it can no longer be amended
const doneElsewhere = id => !T.has(id) && DONE((ALL.find(x => x.id === id) || {}).statut)
// Without phase_max (old plan-lint), no convergence instruction
const LAST = plan.phase_max ? PHASE >= Number(plan.phase_max) : false

// Running a task
// Autonomous mode: applies the recommended option of an issue (decision, entries, tasks, amendments)
function applyRecommended(t, pt, updates) {
  const recommended = (pt.options || []).filter(o => o.recommande)
  // No recommended option, or several: a human settles
  if (recommended.length !== 1) return stopOn(issueOf(t, pt), updates.points)
  const rec = recommended[0]
  // Consistency: every task cited exists in the plan, or the option (or the run) creates it
  const known = new Set([...ALL.map(x => x.id), ...added.map(x => x.id), ...updates.taches.map(x => x.id), ...(rec.taches_ajoutees || []).map(x => x.id)])
  const text = [rec.description, ...(rec.entrees || []).map(e => e.description), ...(rec.amendements || []).map(a => a.raison)].join(' ')
  const unknown = [...new Set([...(text.match(RE_ID) || []), ...(rec.amendements || []).flatMap(a => [a.id, ...(a.depend_de || [])])])].filter(id => !known.has(id))
  if (unknown.length) return stopOn({ ...issueOf(t, pt), incoherence: `tâches citées qui n'existent pas et que l'option ne crée pas : ${unknown.join(', ')}` }, updates.points)
  if (autoDecisions.length >= MAX_AUTO) return stopOn({ ...issueOf(t, pt), coupe_circuit: true }, updates.points)
  const decision = { tache: t.id, titre: pt.titre, option: rec.id, description: rec.description }
  autoDecisions.push(decision)
  updates.decisions.push(decision)
  updates.office.push(`${pt.titre} : ${rec.description}`)
  updates.entrees.push({ type: 'décision', gravite: 'majeur', description: `${pt.titre} : option ${rec.id} prise d'office (mode autonome) — ${rec.description}` }, ...(rec.entrees || []))
  updates.taches.push(...(rec.taches_ajoutees || []).map(toPhase))
  const fresh = new Set([...added, ...updates.taches].map(x => x.id))
  for (const am of rec.amendements || []) {
    if (done.has(am.id) || doneElsewhere(am.id) || running.has(am.id)) { updates.ecartes.push(am); discardedRun.push({ tache: t.id, ...am }); continue }
    updates.amendements.push(am)
    const c = T.get(am.id)
    if (!c) continue
    amended.set(am.id, (amended.get(am.id) || 0) + 1)
    c.verification = [...(c.verification || []), ...(am.verification || [])]
    c.depend_de = [...(c.depend_de || []), ...(am.depend_de || [])]
    // New dependency on a task added during this run: the task waits for the next run
    if ((am.depend_de || []).some(d => fresh.has(d)) && pending.delete(am.id)) deferred.push(am.id)
  }
}

async function closeTask(t, status, attempts, r, gaps = [], trace = {}) {
  const flaky = [...new Set(trace.instables || [])], rejections = trace.refus || [], unverifiable = trace.nonVerif || []
  // issues and decisions: those of this close, passed to progress (cloture); tasks running in parallel have their own
  const updates = { entrees: [...(trace.entrees || [])], taches: [], amendements: [], ecartes: [], office: [], points: [...(trace.points || [])], decisions: [] }
  // Files and commands the agents may not read, write or run: review by the human before the PR, without an issue or a stop
  const reviews = [...((r && r.ecarts) || []).filter(e => e.type === 'relecture').map(e => e.description), ...(trace.interdites || []).map(c => `commande \`${c}\` refusée aux agents : à lancer par l'humain avant la PR`)]
  const deviations = ((r && r.ecarts) || []).filter(e => e.type !== 'relecture')
  let reclassified = new Set()
  // Sensitive deviations (data, database, prod, secret): major automatically, whatever the rating
  const sensitive = deviations.filter(e => e.type !== 'besoin-humain' && SENSITIVE.test(e.description || '')).map(e => e.description)
  const majorIfSensitive = e => (SENSITIVE.test(e.description || '') ? { ...e, gravite: 'majeur' } : e)
  let humanSeen = false
  const replan = !!(r && (deviations.length || status !== 'fusionnée' || unverifiable.length))
  if (replan) {
    const rp = await agent(pReplan(t, { ...r, ecarts: deviations }, status, gaps, unverifiable, sensitive), { label: `${t.id} · replanification`, agentType: AG('replanificateur'), model: 'opus', schema: REPLAN_S })
    if (rp) {
      // Forbidden file reported as an ordinary deviation: the replanner reclassifies it as a review, which is neither an issue nor a sensitive deviation
      reclassified = new Set((rp.relectures || []).map(x => x.ecart).filter(Boolean))
      reviews.push(...(rp.relectures || []).map(x => x.relecture), ...(rp.entrees || []).filter(e => e.type === 'relecture').map(e => e.description))
      updates.entrees.push(...(rp.entrees || []).filter(e => e.type !== 'relecture').map(majorIfSensitive))
      updates.taches.push(...(rp.taches_ajoutees || []).map(toPhase))
      // One issue per major deviation or unverifiable criterion: human → stop; otherwise by mode
      for (const pt of rp.points || []) {
        if (pt.humain) { humanSeen = true; stopOn(issueOf(t, pt), updates.points) }
        else if (MODE === 'auto') applyRecommended(t, pt, updates)
        else if (MODE === 'devia') stopOn(issueOf(t, pt), updates.points)
        else { const p = issueOf(t, pt); updates.points.push(p); issues.push(p) }
      }
      // A sensitive deviation without any decision issue: a human settles
      // Reclassification refused for a deviation made sensitive by other words than the mention of a .env: a human settles, whatever the other issues
      const disputed = sensitive.filter(d => reclassified.has(d) && SENSITIVE_NOT_ENV.test(d))
      if (disputed.length) { humanSeen = true; stopOn(humanIssue(t.id, `Écart sensible de ${t.id} reclassé en relecture`, disputed.join(' ; ')), updates.points) }
      const remaining = sensitive.filter(d => !reclassified.has(d))
      if (remaining.length && !(rp.points || []).length) { humanSeen = true; stopOn(humanIssue(t.id, `Écart sensible de ${t.id} sans point de décision`, remaining.join(' ; ')), updates.points) }
    } else {
      // Without a rating, nothing passes silently: deviations noted major, stop for a human
      updates.entrees.push(...deviations.map(e => ({ type: e.type, gravite: 'majeur', description: `${e.description} (non classé : replanificateur sans réponse)` })))
      humanSeen = true
      stopOn(humanIssue(t.id, `Replanification de ${t.id} sans réponse`, 'Écarts, manques et critères non vérifiables non classés : les relire dans HANDOFF.md.'), updates.points)
    }
  }
  // File unreadable for the evaluator: a generic entry, unless a review already cites it
  reviews.push(...(trace.illisibles || []).filter(f => !reviews.some(d => cite(d, f))).map(f => `${f} : illisible par les agents, à relire par l'humain avant la PR`))
  const allReviews = [...new Set(reviews)]
  updates.entrees.push(...allReviews.map(d => ({ type: 'relecture', gravite: 'majeur', description: d })))
  const needs = deviations.filter(e => e.type === 'besoin-humain')
  if (needs.length && !humanSeen) stopOn(humanIssue(t.id, `Besoin humain signalé par ${t.id}`, needs.map(e => e.description).join(' ; ')), updates.points)
  // Unmerged task that waits for a human: it only restarts on their decision (args.relancer)
  const final = status !== 'fusionnée' && (humanSeen || needs.length) ? 'besoin-humain' : status
  added.push(...updates.taches)
  for (const x of updates.taches) parents.set(x.id, t.id)
  // Close in progress (0.8.0): what the scribe passes to suivi.mjs cloture
  const closeInput = PROGRESS ? {
    tache: t.id, statut: final, essais: attempts, branche: r ? r.branche : null,
    ...(rejections.length ? { refus: rejections.map(x => ({ ...x, manques: shorts(x.manques) })) } : {}), ...(flaky.length ? { instables: shorts(flaky) } : {}), ...(unverifiable.length ? { non_verifiables: shorts(unverifiable) } : {}),
    // Reviews on one line but whole: progress matches them with their HANDOFF.md entry, word for word
    ...(final !== 'fusionnée' ? { blocage: shorts(gaps) } : {}), ...(allReviews.length ? { relectures: allReviews.map(oneLine) } : {}),
    ...(updates.decisions.length ? { decisions_office: updates.decisions.map(d => ({ ...d, description: short(d.description) })) } : {}), ...(updates.points.length ? { points: updates.points.map(withoutActions) } : {}),
    ...(updates.taches.length ? { taches_ajoutees: updates.taches.map(x => ({ id: x.id, titre: short(x.titre), phase: x.phase })) } : {}),
    ...(updates.amendements.length ? { amendements: updates.amendements.map(m => ({ id: m.id, raison: short(m.raison) })) } : {}),
    ...(replan ? { replanification: true } : {}),
  } : null
  const s = await exclusive(() => agent(pScribe(t, final, attempts, r, updates, gaps, { instables: flaky, refus: rejections, nonVerif: unverifiable }, closeInput), { label: `${t.id} · suivi`, agentType: AG('scribe'), model: 'sonnet', schema: requireFields(SCRIBE_S, 'suivi_ok') }))
  for (const am of updates.amendements) { const n = (amended.get(am.id) || 1) - 1; if (n > 0) amended.set(am.id, n); else amended.delete(am.id) }
  if (s) discardedRun.push(...(s.ecartes || []).map(e => ({ tache: t.id, ...e })))
  if (!s || !s.ok) stopOn(humanIssue(t.id, `Suivi de ${t.id} non commité`, s ? 'Le scribe n’a pas pu commiter.' : 'Scribe sans réponse.'))
  else if ((s.refuses || []).length) stopOn(humanIssue(t.id, `Suivi de ${t.id} : tâches, amendements ou décisions refusés`, JSON.stringify(s.refuses)))
  // Close not written in suivi.json: stop, as for a failed scribe; the clerk closes the task from the summary at the end of the run
  else if (PROGRESS && s.suivi_ok !== true) stopOn(humanIssue(t.id, `Suivi de ${t.id} : clôture non écrite dans suivi.json`, `${s.suivi_erreur || 'résultat non rapporté'}. HANDOFF.md et DISCOVERY.md sont commités ; la fin de run clôt ${t.id} dans suivi.json d'après le bilan et régénère SUIVI.md.`))
  noteProgress(t.id, 'cloture', s && s.ok ? s : null)
  log(`${t.id} : ${final}`)
  return { id: t.id, statut: final, essais: attempts, branche: r ? r.branche : null, resume: r ? r.resume : '', ...(final !== 'fusionnée' ? { blocage: gaps } : {}), ...(flaky.length ? { instables: flaky } : {}), ...(rejections.length ? { refus: rejections } : {}), ...(unverifiable.length ? { non_verifiables: unverifiable } : {}), ...(allReviews.length ? { relectures: allReviews } : {}) }
}

// Model of the fix that follows the rejected attempt (0.11.0). Task without a model: the escalade ladder, as before, without a call.
// Task with a model: the replanner chooses from the rejection; never below the task's model (floor); without a valid
// answer, the ladder. Returns { model, reason, change? }: change { from, to, reason } when the model differs from the attempt's.
async function chooseModel(t, rejection, models, previous) {
  const before = models[models.length - 1], ladder = atLeast(ESC[Math.min(rejection.essai - 1, ESC.length - 1)], t.modele)
  let model = ladder, reason = `pas de modèle dans le plan : échelle d'escalade, correction ${rejection.essai}`
  if (t.modele) {
    const c = await agent(pChoice(t, rejection, before, previous.map((x, i) => ({ essai: x.essai, modele: models[i], par: x.par, manques: shorts(x.manques) }))), { label: `${t.id} · choix du modèle ${rejection.essai}`, agentType: AG('replanificateur'), model: 'opus', schema: CHOICE_S })
    if (c && CHOICE_MODELS.includes(c.modele)) {
      model = atLeast(c.modele, t.modele)
      reason = short(c.raison || 'sans raison', 200) + (model !== c.modele ? ` ; relevé au modèle de la tâche (${t.modele})` : '')
    } else {
      reason = `${c ? `choix invalide (${short(String(c.modele), 30)})` : 'choix du modèle sans réponse'} : échelle d'escalade, correction ${rejection.essai}`
      log(`${t.id} : ${reason}`)
    }
  }
  return { modele: model, raison: reason, ...(model !== before ? { changement: { de: before, vers: model, raison: reason } } : {}) }
}

async function runTask(t, isolated) {
  try {
    log(`${t.id} démarre (${isolated ? 'worktree' : 'checkout principal'})`)
    // The task's model, as is; without a model in the plan, sonnet (0.10 and earlier)
    const workerModel = t.modele || 'sonnet'
    let r = await agent(pWorker(t, isolated, workerModel), { label: `${t.id} · worker`, agentType: AG(isolated ? 'worker-isole' : 'worker'), model: workerModel, schema: REPORT_S, ...(isolated ? { isolation: 'worktree' } : {}), ...effort(t) })
    noteProgress(t.id, 'worker', r)
    // Model of each attempt, in order: the worker, then each fix
    const models = [workerModel]
    let attempts = 1
    const trace = { instables: [], refus: [], nonVerif: [], illisibles: [], interdites: [], points: [] }
    for (;;) {
      if (!r) return await closeTask(t, 'échec', attempts, null, ['worker sans réponse (limite d’usage ou erreur API)'], trace)
      if (r.statut === 'blocked') return await closeTask(t, 'bloquée', attempts, r, [r.blocage || 'bloquée par le worker'], trace)
      let gaps = [], by = 'vérification'
      const v = await agent(pVerif(t, r), { label: `${t.id} · vérification`, agentType: AG('verificateur'), model: 'sonnet', schema: VERIF_S })
      noteProgress(t.id, 'vérification', v)
      if (v && (v.instables || []).length) trace.instables.push(...v.instables)
      // Commands refused by permissions: only the task's count as forbidden; another one is a failure
      // Progress command cited among the refused ones (authorization rule missing): neither a task command nor a failure
      const refused = ((v && v.interdites) || []).filter(x => !(PROGRESS && String(x).includes('suivi.mjs')))
      const unknown = refused.filter(x => !(t.verification || []).some(c => sameCommand(c, x, r.chemin)))
      trace.interdites = [...new Set([...trace.interdites, ...(t.verification || []).filter(c => refused.some(x => sameCommand(c, x, r.chemin)))])]
      if (!v) gaps = ['vérificateur sans réponse']
      else if (!v.ok || unknown.length) gaps = [...(v.echecs || []).map(e => `${e.commande} : ${e.extrait || 'échec'}`), ...unknown.map(x => `${x} : refusée selon le vérificateur, mais ce n'est pas une commande de vérification de la tâche`)]
      // No command allowed: nothing proves the task, and a fix would change nothing
      else if ((t.verification || []).length && (t.verification || []).every(c => trace.interdites.includes(c))) return await closeTask(t, 'bloquée', attempts, r, [`aucune commande de vérification permise aux agents : ${trace.interdites.join(' ; ')}`], trace)
      else {
        by = 'évaluation'
        const e = await agent(pEval(t, r, { ...v, interdites: trace.interdites }), { label: `${t.id} · évaluation`, agentType: AG('evaluateur'), model: 'opus', schema: EVAL_S })
        noteProgress(t.id, 'évaluation', e)
        // A file unreadable once stays so: accumulated from one evaluation to the next
        if (e) { trace.nonVerif = e.non_verifiables || []; trace.illisibles = [...new Set([...trace.illisibles, ...(e.illisibles || [])])] }
        if (!e) gaps = ['évaluateur sans réponse']
        else if (e.verdict === 'ko') gaps = e.manques && e.manques.length ? e.manques : ['verdict ko sans détail']
      }
      if (!gaps.length) break
      if (attempts > MAXFIX) return await closeTask(t, 'bloquée', attempts, r, gaps, trace)
      const attemptRejection = { essai: attempts, par: by, manques: gaps }
      trace.refus.push(attemptRejection)
      const choice = await chooseModel(t, attemptRejection, models, trace.refus.slice(0, -1))
      // Every choice to the log, model change or not: a choice raised to the floor, equal to the previous attempt, has no other trace
      log(`${t.id} : correction ${attempts} sur ${choice.modele}${choice.changement ? ` (au lieu de ${choice.changement.de})` : ''} : ${choice.raison}`)
      const c = await agent(pFix(t, r, gaps, attemptRejection, choice), { label: `${t.id} · correction ${attempts}`, agentType: AG('worker'), model: choice.modele, schema: REPORT_S, ...effort(t) })
      noteProgress(t.id, 'correction', c)
      models.push(choice.modele)
      attempts++
      // Fix without an answer: we keep the report of the earlier attempts (deviations, reviews, branch)
      if (!c) return await closeTask(t, 'échec', attempts, r, ['correction sans réponse (limite d’usage ou erreur API)'], trace)
      r = accumulate(r, c)
    }
    // Post-merge check: the first verification command the agents are allowed to run
    const check = (t.verification || []).find(c => !trace.interdites.includes(c)) || 'aucune'
    const i = await exclusive(() => agent(pMerge(t, r, isolated, check), { label: `${t.id} · fusion`, agentType: AG('integrateur'), model: 'sonnet', schema: INTEG_S }))
    noteProgress(t.id, 'fusion', i)
    if (!i) return await closeTask(t, 'bloquée', attempts, r, ['intégrateur sans réponse'], trace)
    if (!(i.fusionne ?? i.ok)) return await closeTask(t, 'bloquée', attempts, r, [`fusion : ${i.detail || 'échec'}`], trace)
    if (!(i.controle_ok ?? i.ok)) {
      // Merge done but check failed: the task stays merged and the run stops for a human
      const detail = `${setupOf(t).length ? 'préparation ou ' : ''}contrôle post-fusion en échec sur ${INTEG} (${check}) : ${i.detail || 'échec'}`
      trace.entrees = [{ type: 'besoin-humain', gravite: 'majeur', description: detail }]
      stopOn({ tache: t.id, titre: `Contrôle post-fusion en échec après ${t.id}`, contexte: detail, humain: true, options: [{ id: 'reparer', description: `Réparer sur ${INTEG}, rejouer les vérifications, puis relancer la phase`, impact: '', recommande: true }, { id: 'arreter', description: 'Arrêter le plan ici', impact: '', recommande: false }] }, trace.points)
    }
    return await closeTask(t, 'fusionnée', attempts, r, [], trace)
  } catch (err) {
    return { id: t.id, statut: 'échec', essais: 0, branche: null, resume: String(err), blocage: [`erreur du workflow : ${String(err)}`] }
  }
}

// Scheduling: dependencies, resources, parallelism
phase('Tâches')
// A task with an open prerequisite in PREREQUIS.md waits, even when rerun: the prerequisite is settled in the plan first
const waitingOnPrerequisites = plan.taches.filter(t => !DONE(t.statut) && (t.prerequis_ouverts || []).length).map(t => ({ id: t.id, prerequis: t.prerequis_ouverts }))
const waitsOnPrerequisite = id => waitingOnPrerequisites.some(a => a.id === id)
// A "besoin-humain" task only restarts if the user reruns it (args.relancer)
const waiting = plan.taches.filter(t => t.statut === 'besoin-humain' && !RERUN.has(t.id) && !waitsOnPrerequisite(t.id)).map(t => t.id)
const pending = new Map(plan.taches.filter(t => !DONE(t.statut) && !waiting.includes(t.id) && !waitsOnPrerequisite(t.id)).map(t => [t.id, t]))
const running = new Map()
const locks = new Set()
const ready = t => deps(t).every(d => done.has(d)) && !amended.has(t.id) && !(t.ressources || []).some(r => locks.has(r)) && !locks.has('checkout')
while (pending.size || running.size) {
  if (!stop) {
    for (const t of [...pending.values()]) {
      if (running.size >= PAR) break
      if (!ready(t)) continue
      const others = [...pending.values(), ...[...running.keys()].map(id => T.get(id))].filter(o => o.id !== t.id)
      // Worktree only if another task can run at the same time: never with a parallelism of 1
      const isolated = PAR > 1 && (running.size > 0 || others.some(o => canOverlap(o, t)))
      const taken = [...(t.ressources || []), ...(isolated ? [] : ['checkout'])]
      taken.forEach(x => locks.add(x))
      pending.delete(t.id)
      running.set(t.id, runTask(t, isolated).then(res => {
        results.push(res)
        if (res.statut === 'fusionnée') done.add(t.id)
        taken.forEach(x => locks.delete(x))
        running.delete(t.id)
      }))
    }
  }
  if (!running.size) break
  await Promise.race(running.values())
}

phase('Clôture')
const failed = results.filter(r => r.statut !== 'fusionnée')
const summary = {
  phase: PHASE, mode: MODE, taches: results, non_lancees: [...pending.keys()], reportees: deferred,
  taches_ajoutees: added.map(x => ({ id: x.id, phase: x.phase, titre: x.titre })),
  relectures: results.flatMap(x => (x.relectures || []).map(d => ({ tache: x.id, relecture: d }))),
  decisions_office: autoDecisions, amendements_ecartes: discardedRun, points_a_trancher: issues, arbitrages_appliques: rulingsApplied, en_attente: waiting, en_attente_prerequis: waitingOnPrerequisites,
}
if (stop) return await finish({ statut: 'arbitrage', arbitrage: stop, ...summary })
if (failed.length || pending.size || waiting.length || waitingOnPrerequisites.length) return await finish({ statut: 'partiel', ...summary })
// Initial tasks all merged, but tasks added to this phase or deferred: rerun the phase
return await finish({ statut: deferred.length || added.some(x => x.phase === PHASE) ? 'à-relancer' : 'terminé', ...summary })
