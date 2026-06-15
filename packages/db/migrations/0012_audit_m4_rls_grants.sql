-- M4 Audit §3.6, §3.7 (M4-T05) — RLS, the append-only GRANT model, the audit-capture
-- role wiring, the scrub helper, and baseline write-audit triggers for the seven Module 4
-- lifecycle / integrity / catalog tables created in 0011. Runs after the Drizzle-generated
-- table DDL, the same two-phase shape M1 (0001/0004) and M3 (0008/0009) use.
--
-- AUTHORITY NOTE (architecture > module spec). Spec §3.7 calls a `wardenx_enable_rls()`
-- helper; M1/M2/M3 never shipped such a generator — they hand-write the CREATE POLICY shape
-- (0001/0006/0009). This migration follows that established, gate-checked shape. Per ADR-0010
-- D2 the ONLY session variable any policy keys on is `app.org_id` (check-tenancy.ts rule 2);
-- the audit_seal nullable-org / platform-partition nuance and the Compliance-permission gating
-- on legal-hold / destruction / export actions are RBAC/ABAC at the app layer (M4-T06/T08),
-- NEVER pushed into RLS (architecture line 220 / spec §3.6).
--
-- SCOPE (M4-T05). This migration ships the *capability*: the audit-writer INSERT grant the
-- audit_event partition deferred to M4 (0001 line 9), the scrub helper, the append-only grant
-- model, RLS, and BASELINE triggers reusing M1's wardenx_audit_trigger() (0004). M4 owns the
-- canonical column-level write-audit trigger *generator* (M4-T02) and back-fills every M1–M3+M4
-- org-scoped table through it (denylist scrubbing) in M4-T10. The Part 2 retention class, the
-- denylist-category seed, and the action-catalog seed land later (§3.7.1 / M4-T07/T10) — only
-- the tables exist here, not their rows.

-- 1. Audit-capture role wiring ----------------------------------------------
-- The wardenx_audit_writer role already exists (0001). 0001 deferred its audit_event INSERT
-- grant to "M4's migration" (0001 line 9 / §3.7 step 2): grant it here. Writes still flow
-- through the SECURITY DEFINER wardenx_audit_trigger() (0004) — owned by the admin/table owner
-- so it bypasses RLS — wardenx_app never writes audit_event directly (no INSERT policy, 0001).
GRANT INSERT ON "audit_event" TO wardenx_audit_writer;--> statement-breakpoint

-- 2. Scrub helper (§3.7 step 3) ---------------------------------------------
-- Replaces denylisted column values in a before/after row image with the change-marker
-- '<changed>', so the immutable audit row records *that* a high-sensitivity column changed
-- without copying its value (§2.3, §5). IMMUTABLE: pure function of its inputs. The canonical
-- write-audit trigger generator (M4-T02) emits calls to this when a table declares denylist
-- categories; the baseline triggers below do not scrub (normalized in M4-T10).
CREATE OR REPLACE FUNCTION audit_scrub(doc jsonb, denylist text[])
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    (SELECT jsonb_object_agg(k, CASE WHEN k = ANY(denylist) THEN '"<changed>"'::jsonb ELSE v END)
     FROM jsonb_each(doc) AS e(k, v)),
    '{}'::jsonb);
$$;--> statement-breakpoint

-- 3. Append-only GRANT model (§3.6) -----------------------------------------
-- Org-scoped lifecycle tables carry a mutable state machine (legal_hold active→released;
-- destruction_certificate pending→…→executed/partial_refused; audit_export pending→ready),
-- so wardenx_app gets full DML (subject to RLS below).
GRANT INSERT, SELECT, UPDATE, DELETE ON
  "legal_hold", "destruction_certificate", "audit_export"
