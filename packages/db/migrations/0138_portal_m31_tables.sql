-- M31 Patient/Family Portal & Telehealth §3.3 — the 5 enum types + the THREE manifest-owned tables with
-- their indexes and CHECKs. RLS, grants and the M4 write-audit triggers land in 0139. (ADR-0005: the
-- manifest owns exactly these three; the spec §2.1 15-entity ERD is a proposal and its other entities —
-- invitations, sessions, uploads, recordings, webhook events, … — never materialize as M31 tables.)
--
-- SCOPE / no partitions: all three are current-row tables at bounded volume (one account per caregiver,
-- one active grant per account×patient, one telehealth row per M17 visit); every dominant query is a
-- current-row read, so none is partitioned. The spec's high-volume time-keyed tables (portal_audit_view,
-- telehealth_webhook_event) that §3.2 would partition are NOT owned by the manifest.
--
-- TENANCY (ARCH-011 / ADR-0010 / §3.5): every table carries organization_id NOT NULL and the RLS predicate
-- (0139) keys on app.org_id ALONE. portal_account is NOT patient-scoped — an account reaches patients only
-- through portal_access_grant — so it carries no provider_entity_id/location_id (the three-column rule is
-- for PHI-bearing rows). The two patient-bearing tables (portal_access_grant, telehealth_visit) DO carry
-- provider_entity_id NOT NULL + location_id (NULLABLE), denormalized from the patient's admission / the M17
-- visit at write time so the §4.3 engagement + telehealth-metrics seams roll up per CCN/location without
-- joining through M5/M6. §3.3's Drizzle sketch omits those two columns; ARCH-011 is authoritative and
-- check-tenancy requires them.
--
-- CROSS-MODULE FK POLICY (architecture wins): only organization_id / provider_entity_id / location_id (M1
-- core), user_id (M2 `user`) and the intra-M31 portal_account parent get real FK constraints. patient_id
-- (M5), source_consent_record_id (M39), m17_visit_id (M17), assigned_membership_id / granted_by /
-- revoked_by_membership_id (M2 membership) and linked_encounter_id (M8) are LOGICAL uuid, validated at the
-- write boundary. `revoke_cascade_source`, `scheduled_visit_setting` and `end_reason` are text validated
-- against the @wardenx/types unions (PortalGrantRevokeCascadeSource / TelehealthScheduledVisitSetting /
-- TelehealthEndReason), not pinned as pgEnums (§3.3).
CREATE TYPE "public"."portal_account_relationship" AS ENUM('patient_self', 'family_caregiver', 'dpoa_healthcare_agent', 'personal_representative_post_death', 'bereaved_family_member');--> statement-breakpoint
CREATE TYPE "public"."portal_account_status" AS ENUM('invited', 'active', 'suspended', 'revoked', 'bereaved');--> statement-breakpoint
CREATE TYPE "public"."portal_access_grant_kind" AS ENUM('family_caregiver', 'dpoa_healthcare', 'patient_self', 'personal_representative', 'bereaved_family');--> statement-breakpoint
CREATE TYPE "public"."telehealth_lifecycle_state" AS ENUM('room_minted', 'patient_joined', 'clinician_joined', 'in_progress', 'ended_clean', 'ended_aborted', 'reconciled');--> statement-breakpoint
CREATE TYPE "public"."telehealth_vendor" AS ENUM('daily_co', 'twilio_video', 'native_webrtc');--> statement-breakpoint

-- ============================================================================================
-- portal_account — D2's account ROOT. One row per (org, M2 user, relationship). NOT patient-scoped
-- (per-patient reach is a portal_access_grant), so no PE/location. The three *_cipher columns are
-- envelope-encrypted contact PHI and are §3.6 audit-denylisted in 0139.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "portal_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"relationship" "portal_account_relationship" NOT NULL,
	"status" "portal_account_status" DEFAULT 'invited' NOT NULL,
	"display_name_cipher" text NOT NULL,
	"email_cipher" text NOT NULL,
	"phone_cipher" text,
	"preferred_language_iso639" text DEFAULT 'en' NOT NULL,
	"two_factor_enrolled" boolean DEFAULT false NOT NULL,
	"passkey_enrolled" boolean DEFAULT false NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"last_active_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_account_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "portal_account_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict,
	CONSTRAINT "portal_account_activated_requires_invited" CHECK ("activated_at" IS NULL OR "invited_at" IS NOT NULL),
	CONSTRAINT "portal_account_revoked_terminal" CHECK ("revoked_at" IS NULL OR "status" = 'revoked')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_account_org_idx" ON "portal_account" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_account_user_idx" ON "portal_account" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portal_account_active_org_user_rel_unique" ON "portal_account" ("organization_id","user_id","relationship") WHERE revoked_at IS NULL;--> statement-breakpoint

