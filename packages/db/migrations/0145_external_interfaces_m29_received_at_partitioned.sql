-- M29 External Interfaces §3.3 — the THREE tables monthly PARTITIONED BY RANGE (received_at):
-- hl7_message_inbound, lab_observation, lab_observation_value. Grouped in one file because
-- check-ddl-legality rule 1 derives ONE partition column per FILE and then requires every PK/UNIQUE in it
-- to include that column — all three carry the composite PK (id, received_at), so the rule is satisfied.
-- Every non-PK index is a PLAIN (non-unique) index for the same reason (a UNIQUE on a partitioned table
-- must include the partition key; the idempotency/sha lookups are non-unique here and deduped in the
-- service). RLS, grants and the M4 write-audit trigger are declared on each PARTITIONED PARENT in 0148 and
-- propagate to every partition (PG11+; the M32 ai_invocation / M28 fhir_client_session precedent).
--
-- TENANT-SCOPED (organization_id NOT NULL, canonical app.org_id RLS in 0148). lab_observation is
-- PHI-bearing (patient_id) so it adds provider_entity_id NOT NULL + location_id (ARCH-011, architecture
-- wins over §3.3's literal shape). The two lab tables ADD organization_id vs §3.3 so each has its own RLS
-- policy. FK POLICY: organization_id and every cross-module / cross-partition reference is a LOGICAL uuid
-- validated at the write boundary — no DB FK from a partitioned child.

-- ============================================================================================
-- §3.3 hl7_message_inbound — every inbound HL7 wire message (raw DEK-encrypted; §3.6 denylist).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "hl7_message_inbound" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"feed_id" uuid NOT NULL,
	"message_type" text NOT NULL,
	"message_control_id" text NOT NULL,
	"payload_cipher" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"segments_summary" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parse_status" "hl7_inbound_parse_status" DEFAULT 'in_progress' NOT NULL,
	"parse_error" jsonb,
	"sending_facility_id" uuid,
	"sending_facility_raw_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"matched_patient_id" uuid,
	"match_level" "hl7_inbound_match_level",
	"match_outcome" "hl7_inbound_match_outcome",
	"match_confidence" numeric(4, 3),
	"cascade_run_ms" integer,
	"parsed_segments_cipher" text,
	"parsed_segments_sha256" text,
	CONSTRAINT "hl7_message_inbound_pkey" PRIMARY KEY ("id","received_at")
) PARTITION BY RANGE ("received_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_hl7_message_inbound_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'hl7_message_inbound_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF hl7_message_inbound FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF hl7_message_inbound DEFAULT', 'hl7_message_inbound_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_hl7_message_inbound_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hmi_org_feed" ON "hl7_message_inbound" ("organization_id","feed_id","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hmi_parse_status" ON "hl7_message_inbound" ("parse_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hmi_idempotency" ON "hl7_message_inbound" ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hmi_sha256" ON "hl7_message_inbound" ("payload_sha256");--> statement-breakpoint

-- ============================================================================================
-- §3.3 lab_observation — an ORU^R01 result matched to a patient (ARCH-011: provider_entity_id + location_id).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "lab_observation" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"source_message_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"order_id" uuid,
	"observation_date" timestamp with time zone NOT NULL,
	"collection_date" timestamp with time zone,
	"result_status" "lab_result_status" NOT NULL,
	"performing_lab_facility_id" uuid,
	"ordering_physician_npi" text,
	"loinc_code" text NOT NULL,
	"loinc_display_text" text NOT NULL,
	"terminology_validation" "lab_terminology_validation" NOT NULL,
	"abnormal_summary" "lab_abnormal_summary" NOT NULL,
	"attached_document_id" uuid,
	"sud_redacted_at_ingest" boolean DEFAULT false NOT NULL,
	"previous_observation_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_observation_pkey" PRIMARY KEY ("id","received_at")
) PARTITION BY RANGE ("received_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_lab_observation_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'lab_observation_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF lab_observation FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF lab_observation DEFAULT', 'lab_observation_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_lab_observation_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lo_org_patient" ON "lab_observation" ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lo_patient_date" ON "lab_observation" ("patient_id","observation_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lo_order" ON "lab_observation" ("order_id") WHERE order_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lo_abnormal" ON "lab_observation" ("abnormal_summary") WHERE abnormal_summary IN ('any_critical','any_abnormal');--> statement-breakpoint

-- ============================================================================================
-- §3.3 lab_observation_value — the per-OBX result row; co-partitioned with the parent on received_at.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "lab_observation_value" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"observation_id" uuid NOT NULL,
	"obx_set_id" integer NOT NULL,
	"loinc_code" text NOT NULL,
	"loinc_display_text" text NOT NULL,
	"terminology_validation" "lab_terminology_validation" NOT NULL,
	"value_type" "lab_value_type" NOT NULL,
	"numeric_value" numeric(18, 6),
	"string_value" text,
	"units" text,
	"reference_range" text,
	"abnormal_flag" "lab_abnormal_flag",
	"performed_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lab_observation_value_pkey" PRIMARY KEY ("id","received_at")
) PARTITION BY RANGE ("received_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_lab_observation_value_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'lab_observation_value_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF lab_observation_value FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF lab_observation_value DEFAULT', 'lab_observation_value_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_lab_observation_value_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lov_observation" ON "lab_observation_value" ("observation_id","obx_set_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lov_loinc" ON "lab_observation_value" ("loinc_code");
