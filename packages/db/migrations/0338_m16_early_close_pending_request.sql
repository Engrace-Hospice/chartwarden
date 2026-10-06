-- GAP-047 — M16 D7 early close: record a PENDING cosign request on the plan; the closure row (whose
-- §3.3.7 CHECK requires a non-null supervisor cosigner on the five early reasons) is inserted only by the
-- cosign-close transition, by a DIFFERENT supervisor.
--
-- close-early now writes these four columns and leaves the plan in its current state; cosign-close reads
-- them, performs the transition to closed_early, inserts the closure with cosigned_by = the cosigner and
-- closed_by = the requester, then clears the request.
--
-- Additive, nullable, no default. All four are set together or not at all. The narrative is D11 prose, so
-- the plan audit trigger's denylist gains early_close_narrative_redacted (mirrored in M16_AUDIT_DENYLIST;
-- the trigger function is otherwise byte-identical to 0102). Existing RLS policies cover the new columns.
-- A plan that is already closed_early keeps NULLs (its closure row is the record).
ALTER TABLE "bereavement_plan" ADD COLUMN IF NOT EXISTS "early_close_reason" bereavement_plan_closure_reason;--> statement-breakpoint
ALTER TABLE "bereavement_plan" ADD COLUMN IF NOT EXISTS "early_close_narrative_redacted" text;--> statement-breakpoint
ALTER TABLE "bereavement_plan" ADD COLUMN IF NOT EXISTS "early_close_requested_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "bereavement_plan" ADD COLUMN IF NOT EXISTS "early_close_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bereavement_plan" DROP CONSTRAINT IF EXISTS "berv_plan_early_close_request_all_or_none";--> statement-breakpoint
ALTER TABLE "bereavement_plan" ADD CONSTRAINT "berv_plan_early_close_request_all_or_none"
  CHECK ((early_close_reason IS NULL) = (early_close_narrative_redacted IS NULL)
     AND (early_close_reason IS NULL) = (early_close_requested_by_user_id IS NULL)
     AND (early_close_reason IS NULL) = (early_close_requested_at IS NULL));--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_plan() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY['pause_reason_redacted','ipoc_bereavement_intent_summary_redacted','early_close_narrative_redacted']::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE')
    THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE')
    THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user',
    'bereavement_plan.' || lower(TG_OP),
    'bereavement_plan',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'compliance'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_audit_bereavement_plan" ON bereavement_plan;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_plan" AFTER INSERT OR UPDATE OR DELETE ON bereavement_plan
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_plan();
