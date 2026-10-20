-- M18 / PR E.1 — durable capture-level idempotency across every evv_event partition.
-- This table is intentionally not partitioned by event_at: its UNIQUE identity remains global when a
-- capture crosses a month boundary or lands in evv_event_default. Receipts are append-only and have no
-- time-based purge. Any future archival must preserve the unique identity for the full medico-legal
-- lifetime; dropping a receipt while its local_id can be replayed is prohibited.
CREATE TABLE "evv_offline_capture_receipt" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "evv_device_id" uuid NOT NULL,
  "local_id" uuid NOT NULL,
  "posting_membership_id" uuid NOT NULL,
  "payload_fingerprint" text NOT NULL,
  "fingerprint_key_id" text NOT NULL,
  "event_id" uuid NOT NULL,
  "event_at" timestamp with time zone NOT NULL,
  "kind" "evv_event_kind" NOT NULL,
  "captured_at" timestamp with time zone NOT NULL,
  "gps_quality" "evv_event_gps_quality" NOT NULL,
  "geofence_decision" text NOT NULL,
  "visit_state_after_event" text,
  "synced_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "evv_offline_capture_receipt_id_pk" PRIMARY KEY ("id"),
  CONSTRAINT "evv_offline_receipt_fingerprint_check" CHECK ("payload_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "evv_offline_receipt_key_id_check" CHECK (length("fingerprint_key_id") BETWEEN 1 AND 64),
  CONSTRAINT "evv_offline_receipt_geofence_check" CHECK ("geofence_decision" IN ('pass','fail_distance','fail_accuracy','fail_no_baseline')),
  CONSTRAINT "evv_offline_capture_receipt_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT,
  CONSTRAINT "evv_offline_capture_receipt_device_fk" FOREIGN KEY ("evv_device_id") REFERENCES "evv_device"("id") ON DELETE RESTRICT,
  CONSTRAINT "evv_offline_capture_receipt_membership_fk" FOREIGN KEY ("posting_membership_id") REFERENCES "membership"("id") ON DELETE RESTRICT
);--> statement-breakpoint
CREATE UNIQUE INDEX "evv_offline_receipt_capture_uidx"
  ON "evv_offline_capture_receipt" ("organization_id", "evv_device_id", "local_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evv_offline_receipt_event_uidx"
  ON "evv_offline_capture_receipt" ("organization_id", "event_id");--> statement-breakpoint
CREATE INDEX "evv_offline_receipt_membership_idx"
  ON "evv_offline_capture_receipt" ("organization_id", "posting_membership_id");--> statement-breakpoint

ALTER TABLE "evv_offline_capture_receipt" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "evv_offline_capture_receipt" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "evv_offline_capture_receipt_org" ON "evv_offline_capture_receipt"
  FOR ALL TO wardenx_app
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "evv_offline_capture_receipt" TO wardenx_app;--> statement-breakpoint
GRANT ALL ON "evv_offline_capture_receipt" TO wardenx_admin;--> statement-breakpoint

CREATE OR REPLACE FUNCTION evv_offline_capture_receipt_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'EVV_OFFLINE_CAPTURE_RECEIPT_APPEND_ONLY';
END $$;--> statement-breakpoint
CREATE TRIGGER "evv_offline_capture_receipt_append_only_trg"
  BEFORE UPDATE OR DELETE ON "evv_offline_capture_receipt"
  FOR EACH ROW EXECUTE FUNCTION evv_offline_capture_receipt_append_only();--> statement-breakpoint

-- Fingerprints are denylisted from audit payloads. The remaining projection is coordinate-free and contains
-- no patient identifier. Retention is the existing M18 compliance/evv_record class.
CREATE OR REPLACE FUNCTION audit_phi_write_evv_offline_capture_receipt() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_after jsonb;
BEGIN
  v_after := audit_scrub(to_jsonb(NEW), ARRAY['payload_fingerprint']::text[]);
  INSERT INTO audit_event (
    organization_id, actor_user_id, actor_kind, event_type, resource_kind,
    resource_id, correlation_id, outcome, severity, before, after, context, retention_class
  ) VALUES (
    NEW.organization_id,
    NULLIF(current_setting('app.user_id', true), '')::uuid,
    'user', 'evv_offline_capture_receipt.insert', 'evv_offline_capture_receipt', NEW.id,
    COALESCE(NULLIF(current_setting('app.correlation_id', true), ''), 'system'),
    'success', 'info', NULL, v_after, '{}'::jsonb, 'compliance'
  );
  RETURN NEW;
END $$;--> statement-breakpoint
ALTER FUNCTION audit_phi_write_evv_offline_capture_receipt() OWNER TO wardenx_audit_writer;--> statement-breakpoint
CREATE TRIGGER "trg_audit_evv_offline_capture_receipt"
  AFTER INSERT ON evv_offline_capture_receipt
  FOR EACH ROW EXECUTE FUNCTION audit_phi_write_evv_offline_capture_receipt();--> statement-breakpoint

COMMENT ON TABLE "evv_offline_capture_receipt" IS
  'M18 durable append-only offline EVV idempotency receipts. Non-partitioned so (organization, device, local_id) is globally unique; no automatic expiry.';
