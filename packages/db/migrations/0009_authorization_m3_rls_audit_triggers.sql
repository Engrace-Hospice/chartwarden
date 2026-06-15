-- M3 Authorization §3.6 — RLS, GRANT model, and baseline write-audit triggers for the
-- five org-scoped Module 3 tables created in 0008 (`role`, `role_permission`,
-- `membership_role`, `break_glass_event`, `auditor_engagement`). Runs after the
-- Drizzle-generated table DDL, the same two-phase shape M1 (0001) and M2 (0006) use.
-- `permission` is the platform-global, read-only catalog mirror (NON_ORG_SCOPED) — it
-- carries no organization_id and gets SELECT-only access, not RLS.
--
-- AUTHORITY NOTE (architecture > module spec). Spec §3.7 calls a `wardenx_enable_rls()`
-- helper; M1/M2 never shipped such a generator — they hand-write the CREATE POLICY shape
-- (0001/0006). This migration follows that established, gate-checked shape. Per ADR-0010 D2
-- the ONLY session variable any policy keys on is `app.org_id` (check-tenancy.ts rule 2);
-- ProviderEntity/Location/caseload and the auditor-engagement and cross-tenant break-glass
-- read narrowing are RBAC/ABAC at the app layer (M3-T06/T08), NEVER pushed into RLS
-- (architecture line 220 / spec §3.6).
--
-- BASELINE TRIGGERS (Wave-A interplay note 2 / M4-T10). These reuse M1's
-- wardenx_audit_trigger() (0004). M4 owns the canonical write-audit trigger generator and
-- back-fills these org-scoped tables through it (denylist scrubbing) in M4-T10.

-- Append-only GRANT model ---------------------------------------------------
-- wardenx_app gets full DML on the five org-scoped tables (subject to RLS below).
-- `permission` is a read-only mirror, refreshed from the code catalog on deploy via the
-- platform context (wardenx_admin) — wardenx_app may only SELECT it (spec §3.7).
GRANT INSERT, SELECT, UPDATE, DELETE ON
  "role", "role_permission", "membership_role", "break_glass_event", "auditor_engagement"
TO wardenx_app;--> statement-breakpoint
GRANT SELECT ON "permission" TO wardenx_app;--> statement-breakpoint

-- Row-Level Security --------------------------------------------------------
ALTER TABLE "role" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "role_permission" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "membership_role" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "break_glass_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auditor_engagement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- role / role_permission carry a NULLABLE organization_id (NULL = platform template).
-- The writable policy never admits a NULL org, so a tenant context can neither create nor
-- mutate a platform template (templates are managed only through the platform context).
-- The org-NULL READ exception (templates readable by every tenant) is a SELECT-only policy
-- isolated in migration 0010 — kept out of this file so check-tenancy.ts rule 3a can
-- confirm the NULL branch never co-resides with a tenant-writable policy (the 0002 shape).
CREATE POLICY "role_org" ON "role"
  FOR ALL TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "role_permission_org" ON "role_permission"
  FOR ALL TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- membership_role belongs to exactly one org (NOT NULL) — standard tenant isolation.
CREATE POLICY "membership_role_org" ON "membership_role"
  FOR ALL TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- break_glass_event: org-scoped on the actor's organization_id. The cross-tenant read
-- nuance (target_organization_id set → platform context + target tenant Compliance Officer)
-- is ABAC at the app layer (spec §3.6), not an RLS branch.
CREATE POLICY "break_glass_event_org" ON "break_glass_event"
  FOR ALL TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- auditor_engagement: standard org isolation. An auditor SESSION reads only its own
-- engagement's in-scope rows — enforced by the ABAC `engagement_scope` predicate (§3.6),
-- not by RLS, which scopes the organization boundary only.
CREATE POLICY "auditor_engagement_org" ON "auditor_engagement"
  FOR ALL TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- Baseline write-audit triggers ---------------------------------------------
-- Attach M1's wardenx_audit_trigger() to every org-scoped M3 table so role/permission and
-- emergency-access/engagement mutations are captured into audit_event. M4-T10 normalizes
-- these to the canonical generator (column-level denylist scrubbing).
CREATE TRIGGER "role_audit" AFTER INSERT OR UPDATE OR DELETE ON role
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "role_permission_audit" AFTER INSERT OR UPDATE OR DELETE ON role_permission
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "membership_role_audit" AFTER INSERT OR UPDATE OR DELETE ON membership_role
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "break_glass_event_audit" AFTER INSERT OR UPDATE OR DELETE ON break_glass_event
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "auditor_engagement_audit" AFTER INSERT OR UPDATE OR DELETE ON auditor_engagement
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
-- permission is the platform-global catalog mirror (no RLS). Its rows are (re)written only
-- in the platform context (wardenx_admin) on deploy; auditing those catalog refreshes is
-- the same treatment platform/reference tables already get (system_status,
-- organization_settings_registry). The trigger attributes via the app.org_id session var
-- (NULL for a platform refresh — a platform-scoped audit event).
CREATE TRIGGER "permission_audit" AFTER INSERT OR UPDATE OR DELETE ON permission
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();