-- ============================================================================================
-- portal_access_grant — D5/D6/D7's per-patient authorization. Patient-bearing → carries the ARCH-011
-- provider_entity_id + location_id. scope_set_jsonb (§2.3 resolved scope) + revoke_reason_cipher are
-- §3.6 audit-denylisted (0139). One ACTIVE grant per (account, patient); a re-grant is a new row.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "portal_access_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"portal_account_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"grant_kind" "portal_access_grant_kind" NOT NULL,
	"scope_set_jsonb" jsonb NOT NULL,
	"source_consent_record_id" uuid NOT NULL,
	"source_consent_version" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by_membership_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason_cipher" text,
	"revoked_by_membership_id" uuid,
	"revoke_cascade_source" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_access_grant_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "portal_access_grant_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "portal_access_grant_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "portal_access_grant_portal_account_id_fk" FOREIGN KEY ("portal_account_id") REFERENCES "public"."portal_account"("id") ON DELETE restrict,
	CONSTRAINT "portal_access_grant_revoked_requires_source" CHECK ("revoked_at" IS NULL OR "revoke_cascade_source" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_access_grant_org_idx" ON "portal_access_grant" ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_access_grant_account_patient_idx" ON "portal_access_grant" ("portal_account_id","patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_access_grant_patient_active_idx" ON "portal_access_grant" ("organization_id","patient_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portal_access_grant_account_patient_active_unique" ON "portal_access_grant" ("portal_account_id","patient_id") WHERE revoked_at IS NULL;--> statement-breakpoint

-- ============================================================================================
-- telehealth_visit — D8/D14's video-visit ROOT, unique per M17 visit. Patient-bearing → carries the
-- ARCH-011 provider_entity_id + location_id. The two vendor_room_*_cipher columns + end_reason_detail_cipher
-- are §3.6 audit-denylisted (0139). M8 attaches the encounter (linked_encounter_id) on visit_ended.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "telehealth_visit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"m17_visit_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"assigned_membership_id" uuid NOT NULL,
	"lifecycle_state" "telehealth_lifecycle_state" DEFAULT 'room_minted' NOT NULL,
	"vendor" "telehealth_vendor" NOT NULL,
	"vendor_room_id_cipher" text NOT NULL,
	"vendor_room_url_cipher" text NOT NULL,
	"scheduled_visit_setting" text NOT NULL,
	"audio_only_fallback_active" boolean DEFAULT false NOT NULL,
	"recording_enabled" boolean DEFAULT false NOT NULL,
	"recording_requested" boolean DEFAULT false NOT NULL,
	"room_minted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_participant_joined_at" timestamp with time zone,
	"visit_started_at" timestamp with time zone,
	"visit_ended_at" timestamp with time zone,
	"total_duration_sec" integer,
	"end_reason" text,
	"end_reason_detail_cipher" text,
	"linked_encounter_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telehealth_visit_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "telehealth_visit_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "telehealth_visit_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "telehealth_visit_recording_requires_enabled" CHECK ("recording_requested" = false OR "recording_enabled" = true),
	CONSTRAINT "telehealth_visit_ended_requires_end_reason" CHECK ("lifecycle_state" NOT IN ('ended_clean','ended_aborted') OR "end_reason" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telehealth_visit_org_idx" ON "telehealth_visit" ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telehealth_visit_m17_visit_unique" ON "telehealth_visit" ("m17_visit_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telehealth_visit_patient_idx" ON "telehealth_visit" ("patient_id","room_minted_at");
