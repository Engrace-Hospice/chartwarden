# PR B — checklist de sortie

Date : 2026-10-16  
Conclusion : **GO sous conditions pour PR C**

Le backend et le contrat permettent de commencer l’intégration mobile. La ratification d’ADR-0069,
le choix des schemes/app links et les preuves sur appareils restent des conditions avant diffusion.

## Objectifs livrés

- [x] Baseline des fichiers, versions et protections réellement présents.
- [x] ADR-0069 proposé comme supersession explicite d’ADR-0035, historique conservé.
- [x] Corpus Architecture, System Design, Security Hardening, Integrations et design mobile aligné.
- [x] Aucun `apps/mobile`, code React Native ou changement dans `wardenx-mobile`.
- [x] `@better-auth/expo` `1.6.25` ajouté dans `packages/auth`, sur l’unique instance Better Auth.
- [x] Plugins username, TOTP, passkey navigateur, magic link, credentials et session existants conservés.
- [x] Origins web HTTP(S), callbacks natifs et expected origins WebAuthn séparés et validés.
- [x] CORS et Socket.IO utilisent uniquement les origins web exactes ; aucune wildcard ou confiance en
  `Origin: null`/Origin absent.
- [x] Bootstrap CSRF authentifié, minimal et non cacheable à `GET /api/v1/auth/csrf`.
- [x] Double-submit navigateur conservé ; client natif soumis au même contrôle sans bypass.
- [x] Multiple `Set-Cookie` Better Auth + `wardenx_csrf` préservés par le pont Fastify.
- [x] Organisation one-shot, MFA, changement de mot de passe, classes de session et step-up inchangés.
- [x] OpenAPI, schéma client généré et rapport de couverture actualisés.
- [x] Contrat PR C documenté pour Better Auth, Axios, CSRF, erreurs, cycle de session et Socket.IO.

## Vérifications réellement exécutées

| Commande | Résultat |
|---|---|
| `bunx vitest run` sur les 12 fichiers ciblés auth/origins/CSRF/Fastify/session/auditeur/realtime | **PASS** — 12 fichiers, 203 tests |
| `WARDENX_TEST_DATABASE_URL=… bun run test:auth:live` sur un conteneur privé `pgvector/pgvector:pg18` | **PASS** — 1 fichier, 26 tests ; vraie session Better Auth, bootstrap CSRF, binding org et rôle applicatif NOBYPASSRLS ; conteneur supprimé |
| `bunx tsc -p packages/auth/tsconfig.json --noEmit --pretty false` | **PASS** |
| `bunx tsc -p apps/backend/tsconfig.json --noEmit --pretty false` | **PASS** |
| `bunx biome check <fichiers TypeScript modifiés>` | **PASS** après correction de format/imports |
| `bun run arch:boundaries` | **PASS** |
| `bun run arch:request-header-auth` | **PASS** |
| `bun run arch:error-envelope` | **PASS** |
| `bun run arch:test-typecheck` | **PASS** |
| `bun run arch:merge-artifacts` | **PASS** |
| `bun run arch:manifest-mirror` | **PASS** |
| `bun run arch:architecture-docs` | **PASS** avec le warning préexistant sur le stamp de `identity-frontend-integration.md` |
| `bun run arch:adr-docs` | **PASS** |
| `bun run docs:ui` | **PASS** |
| `bun run openapi:emit && bun run client:gen` | **PASS** |
| `bun run openapi:check` | **PASS** |
| `bun run arch:openapi-provenance` | **PASS** |
| `bun run arch:openapi-coverage` | premier passage **FAIL attendu** car rapport stale ; `bun run openapi:coverage` puis nouveau passage **PASS** |
| `bun run client:check` | **PASS** |
| `bun run check:boot:platform` | **PASS** |
| `git diff --check` | **PASS** |

La suite monorepo complète, `bun run arch:fitness`, les autres suites live et tout déploiement n’ont pas
été exécutés, conformément au périmètre ciblé demandé. La suite Socket.IO live requiert aussi Valkey et
reste couverte par sa lane existante, pas par cette exécution PR B.

## Risques bloquants avant diffusion mobile

- **Ratification :** ADR-0069 est proposé ; le Frontend/Architecture Owner doit enregistrer son accord.
- **Identité applicative :** scheme production, bundle/application IDs, Universal/App Links et fichiers
  d’association doivent être choisis et vérifiés avec les builds signés.
- **Transport device :** PR C doit prouver Better Auth Expo/SecureStore, CSRF Axios et Socket.IO sur un
  appareil iOS et un appareil Android. Les tests backend ne valent pas certification device.
- **Passkey natif :** non démontré et ne doit pas être annoncé ; TOTP/backup codes restent le fallback.

## Risques non bloquants pour PR C, bloquants pour leurs fonctions futures

- biométrie/foreground lock, screenshot policy, root/jailbreak, attestation, pinning et MDM ;
- cache PHI/offline chiffré et réconciliation EVV ;
- cycle d’installation APNs/FCM et notifications natives sans PHI ;
- validation du transport Socket.IO réel sur les deux plateformes et comportement réseau dégradé.

## Validation PR C attendue

- [ ] Login username/password, TOTP/backup, password change, membership, org one-shot et contexte réels.
- [ ] `getCookie()` + SecureStore persistent et purgent la session sans journaliser les headers.
- [ ] Bootstrap CSRF après login/reprise, double-submit Axios exact et scénarios négatifs device.
- [ ] Foreground, expiration, révocation, logout et mutation au résultat ambigu.
- [ ] Socket.IO avec cookie réel, refus session invalide, reconnexion puis relecture REST.
- [ ] Vérification des permissions effectives ; aucun accès décidé par rôle ou org local.

