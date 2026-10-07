-- M6 — `election_addendum`: a SCANNED, wet-signed paper copy as the 42 CFR 418.24(c)(9) acknowledgement of
-- receipt. Patients often sign the paper addendum handed to them at the bedside; staff scan it into M22 and attach
-- it here instead of (or in addition to) keying the signature. The scanned document is linked in its OWN columns:
-- `document_id` stays the rendered (c)(10) PDF M22 stamps through the `m22.document.rendered` back-ref.
--
--   acknowledgement_source               'structured' (keyed in WardenX) | 'uploaded' (scanned signed copy);
--                                        set only on a settled acknowledgement (signed / refused)
--   acknowledgement_document_id          M22 document of the scanned copy (app-validated, no cross-module FK —
--   acknowledgement_document_version_id  the same convention as `admission_evidence.document_id`, mig 0220)
--
-- Not PHI (an enum + two uuids), so the 0381 audit trigger's denylist is unchanged: the new columns appear in the
-- write audit's before/after images. The table-level GRANT SELECT, INSERT, UPDATE (0381) already covers them for
-- wardenx_app; RLS is the table's FORCEd org policy. Idempotent.
DO $$ BEGIN
  CREATE TYPE "public"."election_addendum_acknowledgement_source" AS ENUM('structured', 'uploaded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "election_addendum"
  ADD COLUMN IF NOT EXISTS "acknowledgement_source" "election_addendum_acknowledgement_source";--> statement-breakpoint
ALTER TABLE "election_addendum" ADD COLUMN IF NOT EXISTS "acknowledgement_document_id" uuid;--> statement-breakpoint
ALTER TABLE "election_addendum" ADD COLUMN IF NOT EXISTS "acknowledgement_document_version_id" uuid;--> statement-breakpoint

-- Every signature / refusal recorded before this migration was keyed in WardenX.
UPDATE "election_addendum" SET "acknowledgement_source" = 'structured'
  WHERE "status" IN ('signed', 'refused') AND "acknowledgement_source" IS NULL;--> statement-breakpoint

-- (c)(9) shape: an uploaded acknowledgement carries the exact scanned document version; a structured one carries
-- none; and the source is only ever set on a signed or refused version.
DO $$ BEGIN
  ALTER TABLE "election_addendum" ADD CONSTRAINT "election_addendum_ack_source_shape_chk" CHECK (
    ("acknowledgement_source" IS NULL OR "status" IN ('signed', 'refused'))
    AND ("acknowledgement_source" IS DISTINCT FROM 'uploaded'
      OR ("acknowledgement_document_id" IS NOT NULL AND "acknowledgement_document_version_id" IS NOT NULL))
    AND ("acknowledgement_source" = 'uploaded'
      OR ("acknowledgement_document_id" IS NULL AND "acknowledgement_document_version_id" IS NULL))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

COMMENT ON COLUMN "election_addendum"."acknowledgement_source" IS
  '42 CFR 418.24(c)(9): structured = signature/refusal keyed in WardenX; uploaded = scanned signed paper copy (acknowledgement_document_*). NULL until acknowledged.';
