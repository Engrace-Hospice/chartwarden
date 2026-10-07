-- M2 — the durable auditor magic-link token store (GAP-011).
--
-- M3's POST /engagements/:id/auditors calls M2's `AuditorSessionMinter` seam, whose issuer was a per-process
-- Map: the one-time token vanished on restart / was invisible to a second instance, and the TASK-001 in-memory
-- ledger refused a production boot over it. This is the persisted side: only the sha256 HASH of the single-use
-- token is stored (the invitation precedent — `organization_invitation.token_hash`), bound to the engagement
-- and its window. `consumed_at` makes it single-use; `revoked_at` is set when the engagement closes/cancels
-- (authz.close_engagements). No FK to `auditor_engagement` (M3-owned): M2 does not depend on M3 — the
-- `engagement_id` is an opaque reference the issuer was handed. Not PHI (no patient reference), so the
-- three-column rule's provider_entity_id/location_id do not apply (the organization_invitation shape).
-- Idempotent.
CREATE TABLE IF NOT EXISTS "auditor_magic_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"auditor_email" text NOT NULL,
	"auditor_name" text NOT NULL,
	"token_hash" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auditor_magic_link_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade,
	CONSTRAINT "auditor_magic_link_window_chk" CHECK ("window_start" < "expires_at")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auditor_magic_link_token_idx" ON "auditor_magic_link" ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auditor_magic_link_org_engagement_idx" ON "auditor_magic_link" ("organization_id", "engagement_id");--> statement-breakpoint

ALTER TABLE "auditor_magic_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auditor_magic_link" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "auditor_magic_link_org" ON "auditor_magic_link"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- No DELETE for the app role: a consumed/revoked link is the access-grant evidence.
GRANT SELECT, INSERT, UPDATE ON "auditor_magic_link" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "auditor_magic_link" TO wardenx_admin;--> statement-breakpoint

DROP TRIGGER IF EXISTS "auditor_magic_link_audit" ON auditor_magic_link;--> statement-breakpoint
CREATE TRIGGER "auditor_magic_link_audit" AFTER INSERT OR UPDATE OR DELETE ON auditor_magic_link
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
