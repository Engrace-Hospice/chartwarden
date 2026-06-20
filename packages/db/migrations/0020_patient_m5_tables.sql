CREATE TYPE "public"."patient_address_kind" AS ENUM('home', 'facility', 'mailing', 'temporary', 'prior');
--> statement-breakpoint
CREATE TYPE "public"."patient_amendment_status" AS ENUM('pending', 'accepted', 'denied', 'withdrawn');
--> statement-breakpoint
CREATE TYPE "public"."patient_assignment_role" AS ENUM('primary_rn', 'attending_clinician', 'case_manager_msw', 'chaplain', 'aide', 'np', 'md', 'volunteer', 'bereavement');
--> statement-breakpoint
CREATE TYPE "public"."patient_caregiver_lr_authority" AS ENUM('dpoa_healthcare', 'guardian', 'next_of_kin', 'none');
--> statement-breakpoint
CREATE TYPE "public"."patient_caregiver_relationship" AS ENUM('spouse', 'child', 'parent', 'sibling', 'other_family', 'friend', 'guardian', 'paid_caregiver');
--> statement-breakpoint
CREATE TYPE "public"."patient_identifier_kind" AS ENUM('mrn', 'mbi', 'ssn', 'state_id', 'prior_mrn', 'hospice_external', 'partner_mrn');
--> statement-breakpoint
CREATE TYPE "public"."patient_match_review_status" AS ENUM('open', 'merged', 'not_a_match', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."patient_payer_coverage_kind" AS ENUM('medicare_ffs', 'medicare_advantage', 'medicaid', 'commercial', 'hospice_carve_out', 'self_pay');
--> statement-breakpoint
CREATE TYPE "public"."patient_phone_kind" AS ENUM('mobile', 'home', 'work', 'facility');
--> statement-breakpoint
CREATE TYPE "public"."patient_status" AS ENUM('prospective', 'active', 'on_hold', 'discharged', 'deceased', 'merged');
--> statement-breakpoint
CREATE TABLE "patient" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"mrn" text NOT NULL,
	"legal_first_name" text NOT NULL,
	"legal_middle_name" text,
	"legal_last_name" text NOT NULL,
	"legal_name_suffix" text,
	"dob" date NOT NULL,
	"sex_assigned_at_birth" text NOT NULL,
	"gender_identity_code" text,
	"sexual_orientation_code" text,
	"pronouns_code" text,
	"marital_status_code" text,
	"race_codes" text[],
	"ethnicity_codes" text[],
	"status" "patient_status" DEFAULT 'prospective' NOT NULL,
	"deceased_date" date,
	"npp_acknowledgment_doc_ref" uuid,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_deceased_requires_date" CHECK (("patient"."status" <> 'deceased') OR ("patient"."deceased_date" IS NOT NULL)),
	CONSTRAINT "patient_dob_not_future" CHECK ("patient"."dob" <= CURRENT_DATE),
	CONSTRAINT "patient_merged_requires_target" CHECK (("patient"."status" <> 'merged') OR ("patient"."merged_into_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "patient_identifier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"kind" "patient_identifier_kind" NOT NULL,
	"value" text,
	"value_encrypted" "bytea",
	"value_last4" text,
	"issuer" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_identifier_sensitive_encrypted" CHECK (("patient_identifier"."kind" NOT IN ('ssn','state_id')) OR ("patient_identifier"."value_encrypted" IS NOT NULL AND "patient_identifier"."value" IS NULL)),
	CONSTRAINT "patient_identifier_public_plaintext" CHECK (("patient_identifier"."kind" IN ('ssn','state_id')) OR ("patient_identifier"."value" IS NOT NULL)),
	CONSTRAINT "patient_identifier_mbi_format" CHECK (("patient_identifier"."kind" <> 'mbi') OR ("patient_identifier"."value" ~ '^[1-9][AC-HJ-NP-RT-Y][0-9AC-HJ-NP-RT-Y]{9}$'))
);
--> statement-breakpoint
CREATE TABLE "patient_name_alias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"kind" text NOT NULL,
	"first_name" text,
	"middle_name" text,
	"last_name" text,
	"full_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_address" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"kind" "patient_address_kind" DEFAULT 'home' NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"state" text,
	"postal_code" text NOT NULL,
	"country" text DEFAULT 'US' NOT NULL,
	"county" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"geocode_lat" numeric(9, 6),
	"geocode_lng" numeric(9, 6),
	"facility_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_address_us_state_required" CHECK (("patient_address"."country" <> 'US') OR ("patient_address"."state" IS NOT NULL)),
	CONSTRAINT "patient_address_dates" CHECK ("patient_address"."effective_to" IS NULL OR "patient_address"."effective_to" >= "patient_address"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "patient_phone" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"kind" "patient_phone_kind" DEFAULT 'home' NOT NULL,
	"e164" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_email" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"email" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_payer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"payer_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"coverage_kind" "patient_payer_coverage_kind" NOT NULL,
	"subscriber_id" text NOT NULL,
	"group_number" text,
	"bin_pcn" text,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"card_image_doc_ref" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "caregiver" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"preferred_language_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_caregiver" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"caregiver_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"relationship" "patient_caregiver_relationship" NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"is_legal_representative" boolean DEFAULT false NOT NULL,
	"lr_authority" "patient_caregiver_lr_authority" DEFAULT 'none' NOT NULL,
	"lr_proof_doc_ref" uuid,
	"portal_invitation_consented" boolean DEFAULT false NOT NULL,
	"involvement_from" date NOT NULL,
	"involvement_to" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_caregiver_lr_authority_requires_flag" CHECK (("patient_caregiver"."lr_authority" = 'none') OR ("patient_caregiver"."is_legal_representative" = true))
);
--> statement-breakpoint
CREATE TABLE "emergency_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"name" text NOT NULL,
	"relationship" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"priority" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_communication_preference" (
	"patient_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"preferred_language_code" text,
	"interpreter_needed" boolean DEFAULT false NOT NULL,
	"preferred_channel" text,
	"accessible_format" text,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"do_not_mail_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"clinician_user_id" uuid NOT NULL,
	"role" "patient_assignment_role" NOT NULL,
	"assigned_at" date NOT NULL,
	"unassigned_at" date,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_privacy_flag_snapshot" (
	"patient_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"flags" text[] NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_consent_version" uuid,
	"invalidated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "patient_match_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"candidate_existing_patient_id" uuid NOT NULL,
	"new_patient_id" uuid,
	"candidate_incoming" jsonb NOT NULL,
	"score" numeric(5, 4) NOT NULL,
	"feature_breakdown" jsonb NOT NULL,
	"status" "patient_match_review_status" DEFAULT 'open' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_merge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"source_patient_id" uuid NOT NULL,
	"target_patient_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"merged_field_diff" jsonb NOT NULL,
	"performed_by" uuid,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unmerged_at" timestamp with time zone,
	"unmerged_by" uuid,
	CONSTRAINT "patient_merge_no_self" CHECK ("patient_merge"."source_patient_id" <> "patient_merge"."target_patient_id")
);
--> statement-breakpoint
CREATE TABLE "patient_amendment_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid,
	"location_id" uuid,
	"patient_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"requested_changes" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"status" "patient_amendment_status" DEFAULT 'pending' NOT NULL,
	"reviewer_user_id" uuid,
	"denial_reason" text,
	"statement_of_disagreement" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"sla_due_at" timestamp with time zone NOT NULL,
	CONSTRAINT "patient_amendment_request_denial_reason_required" CHECK (("patient_amendment_request"."status" <> 'denied') OR ("patient_amendment_request"."denial_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient" ADD CONSTRAINT "patient_merged_into_id_patient_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_identifier" ADD CONSTRAINT "patient_identifier_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_identifier" ADD CONSTRAINT "patient_identifier_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_identifier" ADD CONSTRAINT "patient_identifier_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_identifier" ADD CONSTRAINT "patient_identifier_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_name_alias" ADD CONSTRAINT "patient_name_alias_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_name_alias" ADD CONSTRAINT "patient_name_alias_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_name_alias" ADD CONSTRAINT "patient_name_alias_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_name_alias" ADD CONSTRAINT "patient_name_alias_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_address" ADD CONSTRAINT "patient_address_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_address" ADD CONSTRAINT "patient_address_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_address" ADD CONSTRAINT "patient_address_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_address" ADD CONSTRAINT "patient_address_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_phone" ADD CONSTRAINT "patient_phone_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_phone" ADD CONSTRAINT "patient_phone_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_phone" ADD CONSTRAINT "patient_phone_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_phone" ADD CONSTRAINT "patient_phone_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_email" ADD CONSTRAINT "patient_email_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_email" ADD CONSTRAINT "patient_email_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_email" ADD CONSTRAINT "patient_email_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_email" ADD CONSTRAINT "patient_email_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_payer" ADD CONSTRAINT "patient_payer_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_payer" ADD CONSTRAINT "patient_payer_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_payer" ADD CONSTRAINT "patient_payer_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_payer" ADD CONSTRAINT "patient_payer_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "caregiver" ADD CONSTRAINT "caregiver_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "caregiver" ADD CONSTRAINT "caregiver_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "caregiver" ADD CONSTRAINT "caregiver_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_caregiver" ADD CONSTRAINT "patient_caregiver_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_caregiver" ADD CONSTRAINT "patient_caregiver_caregiver_id_caregiver_id_fk" FOREIGN KEY ("caregiver_id") REFERENCES "public"."caregiver"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_caregiver" ADD CONSTRAINT "patient_caregiver_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_caregiver" ADD CONSTRAINT "patient_caregiver_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_caregiver" ADD CONSTRAINT "patient_caregiver_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emergency_contact" ADD CONSTRAINT "emergency_contact_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emergency_contact" ADD CONSTRAINT "emergency_contact_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emergency_contact" ADD CONSTRAINT "emergency_contact_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "emergency_contact" ADD CONSTRAINT "emergency_contact_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_communication_preference" ADD CONSTRAINT "patient_communication_preference_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_communication_preference" ADD CONSTRAINT "patient_communication_preference_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_communication_preference" ADD CONSTRAINT "patient_communication_preference_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_communication_preference" ADD CONSTRAINT "patient_communication_preference_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_assignment" ADD CONSTRAINT "patient_assignment_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_assignment" ADD CONSTRAINT "patient_assignment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_assignment" ADD CONSTRAINT "patient_assignment_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_assignment" ADD CONSTRAINT "patient_assignment_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_assignment" ADD CONSTRAINT "patient_assignment_clinician_user_id_user_id_fk" FOREIGN KEY ("clinician_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_privacy_flag_snapshot" ADD CONSTRAINT "patient_privacy_flag_snapshot_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_privacy_flag_snapshot" ADD CONSTRAINT "patient_privacy_flag_snapshot_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_privacy_flag_snapshot" ADD CONSTRAINT "patient_privacy_flag_snapshot_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_privacy_flag_snapshot" ADD CONSTRAINT "patient_privacy_flag_snapshot_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_match_review" ADD CONSTRAINT "patient_match_review_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_match_review" ADD CONSTRAINT "patient_match_review_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_match_review" ADD CONSTRAINT "patient_match_review_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_match_review" ADD CONSTRAINT "patient_match_review_candidate_existing_patient_id_patient_id_fk" FOREIGN KEY ("candidate_existing_patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_match_review" ADD CONSTRAINT "patient_match_review_new_patient_id_patient_id_fk" FOREIGN KEY ("new_patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_match_review" ADD CONSTRAINT "patient_match_review_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_source_patient_id_patient_id_fk" FOREIGN KEY ("source_patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_target_patient_id_patient_id_fk" FOREIGN KEY ("target_patient_id") REFERENCES "public"."patient"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_performed_by_user_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_merge" ADD CONSTRAINT "patient_merge_unmerged_by_user_id_fk" FOREIGN KEY ("unmerged_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_amendment_request" ADD CONSTRAINT "patient_amendment_request_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_amendment_request" ADD CONSTRAINT "patient_amendment_request_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_amendment_request" ADD CONSTRAINT "patient_amendment_request_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_amendment_request" ADD CONSTRAINT "patient_amendment_request_patient_id_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patient"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_amendment_request" ADD CONSTRAINT "patient_amendment_request_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "patient_amendment_request" ADD CONSTRAINT "patient_amendment_request_reviewer_user_id_user_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "patient_org_idx" ON "patient" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX "patient_org_loc_mrn_idx" ON "patient" USING btree ("organization_id","location_id","mrn");
--> statement-breakpoint
CREATE UNIQUE INDEX "patient_mrn_org_unique" ON "patient" USING btree ("organization_id","mrn");
--> statement-breakpoint
CREATE INDEX "patient_name_search_idx" ON "patient" USING gin ((lower("legal_last_name" || ' ' || "legal_first_name")) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "patient_dob_idx" ON "patient" USING btree ("organization_id","dob");
--> statement-breakpoint
CREATE INDEX "patient_status_idx" ON "patient" USING btree ("organization_id","status");
--> statement-breakpoint
CREATE INDEX "patient_identifier_patient_idx" ON "patient_identifier" USING btree ("patient_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "patient_identifier_mrn_unique" ON "patient_identifier" USING btree ("organization_id","value") WHERE "patient_identifier"."kind" = 'mrn';
--> statement-breakpoint
CREATE UNIQUE INDEX "patient_identifier_mbi_unique" ON "patient_identifier" USING btree ("organization_id","value") WHERE "patient_identifier"."kind" = 'mbi' AND "patient_identifier"."effective_to" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "patient_identifier_prior_mrn_unique" ON "patient_identifier" USING btree ("organization_id","issuer","value") WHERE "patient_identifier"."kind" = 'prior_mrn';
--> statement-breakpoint
CREATE INDEX "patient_identifier_partner_mrn_idx" ON "patient_identifier" USING btree ("organization_id","issuer","value") WHERE "patient_identifier"."kind" = 'partner_mrn';
--> statement-breakpoint
CREATE INDEX "patient_name_alias_patient_idx" ON "patient_name_alias" USING btree ("patient_id");
--> statement-breakpoint
CREATE INDEX "patient_address_patient_idx" ON "patient_address" USING btree ("patient_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "patient_address_primary_unique" ON "patient_address" USING btree ("patient_id") WHERE "patient_address"."is_primary" = true AND "patient_address"."effective_to" IS NULL;
--> statement-breakpoint
CREATE INDEX "patient_phone_patient_idx" ON "patient_phone" USING btree ("patient_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "patient_phone_primary_unique" ON "patient_phone" USING btree ("patient_id") WHERE "patient_phone"."is_primary" = true;
--> statement-breakpoint
CREATE INDEX "patient_email_patient_idx" ON "patient_email" USING btree ("patient_id");
--> statement-breakpoint
CREATE INDEX "patient_payer_patient_idx" ON "patient_payer" USING btree ("patient_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "patient_payer_active_rank_unique" ON "patient_payer" USING btree ("patient_id","rank") WHERE "patient_payer"."effective_to" IS NULL;
--> statement-breakpoint
CREATE INDEX "caregiver_org_idx" ON "caregiver" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX "patient_caregiver_patient_idx" ON "patient_caregiver" USING btree ("patient_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "patient_caregiver_primary_unique" ON "patient_caregiver" USING btree ("patient_id") WHERE "patient_caregiver"."is_primary" = true AND "patient_caregiver"."involvement_to" IS NULL;
--> statement-breakpoint
CREATE INDEX "emergency_contact_patient_idx" ON "emergency_contact" USING btree ("patient_id");
--> statement-breakpoint
CREATE INDEX "patient_assignment_patient_idx" ON "patient_assignment" USING btree ("patient_id");
--> statement-breakpoint
CREATE INDEX "patient_assignment_clinician_active_idx" ON "patient_assignment" USING btree ("clinician_user_id") WHERE "patient_assignment"."unassigned_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "patient_assignment_primary_rn_unique" ON "patient_assignment" USING btree ("patient_id","role") WHERE "patient_assignment"."role" = 'primary_rn' AND "patient_assignment"."unassigned_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "patient_privacy_flag_snapshot_org_idx" ON "patient_privacy_flag_snapshot" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX "patient_match_review_org_idx" ON "patient_match_review" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX "patient_match_review_open_idx" ON "patient_match_review" USING btree ("organization_id") WHERE "patient_match_review"."status" = 'open';
--> statement-breakpoint
CREATE INDEX "patient_merge_org_idx" ON "patient_merge" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX "patient_merge_source_idx" ON "patient_merge" USING btree ("source_patient_id");
--> statement-breakpoint
CREATE INDEX "patient_merge_target_idx" ON "patient_merge" USING btree ("target_patient_id");
--> statement-breakpoint
CREATE INDEX "patient_amendment_request_patient_idx" ON "patient_amendment_request" USING btree ("patient_id");
--> statement-breakpoint
CREATE INDEX "patient_amendment_request_sla_idx" ON "patient_amendment_request" USING btree ("sla_due_at") WHERE "patient_amendment_request"."status" = 'pending';
