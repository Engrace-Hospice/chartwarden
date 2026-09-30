-- F-212 (#252) — M23: make `sequestration_policy` a TENANT-ENTERABLE, append-only, overlap-safe policy timeline.
--
-- `POST /claims/assemble` fails closed with `SEQUESTRATION_POLICY_UNAVAILABLE` unless a policy row covers the claim's service-from
-- date. A forward-dating write path existed (`POST /billing/sequestration-policies`) but (a) it refused any effectiveFrom <= today,
-- so a tenant could never make a policy cover a CURRENT or PAST service date, (b) the table had no supersede semantics (a mis-keyed
-- row could only be "corrected" by editing it: the app role held UPDATE on every column), (c) nothing prevented two rows covering the
-- same date, and (d) the percentage was unconstrained free text.
--
-- This migration keeps the existing table and adds (mirroring F-210's `hospice_rate_table`, migration 0279):
--   * `superseded_at` / `superseded_by_id` — a correction SUPERSEDES a row; a superseded row stays readable as history.
--   * a race-safe EXCLUDE (btree_gist): two LIVE (non-superseded) rows for one provider entity can never overlap in date.
--   * plausibility CHECKs: percentage is a decimal string in [0, 2] (the Medicare FFS sequestration cap; 0 = the CARES-Act
--     moratorium, 1 = the Apr-Jun 2022 step-down), effective_from not before 2013-04-01 (first sequestered payments), period order.
--   * column-level UPDATE GRANT (only `effective_to`, `superseded_at`, `superseded_by_id`) + a guard trigger: the percentage,
--     start date, actor and reason are immutable; `effective_to` may only CLOSE an open period (NULL -> date), never re-open or move
--     one; a superseded row is frozen; DELETE is destruction-role only (org erasure, unchanged).
--
-- LEGACY DATA. Rows written by the old forward-date path close the predecessor's `effective_to` ON the successor's `effective_from`
-- (a one-day inclusive overlap that the new EXCLUDE would reject). Step 1 repairs exactly that pattern (predecessor ends the day
-- BEFORE), step 2 supersedes any remaining older row that still overlaps a later one (newest wins, as the old lookup did), so the
-- constraints can be created on real data instead of failing the migration. Both run before the guard trigger exists.
-- Not PHI. Org-scoped, RLS already ENABLED + FORCED. Idempotent.

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

ALTER TABLE "sequestration_policy"
  ADD COLUMN IF NOT EXISTS "superseded_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "superseded_by_id" uuid;--> statement-breakpoint

-- (1) repair the old forward-date pattern: predecessor.effective_to == successor.effective_from  =>  predecessor ends the day before.
UPDATE "sequestration_policy" r
   SET "effective_to" = n."effective_from" - 1
  FROM "sequestration_policy" n
 WHERE r."organization_id" = n."organization_id"
   AND r."provider_entity_id" = n."provider_entity_id"
   AND r."id" <> n."id"
   AND r."superseded_at" IS NULL
   AND r."effective_to" IS NOT NULL
   AND r."effective_to" = n."effective_from"
   AND r."effective_from" < n."effective_from";--> statement-breakpoint

-- (2) any older row that STILL overlaps a later one is superseded by the newest overlapping successor.
UPDATE "sequestration_policy" r
   SET "superseded_at" = now(),
       "superseded_by_id" = (
         SELECT n."id" FROM "sequestration_policy" n
          WHERE n."organization_id" = r."organization_id"
            AND n."provider_entity_id" = r."provider_entity_id"
            AND n."id" <> r."id"
            AND (n."effective_from", n."created_at", n."id") > (r."effective_from", r."created_at", r."id")
            AND daterange(n."effective_from", n."effective_to", '[]') && daterange(r."effective_from", r."effective_to", '[]')
          ORDER BY n."effective_from" DESC, n."created_at" DESC, n."id" DESC
          LIMIT 1)
 WHERE r."superseded_at" IS NULL
   AND EXISTS (
         SELECT 1 FROM "sequestration_policy" n
          WHERE n."organization_id" = r."organization_id"
            AND n."provider_entity_id" = r."provider_entity_id"
            AND n."id" <> r."id"
            AND (n."effective_from", n."created_at", n."id") > (r."effective_from", r."created_at", r."id")
            AND daterange(n."effective_from", n."effective_to", '[]') && daterange(r."effective_from", r."effective_to", '[]'));--> statement-breakpoint

ALTER TABLE "sequestration_policy" DROP CONSTRAINT IF EXISTS "sequestration_policy_superseded_chk";--> statement-breakpoint
ALTER TABLE "sequestration_policy" ADD CONSTRAINT "sequestration_policy_superseded_chk"
  CHECK (("superseded_at" IS NULL) = ("superseded_by_id" IS NULL));--> statement-breakpoint

-- NOT VALID: enforced for every new/changed row without re-scanning (and failing on) any legacy row.
ALTER TABLE "sequestration_policy" DROP CONSTRAINT IF EXISTS "sequestration_policy_period_chk";--> statement-breakpoint
ALTER TABLE "sequestration_policy" ADD CONSTRAINT "sequestration_policy_period_chk"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from") NOT VALID;--> statement-breakpoint

ALTER TABLE "sequestration_policy" DROP CONSTRAINT IF EXISTS "sequestration_policy_start_chk";--> statement-breakpoint
ALTER TABLE "sequestration_policy" ADD CONSTRAINT "sequestration_policy_start_chk"
  CHECK ("effective_from" >= DATE '2013-04-01') NOT VALID;--> statement-breakpoint

-- The Medicare FFS sequestration reduction is statutorily capped at 2%; 0 is legitimate (2020-05-01..2022-03-31 moratorium).
-- Text-typed on purpose (D11: never a float); the regex keeps the cast safe.
ALTER TABLE "sequestration_policy" DROP CONSTRAINT IF EXISTS "sequestration_policy_percentage_chk";--> statement-breakpoint
ALTER TABLE "sequestration_policy" ADD CONSTRAINT "sequestration_policy_percentage_chk"
  CHECK (CASE WHEN "percentage" ~ '^[0-9](\.[0-9]{1,4})?$' THEN "percentage"::numeric BETWEEN 0 AND 2 ELSE false END) NOT VALID;--> statement-breakpoint

ALTER TABLE "sequestration_policy" DROP CONSTRAINT IF EXISTS "sequestration_policy_no_overlap";--> statement-breakpoint
ALTER TABLE "sequestration_policy" ADD CONSTRAINT "sequestration_policy_no_overlap" EXCLUDE USING gist (
  "organization_id" WITH =, "provider_entity_id" WITH =,
  daterange("effective_from", "effective_to", '[]') WITH &&
) WHERE ("superseded_at" IS NULL);--> statement-breakpoint

-- Column-level UPDATE: the app can close an open period and stamp the supersede columns, and nothing else.
REVOKE UPDATE ON "sequestration_policy" FROM wardenx_app;--> statement-breakpoint
GRANT UPDATE ("effective_to", "superseded_at", "superseded_by_id") ON "sequestration_policy" TO wardenx_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION sequestration_policy_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only a NON-superuser member of the destruction role: a superuser is implicitly a member of every role.
    IF pg_has_role(current_user, 'wardenx_destruction', 'MEMBER')
       AND NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'sequestration_policy cannot be deleted (only the destruction role may erase it)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'sequestration_policy row is superseded and immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.provider_entity_id <> OLD.provider_entity_id
     OR NEW.percentage <> OLD.percentage
     OR NEW.effective_from <> OLD.effective_from
     OR NEW.set_by_membership_id <> OLD.set_by_membership_id
     OR NEW.set_reason IS DISTINCT FROM OLD.set_reason
     OR NEW.created_at <> OLD.created_at
     -- an open period may be CLOSED (NULL -> date); a closed period is never moved or re-opened.
     OR (OLD.effective_to IS NOT NULL AND NEW.effective_to IS DISTINCT FROM OLD.effective_to) THEN
    RAISE EXCEPTION 'sequestration_policy is append-only; supersede the row instead of editing it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_sequestration_policy_guard" ON "sequestration_policy";--> statement-breakpoint
CREATE TRIGGER "trg_sequestration_policy_guard"
  BEFORE UPDATE OR DELETE ON "sequestration_policy"
  FOR EACH ROW EXECUTE FUNCTION sequestration_policy_guard();--> statement-breakpoint

-- The old "one open row per (provider entity, start)" unique index must ignore SUPERSEDED rows, or a same-start open correction
-- (the commonest fix: right start date, wrong percentage) could never be inserted beside the row it supersedes.
DROP INDEX IF EXISTS "sequestration_policy_active_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sequestration_policy_active_uq"
  ON "sequestration_policy" ("provider_entity_id", "effective_from") WHERE effective_to IS NULL AND superseded_at IS NULL;--> statement-breakpoint

-- Lookup index for the live-row date lookups.
CREATE INDEX IF NOT EXISTS "sequestration_policy_live_lookup_idx"
  ON "sequestration_policy" ("organization_id", "provider_entity_id", "effective_from" DESC) WHERE "superseded_at" IS NULL;--> statement-breakpoint

-- The already-registered keys' catalog mirror rows + the full-catalog admin roles' grants (0273/0279's pattern), so an existing
-- tenant has someone who can enter the policy before the catalog sync next runs. No other role is granted anything on purpose.
INSERT INTO "permission" ("key", "resource", "action", "category", "default_abac", "description") VALUES
  ('billing.sequestration_policy.read', 'billing_sequestration_policy', 'read', 'billing', 'provider_entity_billing_scope', ''),
  ('billing.sequestration_policy.edit', 'billing_sequestration_policy', 'edit', 'billing', 'provider_entity_billing_scope', '')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO "role_permission" ("organization_id", "role_id", "permission_key")
SELECT r."organization_id", r."id", p."key"
  FROM "role" r
 CROSS JOIN (VALUES ('billing.sequestration_policy.read'), ('billing.sequestration_policy.edit')) AS p("key")
 WHERE r."key" IN ('administrator', 'org_admin')
   AND r."organization_id" IS NOT NULL
ON CONFLICT ("role_id", "permission_key") DO NOTHING;
