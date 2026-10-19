# Préparation backend pour le mobile

## Décision synthétique

Le backend est largement réutilisable pour les données, permissions et transitions, mais la session
native ne doit pas copier le comportement navigateur au moyen d’un cookie bricolé dans Axios.

PR B a ajouté l’intégration serveur officielle Better Auth Expo à l’adaptateur unique, séparé les
origines web/WebAuthn des schemes natifs et défini l’amorçage CSRF authentifié. ADR-0069 porte la
supersession d’ADR-0035 et attend la ratification formelle. PR C doit encore démontrer sur appareils le
transport SecureStore, le login username, TOTP/backup codes, cookie/session, CSRF, sign-out, révocation
et Socket.IO. Le passkey natif reste non démontré.

Alternative non retenue : inventer un bearer token mobile parallèle. Cela créerait une deuxième surface
d’authentification contraire à ADR-0026 et demanderait rotation, révocation, session classes et step-up
en double.

## Tableau de préparation

| Domaine | Classement | Existant vérifié | Exigence mobile / écart |
|---|---|---|---|
| Gouvernance stack | condition humaine | ADR-0069 propose le remplacement du wrap Capacitor par le repo Expo séparé ; corpus autoritaire aligné | ratifier ADR-0069 sans réécrire ADR-0035 |
| Better Auth | prêt côté serveur | instance unique avec plugin Expo, username, TOTP, passkey navigateur, magic link, cookies/session dans `packages/auth/src/identity/auth.ts` | pinner la version client compatible et prouver le transport SecureStore sur appareils ; aucun token maison |
| Session/CSRF | contrat backend prêt | CSRF navigateur inchangé ; bootstrap authentifié `GET /api/v1/auth/csrf` et double-submit exact | appliquer le protocole du contrat PR C et tester iOS/Android réel |
| Auth context | réutilisable tel quel | `/api/v1/auth/context` retourne identité, org, membership, roles, locations, scope, permissions | ajouter une politique de refresh foreground/403 ; aucune permission calculée côté client |
| Sélection org | réutilisable avec contrainte | memberships + sélection one-shot ; `ORG_ALREADY_BOUND` si déjà liée | le changement d’org implique aujourd’hui sign-out/re-auth ; documenter explicitement l’UX |
| Mot de passe temporaire | réutilisable tel quel | credential status + complete-required-change ; allowlist dans `authenticate.ts` | root state natif et purge session sur conflit/révocation |
| MFA/TOTP | adaptateur natif nécessaire | challenge et vérification existent ; aucun écran web d’enrolment TOTP | décider UI d’enrolment ; ne pas dépendre exclusivement de WebAuthn natif sans preuve |
| Passkeys | à vérifier | RP ID/origins et écran web ; cérémonie navigateur démontrée | vérifier support Expo/native et association domain ; fallback TOTP obligatoire si non prouvé |
| Step-up | réutilisable avec adaptateur | état serveur `lastStepUp*`, routes initiate/verify et `requireStepUp` | conserver intention sans auto-rejouer la mutation ; UI facteur native à valider |
| Axios/API | adaptateur natif nécessaire | client `openapi-fetch` web avec correlation/status handling | créer client Axios mobile typé autour des contrats, cookies/headers Better Auth, `Idempotency-Key`, `If-Match`, correlation IDs |
| OpenAPI/TS | réutilisable tel quel | `packages/ui/src/core/api/schema.ts` et contrats générés | extraire/importer uniquement types/contrats non-DOM ; ne pas importer provider React DOM/web |
| My Visits | modification UX + contrat conseillé | `/api/v1/visits` restreint serveur par caseload, patient épinglé et assigned membership ; `visit.read_team` élargit | le nom « My » n’est pas strictement « assigned only » ; ajouter `scope=assigned_to_me` ou endpoint dédié avant promesse UX |
| EVV capture | adaptateur natif nécessaire | check-in/out, assignment/window ABAC, géoloc body, device attestation optionnelle | permissions OS, précision/consentement, attestation réelle, stockage chiffré et état GPS |
| EVV offline | modification backend nécessaire | prévalidation complète, puis écritures indépendantes | résultat par événement + idempotency key + reprise sûre ; aujourd’hui une panne à N peut laisser 1..N-1 committés |
| Encounters/Orders/HOPE | réutilisable avec discipline | validations, transitions, 409 et `If-Match` sur plusieurs surfaces | matrice précise d’idempotence/version par commande ; aucune retry automatique non idempotente |
| Signatures | réutilisable avec adaptateur | guards permission/ABAC/step-up et transitions serveur | écran plein, version affichée, preuve serveur avant succès, reprise après step-up |
| Socket.IO | backend compatible, device à vérifier | handshake cookie, origin web allowlist, org/user/session dérivés serveur, rooms serveur, recheck révocation | prouver `extraHeaders.Cookie` sur transports iOS/Android ; reconnect avec relecture REST ; aucun event client→serveur |
| Push | modification backend nécessaire | M36 delivery endpoints et Web Push VAPID | ajouter type de device/token natif, FCM Android et APNs iOS (direct ou FCM relay), rotation/révocation/logout |
| SecureStore | adaptateur natif nécessaire | interface `SecureStorePort` générique, web adapter localStorage | implémentation Expo SecureStore ; limiter aux petits secrets/session, politique de migration/erreur/purge |
| AsyncStorage | politique seulement | aucun contrat mobile | préférences non sensibles uniquement ; jamais PHI, token, réponse patient, message ou draft clinique |
| Capabilities ports | réutilisable comme interfaces | geolocation, camera, biometric, secure store, push, filesystem, network | implémenter des adapters Expo ; corriger la documentation historique Capacitor sans importer `web-adapters.ts` |

