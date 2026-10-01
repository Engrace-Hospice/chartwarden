-- F-225 (#248) — `document_access_log` (M22 §3.3) becomes able to account a PORTAL document disclosure
-- (HIPAA §164.528), and becomes genuinely APPEND-ONLY for the app role.
--
-- (1) The table was written for STAFF accessors only: `accessor_membership_id` NOT NULL, no patient id
--     and no portal identity. A portal session has no membership (M2: `attributes.membershipId` is null on
--     a portal session), so the portal mint could not be recorded without inventing a membership.
--       + accessor_portal_account_id  — the M31 portal account (logical FK, like every cross-module id here)
--       + portal_session_id           — the M2 session the access ran under
--       + patient_id                  — whose record was disclosed (a per-patient accounting scan cannot
--                                       be answered by joining through `document` once a doc is tombstoned)
--       ~ accessor_membership_id      — nullable; CHECK: EXACTLY ONE of membership / portal account is set.
--     Ids only — no PHI, no free text. (ADD COLUMN / ALTER on the partitioned parent propagates to every
--     monthly partition + the DEFAULT partition.)
-- (2) 0049 granted wardenx_app `SELECT, INSERT, UPDATE`, contradicting the table's own contract ("the log is
--     append-only and never cascade-deleted", M22 lifecycle/access-log.ts; D12 / ADR-0013). Nothing in the
--     codebase updates it, so UPDATE is revoked; DELETE was never granted. Retention erasure runs as the
--     admin role (`wardenx_admin` keeps ALL).
-- Idempotent (IF NOT EXISTS / catalog guards).
ALTER TABLE "document_access_log" ADD COLUMN IF NOT EXISTS "accessor_portal_account_id" uuid;--> statement-breakpoint
ALTER TABLE "document_access_log" ADD COLUMN IF NOT EXISTS "portal_session_id" uuid;--> statement-breakpoint
ALTER TABLE "document_access_log" ADD COLUMN IF NOT EXISTS "patient_id" uuid;--> statement-breakpoint
ALTER TABLE "document_access_log" ALTER COLUMN "accessor_membership_id" DROP NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'document_access_log_one_accessor'
  ) THEN
    ALTER TABLE "document_access_log"
      ADD CONSTRAINT "document_access_log_one_accessor"
      CHECK (num_nonnulls("accessor_membership_id", "accessor_portal_account_id") = 1);
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "doc_access_log_patient_idx"
  ON "document_access_log" USING btree ("organization_id", "patient_id", "accessed_at" DESC NULLS LAST);--> statement-breakpoint
REVOKE UPDATE ON "document_access_log" FROM wardenx_app;
