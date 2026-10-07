-- GAP-092 — M31 portal invitations (spec §3.3 `portal_invitation`): the magic-link invitation that creates a portal
-- account + its per-patient grant.
--
-- `POST /admin/portal-invitations` fabricated ids and persisted nothing; list / revoke / invite-bereaved did
-- nothing; and no code path anywhere inserted a `portal_account` or `portal_access_grant` (F-164). Now: issue creates
-- the invitee's M2 user (via M2's primitive), an `invited` `portal_account` (contact PHI sealed under the tenant DEK)
-- and this row, whose token is stored ONLY as a SHA-256 digest (single-use, 72h..7d TTL). Accepting the token
-- activates the account and inserts the grant, under the M39 portal-access consent resolved at that moment.
--
-- PATIENT-BEARING (patient_id), so beyond organization_id NOT NULL it carries the ARCH-011 provider_entity_id NOT NULL +
-- location_id (nullable), resolved from the patient's admission. FORCEd RLS on app.org_id; no DELETE for the app role
-- (an invitation is part of the access-provisioning trail; the portal eraser deletes under wardenx_destruction).
-- Idempotent.
CREATE TABLE IF NOT EXISTS "portal_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"portal_account_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"relationship" "portal_account_relationship" NOT NULL,
	"grant_kind" "portal_access_grant_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"proposed_scope_overlay" jsonb,
	"caregiver_id" uuid,
	"bereaved_contact_id" uuid,
	"invited_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_invitation_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "portal_invitation_provider_entity_id_fk"
		FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "portal_invitation_account_fk"
		FOREIGN KEY ("portal_account_id") REFERENCES "public"."portal_account"("id") ON DELETE restrict,
	CONSTRAINT "portal_invitation_not_both_terminal_chk" CHECK ("accepted_at" IS NULL OR "revoked_at" IS NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portal_invitation_token_hash_uq" ON "portal_invitation" ("token_hash");--> statement-breakpoint
-- At most one OUTSTANDING invitation per account + patient: re-issuing revokes the prior one first.
CREATE UNIQUE INDEX IF NOT EXISTS "portal_invitation_outstanding_uq" ON "portal_invitation" ("portal_account_id", "patient_id")
	WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_invitation_org_idx" ON "portal_invitation" ("organization_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_invitation_patient_idx" ON "portal_invitation" ("patient_id");--> statement-breakpoint

ALTER TABLE "portal_invitation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal_invitation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "portal_invitation_org" ON "portal_invitation"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- The accept route is token-authenticated (no session, hence no org context yet): the token carries its org id as a
-- non-secret prefix (`<orgId>.<secret>`), so the route opens `withOrgContext(<orgId>)` and looks the digest up under RLS —
-- no cross-tenant lookup function is needed, and a forged prefix simply finds nothing.
GRANT SELECT, INSERT, UPDATE ON "portal_invitation" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "portal_invitation" TO wardenx_admin;--> statement-breakpoint
DO $$ BEGIN
  GRANT SELECT, DELETE ON "portal_invitation" TO wardenx_destruction;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_portal_invitation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['token_hash']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'portal_invitation.' || lower(TG_OP), 'portal_invitation', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('patient_id', COALESCE(NEW.patient_id, OLD.patient_id), 'provider_entity_id', COALESCE(NEW.provider_entity_id, OLD.provider_entity_id), 'location_id', COALESCE(NEW.location_id, OLD.location_id)), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_portal_invitation() OWNER TO wardenx_audit_writer;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_portal_invitation" ON portal_invitation;--> statement-breakpoint
CREATE TRIGGER "trg_audit_portal_invitation" AFTER INSERT OR UPDATE OR DELETE ON portal_invitation
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_portal_invitation();
