-- dosespot_sync_queue — M12's §2.6 D4 / §2.8 D10 DoseSpot job queue (M12 `handlers-unbound` group,
-- #248). `decidePatientSyncTrigger`/`decideMedHxFetch` (`consumers/sync-triggers.ts`) have been complete,
-- pure, unit-tested deciders since M12-T08 with NO caller anywhere in the repository: `12-dosespot/` has
-- no `jobs/` directory, no BullMQ Queue/Worker construction, and the route service's `jobId` values are
-- hardcoded template strings, never a real enqueue. Six catalogued M5/M6 events
-- (`m5.patient.{created,updated,address_changed,payer_changed}`, `m6.{admission.activated,cti.signed}`)
-- declare `m12` as a consumer and nothing has ever consumed them — a demographic change never re-synced
-- the patient to DoseSpot; an admission activation or recertification never pulled MedicationHistory.
--
-- ONE PENDING ROW PER (organization_id, kind, patient_id) — a partial-unique index (the
-- `measure_recompute_queue` / migration 0062 precedent, F-150 #248) debounces repeated triggers for the
-- same patient onto the one still-pending job: two demographic updates in quick succession, or a
-- redelivery of the same outbox event, collapse rather than duplicate. `admission_id` is NOT part of the
-- debounce key deliberately — a second admission-driven MedHx pull for a patient whose sync is already
-- pending needs no separate row, since the pull is patient-scoped, not admission-scoped, at the DoseSpot
-- side.
--
-- `patient_id`/`admission_id` are PLAIN uuid with NO cross-module FK — the `medication_order.patient_id`/
-- `refill_request.patient_id` precedent (`packages/db/src/schema/dosespot/*.ts`, both commented
-- "M5 (app-validated; no cross-module FK)") applied a third time, and consistent with `sync-triggers.ts`'s
-- own header: every consumed event name is a string literal, so M12 gains no new `dependsOn` edge from
-- this table either. `admission_id` is nullable even for `medhx_fetch` — `m6.cti.signed`'s real payload
-- carries no admission id (only `electionPeriodId`), and resolving it needs a new M6 seam this pass's
-- isolated-file scope does not build (reported, not fabricated).
CREATE TABLE IF NOT EXISTS "dosespot_sync_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid,
	"invalidate_rx_benefit_cache" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"triggering_event_outbox_id" uuid,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	CONSTRAINT "dosespot_sync_queue_organization_id_organization_id_fk"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "dosespot_sync_queue_kind_chk"
		CHECK ("kind" IN ('patient_sync', 'medhx_fetch')),
	CONSTRAINT "dosespot_sync_queue_reason_chk"
		CHECK ("reason" IN ('created', 'updated', 'address_changed', 'payer_changed', 'admission_activated', 'recertification')),
	CONSTRAINT "dosespot_sync_queue_status_chk"
		CHECK ("status" IN ('pending', 'processing', 'completed', 'failed')),
	-- The reason vocabulary is kind-partitioned (patient-sync reasons vs. medhx-fetch reasons) — a row
	-- must not mix the two. `admission_id` is deliberately NOT required for `medhx_fetch`: the
	-- `admission_activated`-sourced job carries a real admission id from the M6 wire payload, but the
	-- `recertification`-sourced job (`m6.cti.signed`) does NOT — that event's payload carries
	-- `electionPeriodId`, never `admissionId`, and no published M6 seam resolves the reverse without a
	-- new cross-module read this pass's isolated-file scope does not build (see
	-- `jobs/sync-trigger-bindings.ts`'s header). `patient_sync` jobs never carry an admission at all.
	CONSTRAINT "dosespot_sync_queue_kind_reason_chk"
		CHECK (
			("kind" = 'patient_sync' AND "reason" IN ('created', 'updated', 'address_changed', 'payer_changed') AND "admission_id" IS NULL)
			OR
			("kind" = 'medhx_fetch' AND "reason" IN ('admission_activated', 'recertification'))
		)
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "dosespot_sync_queue_pending_uq"
	ON "dosespot_sync_queue" ("organization_id", "kind", "patient_id")
	WHERE "status" = 'pending';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "dosespot_sync_queue_org_status_ix"
	ON "dosespot_sync_queue" ("organization_id", "status", "enqueued_at");--> statement-breakpoint

-- RLS — the canonical app.org_id predicate (ADR-0010 D3), ENABLE + FORCE together (F-087, migration
-- 0118): FORCE is what makes the policy apply to the table's OWNER too, since `migrate.ts` connects as
-- `DATABASE_ADMIN_URL ?? DATABASE_URL` and a deployment that migrates with only DATABASE_URL set makes
-- wardenx_app the owner. NULLIF guard (migration 0246/0247 precedent) even though every real caller in
-- this pass opens `withOrgContext` first — free insurance against a pooled connection whose GUC reverted
-- to '' rather than NULL after a prior transaction.
ALTER TABLE "dosespot_sync_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dosespot_sync_queue" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "dosespot_sync_queue_org" ON "dosespot_sync_queue"
	FOR ALL TO wardenx_app
	USING (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
	WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "dosespot_sync_queue" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "dosespot_sync_queue" TO wardenx_admin;--> statement-breakpoint

-- Audit trigger — the `measure_recompute_queue` precedent (migration 0068): no PHI column, no denylist
-- entry needed, but the row still records who/what enqueued and processed a DoseSpot integration job
-- against a named patient, which is worth a compliance trail on its own.
CREATE OR REPLACE FUNCTION audit_phi_write_dosespot_sync_queue() RETURNS trigger
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
    'dosespot_sync_queue.' || lower(TG_OP),
    'dosespot_sync_queue',
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
ALTER FUNCTION audit_phi_write_dosespot_sync_queue() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_dosespot_sync_queue" AFTER INSERT OR UPDATE OR DELETE ON dosespot_sync_queue
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_dosespot_sync_queue();
