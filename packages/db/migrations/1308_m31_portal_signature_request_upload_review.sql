-- compat: contract
-- ADR-0107 D6 - staff review of an uploaded signed paper copy.
--   * A request is `signed` either by a portal signer (full portal evidence, as before) or by staff ACCEPTING an uploaded copy: the
--     evidence is then the review itself (reviewer, outcome `accepted`, the upload row), not a typed name and session the signer never had.
--     The two CHECKs below are widened for exactly that case and keep every portal-signed guarantee. Old code keeps writing valid rows, but the CHECK swap is DDL the compat gate treats as contracting, so it is declared `contract` (a failed deploy halts for an operator).
--   * The staff REVIEW permission key, mirrored into the DB catalog (the 1253 / 1306 / 1307 shape). Idempotent.
ALTER TABLE "portal_signature_request" DROP CONSTRAINT "portal_signature_request_signed_chk";--> statement-breakpoint
ALTER TABLE "portal_signature_request" ADD CONSTRAINT "portal_signature_request_signed_chk" CHECK (
  ("status" = 'signed') = (
    "signed_at" IS NOT NULL AND (
      (
        "signed_by_portal_account_id" IS NOT NULL AND "signer_grant_kind" IS NOT NULL AND "signer_role" IS NOT NULL
        AND "signed_typed_name" IS NOT NULL AND "attestation_sha256" IS NOT NULL AND "portal_session_id" IS NOT NULL
        AND "idempotency_key" IS NOT NULL
      ) OR (
        "review_outcome" = 'accepted' AND "reviewed_by" IS NOT NULL AND "reviewed_at" IS NOT NULL
        AND "uploaded_document_upload_id" IS NOT NULL
      )
    )
  )
);--> statement-breakpoint
ALTER TABLE "portal_signature_request" DROP CONSTRAINT "portal_signature_request_on_behalf_chk";--> statement-breakpoint
ALTER TABLE "portal_signature_request" ADD CONSTRAINT "portal_signature_request_on_behalf_chk" CHECK (
  "status" <> 'signed' OR "review_outcome" = 'accepted' OR "signer_role" = 'patient'
  OR ("signer_relationship_text" IS NOT NULL AND ("signer_role" <> 'caregiver_on_behalf' OR "patient_unable_reason" IS NOT NULL))
);--> statement-breakpoint
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('portal.signature_request.review', 'portal_signature_request', 'review', 'admin', 'caseload_membership', '')
ON CONFLICT ("key") DO NOTHING;
