-- M21 — `supply_request_pharmacy_dispense` (F-233, #248, Option B of the F-230 register): the minimal,
-- append-only fact "the order behind this M21 request was dispensed at T (by the order's pharmacy of
-- record, source dosespot)", written by M21's consumer of `m12.medication_order.dispensed_at_pharmacy`.
--
-- WHAT THIS IS NOT. It is NOT a `comfort_kit_dispatch` and creates none. M21 §2.5 says the consumer creates a
-- `dispatch_source = pharmacy_partner` dispatch, but that row's NOT NULL chain-of-custody columns
-- (`kit_serial_number`, `dispatched_by_membership_id`, `controlled_substance_handling_policy_digest`, per-line
-- lot/expiry) are facts about a PHYSICAL kit that a pharmacy-dispense signal does not carry; inventing them
-- would fabricate a DEA 21 CFR §1304 chain-of-custody record. No dispatch / request state machine is touched
-- and `supply_request` itself is not altered (it is partitioned and owned by the lifecycle writers).
--
-- CORRELATION. The only link from the event to M21 is the OPTIONAL `data.contents[].medicationOrderId` on a
-- `comfort_kit_deploy` / `comfort_kit_replenish` request. One event can match several requests (a deploy and
-- a later replenish naming the same order); each gets one row.
--
-- HONESTY OF `dispensing_pharmacy_mdm_id`: the M12 emit carries the pharmacy OF RECORD on the order
-- (`medication_order.pharmacy_mdm_id`), because the webhook's own pharmacy identity is not mapped. It is NOT a
-- vendor-confirmed dispensing pharmacy. `source = 'dosespot'` records the signal's origin, not a confirmation.
--
-- SETTLEMENT. An event that correlates with no request is settled with ONE row, `outcome =
-- 'no_correlating_request'`, `supply_request_id`/`patient_id` NULL and a recorded reason — so the no-op is
-- visible and a redelivery is a no-op rather than a second row. (It is event-time correlation only: a request
-- created AFTER the event is not retro-matched.)
--
-- IDEMPOTENCY: the outbox event id (`source_event_id`) — unique per (org, event, request) and, for the
-- unmatched row, per (org, event).
--
-- Append-only: wardenx_app gets SELECT + INSERT, no UPDATE, no DELETE (the M21 eraser runs as the admin role).
-- Cross-module FK policy: supply_request_id / patient_id / medication_order_id are LOGICAL uuid (the targets
-- are partitioned / other modules'). RLS on the canonical app.org_id predicate, ENABLE + FORCE together.
CREATE TABLE IF NOT EXISTS "supply_request_pharmacy_dispense" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"source" text DEFAULT 'dosespot' NOT NULL,
	"outcome" text NOT NULL,
	"outcome_reason" text,
	"supply_request_id" uuid,
	"patient_id" uuid,
	"medication_order_id" uuid NOT NULL,
	"dosespot_prescription_id" text NOT NULL,
	"dispensed_at" timestamp with time zone NOT NULL,
	"fill_number" integer,
	"dispensing_pharmacy_mdm_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supply_request_pharmacy_dispense_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "supply_request_pharmacy_dispense_source_chk" CHECK ("source" IN ('dosespot')),
	CONSTRAINT "supply_request_pharmacy_dispense_outcome_chk"
		CHECK ("outcome" IN ('recorded', 'no_correlating_request')),
	CONSTRAINT "supply_request_pharmacy_dispense_shape_chk" CHECK (
		("outcome" = 'recorded' AND "supply_request_id" IS NOT NULL AND "patient_id" IS NOT NULL)
		OR ("outcome" = 'no_correlating_request' AND "supply_request_id" IS NULL
			AND "patient_id" IS NULL AND "outcome_reason" IS NOT NULL)
	)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "supply_request_pharmacy_dispense_event_request_uq"
	ON "supply_request_pharmacy_dispense" ("organization_id", "source_event_id", "supply_request_id")
	WHERE "supply_request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "supply_request_pharmacy_dispense_event_unmatched_uq"
	ON "supply_request_pharmacy_dispense" ("organization_id", "source_event_id")
	WHERE "supply_request_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supply_request_pharmacy_dispense_request_ix"
	ON "supply_request_pharmacy_dispense" ("organization_id", "supply_request_id")
	WHERE "supply_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supply_request_pharmacy_dispense_patient_ix"
	ON "supply_request_pharmacy_dispense" ("organization_id", "patient_id")
	WHERE "patient_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "supply_request_pharmacy_dispense" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supply_request_pharmacy_dispense" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "supply_request_pharmacy_dispense_org" ON "supply_request_pharmacy_dispense"
	FOR ALL TO wardenx_app
	USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "supply_request_pharmacy_dispense" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "supply_request_pharmacy_dispense" TO wardenx_admin;--> statement-breakpoint

-- M4 write-audit trigger (the 0303 / 0106 shape). Structural only: no free-text column, empty denylist.
CREATE OR REPLACE FUNCTION audit_phi_write_supply_request_pharmacy_dispense() RETURNS trigger
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
    'supply_request_pharmacy_dispense.' || lower(TG_OP),
    'supply_request_pharmacy_dispense',
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
ALTER FUNCTION audit_phi_write_supply_request_pharmacy_dispense() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_supply_request_pharmacy_dispense" AFTER INSERT OR UPDATE OR DELETE ON supply_request_pharmacy_dispense
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_supply_request_pharmacy_dispense();
