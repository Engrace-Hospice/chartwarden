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
--   re-created in the hardened 1062 form (search_path pinned incl. pg_temp, schema-qualified audit_scrub / audit_event,
--   SECURITY DEFINER, owned by wardenx_audit_writer) so NEW audit rows say `per_diem_rate_calculation`; audit_event rows
--   already written keep the old text (an audit trail is not rewritten).
--
-- STORED HISTORY IS NEVER REWRITTEN. validation_result (append-only run history) and
-- per_diem_rate_calculation.segments (append-only calculation snapshot) keep their legacy values byte for byte:
--   * validation_result.rule_key 'hipps_coding_correct' / remediation.fixAction 'recompute_hipps'
--   * per_diem_rate_calculation.segments[*].hippsCharPosition
-- No trigger is ever disabled by this file. Instead the application READ side maps the legacy spellings onto the new ones
-- (packages/billing/src/legacy-stored-aliases.ts; applied wherever stored values are projected, resolved or dispatched).
-- The one mutable table, validation_rule_config (tenant overlay; no append-only trigger), has its rule_key renamed in
-- place with a plain UPDATE and its audit trigger STILL ENABLED, so the rename is itself on the audit trail.
--
-- DEPLOYMENT: a hard rename needs migrate-then-swap. Between the migration and the end of the rolling deploy, pods still
-- running the previous image reference `hipps_calculation` / `hipps_code` and fail on claim assemble / validate (reads of
-- the claim detail pricing block included) until the rollout completes. Run the migration, then roll the new image.
--
-- TRANSACTION: scripts/db/migrate.ts wraps the WHOLE file in one BEGIN/COMMIT (the `--> statement-breakpoint` markers
-- are only a drizzle-kit convention; the runner executes the file as a single multi-statement query), so a failure
-- anywhere rolls the entire migration back.
--
-- MIGRATOR ROLE: validation_rule_config has FORCEd org RLS, so the rule_key UPDATE below only sees every tenant's rows when the
-- migrator is a superuser or has BYPASSRLS (the DATABASE_ADMIN_URL role). Under any other role it would silently update 0
-- rows; the verification block at the end of this file therefore RAISEs (rolling the whole migration back) if the role is
-- subject to RLS or if any legacy-keyed row that is not a legitimate unique-safety skip remains.
--
-- OLD PODS AFTER THE SWAP: with migrate-then-swap, a pod still running the previous image could create a NEW legacy-key
-- (`hipps_coding_correct`) validation_rule_config row after this migration has run. Such a row is never renamed; it is inert
-- (the read side aliases the legacy spelling to the current rule, and the write side now rejects creating one).
--
-- Idempotent: every step is guarded on the old name still existing / the new state not yet reached, so a re-run (or a run
-- from a partially migrated state, e.g. table renamed but not its columns) converges on the same end state.
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

  -- PHI write-audit trigger function: rename here, then re-created below (hardened 1062 form) so new audit rows carry the new resource kind.
  IF to_regprocedure('public.audit_phi_write_hipps_calculation()') IS NOT NULL THEN
    ALTER FUNCTION audit_phi_write_hipps_calculation() RENAME TO audit_phi_write_per_diem_rate_calculation;
  END IF;
END
$mig$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_per_diem_rate_calculation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_before jsonb; v_after jsonb; v_cols text[] := ARRAY['segments']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id, correlation_id, outcome, severity, before, after, context, retention_class)
  VALUES (COALESCE(NEW.organization_id, OLD.organization_id), NULLIF(current_setting('app.user_id', true), '')::uuid, 'system', 'per_diem_rate_calculation.' || lower(TG_OP), 'per_diem_rate_calculation', COALESCE(NEW.id, OLD.id), COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'), 'success', 'info', v_before, v_after, jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')), 'compliance');
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_per_diem_rate_calculation() OWNER TO wardenx_audit_writer;--> statement-breakpoint

-- Tenant rule overlay: rename the persisted rule key in place. validation_rule_config has NO append-only trigger, so a plain
-- UPDATE works with its audit trigger enabled (the rename is audited). A row is skipped only if the tenant somehow already
-- holds the new key (cannot happen before this migration; the skip keeps the unique (org, rule_key) constraint safe).
UPDATE validation_rule_config o
   SET rule_key = 'per_diem_class_coding_correct'
 WHERE o.rule_key = 'hipps_coding_correct'
   AND NOT EXISTS (SELECT 1 FROM validation_rule_config n
                    WHERE n.organization_id = o.organization_id AND n.rule_key = 'per_diem_class_coding_correct');
--> statement-breakpoint

-- Verify the overlay rename: fail loudly (rolling the whole file back) instead of silently leaving legacy rows behind.
-- Rows skipped by the NOT EXISTS unique-safety guard (the tenant already holds the new key) are legitimate and tolerated.
DO $verify$
DECLARE
  remaining integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'migration 1069 must run as a superuser / BYPASSRLS role (DATABASE_ADMIN_URL): validation_rule_config has FORCEd RLS, so % could not rename every tenant''s rule_key', current_user;
  END IF;
  SELECT count(*) INTO remaining
    FROM validation_rule_config o
   WHERE o.rule_key = 'hipps_coding_correct'
     AND NOT EXISTS (SELECT 1 FROM validation_rule_config n
                      WHERE n.organization_id = o.organization_id AND n.rule_key = 'per_diem_class_coding_correct');
  IF remaining > 0 THEN
    RAISE EXCEPTION 'migration 1069: % validation_rule_config row(s) still carry rule_key hipps_coding_correct', remaining;
  END IF;
END
$verify$;
