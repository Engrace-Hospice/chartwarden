# Roadmap d’implémentation mobile

## Garde-fous transversaux

Chaque lot est une tranche verticale : UI native, contrat typé, permissions/ABAC, états d’erreur,
accessibilité, télémétrie sans PHI et preuve sur iOS/Android. Une route difficile reste dans le backlog ;
elle n’est pas supprimée de la cible de parité.

Avant chaque tranche, sélectionner les lignes du CSV par `mobile_destination`, suivre les appels indirects
jusqu’aux routes backend et remplacer `À vérifier` par un contrat démontré. Les adaptations n’importent
aucun composant DOM depuis `apps/web` ou `packages/ui/src/web`.

## Lot 0.5 / PR B — décision et contrat backend

**État au 2026-10-16 : implémenté, ratification d’ADR-0072 et preuves sur appareils en attente.**

### Entrée

- demande produit Expo/RN documentée par ce Lot 0 ;
- ADR-0035 conservé comme historique ; ADR-0072 proposé comme supersession.

### Travail documentaire

- rédiger un ADR qui compare le coût du second renderer RN aux bénéfices attendus et remplace
  explicitement ADR-0035 s’il est ratifié ;
- conserver `wardenx-mobile` comme consommateur API externe ; aucun codePath `apps/mobile` n’entre dans le manifest de ce repository ;
- réviser les sections mobile de l’architecture v0.11, System Design, Security Hardening, Integrations,
  DR/BCP et les specs UI Capacitor ;
- transposer les contrôles `FLAG_SECURE`, root/jailbreak, pinning, SQLCipher, biometric idle, MDM et
  offline ticket vers des mécanismes Expo/RN démontrables ;
- décider ce qui reste partageable hors DOM (`types`, contrats OpenAPI, tokens, capability interfaces).

### Sortie mesurable

- ADR-0072 nomme la stack, le propriétaire, les frontières et la stratégie ; son acceptation formelle reste à enregistrer ;
- aucun document autoritaire ne prescrit encore la stack opposée ;
- les gates documentaires et manifest sont prévus avant tout scaffold.

## Lot 1 — fondation native et authentification (après Lot 0.5)

### Entrée

- décision app identifiers, schemes/universal links, environnements API et politique device build ;
- ADR de supersession Expo ratifié et corpus d’architecture aligné ;
- validation de l’intégration Better Auth Expo dans l’adaptateur unique ;
- modèle de menace stockage/cache/logs accepté ;
- tokens Lantern figés depuis `apps/web/src/index.css` et `packages/ui/src/core/theme/colors.ts`.

### Travail

- initialiser Expo/TypeScript/Expo Router/NativeWind/Axios/Lucide ;
- créer root coordinator, états auth/system, client API, error envelope et correlation ID ;
- adapters Expo pour secure store, network et base capabilities ;
- login username, MFA, mot de passe temporaire, organisation, context refresh, logout/révocation ;
- shell compact/tablette, guards permission, catalogue `Modules`, deep-link anchors ;
- composants de base et accessibilité, sans écran métier factice.

### Sortie mesurable

- un utilisateur réel se connecte en dev build iOS et Android, franchit MFA/org et voit uniquement les
  destinations autorisées ;
- 401, 403, 409, 422, 423, 503 et panne réseau ont des états distincts ;
- aucun secret/PHI dans AsyncStorage, logs ou crash breadcrumbs ; purge démontrée au logout/org change ;
- deep link interdit ne révèle pas la ressource ; Back a une destination sûre ;
- passkey ou fallback TOTP démontré, pas supposé ; Socket.IO auth au minimum prototypée.

## Lot 2 — journée terrain en lecture

### Dépendances

- décider/ajouter le scope serveur `assigned_to_me`, ou renommer correctement la vue ;
- patient summary et visit detail contracts suivis et typés ;
- stratégie push device-token décidée.

### Travail

- preset RN/RNCM/LPN, My Visits/Visits, filtres aujourd’hui/upcoming ;
- Visit Detail et Patient Workspace résumé ;
- Patient search/census sans PHI en URL ni index local ;
- notification/deep link vers patient/visit avec permission recheck ;
- offline limité à shell/dernière liste clairement datée, sans mutation.

### Sortie mesurable

- la liste n’affiche aucune visite hors scope d’un compte test ;
- changement de permission/assignation au foreground retire l’accès et purge le cache ;
- parcours My Visits → Patient → Back revient à la date/position initiale ;
- VoiceOver/TalkBack et Dynamic Type passent les scénarios principaux.

## Lot 3 — EVV et encounter drafts

### Dépendances

- contrat EVV offline par événement/idempotence ; adapter d’attestation ou décision de maintien du flag off ;
- politique de draft PHI chiffré, TTL, backup et purge ;
- matrice des versions/transitions encounter.

### Travail

- permission géolocalisation, check-in/out, précision et consentement ;
- file offline visible et réconciliation ;
- Encounter composer, save draft, conflit, reprise après background/step-up ;
- fermeture/finalisation avec preuve serveur.

### Sortie mesurable

- aucun batch partiel n’est présenté comme entièrement synchronisé ;
- répétition du même événement ne crée pas de doublon ;
- GPS denied/approximate, 403 assignment, window failure et conflit sont distingués ;
- kill/relaunch et appel téléphonique reprennent le bon draft, puis logout le détruit.