## Authentification et erreurs

### Flux attendu

1. Login username/password via Better Auth.
2. Si challenge 2FA, route MFA ; stocker uniquement la session/cookies via SecureStore.
3. Lire credential status ; imposer le changement temporaire si nécessaire.
4. Lire memberships ; si plusieurs, choisir puis lier une fois l’organisation.
5. Lire `/api/v1/auth/context`; lancer l’app seulement avec `organizationId` non vide.
6. Refresh du contexte au foreground, après reconnexion socket, 403/423, changement serveur signalé.
7. Logout : Better Auth sign-out confirmé, fermeture socket, purge SecureStore/cache/drafts et reset router.

Les statuts doivent rester distincts : 401 session absente/expirée ; 403 permission ou step-up selon le
code d’enveloppe ; 409 conflit d’état/version ; 422 validation ; 423 verrouillage si renvoyé ; 503
indisponibilité. Le client lit l’enveloppe WardenX et le correlation ID ; il ne transforme pas toutes
les erreurs en « reconnectez-vous ».

### CSRF et transport

Le helper Better Auth Expo restitue les cookies Better Auth qu’il gère ; il ne constitue pas une preuve
qu’il capture le cookie applicatif `wardenx_csrf`. PR B ne repose donc pas sur cette hypothèse. Après
authentification, le client appelle `GET /api/v1/auth/csrf` avec son cookie Better Auth, conserve le
nonce retourné en mémoire, puis joint `wardenx_csrf=<nonce>` et `X-CSRF-Token: <nonce>` à toute mutation
`/api/v1/*`. Le contrat complet de rotation et reprise est dans `backend-expo-auth-contract.md`. Un
`Origin` absent ne vaut jamais autorisation : session, permissions, contexte serveur et RLS restent requis.

## Client Axios mobile

- `baseURL` par environnement signé/configuré, pas éditable par l’utilisateur en production.
- Timeout et annulation par écran ; aucune PHI dans URL/query si un body ou identifiant opaque convient.
- `withCredentials` ou header Better Auth uniquement selon le prototype validé.
- Ajout d’un correlation ID non-PHI ; journalisation des codes/latences sans body clinique.
- Retry automatique limité à GET/HEAD et commandes explicitement idempotentes avec la même clé.
- Ne jamais retry automatiquement une signature, transition ou EVV si le résultat est inconnu.
- Conserver et envoyer `If-Match` lorsque le contrat l’exige ; 409 ouvre la résolution de conflit.
- Une réponse serveur réussie, pas la mise en file locale, déclenche le statut `success`.

## My Visits

`apps/backend/src/modules/17-scheduling/routes/scheduling-routes.ts` construit un `VisitReadScope` :
les rôles org-wide et détenteurs `visit.read_team` voient large ; les autres voient les patients de leur
caseload, le patient de session et les visites assignées à leur membership. Le filtre `clinician` existe,
mais laisser le client fournir son propre membership ne doit pas devenir une barrière de sécurité.

