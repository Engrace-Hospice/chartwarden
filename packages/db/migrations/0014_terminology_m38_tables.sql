-- M38 Terminology §3.7 / §9.2 / M38-T03 — PostgreSQL extensions the terminology schema needs,
-- created BEFORE the index DDL below that depends on them: `pg_trgm` backs the `gin_trgm_ops`
-- fuzzy-display indexes on the per-system concept tables (§3.4); `vector` backs the
-- `concept_embedding` pgvector column + its HNSW index (§3.6, §7.7). `vector` is already enabled
-- by 0001 (M1); both are emitted IF NOT EXISTS so re-application is idempotent (spec §3.7 "assert
-- presence"). These two lines are the only hand-edit to this otherwise drizzle-generated file.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "public"."code_system_id" AS ENUM('icd10cm', 'icd10pcs', 'snomed', 'loinc', 'rxnorm', 'ndc', 'hcpcs', 'cvx', 'revenue', 'carc', 'rarc');--> statement-breakpoint
CREATE TYPE "public"."concept_status" AS ENUM('active', 'deprecated', 'retired');--> statement-breakpoint
CREATE TYPE "public"."deprecation_mapping_kind" AS ENUM('equivalent', 'broader', 'narrower', 'none', 'see_other');--> statement-breakpoint
CREATE TYPE "public"."terminology_update_action" AS ENUM('loaded', 'deprecated', 'expanded', 'embedded', 'tenant_extension_added', 'tenant_extension_removed');--> statement-breakpoint
CREATE TYPE "public"."value_set_scope" AS ENUM('platform', 'hospice', 'hqrp');--> statement-breakpoint
CREATE TYPE "public"."version_load_status" AS ENUM('loading', 'staged', 'active', 'superseded', 'failed');--> statement-breakpoint
CREATE TABLE "code_system" (
	"id" "code_system_id" PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"license_source" text NOT NULL,
	"source_uri" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_system_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_system_id" "code_system_id" NOT NULL,
	"version" text NOT NULL,
	"released_on" date NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"source_file_ref" text NOT NULL,
	"checksum" text NOT NULL,
	"status" "version_load_status" DEFAULT 'loading' NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"loaded_by" uuid
);
--> statement-breakpoint
CREATE TABLE "concept_icd10cm" (
	"code" text NOT NULL,
	"display" text NOT NULL,
	"status" "concept_status" NOT NULL,
	"effective_date" date NOT NULL,
	"end_date" date,
	"version_id" uuid NOT NULL,
	"is_billable_leaf" boolean DEFAULT false NOT NULL,
	"chapter" text,
	"parent_code" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_icd10cm_code_version_id_pk" PRIMARY KEY("code","version_id")
);
--> statement-breakpoint
CREATE TABLE "concept_snomed" (
	"code" text NOT NULL,
	"display" text NOT NULL,
	"status" "concept_status" NOT NULL,
	"effective_date" date NOT NULL,
	"end_date" date,
	"version_id" uuid NOT NULL,
	"fully_specified_name" text NOT NULL,
	"semantic_tag" text,
	"hierarchy_path" text[],
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_snomed_code_version_id_pk" PRIMARY KEY("code","version_id")
);
--> statement-breakpoint
CREATE TABLE "concept_loinc" (
	"code" text NOT NULL,
	"display" text NOT NULL,
	"status" "concept_status" NOT NULL,
	"effective_date" date NOT NULL,
	"end_date" date,
	"version_id" uuid NOT NULL,
	"component" text,
	"property" text,
	"time" text,
	"system" text,
	"scale" text,
	"method" text,
	"short_name" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_loinc_code_version_id_pk" PRIMARY KEY("code","version_id")
);
--> statement-breakpoint
CREATE TABLE "concept_rxnorm" (
	"code" text NOT NULL,
	"display" text NOT NULL,
	"status" "concept_status" NOT NULL,
	"effective_date" date NOT NULL,
	"end_date" date,
	"version_id" uuid NOT NULL,
	"tty" text NOT NULL,
	"ingredient_rxcui" text,
	"ndcs" text[],
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_rxnorm_code_version_id_pk" PRIMARY KEY("code","version_id")
);
--> statement-breakpoint
CREATE TABLE "value_set" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"scope" "value_set_scope" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "value_set_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"value_set_id" text NOT NULL,
	"system_id" "code_system_id" NOT NULL,
	"code" text NOT NULL,
	"member_effective" date NOT NULL,
	"member_end" date,
	"annotations" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "value_set_expansion" (
	"value_set_id" text NOT NULL,
	"system_id" "code_system_id" NOT NULL,
	"code" text NOT NULL,
	"as_of_lower" date NOT NULL,
	"as_of_upper" date,
	"annotations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "value_set_expansion_value_set_id_system_id_code_as_of_lower_pk" PRIMARY KEY("value_set_id","system_id","code","as_of_lower")
);
--> statement-breakpoint
CREATE TABLE "value_set_tenant_extension" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"value_set_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"system_id" "code_system_id" NOT NULL,
	"code" text NOT NULL,
	"reason" text NOT NULL,
	"added_by" uuid,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deprecation_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"system_id" "code_system_id" NOT NULL,
	"deprecated_code" text NOT NULL,
	"deprecation_effective" date NOT NULL,
	"successor_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"mapping_kind" "deprecation_mapping_kind" NOT NULL,
	"guidance" text,
	"created_in_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concept_embedding" (
	"system_id" "code_system_id" NOT NULL,
	"code" text NOT NULL,
	"asof_version" uuid NOT NULL,
	"embedding" vector(384) NOT NULL,
	"model_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concept_embedding_system_id_code_asof_version_pk" PRIMARY KEY("system_id","code","asof_version")
);
--> statement-breakpoint
CREATE TABLE "terminology_update_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"system_id" "code_system_id" NOT NULL,
	"version_id" uuid,
	"action" "terminology_update_action" NOT NULL,
	"concept_count" integer DEFAULT 0 NOT NULL,
	"new_codes" integer DEFAULT 0 NOT NULL,
	"retired_codes" integer DEFAULT 0 NOT NULL,
	"affected_value_sets" integer DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "code_system_version" ADD CONSTRAINT "code_system_version_code_system_id_code_system_id_fk" FOREIGN KEY ("code_system_id") REFERENCES "public"."code_system"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_system_version" ADD CONSTRAINT "code_system_version_loaded_by_user_id_fk" FOREIGN KEY ("loaded_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_icd10cm" ADD CONSTRAINT "concept_icd10cm_version_id_code_system_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."code_system_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_snomed" ADD CONSTRAINT "concept_snomed_version_id_code_system_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."code_system_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_loinc" ADD CONSTRAINT "concept_loinc_version_id_code_system_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."code_system_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_rxnorm" ADD CONSTRAINT "concept_rxnorm_version_id_code_system_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."code_system_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "value_set_member" ADD CONSTRAINT "value_set_member_value_set_id_value_set_id_fk" FOREIGN KEY ("value_set_id") REFERENCES "public"."value_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "value_set_expansion" ADD CONSTRAINT "value_set_expansion_value_set_id_value_set_id_fk" FOREIGN KEY ("value_set_id") REFERENCES "public"."value_set"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "value_set_tenant_extension" ADD CONSTRAINT "value_set_tenant_extension_value_set_id_value_set_id_fk" FOREIGN KEY ("value_set_id") REFERENCES "public"."value_set"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "value_set_tenant_extension" ADD CONSTRAINT "value_set_tenant_extension_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "value_set_tenant_extension" ADD CONSTRAINT "value_set_tenant_extension_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deprecation_mapping" ADD CONSTRAINT "deprecation_mapping_created_in_version_id_code_system_version_id_fk" FOREIGN KEY ("created_in_version_id") REFERENCES "public"."code_system_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_embedding" ADD CONSTRAINT "concept_embedding_asof_version_code_system_version_id_fk" FOREIGN KEY ("asof_version") REFERENCES "public"."code_system_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminology_update_log" ADD CONSTRAINT "terminology_update_log_version_id_code_system_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."code_system_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "code_system_version_unique" ON "code_system_version" USING btree ("code_system_id","version");--> statement-breakpoint
CREATE INDEX "code_system_version_current_idx" ON "code_system_version" USING btree ("code_system_id") WHERE status = 'active' AND effective_to IS NULL;--> statement-breakpoint
CREATE INDEX "code_system_version_effective_idx" ON "code_system_version" USING btree ("code_system_id","effective_from","effective_to");--> statement-breakpoint
CREATE INDEX "icd10cm_code_idx" ON "concept_icd10cm" USING btree ("code");--> statement-breakpoint
CREATE INDEX "icd10cm_asof_idx" ON "concept_icd10cm" USING btree ("code","effective_date","end_date");--> statement-breakpoint
CREATE INDEX "icd10cm_active_billable_idx" ON "concept_icd10cm" USING btree ("status") WHERE status = 'active' AND is_billable_leaf = true;--> statement-breakpoint
CREATE INDEX "icd10cm_parent_idx" ON "concept_icd10cm" USING btree ("parent_code");--> statement-breakpoint
CREATE INDEX "icd10cm_display_trgm_idx" ON "concept_icd10cm" USING gin (display gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "snomed_code_idx" ON "concept_snomed" USING btree ("code");--> statement-breakpoint
CREATE INDEX "snomed_semantic_tag_idx" ON "concept_snomed" USING btree ("semantic_tag");--> statement-breakpoint
CREATE INDEX "snomed_hierarchy_idx" ON "concept_snomed" USING gin (hierarchy_path);--> statement-breakpoint
CREATE INDEX "snomed_display_trgm_idx" ON "concept_snomed" USING gin (display gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "loinc_code_idx" ON "concept_loinc" USING btree ("code");--> statement-breakpoint
CREATE INDEX "loinc_axis_idx" ON "concept_loinc" USING btree ("component","property");--> statement-breakpoint
CREATE INDEX "loinc_display_trgm_idx" ON "concept_loinc" USING gin (display gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "rxnorm_code_idx" ON "concept_rxnorm" USING btree ("code");--> statement-breakpoint
CREATE INDEX "rxnorm_tty_idx" ON "concept_rxnorm" USING btree ("tty");--> statement-breakpoint
CREATE INDEX "rxnorm_ingredient_idx" ON "concept_rxnorm" USING btree ("ingredient_rxcui");--> statement-breakpoint
CREATE INDEX "rxnorm_display_trgm_idx" ON "concept_rxnorm" USING gin (display gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "value_set_member_unique" ON "value_set_member" USING btree ("value_set_id","system_id","code","member_effective");--> statement-breakpoint
CREATE INDEX "value_set_member_by_set_idx" ON "value_set_member" USING btree ("value_set_id");--> statement-breakpoint
CREATE INDEX "value_set_expansion_membership_idx" ON "value_set_expansion" USING btree ("system_id","code","value_set_id");--> statement-breakpoint
CREATE INDEX "value_set_expansion_asof_idx" ON "value_set_expansion" USING btree ("value_set_id","as_of_lower","as_of_upper");--> statement-breakpoint
CREATE UNIQUE INDEX "vs_tenant_ext_active_unique" ON "value_set_tenant_extension" USING btree ("value_set_id","organization_id","system_id","code") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE INDEX "vs_tenant_ext_org_idx" ON "value_set_tenant_extension" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "vs_tenant_ext_value_set_idx" ON "value_set_tenant_extension" USING btree ("value_set_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deprecation_mapping_unique" ON "deprecation_mapping" USING btree ("system_id","deprecated_code","deprecation_effective");--> statement-breakpoint
CREATE INDEX "concept_embedding_hnsw_idx" ON "concept_embedding" USING hnsw (embedding vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
CREATE INDEX "concept_embedding_system_idx" ON "concept_embedding" USING btree ("system_id");--> statement-breakpoint
CREATE INDEX "terminology_update_log_system_at_idx" ON "terminology_update_log" USING btree ("system_id","at");