-- M21 Supplies §3.1.8 / §3.6 — `comfort_kit_dispatch`, D6/D17's head of the 21 CFR §1304 chain of custody:
-- one row per physical kit that left a DEA registration, unified across every deployment site (home / ALF /
-- SNF-as-residence / IPU room) behind the single `deployment_site` discriminator. The per-medication lines
-- hang off it in `comfort_kit_dispatched_content` (declared in 0103 — it is unpartitioned and cannot share a
-- file with a composite-key table).
--
-- D12: partitioned monthly by RANGE (dispatched_at) with the composite PRIMARY KEY (id, dispatched_at). Its
-- OWN file, separate from `supply_request`'s 0104, because check-ddl-legality derives one partition column
-- per FILE and these two differ. RLS, grants and the M4 write-audit trigger are declared on the PARENT in
-- 0106 and propagate to every partition (PG11+).
--
-- WHY `dispatched_at` AND NOT `created_at`: the DEA question is always "what left the hub in March", and
-- `dispatched_at` is the fact a surveyor's date range is expressed in. Partitioning on row-creation time
-- would scatter one month's custody records across two partitions whenever a dispatch is recorded late.
--
-- §3.0 / M21-F04: §3.1 is normative — `kit_serial_number`, `dispatched_by_membership_id`,
-- `controlled_substance_handling_policy_digest`, `ipu_room_id`, `admission_id` and `location_id` are
-- restored, and the draft-only `m21_comfort_kit_dispatch_status` enum is folded IN (load-bearing in §5/§7
-- and in the published `ActiveDispatchView`). Two further folds the published types require:
-- `deployed_at_patient_at` + `deployed_by_membership_id`, which `M21ComfortKitDeployedAtPatientPayload`
-- (locked in M21-T01) publishes as `deployedAt` / `deployedByMembershipId` — a status enum with a
-- `deployed_at_patient` value and nowhere to record WHEN and BY WHOM would make that payload unbuildable.
-- `facility_identifier_jsonb` is folded per D17; D17's "required for non-home sites" stays a WRITE-BOUNDARY
-- rule rather than a CHECK, since §3.1 declares none and §3.1 governs the storage layer.
--
-- POLICY DIGEST, NOT POLICY POINTER: `controlled_substance_handling_policy_digest` freezes the template's
-- handling policy AS DISPATCHED. A tenant that loosens its lock-box rule next quarter must not retroactively
-- change what the courier was instructed to do on this kit. Same reasoning as
-- `routing_rule_resolved_jsonb` on the request.
--
-- CROSS-MODULE FK POLICY: organization_id / provider_entity_id / location_id (M1 core) and the UNPARTITIONED
-- intra-M21 `comfort_kit_template_id` carry real FKs. `supply_request_id` is LOGICAL — its target is
-- partitioned on a key this row does not carry as part of its own identity, so a real FK would need the
-- composite. patient_id (M5), admission_id (M6), pharmacy_partner_id (M40), bol_document_id (M22),
-- m13_deployment_id (M13), ipu_room_id (M37 forward seam) and every `*_membership_id` (M2) are logical uuid.
CREATE TABLE IF NOT EXISTS "comfort_kit_dispatch" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"supply_request_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"comfort_kit_template_id" uuid NOT NULL,
	"deployment_site" "m21_deployment_site" NOT NULL,
	"dispatch_status" "m21_comfort_kit_dispatch_status" DEFAULT 'dispatched' NOT NULL,
	"ipu_room_id" uuid,
	"facility_identifier_jsonb" jsonb,
	"pharmacy_dispatch_mode" "m21_pharmacy_dispatch_mode" NOT NULL,
	"dispatch_source" "m21_dispatch_source" NOT NULL,
	"pharmacy_partner_id" uuid,
	"kit_serial_number" text NOT NULL,
	"dispatched_by_membership_id" uuid NOT NULL,
	"dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deployed_at_patient_at" timestamp with time zone,
	"deployed_by_membership_id" uuid,
	"bol_document_id" uuid,
	"m13_deployment_id" uuid,
	"m13_deployment_link_resolved_at" timestamp with time zone,
	"controlled_substance_handling_policy_digest" text NOT NULL,
	"dispatched_contents_jsonb" jsonb NOT NULL,
	"special_handling_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comfort_kit_dispatch_pkey" PRIMARY KEY ("id","dispatched_at"),
	CONSTRAINT "m21_ckd_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckd_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckd_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckd_template_fk" FOREIGN KEY ("comfort_kit_template_id") REFERENCES "public"."comfort_kit_template"("id") ON DELETE restrict,
	CONSTRAINT "m21_ckit_dispatch_ipu_room_site" CHECK (("deployment_site" = 'ipu_room' AND "ipu_room_id" IS NOT NULL) OR ("deployment_site" <> 'ipu_room' AND "ipu_room_id" IS NULL)),
	CONSTRAINT "m21_ckit_dispatch_deploy_attributed" CHECK (("deployed_at_patient_at" IS NULL) = ("deployed_by_membership_id" IS NULL))
) PARTITION BY RANGE ("dispatched_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_comfort_kit_dispatch_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'comfort_kit_dispatch_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF comfort_kit_dispatch FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF comfort_kit_dispatch DEFAULT', 'comfort_kit_dispatch_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_comfort_kit_dispatch_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_dispatch_patient_idx" ON "comfort_kit_dispatch" ("organization_id","patient_id","dispatched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_dispatch_supply_req_idx" ON "comfort_kit_dispatch" ("supply_request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_dispatch_ipu_room_idx" ON "comfort_kit_dispatch" ("location_id","ipu_room_id") WHERE deployment_site = 'ipu_room';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_dispatch_m13_link_pending_idx" ON "comfort_kit_dispatch" ("dispatched_at") WHERE m13_deployment_id IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comfort_kit_dispatch_kit_serial_idx" ON "comfort_kit_dispatch" ("organization_id","kit_serial_number");
