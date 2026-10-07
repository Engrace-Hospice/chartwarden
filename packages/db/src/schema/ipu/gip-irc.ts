import { sql } from "drizzle-orm";
// @wardenx/db — M37 GIP criteria + IRC cap (§2.4/§2.5, §3.3): gip_admission_criteria, its per-encounter
// reassessment ledger, the irc_episode 5-day cap tracker, and the ipu_remote_inpatient_episode
// (CoP 418.112 arranged-inpatient tracking). TENANT-SCOPED, RLS on app.org_id. `data`/`rationale`/
// notes/reason free-text is PHI-denylisted for audit scrubbing (D11, §3.6). Cross-module ids
// (triggered_by_encounter_id/M8, patient_id, membership/physician ids, level_of_care_period_id/M6,
// remote_facility_id/M40, arrangement_agreement_document_id/M22) are logical uuids; ipu_admission_id and
// gip_admission_criteria_id are REAL intra-module FKs. char_length CHECKs live in the migration.
import {
  boolean,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  gipCriterionKind,
  ipuAdmissionKind,
  ipuRemoteArrangementBillingBasis,
  ircEpisodeState,
} from "../../enums";
import { ipuAdmission } from "./admission";
import { bigintVersion } from "./shared";

export const gipAdmissionCriteria = pgTable(
  "gip_admission_criteria",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    ipuAdmissionId: uuid("ipu_admission_id")
      .notNull()
      .references(() => ipuAdmission.id, { onDelete: "restrict" }),
    criterionKind: gipCriterionKind("criterion_kind").notNull(),
    data: jsonb("data").notNull(), // TypeBox-validated; PHI denylisted
    attestingPhysicianId: uuid("attesting_physician_id").notNull(),
    attestingMembershipId: uuid("attesting_membership_id").notNull(),
    attestedAt: timestamp("attested_at", { withTimezone: true }).notNull().defaultNow(),
    stepUpAssertionId: uuid("step_up_assertion_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    onePerAdmissionUq: uniqueIndex("gip_criteria_one_per_admission").on(t.ipuAdmissionId),
  }),
);

export const gipCriteriaReassessment = pgTable(
  "gip_criteria_reassessment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    gipAdmissionCriteriaId: uuid("gip_admission_criteria_id")
      .notNull()
      .references(() => gipAdmissionCriteria.id, { onDelete: "restrict" }),
    ipuAdmissionId: uuid("ipu_admission_id")
      .notNull()
      .references(() => ipuAdmission.id, { onDelete: "restrict" }),
    triggeredByEncounterId: uuid("triggered_by_encounter_id"), // M8 encounter; nullable for ad-hoc
    reassessedByMembershipId: uuid("reassessed_by_membership_id").notNull(),
    criterionStillMet: boolean("criterion_still_met").notNull(),
    rationale: text("rationale").notNull(), // char_length >= 50 (migration CHECK); PHI denylisted
    assessedAt: timestamp("assessed_at", { withTimezone: true }).notNull().defaultNow(),
    stepUpAssertionId: uuid("step_up_assertion_id"), // required if criterion_still_met=false
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    admissionAtIx: index("gip_reassessment_admission_at_idx").on(t.ipuAdmissionId, t.assessedAt),
  }),
);

export const ircEpisode = pgTable(
  "irc_episode",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    ipuAdmissionId: uuid("ipu_admission_id")
      .notNull()
      .references(() => ipuAdmission.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // ARCH-011 (logical uuid; D17)
    locationId: uuid("location_id"),
    patientId: uuid("patient_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    expectedEndAt: timestamp("expected_end_at", { withTimezone: true }).notNull(),
    consecutiveDayCount: smallint("consecutive_day_count").notNull().default(1),
    // §2.5 resumption (0363): the days inherited from a prior episode closed within 30 days (0 = fresh).
    carriedOverDays: smallint("carried_over_days").notNull().default(0),
    state: ircEpisodeState("state").notNull().default("active"),
    capOverrideInvoked: boolean("cap_override_invoked").notNull().default(false),
    capOverrideInvokedBy: uuid("cap_override_invoked_by"),
    capOverrideReason: text("cap_override_reason"), // PHI denylisted
    capOverrideExtensionDays: smallint("cap_override_extension_days"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closureReason: text("closure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    onePerAdmissionUq: uniqueIndex("irc_episode_one_per_admission").on(t.ipuAdmissionId),
    stateStartedIx: index("irc_episode_state_started_idx")
      .on(t.state, t.startedAt)
      .where(sql`state != 'closed'`),
  }),
);

export const ipuRemoteInpatientEpisode = pgTable(
  "ipu_remote_inpatient_episode",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    ipuAdmissionId: uuid("ipu_admission_id")
      .notNull()
      .references(() => ipuAdmission.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // ARCH-011 (logical uuid; D17)
    locationId: uuid("location_id"),
    patientId: uuid("patient_id").notNull(),
    levelOfCarePeriodId: uuid("level_of_care_period_id").notNull(), // M6
    remoteFacilityId: uuid("remote_facility_id").notNull(), // M40 Facility
    kind: ipuAdmissionKind("kind").notNull(), // CHECK kind IN ('gip','irc') in migration
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    arrangementAgreementDocumentId: uuid("arrangement_agreement_document_id"), // M22
    attendingPhysicianId: uuid("attending_physician_id"), // M40
    arrangementBillingBasis: ipuRemoteArrangementBillingBasis("arrangement_billing_basis")
      .notNull()
      .default("bundled"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    onePerAdmissionUq: uniqueIndex("remote_episode_one_per_admission").on(t.ipuAdmissionId),
    facilityStateIx: index("remote_episode_facility_state_idx")
      .on(t.remoteFacilityId, t.startedAt)
      .where(sql`ended_at IS NULL`),
  }),
);

export type GipAdmissionCriteriaRow = typeof gipAdmissionCriteria.$inferSelect;
export type NewGipAdmissionCriteriaRow = typeof gipAdmissionCriteria.$inferInsert;
export type GipCriteriaReassessmentRow = typeof gipCriteriaReassessment.$inferSelect;
export type NewGipCriteriaReassessmentRow = typeof gipCriteriaReassessment.$inferInsert;
export type IrcEpisodeRow = typeof ircEpisode.$inferSelect;
export type NewIrcEpisodeRow = typeof ircEpisode.$inferInsert;
export type IpuRemoteInpatientEpisodeRow = typeof ipuRemoteInpatientEpisode.$inferSelect;
export type NewIpuRemoteInpatientEpisodeRow = typeof ipuRemoteInpatientEpisode.$inferInsert;
