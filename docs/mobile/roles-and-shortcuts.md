# Rôles, permissions et raccourcis

## Règle d’autorité

`GET /api/v1/auth/context` fournit `roles`, `permissions`, `organizationId`, `membershipId`,
`locationIds`, `orgWidePatientScope` et `isAdmin`. Le client construit la navigation depuis
`permissions`; les rôles ne sélectionnent qu’un preset de départ. Chaque écran revérifie sa permission
et le backend conserve RBAC, ABAC et RLS.

Un rôle technique n’implique pas automatiquement une permission. Les tenants peuvent renommer,
étendre ou restreindre les templates. Les exceptions démontrées sont les floors `system_locked` et les
grants explicites de `packages/auth/src/roles/templates.ts`, `intake-grants.ts` et
`admitting-clinician-grants.ts`.

## Rôles observés

Les clés cliniques canoniques sont définies dans `packages/auth/src/roles/display-names.ts` : `rn`,
`rn_case_manager`, `lpn`, `md`, `hospice_physician`, `medical_director`, `np`, `msw`, `chaplain`,
`volunteer`, `volunteer_coordinator`, `clinical_supervisor`, `compliance_officer`, `chha` et
`hipaa_privacy_officer`.

Sont également observés : `administrator`, `org_admin`, `director_of_nursing`,
`hipaa_security_officer`, `intake_coordinator`, `intake_supervisor`, `external_auditor` et les rôles
plateforme `platform_*`. Les fonctions scheduling et billing peuvent être portées par des rôles tenant
personnalisés ; aucune clé générique `scheduler` n’est prouvée dans le catalogue inspecté.

`medical_director` possède un floor réel comprenant `patient.read`, `cti.sign_hospice_md`,
`idg.attend`, `orders.cosign` et `breakglass.invoke`. `administrator` possède un floor
`org.manage`, `member.manage`, `role.read`, `report.dashboard.read`. Ces floors ne suffisent pas à
déduire les autres destinations proposées ci-dessous.

## Presets candidats

Chaque cellule « permission » est la condition d’affichage, pas une assertion d’attribution au rôle.

| Profil / rôles observés | Objectif du jour | Destination initiale candidate | Shortcuts candidats, si permission | Fallback |
|---|---|---|---|---|
| RN / RN Case Manager (`rn`, `rn_case_manager`) | Exécuter les visites, documenter et coordonner le caseload | My Visits — `visit.read` | My Visits; Patients — `patient.read`; Drafts — `encounter.author`; Messages — `messaging.read`; Modules | première destination autorisée, sinon Modules |
| LPN (`lpn`) | Visites assignées, tâches permises, documentation avec cosign si requis | My Visits — `visit.read` | My Visits; Patients; eMAR — `administration.read`; Drafts; Modules | même règle, aucune élévation vers RN |
| Physician (`md`) / Hospice Physician (`hospice_physician`) | Lire le contexte patient et traiter les signatures | Orders — `orders.read` | Orders; Cosignatures — `encounter.cosign`; Patients; Messages; Modules | Patients ou Modules selon permissions |
| Medical Director (`medical_director`) | Superviser, signer CTI/orders et participer à l’IDG | Orders — `orders.read` ou Patients — `patient.read` | Orders; Patients; IDG — `idg.attend`; Reports — `report.dashboard.read` si accordé; Modules | destination autorisée la plus sûre |
| Nurse Practitioner (`np`) | Gérer visites, évaluations, orders/prescribing autorisés | Tasks/Orders selon permissions | My Visits; Patients; Orders; Messages; Modules | Patients ou Modules |
| MSW (`msw`) | Caseload, visites et plan social | My Visits ou Patients | My Visits; Patients; Discipline Plans — permission M15; Messages; Modules | Patients/Modules |
| Chaplain (`chaplain`) | Caseload, visites et plan spirituel | My Visits ou Patients | My Visits; Patients; Discipline Plans; Messages; Modules | Patients/Modules |
| Intake (`intake_coordinator`, `intake_supervisor`) | Triage referral et admission | Referral Inbox — `referral.read` | Referrals; Admissions — `admission.read`; Eligibility — `billing.eligibility.read`; Documents/Intake — `intake.read`; Modules | Admissions ou Modules |
| Scheduling (rôle tenant à vérifier) | Planifier et résoudre les conflits | Calendar — route visible, puis `visit.read_team` pour vues équipe | Calendar; Day/Week — `visit.read_team`; Proposals — `visit.proposal.read`; Time Off — `time_off.read_team`; Modules | Calendar/My Visits/Modules |
| Billing/Finance (rôles tenant à vérifier) | Éligibilité, claims, remittance et work queues | Billing selon première permission | Billing; Remittance; CAP/Cost Reports; Reports; Modules | première destination revenue autorisée |
| Compliance (`compliance_officer`, privacy/security officers) | Examiner incidents, audit, privacy et holds | Audit — `audit.read` | Audit; QAPI — `incident.read`; Privacy — `privacy.admin`; Legal Holds — `legalhold.read/manage`; Modules | Modules |
| Administrator (`administrator`) | État opérationnel et gouvernance hospice | Home/Reports | Patients si accordé; Admissions si accordé; Staff — `member.manage`; Reports — `report.dashboard.read`; Modules | Staff/Reports/Modules |
| Organization Admin (`org_admin`) | Compte, membres, rôles et intégrations | Organization/Staff selon permission | Staff; Roles; Organization; Integrations; Modules | Modules |

