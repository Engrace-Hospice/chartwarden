-- M20 Field Safety §3.2 Phase A + B / §3.3 — the 12 M20 enum types and the THIRTEEN owned tables with
-- their indexes and CHECK constraints. RLS, grants, the M4 write-audit triggers (with the §3.6 denylists)
-- and the §2.3 active-SOS guard on the location stream land in 0111.
--
-- ENUM NAMING: M20's §3.2 Phase-A block spells its type names WITHOUT an `m20_` prefix (as M19's does).
-- The spec is followed verbatim; none of the twelve names collides with an existing type in the cluster,
-- and `packages/db/src/enums.ts` (M20-T01) already declares the matching pgEnums under the same names.
--
-- ONE SPEC AMENDMENT, carried from M20-T01: `safety_sos_lifecycle_state` gains `emergency_terminus`.
-- §2.2.2 and the M20-F05 / S13 / INT-031 remediation make it the mandated END of the life-safety chain —
-- the state a tier-3 SLA breach with no acknowledgment enters, which auto-dials the consented emergency
-- contact, surfaces M40's PSAP number to every recipient, pages WardenX ops, and KEEPS re-escalating until
-- a human acknowledges. The amendment updated the state machine, §8.8's audit catalog and the
-- `m20_sos_terminus_reached_total` metric and never updated the §3.2 CREATE TYPE block it came from.
-- Following Phase A verbatim would leave an unacknowledged 3 a.m. SOS sitting in `escalation_tier_3`
-- forever, which is the exact failure S13 exists to close. It is therefore also IN the SLA-watchdog's
-- partial index below: an index scoped to the three tier states would leave the terminus unscanned, which
-- is precisely how the loop would quietly stop.
--
-- TENANCY (ARCH-011 / ADR-0010): all thirteen tables carry organization_id NOT NULL and there is NO
-- org-NULL row anywhere in this module. Two §3.3 sketches said otherwise and the same document overrules
-- both: M20-F03 / §3.2 Phase E struck the org-NULL `safety_policy` platform row (the column is NOT NULL, so
-- the seed could never have inserted and would never have matched the tenant-scoped RLS — the floor is the
-- `SAFETY_POLICY_FLOOR` code constant instead, M18's geofence-floor precedent), and the same Phase routes
-- platform high-risk-area polygons to a SEPARATE pattern-2 platform-shared table rather than NULL-org rows
-- in `safety_high_risk_area`, because a NULL-org row in a tenant-scoped table is invisible to its own
-- tenant under RLS and reachable only through the `OR organization_id IS NULL` policy shape ADR-0010 D3
-- forbids. That platform table is not among the manifest's thirteen `ownedTables`, so it is not created
-- here; platform polygons ship as per-org seeded rows until a reviewed manifest edit lands it.
--
-- Eight tables additionally carry provider_entity_id NOT NULL + location_id NULLABLE — the three-column
-- rule architecture supplies and the §3.3 block omits: the two check-in tables, the three SOS tables, the
-- two incident tables and the acknowledgment. PE is DENORMALIZED onto the children (the M16 posture) so
-- the §4.3 seam rollups and M36's recipient resolution never join back to a parent under RLS. Location is
-- nullable because an SOS is raised wherever the clinician is, which is frequently not a Location the org
-- has on file, and an `ad_hoc` check-in has no visit to resolve one from.
--
-- `safety_supervisor_subscription` ALSO has location_id and provider_entity_id and they are NOT the
-- three-column rule: they are SCOPE SELECTORS saying what one subscription covers, which is why they are
-- nullable. The table holds no patient data at all — it is workforce paging configuration.
--
-- M20-F07 — NO PostGIS. §3.2 Phase F struck the `geometry(Polygon, 4326)` column and the GIST index: the
-- architecture DB stack is pgvector + pgcrypto only (ARCH-027) and M1 is frozen (ARCH-232). Polygons are
-- jsonb RINGS and point-in-polygon membership is an even-odd ray-cast in app code (M20-T03). §2.3's
-- "PostGIS ST_IsValid" enforcement row is likewise app-side: the CHECK here asserts the jsonb SHAPE, and
-- ring closure / winding / the ≥4-point minimum are the evaluator's. A geometry/GIST/ST_Within path for
-- Phase-2 scale needs its own architecture ADR (DR-restore drills, pgBackRest, CIS image baseline).
--
-- NOTHING IS PARTITIONED. `safety_sos_location_stream` is the only table with a plausible volume argument,
-- and it is self-limiting by design: one sample every 30 seconds during an active SOS, capped at 4 hours by
-- the D6 / §8.7 forced sunset (~480 rows per alert), with §3.7 physically deleting the stream at
-- SOS-resolve + 90 days. Partitioning it would forbid the real FK to `safety_sos_alert` that makes the
-- crypto-erase sweep one statement.
--
-- THREE DEFERRED FKs (`ALTER TABLE … ADD CONSTRAINT` at the bottom of each block) close reference CYCLES
-- Drizzle cannot express in a table literal: `safety_policy.current_version_id` → `safety_policy_version`,
-- `safety_check_in_schedule.fulfilled_by_check_in_id` → `safety_check_in`, and
-- `safety_sos_alert.linked_incident_id` → `safety_incident`. The §3.3 block calls each of them out; the
-- Drizzle model carries them as plain uuid because a cycle has no valid declaration order there.
--
-- CROSS-MODULE FK POLICY (architecture wins): only organization_id / provider_entity_id / location_id (M1
-- core) and the intra-M20 parents get real FK constraints. visit_id (M17), patient_id +
-- last_known_patient_id (M5), posted_via_device_id (M2), the `corrects_check_in_id` /
-- `superseded_by_check_in_id` correction pointers (bounded to 3 generations by the recorder, M20-T03) and
-- every `*_membership_id` (M2) are LOGICAL uuid, validated at the write boundary through the owning
-- module's seam — the M17 `visit.assigned_membership_id` precedent. The Drizzle `.references()` on the
-- membership columns is the ORM's view of the relationship; the SQL here is normative.
--
-- IDENTIFIER LENGTH: every constraint is explicitly named with an `m20_` prefix and a short table
-- abbreviation (sp / spv / scis / sci / ssa / ssls / ssash / si / sish / sack / sss / shra / secc).
-- PostgreSQL truncates identifiers at 63 characters, and Drizzle's default naming on a column like
-- `osha_reportable_signed_off_by_membership_id` truncates two DIFFERENT constraints to the same string
-- (the M16-T02 finding).
CREATE TYPE "public"."safety_check_in_kind" AS ENUM('pre_visit', 'mid_visit', 'post_visit', 'between_visits', 'ad_hoc');--> statement-breakpoint
CREATE TYPE "public"."safety_check_in_status" AS ENUM('ok', 'concerned_continue', 'concerned_stop');--> statement-breakpoint
CREATE TYPE "public"."safety_check_in_state" AS ENUM('proposed', 'recorded', 'overdue', 'escalated', 'superseded', 'incident_opened');--> statement-breakpoint
CREATE TYPE "public"."safety_sos_lifecycle_state" AS ENUM('raised', 'cancel_window_open', 'acknowledging', 'acknowledged', 'escalation_tier_1', 'escalation_tier_2', 'escalation_tier_3', 'emergency_terminus', 'resolving', 'resolved', 'cancelled_in_window', 'cancel_attempted_but_rejected', 'incident_opened');--> statement-breakpoint
CREATE TYPE "public"."safety_sos_cancel_status" AS ENUM('not_cancelled', 'cancelled_in_window', 'cancel_attempted_but_rejected');--> statement-breakpoint
CREATE TYPE "public"."safety_incident_category" AS ENUM('physical_assault', 'verbal_assault', 'threatened', 'dog_bite', 'animal_other', 'vehicle_accident_on_duty', 'theft_during_visit', 'medical_emergency_clinician_self', 'weather_emergency', 'environmental_hazard', 'near_miss', 'other');--> statement-breakpoint
CREATE TYPE "public"."safety_incident_severity" AS ENUM('minor', 'moderate', 'serious', 'life_threatening');--> statement-breakpoint
CREATE TYPE "public"."safety_incident_state" AS ENUM('draft', 'submitted', 'under_review', 'returned_to_clinician', 'closed_with_action_plan', 'closed_no_action', 'reopened');--> statement-breakpoint
CREATE TYPE "public"."safety_high_risk_category" AS ENUM('documented_prior_incident', 'community_self_reported_unsafe', 'nighttime_only_advisory', 'weather_advisory_seasonal', 'general_caution');--> statement-breakpoint
CREATE TYPE "public"."safety_subscription_model" AS ENUM('location_scoped', 'provider_entity_scoped', 'role_scoped', 'explicit_only');--> statement-breakpoint
CREATE TYPE "public"."safety_acknowledgment_target_kind" AS ENUM('sos_alert', 'incident', 'overdue_check_in');--> statement-breakpoint
CREATE TYPE "public"."safety_emergency_contact_consent_status" AS ENUM('granted', 'revoked', 'expired');--> statement-breakpoint

-- ============================================================================================
-- POLICY — safety_policy + safety_policy_version (§2.2.4 / D4). One policy row per tenant, many version
-- rows. Every other M20 row PINS the version it was written under, so a policy edit in 2027 cannot
-- retroactively change what cadence was in force during a 2025 incident.
--
-- `is_system_locked` stays on the policy row and means "platform ops froze THIS tenant's policy" — it is
-- NOT the M20-F03 platform-floor discriminator, because after Phase E there is no platform row to
-- discriminate. Both tables are org-level configuration with no person column, so neither carries the
-- three-column rule's PE + Location (the M19 `tenant_oncall_policy` posture).
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "safety_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"is_system_locked" boolean DEFAULT false NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_membership_id" uuid,
	CONSTRAINT "m20_sp_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "safety_policy_org_unique" ON "safety_policy" ("organization_id");--> statement-breakpoint

-- The tighten-only CHECKs below are the PLATFORM BAND from `SAFETY_POLICY_BOUNDS` (@wardenx/types), not the
-- floor defaults. §2.2.4/D4's rule is a band per knob and not one comparison, because "tighter" runs in
-- opposite directions: a SHORTER overdue threshold alerts the supervisor sooner, a SHORTER mid-visit cadence
-- makes the clinician check in more often, and a LONGER cancel window gives more chance to undo an
-- accidental press. The ladder CHECK is the one §2.2.4 does not state and D4 requires anyway: the four
-- overdue tiers are an ORDER, and a tenant that set escalation < supervisor_alert would page the medical
-- director before the supervisor. The editor (M20-T03) re-checks the same bounds to return 422 rather than a
-- constraint error.
CREATE TABLE IF NOT EXISTS "safety_policy_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"safety_policy_id" uuid NOT NULL,
	"mid_visit_cadence_minutes" integer NOT NULL,
	"mid_visit_min_visit_duration_minutes" integer NOT NULL,
	"pre_visit_window_minutes" integer NOT NULL,
	"post_visit_window_minutes" integer NOT NULL,
	"gentle_reminder_minutes" integer NOT NULL,
	"supervisor_alert_minutes" integer NOT NULL,
	"escalation_minutes" integer NOT NULL,
	"sos_equivalent_minutes" integer NOT NULL,
	"sos_cancel_window_seconds" integer NOT NULL,
	"sos_cancel_requires_biometric" boolean DEFAULT true NOT NULL,
	"sos_continuous_location_enabled" boolean DEFAULT false NOT NULL,
	"sos_continuous_location_sample_seconds" integer DEFAULT 30 NOT NULL,
	"sos_continuous_location_max_duration_hours" integer DEFAULT 4 NOT NULL,
	"sos_tier_1_sla_seconds" integer DEFAULT 60 NOT NULL,
	"sos_tier_2_sla_seconds" integer DEFAULT 120 NOT NULL,
	"sos_tier_3_sla_seconds" integer DEFAULT 300 NOT NULL,
	"subscription_model" "safety_subscription_model" DEFAULT 'location_scoped' NOT NULL,
	"after_hours_start_hour" integer DEFAULT 18 NOT NULL,
	"after_hours_end_hour" integer DEFAULT 8 NOT NULL,
	"osha_reportable_auto_flag_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_membership_id" uuid,
	"edit_reason" text,
	CONSTRAINT "m20_spv_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m20_spv_policy_fk" FOREIGN KEY ("safety_policy_id") REFERENCES "public"."safety_policy"("id") ON DELETE restrict,
	CONSTRAINT "m20_spv_window" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
	CONSTRAINT "m20_spv_cadence_band" CHECK ("mid_visit_cadence_minutes" BETWEEN 30 AND 120 AND "mid_visit_min_visit_duration_minutes" BETWEEN 15 AND 240 AND "pre_visit_window_minutes" BETWEEN 5 AND 60 AND "post_visit_window_minutes" BETWEEN 1 AND 30),
	CONSTRAINT "m20_spv_overdue_band" CHECK ("gentle_reminder_minutes" BETWEEN 1 AND 5 AND "supervisor_alert_minutes" BETWEEN 1 AND 15 AND "escalation_minutes" BETWEEN 1 AND 30 AND "sos_equivalent_minutes" BETWEEN 1 AND 60),
	CONSTRAINT "m20_spv_overdue_ladder" CHECK ("gentle_reminder_minutes" <= "supervisor_alert_minutes" AND "supervisor_alert_minutes" <= "escalation_minutes" AND "escalation_minutes" <= "sos_equivalent_minutes"),
	CONSTRAINT "m20_spv_sos_band" CHECK ("sos_cancel_window_seconds" BETWEEN 5 AND 30 AND "sos_continuous_location_sample_seconds" BETWEEN 10 AND 300 AND "sos_continuous_location_max_duration_hours" BETWEEN 1 AND 4 AND "sos_tier_1_sla_seconds" BETWEEN 15 AND 60 AND "sos_tier_2_sla_seconds" BETWEEN 30 AND 120 AND "sos_tier_3_sla_seconds" BETWEEN 60 AND 300),
	CONSTRAINT "m20_spv_after_hours" CHECK ("after_hours_start_hour" BETWEEN 0 AND 23 AND "after_hours_end_hour" BETWEEN 0 AND 23),
	CONSTRAINT "m20_spv_osha_list_array" CHECK (jsonb_typeof("osha_reportable_auto_flag_categories") = 'array')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spv_org_effective_idx" ON "safety_policy_version" ("organization_id","effective_from","effective_to");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spv_current_partial_idx" ON "safety_policy_version" ("organization_id") WHERE effective_to IS NULL;--> statement-breakpoint
-- Deferred FK #1: the policy↔version cycle.
ALTER TABLE "safety_policy" ADD CONSTRAINT "m20_sp_current_version_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."safety_policy_version"("id") ON DELETE restrict;--> statement-breakpoint

-- ============================================================================================
-- OBLIGATION + ATTESTATION — safety_check_in_schedule + safety_check_in (§2.2.1 / D2/D3/D4). Two tables on
-- purpose: the schedule is a timer the SYSTEM owns and the overdue detector scans, the check-in is a
-- statement a PERSON made and is append-only after the 5-minute amendment grace.
--
-- M20-F04 — the schedule's unique key is (visit_id, kind, expected_at), NOT (visit_id, kind). A
-- 90–120-minute visit materializes SEVERAL `mid_visit` cadence rows (D3 / §7.1), which the two-column key
-- forbade outright — a core feature was unbuildable. It also matches the declared §2.6 idempotency key, so
-- re-running the materializer for a visit that already has its schedule is the no-op §2.6 promises.
--
-- COORDINATES ARE OFF BY DEFAULT (D11). The coordinate CHECK makes the three columns move together in both
-- directions: a cipher with no accuracy is unusable evidence, and one with no `coordinates_consent_at` is a
-- location captured with no consent instant to replay — exactly what §8.7 exists to prevent.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "safety_check_in_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"visit_id" uuid,
	"clinician_membership_id" uuid NOT NULL,
	"kind" "safety_check_in_kind" NOT NULL,
	"expected_at" timestamp with time zone NOT NULL,
	"window_minutes" integer NOT NULL,
	"state" "safety_check_in_state" DEFAULT 'proposed' NOT NULL,
	"fulfilled_by_check_in_id" uuid,
	"overdue_detected_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"safety_policy_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m20_scis_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m20_scis_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m20_scis_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m20_scis_policy_version_fk" FOREIGN KEY ("safety_policy_version_id") REFERENCES "public"."safety_policy_version"("id") ON DELETE restrict,
	CONSTRAINT "m20_scis_window_positive" CHECK ("window_minutes" > 0),
	CONSTRAINT "m20_scis_visit_kind" CHECK (("kind" IN ('pre_visit','mid_visit','post_visit') AND "visit_id" IS NOT NULL) OR "kind" IN ('between_visits','ad_hoc')),
	CONSTRAINT "m20_scis_overdue_stamped" CHECK ("state" NOT IN ('overdue','escalated') OR "overdue_detected_at" IS NOT NULL),
	CONSTRAINT "m20_scis_escalated_stamped" CHECK ("state" <> 'escalated' OR "escalated_at" IS NOT NULL),
	CONSTRAINT "m20_scis_recorded_fulfilled" CHECK ("state" <> 'recorded' OR "fulfilled_by_check_in_id" IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scis_visit_kind_expected_uniq" ON "safety_check_in_schedule" ("visit_id","kind","expected_at") WHERE visit_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scis_clinician_expected_idx" ON "safety_check_in_schedule" ("clinician_membership_id","expected_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scis_overdue_scan_idx" ON "safety_check_in_schedule" ("organization_id","state","expected_at") WHERE state IN ('proposed','overdue');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "safety_check_in" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"schedule_id" uuid,
	"visit_id" uuid,
	"posted_by_membership_id" uuid NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" "safety_check_in_kind" NOT NULL,
	"status" "safety_check_in_status" NOT NULL,
	"concern_note" text,
	"posted_coordinates_cipher" bytea,
	"posted_coordinates_accuracy_m" integer,
	"coordinates_consent_at" timestamp with time zone,
	"posted_via_device_id" uuid,
	"corrects_check_in_id" uuid,
	"superseded_at" timestamp with time zone,
	"superseded_by_check_in_id" uuid,
	"safety_policy_version_id" uuid NOT NULL,
	"is_part_of_sos_bracket" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m20_sci_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m20_sci_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m20_sci_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m20_sci_schedule_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."safety_check_in_schedule"("id") ON DELETE restrict,
	CONSTRAINT "m20_sci_policy_version_fk" FOREIGN KEY ("safety_policy_version_id") REFERENCES "public"."safety_policy_version"("id") ON DELETE restrict,
	CONSTRAINT "m20_sci_concern_note" CHECK ("status" = 'ok' OR length(btrim("concern_note")) >= 20),
	CONSTRAINT "m20_sci_visit_kind" CHECK (("kind" IN ('pre_visit','mid_visit','post_visit') AND "visit_id" IS NOT NULL) OR "kind" IN ('between_visits','ad_hoc')),
	CONSTRAINT "m20_sci_coordinate_triple" CHECK (("posted_coordinates_cipher" IS NULL AND "posted_coordinates_accuracy_m" IS NULL AND "coordinates_consent_at" IS NULL) OR ("posted_coordinates_cipher" IS NOT NULL AND "posted_coordinates_accuracy_m" IS NOT NULL AND "posted_coordinates_accuracy_m" >= 0 AND "coordinates_consent_at" IS NOT NULL)),
	CONSTRAINT "m20_sci_supersession_pair" CHECK (("superseded_at" IS NULL AND "superseded_by_check_in_id" IS NULL) OR ("superseded_at" IS NOT NULL AND "superseded_by_check_in_id" IS NOT NULL)),
	CONSTRAINT "m20_sci_no_self_correction" CHECK ("corrects_check_in_id" IS NULL OR "corrects_check_in_id" <> "id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sci_membership_posted_idx" ON "safety_check_in" ("posted_by_membership_id","posted_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sci_visit_idx" ON "safety_check_in" ("visit_id") WHERE visit_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sci_active_uniq" ON "safety_check_in" ("schedule_id") WHERE superseded_at IS NULL AND schedule_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sci_purge_scan_idx" ON "safety_check_in" ("organization_id","posted_at") WHERE is_part_of_sos_bracket = false AND status = 'ok';--> statement-breakpoint
-- Deferred FK #2: the schedule↔check-in cycle.
ALTER TABLE "safety_check_in_schedule" ADD CONSTRAINT "m20_scis_fulfilled_by_fk" FOREIGN KEY ("fulfilled_by_check_in_id") REFERENCES "public"."safety_check_in"("id") ON DELETE restrict;--> statement-breakpoint

-- ============================================================================================
-- SOS — safety_sos_alert + safety_sos_location_stream + safety_sos_alert_state_history (§2.2.2 /
-- D5/D6/D7). One row per press.
--
-- THE PRESS IS NOT IDEMPOTENT AND THAT IS THE POINT (§2.6). Every press writes a row; the FAN-OUT is what
-- is idempotent, on the outbox event_id. There is deliberately NO unique key on (membership, posted_at) or
-- anything like it — a second press is a second call for help, and a schema that collapsed it into the
-- first would be the safety failure this module exists to prevent.
--
-- COORDINATES ARE REQUIRED HERE, unlike a routine check-in (D6/D11): the location at the moment of the
-- press is the single most useful fact a responder has, and `coordinates_consent_at` is NOT NULL beside it
-- so the consent instant is always replayable. M20-F16 is the boundary and it lives in the recorder, not
-- here: declining `sos_coordinates` consent does NOT disable SOS — the alert fans out either way.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "safety_sos_alert" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"posted_by_membership_id" uuid NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_via_device_id" uuid,
	"last_known_visit_id" uuid,
	"last_known_patient_id" uuid,
	"posted_coordinates_cipher" bytea NOT NULL,
	"posted_coordinates_accuracy_m" integer NOT NULL,
	"coordinates_consent_at" timestamp with time zone NOT NULL,
	"cancel_window_expired_at" timestamp with time zone NOT NULL,
	"cancel_status" "safety_sos_cancel_status" DEFAULT 'not_cancelled' NOT NULL,
	"cancel_attempted_at" timestamp with time zone,
	"cancel_biometric_result" text,
	"lifecycle_state" "safety_sos_lifecycle_state" DEFAULT 'raised' NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by_membership_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by_membership_id" uuid,
	"resolution_narrative_cipher" bytea,
	"outcome" text,
	"linked_incident_id" uuid,
	"safety_policy_version_id" uuid NOT NULL,
	"acknowledger_dispatch_payload_cipher" bytea,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m20_ssa_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m20_ssa_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m20_ssa_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m20_ssa_policy_version_fk" FOREIGN KEY ("safety_policy_version_id") REFERENCES "public"."safety_policy_version"("id") ON DELETE restrict,
	CONSTRAINT "m20_ssa_cancel_window" CHECK ("cancel_window_expired_at" > "posted_at"),
	CONSTRAINT "m20_ssa_accuracy" CHECK ("posted_coordinates_accuracy_m" >= 0),
	CONSTRAINT "m20_ssa_biometric_vocab" CHECK ("cancel_biometric_result" IS NULL OR "cancel_biometric_result" IN ('passed','failed','not_required')),
	CONSTRAINT "m20_ssa_outcome_vocab" CHECK ("outcome" IS NULL OR "outcome" IN ('no_action_needed','clinician_safe_continued','visit_cancelled','incident_opened','911_called','other')),
	CONSTRAINT "m20_ssa_cancel_attempt" CHECK (("cancel_status" = 'not_cancelled' AND "cancel_attempted_at" IS NULL AND "cancel_biometric_result" IS NULL) OR ("cancel_status" <> 'not_cancelled' AND "cancel_attempted_at" IS NOT NULL AND "cancel_biometric_result" IS NOT NULL)),
	CONSTRAINT "m20_ssa_cancel_lifecycle" CHECK (("cancel_status" = 'cancelled_in_window') = ("lifecycle_state" = 'cancelled_in_window')),
	CONSTRAINT "m20_ssa_ack_stamped" CHECK ("lifecycle_state" NOT IN ('acknowledged','resolving','resolved') OR ("acknowledged_at" IS NOT NULL AND "acknowledged_by_membership_id" IS NOT NULL)),
	CONSTRAINT "m20_ssa_resolved_stamped" CHECK ("lifecycle_state" <> 'resolved' OR ("resolved_at" IS NOT NULL AND "resolved_by_membership_id" IS NOT NULL AND "outcome" IS NOT NULL)),
	CONSTRAINT "m20_ssa_incident_linked" CHECK ("lifecycle_state" <> 'incident_opened' OR "linked_incident_id" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ssa_org_active_idx" ON "safety_sos_alert" ("organization_id","posted_at" DESC) WHERE lifecycle_state NOT IN ('resolved','cancelled_in_window','incident_opened');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ssa_posted_by_idx" ON "safety_sos_alert" ("posted_by_membership_id","posted_at" DESC);--> statement-breakpoint
-- `emergency_terminus` is IN this predicate on purpose; see the header amendment note.
CREATE INDEX IF NOT EXISTS "ssa_sla_scan_idx" ON "safety_sos_alert" ("organization_id","lifecycle_state") WHERE lifecycle_state IN ('acknowledging','escalation_tier_1','escalation_tier_2','escalation_tier_3','emergency_terminus');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "safety_sos_location_stream" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"sos_alert_id" uuid NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"coordinates_cipher" bytea NOT NULL,
	"accuracy_m" integer NOT NULL,
	"device_telemetry" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m20_ssls_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m20_ssls_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m20_ssls_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m20_ssls_alert_fk" FOREIGN KEY ("sos_alert_id") REFERENCES "public"."safety_sos_alert"("id") ON DELETE restrict,
	CONSTRAINT "m20_ssls_accuracy" CHECK ("accuracy_m" >= 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ssls_alert_sampled_idx" ON "safety_sos_location_stream" ("sos_alert_id","sampled_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ssls_org_sampled_idx" ON "safety_sos_location_stream" ("organization_id","sampled_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "safety_sos_alert_state_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"sos_alert_id" uuid NOT NULL,
	"from_state" "safety_sos_lifecycle_state",
	"to_state" "safety_sos_lifecycle_state" NOT NULL,
	"transitioned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"transitioned_by_membership_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m20_ssash_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m20_ssash_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m20_ssash_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m20_ssash_alert_fk" FOREIGN KEY ("sos_alert_id") REFERENCES "public"."safety_sos_alert"("id") ON DELETE restrict,
	CONSTRAINT "m20_ssash_no_self" CHECK ("from_state" IS NULL OR "from_state" <> "to_state")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ssash_alert_idx" ON "safety_sos_alert_state_history" ("sos_alert_id","transitioned_at");--> statement-breakpoint

-- ============================================================================================
-- INCIDENT — safety_incident + safety_incident_state_history (§2.2.3 / D9). `reopened` is a STATE on the
-- same row, not a second row: a second row would break the workers-comp timeline an insurer reads.
--
-- WHAT THE DATABASE CAN AND CANNOT ENFORCE, stated rather than assumed:
--   • §2.3's "`narrative_cipher` ≥ 200 chars for submit" as a DB CHECK: the column holds CIPHERTEXT and no
--     CHECK can measure plaintext length through it. `octet_length(...) >= 200` is the honest floor here
--     (AEAD ciphertext is never shorter than its plaintext, so a ≥200-char narrative always clears it) —
--     NECESSARY, not sufficient. The sufficient check is the submit service's, which sees the plaintext.
--   • §2.2.3's "`occurred_at` ≥ now() - 30 days" is deliberately NOT a CHECK: `now()` is not IMMUTABLE and
--     PostgreSQL rejects it there (the M21 `CURRENT_DATE` finding), and the rule is wrong as a hard
--     constraint anyway — §2.2.3 itself allows a delayed report with supervisor attestation. The half that
--     IS expressible (`occurred_at <= reported_at`, both columns of the row) is also the half that catches
--     the real error: an incident that happened in the future.
--   • D9's "cannot submit with osha_reportable=true without supervisor sign-off" IS expressible, because
--     the sign-off columns live on this row — and it is the one rule here that a route-layer-only guard
--     would leave a repair script free to violate on the way to a state agency.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "safety_incident" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"affected_clinician_membership_id" uuid NOT NULL,
	"reported_by_membership_id" uuid NOT NULL,
	"category" "safety_incident_category" NOT NULL,
	"severity" "safety_incident_severity" NOT NULL,
	"visit_id" uuid,
	"patient_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"location_description" text,
	"narrative_cipher" bytea NOT NULL,
	"witnesses_cipher" bytea,
	"osha_reportable" boolean DEFAULT false NOT NULL,
	"osha_reportable_signed_off_by_membership_id" uuid,
	"osha_reportable_signed_off_at" timestamp with time zone,
	"workers_comp_claim_initiated" boolean DEFAULT false NOT NULL,
	"workers_comp_claim_reference" text,
	"linked_sos_alert_id" uuid,
	"lifecycle_state" "safety_incident_state" DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"reviewed_by_membership_id" uuid,
	"reviewed_at" timestamp with time zone,
	"action_plan_cipher" bytea,
	"closed_at" timestamp with time zone,
	"reopen_reason" text,
	"safety_policy_version_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m20_si_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m20_si_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m20_si_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m20_si_sos_alert_fk" FOREIGN KEY ("linked_sos_alert_id") REFERENCES "public"."safety_sos_alert"("id") ON DELETE restrict,
	CONSTRAINT "m20_si_policy_version_fk" FOREIGN KEY ("safety_policy_version_id") REFERENCES "public"."safety_policy_version"("id") ON DELETE restrict,
	CONSTRAINT "m20_si_occurred_before_reported" CHECK ("occurred_at" <= "reported_at"),
	CONSTRAINT "m20_si_narrative_floor" CHECK ("lifecycle_state" = 'draft' OR octet_length("narrative_cipher") >= 200),
	CONSTRAINT "m20_si_osha_signoff_pair" CHECK (("osha_reportable_signed_off_by_membership_id" IS NULL) = ("osha_reportable_signed_off_at" IS NULL)),
	CONSTRAINT "m20_si_osha_signoff_required" CHECK ("lifecycle_state" = 'draft' OR "osha_reportable" = false OR "osha_reportable_signed_off_at" IS NOT NULL),
	CONSTRAINT "m20_si_submitted_stamped" CHECK ("lifecycle_state" = 'draft' OR "submitted_at" IS NOT NULL),
	CONSTRAINT "m20_si_reviewed_pair" CHECK (("reviewed_by_membership_id" IS NULL) = ("reviewed_at" IS NULL)),
	CONSTRAINT "m20_si_closed_stamped" CHECK ("lifecycle_state" NOT IN ('closed_with_action_plan','closed_no_action') OR "closed_at" IS NOT NULL),
	CONSTRAINT "m20_si_action_plan_required" CHECK ("lifecycle_state" <> 'closed_with_action_plan' OR "action_plan_cipher" IS NOT NULL),
	CONSTRAINT "m20_si_reopen_reason" CHECK ("lifecycle_state" <> 'reopened' OR length(btrim("reopen_reason")) >= 20)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "si_org_occurred_idx" ON "safety_incident" ("organization_id","occurred_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "si_clinician_idx" ON "safety_incident" ("affected_clinician_membership_id","occurred_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "si_osha_scan_idx" ON "safety_incident" ("organization_id","osha_reportable","lifecycle_state") WHERE osha_reportable = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "si_review_queue_idx" ON "safety_incident" ("organization_id","lifecycle_state","submitted_at") WHERE lifecycle_state = 'submitted';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "safety_incident_state_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"incident_id" uuid NOT NULL,
	"from_state" "safety_incident_state",
	"to_state" "safety_incident_state" NOT NULL,
	"transitioned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"transitioned_by_membership_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m20_sish_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m20_sish_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m20_sish_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m20_sish_incident_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."safety_incident"("id") ON DELETE restrict,
	CONSTRAINT "m20_sish_no_self" CHECK ("from_state" IS NULL OR "from_state" <> "to_state")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sish_incident_idx" ON "safety_incident_state_history" ("incident_id","transitioned_at");--> statement-breakpoint
-- Deferred FK #3: the SOS↔incident cycle (an SOS links the incident it opened; the incident links back).
ALTER TABLE "safety_sos_alert" ADD CONSTRAINT "m20_ssa_linked_incident_fk" FOREIGN KEY ("linked_incident_id") REFERENCES "public"."safety_incident"("id") ON DELETE restrict;--> statement-breakpoint

-- ============================================================================================
-- ACT — safety_acknowledgment (§2.2.6). The row that proves a human answered, which is the fact a
-- workers-comp carrier, a plaintiff's counsel and a surveyor each ask for first.
--
-- EXACTLY ONE TARGET, BOTH DIRECTIONS. §3.3 calls this "a raw constraint not expressible in the Drizzle
-- DSL"; it is expressible, and it needs the second direction: `target_kind` must AGREE with which of the
-- three FK columns is populated. Enforcing only "exactly one is non-null" would let a row claim
-- `target_kind='sos_alert'` while pointing at an incident, and the §4.3 reader keys off the discriminator —
-- so the acknowledgment would silently attach to the wrong alert.
--
-- WHAT THE `action_taken` CHECK CAN SAY: §2.2.6 tiers the minimum by the TARGET's severity (≥20 warn, ≥40
-- critical). Severity lives on the target row and a CHECK cannot read another table, so the DB enforces
-- the ≥20 FLOOR that applies to every acknowledgment and the severity-tiered ≥40 is the acknowledger
-- service's. The floor is the half that matters here: it is what stops "ok" being a valid answer to a
-- 3 a.m. SOS.
--
-- THREE PARTIAL INDEXES, not §3.3's one three-column composite: a composite over (sos_alert_id,
-- incident_id, overdue_check_in_schedule_id) has two NULLs in every row and serves none of the three
-- lookups it was written for.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "safety_acknowledgment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_entity_id" uuid NOT NULL,
	"location_id" uuid,
	"target_kind" "safety_acknowledgment_target_kind" NOT NULL,
	"sos_alert_id" uuid,
	"incident_id" uuid,
	"overdue_check_in_schedule_id" uuid,
	"acknowledged_by_membership_id" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action_taken" text NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m20_sack_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m20_sack_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m20_sack_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m20_sack_sos_alert_fk" FOREIGN KEY ("sos_alert_id") REFERENCES "public"."safety_sos_alert"("id") ON DELETE restrict,
	CONSTRAINT "m20_sack_incident_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."safety_incident"("id") ON DELETE restrict,
	CONSTRAINT "m20_sack_schedule_fk" FOREIGN KEY ("overdue_check_in_schedule_id") REFERENCES "public"."safety_check_in_schedule"("id") ON DELETE restrict,
	CONSTRAINT "m20_sack_one_target" CHECK (("target_kind" = 'sos_alert' AND "sos_alert_id" IS NOT NULL AND "incident_id" IS NULL AND "overdue_check_in_schedule_id" IS NULL) OR ("target_kind" = 'incident' AND "incident_id" IS NOT NULL AND "sos_alert_id" IS NULL AND "overdue_check_in_schedule_id" IS NULL) OR ("target_kind" = 'overdue_check_in' AND "overdue_check_in_schedule_id" IS NOT NULL AND "sos_alert_id" IS NULL AND "incident_id" IS NULL)),
	CONSTRAINT "m20_sack_action_taken" CHECK (length(btrim("action_taken")) >= 20),
	CONSTRAINT "m20_sack_outcome_vocab" CHECK ("outcome" IS NULL OR "outcome" IN ('reached_clinician_by_phone','dispatched_supervisor','911_called','no_action_needed','other'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sack_sos_idx" ON "safety_acknowledgment" ("sos_alert_id","acknowledged_at" DESC) WHERE sos_alert_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sack_incident_idx" ON "safety_acknowledgment" ("incident_id","acknowledged_at" DESC) WHERE incident_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sack_schedule_idx" ON "safety_acknowledgment" ("overdue_check_in_schedule_id","acknowledged_at" DESC) WHERE overdue_check_in_schedule_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sack_actor_idx" ON "safety_acknowledgment" ("acknowledged_by_membership_id","acknowledged_at" DESC);--> statement-breakpoint

-- ============================================================================================
-- CONFIG — safety_supervisor_subscription (§2.2.5 / D8). The PAGING layer: who gets woken up when this
-- clinician's SOS fires. Dashboard VISIBILITY is RBAC + ABAC and is deliberately independent — a
-- supervisor may see a board they are not paged for, and (the failure D8 exists to close) a clinician may
-- be visible on every board and paged by nobody.
--
-- `NULLS NOT DISTINCT` IS LOAD-BEARING. §2.2.5 requires (supervisor, clinician, location, PE) to be unique
-- among ACTIVE rows and three of those four are nullable. Under PostgreSQL's default NULL semantics two
-- identical location-scoped rows — (sup, NULL, loc-A, NULL) twice — are DISTINCT and both insert, so the
-- supervisor is paged twice for every alert and the "one row per pair" rule the resolver relies on is not a
-- rule at all. The Drizzle `uniqueIndex` cannot spell the modifier; this SQL is normative.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "safety_supervisor_subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"supervisor_membership_id" uuid NOT NULL,
	"clinician_membership_id" uuid,
	"location_id" uuid,
	"provider_entity_id" uuid,
	"scope_kind" text NOT NULL,
	"alert_kinds" text[] NOT NULL,
	"is_vacation_forwarding" boolean DEFAULT false NOT NULL,
	"vacation_forward_to_membership_id" uuid,
	"deactivated_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m20_sss_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m20_sss_location_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."location"("id") ON DELETE restrict,
	CONSTRAINT "m20_sss_provider_entity_id_fk" FOREIGN KEY ("provider_entity_id") REFERENCES "public"."provider_entity"("id") ON DELETE restrict,
	CONSTRAINT "m20_sss_scope_vocab" CHECK ("scope_kind" IN ('explicit','location','provider_entity','role')),
	CONSTRAINT "m20_sss_scope_integrity" CHECK (("scope_kind" = 'explicit' AND "clinician_membership_id" IS NOT NULL) OR ("scope_kind" = 'location' AND "location_id" IS NOT NULL) OR ("scope_kind" = 'provider_entity' AND "provider_entity_id" IS NOT NULL) OR "scope_kind" = 'role'),
	CONSTRAINT "m20_sss_alert_kinds_nonempty" CHECK (array_length("alert_kinds", 1) >= 1),
	CONSTRAINT "m20_sss_alert_kinds_vocab" CHECK ("alert_kinds" <@ ARRAY['sos','overdue','incident','high_risk_area']::text[]),
	CONSTRAINT "m20_sss_vacation_pair" CHECK ("is_vacation_forwarding" = ("vacation_forward_to_membership_id" IS NOT NULL)),
	CONSTRAINT "m20_sss_no_self_forward" CHECK ("vacation_forward_to_membership_id" IS NULL OR "vacation_forward_to_membership_id" <> "supervisor_membership_id"),
	CONSTRAINT "m20_sss_no_self_supervision" CHECK ("clinician_membership_id" IS NULL OR "clinician_membership_id" <> "supervisor_membership_id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sss_active_pair_uniq" ON "safety_supervisor_subscription" ("supervisor_membership_id","clinician_membership_id","location_id","provider_entity_id") NULLS NOT DISTINCT WHERE superseded_at IS NULL AND deactivated_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sss_clinician_idx" ON "safety_supervisor_subscription" ("clinician_membership_id") WHERE superseded_at IS NULL AND deactivated_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sss_supervisor_idx" ON "safety_supervisor_subscription" ("supervisor_membership_id") WHERE superseded_at IS NULL AND deactivated_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sss_scope_idx" ON "safety_supervisor_subscription" ("organization_id","scope_kind","location_id","provider_entity_id") WHERE superseded_at IS NULL AND deactivated_at IS NULL;--> statement-breakpoint

-- ============================================================================================
-- CONFIG — safety_high_risk_area (§2.2.7 / D12). An ADVISORY polygon: it never blocks a visit, it surfaces
-- a warning and (per tenant policy) makes the pre-visit check-in mandatory or flags a buddy visit for M17
-- to route. Every category is advisory; there is no blocking category by design.
--
-- M20-F07 (see the header): jsonb polygon RINGS, an even-odd ray-cast in app code, and no PostGIS / GIST /
-- ST_Within anywhere. The evaluator loads the org's live polygons and tests in memory, so the hot path is
-- "this org's active areas", not a spatial index.
--
-- M20-F03: organization_id NOT NULL. §3.3 sketches it nullable with "NULL = platform-seeded" and §3.2
-- Phase E overrules that in the same document; see the header.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "safety_high_risk_area" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"risk_category" "safety_high_risk_category" NOT NULL,
	"advisory_message" text NOT NULL,
	"polygon" jsonb NOT NULL,
	"policy_for_visits_to_area" text DEFAULT 'advisory_only' NOT NULL,
	"evidence_documents_cipher" jsonb,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m20_shra_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m20_shra_window" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
	CONSTRAINT "m20_shra_message_bounds" CHECK (length(btrim("advisory_message")) BETWEEN 1 AND 200),
	CONSTRAINT "m20_shra_policy_vocab" CHECK ("policy_for_visits_to_area" IN ('advisory_only','requires_pre_visit_check_in','requires_buddy_visit')),
	CONSTRAINT "m20_shra_polygon_shape" CHECK (jsonb_typeof("polygon") = 'array' AND jsonb_array_length("polygon") >= 1)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shra_org_effective_idx" ON "safety_high_risk_area" ("organization_id","effective_from","effective_to");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shra_active_idx" ON "safety_high_risk_area" ("organization_id","risk_category") WHERE effective_to IS NULL;--> statement-breakpoint

-- ============================================================================================
-- CONFIG — safety_emergency_contact_consent (§2.2.8 / D6/D10/M20-F16). The CLINICIAN is the data subject
-- here, not a patient: this is the workforce's own consent to have their location captured during an SOS,
-- streamed during an active SOS, and their emergency contact called when the life-safety chain reaches its
-- terminus.
--
-- `expired` IS NOT `revoked` AND THE DISTINCTION IS THE POINT. Revoked means the clinician withdrew;
-- expired means the tenant's rotation aged the acknowledgment out and nobody re-asked. A coercion review
-- reads exactly that difference, so the two are separate enum values with separate timestamp columns
-- rather than one "ended_at".
--
-- `acknowledgment_text_snapshot` is deliberately NOT in the §3.6 denylist: it is the policy text the
-- clinician was shown at grant, which is the one thing a consent dispute turns on. Scrubbing it would leave
-- the audit trail able to prove a consent existed and unable to say what was consented to.
-- ============================================================================================
CREATE TABLE IF NOT EXISTS "safety_emergency_contact_consent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"clinician_membership_id" uuid NOT NULL,
	"consent_purpose" text NOT NULL,
	"consent_scope_detail" jsonb NOT NULL,
	"status" "safety_emergency_contact_consent_status" DEFAULT 'granted' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"acknowledgment_text_snapshot" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "m20_secc_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict,
	CONSTRAINT "m20_secc_purpose_vocab" CHECK ("consent_purpose" IN ('sos_coordinates','continuous_location_during_sos','emergency_contact_call')),
	CONSTRAINT "m20_secc_revocation_pair" CHECK (("status" = 'revoked') = ("revoked_at" IS NOT NULL)),
	CONSTRAINT "m20_secc_expiry_stamped" CHECK ("status" <> 'expired' OR "expires_at" IS NOT NULL),
	CONSTRAINT "m20_secc_scope_object" CHECK (jsonb_typeof("consent_scope_detail") = 'object'),
	CONSTRAINT "m20_secc_contact_present" CHECK ("consent_purpose" <> 'emergency_contact_call' OR jsonb_exists("consent_scope_detail", 'contact')),
	CONSTRAINT "m20_secc_snapshot_nonempty" CHECK (length(btrim("acknowledgment_text_snapshot")) > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "secc_active_uniq" ON "safety_emergency_contact_consent" ("organization_id","clinician_membership_id","consent_purpose") WHERE status = 'granted';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secc_clinician_idx" ON "safety_emergency_contact_consent" ("clinician_membership_id","consent_purpose");
