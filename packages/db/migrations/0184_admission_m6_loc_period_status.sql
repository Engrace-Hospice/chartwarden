-- M6 Admission — level_of_care_period confirm-handshake fix (2026-08-05). Persists the §2.3.5 state
-- machine's already-modeled "assigning" (IRC/GIP requested, M37 IPU bed not yet confirmed) vs "active"
-- distinction, which previously had NO column at all — every reader inferred "current" purely from
-- `ended_at IS NULL`, conflating a not-yet-billable request with a confirmed period of care. `status` is
-- kept in sync with `ended_at` at every close (UPDATE ... SET status='ended') so it is always
-- self-describing — never requires a join back to `ended_at` to interpret.
--
-- Backfill: every pre-existing row was written via the pre-fix `changeLoc` path, which hardcoded
-- `facilityId: null` — IRC/GIP transitions therefore always threw IPU_FACILITY_REQUIRED and could never
-- reach the table, so every row that exists today is truthfully either RHC/CHC 'active' (open) or
-- whatever level 'ended' (closed). DEFAULT 'active' backfills every row; the UPDATE below then corrects
-- the closed ones.
CREATE TYPE "public"."level_of_care_period_status" AS ENUM('assigning', 'active', 'ended');--> statement-breakpoint
ALTER TABLE "level_of_care_period"
  ADD COLUMN IF NOT EXISTS "status" "level_of_care_period_status" NOT NULL DEFAULT 'active';--> statement-breakpoint
UPDATE "level_of_care_period" SET "status" = 'ended' WHERE "ended_at" IS NOT NULL;--> statement-breakpoint
COMMENT ON COLUMN "level_of_care_period"."status" IS
  'M6 §2.3.5 persisted lifecycle state (assigning/active/ended) — kept in sync with ended_at at every close. assigning = IRC/GIP requested, M37 bed not yet confirmed; NOT billable (M24 claim assembly excludes it).';
