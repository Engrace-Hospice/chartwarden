-- GAP-043 — M2 Identity §3.7: the per-tenant, per-membership NAMED APPROVAL AUTHORITY registry.
--
-- WHAT WAS BROKEN. M27's §4.7 `cost_report_approver_for_provider` predicate is specified as three
-- independent conjuncts: the membership holds `cost_report.approve_for_submit` (M3 RBAC, enforced at the
-- route), is in scope for the report's ProviderEntity (M40 provider scope), AND carries the per-tenant
-- elevated-approval designation. The third had no table, no column and no seam anywhere in the system, so
-- `buildDrizzleM27AbacResolver` — the resolver that boots in every deployment with a database — hardcoded
-- `async hasElevatedApproval() { return false; }` with the honest comment "a real read here would fabricate
-- a fact M27 cannot resolve". The predicate's last line calls it unconditionally, so the guard denied every
-- caller: override_validation / approve_for_submit / submit / submit_past_deadline / reopen_submitted were
-- ALL unreachable in every tenant, and the CMS-1984-14 filing workflow the module exists for had no end
-- state. M27's own test suite substitutes a permissive stub and says so in a comment — the clearest
-- possible signal that the production path was the one that never worked.
--
-- WHY NOT JUST USE THE PERMISSION. A permission travels with whatever role carries it, so a tenant that
-- grants `cost_report.approve_for_submit` to a broad finance role would silently make every member of that
-- role a signatory. Certifying a cost report is a named-officer act under 42 CFR §413.24 — the tenant names
-- the individuals, and that naming must be its own auditable record with a granter, a reason, and a
-- revocation trail. Collapsing the third conjunct into the first would delete a control the spec states.
--
-- WHY M2 OWNS IT. The subject is a MEMBERSHIP, not a cost report. M27 reads it through the
-- `ElevatedApprovalReader` seam and never touches the table (`arch:tables` would refuse it: only the narrow
-- identity cohort — organization/membership/user/session/role/membership_role — is exempt for direct
-- cross-module reads, and a new table does not join that list by being convenient).
--
-- SHAPE follows `membership_credential` (migration 0191, GAP-093) — the repo's existing per-membership
-- named-grant table: one LIVE row per (membership, kind) via a partial unique index, revoked rows retained
-- in place as the trail rather than deleted. STAFF-scoped, so `organization_id` only (the ARCH-011
-- three-column rule scopes PHI-bearing tables). The grant is org-wide on purpose: per-ProviderEntity
-- narrowing is the SEPARATE scope conjunct in the predicate, and duplicating it here would let the two
-- disagree.
CREATE TYPE "public"."elevated_approval_kind" AS ENUM('cost_report_approval');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "membership_elevated_approval" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "approval_kind" "elevated_approval_kind" NOT NULL,
  "granted_by_membership_id" uuid NOT NULL,
  "granted_at" timestamptz DEFAULT now() NOT NULL,
  "grant_reason" text NOT NULL,
  "revoked_at" timestamptz,
  "revoked_by_membership_id" uuid,
  "revoked_reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "membership_elevated_approval_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE restrict,
  CONSTRAINT "membership_elevated_approval_membership_fk"
    FOREIGN KEY ("membership_id") REFERENCES "membership"("id") ON DELETE cascade,
  CONSTRAINT "membership_elevated_approval_granted_by_fk"
    FOREIGN KEY ("granted_by_membership_id") REFERENCES "membership"("id"),
  CONSTRAINT "membership_elevated_approval_revoked_by_fk"
    FOREIGN KEY ("revoked_by_membership_id") REFERENCES "membership"("id"),
  -- A revocation is all-or-nothing: instant, actor and reason together or none of them. A row reading
  -- "revoked, by nobody, for no reason" is the shape that makes an authority trail useless — the same
  -- invariant migration 0200 enforces on the unmatched-lab queue's exit.
  CONSTRAINT "membership_elevated_approval_revocation_consistent" CHECK (
    ("revoked_at" IS NULL AND "revoked_by_membership_id" IS NULL AND "revoked_reason" IS NULL)
    OR ("revoked_at" IS NOT NULL AND "revoked_by_membership_id" IS NOT NULL
        AND "revoked_reason" IS NOT NULL AND length(btrim("revoked_reason")) >= 10)
  ),
  -- The granter must say why. A designation with an empty rationale cannot be reviewed by a surveyor.
  CONSTRAINT "membership_elevated_approval_grant_reason_required" CHECK (
    length(btrim("grant_reason")) >= 10
  )
);--> statement-breakpoint
-- At most one LIVE grant per (membership, kind). Re-granting after a revoke inserts a NEW row, so the
-- history reads as a sequence of designations rather than one mutated flag.
CREATE UNIQUE INDEX IF NOT EXISTS "membership_elevated_approval_live_uq"
  ON "membership_elevated_approval" ("organization_id", "membership_id", "approval_kind")
  WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "membership_elevated_approval_live_lookup_idx"
  ON "membership_elevated_approval" ("organization_id", "membership_id", "approval_kind")
  WHERE "revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "membership_elevated_approval" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "membership_elevated_approval" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "membership_elevated_approval_org" ON "membership_elevated_approval";--> statement-breakpoint
CREATE POLICY "membership_elevated_approval_org" ON "membership_elevated_approval"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- No DELETE grant: a designation is revoked, never erased. The revoked row IS the evidence that the
-- authority once existed, which is exactly what a cost-report survey asks about.
GRANT SELECT, INSERT, UPDATE ON "membership_elevated_approval" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "membership_elevated_approval" TO wardenx_admin;--> statement-breakpoint
CREATE TRIGGER "membership_elevated_approval_audit"
  AFTER INSERT OR UPDATE OR DELETE ON membership_elevated_approval
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
