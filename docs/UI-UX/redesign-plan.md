# Plan de refonte UI/UX — socle réutilisable et trois écrans de référence

## 1. Objectif et périmètre

Cette refonte doit produire un système d’interface cohérent avant de modifier le reste des
écrans. Les maquettes de référence définissent l’intention visuelle : application clinique
professionnelle, bleu profond comme couleur d’action, surfaces claires et aérées, cartes à
hiérarchie nette, indicateurs sémantiques, tableaux denses mais lisibles, et un thème sombre
conçu intentionnellement.

La première livraison ne cherchera donc pas à refaire toutes les pages. Elle livrera :

1. un kit de composants et de règles documentées dans `@wardenx/ui` ;
2. trois écrans pilotes représentatifs ;
3. une recette visuelle, responsive, accessible et respectueuse de la confidentialité qui
   pourra être appliquée écran par écran sans recréer des composants locaux.

Le périmètre est uniquement la présentation et l’expérience d’utilisation. Les contrats API,
autorisations serveur, RLS, règles métiers, masquage PHI et événements d’audit restent
inchangés. Aucun faux indicateur ne sera introduit : une donnée indisponible affiche `—`, un
état de chargement ou une explication, jamais une valeur décorative.

## 2. État de départ et principes à conserver

Le dépôt dispose déjà d’une base « Lantern » : tokens light/dark dans
`apps/web/src/index.css`, références de tokens dans `packages/ui/src/web/theme/tokens.ts`,
composants de régions/layout dans `packages/ui/src/web`, et une taxonomie de layouts dans
`docs/design/WARDENX_UI_LAYOUT_PATTERNS.md`. La refonte devra consolider cette base, pas créer
un second design system concurrent.

Les règles ci-dessous reprennent les références visuelles tout en respectant les exigences
WardenX :

- Bleu indigo comme action primaire et lien actif ; jamais comme seul moyen de communiquer un
  état. Les teintes vert/ambre/rouge/bleu restent réservées aux significations métier.
- Fond très clair en light, surfaces blanches, élévation douce, rayons généreux et séparateurs
  discrets ; en dark, surfaces « twilight » distinctes, pas une simple inversion.
- Titres et libellés éditoriaux dans la police display existante ; données, formulaires et
  chiffres dans la police UI avec chiffres tabulaires ; identifiants dans la police mono.
- Cartes de synthèse cliquables uniquement lorsqu’elles appliquent réellement un filtre. Elles
  doivent avoir une étiquette, une valeur, une éventuelle tendance/échéance, et un état
  sélectionné accessible.
- Statuts, sévérités et échéances ont une icône ou un libellé explicite, un contraste WCAG AA,
  et un mapping centralisé. Rouge = critique/échu ; ambre = attention/proche de l’échéance ;
  vert = conforme/terminé ; bleu = actif/en cours ; neutre = information/non calculé.
- Les actions destructives restent secondaires et demandent confirmation ; les actions
  irréversibles ou réglementées conservent les Guard Chips, validation et step-up existants.
- PHI minimisée dans les listes et panneaux ; révélation, export et action sensible restent
  conditionnés par les permissions et l’audit déjà en place.

## 3. Les trois écrans pilotes

| Écran pilote | Route / pattern | Pourquoi il est retenu | Règles et composants validés |
| --- | --- | --- | --- |
| Patient List / Census (M05) | `/patients` — Work Queue | C’est le cas le plus réutilisable de liste opérationnelle : recherche, filtres, KPI, table, sélection de ligne, contexte patient et pagination curseur. | App shell, titre/actions, KPI filtrants, barre de filtres, table responsive, badges de statut/consentement, pagination, état vide/erreur, panneau de détail/drawer. |
| QAPI & Incidents (M30) | `/quality/qapi` — Dashboard + Work Queue | C’est le meilleur écran de pilotage à risque : métriques colorées, tendances, seuils, registres, détail d’incident et actions sous contraintes. Il traduit directement la plupart des maquettes Clinical Compliance. | Scorecards à tonalité métier, mini-tendances/progress, filtres à facettes, table avec sévérité et SLA, panneau d’enquête/timeline, drawer, skeletons et états de risque. |
| Admission / Referral Intake (M06) | `/admissions/new` et dossier de referral — Stepper Workflow + Review Workspace | C’est le cas de formulaire long, guidé et réglementé : sections, validation, documents, contexte, sauvegarde brouillon et action finale bloquée. | Stepper, formulaire et champs, choix par cartes (dont sévérité), sections repliables, validation inline/récapitulatif, aide contextuelle, panneau documents/risques, barre d’actions sticky et modales de confirmation. |

