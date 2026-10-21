# Phase 0 — Inventaire de refonte UI/UX

Date : 2026-08-19  
Statut : terminé — base de travail des phases 1 à 3

## Écrans pilotes confirmés

| Écran | Route | Layout existant | Données / sécurité à préserver |
| --- | --- | --- | --- |
| Patient List / Census (M05) | `/patients` | `WorkQueueLayout` + panneau de résumé | Recherche et curseur côté API, caseload imposé par le serveur, MBI limité et badges de confidentialité conditionnés par consentement. |
| QAPI & Incidents (M30) | `/quality/qapi` | header + KPI + sections locales ; cible : Dashboard/Work Queue | Registre sans identité patient, états/sévérités typés depuis le client généré, permissions `incident.read` et données de qualité sensibles. |
| Admission / Referral Intake (M06) | `/admissions/new` et `/referrals/:id` | formulaire local ; cible : Stepper Workflow + Review Workspace | POST d’admission et validations serveur inchangés ; aucune persistance de brouillon contenant de la PHI dans le navigateur. |

## État du système existant

| Sujet | Réutilisable maintenant | Écart à traiter |
| --- | --- | --- |
| Tokens et thème | Tokens Lantern light/twilight-dark dans `apps/web/src/index.css`; pointeurs dans `packages/ui/src/web/theme/tokens.ts`; choix UI seul persisté sous `wx-theme`; bascule avant le premier rendu. | Ajouter les primitives afin que les écrans n’écrivent plus leurs propres styles d’interaction. Le thème et le responsive restent des critères de sortie de chaque primitive. |
| Shell et navigation | Shell responsive, navigation mobile en drawer, recherche globale, état actif et bouton de thème dans `apps/web/src/shell`. | Les écrans pilotes devront consommer les primitives avant toute retouche structurelle du shell. |
| Layouts | `WorkQueueLayout`, `DashboardLayout`, `StepperWorkflowLayout`, `PageHeader`, `FilterBar`, `RightDetailPanel`, `StickyFooterActions`. | Les panneaux et tables des pilotes devront migrer vers les composants données de la phase 2. |
| Feedback/sûreté | `StatusPill`, `EmptyState`, `LoadingSpinner`, `ErrorState`, `Modal`, `ConfirmDialog`, Guardrails et composants de sensibilité. | Compléter le kit avec une carte et des champs normalisés ; conserver les modales et garde-fous actuels. |
| Écrans pilotes | Les trois routes sont implémentées et enregistrées. | M05 contient un `KpiCard` local ; M06 réplique champs/boutons ; M30 réplique styles de table/filtre/cartes. Migration prévue après le socle, pas dans cette phase. |

## Matrice référence → règle → composant

| Référence visuelle | Règle WardenX | Primitive/layer cible | Premier consommateur |
| --- | --- | --- | --- |
| CTA bleu arrondi, secondaire tonal, destructif distinct | Libellé visible, focus AA, loading/disabled explicites, couleur jamais seule. | `Button` | M05, M06, M30 |
| Champs gris doux avec libellé et erreur | Label lié, aide/erreur annoncée, pas de PHI mémorisée par la primitive. | `TextField`, `SelectField`, `TextAreaField` | M06 |
| Cartes KPI et sections blanches | Surface tokenisée, aucun hex local, contenu sémantique et responsive. | `Card`, `KpiCard` existant | M05, M30 |
| Indicateurs verts/ambre/rouges/bleus | Mapping typé, icône + texte, contraste AA en light/dark. | `StatusPill` existant + mappings de module | M05, M30, M06 |
| Panneaux et confirmations | Focus piégé, Escape/retour du focus selon le caractère bloquant. | `Modal`, `ConfirmDialog` existants | M06, M30 |
| Tables, filtres, pagination et détail latéral | Curseurs réels, priorité mobile, aucun faux numéro de page. | Phase 2 : `DataTable`, `Pagination`, `DetailPanel` | M05 puis M30 |

## Contraintes d’acceptation transverses

- Cibles : 1440 px, 768 px et 390 px ; light et twilight-dark à chaque primitive.
- WCAG 2.2 AA : focus visible, ordre de tabulation, libellés, erreurs annoncées et mouvement réduit.
- Aucun changement de contrat OpenAPI, de règle ABAC/RLS, de masquage PHI ou d’événement d’audit.
- Les données absentes restent `—` ou prennent un état de chargement/erreur explicite.
- Les tests de cette phase portent sur le type-check, le rendu accessible des primitives et les
  vérifications de design tokens ; les captures visuelles des pilotes seront ajoutées avec les
  phases 3 à 5.

## Décisions prises

1. Les maquettes sont une direction visuelle, non une source de données ou de comportements métier.
2. Responsive et dark mode sont des critères de sortie pour chaque composant, pas une passe finale.
3. La phase 1 étend `@chartwarden/ui`; elle ne migre pas encore les trois écrans, afin que leur
   migration de phase 3 consomme un socle stable.
