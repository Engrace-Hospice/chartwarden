-- M29 External Interfaces §3.3 — hl7_inbound_proposal, monthly PARTITION BY RANGE (proposed_at). In its own
-- file (check-ddl-legality rule 1: one partition column per file; the composite PK is (id, proposed_at)).
-- RLS, grants and the GENERATED M4 write-audit trigger are on the PARTITIONED PARENT in 0148 and propagate
-- to every partition.
--
-- TENANT-SCOPED (organization_id NOT NULL, canonical app.org_id RLS in 0148). §3.6 denylists
-- proposed_patient_candidate (the parsed PID demographic candidate — PHI), captured by its hash digest; the
-- status / match_outcome / decision columns stay verbatim as §164.528 evidence. FK POLICY: source_message_id
-- references the PARTITIONED hl7_message_inbound (app-side); organization_id / matched_patient_id /
-- decided_by_membership_id / accepted_aggregate_id are LOGICAL uuids validated at the write boundary.
-- owner_module is a text column validated against 'm5' | 'm6' at the write boundary.
CREATE TABLE IF NOT EXISTS "hl7_inbound_proposal" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_message_id" uuid NOT NULL,
	"resource_kind" "hl7_inbound_proposal_kind" NOT NULL,
	"proposed_patient_candidate" jsonb NOT NULL,
	"match_outcome" "hl7_inbound_match_outcome" NOT NULL,
	"matched_patient_id" uuid,
	"match_confidence" numeric(4, 3),
	"match_candidate_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"owner_module" text DEFAULT 'm5' NOT NULL,
	"proposal_status" "hl7_inbound_proposal_status" DEFAULT 'pending' NOT NULL,
	"decided_by_membership_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_rationale" text,
	"accepted_aggregate_id" uuid,
	"validation_errors" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "hl7_inbound_proposal_pkey" PRIMARY KEY ("id","proposed_at")
) PARTITION BY RANGE ("proposed_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_hl7_inbound_proposal_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'hl7_inbound_proposal_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF hl7_inbound_proposal FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF hl7_inbound_proposal DEFAULT', 'hl7_inbound_proposal_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_hl7_inbound_proposal_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hip_org_status" ON "hl7_inbound_proposal" ("organization_id","proposal_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hip_expires" ON "hl7_inbound_proposal" ("expires_at") WHERE proposal_status = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_hip_matched_patient" ON "hl7_inbound_proposal" ("matched_patient_id") WHERE matched_patient_id IS NOT NULL;
