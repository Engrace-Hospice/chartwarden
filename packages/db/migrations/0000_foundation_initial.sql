CREATE TYPE "public"."audit_actor_kind" AS ENUM('user', 'system', 'integration', 'external_collaborator');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('success', 'failure', 'denied');--> statement-breakpoint
CREATE TYPE "public"."audit_retention_class" AS ENUM('operational', 'compliance', 'legal_hold');--> statement-breakpoint
CREATE TYPE "public"."audit_severity" AS ENUM('info', 'warn', 'critical');--> statement-breakpoint
CREATE TYPE "public"."feature_flag_kind" AS ENUM('product', 'rollout', 'kill_switch', 'migration');--> statement-breakpoint
CREATE TYPE "public"."feature_flag_value_type" AS ENUM('bool', 'string', 'number', 'json');--> statement-breakpoint
CREATE TYPE "public"."location_status" AS ENUM('created', 'active', 'suspended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('pending', 'active', 'suspended', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."organization_status" AS ENUM('created', 'active', 'suspended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."outbox_event_status" AS ENUM('pending', 'dispatching', 'dispatched', 'failed');--> statement-breakpoint
CREATE TYPE "public"."provider_entity_status" AS ENUM('created', 'active', 'suspended', 'closed');--> statement-breakpoint
CREATE TYPE "public"."system_status_value" AS ENUM('operational', 'degraded', 'outage');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('created', 'active', 'suspended', 'deactivated');--> statement-breakpoint
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"legal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"status" "organization_status" DEFAULT 'created' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "provider_entity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"ccn" text NOT NULL,
	"legal_name" text NOT NULL,
	"doing_business_as" text,
	"fiscal_intermediary" text,
	"npi" text NOT NULL,
	"tax_id_encrypted" text NOT NULL,
	"fiscal_year_end" text NOT NULL,
	"addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "provider_entity_status" DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"postal_code" text NOT NULL,
	"phone" text,
	"fax" text,
	"timezone" text NOT NULL,
	"service_area" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "location_status" DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text,
	"image" text,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" "membership_status" DEFAULT 'pending' NOT NULL,
	"default_location_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_provider_entity_id" uuid,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"invited_by" uuid
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"active_organization_id" uuid,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	"password_hash" text,
	"access_token_encrypted" text,
	"refresh_token_encrypted" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" uuid,
	"actor_user_id" uuid,
	"actor_kind" "audit_actor_kind" NOT NULL,
	"actor_role" text,
	"event_type" text NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" uuid,
	"correlation_id" text NOT NULL,
	"request_id" text,
	"trace_id" text,
	"source_ip" text,
	"user_agent" text,
	"outcome" "audit_outcome" NOT NULL,
	"severity" "audit_severity" DEFAULT 'info' NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retention_class" "audit_retention_class" DEFAULT 'compliance' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_status" (
	"id" text PRIMARY KEY NOT NULL,
	"status" "system_status_value" DEFAULT 'operational' NOT NULL,
	"headline" text,
	"details" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "feature_flag_evaluation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_id" uuid NOT NULL,
	"organization_id" uuid,
	"user_id" uuid,
	"evaluated_value" jsonb NOT NULL,
	"targeting_matched" text,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"flag_key" text NOT NULL,
	"flag_kind" "feature_flag_kind" DEFAULT 'product' NOT NULL,
	"value_type" "feature_flag_value_type" NOT NULL,
	"value" jsonb NOT NULL,
	"rollout_percent" integer,
	"targeting" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kill_switch_active" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"rationale" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "idempotency_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" text NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_kind" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_event_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organization_settings_registry" (
	"settings_key" text PRIMARY KEY NOT NULL,
	"registered_by_module" text NOT NULL,
	"description" text NOT NULL,
	"registry_entry_json" jsonb NOT NULL,
	"registered_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_event_catalog" (
	"event_name" text PRIMARY KEY NOT NULL,
	"module_owner" text NOT NULL,
	"description" text NOT NULL,
	"payload_schema" jsonb NOT NULL,
	"declared_consumers" text[] DEFAULT '{}' NOT NULL,
	"is_outbox_only" boolean DEFAULT true NOT NULL,
	"registered_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_entity" ADD CONSTRAINT "provider_entity_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location" ADD CONSTRAINT "location_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_status" ADD CONSTRAINT "system_status_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag_evaluation" ADD CONSTRAINT "feature_flag_evaluation_flag_id_feature_flag_id_fk" FOREIGN KEY ("flag_id") REFERENCES "public"."feature_flag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag" ADD CONSTRAINT "feature_flag_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag" ADD CONSTRAINT "feature_flag_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag" ADD CONSTRAINT "feature_flag_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_status_idx" ON "organization" USING btree ("status");--> statement-breakpoint
CREATE INDEX "organization_created_at_idx" ON "organization" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_entity_ccn_idx" ON "provider_entity" USING btree ("ccn");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_entity_npi_idx" ON "provider_entity" USING btree ("npi");--> statement-breakpoint
CREATE INDEX "provider_entity_org_idx" ON "provider_entity" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "location_provider_entity_idx" ON "location" USING btree ("provider_entity_id");--> statement-breakpoint
CREATE INDEX "location_state_idx" ON "location" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_idx" ON "user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "user_status_idx" ON "user" USING btree ("status");--> statement-breakpoint
CREATE INDEX "membership_user_org_idx" ON "membership" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_active_unique_idx" ON "membership" USING btree ("user_id","organization_id") WHERE "membership"."status" != 'revoked';--> statement-breakpoint
CREATE INDEX "membership_status_idx" ON "membership" USING btree ("status");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_expires_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "account_user_provider_idx" ON "account" USING btree ("user_id","provider_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verification_expires_idx" ON "verification" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "audit_event_org_created_idx" ON "audit_event" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_event_event_type_created_idx" ON "audit_event" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE INDEX "audit_event_actor_user_created_idx" ON "audit_event" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_event_resource_idx" ON "audit_event" USING btree ("resource_kind","resource_id");--> statement-breakpoint
CREATE INDEX "audit_event_correlation_idx" ON "audit_event" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "feature_flag_eval_flag_idx" ON "feature_flag_evaluation" USING btree ("flag_id","evaluated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flag_key_org_idx" ON "feature_flag" USING btree ("flag_key","organization_id");--> statement-breakpoint
CREATE INDEX "feature_flag_kind_idx" ON "feature_flag" USING btree ("flag_kind");--> statement-breakpoint
CREATE INDEX "feature_flag_expires_idx" ON "feature_flag" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_org_key_idx" ON "idempotency_key" USING btree ("organization_id","key");--> statement-breakpoint
CREATE INDEX "idempotency_expires_idx" ON "idempotency_key" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "outbox_status_created_idx" ON "outbox_event" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "outbox_org_idx" ON "outbox_event" USING btree ("organization_id");