-- M6 — `election_addendum`: a version whose 418.24(c) CONTENT lives on a signed paper copy.
--
-- When a patient signs (or refuses) a paper addendum that was never completed in WardenX, the scanned paper IS the
-- furnished addendum: its (c)(4)–(8) content is on the paper, not in the structured columns. `content_source`
-- records that explicitly instead of overloading `acknowledgement_source` (0395): the two answer different
-- questions — WHERE THE CONTENT IS ((c)(1)–(8), (c)(10)) versus HOW RECEIPT WAS ACKNOWLEDGED ((c)(9)). A complete
-- WardenX addendum acknowledged on a scanned copy is `structured` content + `uploaded` acknowledgement; only an
-- incomplete draft attached on paper is `scanned_paper` content (always with an `uploaded` acknowledgement).
--
--   content_source  'structured' (default; the (c) content is in the columns) | 'scanned_paper'
--
-- Whatever structured fields exist are kept. Not PHI (an enum), so the 0381 audit denylist is unchanged; the
-- table-level grants and FORCEd RLS already cover the column. Idempotent.
DO $$ BEGIN
  CREATE TYPE "public"."election_addendum_content_source" AS ENUM('structured', 'scanned_paper');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "election_addendum" ADD COLUMN IF NOT EXISTS "content_source"
  "election_addendum_content_source" DEFAULT 'structured' NOT NULL;--> statement-breakpoint

-- Content on paper exists only past furnish, and once acknowledged it is the uploaded (scanned) acknowledgement
-- that carries the paper. (`furnished` is the instant inside the furnish-then-acknowledge transaction.)
DO $$ BEGIN
  ALTER TABLE "election_addendum" ADD CONSTRAINT "election_addendum_content_source_shape_chk" CHECK (
    "content_source" = 'structured'
    OR ("status" = 'furnished'
      OR ("status" IN ('signed', 'refused') AND "acknowledgement_source" = 'uploaded'))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

COMMENT ON COLUMN "election_addendum"."content_source" IS
  '42 CFR 418.24(c): structured = the addendum content is in this row; scanned_paper = the authoritative content is the signed paper copy (acknowledgement_document_*).';
