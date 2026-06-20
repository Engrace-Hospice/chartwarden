-- M40 Master Data Management §3.3–3.5 / §3.9 — M40-T03 tables (drizzle-generated, hand-augmented
-- with the leading CREATE EXTENSION). The 11 manifest-owned MDM tables, enums, indexes, FKs and
-- CHECK constraints. RLS (the locked two-table canonical/overlay pattern), the `mdm_canonical_writer`
-- role, grants and the write-audit triggers land in the companion 0019 migration.
--
-- M40 owns 11 tables (the manifest is authoritative; the spec's §3.6/§3.7 examples list the full
-- seven-kind canonical/overlay superset, but Phase 1 ships canonical tables for only physician/
-- facility/payer, the single physician overlay, plus the cross-cutting workflow + NPPES sync +
-- BAA tables — §2.3, the `wave-b-m40-t01` scope note). Seven carry NO organization_id by design
-- (canonical external_physician/facility/payer, the cross-cutting entity_relationship/merge_request,
-- the platform-operational nppes_sync_log/nppes_sync_coordination) and sit on the check-tenancy
-- NON_ORG_SCOPED allowlist; four are org-scoped (external_physician_tenant_overlay, mdm_provisional,
-- mdm_baa_record, mdm_baa_required) and take standard app.org_id RLS in 0019.
--
-- pg_trgm backs the gin_trgm_ops indexes on the canonical name/address columns (fuzzy match, §3.3).
-- It is already enabled by 0014 (M38); re-asserted here idempotently so this migration is
-- self-contained ahead of its index DDL.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."mdm_entity_status" AS ENUM('active', 'deactivated', 'merged', 'provisional');--> statement-breakpoint
CREATE TYPE "public"."mdm_entity_kind" AS ENUM('physician', 'facility', 'pharmacy', 'referral_source', 'payer', 'dme_vendor', 'funeral_home');--> statement-breakpoint
CREATE TYPE "public"."mdm_merge_status" AS ENUM('pending', 'approved', 'rejected', 'executed');--> statement-breakpoint
CREATE TYPE "public"."mdm_merge_proposer" AS ENUM('nppes', 'admin', 'tenant', 'fuzzy_job');--> statement-breakpoint
CREATE TYPE "public"."mdm_provisional_status" AS ENUM('pending', 'promoted', 'merged', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."mdm_nppes_sync_mode" AS ENUM('nightly_delta', 'weekly_full', 'on_demand');--> statement-breakpoint
CREATE TYPE "public"."mdm_baa_status" AS ENUM('executed', 'pending', 'n_a');--> statement-breakpoint
CREATE TYPE "public"."facility_kind" AS ENUM('hospital', 'alf', 'snf', 'ipu', 'clinic', 'other');--> statement-breakpoint
CREATE TYPE "public"."payer_kind" AS ENUM('medicare', 'medicaid', 'medicare_advantage', 'commercial', 'other');--> statement-breakpoint
CREATE TABLE "external_physician" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"npi" text,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"credentials" text,
	"is_np" boolean DEFAULT false NOT NULL,
	"specialty_taxonomy" text,
	"license_states" text[],
	"primary_address" jsonb,
	"contact_methods" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "mdm_entity_status" DEFAULT 'active' NOT NULL,
	"merged_into_id" uuid,
	"merged_from" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"nppes_last_synced_at" timestamp with time zone,
	"nppes_provenance" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_physician_npi_format" CHECK (npi IS NULL OR npi ~ '^[0-9]{10}$'),
	CONSTRAINT "external_physician_merged_consistency" CHECK ((status = 'merged') = (merged_into_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "external_physician_tenant_overlay" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_physician_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"preferred_contact_phone" text,
	"preferred_contact_email" text,
	"relationship_notes" text,
	"do_not_refer" boolean DEFAULT false NOT NULL,
	"is_preferred" boolean DEFAULT false NOT NULL,
	"preferred_rank" integer,
	"contract_terms" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ccn" text,
	"npi" text,
	"kind" "facility_kind" NOT NULL,
	"name" text NOT NULL,
	"primary_address" jsonb,
	"sending_facility_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "mdm_entity_status" DEFAULT 'active' NOT NULL,
	"merged_into_id" uuid,
	"merged_from" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_ccn_format" CHECK (ccn IS NULL OR ccn ~ '^[0-9A-Z]{6,10}$'),
	CONSTRAINT "facility_merged_consistency" CHECK ((status = 'merged') = (merged_into_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "payer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "payer_kind" NOT NULL,
	"state_code" text,
	"payer_id" text,
	"name" text NOT NULL,
	"status" "mdm_entity_status" DEFAULT 'active' NOT NULL,
	"merged_into_id" uuid,
	"merged_from" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_merged_consistency" CHECK ((status = 'merged') = (merged_into_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "entity_relationship" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_kind" "mdm_entity_kind" NOT NULL,
	"src_id" uuid NOT NULL,
	"dst_id" uuid NOT NULL,
	"relationship" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_relationship_not_self" CHECK (src_id <> dst_id)
);
--> statement-breakpoint
CREATE TABLE "merge_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_kind" "mdm_entity_kind" NOT NULL,
	"canonical_id" uuid NOT NULL,
	"duplicate_id" uuid NOT NULL,
	"proposed_by" "mdm_merge_proposer" NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" "mdm_merge_status" DEFAULT 'pending' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_request_not_self" CHECK (canonical_id <> duplicate_id)
);
--> statement-breakpoint
CREATE TABLE "nppes_sync_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mode" "mdm_nppes_sync_mode" NOT NULL,
	"looked_up" integer DEFAULT 0 NOT NULL,
	"changed" integer DEFAULT 0 NOT NULL,
	"deactivated" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"outcome" text NOT NULL,
	"error_summary" jsonb
);
--> statement-breakpoint
CREATE TABLE "nppes_sync_coordination" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_m29_sync_completed_at" timestamp,
	"last_m29_sync_run_id" text,
	"last_m40_legacy_run_completed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mdm_provisional" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_kind" "mdm_entity_kind" NOT NULL,
	"proposed_fields" jsonb NOT NULL,
	"resolution" "mdm_provisional_status" DEFAULT 'pending' NOT NULL,
	"promoted_canonical_id" uuid,
	"proposed_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mdm_baa_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_kind" "mdm_entity_kind" NOT NULL,
	"canonical_id" uuid NOT NULL,
	"baa_status" "mdm_baa_status" NOT NULL,
	"executed_on" date,
	"expires_on" date,
	"document_ref" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mdm_baa_required" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "mdm_entity_kind" NOT NULL,
	"required" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_physician" ADD CONSTRAINT "external_physician_merged_into_id_external_physician_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."external_physician"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_physician_tenant_overlay" ADD CONSTRAINT "external_physician_tenant_overlay_external_physician_id_external_physician_id_fk" FOREIGN KEY ("external_physician_id") REFERENCES "public"."external_physician"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_physician_tenant_overlay" ADD CONSTRAINT "external_physician_tenant_overlay_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_physician_tenant_overlay" ADD CONSTRAINT "external_physician_tenant_overlay_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility" ADD CONSTRAINT "facility_merged_into_id_facility_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."facility"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer" ADD CONSTRAINT "payer_merged_into_id_payer_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."payer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_request" ADD CONSTRAINT "merge_request_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_provisional" ADD CONSTRAINT "mdm_provisional_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_provisional" ADD CONSTRAINT "mdm_provisional_proposed_by_user_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_baa_record" ADD CONSTRAINT "mdm_baa_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdm_baa_required" ADD CONSTRAINT "mdm_baa_required_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_physician_npi_idx" ON "external_physician" USING btree ("npi") WHERE npi IS NOT NULL;--> statement-breakpoint
CREATE INDEX "external_physician_name_trgm_idx" ON "external_physician" USING gin ((first_name || ' ' || last_name) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "external_physician_status_idx" ON "external_physician" USING btree ("status");--> statement-breakpoint
CREATE INDEX "external_physician_merged_idx" ON "external_physician" USING btree ("merged_into_id") WHERE merged_into_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_external_physician_nppes_provenance_source" ON "external_physician" USING btree ((nppes_provenance->>'lastSyncSource')) WHERE nppes_provenance IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "external_physician_overlay_unique" ON "external_physician_tenant_overlay" USING btree ("external_physician_id","organization_id");--> statement-breakpoint
CREATE INDEX "external_physician_overlay_org_idx" ON "external_physician_tenant_overlay" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "facility_ccn_idx" ON "facility" USING btree ("ccn") WHERE ccn IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "facility_npi_idx" ON "facility" USING btree ("npi") WHERE npi IS NOT NULL;--> statement-breakpoint
CREATE INDEX "facility_name_trgm_idx" ON "facility" USING gin (name gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "facility_addr_trgm_idx" ON "facility" USING gin ((primary_address->>'line1') gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "idx_facility_sending_facility_codes_gin" ON "facility" USING gin ("sending_facility_codes");--> statement-breakpoint
CREATE UNIQUE INDEX "payer_x12_idx" ON "payer" USING btree ("payer_id") WHERE payer_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payer_name_trgm_idx" ON "payer" USING gin (name gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "payer_kind_state_idx" ON "payer" USING btree ("kind","state_code");--> statement-breakpoint
CREATE INDEX "entity_relationship_src_idx" ON "entity_relationship" USING btree ("entity_kind","src_id");--> statement-breakpoint
CREATE INDEX "entity_relationship_dst_idx" ON "entity_relationship" USING btree ("entity_kind","dst_id");--> statement-breakpoint
CREATE INDEX "merge_request_status_idx" ON "merge_request" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_request_unique_pair" ON "merge_request" USING btree ("entity_kind","canonical_id","duplicate_id") WHERE status IN ('pending','approved');--> statement-breakpoint
CREATE INDEX "nppes_sync_log_run_at_idx" ON "nppes_sync_log" USING btree ("run_at");--> statement-breakpoint
CREATE INDEX "mdm_provisional_org_kind_idx" ON "mdm_provisional" USING btree ("organization_id","entity_kind");--> statement-breakpoint
CREATE INDEX "mdm_provisional_resolution_idx" ON "mdm_provisional" USING btree ("resolution");--> statement-breakpoint
CREATE UNIQUE INDEX "mdm_baa_unique" ON "mdm_baa_record" USING btree ("organization_id","entity_kind","canonical_id");--> statement-breakpoint
CREATE INDEX "mdm_baa_expires_idx" ON "mdm_baa_record" USING btree ("expires_on") WHERE expires_on IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mdm_baa_required_unique" ON "mdm_baa_required" USING btree ("organization_id","kind");
