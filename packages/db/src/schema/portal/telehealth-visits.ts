// @wardenx/db — `telehealth_visit` (M31 §3.3, M31-T02). D8/D14's video-visit root: one row per M17 visit
// that runs as telehealth (unique on m17_visit_id). It tracks the vendor room, the join/start/end
// lifecycle, the audio-only Tier-3 fallback flag and the two-party-recording request state; on
// `visit_ended` M8 attaches the encounter (`linked_encounter_id`) via the §4.3 TelehealthVisitReader seam.
//
// TENANCY (ARCH-011): patient-bearing (patient_id, linked_encounter_id), so beyond organization_id NOT
// NULL it carries provider_entity_id NOT NULL + location_id (nullable) — denormalized from the M17 visit
// at room-mint so the §4.3 TelehealthMetricsProvider rolls up per CCN/location without joining. The spec
// §3.3 sketch omits these two columns; ARCH-011's three-column rule for PHI rows is authoritative and the
// gate (check-tenancy) requires them. RLS keys on app.org_id ALONE (0139).
//
// The two `vendor_room_*_cipher` columns + `end_reason_detail_cipher` are envelope-encrypted / free-text
// and §3.6 audit-denylisted (mirrors `M31_AUDIT_DENYLIST.telehealth_visit`).
//
// CROSS-MODULE FK POLICY: organization/provider_entity/location (M1 core) carry real FKs. m17_visit_id
// (M17), patient_id (M5), assigned_membership_id (M2), linked_encounter_id (M8) are LOGICAL uuid,
// app-validated. `scheduled_visit_setting` / `end_reason` are text validated against the @wardenx/types
// `TelehealthScheduledVisitSetting` / `TelehealthEndReason` unions at the write boundary (not pgEnums).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { telehealthLifecycleState, telehealthVendor } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { users } from "../users";

export const telehealthVisits = pgTable(
  "telehealth_visit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    m17VisitId: uuid("m17_visit_id").notNull(), // logical FK → M17 visit (one telehealth row per visit)
    patientId: uuid("patient_id").notNull(), // logical FK → M5 patient
    assignedMembershipId: uuid("assigned_membership_id").notNull(), // logical FK → M2 membership

    lifecycleState: telehealthLifecycleState("lifecycle_state").notNull().default("room_minted"),
    vendor: telehealthVendor("vendor").notNull(),
    vendorRoomIdCipher: text("vendor_room_id_cipher").notNull(), // §3.6 audit-denylisted
    vendorRoomUrlCipher: text("vendor_room_url_cipher").notNull(), // §3.6 audit-denylisted

    // §2.2.3 text columns validated against the @wardenx/types unions at the write boundary.
    scheduledVisitSetting: text("scheduled_visit_setting").notNull(),
    audioOnlyFallbackActive: boolean("audio_only_fallback_active").notNull().default(false),
    recordingEnabled: boolean("recording_enabled").notNull().default(false),
    recordingRequested: boolean("recording_requested").notNull().default(false),
    // GAP-093(b): the session user who started the recording (NULL = none, or started before 0339).
    recordingStartedByUserId: uuid("recording_started_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),

    roomMintedAt: timestamp("room_minted_at", { withTimezone: true }).notNull().defaultNow(),
    firstParticipantJoinedAt: timestamp("first_participant_joined_at", { withTimezone: true }),
    visitStartedAt: timestamp("visit_started_at", { withTimezone: true }),
    visitEndedAt: timestamp("visit_ended_at", { withTimezone: true }),
    totalDurationSec: integer("total_duration_sec"),
    endReason: text("end_reason"),
    endReasonDetailCipher: text("end_reason_detail_cipher"), // §3.6 audit-denylisted (free-text)

    linkedEncounterId: uuid("linked_encounter_id"), // logical FK → M8 encounter (attached on visit_ended)

    version: integer("version").notNull().default(0), // §2.5 If-Match
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("telehealth_visit_org_idx").on(t.organizationId),
    m17VisitUnique: uniqueIndex("telehealth_visit_m17_visit_unique").on(t.m17VisitId),
    patientIdx: index("telehealth_visit_patient_idx").on(t.patientId, t.roomMintedAt),
    recordingRequiresEnabled: check(
      "telehealth_visit_recording_requires_enabled",
      sql`recording_requested = false OR recording_enabled = true`,
    ),
    endedRequiresEndReason: check(
      "telehealth_visit_ended_requires_end_reason",
      sql`lifecycle_state NOT IN ('ended_clean','ended_aborted') OR end_reason IS NOT NULL`,
    ),
  }),
);

export type TelehealthVisitRow = typeof telehealthVisits.$inferSelect;
export type NewTelehealthVisitRow = typeof telehealthVisits.$inferInsert;
