-- M34 SaaS Tenant Platform §3.10 (RLS & Grants) — M34-T03. Locks per-table RLS, policies, and
-- least-privilege grants for the 16 M34 tables, plus the `tenant_key_ring_metadata_v` masking view.
-- Tables/enums/indexes/FKs land in 0051; the tenant_platform_writer role in 0050; the M4 write-audit
-- triggers in 0053; onboarding-template seed in 0054; the DEK-lifecycle SECURITY DEFINER fns in 0055.
--
-- TWO RLS SHAPES (§3.10 M34-F02 / ADR-0010, CANONICAL):
--   • ORG-SCOPED — EVERY tenant-scoped M34 table carries organization_id NOT NULL and uses the CANONICAL
--     predicate `USING/WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid)` — NO
--     subqueries, NO EXISTS(SELECT…), NO pg_has_role(...). Applies to: tenant_account,
--     tenant_account_status_event, onboarding_task, tenant_key_ring, tenant_key_destruction_log,
--     support_consent_grant, support_session, support_session_event, dsar_export_job,
--     dsar_export_job_event, tenant_export_job, tenant_export_job_event, platform_tenant_baa_record.
--     tenant_account is SELECT-only for wardenx_app (INSERT/UPDATE via tenant_platform_writer); the export
--     tables are full-CRUD for the tenant (worker runs under the tenant's withOrgContext, F09).
--     tenant_key_ring ciphertext is NEVER readable to wardenx_app: base-table SELECT is REVOKED and surfaced
--     only via the tenant_key_ring_metadata_v view (which filters on organization_id); wardenx_app is
--     INSERT-only on the base table, with mutation via tenant_platform_writer.
--   • PLATFORM — onboarding_task_template is a read-only shared catalog (SELECT USING(true), no tenant
--     write); tenant_signup_intent / tenant_signup_token are pre-organization platform-only
--     (wardenx_app cannot SELECT; tenant_platform_writer the one legitimate org-less exemption).

-- ============================================================================================
-- 1. tenant_account — ORG-SCOPED. Tenant reads its own row only (M34-F09: no blanket
--    pg_has_role('wardenx_admin') OR — that granted silent cross-tenant read). INSERT/UPDATE only via
--    tenant_platform_writer (provision/lifecycle SECURITY DEFINER path).
-- ============================================================================================
ALTER TABLE "tenant_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_account_select_own" ON "tenant_account"
  FOR SELECT TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT ON "tenant_account" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tenant_account" TO tenant_platform_writer;--> statement-breakpoint
GRANT ALL ON "tenant_account" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 1b. tenant_invitation — ORG-SCOPED, platform-written (D18 platform → first-admin). Tenant reads its
--    own invitations; INSERT/UPDATE only via tenant_platform_writer (issued at provisioning; acceptance
--    route uses token-hash auth, runs platform-side). §3.10 canonical predicate.
-- ============================================================================================
ALTER TABLE "tenant_invitation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_invitation_select_own" ON "tenant_invitation"
  FOR SELECT TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT ON "tenant_invitation" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tenant_invitation" TO tenant_platform_writer;--> statement-breakpoint
GRANT ALL ON "tenant_invitation" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 2. tenant_account_status_event — ORG-SCOPED, immutable lifecycle ledger. Canonical SELECT predicate;
--    INSERT only by the transition-writing service (tenant_platform_writer); never UPDATE/DELETE.
-- ============================================================================================
ALTER TABLE "tenant_account_status_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_account_status_event_org" ON "tenant_account_status_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT ON "tenant_account_status_event" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "tenant_account_status_event" TO tenant_platform_writer;--> statement-breakpoint
GRANT ALL ON "tenant_account_status_event" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 3. onboarding_task_template — PLATFORM-SHARED read-only catalog (SD-036 pattern-2). No
--    organization_id; identical rows for every tenant. wardenx_app reads only; writes via
--    tenant_platform_writer.
-- ============================================================================================
ALTER TABLE "onboarding_task_template" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "onboarding_task_template_read_all" ON "onboarding_task_template"
  FOR SELECT TO wardenx_app
  USING (true);--> statement-breakpoint
GRANT SELECT ON "onboarding_task_template" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "onboarding_task_template" TO tenant_platform_writer;--> statement-breakpoint
GRANT ALL ON "onboarding_task_template" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 4. onboarding_task — ORG-SCOPED (organization_id NOT NULL). Canonical app.org_id predicate.
-- ============================================================================================
ALTER TABLE "onboarding_task" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "onboarding_task_org" ON "onboarding_task"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "onboarding_task" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "onboarding_task" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 5. tenant_key_ring — ORG-SCOPED (organization_id NOT NULL). Ciphertext NEVER readable to wardenx_app:
--    base-table SELECT is REVOKED and surfaced only through tenant_key_ring_metadata_v (non-ciphertext
--    columns). wardenx_app is INSERT-only (initial key ring); rotation/destroy mutate via the 0055
--    SECURITY DEFINER fns owned by tenant_platform_writer.
-- ============================================================================================
ALTER TABLE "tenant_key_ring" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- INSERT path still needs an RLS WITH CHECK on the tenant scope (wardenx_app seeds its own ring).
CREATE POLICY "tenant_key_ring_org" ON "tenant_key_ring"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- wardenx_app is INSERT-only on the base table; SELECT goes through the masking view, mutation through
-- tenant_platform_writer (SECURITY DEFINER). The ciphertext column is therefore never selectable here.
REVOKE SELECT ON "tenant_key_ring" FROM wardenx_app;--> statement-breakpoint
GRANT INSERT ON "tenant_key_ring" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, UPDATE ON "tenant_key_ring" TO tenant_platform_writer;--> statement-breakpoint
GRANT ALL ON "tenant_key_ring" TO wardenx_admin;--> statement-breakpoint
-- Masking view (§3.10 M34-F02 / ADR-0010): non-ciphertext columns only; surfaces organization_id and
-- filters on the caller's org with the canonical predicate. Runs with the view-owner's rights over the
-- base table, so wardenx_app reads metadata without a base-table SELECT.
CREATE VIEW "tenant_key_ring_metadata_v" AS
  SELECT kr.id, kr.tenant_account_id, kr.organization_id, kr.current_dek_version, kr.current_dek_kek_id,
         kr.dek_created_at, kr.dek_last_rotated_at, kr.destroyed_at,
         kr.destroyed_by_membership_id, kr.destruction_certificate_id
    FROM tenant_key_ring kr
   WHERE kr.organization_id = current_setting('app.org_id', true)::uuid;--> statement-breakpoint
GRANT SELECT ON "tenant_key_ring_metadata_v" TO wardenx_app;--> statement-breakpoint
GRANT SELECT ON "tenant_key_ring_metadata_v" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 6. tenant_key_destruction_log — ORG-SCOPED (organization_id NOT NULL). Append-only destruction ledger.
-- ============================================================================================
ALTER TABLE "tenant_key_destruction_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_key_destruction_log_org" ON "tenant_key_destruction_log"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- Read-only to the tenant; the shred SECURITY DEFINER fn (tenant_platform_writer) writes the log rows.
GRANT SELECT ON "tenant_key_destruction_log" TO wardenx_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "tenant_key_destruction_log" TO tenant_platform_writer;--> statement-breakpoint
GRANT ALL ON "tenant_key_destruction_log" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 7. support_consent_grant — ORG-SCOPED (organization_id NOT NULL). INSERT further narrowed to the
--    tenant compliance_officer by the M3 ABAC predicate at the application layer; UPDATE limited to the
--    revoke fields by the route. RLS enforces the org boundary only.
-- ============================================================================================
ALTER TABLE "support_consent_grant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "support_grant_org" ON "support_consent_grant"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "support_consent_grant" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "support_consent_grant" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 8. support_session — ORG-SCOPED (organization_id NOT NULL). PHI access is break-glass-gated (F01) at
--    the M2/M3 layer; RLS enforces the org boundary. INSERT only by services.
-- ============================================================================================
ALTER TABLE "support_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "support_session_org" ON "support_session"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "support_session" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "support_session" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 9. support_session_event — ORG-SCOPED (organization_id NOT NULL; LIST-partitioned by organization_id).
--    Immutable PHI-access ledger; carries patient_id, so PHI access remains break-glass-gated (F01).
--    INSERT only by services.
-- ============================================================================================
ALTER TABLE "support_session_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "support_session_event_org" ON "support_session_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "support_session_event" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "support_session_event" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 10. dsar_export_job — ORG-SCOPED (organization_id NOT NULL day one). Canonical predicate + ABAC at the
--     route; worker runs under the tenant's withOrgContext (F09), so full CRUD for the tenant. Carries
--     patient_id (PHI).
-- ============================================================================================
ALTER TABLE "dsar_export_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "dsar_export_job_org" ON "dsar_export_job"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "dsar_export_job" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "dsar_export_job" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 11. dsar_export_job_event — ORG-SCOPED, immutable progress ledger. Canonical predicate; INSERT-only
--     for the tenant.
-- ============================================================================================
ALTER TABLE "dsar_export_job_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "dsar_export_job_event_org" ON "dsar_export_job_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "dsar_export_job_event" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "dsar_export_job_event" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 12. tenant_export_job — ORG-SCOPED (organization_id NOT NULL day one). Canonical predicate + ABAC;
--     worker under the tenant's withOrgContext (F09).
-- ============================================================================================
ALTER TABLE "tenant_export_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_export_job_org" ON "tenant_export_job"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tenant_export_job" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "tenant_export_job" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 13. tenant_export_job_event — ORG-SCOPED, immutable progress ledger. Canonical predicate; INSERT-only.
-- ============================================================================================
ALTER TABLE "tenant_export_job_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_export_job_event_org" ON "tenant_export_job_event"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "tenant_export_job_event" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "tenant_export_job_event" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 14. platform_tenant_baa_record — ORG-SCOPED (organization_id NOT NULL). INSERT/UPDATE narrowed to the
--     compliance_officer by M3 ABAC at the route; RLS enforces the org boundary.
-- ============================================================================================
ALTER TABLE "platform_tenant_baa_record" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "platform_tenant_baa_record_org" ON "platform_tenant_baa_record"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "platform_tenant_baa_record" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "platform_tenant_baa_record" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 15. tenant_signup_intent — PLATFORM-ONLY (pre-organization, no organization_id). wardenx_app cannot
--     SELECT; tenant_platform_writer is the one legitimate org-less exemption (the self-serve signup
--     funnel runs platform-side before a tenant org exists). RLS enabled with no wardenx_app policy.
-- ============================================================================================
ALTER TABLE "tenant_signup_intent" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tenant_signup_intent" TO tenant_platform_writer;--> statement-breakpoint
GRANT ALL ON "tenant_signup_intent" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 16. tenant_signup_token — PLATFORM-ONLY (pre-organization). wardenx_app cannot SELECT; acceptance
--     uses token-hash auth at the route, executed under tenant_platform_writer. RLS enabled, no
--     wardenx_app policy.
-- ============================================================================================
ALTER TABLE "tenant_signup_token" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "tenant_signup_token" TO tenant_platform_writer;--> statement-breakpoint
GRANT ALL ON "tenant_signup_token" TO wardenx_admin;--> statement-breakpoint

-- ============================================================================================
-- 17. M4 write-audit append path (M04-F06 #2) — idempotent re-assertion (mirror 0019 section 10). The
--     M34 write-audit triggers (0053) write through wardenx_audit_writer; re-assert its INSERT grant +
--     policy here so the RLS migration is self-contained and replay-safe.
-- ============================================================================================
GRANT INSERT ON audit_event TO wardenx_audit_writer;--> statement-breakpoint
DROP POLICY IF EXISTS audit_writer_insert ON audit_event;--> statement-breakpoint
CREATE POLICY audit_writer_insert ON audit_event
  FOR INSERT TO wardenx_audit_writer WITH CHECK (true);
