-- M1 Foundation §3.3 — close the structural RLS holes the 0215–0226 migrations reopened.
--
-- Found by the live structural gates in rls-isolation.live.test.ts ("every RLS table is FORCEd" and
-- "EVERY table carrying organization_id has RLS enabled"), which walk pg_class rather than migration
-- text. 0118 FORCEd every table that had RLS on AT THAT TIME and 0120 closed the last org-scoped table
-- without RLS; neither is retroactive, so each later migration must carry its own FORCE. These did not.
--
-- ── HOLE 1: RLS ENABLED but not FORCED (8 tables) ────────────────────────────────────────────────────
--   0215 referral_activity, referral_note                              (M6 referral, org-scoped PHI)
--   0220 admission_evidence                                           (M6 admission, org-scoped PHI)
--   0222 hope_assessment_answer                                       (M10, org-scoped PHI)
--   0222 hope_spec_version, hope_spec_item, hope_spec_item_isc,
--        hope_spec_item_option                                         (M10 CMS spec reference data)
-- ENABLE does not bind the table OWNER. If the migrator ever runs as `wardenx_app` (scripts/db/migrate.ts
-- falls back to DATABASE_URL), the app role owns these tables and silently bypasses every policy — and
-- ownership is not BYPASSRLS, so the boot guard cannot see it (the 0118 HOLE 1 rationale, verbatim).
-- The four hope_spec_* tables carry no organization_id — they are global CMS reference data read via a
-- `USING (true)` SELECT policy — but they are still FORCEd: 0118's invariant is "every RLS table is
-- FORCEd", and FORCE on a global-read table costs nothing (the read policy still admits every tenant).
--
-- ── HOLE 2: org-scoped table with NO RLS at all (1 table) ────────────────────────────────────────────
--   0226 hope_submission_result_event — organization_id NOT NULL, created with no ENABLE, no policy and
--   no grants. The iQIES Final Validation Report import (hope-route-service-db.ts) inserts a row per CMS
--   result under withOrgContext as `wardenx_app`, carrying the CMS message/raw_result for a named
--   patient's HOPE record — tenant data by any reading, so the NON_ORG_SCOPED opt-out does not apply.
--   Without a grant the import cannot write it at all; with a grant and no RLS, every tenant could read
--   every other tenant's CMS results. Both are fixed together here.
-- Policy shape mirrors the parent `hope_submission` (0035): one FOR ALL policy keyed ONLY on
-- `current_setting('app.org_id', true)` (ADR-0010 D2). Grants are SELECT + INSERT only: a result event is
-- an append-only record of what CMS returned (the import uses ON CONFLICT DO NOTHING and never updates),
-- so no UPDATE/DELETE grant is issued — a re-import appends, it never rewrites history.

-- 1. FORCE on the eight RLS-enabled-but-unforced tables.
ALTER TABLE "referral_activity" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "referral_note" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admission_evidence" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hope_assessment_answer" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hope_spec_version" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hope_spec_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hope_spec_item_isc" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hope_spec_item_option" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- 2. hope_submission_result_event: RLS + FORCE + org policy + least-privilege grants.
ALTER TABLE "hope_submission_result_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hope_submission_result_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "hope_submission_result_event_org" ON "hope_submission_result_event";--> statement-breakpoint
CREATE POLICY "hope_submission_result_event_org" ON "hope_submission_result_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "hope_submission_result_event" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "hope_submission_result_event" TO wardenx_admin;
