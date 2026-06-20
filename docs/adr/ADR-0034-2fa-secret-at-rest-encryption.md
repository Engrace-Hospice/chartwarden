# ADR-0034 — 2FA secret at-rest encryption (Better Auth twoFactor over M1's encrypted columns)

- **Status:** **Accepted** — ratified 2026-06-20 (Security-Owner sign-off). Authorizes the 4
  implementation tasks below; the pure cipher layer lands first (unit-testable), the adapter decorator +
  live-lane assertions follow on a PG-capable runner.
- **Date:** 2026-06-20
- **Phase:** auth wave follow-up (AUTH-T05/T06 deferred this; it gates 2FA enrollment + the MFA screens).
- **Extends:** [ADR-0033](ADR-0033-better-auth-mount-and-prod-db-client.md) (Better Auth mount; §the 2FA
  reconciliation was deferred here). Plan context: `docs/plans/AUTH_T06_SCHEMA_RECONCILE.md`.

## Context
M1 deliberately stores the TOTP secret + backup codes **encrypted at rest** — the `two_factor` table has
`secret_encrypted` / `backup_codes_encrypted` columns (user-owned, NON_ORG_SCOPED). Better Auth's
`twoFactor` plugin, however, manages **plaintext** `secret` / `backup_codes`. Reconciling them was the
"Option C" chosen at AUTH-T06. Two facts make C a focused sub-project, not a config tweak:

1. **`databaseHooks` cover only the core models** (user/session/account/verification) — **not** plugin
   models — so the `twoFactor` secret write cannot be intercepted via the standard hook.
2. **No existing user-level encryption helper.** The `*_encrypted` columns were never wired; the only
   envelope helper in the tree is **org-scoped / PHI**, and 2FA secrets are **user-level** (a user's 2FA
   works across every org they belong to), so an org-scoped DEK is the wrong key boundary.

## Decision

### 1. Interception — a Better Auth adapter decorator (in `packages/auth`)
Wrap `drizzleAdapter(db, …)` with an **encrypting adapter decorator** that, for the `twoFactor` model
only, **encrypts** the `secret` and `backupCodes` fields on `create`/`update` inputs and **decrypts** them
on `findOne`/`findMany` outputs. Better Auth's `database` option accepts a custom adapter, so the
decorator composes over the Drizzle adapter without forking the plugin. The plugin's fields are
**field-mapped** to M1's columns (`secret → secret_encrypted`, `backupCodes → backup_codes_encrypted`) so
no plaintext-named columns are introduced and the migration keeps M1's `*_encrypted` shape (no new
`two_factor` columns vs ADR-0033's additive migration 0024).

### 2. Cipher — AES-256-GCM, user-level server key
- **AES-256-GCM** (authenticated encryption) via `node:crypto`. Random **96-bit nonce per value**.
- At-rest format (base64): `version(1) ‖ nonce(12) ‖ ciphertext ‖ tag(16)` — the version byte enables
  rotation without ambiguity.
- **Key: a single user-level server key** (2FA is user-scoped, cross-org — a per-org DEK is the wrong
  boundary), 32 bytes, from `TWO_FACTOR_ENCRYPTION_KEY` (base64 env, or KMS-sourced at boot). **Fail
  closed** in production if absent. This is distinct from `BETTER_AUTH_SECRET` (separation of concerns).
- Backup codes encrypt the same way (the JSON array → ciphertext in `backup_codes_encrypted`).

### 3. Rotation (forward-looking, not built now)
The `version` byte + a small key registry (id → key) lets a future rotation decrypt old values with the
old key and re-encrypt on next write. Out of scope for the first implementation; the format reserves for it.

### 4. Verification — the live-PG lane (load-bearing)
Extend the `auth-live` CI job (real Postgres): enroll TOTP, then **assert `two_factor.secret_encrypted`
is ciphertext** (≠ the plaintext TOTP secret, and decryptable), and a **TOTP challenge verifies** end to
end (the decrypt round-trips). The infra-free unit suite covers only the pure cipher (encrypt→decrypt,
tamper→fail, wrong-key→fail).

## Consequences
- **Preserves M1's at-rest posture** for 2FA secrets (the reason Option C was chosen over plaintext B).
- **New secret:** `TWO_FACTOR_ENCRYPTION_KEY` — documented, fail-closed, separate from the session secret.
- **Adapter-decorator complexity:** the decorator must cover **every** twoFactor read/write path Better
  Auth uses (create/update/findOne/findMany); a missed path would store/return plaintext — hence the
  live-lane assertion that the stored value is ciphertext.
- **Unlocks** 2FA enrollment → the **MFA-challenge / step-up** screens (AUTH-T07 follow-ups). Passkey
  enrollment is a **separate** reconciliation (credentialID/transports/counter + flow), not this ADR.
- Verified live; the unit suite cannot exercise the plugin path (no DB) — same trade-off ADR-0033 §5 set.

## Implementation tasks (after ratification, on a PG-capable runner)
1. `packages/auth` pure cipher (`aes256gcmSeal`/`Open` + key loader) + unit tests.
2. The encrypting adapter decorator + the `two_factor` field maps in `createIdentityAuth`.
3. Live-lane assertions (enroll → ciphertext-at-rest → verify).
4. Wire MFA-challenge into the sign-in flow (the screen consumes `twoFactorClient`).

## References
- ADR-0033, `docs/plans/AUTH_T06_SCHEMA_RECONCILE.md`, `packages/db/src/schema/two-factor.ts`,
  `packages/auth/src/identity/auth.ts` (the `twoFactor` plugin + adapter), migration `0024`.
