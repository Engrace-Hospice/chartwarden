-- M23 — rename the `hipps_*` construct to `per_diem_rate_*` / `per_diem_class_*` (ADR-0001: `PerDiemRateCalculation`). Hospice claims carry NO HIPPS rate code: the
-- stored 5-character value is an INTERNAL per-diem class placeholder (`derivePerDiemClassCode`,
-- packages/billing/src/per-diem-class/calculator.ts) and is never transmitted on an 837I / UB-04. The old name implied a
-- CMS code that does not exist for hospice, so it is renamed everywhere. No behaviour changes; nothing is dropped.
--
--   table    hipps_calculation                  -> per_diem_rate_calculation
--   columns  hipps_code                         -> per_diem_class_code
--            hipps_rate_cents                   -> per_diem_rate_cents
--   every constraint / index / policy / trigger carrying the old name is renamed in place (the table keeps its OID,
--   its rows, its FORCEd org RLS, its grants, its append-only + audit triggers). The PHI write-audit trigger function is
--   replaced so NEW audit rows say `per_diem_rate_calculation`; audit_event rows already written keep the old text
--   (an audit trail is not rewritten).
--
-- STORED VALUES migrated in place (rows exist on populated databases):
--   * per_diem_rate_calculation.segments[*].hippsCharPosition -> perDiemClassCharPosition (jsonb key)
--   * validation_rule_config.rule_key / validation_result.rule_key 'hipps_coding_correct' -> 'per_diem_class_coding_correct'
--     and validation_result.remediation.fixAction 'recompute_hipps' -> 'recompute_per_diem_class'
--     (validation_result is the append-only run history; a stale key would no longer match the rule registry).
--   The append-only / audit triggers are disabled for exactly these three UPDATEs inside one DO block (one statement =
--   one transaction: a failure rolls the disable back too) and re-enabled before it ends.
--
-- Idempotent: every step is guarded on the old name still existing, so a re-run is a no-op.
DO $mig$
DECLARE
  r record;
  new_name text;
BEGIN
  IF to_regclass('public.hipps_calculation') IS NOT NULL AND to_regclass('public.per_diem_rate_calculation') IS NULL THEN
    ALTER TABLE "hipps_calculation" RENAME TO "per_diem_rate_calculation";
  END IF;

  IF to_regclass('public.per_diem_rate_calculation') IS NULL THEN
    RETURN; -- nothing to do
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'per_diem_rate_calculation' AND column_name = 'hipps_code') THEN
    ALTER TABLE "per_diem_rate_calculation" RENAME COLUMN "hipps_code" TO "per_diem_class_code";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
             AND table_name = 'per_diem_rate_calculation' AND column_name = 'hipps_rate_cents') THEN
    ALTER TABLE "per_diem_rate_calculation" RENAME COLUMN "hipps_rate_cents" TO "per_diem_rate_cents";
  END IF;

  -- Constraints (incl. PG18 named NOT NULLs; renaming a PK / UNIQUE constraint renames its backing index).
  FOR r IN
    SELECT conname::text AS conname FROM pg_constraint
    WHERE conrelid = 'public.per_diem_rate_calculation'::regclass AND conname LIKE 'hipps\_calculation%'
  LOOP
    new_name := replace(replace(replace(r.conname, 'hipps_calculation', 'per_diem_rate_calculation'),
                                'hipps_code', 'per_diem_class_code'),
                        'hipps_rate_cents', 'per_diem_rate_cents');
    EXECUTE format('ALTER TABLE public.per_diem_rate_calculation RENAME CONSTRAINT %I TO %I', r.conname, new_name);
  END LOOP;

  -- Stand-alone indexes (the constraint-backed ones were renamed above).
  FOR r IN
    SELECT c.relname::text AS relname FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'public.per_diem_rate_calculation'::regclass AND c.relname LIKE 'hipps\_calculation%'
  LOOP
    EXECUTE format('ALTER INDEX public.%I RENAME TO %I', r.relname,
                   replace(r.relname, 'hipps_calculation', 'per_diem_rate_calculation'));
  END LOOP;

  -- Policies (hipps_calculation_org from 0077, hipps_calculation_destruction from 0157).
  FOR r IN
    SELECT polname::text AS polname FROM pg_policy
    WHERE polrelid = 'public.per_diem_rate_calculation'::regclass AND polname LIKE 'hipps\_calculation%'
  LOOP
    EXECUTE format('ALTER POLICY %I ON public.per_diem_rate_calculation RENAME TO %I', r.polname,
                   replace(r.polname, 'hipps_calculation', 'per_diem_rate_calculation'));
  END LOOP;

  -- Triggers.
  FOR r IN
    SELECT tgname::text AS tgname FROM pg_trigger
    WHERE tgrelid = 'public.per_diem_rate_calculation'::regclass AND NOT tgisinternal AND tgname LIKE '%hipps\_calculation%'
  LOOP
    EXECUTE format('ALTER TRIGGER %I ON public.per_diem_rate_calculation RENAME TO %I', r.tgname,
                   replace(r.tgname, 'hipps_calculation', 'per_diem_rate_calculation'));
  END LOOP;

  -- PHI write-audit trigger function: rename, then redefine so new audit rows carry the new resource kind.
  IF to_regprocedure('public.audit_phi_write_hipps_calculation()') IS NOT NULL THEN
    ALTER FUNCTION audit_phi_write_hipps_calculation() RENAME TO audit_phi_write_per_diem_rate_calculation;
  END IF;
