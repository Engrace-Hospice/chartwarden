CREATE TYPE "public"."consent_capture_method" AS ENUM('electronic_portal_signature', 'typed_signature_in_app', 'uploaded_signed_pdf', 'witnessed_verbal_documented', 'notarized');--> statement-breakpoint
CREATE TYPE "public"."consent_delegated_access_scope" AS ENUM('view_only_minimal', 'view_only_full', 'view_and_message', 'view_message_and_decisions');--> statement-breakpoint
CREATE TYPE "public"."consent_dpoa_activation_condition" AS ENUM('immediate', 'upon_incapacity_attested', 'upon_physician_determination', 'upon_incompetence_court_order');--> statement-breakpoint
CREATE TYPE "public"."consent_dpoa_agent_kind" AS ENUM('primary', 'alternate_1', 'alternate_2');--> statement-breakpoint
CREATE TYPE "public"."consent_dpoa_scope_kind" AS ENUM('healthcare_full', 'healthcare_end_of_life_only', 'financial_narrow', 'financial_broad');--> statement-breakpoint
CREATE TYPE "public"."consent_dpoa_term_kind" AS ENUM('indefinite', 'until_date', 'event_driven');--> statement-breakpoint
CREATE TYPE "public"."consent_grantor_kind" AS ENUM('patient_self', 'dpoa_healthcare_agent', 'dpoa_financial_agent', 'court_guardian', 'parent_for_minor', 'healthcare_surrogate', 'bereaved_person_self');--> statement-breakpoint
CREATE TYPE "public"."consent_recipient_kind" AS ENUM('external_physician', 'facility', 'pharmacy', 'irb', 'family_member', 'attorney', 'employer', 'researcher', 'free_text');--> statement-breakpoint
CREATE TYPE "public"."consent_reminder_kind" AS ENUM('90_days', '30_days', '14_days', '7_days', '1_day');--> statement-breakpoint
CREATE TYPE "public"."consent_renewal_cycle_status" AS ENUM('open', 'renewed', 'closed_expired', 'closed_revoked', 'closed_no_longer_applicable');--> statement-breakpoint
CREATE TYPE "public"."consent_revocation_actor_kind" AS ENUM('patient_self_via_portal', 'staff', 'dpoa_agent', 'court_order', 'platform_admin_break_glass');--> statement-breakpoint
CREATE TYPE "public"."consent_revocation_cascade_status" AS ENUM('pending', 'in_progress', 'completed', 'partial_failed');--> statement-breakpoint
CREATE TYPE "public"."consent_scope_discriminator" AS ENUM('categorical', 'per_recipient', 'per_named_agent', 'per_encounter');--> statement-breakpoint
CREATE TYPE "public"."consent_status" AS ENUM('draft', 'active', 'superseded', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."consent_type_key" AS ENUM('portal_access', 'dpoa_healthcare', 'dpoa_financial', 'family_caregiver_access', '42_cfr_part_2_release', 'media_release', 'research_participation', 'telehealth_consent', 'advance_directive_acknowledgment', 'hipaa_release', 'bereavement_outreach_consent', 'custom');--> statement-breakpoint
CREATE TABLE "consent_type_catalog" (
	"type_key" "consent_type_key" PRIMARY KEY NOT NULL,
	"display_name_en" text NOT NULL,
	"scope_discriminator" "consent_scope_discriminator" NOT NULL,
	"default_expiration_seconds" integer,
	"max_term_seconds" integer,
	"capture_method_floor" text[] NOT NULL,
	"reminder_cadence_floor" text[] NOT NULL,
	"revocation_cascade_kind" text NOT NULL,
	"is_per_recipient" boolean NOT NULL,
	"is_per_named_agent" boolean NOT NULL,
	"is_post_mortem_eligible" boolean NOT NULL,
	"requires_jurisdiction_code" boolean NOT NULL,
	"cfr_42_part_2_compliant" boolean NOT NULL,
	"hipaa_164_508_compliant" boolean NOT NULL,
	"body_text_template_key" text NOT NULL,
	"m22_template_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_consent_type_overlay" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type_key" "consent_type_key" NOT NULL,
	"tighter_expiration_seconds" integer,
	"tighter_capture_methods" text[],
	"tighter_reminder_cadence" text[],
	"state_addendum_text" text,
	"jurisdiction_code_required" boolean,
	"published_at" timestamp with time zone,
	"published_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tcto_expiration_non_negative" CHECK ("tenant_consent_type_overlay"."tighter_expiration_seconds" IS NULL OR "tenant_consent_type_overlay"."tighter_expiration_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "consent_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"type_key" "consent_type_key" NOT NULL,
	"scope_descriptor" jsonb NOT NULL,
	"grantor_kind" "consent_grantor_kind" NOT NULL,
	"grantor_user_id" uuid,
	"grantor_caregiver_id" uuid,
	"grantor_relationship_text" text,
	"acting_consent_id" uuid,
	"effective_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"status" "consent_status" DEFAULT 'draft' NOT NULL,
	"supersedes_consent_record_id" uuid,
	"superseded_at" timestamp with time zone,
	"superseded_by_consent_record_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_via_id" uuid,
	"renewed_from_consent_record_id" uuid,
	"capture_method" "consent_capture_method" NOT NULL,
	"capture_evidence_jsonb" jsonb NOT NULL,
	"jurisdiction_code" text,
	"language_code" text,
	"survives_death" boolean DEFAULT false NOT NULL,
	"internal_notes_cipher" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid NOT NULL,
	"signed_at" timestamp with time zone,
	"signed_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "cr_no_self_supersede" CHECK (supersedes_consent_record_id <> id),
	CONSTRAINT "cr_no_self_acting" CHECK (acting_consent_id <> id),
	CONSTRAINT "cr_no_self_renewal" CHECK (renewed_from_consent_record_id <> id),
	CONSTRAINT "cr_expires_after_effective" CHECK (expires_at IS NULL OR expires_at > effective_at),
	CONSTRAINT "cr_superseded_consistent" CHECK ((status <> 'superseded') OR (superseded_at IS NOT NULL AND superseded_by_consent_record_id IS NOT NULL)),
	CONSTRAINT "cr_revoked_consistent" CHECK ((status <> 'revoked') OR (revoked_at IS NOT NULL AND revoked_via_id IS NOT NULL)),
	CONSTRAINT "cr_signed_consistent" CHECK ((status = 'draft') OR (signed_at IS NOT NULL AND signed_by_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "consent_record_recipient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"consent_record_id" uuid NOT NULL,
	"recipient_kind" "consent_recipient_kind" NOT NULL,
	"recipient_entity_id" uuid,
	"recipient_free_text" text,
	"recipient_resolved_display_name" text NOT NULL,
	"purpose_code" text,
	"purpose_free_text" text,
	"expires_at" timestamp with time zone,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by_id" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_id" uuid,
	"removed_reason_text" text,
	CONSTRAINT "crr_freetext_or_entity" CHECK ((recipient_kind = 'free_text' AND recipient_entity_id IS NULL AND recipient_free_text IS NOT NULL)
       OR (recipient_kind <> 'free_text' AND recipient_entity_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "consent_record_dpoa_agent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"consent_record_id" uuid NOT NULL,
	"agent_kind" "consent_dpoa_agent_kind" NOT NULL,
	"agent_name" text NOT NULL,
	"agent_relationship" text NOT NULL,
	"agent_contact_jsonb" jsonb NOT NULL,
	"agent_external_physician_id" uuid,
	"agent_user_id" uuid,
	"agent_caregiver_id" uuid,
	"activation_condition" "consent_dpoa_activation_condition" NOT NULL,
	"activation_evidence_jsonb" jsonb,
	"scope_kind" "consent_dpoa_scope_kind" NOT NULL,
	"term_kind" "consent_dpoa_term_kind" NOT NULL,
	"term_until" timestamp with time zone,
	"state_specific_jsonb" jsonb,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by_id" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_id" uuid,
	CONSTRAINT "crda_term_consistent" CHECK ((term_kind <> 'until_date') OR (term_until IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "consent_revocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"consent_record_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by_kind" "consent_revocation_actor_kind" NOT NULL,
	"revoked_by_user_id" uuid,
	"revoked_by_caregiver_id" uuid,
	"reason_text" text NOT NULL,
	"evidence_document_id" uuid,
	"cascade_status" "consent_revocation_cascade_status" DEFAULT 'pending' NOT NULL,
	"cascade_started_at" timestamp with time zone,
	"cascade_completed_at" timestamp with time zone,
	"cascade_consumer_status_jsonb" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"step_up_evidence_id" uuid,
	"audit_event_id" uuid,
	CONSTRAINT "cr_revocation_staff_reason_floor" CHECK (revoked_by_kind <> 'staff' OR length(reason_text) >= 40),
	CONSTRAINT "cr_revocation_staff_evidence" CHECK (revoked_by_kind <> 'staff' OR evidence_document_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "consent_expiration_reminder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"consent_record_id" uuid NOT NULL,
	"reminder_kind" "consent_reminder_kind" NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone,
	"delivery_channel" text NOT NULL,
	"recipient_resolution_jsonb" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"m36_alert_id" uuid
);
--> statement-breakpoint
CREATE TABLE "delegated_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"consent_record_id" uuid NOT NULL,
	"consent_record_recipient_id" uuid NOT NULL,
	"delegate_user_id" uuid,
	"delegate_caregiver_id" uuid NOT NULL,
	"scope_kind" "consent_delegated_access_scope" NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"portal_session_class" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_document_link" (
	"consent_record_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"template_version" text NOT NULL,
	"rendered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_eval_audit" (
	"id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"consent_record_id" uuid,
	"consent_version_at_eval" integer,
	"type_key" "consent_type_key" NOT NULL,
	"recipient_resolved_kind" text,
	"recipient_resolved_id" uuid,
	"allowed" boolean NOT NULL,
	"deny_reason" text,
	"as_of" timestamp with time zone NOT NULL,
	"caller_module" text NOT NULL,
	"caller_route" text,
	"session_class" text,
	"session_id" uuid,
	"membership_id" uuid,
	"redacted_categories" text[],
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_eval_audit_id_evaluated_at_pk" PRIMARY KEY("id","evaluated_at")
);
--> statement-breakpoint
CREATE TABLE "consent_renewal_cycle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"source_consent_record_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"status" "consent_renewal_cycle_status" DEFAULT 'open' NOT NULL,
	"cycle_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_action_due_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	"resolved_consent_record_id" uuid,
	"assigned_to_membership_id" uuid
);
--> statement-breakpoint
DROP INDEX "patient_name_search_idx";--> statement-breakpoint
ALTER TABLE "tenant_consent_type_overlay" ADD CONSTRAINT "tenant_consent_type_overlay_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_consent_type_overlay" ADD CONSTRAINT "tenant_consent_type_overlay_type_key_consent_type_catalog_type_key_fk" FOREIGN KEY ("type_key") REFERENCES "public"."consent_type_catalog"("type_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_type_key_consent_type_catalog_type_key_fk" FOREIGN KEY ("type_key") REFERENCES "public"."consent_type_catalog"("type_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_supersedes_consent_record_id_consent_record_id_fk" FOREIGN KEY ("supersedes_consent_record_id") REFERENCES "public"."consent_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_superseded_by_consent_record_id_consent_record_id_fk" FOREIGN KEY ("superseded_by_consent_record_id") REFERENCES "public"."consent_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_renewed_from_consent_record_id_consent_record_id_fk" FOREIGN KEY ("renewed_from_consent_record_id") REFERENCES "public"."consent_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_acting_consent_id_consent_record_id_fk" FOREIGN KEY ("acting_consent_id") REFERENCES "public"."consent_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record_recipient" ADD CONSTRAINT "consent_record_recipient_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record_recipient" ADD CONSTRAINT "consent_record_recipient_consent_record_id_consent_record_id_fk" FOREIGN KEY ("consent_record_id") REFERENCES "public"."consent_record"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record_dpoa_agent" ADD CONSTRAINT "consent_record_dpoa_agent_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_record_dpoa_agent" ADD CONSTRAINT "consent_record_dpoa_agent_consent_record_id_consent_record_id_fk" FOREIGN KEY ("consent_record_id") REFERENCES "public"."consent_record"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_revocation" ADD CONSTRAINT "consent_revocation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_revocation" ADD CONSTRAINT "consent_revocation_consent_record_id_consent_record_id_fk" FOREIGN KEY ("consent_record_id") REFERENCES "public"."consent_record"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_expiration_reminder" ADD CONSTRAINT "consent_expiration_reminder_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_expiration_reminder" ADD CONSTRAINT "consent_expiration_reminder_consent_record_id_consent_record_id_fk" FOREIGN KEY ("consent_record_id") REFERENCES "public"."consent_record"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegated_access" ADD CONSTRAINT "delegated_access_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegated_access" ADD CONSTRAINT "delegated_access_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegated_access" ADD CONSTRAINT "delegated_access_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegated_access" ADD CONSTRAINT "delegated_access_consent_record_id_consent_record_id_fk" FOREIGN KEY ("consent_record_id") REFERENCES "public"."consent_record"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegated_access" ADD CONSTRAINT "delegated_access_consent_record_recipient_id_consent_record_recipient_id_fk" FOREIGN KEY ("consent_record_recipient_id") REFERENCES "public"."consent_record_recipient"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document_link" ADD CONSTRAINT "consent_document_link_consent_record_id_consent_record_id_fk" FOREIGN KEY ("consent_record_id") REFERENCES "public"."consent_record"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_document_link" ADD CONSTRAINT "consent_document_link_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_eval_audit" ADD CONSTRAINT "consent_eval_audit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_eval_audit" ADD CONSTRAINT "consent_eval_audit_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_eval_audit" ADD CONSTRAINT "consent_eval_audit_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_renewal_cycle" ADD CONSTRAINT "consent_renewal_cycle_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_renewal_cycle" ADD CONSTRAINT "consent_renewal_cycle_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_renewal_cycle" ADD CONSTRAINT "consent_renewal_cycle_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_renewal_cycle" ADD CONSTRAINT "consent_renewal_cycle_source_consent_record_id_consent_record_id_fk" FOREIGN KEY ("source_consent_record_id") REFERENCES "public"."consent_record"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_renewal_cycle" ADD CONSTRAINT "consent_renewal_cycle_resolved_consent_record_id_consent_record_id_fk" FOREIGN KEY ("resolved_consent_record_id") REFERENCES "public"."consent_record"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_type_catalog_scope_idx" ON "consent_type_catalog" USING btree ("scope_discriminator");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tcto_org_type" ON "tenant_consent_type_overlay" USING btree ("organization_id","type_key");--> statement-breakpoint
CREATE INDEX "ix_tcto_org" ON "tenant_consent_type_overlay" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ix_cr_patient_type_status" ON "consent_record" USING btree ("organization_id","patient_id","type_key","status");--> statement-breakpoint
CREATE INDEX "ix_cr_expiring_soon" ON "consent_record" USING btree ("expires_at") WHERE status = 'active' AND expires_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_cr_active_by_patient" ON "consent_record" USING btree ("organization_id","patient_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "ix_crr_consent" ON "consent_record_recipient" USING btree ("consent_record_id");--> statement-breakpoint
CREATE INDEX "ix_crr_active_by_consent" ON "consent_record_recipient" USING btree ("consent_record_id") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE INDEX "ix_crr_resolved_entity" ON "consent_record_recipient" USING btree ("recipient_kind","recipient_entity_id") WHERE removed_at IS NULL;--> statement-breakpoint
CREATE INDEX "ix_crda_consent" ON "consent_record_dpoa_agent" USING btree ("consent_record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_crda_primary" ON "consent_record_dpoa_agent" USING btree ("consent_record_id") WHERE agent_kind = 'primary' AND removed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_crda_alt1" ON "consent_record_dpoa_agent" USING btree ("consent_record_id") WHERE agent_kind = 'alternate_1' AND removed_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_crda_alt2" ON "consent_record_dpoa_agent" USING btree ("consent_record_id") WHERE agent_kind = 'alternate_2' AND removed_at IS NULL;--> statement-breakpoint
CREATE INDEX "ix_cr_revocation_consent" ON "consent_revocation" USING btree ("consent_record_id");--> statement-breakpoint
CREATE INDEX "ix_cr_revocation_cascade_stuck" ON "consent_revocation" USING btree ("cascade_status","cascade_started_at") WHERE cascade_status IN ('pending', 'in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cer_idem" ON "consent_expiration_reminder" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "ix_cer_pending" ON "consent_expiration_reminder" USING btree ("scheduled_for") WHERE fired_at IS NULL;--> statement-breakpoint
CREATE INDEX "ix_cer_consent" ON "consent_expiration_reminder" USING btree ("consent_record_id");--> statement-breakpoint
CREATE INDEX "ix_da_patient_caregiver" ON "delegated_access" USING btree ("patient_id","delegate_caregiver_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "ix_da_active_by_patient" ON "delegated_access" USING btree ("organization_id","patient_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "ix_cdl_document" ON "consent_document_link" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "ix_cea_patient_type" ON "consent_eval_audit" USING btree ("organization_id","patient_id","type_key","evaluated_at");--> statement-breakpoint
CREATE INDEX "ix_cea_caller" ON "consent_eval_audit" USING btree ("caller_module","caller_route","evaluated_at");--> statement-breakpoint
CREATE INDEX "ix_cea_record" ON "consent_eval_audit" USING btree ("consent_record_id","evaluated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_crc_source_open" ON "consent_renewal_cycle" USING btree ("source_consent_record_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "ix_crc_open_by_patient" ON "consent_renewal_cycle" USING btree ("organization_id","patient_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "patient_name_search_idx" ON "patient" USING gin ((lower("legal_last_name" || ' ' || "legal_first_name")) gin_trgm_ops);