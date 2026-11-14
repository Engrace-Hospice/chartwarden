# Configuration minimale de test/staging

Approche uniquement, pas des valeurs applicables. Créer les secrets dans le gestionnaire réservé au staging.

## Configuration minimale prod-like

1. `NODE_ENV=production`; image et `GIT_SHA` immuables identifiés; URL API/Web/Admin/Portail et `TRUSTED_ORIGINS` du domaine staging; proxy allowlist limité au reverse proxy staging.
2. Secrets auth/chiffrement staging (`BETTER_AUTH_SECRET`, chiffrement 2FA, keys cursor/KEK requises), uniques; callback/passkey RP ID alignés au domaine de test.
3. PostgreSQL, Redis/Valkey, stockage objet et ClamAV privés, persistants et dédiés. Rôles DB distincts; aucun volume/compte/URL prod partagé.
4. API et worker du même SHA; queues staging; readiness et schedules contrôlés.
5. Build web contre API staging; TLS, cookies sécurisés, CORS, callbacks et WebSocket vérifiés.
6. Désactiver toutes les sorties au départ; autoriser uniquement une sandbox confirmée après contrôle anti-live.

Les URLs de connexion, tokens, KEKs, HMAC/auth/2FA, identifiants S3 et webhooks sont secrets. Hôtes, modes et flags ne sont pas secrets mais doivent être staging. Fournir les secrets par secret store/mount, jamais dans Git, image, build args ou journaux.

## Garde-fous métier

- Pas de `CLEARINGHOUSE_VENDOR`, credentials clearinghouse ni config tenant autorisant l’envoi.
- Claim.MD webhook et modes capture, attribution, delivery, posting désactivés.
- `M24_LAUNCH_GATEWAY_ENABLED=false` jusqu’à validation sandbox.
- Pas d’activation DoseSpot production ni de clé Stripe live.
- Email/SMS/appels/push vers sink ou destinataires de test uniquement.
- Aucun identifiant, queue, DB, bucket, clé ou backup partagé avec production.

Le backend exige ses secrets en `NODE_ENV=production`; les valeurs fictives du [gabarit](TEST_ENV_EXAMPLE.md) doivent être remplacées dans le secret store.
