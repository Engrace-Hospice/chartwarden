// @wardenx/db — `hope_assessment` (M10 §3.3, D11). One row per HOPE timepoint capture across all five
// RFAs (Admission / HUV1 / HUV2 / SFV / Discharge): the per-section CMS HOPE payload in the `data`
// jsonb, the server-authoritative J2051 trigger result, the PPS/ESAS-r clinical-context snapshot at
// sign (D8), and the draft→signed→superseded lifecycle (§2.2.2). PHI-bearing → the three-column tenancy
// rule (provider_entity_id + location_id NOT NULL, denormalized from the admission, §3.3 tenancy note)
// so submission batching and the iQIES ccn_at_election match run without joining M6. High-volume,
// retention-extended → PARTITION BY RANGE (target_date) monthly (§3.6): the Drizzle definition is the
// logical shape (composite PK incl. the partition key); the actual PARTITION BY + monthly partitions +
// the DEFERRABLE self-FK (corrects_assessment_id) + the correction-supersede / schedule-mark-completed
// triggers are emitted by the RLS migration (§3.4/§3.6, M10-T02). Append-only — a correction inserts a
// new row and flips the prior to superseded. Cross-module refs (M5 patient, M6 admission, M8
// source_encounter — FK deferred per D5) are plain uuid app-validated; schedule_id is an intra-module
// FK (hope_timepoint_schedule is not partitioned); actor refs go to M1 `membership`. RLS + grants + the
// M4 write-audit trigger (data / clinical_context_snapshot / late_completion_reason_code denylisted,
// §8.1) land in the RLS migration alongside the partition conversion.
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  hopeRfaKind,
  hopeDischargeReason,
  hopeAssessmentStatus,
  j2051Severity,
} from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { hopeTimepointSchedules } from "./hope-timepoint-schedules";

export const hopeAssessments = pgTable(
  "hope_assessment",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with target_date (the partition key)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // NOT NULL relaxed in mig 0130 (M10L): the record route carries only admission + RFA; siting backfills
    // from the M6 admission / M17 visit context when threaded.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    admissionId: uuid("admission_id").notNull(), // M6 admission (logical; not enforced cross-module)
    scheduleId: uuid("schedule_id").references(() => hopeTimepointSchedules.id), // nullable for SFV-driven
    sourceEncounterId: uuid("source_encounter_id"), // M8 encounter (logical; FK deferred until M8 lock, D5)

    rfaKind: hopeRfaKind("rfa_kind").notNull(),
    dischargeReason: hopeDischargeReason("discharge_reason"), // required when rfa_kind='05_discharge'
    status: hopeAssessmentStatus("status").notNull().default("draft"),
    data: jsonb("data").notNull(), // per-Section discriminated union (free-text denylisted from audit)

    // Derived from data.J at sign; server-authoritative (§J/j2051-evaluator).
    j2051MaxSeverity: j2051Severity("j2051_max_severity").notNull().default("none"),
    j2051TriggerFired: boolean("j2051_trigger_fired").notNull().default(false),

    // Late completion.
    wasLate: boolean("was_late").notNull().default(false),
    lateCompletionReasonCode: text("late_completion_reason_code"), // CMS late-reason code

    // PPS / ESAS-r snapshot at sign (D8).
    clinicalContextSnapshot: jsonb("clinical_context_snapshot"), // ClinicalContextSnapshot (§3.3)

    // Correction chain (self-refs; DEFERRABLE composite FK added in the RLS migration).
    correctsAssessmentId: uuid("corrects_assessment_id"),
    supersededById: uuid("superseded_by_id"), // trigger-maintained

    // iQIES linkage; nullable until submission accepted.
    iqiesRecordId: text("iqies_record_id"),

    targetDate: timestamp("target_date", { withTimezone: true }).notNull(), // partition key + PK member
    signedAt: timestamp("signed_at", { withTimezone: true }),
    signedByMembershipId: uuid("signed_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByMembershipId: uuid("created_by_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.targetDate] }), // partition key must be in the PK
    // Latest signed per (patient, rfa_kind) — the hot read for chart + IDG.
    byPatientRfaLatest: index("idx_hope_assess_patient_rfa")
      .on(t.patientId, t.rfaKind, t.targetDate)
      .where(sql`status = 'signed'`),
    // Triggered J2051 for the open SFV worklist.
    byOrgTriggered: index("idx_hope_assess_org_triggered")
      .on(t.organizationId, t.j2051TriggerFired, t.signedAt)
      .where(sql`j2051_trigger_fired = true`),
    // Signed-and-unsubmitted for the iQIES batch assembler.
    byOrgUnsubmitted: index("idx_hope_assess_org_unsubmitted")
      .on(t.organizationId, t.signedAt)
      .where(sql`status = 'signed' AND iqies_record_id IS NULL`),
    // Correction-chain lookup.
    byCorrectsId: index("idx_hope_assess_corrects")
      .on(t.correctsAssessmentId)
      .where(sql`corrects_assessment_id IS NOT NULL`),
  }),
);

export type HopeAssessment = typeof hopeAssessments.$inferSelect;
export type NewHopeAssessment = typeof hopeAssessments.$inferInsert;
