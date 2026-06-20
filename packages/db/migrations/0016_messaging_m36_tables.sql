-- M36 Secure Messaging & Alerts §3.3–3.6 / §3.11 / §3.13 — M36-T03 tables (drizzle-generated).
-- The 15 manifest-owned messaging tables, enums, indexes, FKs and CHECK constraints. RLS, grants
-- and write-audit triggers land in the companion 0017 migration.
CREATE TYPE "public"."alert_category" AS ENUM('clinical_urgent', 'clinical_routine', 'operational', 'field_safety', 'administrative', 'system');--> statement-breakpoint
CREATE TYPE "public"."alert_outcome" AS ENUM('delivered', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."alert_payload_severity" AS ENUM('INFO', 'WARN', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."alert_recipient_resolver" AS ENUM('care_team', 'on_call', 'discipline', 'role_set', 'tenant_admins', 'user_list', 'broadcast');--> statement-breakpoint
CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warn', 'critical');--> statement-breakpoint
CREATE TYPE "public"."channel_kind" AS ENUM('care_team', 'discipline', 'location', 'on_call', 'dm', 'announcement', 'bereavement');--> statement-breakpoint
CREATE TYPE "public"."channel_member_role" AS ENUM('owner', 'member', 'read_only', 'portal_caregiver');--> statement-breakpoint
CREATE TYPE "public"."channel_member_source" AS ENUM('auto', 'manual');--> statement-breakpoint
CREATE TYPE "public"."channel_retention_class" AS ENUM('operational', 'care_related', 'bereavement');--> statement-breakpoint
CREATE TYPE "public"."delivery_endpoint_channel" AS ENUM('push', 'sms', 'email');--> statement-breakpoint
CREATE TYPE "public"."delivery_endpoint_verification" AS ENUM('verified', 'pending', 'expired');--> statement-breakpoint
CREATE TYPE "public"."message_author_kind" AS ENUM('user', 'system');--> statement-breakpoint
CREATE TYPE "public"."message_body_kind" AS ENUM('plain', 'markdown', 'system');--> statement-breakpoint
CREATE TYPE "public"."message_receipt_status" AS ENUM('delivered', 'read', 'ack');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('sent', 'edited', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('in_app', 'push', 'sms', 'email', 'voice');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'delivered', 'failed', 'skipped_quiet_hours', 'forwarded');--> statement-breakpoint
CREATE TYPE "public"."presence_status" AS ENUM('online', 'away', 'offline');--> statement-breakpoint
CREATE TABLE "channel" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel_kind" "channel_kind" NOT NULL,
	"subject_id" uuid,
	"title" text NOT NULL,
	"retention_class" "channel_retention_class" NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"archives_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_kind_subject_shape" CHECK (
      CASE channel_kind
        WHEN 'care_team'    THEN subject_id IS NOT NULL AND retention_class = 'care_related'
        WHEN 'bereavement'  THEN subject_id IS NOT NULL AND retention_class = 'bereavement' AND archives_at IS NOT NULL
        WHEN 'dm'           THEN subject_id IS NULL     AND retention_class = 'care_related'
        WHEN 'announcement' THEN subject_id IS NULL     AND retention_class = 'operational'
        ELSE                     subject_id IS NOT NULL AND retention_class = 'care_related'
      END
    )
);
--> statement-breakpoint
CREATE TABLE "channel_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "channel_member_role" DEFAULT 'member' NOT NULL,
	"source" "channel_member_source" NOT NULL,
	"last_read_message_id" uuid,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"author_user_id" uuid,
	"author_kind" "message_author_kind" NOT NULL,
	"body_cipher" "bytea" NOT NULL,
	"body_sha256" text NOT NULL,
	"body_kind" "message_body_kind" DEFAULT 'plain' NOT NULL,
	"parent_message_id" uuid,
	"quoted_message_id" uuid,
	"status" "message_status" DEFAULT 'sent' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "message_author_shape" CHECK ((author_kind = 'user') = (author_user_id IS NOT NULL)),
	CONSTRAINT "message_status_shape" CHECK (
      (status = 'edited') = (edited_at IS NOT NULL)
      AND (status = 'deleted') = (deleted_at IS NOT NULL)
    ),
	CONSTRAINT "message_sha256_shape" CHECK (body_sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "message_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"document_ref" uuid NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"filename" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "message_receipt_status" DEFAULT 'delivered' NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"acked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "presence" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"status" "presence_status" DEFAULT 'offline' NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text DEFAULT 'socket' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_endpoint" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" "delivery_endpoint_channel" NOT NULL,
	"endpoint_value" text NOT NULL,
	"verification_status" "delivery_endpoint_verification" DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"event_type" text NOT NULL,
	"category" "alert_category" NOT NULL,
	"severity_floor" "alert_severity" NOT NULL,
	"recipient_resolver" "alert_recipient_resolver" NOT NULL,
	"resolver_args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channels_override" text[],
	"system_locked" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"payload" jsonb NOT NULL,
	"correlation_id" text NOT NULL,
	"outcome" "alert_outcome" DEFAULT 'delivered' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"alert_category" "alert_category" NOT NULL,
	"alert_severity" "alert_severity" NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"endpoint_id" uuid,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"vendor_message_id" text,
	"fail_reason" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "notification_delivery_voice_sos_only" CHECK (channel <> 'voice' OR (alert_category = 'field_safety' AND alert_severity = 'critical'))
);
--> statement-breakpoint
CREATE TABLE "user_notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"routing_map" jsonb NOT NULL,
	"quiet_hours" jsonb DEFAULT '{"tz":"America/Los_Angeles","ranges":[],"severityOverride":"critical"}'::jsonb NOT NULL,
	"vacation_forward_to_user_id" uuid,
	"vacation_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_notif_pref_vacation_shape" CHECK ((vacation_forward_to_user_id IS NOT NULL) = (vacation_until IS NOT NULL AND vacation_until > NOW()))
);
--> statement-breakpoint
CREATE TABLE "alert_payload_catalog" (
	"payload_type" text PRIMARY KEY NOT NULL,
	"module_owner" text NOT NULL,
	"severity" "alert_payload_severity" NOT NULL,
	"default_channels" text[] NOT NULL,
	"default_recipient_resolver" text NOT NULL,
	"payload_schema" jsonb NOT NULL,
	"requires_response_tracking" boolean DEFAULT false NOT NULL,
	"description" text NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_alert_routing_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payload_type" text NOT NULL,
	"added_channels" text[] DEFAULT '{}' NOT NULL,
	"added_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"escalated_severity" "alert_payload_severity",
	"rationale" text NOT NULL,
	"configured_by_membership_id" uuid NOT NULL,
	"configured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"template_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"title_template" text NOT NULL,
	"body_template" text NOT NULL,
	"payload_schema" jsonb NOT NULL,
	"default_payload_type" text NOT NULL,
	"default_recipient_resolver" text NOT NULL,
	"supported_locales" text[] DEFAULT '{"en-US"}' NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"owned_by_module" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_notification_template_overlay" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"title_template" text,
	"body_template" text,
	"configured_by_membership_id" uuid NOT NULL,
	"configured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel" ADD CONSTRAINT "channel_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_member" ADD CONSTRAINT "channel_member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_member" ADD CONSTRAINT "channel_member_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_member" ADD CONSTRAINT "channel_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_channel_id_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channel"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_parent_message_id_message_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_quoted_message_id_message_id_fk" FOREIGN KEY ("quoted_message_id") REFERENCES "public"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachment" ADD CONSTRAINT "message_attachment_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_receipt" ADD CONSTRAINT "message_receipt_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_receipt" ADD CONSTRAINT "message_receipt_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_receipt" ADD CONSTRAINT "message_receipt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence" ADD CONSTRAINT "presence_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_endpoint" ADD CONSTRAINT "delivery_endpoint_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rule" ADD CONSTRAINT "alert_rule_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert" ADD CONSTRAINT "alert_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_alert_id_alert_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alert"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_recipient_user_id_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_endpoint_id_delivery_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."delivery_endpoint"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notification_preferences" ADD CONSTRAINT "user_notification_preferences_vacation_forward_to_user_id_user_id_fk" FOREIGN KEY ("vacation_forward_to_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_alert_routing_override" ADD CONSTRAINT "tenant_alert_routing_override_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_alert_routing_override" ADD CONSTRAINT "tenant_alert_routing_override_payload_type_alert_payload_catalog_payload_type_fk" FOREIGN KEY ("payload_type") REFERENCES "public"."alert_payload_catalog"("payload_type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_alert_routing_override" ADD CONSTRAINT "tenant_alert_routing_override_configured_by_membership_id_membership_id_fk" FOREIGN KEY ("configured_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_template" ADD CONSTRAINT "notification_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_template" ADD CONSTRAINT "notification_template_default_payload_type_alert_payload_catalog_payload_type_fk" FOREIGN KEY ("default_payload_type") REFERENCES "public"."alert_payload_catalog"("payload_type") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_notification_template_overlay" ADD CONSTRAINT "tenant_notification_template_overlay_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_notification_template_overlay" ADD CONSTRAINT "tenant_notification_template_overlay_configured_by_membership_id_membership_id_fk" FOREIGN KEY ("configured_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_org_kind_idx" ON "channel" USING btree ("organization_id","channel_kind");--> statement-breakpoint
CREATE INDEX "channel_subject_idx" ON "channel" USING btree ("channel_kind","subject_id") WHERE subject_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_unique_subject" ON "channel" USING btree ("organization_id","channel_kind","subject_id") WHERE subject_id IS NOT NULL AND channel_kind IN ('care_team','on_call','bereavement','location','discipline');--> statement-breakpoint
CREATE UNIQUE INDEX "channel_member_active_unique" ON "channel_member" USING btree ("channel_id","user_id") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE INDEX "channel_member_user_idx" ON "channel_member" USING btree ("user_id") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE INDEX "channel_member_channel_idx" ON "channel_member" USING btree ("channel_id") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE INDEX "message_channel_created_idx" ON "message" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "message_author_idx" ON "message" USING btree ("author_user_id") WHERE author_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "message_org_idx" ON "message" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "message_parent_idx" ON "message" USING btree ("parent_message_id") WHERE parent_message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "message_attachment_message_idx" ON "message_attachment" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_receipt_unique" ON "message_receipt" USING btree ("message_id","user_id");--> statement-breakpoint
CREATE INDEX "message_receipt_user_read_idx" ON "message_receipt" USING btree ("user_id","status") WHERE status = 'delivered';--> statement-breakpoint
CREATE INDEX "message_receipt_message_idx" ON "message_receipt" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "presence_status_idx" ON "presence" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_endpoint_unique" ON "delivery_endpoint" USING btree ("user_id","channel","endpoint_value");--> statement-breakpoint
CREATE INDEX "delivery_endpoint_user_channel_idx" ON "delivery_endpoint" USING btree ("user_id","channel");--> statement-breakpoint
CREATE INDEX "alert_rule_event_idx" ON "alert_rule" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "alert_rule_org_event_idx" ON "alert_rule" USING btree ("organization_id","event_type","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_rule_unique" ON "alert_rule" USING btree ("organization_id","event_type","severity_floor");--> statement-breakpoint
CREATE INDEX "alert_org_created_idx" ON "alert" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "alert_event_type_idx" ON "alert" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "notification_delivery_alert_idx" ON "notification_delivery" USING btree ("alert_id");--> statement-breakpoint
CREATE INDEX "notification_delivery_recipient_idx" ON "notification_delivery" USING btree ("recipient_user_id","queued_at");--> statement-breakpoint
CREATE INDEX "notification_delivery_vendor_idx" ON "notification_delivery" USING btree ("vendor_message_id") WHERE vendor_message_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_notification_preferences_unique" ON "user_notification_preferences" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_template_org_key_version_uk" ON "notification_template" USING btree ("organization_id","template_key","version");--> statement-breakpoint
CREATE INDEX "notification_template_key_idx" ON "notification_template" USING btree ("template_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_notification_template_overlay_uk" ON "tenant_notification_template_overlay" USING btree ("organization_id","template_key");