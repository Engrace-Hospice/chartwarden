# Matrice de migration UI — après les écrans pilotes

Les trois pilotes sont la référence de composition : Census (Work Queue), QAPI (risque/compliance)
et Admission (Stepper Workflow). Les vagues suivantes sont ordonnées par réutilisation du pattern,
fréquence opérationnelle et risque clinique/réglementaire.

## Vague 1 — Work Queue

Appliquer `PageHeader` → `KpiStrip` optionnel → `FilterBar` → `DataTable` →
`CursorPagination` → `RightDetailPanel`.

- Admin/plateforme : Audit Log, Feature Flags, Staff Management, Master Data, Terminology,
  Integration Monitoring, FHIR/API, AI Governance Console, Clinical Content Admin, Referral Source CRM.
- Clinique/opérations : Document Management, On-Call Triage, EVV, Volunteer Management, Medication
  Refill Inbox, Field Safety Incidents, On-call Roster/Protocols, EPCS, Bereavement, Patient Rights.
- Revenu : Denials, Eligibility, ERA Posting, Claims/Billing, NOE/NOTR, Prior Authorization,
  Medicaid Validation Override, Patient Statements.
- Noyau : Notifications & Tasks, Global Search Results, Help & Training.

**Contrôles spécifiques :** prioriser les colonnes mobile, ne pas exposer de PHI supplémentaire dans
le détail, utiliser un mapping de statut fermé et conserver la pagination réellement servie par l’API.

## Vague 2 — Dashboards et scorecards

Appliquer `DashboardLayout`, `MetricCard`, tendances provenant de données réelles et une table
contributrice. Toute métrique doit donner sa date/source et son dénominateur quand il est pertinent.

- HQRP Quality, Quality Measures Chart Audit, Cap Management, Field Safety, Reporting & Analytics,
  Agency Command Center, Role Dashboards, Consent Expiration/Renewal.

**Contrôles spécifiques :** aucune tendance fictive, seuils accessibles hors couleur, expliciter les
mesures supprimées/indisponibles et protéger les exports.

## Vague 3 — Stepper et review workspaces

Appliquer `StepperWorkflowLayout`, `WorkflowStepper`, `FormSection`, champs partagés et
`StickyFooterActions`.

- Referral detail/intake, Certification/Recertification, Election & Certification, Cost Report,
  Cap Settlement, Onboarding Wizard, Consent Record Manager, Death/Pronouncement,
  Discharge/Revocation/Transfer.

**Contrôles spécifiques :** validation étape par étape, gardes et signatures métier conservées,
brouillon seulement avec persistance durable/auditée, changement d’étape sans perte silencieuse.

## Vague 4 — Patterns spécialisés

- Work Queue + Review Workspace : Document Management, Clinical Note Lifecycle, DocLens Extraction.
- Work Queue + Documentation Workspace : On-Call Triage, IDG Meeting.
- Patient/Family Detail : Eligibility, Bereavement.
- Mobile Task Flow : Field Safety et Mobile Field Suite.
- Portails : conserver les contraintes Portal Dashboard avant toute adaptation des composants internes.

## Definition of Done par vague

1. Les composants partagés sont employés sans clone local équivalent.
2. Les états loading/error/empty/permission/filter sont couverts.
3. Les dimensions 1440/768/390 et les deux thèmes sont validés.
4. Les contrôles de confidentialité, signatures, ABAC, RLS et audit restent identiques.
5. Les tests/gates concernés passent et la documentation de parité/fidélité est mise à jour si le
   screen registry ou les mappings de frames changent.

## Revue humaine avant généralisation

La conformité visuelle et technique ne remplace pas la validation métier. Avant de lancer une vague :

- un référent clinique valide les libellés, priorités et alertes;
- un référent compliance valide les échéances, sévérités et panneaux sensibles;
- un référent accessibilité teste clavier et lecteur d’écran;
- le propriétaire de module confirme les limites réelles des données et des actions.