Contrat recommandé : `GET /api/v1/visits?scope=assigned_to_me&from=…&to=…`, où le serveur dérive le
membership de la session. Tant qu’il n’existe pas, le mobile nomme la vue « Visits » ou distingue
Assigned/Caseload sans prétendre que toutes les lignes sont assignées.

## EVV et offline

Le mobile capture coordonnées, précision, timestamp, source et identifiant local idempotent. Il demande
la permission juste avant le besoin, explique l’usage et sait traiter denied/restricted/approximate.
L’attestation appareil est désactivée par défaut tant qu’aucun client attesté n’existe ; l’activer avant
l’adapter Expo rendrait toutes les captures 403.

Contrat cible pour sync : réponse par événement `{clientEventId, status, serverEventId?, code?,
retryable}` ; clé idempotente stable ; capacité serveur de retourner les événements déjà appliqués ;
batch atomique ou sémantique partielle explicitement documentée. L’UI montre `pending`, `syncing`,
`accepted`, `rejected`, jamais un unique toast « synced » pour un batch ambigu.

## Messaging et notifications

Socket.IO n’est qu’un signal PHI-free ; REST/DB reste la vérité. Le client reconnecte avec backoff,
rafraîchit la session, puis relit les cursors/read state. Les drafts de message contenant de la PHI sont
chiffrés ou restent en mémoire.

M36 enregistre aujourd’hui des endpoints `push|sms|email`, mais le push transport est Web Push/VAPID.
Contrat natif proposé :

- `POST /api/v1/notifications/device-tokens` avec `platform`, `provider`, `token`, `appVersion`,
  `deviceInstallId`, `locale` et preuve/session ;
- rotation/upsert idempotent, suppression par installation, révocation au logout/offboarding et traitement
  des tokens invalides fournisseurs ;
- payload lock-screen sans nom patient, diagnostic, message ou contenu clinique ; seulement catégorie,
  identifiant opaque et deep link ;
- Android via FCM ; iOS finit toujours par APNs, directement ou via FCM. Le choix fournisseur doit être
  unique côté client pour éviter deux registrations concurrentes.

## Stockage et effacement

| Donnée | Stockage permis | Règle |
|---|---|---|
| session/cookies/secrets | Expo SecureStore | taille limitée, accessibilité device-only appropriée, purge logout/revocation |
| préférence thème/ordre fixe | AsyncStorage | non sensible, non identifiante |
| dernier `orgId` | préférence prudente | identifiant opaque seulement ; ne rétablit jamais l’autorité |
| draft clinique | store/fichier chiffré dédié à concevoir | lié user+org+resource, TTL, version, purge stricte |
| cache patient/messages | chiffré et explicitement approuvé | minimum nécessaire, TTL, pas de backup cloud involontaire |
| PHI, token ou message | **interdit dans AsyncStorage** | interdit également dans logs, analytics, crash breadcrumbs et clipboard |

## Top 10 gaps avant les lots fonctionnels

| # | Criticité | Gap / décision | Lot |
|---|---|---|---|
| 1 | Bloquante | Expo/RN contredit ADR-0035 et quatre documents d’architecture/sécurité | 0.5 |
| 2 | Bloquante | Auth Expo/Better Auth non intégrée : prototype + plugin serveur/client + Axios/Socket | 1 |
| 3 | Bloquante | Politique CSRF/cookies/trusted schemes native non prouvée | 1 |
| 4 | Haute | Passkey native et fallback TOTP/enrolment non démontrés | 1–2 |
| 5 | Haute | Push actuel Web Push/VAPID ; device-token FCM/APNs absent | 2 |
| 6 | Haute | EVV offline peut être partiellement committé sans ack par événement/idempotence claire | 3 |
| 7 | Haute | Device attestation Expo non conçue ; flag serveur doit rester off jusque-là | 3 |
| 8 | Haute | « My Visits » ne garantit pas assigned-only ; nouveau scope serveur recommandé | 2 |
| 9 | Haute | Double-booking scheduling peut remonter 500 au lieu de 409 métier | 4 |
| 10 | Moyenne | Politique cache PHI/drafts chiffrés, TTL, backup et purge à formaliser/tester | 1 |

