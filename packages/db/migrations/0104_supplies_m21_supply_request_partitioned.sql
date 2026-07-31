-- M21 Supplies §3.1.7 / §3.6 — `supply_request`, D1's ONE shared row across all four kinds
-- (dme | supply | comfort_kit_deploy | comfort_kit_replenish), discriminated by `kind` with the per-kind
-- payload in the TypeBox-validated `data` jsonb. Four near-identical tables would have meant four copies of
-- the §2.2 lifecycle, four cancellation cascades, and four places for M11 to look.
--
-- D12: partitioned monthly by RANGE (created_at) with the composite PRIMARY KEY (id, created_at). In its OWN
-- file because check-ddl-legality derives one partition column per FILE and then requires every PK/UNIQUE in
-- that file to include it — 0103's nine tables are keyed on `id` alone and 0105's dispatch is keyed on
-- (id, dispatched_at). RLS, grants and the M4 write-audit trigger are declared on the PARENT in 0106 and
-- propagate to every partition (PG11+, the M25 0082/0083 and M30 incident_report precedent).
--
-- WHY THIS TABLE IS PARTITIONED: it is the highest-volume M21 table by an order of magnitude (every DME
-- item, every consumable resupply, every kit deploy and replenish, for every patient on service) and its
-- dominant reads are windowed — "this month's dispatch volume by vendor", "what is in flight at this
-- Location". Its two seam reads (`getSupplyRequestStatus`, `isTerminal`) are single-row by id and are given
-- the created_at partition key by the caller.
--
-- PROVENANCE CHECK — DEVIATION FROM §3.1.7 (documented, narrow): the spec additionally requires
-- `source_order_id IS NOT NULL` on every non-replenish kind, which makes §4.8's `createDirectSupplyRequest`
-- — the coordinator's direct entry, whose published input types `sourceOrderId` as `OrderRecordId | null` —
-- impossible to write. The replenish branch is kept VERBATIM (a replenish carries its outbox event and never
-- an order); the non-replenish branch is loosened only to "must not carry a replenishment event", and the
-- second CHECK closes the hole that opens: no order and no replenishment event means a named human
-- requester, so an unattributed request still cannot exist.
--
-- §3.0 / M21-F04 FOLDS from the §3.2 draft, kept to what §4/§7 actually use: the invoice columns backing
-- D16's accrual/reconciliation events and `SupplyCostProvider` (integer CENTS, not the draft's text dollars
-- — `M21SupplyRequestInvoiceAccruedPayload`, locked in M21-T01, publishes `invoiceTotalCents`, and a
-- rounding drift on a cap-relevant accrual is a reportable finding), the M22 `delivery_evidence_document_id`
-- that `SupplyCourierAttestation.evidenceDocumentId` publishes, and `requested_by_membership_id`. The
-- draft's `courier_attestation_jsonb` + `caregiver_signature_request_id` are deliberately NOT folded: §3.1
-- already stores the attestation as the three discrete columns the seam type names, and a jsonb copy of
-- columns that already exist is a second source of truth.
--
-- CROSS-MODULE FK POLICY: only organization_id / provider_entity_id / location_id (M1 core) carry real FKs.
-- patient_id (M5), admission_id (M6), source_order_id (M11), source_replenishment_event_id (M1 outbox),
-- assigned_vendor_id + pharmacy_partner_id (M40), the M22 document ids and every `*_membership_id` (M2) are
-- LOGICAL uuid, validated at the write boundary.
CREATE TABLE IF NOT EXISTS "supply_request" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"source_order_id" uuid,
	"source_replenishment_event_id" uuid,
	"requested_by_membership_id" uuid,
	"kind" "m21_supply_request_kind" NOT NULL,
	"data" jsonb NOT NULL,
	"status" "m21_supply_request_status" DEFAULT 'requested' NOT NULL,
	"assigned_vendor_id" uuid,
	"routing_rule_resolved_jsonb" jsonb,
	"pharmacy_partner_id" uuid,
	"document_id" uuid,
	"vendor_order_reference" text,
	"tracking_number" text,
	"carrier" text,
	"ordered_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"delivered_by_membership_id" uuid,
	"delivery_method" "m21_delivery_method",
	"delivery_evidence_document_id" uuid,
	"received_confirmed_at" timestamp with time zone,
	"received_confirmed_actor" text,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_pending_at" timestamp with time zone,
	"cancellation_reason" text,
	"cancellation_vendor_response_jsonb" jsonb,
	"delivery_instructions" text,
	"invoice_total_cents" bigint,
	"invoice_currency" text DEFAULT 'USD' NOT NULL,
	"invoice_accrued_at" timestamp with time zone,
	"invoice_reconciled_at" timestamp with time zone,
	"invoice_variance_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supply_request_pkey" PRIMARY KEY ("id","created_at"),
	CONSTRAINT "m21_supply_request_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m21_supply_request_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m21_supply_request_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m21_supply_request_provenance" CHECK (("kind" = 'comfort_kit_replenish' AND "source_replenishment_event_id" IS NOT NULL AND "source_order_id" IS NULL) OR ("kind" <> 'comfort_kit_replenish' AND "source_replenishment_event_id" IS NULL)),
	CONSTRAINT "m21_supply_request_attributed" CHECK ("source_order_id" IS NOT NULL OR "source_replenishment_event_id" IS NOT NULL OR "requested_by_membership_id" IS NOT NULL),
	CONSTRAINT "m21_supply_request_routing_frozen" CHECK ("status" NOT IN ('vendor_assigned','ordered','in_transit','delivered','received_confirmed','completed','returned') OR "routing_rule_resolved_jsonb" IS NOT NULL),
	CONSTRAINT "m21_supply_request_received_actor" CHECK ("received_confirmed_actor" IS NULL OR "received_confirmed_actor" IN ('caregiver','patient','supply_team','system_auto_confirm'))
) PARTITION BY RANGE ("created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_supply_request_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'supply_request_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF supply_request FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF supply_request DEFAULT', 'supply_request_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_supply_request_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supply_request_org_status_idx" ON "supply_request" ("organization_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supply_request_patient_idx" ON "supply_request" ("organization_id","patient_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supply_request_admission_idx" ON "supply_request" ("organization_id","admission_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supply_request_source_order_idx" ON "supply_request" ("source_order_id") WHERE source_order_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supply_request_source_replenish_idx" ON "supply_request" ("source_replenishment_event_id") WHERE source_replenishment_event_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supply_request_vendor_idx" ON "supply_request" ("assigned_vendor_id","status") WHERE assigned_vendor_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supply_request_in_flight_idx" ON "supply_request" ("organization_id","location_id","created_at" DESC NULLS LAST) WHERE status IN ('requested','vendor_assigned','ordered','in_transit','delivered');