Le premier écran couvre « trouver et agir dans une liste », le deuxième « comprendre et
prioriser le risque », le troisième « compléter un processus ». Ensemble, ils sont plus
représentatifs que trois écrans de listes similaires et donneront des exemples fiables aux
40 modules.

## 4. Socle de composants à réaliser avant les pages

### 4.1 Fondations et shell

- Formaliser les tokens de couleur, espacement, typographie, rayons, ombres, focus et z-index
  existants ; ajouter seulement les tokens manquants (état sélectionné, hover, overlay, danger
  faible, surfaces de tableau), sans hexadécimal dans les écrans.
- Finaliser ThemeProvider/contrôle light-dark : préférence système au premier accès, choix
  utilisateur persistant hors stockage PHI, attribut accessible, absence de flash au chargement.
- Unifier le shell : barre supérieure, navigation latérale repliable, recherche globale,
  zone d’actions/utilisateur et comportement mobile. La navigation active doit être perceptible
  par couleur, forme et `aria-current`.
- Définir les breakpoints de contenu : desktop (rails visibles), tablette (panneau de détail en
  drawer), mobile (nav drawer, filtres essentiels visibles, tableaux en lignes expansibles).

### 4.2 Primitives d’interaction

- `Button` : primary, secondary, tertiary/ghost, destructive et icon-only ; tailles, loading,
  disabled, raccourci éventuel, focus visible et libellé accessible.
- `IconButton`, `LinkButton`, `SplitButton` si une action + menu est justifiée ; pas de bouton
  sans libellé accessible.
- `TextField`, recherche avec debounce/effacement, select/combobox, multi-select, date-range,
  time, textarea, checkbox/switch, radio group et file upload ; label, aide, requis, erreur et
  validation sont standardisés.
- `StatusPill`, `SeverityBadge`, `DeadlineChip`, `ProgressBar`, `Avatar/Initials`, `EmptyState`,
  `LoadingSkeleton`, `ErrorState`, toast et confirmation. Les mappings métier restent typés et
  centralisés, sans `string` libre.

### 4.3 Données, tableaux et filtres

- `DataTable` typé : entêtes, tri, alignement numérique, colonnes prioritaires, rendu vide/
  loading/erreur, sélection de ligne clavier/souris, action contextuelle et cellules sensibles.
- `Pagination` commune qui prend en charge le curseur actuel du backend : précédent/suivant,
  nombre chargé, taille de page si l’API le permet, état loading et conservation des filtres.
  Elle ne simulera pas une pagination par numéro si l’API n’expose que des curseurs.
- `FilterBar` : recherche, filtres rapides en chips, filtres avancés dans popover/drawer,
  compteur de filtres, clear-all, vues sauvegardées ultérieurement et synchronisation URL quand
  le filtre est partageable/non sensible.
- `MetricCard`/`KpiStrip` : tonalité (`neutral`, `info`, `success`, `warning`, `danger`),
  comparaison ou tendance optionnelle, état sélectionné et version compacte responsive.
- `DetailPanel` : en desktop à droite de la table ; en tablette/mobile drawer focus-trappé avec
  retour du focus à la ligne d’origine ; fermeture Escape, bouton explicite et URL/état de
  sélection cohérent.

### 4.4 Composition de formulaires et analyse

- `FormSection`/`FormCard`, grille responsive, légende, aide et résumé d’erreur ; sections
  conditionnelles et repliables sans perdre les données saisies.
- `ChoiceCardGroup` pour les choix à forte signification (p. ex. sévérité), avec radio natif,
  état sélectionné et description ; aucune couleur seule pour indiquer la sélection.
- `Stepper` : état non commencé/en cours/terminé/bloqué, navigation autorisée, progression,
  validation par étape et équivalent compact mobile.
- `StickyActionBar` : brouillon, retour/suivant, soumission/complétion ; annonce des erreurs,
  sauvegarde en cours et garde-fous existants.
- `TrendCard`/`Scorecard` et `Timeline` pour QAPI : valeur, dénominateur lorsque pertinent,
  tendance textuelle, seuil, source/date de mise à jour ; graphiques lisibles sans perception
  des couleurs seules.

## 5. Plan d’exécution

### Phase 0 — cadrage et inventaire (courte) — terminée le 2026-08-19

1. Capturer l’état actuel des trois routes aux formats desktop, tablette, mobile et light/dark.
2. Établir une matrice « référence → règle → composant → écran pilote » à partir des maquettes,
   des spécifications d’écrans et de `WARDENX_UI_LAYOUT_PATTERNS.md`.
