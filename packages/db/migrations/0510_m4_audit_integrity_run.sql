-- M4 §4.4 `audit.integrity_sample` — the run history of the sampled audit hash-chain verification.
--
-- The spec's quarterly sample compares live audit rows with a pgBackRest backup; that reader does not exist
-- in this repo (an external factor), so the verification reference is the `audit_seal` hash chain written
-- when a month closes (migration 0011/0012). Each run — sealing included — leaves ONE append-only row here
-- so `GET /api/v1/audit/integrity/report` can say when the chain was last checked and by what result, and so
-- a mismatch is durable evidence (the alert is a notification, this row is the record). `kind` is `sample` (the verification) or `seal` (a run that sealed closed months). `result` is
-- `match` / `mismatch` / `skipped` (hash chain flag off) / `error` (the run itself failed). `detail` carries
-- the broken partitions and reasons — ids, partition names and counts only, never row content (no PHI).
--
-- Org-scoped, not PHI (no patient reference). APPEND-ONLY for the app role: a verification result must not
-- be rewritable by the code that produced it. Idempotent.
CREATE TABLE IF NOT EXISTS "audit_integrity_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text DEFAULT 'sample' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" text NOT NULL,
	"partitions_sealed" integer DEFAULT 0 NOT NULL,
	"seals_total" integer DEFAULT 0 NOT NULL,
	"seals_sampled" integer DEFAULT 0 NOT NULL,
	"events_hashed" integer DEFAULT 0 NOT NULL,
	"mismatches" integer DEFAULT 0 NOT NULL,
	"backup_cross_reference" text DEFAULT 'unavailable_no_backup_reader' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_integrity_run_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "audit_integrity_run_kind_chk" CHECK ("kind" IN ('sample', 'seal')),
	CONSTRAINT "audit_integrity_run_result_chk" CHECK ("result" IN ('match', 'mismatch', 'skipped', 'error'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_integrity_run_org_finished_idx"
	ON "audit_integrity_run" ("organization_id", "finished_at" DESC);--> statement-breakpoint

ALTER TABLE "audit_integrity_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_integrity_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "audit_integrity_run_org" ON "audit_integrity_run"
    FOR ALL TO wardenx_app
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Append-only for the app role, like audit_seal.
GRANT INSERT, SELECT ON "audit_integrity_run" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "audit_integrity_run" TO wardenx_admin;--> statement-breakpoint

DROP TRIGGER IF EXISTS "audit_integrity_run_audit" ON audit_integrity_run;--> statement-breakpoint
CREATE TRIGGER "audit_integrity_run_audit" AFTER INSERT OR UPDATE OR DELETE ON audit_integrity_run
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
