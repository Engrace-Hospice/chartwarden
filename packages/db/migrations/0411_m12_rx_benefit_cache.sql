-- M12 (GAP-037 close-out) — `rx_benefit_cache`, the §2.9 per-(patient, drug) formulary / coverage summary the
-- `dosespot.rx_benefit_prewarm` cron fills and the RxBenefit lookup reads. The spec (§3 / D15) always listed the
-- table; it was never created, so the prewarm queue had nowhere to write (the `invalidate_rx_benefit_cache`
-- flag on `dosespot_sync_queue` pointed at it).
--
-- NOTHING here is populated by anything but a real RxBenefit lookup response — no seed, no default row, no
-- backfill. `expires_at` bounds how long a cached answer may be served; a patient demographic/payer change
-- DELETEs the patient's rows (the patient-sync worker honours `invalidate_rx_benefit_cache`), so the app role
-- needs DELETE here (unlike the append-only vendor-boundary tables).
--
-- RLS: canonical app.org_id predicate, ENABLE + FORCE together (F-087). M4 write-audit trigger; no free-text
-- columns, so nothing is denylisted.
CREATE TABLE IF NOT EXISTS "rx_benefit_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"rxnorm_rxcui" text NOT NULL,
	"covered" boolean NOT NULL,
	"copay_tier" text,
	"prior_auth_required" boolean NOT NULL,
	"looked_up_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rx_benefit_cache_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "rx_benefit_cache_window_chk" CHECK ("expires_at" > "looked_up_at")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rx_benefit_cache_patient_drug_uq"
	ON "rx_benefit_cache" ("organization_id", "patient_id", "rxnorm_rxcui");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rx_benefit_cache_expiry_ix"
	ON "rx_benefit_cache" ("organization_id", "expires_at");--> statement-breakpoint

ALTER TABLE "rx_benefit_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rx_benefit_cache" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "rx_benefit_cache_org" ON "rx_benefit_cache"
	FOR ALL TO wardenx_app
	USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "rx_benefit_cache" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "rx_benefit_cache" TO wardenx_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION audit_phi_write_rx_benefit_cache() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before jsonb;
  v_after jsonb;
  v_cols text[] := ARRAY[]::text[];
BEGIN
  v_before := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN audit_scrub(to_jsonb(OLD), v_cols) ELSE NULL END;
  v_after := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN audit_scrub(to_jsonb(NEW), v_cols) ELSE NULL END;
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after,
    context, retention_class
  ) VALUES (
    COALESCE(NEW.organization_id, OLD.organization_id),
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'system',
    'rx_benefit_cache.' || lower(TG_OP),
    'rx_benefit_cache',
    COALESCE(NEW.id, OLD.id),
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', v_before, v_after,
    jsonb_build_object(
      'provider_entity_id', NULLIF(current_setting('app.provider_entity_id', true), ''),
      'location_id', NULLIF(current_setting('app.location_id', true), '')),
    'operational'
  );
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_rx_benefit_cache() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_rx_benefit_cache" AFTER INSERT OR UPDATE OR DELETE ON rx_benefit_cache
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_rx_benefit_cache();