3. Lister les composants locaux/doublons des trois écrans et les écarts API (notamment les
   curseurs, tris et données réellement disponibles). Décider explicitement les éléments
   visualisés par `—` jusqu’à ce qu’une source autoritative existe.
4. Valider les seuils de contraste, les états de sécurité/PHI, et les priorités de colonnes
   mobiles avec les parties prenantes clinique/compliance.

**Sortie :** inventaire versionné dans `docs/UI-UX/phase-0-ui-inventory.md`, critères
d’acceptation de chaque composant et aucune modification fonctionnelle appliquée aux pilotes.

### Phase 1 — design tokens et primitives — terminée le 2026-08-19

1. Compléter/normaliser les tokens et le switch de thème dans le système actuel.
2. Construire les primitives de boutons, champs, badges, feedback, carte et overlay dans
   `packages/ui/src/web`, avec API TypeScript, stories/pages de démonstration et tests unitaires.
3. Migrer les styles globaux qui doivent rester communs ; supprimer progressivement les styles
   inline locaux seulement après remplacement par une primitive.
4. Vérifier clavier, focus, lecteurs d’écran, contraste light/dark et réduction des animations.

**Sortie :** un kit publiable via `@wardenx/ui`, sans API métier ni couleur codée en dur dans
les nouveaux composants. Livré : `Button`/`IconButton`, `Card`, `TextField`, `SelectField` et
`TextAreaField`, plus un token de focus adapté aux deux thèmes et une règle de mouvement réduit.
Les composants existants `StatusPill`, `EmptyState`, `LoadingSpinner`, `Modal` et
`ConfirmDialog` restent les primitives officielles de leur domaine.

### Phase 2 — composants de données et layouts — terminée le 2026-08-19

1. Mettre en place `DataTable`, `Pagination`, `FilterBar`, `MetricCard`, `DetailPanel` et les
   comportements responsive/drawer.
2. Formaliser les variantes Work Queue et Dashboard au-dessus des layouts déjà existants, afin
   d’éviter qu’un écran recode ses paddings, colonnes ou panneaux.
3. Ajouter les fixtures pour : 0 résultat, chargement, erreur, table dense, statut critique,
   droits insuffisants et contenu long.

**Sortie :** la file de travail et le dashboard peuvent être construits sans table, filtre,
badge ou panneau fait localement. Livré : `DataTable` typé à colonnes prioritaires responsive,
`CursorPagination` honnête vis-à-vis des API à curseur, `MetricCard`, `FilterBar` avec compteur
et reset, KPI enrichis, et panneau de détail qui devient un drawer mobile avec fermeture Escape
et restauration du focus.

### Phase 3 — écran pilote 1 : Patient List / Census — terminée le 2026-08-19

1. Remplacer les KPI locaux par `MetricCard` et connecter leurs clics aux filtres réels lorsque
   la métrique est actionnable.
2. Mettre en forme recherche/filtres, table de census et pagination curseur ; conserver le
   masquage MBI/consentement et les limitations de caseload du serveur.
3. Refaire le résumé patient sous forme de panneau/drawer partagé, sans révélation additionnelle
   de PHI, et tester sélection, fermeture et retour du focus.
4. Produire les vues : liste par défaut, filtre vide, chargement, erreur, panneau ouvert et
   mobile.

**Critère :** cet écran devient le modèle officiel de toute liste clinique ou opérationnelle.
Livré : KPI sémantiques partageables (dont le filtre Active Census), barre de filtres avec compteur
et reset, `DataTable` à sélection clavier, `CursorPagination` connecté au curseur réel, et action
du panneau de détail via `Button`. Caseload, consentement, masquage MBI et appels API sont inchangés.

### Phase 4 — écran pilote 2 : QAPI & Incidents — terminée le 2026-08-19

1. Composer les KPI de risque, scorecards/tendances et filtres à facettes à partir du kit.
2. Faire évoluer le registre vers la table partagée avec tonalités typées, priorité des colonnes
   et pagination conforme à l’API.
3. Ajouter le panneau d’enquête sélectionnée : résumé sans PHI inutile, sévérité/SLA, timeline,
   étapes RCA et actions autorisées ; les données non exposées par l’API ne sont pas inventées.
4. Ajouter les états « aucun incident », délai proche/échu, incident critique et erreur de
   chargement, en gardant le flux de révélation/audit existant.

