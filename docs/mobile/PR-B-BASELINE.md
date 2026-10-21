# PR B — Baseline backend et architecture mobile

Date d'inspection : 2026-10-16  
Révision inspectée : `6cd1e1af5` sur `fix/admission`  
Gestionnaire : Bun `1.3.14`

Ce document enregistre l'état observé avant les modifications de PR B. Le dossier `docs/mobile/`
existait déjà comme contenu non suivi dans le checkout inspecté ; PR B le conserve et ajoute ses
livrables sans réécrire l'audit Lot 0.

## Périmètre et gouvernance observés

- `docs/adr/ADR-0035-capacitor-mobile-wrap-and-ui-core-split.md` existe, est **Accepted** et interdit
  explicitement une app React Native séparée. `docs/adr/README.md` précise qu'un ADR accepté est
  immuable : une décision ultérieure doit le superséder.
- `docs/architecture/CHARTWARDEN_ARCHITECTURE_v0_11.md`,
  `CHARTWARDEN_SYSTEM_DESIGN_v0.3.md` et `CHARTWARDEN_SECURITY_HARDENING_v0_2.md` prescrivent encore le wrap
  Capacitor. `CHARTWARDEN_INTEGRATIONS_v0_1.md`, `docs/design/DESIGN.md` et la spec de la suite mobile
  contiennent aussi des références ciblées.
- ADR-0026 impose Better Auth comme surface unique, y compris pour les opérateurs externes. ADR-0005
  fait du manifest l'autorité sur les codePaths. Comme `wardenx-mobile` est un dépôt séparé et qu'aucun
  code mobile n'entre ici, aucun nouveau codePath n'est nécessaire dans le manifest ChartWarden.
- Le manifest autorise les imports Better Auth uniquement dans `packages/auth`. L'intégration Expo
  serveur doit donc rester dans cet adaptateur.

## Authentification observée

- `packages/auth/src/identity/auth.ts` construit l'unique instance via `createIdentityAuth()`.
  Plugins présents : lien de session interne, administration des credentials, username, contrôle HIBP,
  TOTP/backup codes, passkey et magic link. Les secrets TOTP sont chiffrés par le décorateur Drizzle.
- Les champs de session supplémentaires sont serveur uniquement : organisation active, classe, scope,
  fenêtre d'engagement, verrouillage écran et fraîcheur/facteur de step-up. La durée Better Auth est
  fixe et le hook ChartWarden applique les timeouts par classe.
- Better Auth et `@better-auth/passkey` sont résolus en `1.6.25`. `@better-auth/expo` n'était pas
  installé lors de l'inspection.
- La source officielle taguée `v1.6.25` expose `expo()` côté serveur et déclare un peer Better Auth de
  la même ligne. Le plugin remplace l'Origin absent par le header `expo-origin`; il ne dispense pas de
  la validation de cet origin contre `trustedOrigins`.
- `packages/auth/src/identity/mount.ts` monte seulement `/api/auth/*`, relaie la requête au handler Web
  Better Auth, conserve les événements/audits et fusionne les multiples `Set-Cookie` avec ceux déjà
  placés sur la réponse.
- `packages/auth/src/identity/client.ts` reste un client navigateur `better-auth/react`. PR B n'y ajoute
  pas de dépendance Expo afin de ne pas charger des modules React Native dans le bundle web.

## Origins, WebAuthn, CORS et temps réel observés

- `resolveTrustedOrigins()` lit `TRUSTED_ORIGINS` et retourne uniquement les trois origins Vite en
  développement par défaut. Cette même liste alimente Better Auth et Socket.IO.
- `resolvePasskeyOrigins()` réutilise `resolveTrustedOrigins()` puis ajoute `BETTER_AUTH_URL`. Ajouter
  directement un scheme natif dans `TRUSTED_ORIGINS` ferait donc entrer une URL non HTTP(S) dans les
  expected origins WebAuthn.
- `PASSKEY_RP_ID` est obligatoire en production ; les cérémonies passkey existantes sont des cérémonies
  navigateur. Aucun flux passkey React Native n'est démontré.
- Le middleware CORS est une allowlist exacte sans wildcard. Le composition root ne passait toutefois
  pas explicitement les origins résolues à `corsAllowOrigins` dans la configuration observée ; PR B doit
  éviter de confondre schemes Better Auth et origins CORS HTTP(S).
- Socket.IO autorise une absence d'Origin pour un client non navigateur, mais exige toujours une session
  valide, une organisation serveur, une session staff active, le membership et la MFA. Les rooms sont
  calculées côté serveur, le client n'émet aucun événement et la session est revérifiée périodiquement.

## Session ChartWarden et parcours observés

- `authenticate.ts` charge la session Better Auth, applique classe/timeout, credential state,
  password-change, MFA et binding d'organisation avant de produire le contexte de requête.
- `/api/v1/auth/memberships` et `/api/v1/auth/context` nécessitent une session. La sélection
  `/api/v1/auth/select-organization` est one-shot et renvoie `ORG_ALREADY_BOUND` au second essai ; le
  client ne peut pas imposer un org, rôle ou membership par header.
- Les routes de credential status, changement de mot de passe obligatoire et step-up restent distinctes
  et ne sont pas relâchées pour mobile.

## CSRF et cookies observés

- `apps/backend/src/bootstrap/plugins/csrf.ts` émet `chartwarden_csrf` (`SameSite=Lax`, `Secure` en
  production, non HttpOnly) sur la première requête. Une mutation `/api/v1/*` qui porte un cookie de
  session doit renvoyer la même valeur dans `X-CSRF-Token`; absence, valeur différente ou cookie émis
  pendant cette même requête échouent en 403.
- `/api/auth/*` reste exempt du double-submit ChartWarden parce que Better Auth applique son propre contrôle
  d'origin. Les webhooks signés et probes sont les autres exemptions nommées ; il n'existe pas
  d'exemption native.
- Les tests existants couvrent le mint, le mismatch, le premier POST refusé, le round-trip exact et les
  cookies de session préfixés `__Secure-`.
- Dans `@better-auth/expo@1.6.25`, `getCookie()` retourne les cookies que le plugin client a persistés.
  Le filtre par défaut ne retient que les cookies dont le nom commence par `better-auth`. La docs permet
  plusieurs préfixes, mais cela ne constitue pas un contrat ChartWarden pour le renouvellement du nonce
  applicatif. PR B doit donc fournir un bootstrap explicite et authentifié.

## Hypothèses et dépendances de PR B

- Le scheme final et les domaines Universal/App Links appartiennent à PR C et à la configuration de
  déploiement. PR B valide une liste explicite `MOBILE_AUTH_TRUSTED_ORIGINS` sans wildcard et ne choisit
  pas silencieusement une valeur de production.
- La base URL native est l'origin HTTPS public du backend ; le chemin Better Auth reste `/api/auth`.
- L'enrôlement et l'assertion passkey natifs restent non démontrés. TOTP et backup codes sont le fallback
  requis jusqu'aux tests device.
- Aucun test iOS/Android, attestation, pinning, MDM, push ou stockage PHI offline n'est inclus dans ce
  dépôt ou dans PR B.
- Les suites live ne doivent jamais viser le cluster Docker partagé. Une preuve live ciblée peut utiliser
  un conteneur `pgvector/pgvector:pg18` privé, une base fraîche et le rôle applicatif NOBYPASSRLS ; toute
  preuve non exécutée sera explicitement notée dans la checklist.
