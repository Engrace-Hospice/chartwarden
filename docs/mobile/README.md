# WardenX Mobile — cadrage et contrats inter-repositories

## Statut et périmètre

Ce dossier est le cadrage documentaire de l’application métier mobile WardenX. La cible est la
parité fonctionnelle progressive avec `apps/web` pour les professionnels hospice. `apps/portal` et
`apps/admin` ne sont pas des sources de routes à porter dans ce lot. Ils restent des éléments de
l’écosystème, pas des fonctionnalités déclarées hors cible.

Le mobile est une application React Native/Expo autonome dans le repository `wardenx-mobile` ; aucun
`apps/mobile` n’est créé ici. [ADR-0072](../adr/ADR-0072-separate-react-native-expo-mobile-app.md)
porte la supersession formelle d’ADR-0035 et reste à ratifier par les propriétaires d’architecture.
PR B prépare uniquement le backend, les contrats et la gouvernance nécessaires à l’authentification
native. L’EVV offline, les notifications natives et les écrans métier restent hors de ce lot.

## Décisions actées

- Cible produit : React Native + Expo + TypeScript, Expo Router, NativeWind, Axios et Lucide React
  Native, dans le repository séparé. Sa ratification d’architecture demeure une décision humaine.
- Expo SecureStore pour les secrets appropriés. AsyncStorage est limité aux préférences non sensibles ;
  aucune PHI et aucun jeton n’y sont admis.
- Le design mobile reprend les tokens WardenX : bleu clinique `#1a56eb`, surfaces slate, Inter pour
  l’interface et IBM Plex Mono pour les identifiants. Les composants sont natifs React Native ; aucun
  composant DOM n’est importé.
- Le backend reste l’autorité pour les permissions, les scopes, les validations et les transitions.
  Les rôles ne servent qu’à proposer un preset de raccourcis.
- Téléphone : bottom navigation stable de 3 à 5 destinations autorisées, catalogue global accessible
  par **un unique onglet `Modules`**. Il n’y a pas de hamburger concurrent.
- Tablette : rail/sidebar adaptatif permanent ou repliable, sans bottom bar dupliquée.
- Les actions `New`, `Sign`, `Approve`, `Check-in`, `Readmit`, `Discharge` et `Transfer` restent
  contextuelles ; elles ne deviennent jamais des tabs.

## Livrables

- [Architecture de navigation](./navigation-architecture.md)
- [Rôles et raccourcis](./roles-and-shortcuts.md)
- [Matrice Web → Mobile](./web-mobile-parity.csv)
- [Parcours utilisateurs](./user-journeys.md)
- [Préparation backend](./backend-mobile-readiness.md)
- [Baseline vérifiée de PR B](./PR-B-BASELINE.md)
- [Contrat backend Expo/Better Auth pour PR C](./backend-expo-auth-contract.md)
- [Checklist et résultats PR B](./PR-B-CHECKLIST.md)
- [Correctifs contrats M6 PR G.1-B](./pr-g1b-backend-contract-fixes.md)
- [Rapport de non-régression Web PR G.1-B](./pr-g1b-web-regression-report.md)
- [Transmission des contrats mobile PR G.1-B](./pr-g1b-mobile-contract-handoff.md)
- [Benchmark UX](./ux-benchmark.md)
- [Roadmap d’implémentation](./implementation-roadmap.md)

## Méthode et sources internes

L’inventaire part du registre réellement monté par
`apps/web/src/main.tsx`, des fichiers `apps/web/src/modules/*/screens.ts` et des pages système de
`apps/web/src/shell/system-pages.tsx`. Le rapport généré `audit/ui-parity/ui-parity.json` sert de
contre-vérification des modules. La matrice contient une ligne par route montée, y compris les routes
dynamiques, les écrans chromeless et les états système.

Les décisions de navigation sont ancrées notamment dans :

- `apps/web/src/shell/primary-nav.ts` et `module-navigation.ts` ;
- `apps/web/src/shell/chart-module-rail.tsx` pour le dossier patient ;
- `apps/web/src/shell/actor-session.ts` et `session.tsx` pour le contexte effectif ;
- `apps/backend/src/modules/02-identity/routes/identity-routes.ts` pour `/api/v1/auth/context`, les
  memberships et la sélection d’organisation ;