## Lot 4 — signatures, Orders et Scheduling

### Dépendances

- passkey/TOTP step-up production-ready ;
- double-booking M17 converti en 409 métier ;
- `eligible-clinicians` et règles de signature suivies par écran.

### Travail

- queues Orders/Encounter signatures, contexte patient, version et confirmation ;
- Calendar Day/Week, Visit/Proposal detail, assign/reassign/cancel/no-show ;
- rôle physician/NP/medical director et preset scheduling filtrés par permission.

### Sortie mesurable

- aucune signature offline ni retry automatique ambigu ;
- un changement de version force une relecture ;
- l’assignation réapplique les guards serveur et le calendrier reflète la mutation ;
- retour queue conserve filtre/position et retire l’item signé.

## Lot 5 — Admissions, assessments et plans interdisciplinaires

### Travail

- Referral Inbox, review, New Referral/New Admission focalisés ;
- discharge/transfer/readmit comme workflows, pas tabs ;
- Assessments, HOPE, Care Plan, Discipline Plans, IDG ;
- presets intake, MSW et chaplain.

### Sortie mesurable

- hard duplicate, soft review, incomplete documents et 422 sont actionnables ;
- toutes les sections Patient Workspace sont filtrées individuellement ;
- les signataires requis et transitions sont ceux du serveur ;
- les sept parcours de référence ont un test E2E mobile heureux + erreur + interruption.

## Lot 6 — Messaging, push et sécurité terrain

### Dépendances

- API device-token native, fournisseur unique, révocation et payload PHI-free ;
- auth/reconnexion Socket.IO native démontrée.

### Travail

- inbox/conversations/tasks, read state et drafts chiffrés ;
- push FCM Android/APNs iOS et deep links ;
- On-call, Field Safety et notifications urgentes ;
- caméra/fichiers uniquement pour contrats démontrés.

### Sortie mesurable

- lock screen ne contient aucune PHI ; token invalide est révoqué ; logout désenregistre l’installation ;
- reconnexion socket relit la vérité REST et ne duplique pas les messages ;
- Part 2 et channel membership restent fail-closed ;
- notification froide/chaude revient correctement à l’origine.

## Lot 7 — revenue, conformité, administration et parité longue traîne

### Travail

- Billing Medicare/Medicaid, Remittance, CAP, Cost Reports ;
- Audit, QAPI, Reports, privacy/consent, Staff/Roles/Organization ;
- Supplies, Documents, IPU, AI, Terminology, MDM, staff Portal/Telehealth ;
- traiter toutes les lignes P3/external dependencies sans suppression silencieuse.

### Sortie mesurable

- chaque ligne du CSV passe à `mapped` implémenté, `blocked-dependency` avec owner/date ou
  `requires-design` avec décision approuvée ;
- toute mutation sensible a version, step-up/confirmation et preuve serveur appropriés ;
- parité mesurée par route et capacité, pas par nombre d’écrans copiés.

## Risques et réponses

| Risque | Signal précoce | Réponse |
|---|---|---|
| deuxième auth mobile divergente | bearer token ad hoc ou permission locale | bloquer ; rester dans Better Auth/ADR-0026 |
| fausse promesse offline | bouton success avant ack | état par item, contrat idempotent, tests coupure réseau |
| fuite PHI device | AsyncStorage/log/query URL | lint/revue sécurité, redaction, tests de purge |
| navigation instable multirôle | tabs qui changent après clic | preset déterministe recalculé seulement sur contexte/permissions |
| duplication d’écrans | push depuis tab/drawer/deep link | route canonique, `navigate`/unwind, origin/anchor |
| copie du desktop | 12 tabs ou tables compressées | groupes, list/detail, workflows focalisés |
| permissions supposées | `if role === …` comme garde | context permissions + route guard + serveur |
| dette parité cachée | fonctionnalité « trop complexe » omise | CSV exhaustif et backlog par ligne |

## Décision d’entrée Lot 1

**GO sous conditions pour PR C.** Le plugin Better Auth Expo, la séparation des origines, le bootstrap
CSRF et le contrat backend sont en place. Avant diffusion, les propriétaires doivent ratifier ADR-0072
et choisir les schemes/app links. PR C doit prouver SecureStore, cookies, CSRF et Socket.IO sur iOS et
Android. Push natif, passkey natif et EVV offline restent des lots ultérieurs ; leurs UI ne doivent pas
simuler une disponibilité.

## Prompt historique du Lot 0.5

> Réaliser le Lot 0.5 WardenX Mobile : proposer un ADR de supersession d’ADR-0035 pour remplacer le
> Capacitor wrap par React Native + Expo, sans initialiser `apps/mobile`. Mettre à jour de façon cohérente
> les documents d’architecture, System Design, Security Hardening, Integrations, DR/BCP, design mobile et
> manifest/codePaths concernés. Démontrer l’équivalent Expo/RN de chaque contrôle mobile actuel et
> définir les frontières de partage non-DOM. Soumettre la décision à ratification, exécuter les gates
> documentaires autorisés, puis seulement préparer un prompt Lot 1 d’initialisation Expo.

