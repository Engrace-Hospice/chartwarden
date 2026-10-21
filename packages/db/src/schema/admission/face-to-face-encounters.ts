// @chartwarden/db — `face_to_face_encounter` (M6 §3.3). The CoP face-to-face attestation gating the
// third+ benefit period. PHI-bearing (carries an encounter reference) → the three-column tenancy
// rule (org NOT NULL + nullable provider_entity_id / location_id). `performed_by_user_id` /
// `window_override_by` are M1 users (FK); `encounter_id` is the M8 visit it was charted on (plain
// uuid, app-validated); `document_id` is M22. The election_period FK is intra-M6. One attested F2F
// per period (partial unique). RLS + the M4 write-audit trigger land in M6-T03 (§3.6–3.7).
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { businessRule } from "../../business-rules";
import { f2fEncounterLocation, f2fEncounterStatus, f2fPerformerRole } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { users } from "../users";
import { electionPeriods } from "./election-periods";

/** The persisted R-F2F-05 telehealth attestation (no PHI — three booleans + the record instant). */
export interface F2fTelehealthEligibilityRecord {
  readonly patientInMoratoriumArea: boolean;
  readonly hospiceUnderEnhancedOversight: boolean;
  readonly performerMedicareEnrolledOrOptedOut: boolean;
  readonly attestedAt: string;
}

// Registered business rules (Bug 4): a `23505` on these indexes — two writers racing past the service's
// own pre-check — answers 409 with this sentence instead of a bare 500 (the F-022 / #55 convention).
// Declared outside `pgTable`'s lazily-invoked config callback so the error handler can see them.
const F2F_PERIOD_ATTESTED_IDX = businessRule(
  "f2f_period_attested_idx",
  "This benefit period already has an attested face-to-face encounter.",
);

export const faceToFaceEncounters = pgTable(
  "face_to_face_encounter",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }), // ARCH-011 (nullable)
    locationId: uuid("location_id").references(() => locations.id, {
      onDelete: "restrict",
    }), // ARCH-011 (nullable)
    electionPeriodId: uuid("election_period_id")
      .notNull()
      .references(() => electionPeriods.id, { onDelete: "restrict" }),
    performedByUserId: uuid("performed_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    performerRole: f2fPerformerRole("performer_role").notNull(),
    scheduledDate: date("scheduled_date"),
    requestedWindowStart: date("requested_window_start"),
    requestedWindowEnd: date("requested_window_end"),
    authoritativeWindowStart: date("authoritative_window_start"),
    authoritativeWindowEnd: date("authoritative_window_end"),
    encounterDate: date("encounter_date"),
    encounterLocation: f2fEncounterLocation("encounter_location"),
    // FY2027 CoP R-F2F-05 (migration 0390): the completing clinician's § 418.22(a)(4)(ii)(A)–(C) attestation
    // for a TELEHEALTH encounter (moratorium area / enhanced oversight / performer Medicare-enrolled or
    // opted out) + when it was recorded. NULL for in-person encounters (CHECK-enforced).
    telehealthEligibility: jsonb("telehealth_eligibility").$type<F2fTelehealthEligibilityRecord>(),
    withinWindow: boolean("within_window"),
    windowOverride: boolean("window_override").notNull().default(false),
    windowOverrideReason: text("window_override_reason"),
    windowOverrideBy: uuid("window_override_by").references(() => users.id, {
      onDelete: "set null",
    }),
    attestationSignedAt: timestamp("attestation_signed_at", {
      withTimezone: true,
    }),
    attestationNarrative: text("attestation_narrative"),
    // M8 encounter (app-validated; no cross-module FK). FY2027 R-F2F-06: set when the § 418.22(b)(4)
    // attestation is a linked signed clinical note rather than `attestation_narrative`.
    encounterId: uuid("encounter_id"),
    documentId: uuid("document_id"), // M22 document (app-validated)
    status: f2fEncounterStatus("status").notNull().default("scheduled"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    periodAttestedUnique: uniqueIndex(F2F_PERIOD_ATTESTED_IDX)
      .on(t.electionPeriodId)
      .where(sql`status = 'attested'`),
    performerDateIdx: index("f2f_performer_date_idx").on(t.performedByUserId, t.encounterDate),

    performerScheduledDateIdx: index("f2f_performer_scheduled_date_idx").on(
      t.performedByUserId,
      t.scheduledDate,
    ),
    orgPeriodIdx: index("f2f_org_period_idx").on(t.organizationId, t.electionPeriodId),
  }),
);

export type FaceToFaceEncounter = typeof faceToFaceEncounters.$inferSelect;
export type NewFaceToFaceEncounter = typeof faceToFaceEncounters.$inferInsert;
