-- M34 SaaS Tenant Platform §3.3–§3.9 — M34 tables migration (hand-written SQL mirroring the
-- packages/db/src/schema/saas/*.ts Drizzle definitions). The 16 manifest-owned M34 tables that have
-- landed schema files, their enums, indexes, FKs and CHECK constraints. RLS, the tenant_platform_writer
-- role/grants, the *_event PARTITION BY conversions, and the M4 write-audit triggers land in the
-- companion 0052/0053 migrations; the seed (onboarding templates) lands in 0054, and the key-ring
-- SECURITY DEFINER functions in 0055.
--
-- Tenancy (§3.10 M34-F02 / ADR-0010, CANONICAL): EVERY tenant-scoped M34 table carries
-- organization_id uuid NOT NULL (FK → organization) so the canonical app.org_id RLS predicate applies
-- directly. Only tenant_signup_intent/tenant_signup_token (pre-organization) and the platform-shared
-- onboarding_task_template catalog are genuinely org-less. The org spine + intra-M34 parents take SQL
-- FKs; cross-module references are plain uuid columns (app-validated, no FK), matching the mdm/evv
-- cross-module ref convention.
--
-- The three high-volume *_event tables (support_session_event, dsar_export_job_event,
-- tenant_export_job_event) are LIST-partitioned by organization_id HERE (§3.10 M34-F10): only the empty
-- partitioned PARENT is created; the provision worker creates per-org child partitions (and
-- partition.rotate / OPS-021 maintains their monthly RANGE sub-partitions). Their PK is
-- (id, organization_id, occurred_at) so the LIST partition key is included (ADR-0022 D1.1).
CREATE TYPE "public"."tenant_account_status" AS ENUM('signup_intent', 'provisioning', 'onboarding', 'active', 'suspended', 'at_risk', 'offboarding_initiated', 'final_export_pending', 'retained', 'destruction_pending', 'destroyed');--> statement-breakpoint
CREATE TYPE "public"."retention_class_default" AS ENUM('compliance', 'clinical_record', 'operational', 'bereavement', 'intake_artifact');--> statement-breakpoint
CREATE TYPE "public"."onboarding_task_status" AS ENUM('pending', 'in_progress', 'done', 'skipped', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."tenant_invitation_status" AS ENUM('pending', 'consumed', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."support_consent_grant_scope" AS ENUM('organization_scoped', 'patient_scoped');--> statement-breakpoint
CREATE TYPE "public"."dsar_export_job_status" AS ENUM('requested', 'generating', 'review_pending', 'fulfilled', 'denied', 'extended');--> statement-breakpoint
CREATE TYPE "public"."dsar_request_source" AS ENUM('patient', 'caregiver', 'legal_representative', 'authorized_third_party');--> statement-breakpoint
CREATE TYPE "public"."tenant_export_job_status" AS ENUM('requested', 'generating', 'fulfilled', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."tenant_export_job_purpose" AS ENUM('migration', 'baa_termination', 'compliance_audit', 'surveyor_request');--> statement-breakpoint
CREATE TYPE "public"."platform_tenant_baa_status" AS ENUM('executed', 'pending', 'terminated', 'missing');--> statement-breakpoint
CREATE TYPE "public"."tenant_signup_intent_status" AS ENUM('new', 'qualified', 'provisioned', 'abandoned', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."tenant_signup_intent_source" AS ENUM('self_serve_form', 'platform_ops_manual', 'partner_referral');--> statement-breakpoint
CREATE TABLE "tenant_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" "tenant_account_status" DEFAULT 'signup_intent' NOT NULL,
	"plan_label" text DEFAULT 'engrace_internal' NOT NULL,
	"legal_business_name" text NOT NULL,
	"dba_name" text,
	"billing_contact_email" text NOT NULL,
	"breach_notification_email" text NOT NULL,
	"compliance_officer_membership_id" uuid,
	"retention_class_default" "retention_class_default" DEFAULT 'compliance' NOT NULL,
	"provisioned_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"offboarding_initiated_at" timestamp with time zone,
	"final_export_completed_at" timestamp with time zone,
	"retention_ends_at" timestamp with time zone,
	"destroyed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_membership_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_account_destroyed_consistency" CHECK ((status = 'destroyed') = (destroyed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "tenant_account_status_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_account_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_status" "tenant_account_status",
	"to_status" "tenant_account_status" NOT NULL,
	"transition_reason" text NOT NULL,
	"actor_membership_id" uuid,
	"actor_kind" text NOT NULL,
	"side_effects_recorded" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_task_template" (
	"key" text PRIMARY KEY NOT NULL,
	"display_label" text NOT NULL,
	"description" text NOT NULL,
	"canonical_order" integer NOT NULL,
	"required_role" text NOT NULL,
	"precondition_dsl" text,
	"default_due_days_after_provisioning" integer NOT NULL,
	"is_canonical" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tenant_account_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"status" "onboarding_task_status" DEFAULT 'pending' NOT NULL,
	"assigned_to_membership_id" uuid,
	"due_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"blocker_reason" text,
	"completion_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tenant_account_id" uuid NOT NULL,
	"invitee_email" text NOT NULL,
	"invitee_full_name" text NOT NULL,
	"invitee_phone" text,
	"token_hash" text NOT NULL,
	"status" "tenant_invitation_status" DEFAULT 'pending' NOT NULL,
	"inviter_membership_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_user_id" uuid,
	CONSTRAINT "tenant_invitation_expires_check" CHECK (expires_at <= issued_at + interval '14 days')
);
--> statement-breakpoint
CREATE TABLE "tenant_key_ring" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tenant_account_id" uuid NOT NULL,
	"current_dek_version" text NOT NULL,
	"current_dek_kek_wrapped_ciphertext" bytea,
	"current_dek_kek_id" text,
	"prior_dek_versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dek_created_at" timestamp with time zone,
	"dek_last_rotated_at" timestamp with time zone,
	"destroyed_at" timestamp with time zone,
	"destroyed_by_membership_id" uuid,
	"destruction_certificate_id" uuid,
	CONSTRAINT "tenant_key_ring_destroyed_consistency" CHECK ((destroyed_at IS NOT NULL) = (current_dek_kek_wrapped_ciphertext IS NULL))
);
--> statement-breakpoint
CREATE TABLE "tenant_key_destruction_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tenant_key_ring_id" uuid NOT NULL,
	"destruction_phase" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"per_module_eraser_receipts" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_consent_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tenant_account_id" uuid NOT NULL,
	"scope" "support_consent_grant_scope" NOT NULL,
	"patient_ids_in_scope" uuid[],
	"grant_reason" text NOT NULL,
	"grantor_membership_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_membership_id" uuid,
	"revocation_reason" text,
	CONSTRAINT "support_grant_expires_check" CHECK (expires_at <= issued_at + interval '72 hours'),
	CONSTRAINT "support_grant_patient_scope_check" CHECK ((scope = 'patient_scoped') = (patient_ids_in_scope IS NOT NULL AND array_length(patient_ids_in_scope, 1) > 0))
);
--> statement-breakpoint
CREATE TABLE "support_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"support_consent_grant_id" uuid NOT NULL,
	"actor_membership_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text
);
--> statement-breakpoint
CREATE TABLE "support_session_event" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"support_session_id" uuid NOT NULL,
	"event_kind" text NOT NULL,
	"resource_kind" text,
	"resource_id" uuid,
	"patient_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_ip" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "support_session_event_id_organization_id_occurred_at_pk" PRIMARY KEY("id","organization_id","occurred_at")
) PARTITION BY LIST ("organization_id");
--> statement-breakpoint
CREATE TABLE "dsar_export_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"request_source" "dsar_request_source" NOT NULL,
	"requestor_identity_verification_evidence" text NOT NULL,
	"requesting_membership_id" uuid NOT NULL,
	"status" "dsar_export_job_status" DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sla_due_at" timestamp with time zone NOT NULL,
	"extended_until" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"denied_reason" text,
	"bundle_document_id" uuid,
	"bundle_minio_object_key" text,
	"bundle_sha256" text,
	"bundle_presigned_url_expires_at" timestamp with time zone,
	"bundle_presigned_url_last_generated_at" timestamp with time zone,
	"bundle_downloaded_at" timestamp with time zone,
	"bundle_downloaded_by_membership_id" uuid,
	CONSTRAINT "dsar_extension_check" CHECK (extended_until IS NULL OR extended_until <= sla_due_at + interval '30 days')
);
--> statement-breakpoint
CREATE TABLE "dsar_export_job_event" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"dsar_export_job_id" uuid NOT NULL,
	"event_kind" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"shard_receipt" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dsar_export_job_event_id_organization_id_occurred_at_pk" PRIMARY KEY("id","organization_id","occurred_at")
) PARTITION BY LIST ("organization_id");
--> statement-breakpoint
CREATE TABLE "tenant_export_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"requested_purpose" "tenant_export_job_purpose" NOT NULL,
	"requesting_membership_id" uuid NOT NULL,
	"status" "tenant_export_job_status" DEFAULT 'requested' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fulfilled_at" timestamp with time zone,
	"bundle_minio_object_key" text,
	"bundle_sha256" text,
	"bundle_size_bytes" integer,
	"bundle_module_inventory" jsonb,
	"bundle_presigned_url_expires_at" timestamp with time zone,
	"bundle_presigned_url_last_generated_at" timestamp with time zone,
	"bundle_downloaded_at" timestamp with time zone,
	"bundle_downloaded_by_membership_id" uuid
);
--> statement-breakpoint
CREATE TABLE "tenant_export_job_event" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tenant_export_job_id" uuid NOT NULL,
	"event_kind" text NOT NULL,
	"module_key" text,
	"shard_receipt" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_export_job_event_id_organization_id_occurred_at_pk" PRIMARY KEY("id","organization_id","occurred_at")
) PARTITION BY LIST ("organization_id");
--> statement-breakpoint
CREATE TABLE "platform_tenant_baa_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tenant_account_id" uuid NOT NULL,
	"addendum_version" text NOT NULL,
	"baa_status" "platform_tenant_baa_status" NOT NULL,
	"executed_on" date,
	"effective_on" date,
	"expires_on" date,
	"breach_notification_contact_email" text,
	"breach_notification_contact_phone" text,
	"subcontractor_disclosure_set" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"compliance_officer_attestation_membership_id" uuid,
	"attested_at" timestamp with time zone,
	"document_id" uuid,
	CONSTRAINT "platform_tenant_baa_dates_check" CHECK (executed_on IS NULL OR effective_on IS NULL OR expires_on IS NULL
		OR (executed_on <= effective_on AND effective_on <= expires_on))
);
--> statement-breakpoint
CREATE TABLE "tenant_signup_intent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_email" text NOT NULL,
	"legal_business_name" text NOT NULL,
	"intended_first_admin_email" text NOT NULL,
	"intent_status" "tenant_signup_intent_status" DEFAULT 'new' NOT NULL,
	"source" "tenant_signup_intent_source" NOT NULL,
	"rejection_reason" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"tenant_account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "tenant_signup_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_signup_intent_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token_purpose" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "tenant_signup_token_expires_check" CHECK (expires_at <= issued_at + interval '24 hours')
);
--> statement-breakpoint
ALTER TABLE "tenant_account" ADD CONSTRAINT "tenant_account_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_account_status_event" ADD CONSTRAINT "tenant_account_status_event_tenant_account_id_tenant_account_id_fk" FOREIGN KEY ("tenant_account_id") REFERENCES "public"."tenant_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_account_status_event" ADD CONSTRAINT "tenant_account_status_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_task" ADD CONSTRAINT "onboarding_task_tenant_account_id_tenant_account_id_fk" FOREIGN KEY ("tenant_account_id") REFERENCES "public"."tenant_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_task" ADD CONSTRAINT "onboarding_task_template_key_onboarding_task_template_key_fk" FOREIGN KEY ("template_key") REFERENCES "public"."onboarding_task_template"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_key_destruction_log" ADD CONSTRAINT "tenant_key_destruction_log_tenant_key_ring_id_tenant_key_ring_id_fk" FOREIGN KEY ("tenant_key_ring_id") REFERENCES "public"."tenant_key_ring"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_session" ADD CONSTRAINT "support_session_support_consent_grant_id_support_consent_grant_id_fk" FOREIGN KEY ("support_consent_grant_id") REFERENCES "public"."support_consent_grant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsar_export_job" ADD CONSTRAINT "dsar_export_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsar_export_job_event" ADD CONSTRAINT "dsar_export_job_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_export_job" ADD CONSTRAINT "tenant_export_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_export_job_event" ADD CONSTRAINT "tenant_export_job_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- M34-F02 / ADR-0010: org-spine FKs for the now-org-scoped tables (canonical app.org_id RLS).
ALTER TABLE "onboarding_task" ADD CONSTRAINT "onboarding_task_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_invitation" ADD CONSTRAINT "tenant_invitation_tenant_account_id_tenant_account_id_fk" FOREIGN KEY ("tenant_account_id") REFERENCES "public"."tenant_account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_invitation" ADD CONSTRAINT "tenant_invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_key_ring" ADD CONSTRAINT "tenant_key_ring_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_key_destruction_log" ADD CONSTRAINT "tenant_key_destruction_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_consent_grant" ADD CONSTRAINT "support_consent_grant_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_session" ADD CONSTRAINT "support_session_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_session_event" ADD CONSTRAINT "support_session_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_tenant_baa_record" ADD CONSTRAINT "platform_tenant_baa_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_account_org_unique" ON "tenant_account" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tenant_account_status_idx" ON "tenant_account" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tenant_account_retention_ends_idx" ON "tenant_account" USING btree ("retention_ends_at") WHERE retention_ends_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tenant_account_status_event_org_occurred_idx" ON "tenant_account_status_event" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "tenant_account_status_event_tenant_idx" ON "tenant_account_status_event" USING btree ("tenant_account_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_task_tenant_template_unique" ON "onboarding_task" USING btree ("tenant_account_id","template_key");--> statement-breakpoint
CREATE INDEX "onboarding_task_tenant_status_idx" ON "onboarding_task" USING btree ("tenant_account_id","status");--> statement-breakpoint
CREATE INDEX "onboarding_task_due_idx" ON "onboarding_task" USING btree ("due_at") WHERE status IN ('pending','in_progress','blocked');--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_invitation_token_unique" ON "tenant_invitation" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "tenant_invitation_org_status_idx" ON "tenant_invitation" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "tenant_invitation_tenant_status_idx" ON "tenant_invitation" USING btree ("tenant_account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_key_ring_tenant_unique" ON "tenant_key_ring" USING btree ("tenant_account_id");--> statement-breakpoint
CREATE INDEX "tenant_key_destruction_log_keyring_phase_idx" ON "tenant_key_destruction_log" USING btree ("tenant_key_ring_id","destruction_phase");--> statement-breakpoint
CREATE INDEX "support_grant_tenant_issued_idx" ON "support_consent_grant" USING btree ("tenant_account_id","issued_at");--> statement-breakpoint
CREATE INDEX "support_session_grant_idx" ON "support_session" USING btree ("support_consent_grant_id");--> statement-breakpoint
CREATE INDEX "support_session_actor_started_idx" ON "support_session" USING btree ("actor_membership_id","started_at");--> statement-breakpoint
CREATE INDEX "support_session_active_idx" ON "support_session" USING btree ("expires_at") WHERE closed_at IS NULL;--> statement-breakpoint
CREATE INDEX "support_session_event_session_idx" ON "support_session_event" USING btree ("support_session_id","occurred_at");--> statement-breakpoint
CREATE INDEX "support_session_event_patient_idx" ON "support_session_event" USING btree ("patient_id","occurred_at") WHERE patient_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "dsar_export_org_patient_idx" ON "dsar_export_job" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE INDEX "dsar_export_sla_idx" ON "dsar_export_job" USING btree ("sla_due_at") WHERE status IN ('requested','generating','review_pending','extended');--> statement-breakpoint
CREATE INDEX "dsar_event_org_occurred_idx" ON "dsar_export_job_event" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "dsar_event_job_idx" ON "dsar_export_job_event" USING btree ("dsar_export_job_id","occurred_at");--> statement-breakpoint
CREATE INDEX "tenant_export_org_status_idx" ON "tenant_export_job" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "tenant_export_presigned_expires_idx" ON "tenant_export_job" USING btree ("bundle_presigned_url_expires_at");--> statement-breakpoint
CREATE INDEX "tenant_export_event_org_occurred_idx" ON "tenant_export_job_event" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "tenant_export_event_job_idx" ON "tenant_export_job_event" USING btree ("tenant_export_job_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_tenant_baa_unique" ON "platform_tenant_baa_record" USING btree ("tenant_account_id","addendum_version");--> statement-breakpoint
CREATE INDEX "platform_tenant_baa_tenant_status_idx" ON "platform_tenant_baa_record" USING btree ("tenant_account_id","baa_status");--> statement-breakpoint
CREATE INDEX "platform_tenant_baa_expires_idx" ON "platform_tenant_baa_record" USING btree ("expires_on") WHERE expires_on IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_signup_token_hash_unique" ON "tenant_signup_token" USING btree ("token_hash");
