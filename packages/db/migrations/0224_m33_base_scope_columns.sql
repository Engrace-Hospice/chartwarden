-- M33 §4.7 D8 (F-059) — declare, per report base, which MV column the `reportable_scope` envelope
-- narrows on.
--
-- The scope injector used two file-level constants, `membership_id` and `location_id`, documented as
-- "platform-fixed structural columns of the MV wrapper". No MV this platform ships has either column:
-- `mv_encounter_productivity_membership_day` names its one `authored_by_membership_id`, and
-- `mv_census_org_daily` / `mv_evv_compliance_org_week` are org-grain and have no member column at all.
-- Every `self` / `team` / `location` read would therefore have failed with `column t.membership_id does
-- not exist`. It never did, because no read path ever passed a narrowing envelope — all four built their
-- own with `scopeKind: 'org'`, the one arm that emits no predicate.
--
-- Which column carries the scope is a property of the MV, so it belongs beside the MV binding. NULL means
-- "this base has no column of that kind": a narrowing scope on it compiles to FALSE (deny), which is the
-- same fail-closed rule the empty-id-list case already took, one level up.
ALTER TABLE "report_base_catalog"
  ADD COLUMN IF NOT EXISTS "scope_membership_column" text,
  ADD COLUMN IF NOT EXISTS "scope_location_column" text;--> statement-breakpoint

COMMENT ON COLUMN "report_base_catalog"."scope_membership_column" IS
  'MV column carrying the authoring/owning membership id, narrowed on by reportable_scope self/team (M33 §4.7 D8). NULL = org-grain base; a narrowing scope denies.';--> statement-breakpoint
COMMENT ON COLUMN "report_base_catalog"."scope_location_column" IS
  'MV column carrying the location id, narrowed on by reportable_scope location (M33 §4.7 D8). NULL = base has no location grain; a location scope denies.';--> statement-breakpoint

-- The one base of the three seeded in 0061 that HAS a member grain. Census and EVV stay NULL on purpose:
-- an org-wide daily census cannot be narrowed to one clinician, and pretending otherwise would either
-- fabricate a column or serve the whole org to a self-scoped reader.
UPDATE "report_base_catalog"
   SET "scope_membership_column" = 'authored_by_membership_id'
 WHERE "base_key" = 'encounter_productivity_membership_day';
