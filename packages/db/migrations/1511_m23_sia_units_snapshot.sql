-- compat: expand
-- M23 SIA units snapshot (slice 1 of the SIA correctness work). Medicare pays the Service Intensity Add-on in 15-minute UNITS
-- (<= 16 per day, rounded per visit, paid at the wage-adjusted CHC hourly rate / 4), not in minutes. `sia_calculation` used to
-- keep only the qualifying visits, their minutes and the cents. This adds what the units model needs to be reproduced and
-- explained later: the unit totals, the CHC hourly rate and wage index it was priced with, the policy assumptions, EVERY visit's
-- counted/excluded verdict (so billing sees why an hour of care is not payable), and the advisory for a death in the first
-- seven days of a month (Medicare adjusts the PRIOR month's claim; nothing is added to this claim's expected payment).
-- Additive only: every new column is nullable except `basis` / `revision`, which carry defaults, so rows written by the previous
-- release (and its INSERT ... ON CONFLICT (claim_id)) stay valid. Legacy rows keep basis 'minutes_v1'; new code writes
-- 'units_v2'. 1512 swaps UNIQUE (claim_id) for UNIQUE (claim_id, revision) and adds the CHECKs, because a changed visit fact
-- or rate appends a new revision instead of rewriting the append-only row (trg_append_only_sia_calculation, 1061).
-- RLS (0077), the table grants (SELECT/INSERT/UPDATE app, DELETE for a draft claim 1061, destruction 0157) are table-level and
-- cover the new columns unchanged. The write-audit function is restated only to scrub `visit_outcomes` like `qualifying_visits`
-- (per-visit encounter ids and service dates); the images, the event and the owner are as 0079 made them. The trigger is
-- restated unchanged because arch:audit-denylist-sync finds a function's table from the trigger that follows it.
ALTER TABLE "sia_calculation" ADD COLUMN IF NOT EXISTS "paid_units" integer;--> statement-breakpoint
ALTER TABLE "sia_calculation" ADD COLUMN IF NOT EXISTS "eligible_units" integer;--> statement-breakpoint
ALTER TABLE "sia_calculation" ADD COLUMN IF NOT EXISTS "truncated_units" integer;--> statement-breakpoint
ALTER TABLE "sia_calculation" ADD COLUMN IF NOT EXISTS "chc_hourly_rate_cents" bigint;--> statement-breakpoint
ALTER TABLE "sia_calculation" ADD COLUMN IF NOT EXISTS "wage_index_fiscal_year" integer;--> statement-breakpoint
ALTER TABLE "sia_calculation" ADD COLUMN IF NOT EXISTS "wage_index_factor" text;--> statement-breakpoint
ALTER TABLE "sia_calculation" ADD COLUMN IF NOT EXISTS "policy" jsonb;--> statement-breakpoint
ALTER TABLE "sia_calculation" ADD COLUMN IF NOT EXISTS "visit_outcomes" jsonb;--> statement-breakpoint
ALTER TABLE "sia_calculation" ADD COLUMN IF NOT EXISTS "prior_claim_advisory" jsonb;--> statement-breakpoint
ALTER TABLE "sia_calculation" ADD COLUMN IF NOT EXISTS "basis" text NOT NULL DEFAULT 'minutes_v1';--> statement-breakpoint
ALTER TABLE "sia_calculation" ADD COLUMN IF NOT EXISTS "revision" integer NOT NULL DEFAULT 1;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_sia_calculation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['qualifying_visits','visit_outcomes']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN public.audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN public.audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO public.audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system',
    'sia_calculation.' || lower(TG_OP),
    'sia_calculation',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object('provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_sia_calculation() OWNER TO chartwarden_audit_writer;--> statement-breakpoint
CREATE OR REPLACE TRIGGER "trg_audit_sia_calculation" AFTER INSERT OR UPDATE OR DELETE ON sia_calculation
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_sia_calculation();
