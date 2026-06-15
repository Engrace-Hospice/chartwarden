CREATE TYPE "public"."break_glass_status" AS ENUM('active', 'cosign_pending', 'expired', 'revoked', 'denied');--> statement-breakpoint
CREATE TYPE "public"."engagement_status" AS ENUM('scheduled', 'active', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."engagement_type" AS ENUM('cms_survey', 'state_survey', 'tpe_probe', 'upic_investigation', 'cost_report_field_audit', 'financial_audit', 'accreditation', 'other');--> statement-breakpoint
CREATE TYPE "public"."role_category" AS ENUM('clinical_staff', 'clinical_leadership', 'operations', 'admin_executive', 'billing_finance', 'compliance_quality', 'volunteer', 'patient_family', 'external_auditor', 'external_collaborator', 'platform_staff', 'temporary_special');--> statement-breakpoint
CREATE TYPE "public"."scope_level" AS ENUM('organization', 'provider_entity', 'location', 'patient');--> statement-breakpoint
CREATE TABLE "permission" (
	"key" text PRIMARY KEY NOT NULL,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"category" text NOT NULL,
	"default_abac" text,
	"description" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"category" "role_category" NOT NULL,
	"scope_level" "scope_level" DEFAULT 'location' NOT NULL,
	"system_default" boolean DEFAULT false NOT NULL,
	"system_locked" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"role_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	"abac_override" text
);
--> statement-breakpoint
CREATE TABLE "membership_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "break_glass_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"target_organization_id" uuid,
	"actor_user_id" uuid NOT NULL,
	"target_patient_id" uuid,
	"reason" text NOT NULL,
	"status" "break_glass_status" DEFAULT 'active' NOT NULL,
	"cosign_required" boolean DEFAULT false NOT NULL,
	"cosigned_by" uuid,
	"consent_ref" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auditor_engagement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"engagement_type" "engagement_type" NOT NULL,
	"auditor_agency" text NOT NULL,
	"contact" text,
	"scope" jsonb NOT NULL,
	"status" "engagement_status" DEFAULT 'scheduled' NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auditor_engagement_window_chk" CHECK ("auditor_engagement"."start_at" < "auditor_engagement"."end_at")
);
--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_key_permission_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permission"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_role" ADD CONSTRAINT "membership_role_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_role" ADD CONSTRAINT "membership_role_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_role" ADD CONSTRAINT "membership_role_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_role" ADD CONSTRAINT "membership_role_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_event" ADD CONSTRAINT "break_glass_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_event" ADD CONSTRAINT "break_glass_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_event" ADD CONSTRAINT "break_glass_event_cosigned_by_user_id_fk" FOREIGN KEY ("cosigned_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auditor_engagement" ADD CONSTRAINT "auditor_engagement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auditor_engagement" ADD CONSTRAINT "auditor_engagement_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "role_org_key_idx" ON "role" USING btree ("organization_id","key");--> statement-breakpoint
CREATE INDEX "role_org_idx" ON "role" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_permission_idx" ON "role_permission" USING btree ("role_id","permission_key");--> statement-breakpoint
CREATE INDEX "role_permission_org_idx" ON "role_permission" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_role_idx" ON "membership_role" USING btree ("membership_id","role_id");--> statement-breakpoint
CREATE INDEX "membership_role_membership_idx" ON "membership_role" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "membership_role_org_idx" ON "membership_role" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "break_glass_org_idx" ON "break_glass_event" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "break_glass_actor_idx" ON "break_glass_event" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "break_glass_active_idx" ON "break_glass_event" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "engagement_org_idx" ON "auditor_engagement" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "engagement_window_idx" ON "auditor_engagement" USING btree ("start_at","end_at");