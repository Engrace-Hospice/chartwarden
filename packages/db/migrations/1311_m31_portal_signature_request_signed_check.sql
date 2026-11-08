-- compat: contract
-- (A tightened CHECK can fail to validate over existing rows, so this is declared `contract` and a failed deploy halts for an operator.)
-- ADR-0107 D6 - 1308 widened the signed CHECK so staff ACCEPTING an uploaded copy can sign a request without portal signer evidence, but
-- its accepted branch then asked only for the review itself. An accepted row could be `signed` with no signer role, no grant kind and no
-- record it signed into, so the database could not prove a signed request is tied to its M39 consent. The accepted branch now requires
-- all three, which the accept path always writes; the portal-signed branch is unchanged.
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
        AND "signer_grant_kind" IS NOT NULL AND "signer_role" IS NOT NULL AND "target_ref" IS NOT NULL
      )
    )
  )
);