La bottom bar ne crée pas artificiellement cinq entrées. Si seulement deux destinations métier sont
autorisées, elles sont complétées par `Modules` et aucune destination fictive.

## Matrice permission → destination

| Destination | Permission minimale de visibilité observée | Scope/contrôle serveur à conserver | Profils qui peuvent la préférer |
|---|---|---|---|
| My Visits | `visit.read` | caseload + assigned membership ; équipe entière avec `visit.read_team`/scope large | terrain |
| Patients | `patient.read` | patient/caseload/location/Part 2 selon routes | tous cliniciens autorisés |
| Encounter drafts | `encounter.author` | discipline, caseload et état encounter | RN/LPN/NP/MSW/chaplain autorisés |
| Orders inbox | `orders.read` | caseload/order scope ; signatures séparées | prescribers/cliniciens autorisés |
| Encounter cosign queue | `encounter.cosign` | éligibilité du cosignataire | physicians/supervision |
| Referral Inbox | `referral.read` | intake/admission scope | intake |
| Admissions | `admission.read` | admission scope et statut | intake/admin/cliniciens autorisés |
| Calendar | aucune clé déclarée sur l’écran racine ; appels internes à vérifier | routes M17 restent permissionnées | scheduling/terrain |
| Day/Week Scheduling | `visit.read_team` | org/location et scopes M17 | scheduling |
| Messaging | `messaging.read` | membership channel, Part 2 et rooms serveur | tous profils autorisés |
| Notifications | aucune clé d’écran déclarée | destinataire/session côté serveur | tous profils authentifiés |
| Staff | `member.manage` | organisation liée et anti-escalation | org admin/administrator |
| Roles | `role.read` | anti-escalation sur mutations | admin/compliance |
| Audit | `audit.read` | engagement/scope et audit des lectures | compliance/privacy/security |
| Reports | `report.dashboard.read` | dataset et scope de rôle | leadership/admin/billing |

## Objectifs et tâches de référence

| Profil | Fréquent | Urgent | Exemple complet |
|---|---|---|---|
| RN Case Manager | visites, encounter drafts, care plan | SOS, missed visit, symptôme critique | My Visits → visite → patient → EVV → encounter → finalisation |
| LPN | visite et administration permise | écart eMAR, besoin de cosign | My Visits → patient → eMAR/encounter → soumettre au cosign |
| Physician | signatures et revue clinique | order/CTI expirant | Orders → patient → preuve → step-up → sign → inbox |
| NP | visites, orders, assessments | symptôme/order urgent | task → patient → order/assessment → confirmation serveur |
| MSW | caseload et plan social | risque psychosocial | Patients → plan MSW → note → save |
| Chaplain | caseload et plan spirituel | demande urgente famille/patient | Patients → plan chaplain → documentation → save |
| Intake | referrals et admission | dossier bloqué/duplicate | Referral Inbox → review → admission workflow → liste |
| Scheduling | calendrier et assignation | no-show/réassignation | Calendar → visit → eligible staff → assign → refresh |
| Billing | queues et exceptions | claim/denial deadline | work queue → detail → action versionnée → queue |
| Admin | état opérationnel, membres, rapports | suspension/incidents | Home → domaine → modification autorisée → retour |

## Multi-rôles et changements de contexte

1. Calculer l’union des permissions effectives reçues du serveur, jamais l’union supposée des rôles.
2. Noter les presets candidats de chaque rôle, dédupliquer les destinations, puis conserver un ordre
   déterministe : urgence/quotidien, patient, communication, Modules.
3. Conserver tout le reste dans le catalogue. Un preset court ne retire aucun accès.
4. Si un rôle attendu n’a pas la permission, ne pas afficher son shortcut. Optionnellement expliquer
   dans un écran d’administration pourquoi le preset est incomplet ; ne pas contourner le serveur.
5. Refresh permissions au foreground, après réponse 403/401/423, après notification de session et à
   intervalle raisonnable. Toute permission retirée purge le cache concerné.
6. Le changement d’organisation exige aujourd’hui une nouvelle session :
   `/api/v1/auth/select-organization` refuse une session déjà liée (`ORG_ALREADY_BOUND`). Le mobile
   doit sign-out/re-auth ou attendre un futur contrat explicite ; il ne remplace jamais simplement
   `organizationId` côté client.
7. À l’organisation suivante, reconstruire tabs/catalogue, fermer les stacks, sockets et brouillons,
   puis purger les caches de l’organisation précédente.

