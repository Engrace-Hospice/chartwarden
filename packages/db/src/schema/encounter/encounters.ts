// @wardenx/db — `encounter` (M8 §3.3). The clinical-event root: one row per visit/contact a clinician
// charts on. PHI-bearing → the three-column tenancy rule; here provider_entity_id + location_id are
// NOT NULL (an encounter is a patient-level, location-anchored clinical event, always sited from the
// M17 visit / M6 admission context — see §3.3 tenancy note; drives location-scoped ABAC, multi-CCN
// M33 reporting, and the M23 site-of-service Q-code derivation). Cross-module refs (M5 patient,
// M6 admission/face_to_face, M17 visit, M18 evv_event, M38 code_system_version, M16 bereavement_plan,
// M22 document) are plain uuid app-validated, NOT cross-module FKs; actor refs go to M1 `membership`.
// RLS + grants + the M4 write-audit trigger land in migration 0031 (M8-T03, §3.3/§3.4).
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  encounterDiscipline,
  encounterStatus,
  encounterType,
  evvBracketState,
  lateEntryTier,
} from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const encounters = pgTable(
  "encounter",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // NOT NULL relaxed in mig 0128 (M8L-T02): the draft route carries only patient+admission and the M6
    // admission may itself be unsited; siting backfills from the admission/visit when present.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    admissionId: uuid("admission_id").notNull(), // M6 admission (logical; not enforced cross-module)
    visitId: uuid("visit_id"), // M17 visit (logical; nullable for ad-hoc encounters)

    encounterType: encounterType("encounter_type").notNull(),
    discipline: encounterDiscipline("discipline").notNull(),

    authoredByMembershipId: uuid("authored_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),

    serviceDate: date("service_date").notNull(), // org-timezone date when the encounter actually occurred
    startedAt: timestamp("started_at", { withTimezone: true }), // EVV check-in OR clinician-entered
    endedAt: timestamp("ended_at", { withTimezone: true }), // EVV check-out OR clinician-entered

    evvBracketState: evvBracketState("evv_bracket_state"), // populated at finalize
    evvCheckInEventId: uuid("evv_check_in_event_id"), // M18 evv_event (logical)
    evvCheckOutEventId: uuid("evv_check_out_event_id"), // M18 evv_event (logical)
    evvMissingReason: text("evv_missing_reason"),

    status: encounterStatus("status").notNull().default("draft"),
    lateEntryTier: lateEntryTier("late_entry_tier").notNull().default("normal"),
    lateEntryReason: text("late_entry_reason"),
    significantLateOverrideBy: uuid("significant_late_override_by").references(
      () => memberships.id,
      { onDelete: "set null" },
    ),
    significantLateOverrideReason: text("significant_late_override_reason"),
    administrativeOverrideBy: uuid("administrative_override_by").references(() => memberships.id, {
      onDelete: "set null",
    }),
    administrativeOverrideReason: text("administrative_override_reason"),

    vocabVersionId: uuid("vocab_version_id"), // M38 code_system_version (logical); set at first finalize; immutable thereafter (D11)

    faceToFaceEncounterId: uuid("face_to_face_encounter_id"), // M6 face_to_face_encounter for F2F dual-write (D1)
    bereavementPlanId: uuid("bereavement_plan_id"), // M16 bereavement_plan for bereavement_contact

    documentId: uuid("document_id"), // back-reference to the M22-rendered PDF when M22 publishes

    signedAt: timestamp("signed_at", { withTimezone: true }),
    cosignedAt: timestamp("cosigned_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => memberships.id, { onDelete: "set null" }),
    voidedReason: text("voided_reason"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    patientServiceDateIdx: index("encounter_patient_service_date_idx").on(
      t.organizationId,
      t.patientId,
      t.serviceDate,
    ),
    authorOpenDraftIdx: index("encounter_author_open_draft_idx")
      .on(t.organizationId, t.authoredByMembershipId, t.status)
      .where(sql`status = 'draft'`),
    signedRecentIdx: index("encounter_signed_recent_idx")
      .on(t.organizationId, t.signedAt)
      .where(sql`status IN ('signed','cosign_pending','cosigned')`),
    cosignPendingIdx: index("encounter_cosign_pending_idx")
      .on(t.organizationId, t.signedAt)
      .where(sql`status = 'cosign_pending'`),
    orgVisitUnique: uniqueIndex("encounter_org_visit_unique")
      .on(t.organizationId, t.visitId)
      .where(sql`visit_id IS NOT NULL`),
    lateReasonRequired: check(
      "encounter_late_reason_required",
      sql`(late_entry_tier = 'normal') OR (late_entry_reason IS NOT NULL AND char_length(late_entry_reason) >= 40)`,
    ),
    significantLateConsistency: check(
      "encounter_significant_late_consistency",
      sql`(late_entry_tier <> 'significant_late_entry')
          OR (significant_late_override_by IS NOT NULL AND significant_late_override_reason IS NOT NULL
              AND char_length(significant_late_override_reason) >= 40)`,
    ),
    administrativeOverrideConsistency: check(
      "encounter_administrative_override_consistency",
      sql`(late_entry_tier <> 'administrative_override')
          OR (administrative_override_by IS NOT NULL AND administrative_override_reason IS NOT NULL
              AND char_length(administrative_override_reason) >= 100)`,
    ),
    evvMissingReasonLen: check(
      "encounter_evv_missing_reason_len",
      sql`(evv_bracket_state IS DISTINCT FROM 'evv_missing_documented')
          OR (evv_missing_reason IS NOT NULL AND char_length(evv_missing_reason) >= 20)`,
    ),
    voidedConsistency: check(
      "encounter_voided_consistency",
      sql`(status <> 'voided')
          OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND voided_reason IS NOT NULL
              AND char_length(voided_reason) >= 40)`,
    ),
    signedHasTime: check(
      "encounter_signed_has_time",
      sql`(status NOT IN ('signed','cosign_pending','cosigned')) OR (signed_at IS NOT NULL)`,
    ),
    vocabPinnedWhenFinalized: check(
      "encounter_vocab_pinned_when_finalized",
      sql`(status = 'draft') OR (vocab_version_id IS NOT NULL)`,
    ),
  }),
);

export type Encounter = typeof encounters.$inferSelect;
export type NewEncounter = typeof encounters.$inferInsert;
