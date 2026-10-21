# Catalogue UI — refonte WardenX

Ce catalogue est la référence de migration pour les écrans Web. Les composants proviennent de
`@chartwarden/ui`; ils consomment uniquement les tokens Lantern et fonctionnent en light, twilight-dark,
desktop et mobile. Ne pas recréer une variante locale quand ce catalogue couvre le besoin.

## Règles non négociables

- Une valeur ou un statut n’est jamais exprimé par une couleur seule : employer un libellé et, pour
  les statuts, `StatusPill`.
- Une action de navigation est un lien ; une action sur la page est un `Button`.
- Une pagination curseur emploie `CursorPagination`; ne jamais afficher un total ou une page numérique
  que l’API ne fournit pas.
- Une table à ligne sélectionnable emploie `DataTable`; le composant assure clavier, sélection et
  masquage graduel de colonnes mobile.
- PHI, identifiants et données de formulaire ne vont pas dans `localStorage`/`sessionStorage`.
- Les écrans conservent l’autorisation serveur, le masquage, le step-up et l’audit existants.

## Actions et feedback

| Besoin | Composant | Notes |
| --- | --- | --- |
| Action primaire/secondaire/destructive | `Button` | `tone="primary"`, `secondary`, `tertiary` ou `danger`; utiliser `loading` pendant un appel. |
| Icône seule | `IconButton` | `aria-label` obligatoire. |
| Confirmation ou action irréversible | `ConfirmDialog`, `CeremonyModal`, `GuardChip` | Conserver les gardes métier ; l’UI ne les remplace pas. |
| Statut métier | `StatusPill` | Le module déclare un mapping enum typé → `StatusTone`. |
| Chargement/erreur/vide | `LoadingSpinner`, `ErrorState`, `EmptyState` | Toujours prévoir ces trois états. |

## Formulaires et workflows

| Besoin | Composant | Notes |
| --- | --- | --- |
| Champ texte | `TextField` | `label`, `hint`, `error`, `required`; l’erreur est annoncée. |
| Liste contrôlée | `SelectField` | Les options restent dérivées d’un vocabulaire fermé lorsque l’API en fournit un. |
| Texte long | `TextAreaField` | Ne pas utiliser pour un contenu nécessitant une signature/attestation dédiée. |
| Section de formulaire | `FormSection` | Titre, description et contenu ; la grille de champs est responsive dans l’écran. |
| Étapes | `WorkflowStepper` + `StepperWorkflowLayout` | L’écran garde la politique de validation et marque les étapes bloquées. |
| Actions persistantes | `StickyFooterActions` | Brouillon uniquement si un endpoint durable/audité existe. |

## Données et pilotage

| Besoin | Composant | Notes |
| --- | --- | --- |
| Surface | `Card` | Carte uniquement visuelle ; une carte actionnable est un bouton ou lien explicite. |
| KPI/score | `MetricCard` ou `KpiCard` | `tone` est sémantique; `onSelect` seulement si la carte applique réellement une vue/filtre. |
| Filtres | `FilterBar` | Utiliser `activeFilterCount` et `onClear`; ne pas masquer les filtres appliqués. |
| Tableau | `DataTable<Row>` | Déclarer `DataTableColumn<Row>[]`, `getRowId`, priorités `primary`/`secondary`/`tertiary`. |
| Pagination | `CursorPagination` | Affiche uniquement le nombre chargé et les directions réellement fournies par l’API. |
| Détail de ligne | `RightDetailPanel` | Rail desktop, drawer mobile, Échap et retour de focus. |

## Layouts

- `WorkQueueLayout` : header, KPI/filtres, table, détail latéral. Référence : Census et QAPI.
- `DashboardLayout` : compréhension d’un domaine, mesures/tendances, puis table contributrice.
- `StepperWorkflowLayout` : étapes, espace de saisie, contexte et footer sticky. Référence : Admission.
- `PageHeader`, `KpiStrip`, `FilterBar`, `LeftNavRail` sont les régions de composition ; ne pas
  recopier leurs espacements et séparateurs localement.

## Recette requise par écran migré

- Light et dark à 1440 px, 768 px, 390 px.
- Clavier : Tab, Enter/Espace sur une ligne/action, Échap sur un panneau/drawer.
- Chargement, erreur, zéro résultat, filtre actif, permission insuffisante et données manquantes.
- Vérifier que l’API, les droits, le masquage PHI et l’audit restent inchangés.
- Lancer formatage, type-check, tests pertinents et les gates d’architecture dans un environnement
  Bun avant fusion.