- `packages/auth/src/roles/display-names.ts`, `templates.ts`, `intake-grants.ts` et
  `admitting-clinician-grants.ts` ;
- les routes M17 Scheduling, M18 EVV, M11 Orders et M36 Messaging ;
- `packages/ui/src/core/capabilities/ports.ts`, dont les interfaces sont utiles mais dont les
  commentaires/adaptateurs Capacitor ne constituent pas une implémentation Expo.

Repères précis dans la révision auditée :

| Sujet | Source |
|---|---|
| enregistrement des pages système | `apps/web/src/main.tsx:76` |
| catalogue de navigation web | `apps/web/src/shell/primary-nav.ts:33` |
| douze sections du dossier patient | `apps/web/src/shell/chart-module-rail.tsx:69` |
| contexte acteur effectif | `apps/backend/src/modules/02-identity/routes/identity-routes.ts:203` |
| sélection one-shot d’organisation | `apps/backend/src/modules/02-identity/routes/identity-routes.ts:224` |
| calcul du scope Visits | `apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts:101` |
| liste `/api/v1/visits` | `apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts:315` |
| EVV offline batch | `apps/backend/src/modules/18-evv/routes/evv-routes.ts:242` |
| handshake Socket.IO | `apps/backend/src/bootstrap/realtime/server.ts:93` |
| transport Web Push/VAPID | `apps/backend/src/modules/36-messaging/delivery/transport-binding.ts:130` |
| endpoints de notification | `apps/backend/src/modules/36-messaging/routes/messaging-routes.ts:781` |
| ports de capacités | `packages/ui/src/core/capabilities/ports.ts:77` |
| token bleu clinique | `apps/web/src/index.css:44` |
| décision historique remplacée à ratifier | `docs/adr/ADR-0072-separate-react-native-expo-mobile-app.md` |

La détection des dépendances API dans le CSV est statique et limitée au composant directement lié par
`screens.ts`. `À vérifier` signifie qu’aucun endpoint littéral n’a été démontré à cet endroit ; ce n’est
pas une preuve d’absence d’API. Les appels indirects, clients Better Auth et services importés doivent
être confirmés au moment de la tranche verticale.

## Limites et hypothèses à tester

- Aucun test utilisateur n’a été réalisé. Les presets de navigation sont des hypothèses UX.
- Le plugin serveur Expo et le contrat CSRF/cookies sont couverts par les tests backend ciblés de PR B.
  Le transport réel et SecureStore doivent encore être prouvés sur appareils iOS et Android en PR C.
- Les permissions peuvent être personnalisées par tenant. Aucune table de ce dossier ne prétend qu’un
  rôle possède toujours une permission, sauf lorsqu’un floor ou un grant explicite est cité.
- Les routes staff-side M31 visibles dans `apps/web` restent dans la cible ; les routes propres à la SPA
  patient `apps/portal` ne sont pas incluses.
- Le mode offline est borné aux brouillons explicitement conçus pour cela. Il n’existe pas de promesse
  de dossier patient complet hors ligne.
- ADR-0072 est proposé à ratification. L’historique d’ADR-0035 est conservé et n’est pas réécrit.

## Glossaire

| Terme | Sens dans ce dossier |
|---|---|
| Destination | Zone navigable de premier niveau, sans effet métier immédiat. |
| Shortcut | Destination fréquente affichée dans la bottom bar après filtrage par permission. |
| Catalogue | Liste recherchable de toutes les destinations autorisées (`Modules`). |
| Patient Workspace | Contexte canonique conservant `patientId`, bannière et sections du dossier. |
| Workflow focalisé | Stack plein écran pour une action longue/sensible, avec brouillon et sortie contrôlée. |
| Origine | Route et paramètres depuis lesquels un deep link ou un workflow a été ouvert. |
| Step-up | Réauthentification serveur fraîche exigée pour une opération donnée. |
| PHI | Donnée de santé identifiable ; interdite dans push lock-screen, logs et stockage non chiffré. |
| À vérifier | Contrat non démontré par l’inspection statique ciblée ; validation exigée avant implémentation. |

## Couverture

Les chiffres de couverture sont générés et doivent être lus dans `audit/ui-parity/` et dans la matrice
CSV de ce dossier. Les lignes `requires-api-verification` restent mappées, mais leur contrat de données
doit encore être suivi au-delà du composant racine.

