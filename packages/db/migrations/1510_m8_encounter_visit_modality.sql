-- compat: expand
-- M8: how a visit was delivered (in person / telephonic / video) and where its documented time came from.
-- Medicare hospice SIA and the visit lines (CMS Pub. 100-04 ch. 11 §30.3) count in-person visits only, so
-- the encounter has to say so. Nullable on purpose: a NULL modality is "not yet confirmed by the clinician",
-- never "in person". The previous release ignores all four columns, so this is a pure expand.
--
--   visit_modality               seeded from the M17 visit setting (unconfirmed) and confirmed by the signing
--                                clinician; the legacy-confirm route writes the same three columns on an
--                                already-signed row (a deliberate carve-out of the post-sign immutability rule)
--   visit_modality_confirmed_at  the clinician's explicit confirmation instant; NULL = only seeded / unknown
--   visit_modality_confirmed_by  the confirming membership; ON DELETE RESTRICT (like authored_by_membership_id),
--                                never SET NULL: a deleted membership must not silently erase who confirmed
--   time_source                  who supplied started_at/ended_at: the M18 EVV bracket always wins, otherwise the
--                                signing clinician's documented times. NULL = no documented time (never padded)
--
-- Backfill reads ONLY the same row, and never guesses in_person:
--   * encounter_type = 'telephonic' is telephonic by definition (left unconfirmed);
--   * a row with both times has them from EVV (the only writer of started_at/ended_at before this change).
-- No new table, so the existing encounter RLS policy and trg_audit_encounter cover the new columns. Still a pure
-- expand: every new column is nullable and the RESTRICT FK is on a column that is NULL until a clinician confirms.
CREATE TYPE encounter_visit_modality AS ENUM ('in_person', 'telephonic', 'video');--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "visit_modality" encounter_visit_modality;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "visit_modality_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "visit_modality_confirmed_by" uuid REFERENCES "membership"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "encounter" ADD COLUMN "time_source" text CHECK ("time_source" IN ('evv', 'clinician'));--> statement-breakpoint
-- The two backfill UPDATEs below fire trg_audit_encounter once per updated row (write amplification on a large
-- encounter table is accepted for a one-off backfill). A migration is not a user: the audit function (0031) hard-codes
-- actor_kind = 'user' and a migration sets no app.user_id, so these rows carry no actor; this header is the attribution.
UPDATE "encounter" SET "visit_modality" = 'telephonic' WHERE "encounter_type" = 'telephonic';--> statement-breakpoint
UPDATE "encounter" SET "time_source" = 'evv' WHERE "started_at" IS NOT NULL AND "ended_at" IS NOT NULL;--> statement-breakpoint

-- Serves the sign-time overlap check (one author's documented brackets on and around a service date).
CREATE INDEX IF NOT EXISTS "encounter_author_delivered_idx"
  ON "encounter" ("organization_id", "authored_by_membership_id", "service_date")
  WHERE "started_at" IS NOT NULL AND "status" IN ('signed', 'cosign_pending', 'cosigned');
