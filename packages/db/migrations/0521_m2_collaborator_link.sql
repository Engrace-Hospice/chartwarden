-- M2 — the durable external-collaborator / funeral-home magic-link store and its principal (GAP-115 follow-up).
--
-- `POST /api/v1/collaborators/invite` and `POST /api/v1/funeral/invite` minted a link into a per-process Map: the
-- token vanished on restart, a second replica could never redeem it, and `POST /collaborators/consume` consumed it
-- without ever creating a `session` row — a funeral link was issued, audited and one-time, but not redeemable.
-- This is the persisted side, shaped like `auditor_magic_link` (0402) and `portal_invitation` (0424):
--
--   * only the sha256 HASH of the 256-bit token is stored (`token_hash`, unique); the raw token is handed to the
--     delivery port exactly once. The token is `<organizationId>.<secret>` so the unauthenticated redeem route can
--     open the right tenant under RLS (the org prefix is not secret).
--   * bounded use: `max_uses` (default 1 — single-use) and `use_count`; a redemption is ONE conditional UPDATE
--     (`use_count < max_uses AND revoked_at IS NULL AND expires_at > now()`), so exactly one of N concurrent
--     redeemers wins. `consumed_at` is stamped when the last use is spent.
--   * `kind` is the session class the redemption yields (`external_collaborator` | `funeral_home`).
--   * `principal_user_id` — a redeemed link needs an M2 `user` for Better Auth's session row (`session.user_id` is
--     NOT NULL). The principal is a synthetic, credential-less user created at first redemption; it has no password,
--     no account row and no membership, so it can authenticate only through this link.
--
-- Patient-bearing (it pins the one patient the session may read), so it carries the ARCH-011 provider_entity_id
-- NOT NULL + location_id, resolved from the patient's admission at issue time. Idempotent.
CREATE TABLE IF NOT EXISTS "collaborator_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"invited_by_membership_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"session_ttl_sec" integer NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"first_redeemed_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"principal_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collaborator_link_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "collaborator_link_provider_entity_id_provider_entity_id_fk"
		FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "collaborator_link_location_id_location_id_fk"
		FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "collaborator_link_principal_user_id_user_id_fk"
		FOREIGN KEY ("principal_user_id") REFERENCES "public"."user"("id") ON DELETE restrict,
	CONSTRAINT "collaborator_link_kind_chk" CHECK ("kind" IN ('external_collaborator','funeral_home')),
	CONSTRAINT "collaborator_link_uses_chk" CHECK ("max_uses" >= 1 AND "use_count" >= 0 AND "use_count" <= "max_uses"),
	CONSTRAINT "collaborator_link_session_ttl_chk" CHECK ("session_ttl_sec" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collaborator_link_token_hash_uq" ON "collaborator_link" ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collaborator_link_org_patient_idx" ON "collaborator_link" ("organization_id", "patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collaborator_link_provider_entity_idx" ON "collaborator_link" ("provider_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collaborator_link_location_idx" ON "collaborator_link" ("location_id");--> statement-breakpoint

ALTER TABLE "collaborator_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "collaborator_link" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "collaborator_link_org" ON "collaborator_link"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- No DELETE for the app role: a consumed/revoked link is the access-grant evidence.
GRANT SELECT, INSERT, UPDATE ON "collaborator_link" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "collaborator_link" TO wardenx_admin;--> statement-breakpoint

DROP TRIGGER IF EXISTS "collaborator_link_audit" ON collaborator_link;--> statement-breakpoint
CREATE TRIGGER "collaborator_link_audit" AFTER INSERT OR UPDATE OR DELETE ON collaborator_link
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
