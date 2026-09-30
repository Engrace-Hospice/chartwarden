-- F-206 (#248) — `bereavement_cop_opt_out_credit`: the durable fact backing M30's
-- `bereavement_coverage_rate` CoP 418.64(d) measure treating a pre-death patient bereavement opt-out as
-- SATISFIED, not silently absent from the denominator (the user's own decision closing the
-- `m16.bereavement.plan_skipped_per_patient_opt_out` -> M30 declared-but-unbound pair).
--
-- One row per delivered `m16.bereavement.plan_skipped_per_patient_opt_out` outbox event, recording exactly
-- the event's own payload (patientId/admissionId/deathDate) rather than a derived M16-internal fact — see
-- packages/db/src/schema/bereavement/bereavement-cop-opt-out-credits.ts for why (the event can fire from
-- two shapes, only one of which leaves a `bereavement_plan_closure` row to join through).
--
-- IDEMPOTENCY: UNIQUE on (organization_id, source_event_id), never a pre-read — the migration-0249/0255
-- precedent. A redelivery inserts nothing a second time and cannot double-count toward the rate.
CREATE TABLE IF NOT EXISTS "bereavement_cop_opt_out_credit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"death_date" date NOT NULL,
	"source_event_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "berv_cop_optout_credit_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "berv_cop_optout_credit_provider_entity_id_provider_entity_id_fk"
		FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "berv_cop_optout_credit_location_id_location_id_fk"
		FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "berv_cop_optout_credit_source_event_uq"
	ON "bereavement_cop_opt_out_credit" ("organization_id", "source_event_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "berv_cop_optout_credit_scope_death_idx"
	ON "bereavement_cop_opt_out_credit" ("organization_id", "provider_entity_id", "death_date");--> statement-breakpoint

-- RLS — the canonical app.org_id predicate (ADR-0010 D3), ENABLE + FORCE together (F-087 / migration 0118
-- precedent), NULLIF guard (migration 0246/0247 precedent).
ALTER TABLE "bereavement_cop_opt_out_credit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bereavement_cop_opt_out_credit" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "bereavement_cop_opt_out_credit_org" ON "bereavement_cop_opt_out_credit"
	FOR ALL TO wardenx_app
	USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT ON "bereavement_cop_opt_out_credit" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "bereavement_cop_opt_out_credit" TO wardenx_admin;--> statement-breakpoint

-- M4 write-audit trigger. No free-text column exists on this table (patient_id/admission_id are
-- identifiers, not narrative content — the `bereavement_plan` audit trigger's own denylist only scrubs its
-- two REDACTED narrative columns, migration 0102), so no D11 denylist entry is needed, the
-- `unmapped_taxonomy_occurrence` (migration 0255) precedent. `retention_class` is `compliance`, matching
-- `bereavement_plan` itself: this row directly backs a CoP 418.64(d) compliance measure.
CREATE OR REPLACE FUNCTION audit_phi_write_bereavement_cop_opt_out_credit() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
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
    'system',
    'bereavement_cop_opt_out_credit.' || lower(TG_OP),
    'bereavement_cop_opt_out_credit',
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
ALTER FUNCTION audit_phi_write_bereavement_cop_opt_out_credit() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_bereavement_cop_opt_out_credit" AFTER INSERT OR UPDATE OR DELETE ON bereavement_cop_opt_out_credit
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_bereavement_cop_opt_out_credit();
