-- GAP-093 — M17 §1.1 D8 `clinician_credentials_active` pre-schedule gate. The clinical-license/
-- certification roster: a row per (membership × discipline) credential grant. Distinct from the
-- M3 RBAC role grant `discipline_matches_visit` checks — a clinician can hold the "rn" ROLE while
-- their nursing LICENSE has lapsed or been suspended; this table backs the latter, separate fact.
--
-- STAFF-scoped, not patient-scoped: organization_id only (the three-column rule scopes PHI-bearing
-- tables; the volunteer_compliance_gate precedent, migration 0098, is the same shape for the same
-- reason — PE/location are attributes of a visit assignment, not of a clinician's credential).
CREATE TYPE "public"."credential_discipline" AS ENUM('rn', 'lpn', 'chha', 'msw', 'chaplain', 'volunteer', 'md', 'np');--> statement-breakpoint
CREATE TYPE "public"."credential_status" AS ENUM('active', 'suspended', 'revoked');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "membership_credential" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "credential_type" "credential_discipline" NOT NULL,
  "status" "credential_status" DEFAULT 'active' NOT NULL,
  "effective_at" date NOT NULL,
  "expires_at" date,
  "revoked_at" timestamptz,
  "revoked_reason" text,
  "issuing_body" text,
  "granted_by_membership_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "membership_credential_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE restrict,
  CONSTRAINT "membership_credential_membership_fk"
    FOREIGN KEY ("membership_id") REFERENCES "membership"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "membership_credential_current_uq"
  ON "membership_credential" ("organization_id", "membership_id", "credential_type")
  WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_credential_active_lookup_idx"
  ON "membership_credential" ("organization_id", "membership_id", "credential_type", "status")
  WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_credential_valid_window_idx"
  ON "membership_credential" ("organization_id", "effective_at", "expires_at");--> statement-breakpoint
ALTER TABLE "membership_credential" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "membership_credential" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "membership_credential_org" ON "membership_credential";--> statement-breakpoint
CREATE POLICY "membership_credential_org" ON "membership_credential"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "membership_credential" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "membership_credential" TO wardenx_admin;--> statement-breakpoint
CREATE TRIGGER "membership_credential_audit"
  AFTER INSERT OR UPDATE OR DELETE ON membership_credential
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
