-- compat: expand
-- #908/#909/#910 review follow-up -- M11:
--  (1) critical_lab_result.observation_at: the observation's CLINICAL instant (M29 observationDatetime). A later
--      non-critical observation supersedes only criticals whose observation is OLDER than it, so a late redelivery of an
--      older non-critical cannot withdraw a newer critical. Nullable: rows from 1297 fall back to received_at.
--  (2) Destruction: critical_lab_result (patient FK is ON DELETE restrict) and order_result_review (append-only trigger,
--      no exception) were never reachable by a destruction certificate, so erasing a patient/order would abort on the
--      first of these rows. Same posture as 0272 (attestation ledger): the destruction role gets SELECT + DELETE and an
--      org-pinned FOR ALL policy; the review's append-only trigger admits a DELETE ONLY from a NON-superuser member of
--      chartwarden_destruction (an UPDATE is refused for everyone; the app role is not widened).
ALTER TABLE "critical_lab_result" ADD COLUMN IF NOT EXISTS "observation_at" timestamp with time zone;--> statement-breakpoint

CREATE OR REPLACE FUNCTION order_result_review_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND pg_has_role(current_user, 'chartwarden_destruction', 'MEMBER')
     AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'order_result_review is append-only (% rejected)', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;--> statement-breakpoint

GRANT SELECT, DELETE ON "critical_lab_result" TO chartwarden_destruction;--> statement-breakpoint
GRANT SELECT, DELETE ON "order_result_review" TO chartwarden_destruction;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "critical_lab_result_destruction" ON "critical_lab_result"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE POLICY "order_result_review_destruction" ON "order_result_review"
    FOR ALL TO chartwarden_destruction
    USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
    WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
