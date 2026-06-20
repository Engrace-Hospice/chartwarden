# AUTH-T06 — Better Auth ↔ M1 schema reconciliation (findings + plan)

Before the live-PG auth integration tests (AUTH-T06) can pass, the M1 identity tables must match what
the mounted Better Auth instance + plugins (AUTH-T02/T04/T05) actually read/write. The M1 tables were
designed *for* Better Auth, but a column-level comparison shows real gaps. This doc captures them, the
field-mapping options, the one **security decision** (2FA at-rest encryption), and the execution order.

> **Why a doc, not code:** the agent has **no Postgres** (`WARDENX_TEST_DATABASE_URL` unset), so none of
> this can be empirically verified here — only in CI's `rls-live` lane or a local pg18. Auth-schema
> migrations are security-critical; they should be validated against real PG, not merged blind. Governed
> by **[ADR-0033](../adr/ADR-0033-better-auth-mount-and-prod-db-client.md)** (§5: auth is verified in the
> live-PG lane).

## Authoritative diff first (do this before writing migrations)
Better Auth ships a schema generator that emits the **exact** tables/columns the configured instance +
plugins require:

```
bunx @better-auth/cli generate --config <path to a module exposing createIdentityAuth(db)>
```

Run it (where the auth config loads), diff its output against `packages/db/src/schema/*`, and let that
drive the migration. The findings below are a **static pre-analysis** to scope the work; the generator is
the source of truth.

## Findings (static comparison)

| Table | M1 today | Better Auth needs | Gap / action |
|---|---|---|---|
| **user** | id, email, email_verified, name, image, status, created_at, updated_at | + `twoFactorEnabled` (twoFactor plugin) | **add `two_factor_enabled boolean not null default false`** |
| **session** | id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at + activeOrganizationId/sessionClass/scope/engagement*/screenLockedAt/lastStepUp* | id, userId, token, expiresAt, ipAddress, userAgent + additionalFields | **compatible** ✓ (additionalFields already declared in createIdentityAuth) |
| **account** | id, user_id, provider_id, account_id, password_hash, access_token_encrypted, refresh_token_encrypted, created_at, updated_at | + `id_token`, `scope`, `access_token_expires_at`, `refresh_token_expires_at` | **add the 4 OAuth columns** (nullable; unused by the credential provider but the adapter model includes them — confirm via generate) |
| **two_factor** | id, user_id, method, secret_encrypted, backup_codes_encrypted, verified, created_at, last_used_at | id, userId, `secret`, `backupCodes` | **field mismatch + encryption tension — see Decision** |
| **passkey** | id, user_id, name, credential_id, public_key, counter, device_type, backed_up, transports, created_at, last_used_at | id, userId, name, publicKey, credentialID, counter, deviceType, backedUp, transports, (aaguid?) | **field-map** (credential_id→credentialID, public_key→publicKey, device_type→deviceType, backed_up→backedUp) + confirm `aaguid` need via generate |

`account` already field-maps `password→password_hash`, `accessToken→access_token_encrypted`,
`refreshToken→refresh_token_encrypted` in `createIdentityAuth`. Extend the same pattern to twoFactor +
passkey field names, and add the missing columns by migration.

## Decision required — 2FA secret at-rest encryption (Security-Owner)
M1 deliberately stores `secret_encrypted` / `backup_codes_encrypted` (TOTP secret + backup codes
**encrypted at rest**). Better Auth's `twoFactor` plugin manages `secret` / `backupCodes` as **plaintext**
columns. Reconcile by choosing one:

- **A — Encrypt-at-rest, mapped (preferred if supported):** map the plugin fields to M1's `*_encrypted`
  columns and wrap reads/writes so the stored value is ciphertext (Better Auth field/database hooks, or
  the M1 envelope-encryption helper). Keeps the M1 security posture; needs verifying the plugin exposes a
  field-transform hook.
- **B — Plaintext columns + DB-layer encryption:** add `secret` / `backup_codes` columns and rely on
  disk/pgcrypto at-rest encryption instead of column-level. Simpler; **weakens** the column-level posture
  M1 chose — needs explicit Security-Owner acceptance.
- **C — Custom 2FA storage:** keep M1's encrypted columns and don't use the plugin's storage. Largest.

**Recommendation:** A if Better Auth supports per-field transforms; otherwise escalate B vs C to the
Security-Owner. This decision likely warrants its own short ADR.

## Execution order (after the decision, on a PG-capable runner)
1. `@better-auth/cli generate` → authoritative required schema; diff vs M1.
2. New migration in `packages/db/migrations` for: `user.two_factor_enabled`, the 4 `account` OAuth
   columns, and the twoFactor/passkey reconciliation per the Decision.
3. Field maps in `createIdentityAuth` for twoFactor + passkey (mirror the `account.fields` pattern).
4. Implement the chosen 2FA-encryption approach.
5. `apps/backend/__tests__/auth.live.test.ts` (env-gated): sign-up → sign-in → `getSession` →
   `authenticate` → `request.context`; MFA enroll/challenge; org-select binds the session; lockout.
6. CI: a new `auth-live` job (Postgres service, migrations applied) — or extend `rls-live` — that runs it.
7. Verify green on PG (CI / local pg18). Only then is AUTH-T06 done.

## Status
Backend auth chain is **wired** (T01–T05): DB client → `/api/auth/*` mount → authenticate →
DB-backed SessionContextResolver, with Argon2id + HIBP + 2FA/passkey/magic-link. **Not yet runnable**
end-to-end until this reconciliation + the 2FA decision land and are PG-verified. AUTH-T07 (M2 sign-in/
MFA/passkey screens, Better Auth client per ADR-0033 §4) follows T06.
