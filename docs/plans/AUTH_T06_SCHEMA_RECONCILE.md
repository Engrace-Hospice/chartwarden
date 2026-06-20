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

## Authoritative diff — DONE (generator run 2026-06-20)
`bunx @better-auth/cli generate` against `createIdentityAuth` emitted the exact required schema, captured
at **`docs/api/better-auth-required-schema.generated.ts`** (reference artifact; regenerate after any
plugin/field-map change). It already reflects the `account.fields` mappings. Findings below are now
**authoritative**, not pre-analysis.

## Findings (authoritative — from the generator)

| Table | Required (generator) | M1 today | Action |
|---|---|---|---|
| **user** | + `two_factor_enabled boolean default false` | absent | **migration: add column** |
| **session** | id, expires_at, token, ip/ua + activeOrganizationId/sessionClass/scope/engagement*/screenLockedAt/lastStepUp* | all present | **compatible** ✓ |
| **account** | + `id_token`, `scope`, `access_token_expires_at`, `refresh_token_expires_at` | absent | **migration: add 4 columns** (nullable) |
| **verification** | + `updated_at` | absent | **migration: add column** |
| **two_factor** | `secret`, `backup_codes` (plaintext) | `secret_encrypted`, `backup_codes_encrypted` | **DECISION — see below** |
| **passkey** | + `aaguid`; fields publicKey/credentialID/deviceType/backedUp | columns present (snake_case) but **no `aaguid`** | **migration: add `aaguid`** + confirm drizzle JS-binding names match (else field-map) |

(PK type: the generator emits `text` ids by default; M1 uses `uuid` — that is fine, Better Auth is
PK-type-agnostic; the live user/session already work with uuid. No action.)

## Decision required — 2FA secret at-rest encryption (Security-Owner) — **NO FREE OPTION**
Confirmed: **Better Auth's twoFactor plugin and core expose NO secret-encryption option** (no `encrypt`
hook). M1 stores `secret_encrypted` / `backup_codes_encrypted` (encrypted at rest); the plugin writes
plaintext `secret` / `backup_codes`. So the earlier "Option A (native encrypt-at-rest)" is **not
available**. The real choice:

- **B — Accept plaintext columns:** add `secret` / `backup_codes` (matching the generator) and rely on
  disk / pgcrypto at-rest encryption. Simplest; **weakens** M1's column-level posture → explicit
  Security-Owner acceptance (and likely a short ADR).
- **C — Custom encryption hook:** keep M1's `*_encrypted` columns, map the plugin fields to them, and
  encrypt/decrypt via a Better Auth `databaseHooks` (or the M1 envelope helper) on twoFactor write/read.
  Preserves posture; more work; needs verifying the hook fires for the twoFactor model.

**Recommendation: C** (preserve the at-rest posture M1 deliberately chose), accepting the extra hook work.
**This is the gate** — the migration's `two_factor` shape + the field maps depend on it.

### C feasibility (investigated 2026-06-20) — C is a focused crypto SUB-PROJECT, not a one-line hook
- **`databaseHooks` cover only the core models** (user/session/account/verification), **not the
  `twoFactor` plugin model** — so the secret write cannot be intercepted via the standard hook. C needs a
  custom storage-adapter wrap or a forked plugin to intercept twoFactor writes.
- **No existing user-level encryption helper.** The `*_encrypted` columns were never wired (2FA wasn't
  functional); the only envelope helper in the tree is org-scoped/PHI, not user-level. C therefore means
  **new user-level key management + encrypt/decrypt**, built from scratch — security-critical and
  unverifiable without Postgres.

→ **C should be its own ADR + task** (build the user-level 2FA-secret encryption + write-interception +
PG verification). It is **not** bundled into the additive reconciliation.

## Revised execution (given C's scope)
1. **Now (safe, additive, unblocks email+password sign-in):** migration for `user.two_factor_enabled`,
   `account` +4 OAuth columns, `verification.updated_at`, `passkey.aaguid` + passkey field-maps; a
   **password** sign-in `auth.live.test` + a CI `auth-live` job (Postgres) to verify on real PG. The M1
   `two_factor.*_encrypted` columns are left untouched, reserved for C. (The `twoFactor` plugin stays
   enabled but 2FA *enrollment* is non-functional until C lands — password sign-in for non-2FA users is
   unaffected.)
2. **Follow-up (C, its own ADR):** user-level 2FA-secret encryption + twoFactor write-interception +
   enrollment flow, PG-verified.
3. **AUTH-T07:** M2 sign-in/MFA/passkey screens (Better Auth client) once the live lane is green.

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