END
$mig$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_per_diem_rate_calculation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['segments']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'per_diem_rate_calculation.' || lower(TG_OP), 'per_diem_rate_calculation', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_per_diem_rate_calculation() OWNER TO wardenx_audit_writer;--> statement-breakpoint

DO $mig$
BEGIN
  IF to_regclass('public.per_diem_rate_calculation') IS NULL THEN
    RETURN;
  END IF;

  -- segments[*].hippsCharPosition -> perDiemClassCharPosition (key rename, element order preserved).
  IF EXISTS (SELECT 1 FROM per_diem_rate_calculation WHERE segments::text LIKE '%hippsCharPosition%') THEN
    ALTER TABLE per_diem_rate_calculation DISABLE TRIGGER USER;
    UPDATE per_diem_rate_calculation c
       SET segments = (
         SELECT jsonb_agg(
                  CASE WHEN e ? 'hippsCharPosition'
                       THEN (e - 'hippsCharPosition') || jsonb_build_object('perDiemClassCharPosition', e -> 'hippsCharPosition')
                       ELSE e END
                  ORDER BY ord)
           FROM jsonb_array_elements(c.segments) WITH ORDINALITY AS t(e, ord))
     WHERE jsonb_typeof(c.segments) = 'array' AND c.segments::text LIKE '%hippsCharPosition%';
    ALTER TABLE per_diem_rate_calculation ENABLE TRIGGER USER;
  END IF;

  -- Persisted rule key.
  IF EXISTS (SELECT 1 FROM validation_rule_config WHERE rule_key = 'hipps_coding_correct') THEN
    ALTER TABLE validation_rule_config DISABLE TRIGGER USER;
    UPDATE validation_rule_config SET rule_key = 'per_diem_class_coding_correct' WHERE rule_key = 'hipps_coding_correct';
    ALTER TABLE validation_rule_config ENABLE TRIGGER USER;
  END IF;
  IF EXISTS (SELECT 1 FROM validation_result
             WHERE rule_key = 'hipps_coding_correct' OR remediation::text LIKE '%recompute\_hipps%') THEN
    ALTER TABLE validation_result DISABLE TRIGGER USER;
    UPDATE validation_result SET rule_key = 'per_diem_class_coding_correct' WHERE rule_key = 'hipps_coding_correct';
    -- remediation.fixAction 'recompute_hipps' -> 'recompute_per_diem_class'
    UPDATE validation_result
       SET remediation = replace(remediation::text, 'recompute_hipps', 'recompute_per_diem_class')::jsonb
     WHERE remediation::text LIKE '%recompute\_hipps%';
    ALTER TABLE validation_result ENABLE TRIGGER USER;
  END IF;
END
$mig$;
