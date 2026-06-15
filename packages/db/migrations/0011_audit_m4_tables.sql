CREATE TYPE "public"."audit_export_format" AS ENUM('csv', 'ndjson', 'pdf');--> statement-breakpoint
CREATE TYPE "public"."destruction_status" AS ENUM('pending', 'approved', 'held', 'executed', 'partial_refused');--> statement-breakpoint
CREATE TYPE "public"."legal_hold_status" AS ENUM('active', 'released');--> statement-breakpoint
CREATE TYPE "public"."phi_denylist_category" AS ENUM('pii_high_sensitivity', 'sud_value', 'narrative_free_text');--> statement-breakpoint
CREATE TABLE "legal_hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"criteria" jsonb NOT NULL,
	"status" "legal_hold_status" DEFAULT 'active' NOT NULL,
	"reason" text NOT NULL,
	"applied_by" uuid,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "destruction_certificate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"data_class" text NOT NULL,
	"record_count" integer NOT NULL,
	"date_range_start" timestamp with time zone NOT NULL,
	"date_range_end" timestamp with time zone NOT NULL,
	"method" text NOT NULL,
	"status" "destruction_status" DEFAULT 'pending' NOT NULL,
	"approved_by" uuid,
	"executed_at" timestamp with time zone,
	"certificate_pdf_ref" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "state_retention_override" (
	"state_code" text NOT NULL,
	"data_class" text NOT NULL,
	"retention_spec" text NOT NULL,
	"citation" text NOT NULL,
	CONSTRAINT "state_retention_override_state_code_data_class_pk" PRIMARY KEY("state_code","data_class")
);
--> statement-breakpoint
CREATE TABLE "audit_export" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"scope" jsonb NOT NULL,
	"format" "audit_export_format" NOT NULL,
	"watermarked" boolean DEFAULT true NOT NULL,
	"file_ref" uuid,
	"record_count" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_seal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"partition" text NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"event_count" integer NOT NULL,
	"prev_chain_hash" text,
	"chain_hash" text NOT NULL,
	"algorithm" text DEFAULT 'sha256' NOT NULL,
	"sealed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_denylist_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_name" text NOT NULL,
	"column_name" text NOT NULL,
	"category" "phi_denylist_category" NOT NULL,
	"conditional_check" text,
	"registered_by_module" text NOT NULL,
	"declared_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_action_catalog" (
	"action" text PRIMARY KEY NOT NULL,
	"module_owner" text NOT NULL,
	"default_retention_class" "audit_retention_class" NOT NULL,
	"description" text NOT NULL,
	"denylist_categories" "phi_denylist_category"[] DEFAULT '{}' NOT NULL,
	"is_part_two_eligible" boolean DEFAULT false NOT NULL,
	"registered_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_applied_by_user_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destruction_certificate" ADD CONSTRAINT "destruction_certificate_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destruction_certificate" ADD CONSTRAINT "destruction_certificate_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_export" ADD CONSTRAINT "audit_export_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_export" ADD CONSTRAINT "audit_export_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_seal" ADD CONSTRAINT "audit_seal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legal_hold_org_idx" ON "legal_hold" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "destruction_cert_org_idx" ON "destruction_certificate" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "audit_export_org_idx" ON "audit_export" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "audit_export_status_idx" ON "audit_export" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_seal_partition_idx" ON "audit_seal" USING btree ("organization_id","partition");--> statement-breakpoint
CREATE INDEX "audit_seal_chain_idx" ON "audit_seal" USING btree ("sealed_at");