**Critère :** cet écran devient le modèle de dashboard risque/compliance et des listes avec
statuts réglementés. Livré : KPI sémantiques, filtre de cycle de vie avec compteur/reset,
registre responsive et paginé par curseur, projets QAPI normalisés, et panneau d’enquête alimenté
par le point-read existant. Le panneau omet volontairement l’identifiant patient et le payload
clinique ; il montre statuts, chronologie, plan correctif et nombre de notes autorisés par l’API.

### Phase 5 — écran pilote 3 : Admission / Referral Intake — terminée le 2026-08-19

1. Découper la création/révision en `Stepper`, sections de formulaire et panneau de contexte
   documents/éligibilité/risques.
2. Standardiser champs, choix de sévérité, validation progressive, erreurs de soumission et
   sauvegarde brouillon ; aucune navigation d’étape ne contourne une garde métier.
3. Installer la barre sticky pour brouillon, précédent/suivant et finalisation, puis les
   confirmations/Guard Chips nécessaires à la conversion ou au rejet.
4. Tester les scénarios nouveau referral, informations manquantes, document extrait, prêt à
   admettre et mobile.

**Critère :** cet écran devient le modèle de formulaire long et workflow réglementé.
Livré sur le flux direct `/admissions/new` : `WorkflowStepper` réutilisable, sections de formulaire
normalisées, validation progressive, récapitulatif avant création, contexte latéral responsive et
barre d’actions sticky. Les valeurs restent uniquement en mémoire jusqu’à l’envoi : aucun brouillon
n’est simulé sans endpoint durable et audité. La création, les validations serveur et les redirections
d’autorisation existantes sont inchangées.

### Phase 6 — stabilisation et généralisation — stabilisation technique terminée le 2026-08-19

1. Faire une revue croisée UX, clinique, conformité et accessibilité des trois pilotes.
2. Documenter dans le catalogue UI : quand employer chaque composant/layout, exemples de code,
   variantes interdites, mapping des statuts et checklist de migration.
3. Ajouter une matrice de migration des écrans restants, groupée par pattern : Work Queue,
   Dashboard, Stepper, puis patterns spécialisés. Prioriser les écrans à forte fréquence et à
   risque clinique/compliance.
4. Migrer ensuite par vagues, une famille de pattern à la fois, sans modification simultanée de
   contrat métier sauf tâche explicitement séparée.

**Livré :** catalogue de composants dans `docs/UI-UX/component-catalog.md`, matrice de migration
par vague dans `docs/UI-UX/migration-matrix.md`, et checklist de recette commune. La revue clinique,
compliance, accessibilité assistive et validation visuelle humaine restent des sign-offs requis
avant de démarrer chaque vague de généralisation ; elles ne sont pas remplacées par les contrôles
automatisés.

## 6. Qualité et critères de sortie

Chaque primitive et chacun des trois pilotes doit satisfaire :

- WCAG 2.2 AA : contraste, navigation clavier complète, focus visible, labels/erreurs annoncés,
  cible tactile adéquate, ordre de lecture logique et respect de `prefers-reduced-motion`.
- Light et dark validés visuellement ; aucune couleur brute hors token et aucun état transmis
  par la couleur seule.
- Desktop 1440 px, tablette 768 px et mobile 390 px validés ; les tables dégradent par priorité
  de colonnes et expansion de ligne, jamais par débordement silencieux.
- États complets : loading skeleton, erreur récupérable, vide global, zéro après filtre,
  permission insuffisante, disabled et données indisponibles.
- Données et sécurité préservées : pas de PHI dans le stockage navigateur, pas de contournement
  des permissions, masquage et audit identiques ou renforcés, contrats OpenAPI inchangés sauf
  tâche backend explicitement approuvée.
- Tests TypeScript/unitaires pour les mappings et interactions, tests d’accessibilité, tests E2E
  des flux critiques, et captures de régression visuelle des deux thèmes.
- `bun run build`, `bun run test`, `bun run arch:fitness`, `bun run docs:ui`,
  `bun run ui:parity` et `bun run frame:fidelity` restent verts ; les registres/parités sont
  régénérés si la migration en modifie les attendus.

## 7. Décisions à prendre avant le démarrage de l’implémentation

1. Valider les trois écrans pilotes et l’ordre proposé : Census → QAPI → Admission.
2. Désigner les maquettes fournies comme direction visuelle (et non copie pixel à pixel) ; les
   documents d’architecture, les exigences de confidentialité et les données réellement
   disponibles restent prioritaires.
3. Choisir le niveau de fidélité du premier jalon : composants + trois pilotes desktop/light et
   dark, puis responsive complet dans le même jalon ou immédiatement après. La recommandation est
   de traiter responsive et dark comme critères de sortie de chaque composant, pas comme une
   passe finale.
