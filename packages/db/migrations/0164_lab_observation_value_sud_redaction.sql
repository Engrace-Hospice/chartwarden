-- TASK-063/ARCH-020 follow-up — M29 lab_observation_value.observation_value row-conditional SUD
-- redaction (resolves the constant-vs-migration-vs-catalog three-way disagreement flagged when the
-- audit-denylist-sync gate was built).
--
-- DECISION: implement the row-conditional redaction AUDIT_DENYLIST_CATALOG already specified
-- (packages/audit/src/triggers/catalog.ts, W-M4-11) — 42 CFR Part 2 confidentiality applies to lab
-- results only when the parent observation is SUD-class (`lab_observation.sud_redaction_status <>
-- 'not_applicable'`); non-SUD results stay legible in the audit diff. The PRIOR trigger (0148) did
-- `to_jsonb(OLD/NEW)` directly with no `audit_scrub()` call at all and a hardcoded 'compliance'
-- retention class — its own header comment documented the empty denylist as deliberate and
-- cross-checked against `M29_AUDIT_DENYLIST`, but that check only ever compared against the FLAT
-- constant, which was never designed to express row-conditional protection — it never saw the
-- catalog's row-conditional entry for this exact table+column at all. Two representations that
-- looked consistent were actually silent about a third.
--
-- This is generateAuditTrigger()'s row-conditional code path (packages/audit/src/triggers/
-- generate.ts) — built for exactly this catalog entry, never before invoked against a real
-- migration (confirmed: zero `v_denylist text[]` occurrences in any prior migration). Output below
-- is the LITERAL, byte-for-byte result of:
--
--   generateAuditTrigger({
--     table: "lab_observation_value",
--     resourceKind: "lab_observation_value",
--     denylistCategories: ["sud_value"],
--     retentionClass: "compliance_42cfr_part2",
--   })
--
-- — never hand-typed, so it cannot drift from the catalog it was generated against. Retention class
-- also corrected from the prior hardcoded 'compliance' to 'compliance_42cfr_part2' (§5.3
-- defense-in-depth: a Part 2 trigger is subject to sud_value scrubbing and files under the Part 2
-- retention class regardless of whether a given row actually turned out to be SUD-class).
CREATE OR REPLACE FUNCTION audit_phi_write_lab_observation_value() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_denylist text[] := ARRAY[]::text[];
BEGIN
  IF EXISTS (SELECT 1 FROM lab_observation lo WHERE lo.id = COALESCE(NEW.observation_id, OLD.observation_id) AND lo.sud_redaction_status <> 'not_applicable') THEN
    v_denylist := v_denylist || ARRAY['observation_value']::text[];
  END IF;
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_denylist) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_denylist) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'lab_observation_value.' || lower(TG_OP),
    'lab_observation_value',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance_42cfr_part2'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_lab_observation_value() OWNER TO wardenx_audit_writer;--> statement-breakpoint
-- Re-affirms the existing trigger→function binding (PG14+; the function body above is what actually
-- changed — this table is PARTITIONED, so the trigger must stay attached to the PARENT, which
-- CREATE OR REPLACE TRIGGER preserves — and restating it keeps this migration self-contained and
-- matches what scripts/check-audit-denylist-sync.ts parses per-file).
CREATE OR REPLACE TRIGGER "trg_audit_lab_observation_value" AFTER INSERT OR UPDATE OR DELETE ON lab_observation_value
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_lab_observation_value();
