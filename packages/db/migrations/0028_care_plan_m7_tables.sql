CREATE TYPE "public"."care_plan_signer_role" AS ENUM('rn_case_manager', 'hospice_physician', 'nurse_practitioner', 'msw', 'chaplain', 'medical_director');--> statement-breakpoint
CREATE TYPE "public"."care_plan_status" AS ENUM('draft', 'active', 'discharged');--> statement-breakpoint
CREATE TYPE "public"."care_plan_version_kind" AS ENUM('initial', 'idg_review', 'interim_revision', 'discharge');--> statement-breakpoint
CREATE TYPE "public"."care_plan_version_status" AS ENUM('draft', 'in_review', 'signed', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."goal_source" AS ENUM('clinical', 'patient_stated', 'family_stated', 'agent_stated');--> statement-breakpoint
CREATE TYPE "public"."goal_status" AS ENUM('not_started', 'in_progress', 'met', 'not_met', 'revised', 'discontinued');--> statement-breakpoint
CREATE TYPE "public"."intervention_discipline" AS ENUM('rn', 'lpn', 'chha', 'msw', 'chaplain', 'md_np', 'pt', 'ot', 'st', 'volunteer', 'music_therapy', 'dietitian', 'bereavement');--> statement-breakpoint
CREATE TYPE "public"."intervention_status" AS ENUM('active', 'discontinued', 'completed');--> statement-breakpoint
CREATE TYPE "public"."problem_kind" AS ENUM('terminal', 'related', 'unrelated');--> statement-breakpoint
CREATE TYPE "public"."problem_source" AS ENUM('clinical', 'patient_reported', 'family_reported', 'history', 'intake_extraction');--> statement-breakpoint
CREATE TYPE "public"."problem_status" AS ENUM('active', 'resolved', 'inactive');--> statement-breakpoint
CREATE TABLE "care_plan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"status" "care_plan_status" DEFAULT 'draft' NOT NULL,
	"initial_due_at" timestamp with time zone NOT NULL,
	"initial_signed_at" timestamp with time zone,
	"next_review_due_at" timestamp with time zone,
	"active_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "care_plan_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"care_plan_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"status" "care_plan_version_status" DEFAULT 'draft' NOT NULL,
	"kind" "care_plan_version_kind" NOT NULL,
	"idg_meeting_id" uuid,
	"state_snapshot" jsonb,
	"required_signer_set" jsonb NOT NULL,
	"patient_understanding_text" text,
	"drafted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"drafted_by_membership_id" uuid
);
--> statement-breakpoint
CREATE TABLE "care_plan_signature" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"care_plan_version_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"signer_role" "care_plan_signer_role" NOT NULL,
	"signature_method" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attestation_text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "problem" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"care_plan_id" uuid NOT NULL,
	"icd10_code" text,
	"snomed_code" text,
	"description" text NOT NULL,
	"kind" "problem_kind" NOT NULL,
	"source" "problem_source" DEFAULT 'clinical' NOT NULL,
	"sud_related" boolean DEFAULT false NOT NULL,
	"status" "problem_status" DEFAULT 'active' NOT NULL,
	"onset_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"added_by_membership_id" uuid,
	"added_by_discipline" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"care_plan_id" uuid NOT NULL,
	"problem_id" uuid NOT NULL,
	"original_text" text NOT NULL,
	"revised_text" text,
	"source" "goal_source" NOT NULL,
	"acting_consent_id" uuid,
	"measurable_outcome" text,
	"target_at" timestamp with time zone,
	"status" "goal_status" DEFAULT 'not_started' NOT NULL,
	"status_note" text,
	"added_by_membership_id" uuid,
	"added_by_discipline" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intervention" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"care_plan_id" uuid NOT NULL,
	"problem_id" uuid NOT NULL,
	"goal_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scope_text" text NOT NULL,
	"frequency_text" text NOT NULL,
	"frequency_value" text NOT NULL,
	"discipline" "intervention_discipline" NOT NULL,
	"responsible_role" text,
	"linked_order_id" uuid,
	"status" "intervention_status" DEFAULT 'active' NOT NULL,
	"discontinue_reason" text,
	"added_by_membership_id" uuid,
	"added_by_discipline" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "care_plan" ADD CONSTRAINT "care_plan_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan" ADD CONSTRAINT "care_plan_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan" ADD CONSTRAINT "care_plan_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_version" ADD CONSTRAINT "care_plan_version_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_version" ADD CONSTRAINT "care_plan_version_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_version" ADD CONSTRAINT "care_plan_version_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_version" ADD CONSTRAINT "care_plan_version_care_plan_id_care_plan_id_fk" FOREIGN KEY ("care_plan_id") REFERENCES "public"."care_plan"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_version" ADD CONSTRAINT "care_plan_version_drafted_by_membership_id_membership_id_fk" FOREIGN KEY ("drafted_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_signature" ADD CONSTRAINT "care_plan_signature_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_signature" ADD CONSTRAINT "care_plan_signature_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_signature" ADD CONSTRAINT "care_plan_signature_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_signature" ADD CONSTRAINT "care_plan_signature_care_plan_version_id_care_plan_version_id_fk" FOREIGN KEY ("care_plan_version_id") REFERENCES "public"."care_plan_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_plan_signature" ADD CONSTRAINT "care_plan_signature_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem" ADD CONSTRAINT "problem_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem" ADD CONSTRAINT "problem_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem" ADD CONSTRAINT "problem_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem" ADD CONSTRAINT "problem_care_plan_id_care_plan_id_fk" FOREIGN KEY ("care_plan_id") REFERENCES "public"."care_plan"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem" ADD CONSTRAINT "problem_added_by_membership_id_membership_id_fk" FOREIGN KEY ("added_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_care_plan_id_care_plan_id_fk" FOREIGN KEY ("care_plan_id") REFERENCES "public"."care_plan"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_problem_id_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problem"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal" ADD CONSTRAINT "goal_added_by_membership_id_membership_id_fk" FOREIGN KEY ("added_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention" ADD CONSTRAINT "intervention_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention" ADD CONSTRAINT "intervention_provider_entity_id_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention" ADD CONSTRAINT "intervention_location_id_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention" ADD CONSTRAINT "intervention_care_plan_id_care_plan_id_fk" FOREIGN KEY ("care_plan_id") REFERENCES "public"."care_plan"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention" ADD CONSTRAINT "intervention_problem_id_problem_id_fk" FOREIGN KEY ("problem_id") REFERENCES "public"."problem"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intervention" ADD CONSTRAINT "intervention_added_by_membership_id_membership_id_fk" FOREIGN KEY ("added_by_membership_id") REFERENCES "public"."membership"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "care_plan_org_patient_idx" ON "care_plan" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "care_plan_one_per_admission_uq" ON "care_plan" USING btree ("organization_id","admission_id") WHERE status <> 'discharged';--> statement-breakpoint
CREATE INDEX "care_plan_next_review_due_idx" ON "care_plan" USING btree ("next_review_due_at");--> statement-breakpoint
CREATE INDEX "care_plan_initial_due_idx" ON "care_plan" USING btree ("initial_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "care_plan_version_plan_seq_uq" ON "care_plan_version" USING btree ("care_plan_id","sequence");--> statement-breakpoint
CREATE INDEX "care_plan_version_plan_status_idx" ON "care_plan_version" USING btree ("care_plan_id","status");--> statement-breakpoint
CREATE INDEX "care_plan_version_signed_at_idx" ON "care_plan_version" USING btree ("signed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "care_plan_signature_version_role_uq" ON "care_plan_signature" USING btree ("care_plan_version_id","signer_role");--> statement-breakpoint
CREATE INDEX "care_plan_signature_version_idx" ON "care_plan_signature" USING btree ("care_plan_version_id");--> statement-breakpoint
CREATE INDEX "problem_plan_status_idx" ON "problem" USING btree ("care_plan_id","status");--> statement-breakpoint
CREATE INDEX "problem_kind_idx" ON "problem" USING btree ("care_plan_id","kind");--> statement-breakpoint
CREATE INDEX "problem_sud_idx" ON "problem" USING btree ("care_plan_id") WHERE sud_related = true;--> statement-breakpoint
CREATE INDEX "goal_plan_problem_idx" ON "goal" USING btree ("care_plan_id","problem_id");--> statement-breakpoint
CREATE INDEX "goal_source_idx" ON "goal" USING btree ("care_plan_id","source");--> statement-breakpoint
CREATE INDEX "goal_status_idx" ON "goal" USING btree ("care_plan_id","status");--> statement-breakpoint
CREATE INDEX "intervention_plan_problem_idx" ON "intervention" USING btree ("care_plan_id","problem_id");--> statement-breakpoint
CREATE INDEX "intervention_discipline_idx" ON "intervention" USING btree ("care_plan_id","discipline");--> statement-breakpoint
CREATE INDEX "intervention_status_idx" ON "intervention" USING btree ("care_plan_id","status");