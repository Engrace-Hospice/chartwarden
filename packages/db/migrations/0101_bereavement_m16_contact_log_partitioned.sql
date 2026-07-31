-- M16 Bereavement §3.3.5/§3.6 — `bereavement_contact_log`, the ONE partitioned M16 table (D12): monthly
-- PARTITION BY RANGE (contact_at), the M4 convention. In its OWN file because check-ddl-legality rule 1
-- derives one partition column per FILE and then requires every UNIQUE/PK in that file to include it — the
-- eight tables in 0100 are keyed on `id` alone, this one carries the composite (id, contact_at). RLS,
-- grants and the M4 write-audit trigger land in 0102, declared on the PARENT (they propagate to every
-- partition, PG11+ — the M25 0082/0083 and M30 incident_report precedent).
--
-- WHY THIS TABLE AND ONLY THIS TABLE: it is the only M16 table that grows with VOLUME rather than with
-- headcount. One outreach fans out to many logs (one anniversary letter → five addressees → five rows, all
-- referencing the one M22 document), and the log is never read as "current row" — it is read as a window
-- ("this contact's touchpoints", "what did we send in March"), which is exactly what partition pruning is for.
--
-- The table gets a create_bereavement_contact_log_partition(start_date) helper, a DEFAULT partition so
-- inserts work immediately, and 0..12 monthly leaves seeded from date_trunc('month', now()); the M1
-- partition manager rotates months forward. Retention runs at the partition level (§3.6): the M4 destruction
-- worker's eraseFn clears row data, and the partition file survives until M4's archival cron prunes empty
-- old partitions. Indexes are declared on the PARENT and propagate.
--
-- D15 M8 BOUNDARY — the CHECK PAIR is the point: an in-person bereavement visit is an M8 encounter and its
-- log MUST carry source_encounter_id; every other modality (phone, card, letter, email, portal message) is a
-- direct M16 write and MUST leave it NULL. Both directions are enforced — enforcing only the first lets a
-- mis-routed letter silently acquire an encounter id and double-count in M8's visit surface.
--
-- CROSS-MODULE FK POLICY: organization/provider_entity/location (M1 core) and the three intra-M16 parents
-- (plan, contact, outreach — all unpartitioned, so a partitioned child may legally reference them) carry
-- real FKs. source_encounter_id (M8), artifact_document_id (M22), logged_by_user_id (M2 membership) and
-- external_resource_id_from_m40 (M40) are LOGICAL uuid, validated at the write boundary.
CREATE TABLE IF NOT EXISTS "bereavement_contact_log" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"plan_id" uuid NOT NULL,
	"bereaved_contact_id" uuid NOT NULL,
	"outreach_id" uuid NOT NULL,
	"contact_at" timestamp with time zone NOT NULL,
	"kind" "bereavement_outreach_kind" NOT NULL,
	"outcome" "bereavement_contact_log_outcome" NOT NULL,
	"source_encounter_id" uuid,
	"contact_notes_cipher" text,
	"artifact_document_id" uuid,
	"logged_by_user_id" uuid NOT NULL,
	"logged_by_discipline" text,
	"contact_responded_directly" boolean DEFAULT false NOT NULL,
	"external_resource_id_from_m40" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bereavement_contact_log_pkey" PRIMARY KEY ("id","contact_at"),
	CONSTRAINT "berv_log_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "berv_log_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "berv_log_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "berv_log_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."bereavement_plan"("id") ON DELETE restrict,
	CONSTRAINT "berv_log_bereaved_contact_id_fk" FOREIGN KEY ("bereaved_contact_id") REFERENCES "public"."bereaved_contact"("id") ON DELETE restrict,
	CONSTRAINT "berv_log_outreach_id_fk" FOREIGN KEY ("outreach_id") REFERENCES "public"."bereavement_outreach"("id") ON DELETE restrict,
	CONSTRAINT "berv_log_in_person_requires_encounter" CHECK ("kind" <> 'in_person_visit' OR "source_encounter_id" IS NOT NULL),
	CONSTRAINT "berv_log_non_encounter_kinds_no_encounter" CHECK ("kind" = 'in_person_visit' OR "source_encounter_id" IS NULL)
) PARTITION BY RANGE ("contact_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_bereavement_contact_log_partition(start_date date) RETURNS void AS $$
DECLARE partition_name text; end_date date;
BEGIN
  partition_name := 'bereavement_contact_log_' || to_char(start_date, 'YYYY_MM');
  end_date := start_date + INTERVAL '1 month';
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF bereavement_contact_log FOR VALUES FROM (%L) TO (%L)', partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$ BEGIN EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF bereavement_contact_log DEFAULT', 'bereavement_contact_log_default'); END $$;--> statement-breakpoint
DO $$ DECLARE i int; BEGIN FOR i IN 0..12 LOOP PERFORM create_bereavement_contact_log_partition((date_trunc('month', now()) + (i || ' month')::interval)::date); END LOOP; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_log_plan_contact_idx" ON "bereavement_contact_log" ("plan_id","bereaved_contact_id","contact_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_log_outreach_idx" ON "bereavement_contact_log" ("outreach_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_log_logged_by_idx" ON "bereavement_contact_log" ("logged_by_user_id","contact_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "berv_log_encounter_idx" ON "bereavement_contact_log" ("source_encounter_id") WHERE source_encounter_id IS NOT NULL;
