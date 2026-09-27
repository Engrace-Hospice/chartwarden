-- #138 / F-060 / F-116 — the M33 "day-one dashboards" differentiator, built. A newly provisioned
-- org gets one system-authored `report_definition` (+ published version + an org-shared `report_view`)
-- per currently-ACTIVE report base, seeded at the first membership's invitation-accept (the earliest
-- point an owner membership exists — `report_view.owner_membership_id` is NOT NULL, and no membership
-- exists yet at the M34 `tenant.provision` job that runs before it).
--
-- This partial unique index is the idempotency guard: the seeder is invoked on EVERY accepted
-- invitation for an org (cheap after the first — a few no-op inserts), and two admins racing to accept
-- the first two invitations for a brand-new org must not each mint their own copy of the same system
-- dashboard. `.onConflictDoNothing()` against this index (the `elevated-approvals.ts` grant() precedent)
-- makes a concurrent second seeder attempt a genuine no-op rather than a duplicate row.
--
-- A TENANT-authored definition on the same base is unaffected: the index only applies
-- `WHERE authorship = 'system'`, so a tenant is free to author their own definition over
-- `census_org_daily` alongside the platform-shipped one.
CREATE UNIQUE INDEX "report_definition_system_org_base_uq"
  ON "report_definition" ("organization_id", "base_key")
  WHERE "authorship" = 'system';
