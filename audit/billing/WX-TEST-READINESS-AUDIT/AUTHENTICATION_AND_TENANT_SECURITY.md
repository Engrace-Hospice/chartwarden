# Authentification et sécurité tenant

## Présent dans le dépôt

- Bootstrap `assertProductionEnv` exige et contrôle des secrets en production (`apps/backend/src/bootstrap/env.ts`).
- Architecture/gates imposent RLS, `app.org_id`, séparation rôles, ABAC et vérification de portée des routes.
- Auth dépend d’URL/origines de confiance, secret Better Auth, chiffrement 2FA, passkeys et cookies.

## Non démontré

- Aucun domaine/IdP staging, DNS/TLS, callback, configuration cookies SameSite ou test navigateur externe vérifié.
- Clés effectives, RP ID, trusted proxy et base domain d’un hôte inconnus; ne pas recycler celles de production.
- Données visibles à distance non vérifiées; n’utiliser que fixtures/identités synthétiques.
- Protection de branche et environnement GitHub signalée comme manquante dans le workflow; configuration GitHub non lue.

Avant ouverture: tester login/MFA/passkey avec comptes synthétiques, cookies Secure, domaine strict, CORS/CSRF/callback, refus cross-tenant avec rôle app NOBYPASSRLS, opérateurs limités, durée et effacement des données staging.
