-- 0024 — Better Auth ↔ M1 schema reconciliation (AUTH-T06, ADR-0033).
-- Additive columns the mounted Better Auth instance + plugins require. Authoritative target:
-- docs/api/better-auth-required-schema.generated.ts (from `@better-auth/cli generate`). All ADD COLUMN
-- IF NOT EXISTS so the migration is idempotent and safe to re-apply. The two_factor table is left
-- UNCHANGED — its at-rest-encrypted secret reconciliation (Option C) is a separate, ADR-gated task.

-- user: twoFactor plugin enrollment flag.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "two_factor_enabled" boolean NOT NULL DEFAULT false;

-- account: Better Auth account-model columns (used by OAuth providers; null for the credential provider).
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "id_token" text;
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "scope" text;
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "access_token_expires_at" timestamptz;
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "refresh_token_expires_at" timestamptz;

-- verification: Better Auth verification-model column.
ALTER TABLE "verification" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();

-- passkey: Better Auth passkey-model AAGUID (authenticator id). Full passkey field reconciliation +
-- enrollment is a follow-up.
ALTER TABLE "passkey" ADD COLUMN IF NOT EXISTS "aaguid" text;
