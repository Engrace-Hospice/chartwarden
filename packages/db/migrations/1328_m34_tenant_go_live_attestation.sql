-- compat: expand
-- M34 two-party go-live (slice 1a). onboarding -> active used to be automatic once the sweep saw every step settled.
-- It now takes two people: the tenant's compliance officer ATTESTS readiness (step-up), then a platform operator
-- APPROVES (step-up, human, reason) and the tenant goes active only if the activation guards pass at that moment. A
-- platform operator can also REVOKE a pending attestation.
--
-- tenant_go_live_attestation: one row per attempt, never deleted (a revoked attestation stays as history, and an
-- approved one is the evidence of who authorised the go-live; like tenant_account_status_event it survives offboarding).
-- Tenant-scoped on organization_id (no PHI). RLS ENABLE + FORCE. The tenant role may only READ its own rows and INSERT a
-- PENDING one (the WITH CHECK pins status and every approve/revoke column, so a tenant can never write an approval);
-- approve and revoke are written on the BYPASSRLS platform login (scripts/db/provision-runtime-roles.ts grants it SELECT
-- and a COLUMN-level UPDATE). Write audit: the M1 baseline trigger, whose after-image carries both actors' membership ids.
-- The CHECKs make the state machine a database fact: pending has no approval or revocation, approved has a reason and a
-- different approver than the attester, revoked has a reason.
--
-- tenant_account.compliance_officer_membership_id: the tenant's org_admin assigns the compliance officer during
-- onboarding, so chartwarden_app gets a COLUMN-level UPDATE on that one column (and updated_at) with an own-org UPDATE
-- policy. It still cannot write status or any other column.
CREATE TABLE IF NOT EXISTS "tenant_go_live_attestation" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tenant_account_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attested_by_membership_id" uuid NOT NULL,
	"attested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attestation_note" text,
	"approved_by_membership_id" uuid,
	"approved_at" timestamp with time zone,
	"approval_reason" text,
	"revoked_by_membership_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_go_live_attestation_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "tenant_go_live_attestation_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "tenant_go_live_attestation_tenant_account_id_fk" FOREIGN KEY ("tenant_account_id") REFERENCES "public"."tenant_account"("id") ON DELETE restrict,
	CONSTRAINT "tenant_go_live_attestation_status_ck" CHECK ("status" IN ('pending', 'approved', 'revoked')),
	CONSTRAINT "tenant_go_live_attestation_note_ck" CHECK ("attestation_note" IS NULL OR length("attestation_note") <= 2000),
	CONSTRAINT "tenant_go_live_attestation_approval_reason_ck" CHECK ("approval_reason" IS NULL OR length(btrim("approval_reason")) BETWEEN 8 AND 1000),
	CONSTRAINT "tenant_go_live_attestation_revoke_reason_ck" CHECK ("revoke_reason" IS NULL OR length(btrim("revoke_reason")) BETWEEN 8 AND 1000),
	CONSTRAINT "tenant_go_live_attestation_state_ck" CHECK (
	  ("status" = 'pending'
	     AND "approved_by_membership_id" IS NULL AND "approved_at" IS NULL AND "approval_reason" IS NULL
	     AND "revoked_by_membership_id" IS NULL AND "revoked_at" IS NULL AND "revoke_reason" IS NULL)
	  OR ("status" = 'approved'
	     AND "approved_by_membership_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "approval_reason" IS NOT NULL
	     AND "approved_by_membership_id" <> "attested_by_membership_id"
	     AND "revoked_by_membership_id" IS NULL AND "revoked_at" IS NULL AND "revoke_reason" IS NULL)
	  OR ("status" = 'revoked'
	     AND "revoked_by_membership_id" IS NOT NULL AND "revoked_at" IS NOT NULL AND "revoke_reason" IS NOT NULL
	     AND "approved_by_membership_id" IS NULL AND "approved_at" IS NULL AND "approval_reason" IS NULL)
	)
);--> statement-breakpoint
-- At most one open attestation per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_go_live_attestation_pending_uq" ON "tenant_go_live_attestation" ("tenant_account_id")
  WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_go_live_attestation_tenant_ix" ON "tenant_go_live_attestation" ("tenant_account_id", "attested_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_go_live_attestation_org_ix" ON "tenant_go_live_attestation" ("organization_id");--> statement-breakpoint

ALTER TABLE "tenant_go_live_attestation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_go_live_attestation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_go_live_attestation_org_read" ON "tenant_go_live_attestation";--> statement-breakpoint
CREATE POLICY "tenant_go_live_attestation_org_read" ON "tenant_go_live_attestation"
  FOR SELECT TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_go_live_attestation_org_attest" ON "tenant_go_live_attestation";--> statement-breakpoint
CREATE POLICY "tenant_go_live_attestation_org_attest" ON "tenant_go_live_attestation"
  FOR INSERT TO chartwarden_app
  WITH CHECK (
    organization_id = nullif(current_setting('app.org_id', true), '')::uuid
    AND status = 'pending'
    AND approved_by_membership_id IS NULL AND approved_at IS NULL AND approval_reason IS NULL
    AND revoked_by_membership_id IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL
  );--> statement-breakpoint
GRANT SELECT, INSERT ON "tenant_go_live_attestation" TO chartwarden_app;--> statement-breakpoint
GRANT ALL ON "tenant_go_live_attestation" TO chartwarden_admin;--> statement-breakpoint
-- The platform carrier exists only where provision-runtime-roles.ts has run; that script re-grants on every run.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chartwarden_platform') THEN
    GRANT SELECT ON "tenant_go_live_attestation" TO chartwarden_platform;
    -- UPDATE is column-level (approve / revoke only): an attestation's attester, time and note can never be rewritten.
    GRANT UPDATE ("status", "approved_by_membership_id", "approved_at", "approval_reason", "revoked_by_membership_id", "revoked_at", "revoke_reason", "updated_at") ON "tenant_go_live_attestation" TO chartwarden_platform;
  END IF;
END $$;
--> statement-breakpoint

CREATE TRIGGER "tenant_go_live_attestation_audit" AFTER INSERT OR UPDATE OR DELETE ON tenant_go_live_attestation
  FOR EACH ROW EXECUTE FUNCTION chartwarden_audit_trigger();--> statement-breakpoint

-- The compliance-officer assignment: one column, own org only.
GRANT UPDATE ("compliance_officer_membership_id", "updated_at") ON "tenant_account" TO chartwarden_app;--> statement-breakpoint
CREATE POLICY "tenant_account_assign_compliance_officer" ON "tenant_account"
  FOR UPDATE TO chartwarden_app
  USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