TO wardenx_app;--> statement-breakpoint
-- audit_seal is a tamper-evidence chain: APPEND-ONLY (no UPDATE/DELETE), mirroring audit_event
-- (§10.4 integrity). wardenx_app may read its org's seals and the sealer appends; rewriting a
-- seal would break the hash chain. RLS (FOR ALL) below still scopes visibility to app.org_id.
GRANT INSERT, SELECT ON "audit_seal" TO wardenx_app;--> statement-breakpoint
-- Platform-reference catalogs (NON_ORG_SCOPED, check-tenancy allowlist): read-all for tenants;
-- writes only via the platform context (wardenx_admin) at boot/migration (§3.6, §4.6).
GRANT SELECT ON "state_retention_override" TO wardenx_app;--> statement-breakpoint
GRANT SELECT ON "audit_denylist_catalog" TO wardenx_app;--> statement-breakpoint
GRANT SELECT ON "audit_action_catalog" TO wardenx_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "state_retention_override" FROM wardenx_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "audit_denylist_catalog" FROM wardenx_app;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "audit_action_catalog" FROM wardenx_app;--> statement-breakpoint
GRANT ALL ON
  "legal_hold", "destruction_certificate", "audit_export", "audit_seal",
  "state_retention_override", "audit_denylist_catalog", "audit_action_catalog"
TO wardenx_admin;--> statement-breakpoint

-- 4. Row-Level Security (§3.6) ----------------------------------------------
-- Standard tenant isolation on the four org-scoped tables, keyed ONLY on app.org_id.
ALTER TABLE "legal_hold" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "destruction_certificate" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_export" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_seal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "legal_hold_org" ON "legal_hold"
  FOR ALL TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "destruction_certificate_org" ON "destruction_certificate"
  FOR ALL TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "audit_export_org" ON "audit_export"
  FOR ALL TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
-- audit_seal: org-scoped on a NULLABLE organization_id (platform-scope partitions seal with a
-- NULL org). The writable policy never admits a NULL org, so a tenant context can neither read
-- nor write a platform seal — those are managed only through the platform context. This mirrors
-- the M3 role/role_permission nullable-org shape: the policy keys strictly on org equality, with
-- no NULL-org escape branch (check-tenancy rule 3a). Append-only is enforced by the GRANT model
-- above, not RLS.
CREATE POLICY "audit_seal_org" ON "audit_seal"
  FOR ALL TO wardenx_app
  USING ("organization_id" = current_setting('app.org_id', true)::uuid)
  WITH CHECK ("organization_id" = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

-- 5. Baseline write-audit triggers (Wave-A interplay note 2 / M4-T10) -------
-- Attach M1's wardenx_audit_trigger() (0004) to every M4 table so legal-hold/destruction/
-- export/seal mutations AND the platform-reference catalog writes are captured into audit_event
-- ("each change audited", §3.6). The platform-reference tables get a trigger for the same reason
-- M3's `permission` mirror does (0009): the phi-guards gate requires every org-scoped *or*
-- catalog table that lands in a migration to carry a capture trigger; catalog refreshes run in
-- the platform context and audit as platform-scoped events. M4-T10 normalizes these to the
-- canonical generator (column-level denylist scrubbing via audit_scrub()).
CREATE TRIGGER "legal_hold_audit" AFTER INSERT OR UPDATE OR DELETE ON legal_hold
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "destruction_certificate_audit" AFTER INSERT OR UPDATE OR DELETE ON destruction_certificate
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "audit_export_audit" AFTER INSERT OR UPDATE OR DELETE ON audit_export
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "audit_seal_audit" AFTER INSERT OR UPDATE OR DELETE ON audit_seal
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "state_retention_override_audit" AFTER INSERT OR UPDATE OR DELETE ON state_retention_override
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "audit_denylist_catalog_audit" AFTER INSERT OR UPDATE OR DELETE ON audit_denylist_catalog
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint
CREATE TRIGGER "audit_action_catalog_audit" AFTER INSERT OR UPDATE OR DELETE ON audit_action_catalog
  FOR EACH ROW EXECUTE FUNCTION wardenx_audit_trigger();--> statement-breakpoint

-- 6. Seed state retention overrides (§3.7 step 7; architecture §24.4) --------
-- Baseline two-state seed; extend per tenant geography. Runs in the migration (platform)
-- context. ON CONFLICT keeps the migration idempotent across re-runs.
INSERT INTO state_retention_override (state_code, data_class, retention_spec, citation) VALUES
  ('OR', 'clinical_record', '7y', 'ORS 192.553'),
  ('TX', 'clinical_record_minor', 'until_age_21+7', 'Tex. Health & Safety Code §241.103')
ON CONFLICT (state_code, data_class) DO NOTHING;
