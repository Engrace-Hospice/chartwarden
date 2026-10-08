-- M2 §7.7 — per-auditor BAA / engagement-terms acceptance (the batch-21 auditor 2FA + BAA ceremony).
--
-- An external auditor redeems a single-use link into a CONSTRAINED enrolment session; before that session is
-- upgraded to the read-only engagement session the auditor must accept the versioned BAA / engagement terms
-- and prove a second factor. This is the durable evidence of the acceptance: WHO (user + typed name), WHEN
-- (accepted_at), FROM WHERE (ip, user agent), WHICH TERMS (version + sha-256 of the exact text shown) and FOR
-- WHAT (organization + engagement).
--
-- Append-only for the app role (SELECT, INSERT — no UPDATE, no DELETE): an acceptance is never edited or
-- retracted, a new terms version is a new row. One row per (organization, engagement, user, terms hash), so
-- re-posting the same acceptance is idempotent (ON CONFLICT DO NOTHING) and a re-issued link to the same
-- engagement does not ask again for the same text. `engagement_id` is an opaque reference to M3's
-- `auditor_engagement` (no FK: M2 does not depend on M3 — the auditor_magic_link precedent). Not PHI (no
-- patient reference), so the three-column rule's provider_entity_id / location_id do not apply.
-- Idempotent.
CREATE TABLE IF NOT EXISTS "auditor_baa_acceptance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"terms_version" text NOT NULL,
	"terms_sha256" text NOT NULL,
	"accepted_name" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"session_id" text,
	CONSTRAINT "auditor_baa_acceptance_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "auditor_baa_acceptance_user_id_user_id_fk"
		FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict,
	CONSTRAINT "auditor_baa_acceptance_hash_chk" CHECK ("terms_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auditor_baa_acceptance_name_chk" CHECK (length(btrim("accepted_name")) >= 2)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auditor_baa_acceptance_uq"
	ON "auditor_baa_acceptance" ("organization_id", "engagement_id", "user_id", "terms_sha256");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auditor_baa_acceptance_user_idx" ON "auditor_baa_acceptance" ("user_id");--> statement-breakpoint

ALTER TABLE "auditor_baa_acceptance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auditor_baa_acceptance" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "auditor_baa_acceptance_org" ON "auditor_baa_acceptance"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Append-only: an acceptance is evidence, never edited or removed by the application.
GRANT SELECT, INSERT ON "auditor_baa_acceptance" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "auditor_baa_acceptance" TO wardenx_admin;--> statement-breakpoint

DROP TRIGGER IF EXISTS "auditor_baa_acceptance_audit" ON auditor_baa_acceptance;--> statement-breakpoint
CREATE TRIGGER "auditor_baa_acceptance_audit" AFTER INSERT OR UPDATE OR DELETE ON auditor_baa_acceptance
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
