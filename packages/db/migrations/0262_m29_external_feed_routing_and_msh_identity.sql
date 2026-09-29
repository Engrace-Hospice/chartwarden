-- F-181 (#248) — M29 outbound: the two schema gaps F-175's `feed-resolver.ts` documented.
--
-- (1) ROUTING. `external_feed` had no column linking a feed to the lab destination it delivers to, so the
--     outbound resolver could only ask "is there exactly one active orm_outbound feed for this org" and had
--     to ignore `OrmRequestedPayload.labDestinationFacilityId`. `lab_destination_facility_id` is that link —
--     a LOGICAL M40 Facility id (architecture §25.15: no DB FK crosses a module edge), nullable because an
--     inbound-listener row has no destination and a pre-existing single-feed tenant has not set one.
-- (2) MSH IDENTITY. `orm-o01`'s MSH-3/4/5/6 had no backing columns, so three of the four fell back to the
--     feed's `display_name` — an operator label, not a validated HL7 identifier. Four dedicated nullable
--     columns replace the fallback; the worker REFUSES a send when a required one is absent rather than
--     fabricating it. Each is CHECK-constrained to a value that cannot break HL7 segment framing (no field /
--     component / repetition / escape / subcomponent delimiter, no control characters) and to a sane length.
--
-- Additive-only: every column is nullable with no default, so existing rows and inserts are unaffected.
-- RLS, the FORCE sweep and the M4 write-audit trigger already cover the table (0148 / 0118).
ALTER TABLE "external_feed"
  ADD COLUMN IF NOT EXISTS "lab_destination_facility_id" uuid,
  ADD COLUMN IF NOT EXISTS "msh_sending_application" text,
  ADD COLUMN IF NOT EXISTS "msh_sending_facility" text,
  ADD COLUMN IF NOT EXISTS "msh_receiving_application" text,
  ADD COLUMN IF NOT EXISTS "msh_receiving_facility" text;--> statement-breakpoint

ALTER TABLE "external_feed"
  ADD CONSTRAINT "external_feed_msh_identity_chk" CHECK (
    ("msh_sending_application"   IS NULL OR (length(btrim("msh_sending_application"))   BETWEEN 1 AND 180 AND "msh_sending_application"   !~ '[|^~\\&[:cntrl:]]'))
    AND ("msh_sending_facility"     IS NULL OR (length(btrim("msh_sending_facility"))     BETWEEN 1 AND 180 AND "msh_sending_facility"     !~ '[|^~\\&[:cntrl:]]'))
    AND ("msh_receiving_application" IS NULL OR (length(btrim("msh_receiving_application")) BETWEEN 1 AND 180 AND "msh_receiving_application" !~ '[|^~\\&[:cntrl:]]'))
    AND ("msh_receiving_facility"   IS NULL OR (length(btrim("msh_receiving_facility"))   BETWEEN 1 AND 180 AND "msh_receiving_facility"   !~ '[|^~\\&[:cntrl:]]'))
  );--> statement-breakpoint

-- The resolver's routing read: an org's outbound feeds for one destination.
CREATE INDEX IF NOT EXISTS "idx_external_feed_org_dest_facility"
  ON "external_feed" ("organization_id", "lab_destination_facility_id")
  WHERE "lab_destination_facility_id" IS NOT NULL;
