-- compat: contract
-- (A UNIQUE index can fail to build over existing duplicate rows, so this is declared `contract` and a failed deploy halts for an operator.)
-- ADR-0107 D6 - one uploaded signed copy belongs to at most one signature request. The attach path reads "is this upload already taken"
-- and then links it; two concurrent attaches of the same upload (to the NPP and the Consent to Treat requests) could both pass that read.
-- The index was a plain partial index from 1304; it becomes UNIQUE with the same name and predicate, so the loser of the race fails instead.
DROP INDEX IF EXISTS "portal_signature_request_upload_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "portal_signature_request_upload_idx"
  ON "portal_signature_request" ("uploaded_document_upload_id")
  WHERE "uploaded_document_upload_id" IS NOT NULL;
