-- ADR-0023 D2 (adjudicated) — M2 Identity: the `device_attestation` surface, SecHardening §12.2/§12.4.
--
-- WHAT WAS BROKEN. M3's `device_attestation_valid` predicate reads `AbacContext.attributes
-- .deviceAttestation` and denies unless the platform's own verdict says `valid`. Nothing has ever written
-- that attribute, because M2 owned no attestation table, so the predicate denied EVERY caller. Its one
-- consumer is M33's `report.drilldown.bulk_export` — a CSV of patient-identifiable navigation links — and
-- that route has therefore been closed to everyone, always. The deny direction is correct (an un-attested
-- device must not carry a bulk PHI export) but a control that cannot ever pass is not a control, it is an
-- outage wearing one: nothing distinguishes "your device is not attested" from "no device can be".
--
-- ADR-0023 D2 named exactly this surface and gave two exits: add it to M2 with a real manifest
-- `ownedTables` edit (the `tenant_step_up_policy_override` precedent), or declare it vapor and delete the
-- consuming spec. It is added, because it has TWO consumers and one of them already writes to it: M18's
-- `evv_device.m2_device_attestation_id` is documented in that table as "M2 row (app-validated; no FK)" — a
-- logical foreign key to a table that did not exist, which M18's own registration path satisfies with
-- `randomUUID()`. Declaring the surface vapor would have required deleting that column too.
--
-- WHY A TABLE AND NOT A SESSION COLUMN. The attestation outlives the session (one phone, many sessions),
-- it is revocable independently of any session (a lost device is revoked once, not chased through session
-- rows), and M18 references it BY ROW ID. `session.device_attestation_id` carries only the pointer, and
-- the resolver re-reads the row rather than trusting the pointer — see below.
--
-- WHAT MAKES THE VERDICT THE PLATFORM'S. Every row is written by M2 after it verified an assertion against
-- state the SERVER holds: the `managed_enrollment` provider is an HMAC over a server-minted single-use
-- challenge, keyed by the org's enrollment secret. A device-integrity claim supplied by the device being
-- judged is not evidence, so nothing here is reachable from a request header, body or query. The two
-- hardware providers (`apple_app_attest`, `google_play_integrity`) verify a vendor signature and run in
-- the `DeviceAttestationVerifier` adapter; the enum records WHICH class of evidence a row rests on so a
-- reviewer can tell a hardware attestation from a managed-fleet one.
--
-- SHAPE follows `membership_elevated_approval` (0204) and `membership_credential` (0191): one LIVE row per
-- (membership, device) via a partial unique index, superseded and revoked rows retained in place as the
-- trail. STAFF-scoped, so `organization_id` only — the ARCH-011 three-column rule scopes PHI-bearing
-- tables and a device registration is not one.
CREATE TYPE "public"."device_attestation_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."device_attestation_provider" AS ENUM('managed_enrollment', 'apple_app_attest', 'google_play_integrity');--> statement-breakpoint
CREATE TYPE "public"."device_attestation_verdict" AS ENUM('attested', 'failed', 'revoked');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_attestation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "device_key_fingerprint" text NOT NULL,
  "platform" "device_attestation_platform" NOT NULL,
  "provider" "device_attestation_provider" NOT NULL,
  "verdict" "device_attestation_verdict" NOT NULL,
  "posture" jsonb,
  "failure_reason" text,
  "verified_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "revoked_by_membership_id" uuid,
  "revoked_reason" text,
  "version" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "device_attestation_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE restrict,
  CONSTRAINT "device_attestation_membership_fk"
    FOREIGN KEY ("membership_id") REFERENCES "membership"("id") ON DELETE cascade,
  CONSTRAINT "device_attestation_revoked_by_fk"
    FOREIGN KEY ("revoked_by_membership_id") REFERENCES "membership"("id"),
  -- An attestation must expire. A proof with no horizon is a permanent trust decision made once, which is
  -- the opposite of what a posture check is for.
  CONSTRAINT "device_attestation_window_ordered" CHECK ("expires_at" > "verified_at"),
  -- A revocation is all-or-nothing: instant, actor and reason together or none of them. The 0204
  -- invariant, for the same reason — "revoked, by nobody, for no reason" makes the trail useless. The
  -- `verdict` must agree, so a row cannot read `attested` while carrying a revocation.
  CONSTRAINT "device_attestation_revocation_consistent" CHECK (
    ("revoked_at" IS NULL AND "revoked_by_membership_id" IS NULL AND "revoked_reason" IS NULL
     AND "verdict" <> 'revoked')
    OR ("revoked_at" IS NOT NULL AND "revoked_by_membership_id" IS NOT NULL
        AND "revoked_reason" IS NOT NULL AND length(btrim("revoked_reason")) >= 10
        AND "verdict" = 'revoked')
  ),
  -- A failure must say what failed, and a pass must not carry a failure reason. Without this a row can
  -- read `attested` with a populated `failure_reason`, which is the shape a reviewer cannot interpret.
  CONSTRAINT "device_attestation_failure_reason_consistent" CHECK (
    ("verdict" = 'failed' AND "failure_reason" IS NOT NULL AND length(btrim("failure_reason")) > 0)
    OR ("verdict" <> 'failed' AND "failure_reason" IS NULL)
  )
);--> statement-breakpoint
-- At most one LIVE attestation per device. Re-attesting inserts a NEW row and revokes the previous one,
-- so the history reads as a sequence of proofs rather than one mutated flag.
CREATE UNIQUE INDEX IF NOT EXISTS "device_attestation_live_uq"
  ON "device_attestation" ("organization_id", "membership_id", "device_key_fingerprint")
  WHERE "verdict" = 'attested' AND "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_attestation_live_lookup_idx"
  ON "device_attestation" ("organization_id", "membership_id")
  WHERE "verdict" = 'attested' AND "revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "device_attestation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "device_attestation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "device_attestation_org" ON "device_attestation";--> statement-breakpoint
CREATE POLICY "device_attestation_org" ON "device_attestation"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- No DELETE grant: an attestation is revoked, never erased. A device that was trusted and then was not is
-- exactly what a post-incident review asks about.
GRANT SELECT, INSERT, UPDATE ON "device_attestation" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "device_attestation" TO wardenx_admin;--> statement-breakpoint
CREATE TRIGGER "device_attestation_audit"
  AFTER INSERT OR UPDATE OR DELETE ON device_attestation
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
-- The session's pointer at the device it runs on. Plain uuid, no FK, matching
-- `evv_device.m2_device_attestation_id`: `session` is a Better Auth NON_ORG_SCOPED table and the
-- attestation is org-RLS'd, so a hard FK would couple session deletion to an org-scoped row. The resolver
-- re-reads the attestation and re-checks that it is live and unexpired, so a dangling or stale pointer
-- DENIES rather than admits — the pointer is a lookup key, never the verdict.
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "device_attestation_id" uuid;
