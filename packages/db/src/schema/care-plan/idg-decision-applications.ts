// @chartwarden/db - M7's durable, tenant-scoped IDG proposal/application record for the
// `idg.decision_recorded` care-plan consumer. The unique decision key is committed with the proposed
// mutation set, and the row moves to `applied` only when the governed idg_review version publishes.
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { carePlanIdgProposalStatus, carePlanIdgProposedChangeStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { carePlanVersions } from "./care-plan-versions";
import { carePlans } from "./care-plans";

export const carePlanIdgDecisionApplications = pgTable(
  "care_plan_idg_decision_application",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    idgDecisionId: uuid("idg_decision_id").notNull(),
    idgMeetingId: uuid("idg_meeting_id").notNull(),
    sourceOutboxEventId: uuid("source_outbox_event_id").notNull(),
    carePlanId: uuid("care_plan_id")
      .notNull()
      .references(() => carePlans.id, { onDelete: "restrict" }),
    carePlanVersionId: uuid("care_plan_version_id")
      .notNull()
      .references(() => carePlanVersions.id, { onDelete: "restrict" }),
    status: carePlanIdgProposalStatus("status").notNull().default("proposed"),
    baselineSnapshot: jsonb("baseline_snapshot"),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),
    inReviewAt: timestamp("in_review_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    conflictReason: text("conflict_reason"),
  },
  (t) => ({
    decisionUnique: uniqueIndex("care_plan_idg_decision_application_decision_uq").on(
      t.organizationId,
      t.idgDecisionId,
    ),
    planAppliedIdx: index("care_plan_idg_decision_application_plan_applied_idx").on(
      t.carePlanId,
      t.appliedAt,
    ),
    versionStatusIdx: index("care_plan_idg_decision_application_version_status_idx").on(
      t.carePlanVersionId,
      t.status,
    ),
  }),
);

export const carePlanIdgProposedChanges = pgTable(
  "care_plan_idg_proposed_change",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => carePlanIdgDecisionApplications.id, { onDelete: "restrict" }),
    carePlanId: uuid("care_plan_id")
      .notNull()
      .references(() => carePlans.id, { onDelete: "restrict" }),
    carePlanVersionId: uuid("care_plan_version_id")
      .notNull()
      .references(() => carePlanVersions.id, { onDelete: "restrict" }),
    idgDecisionId: uuid("idg_decision_id").notNull(),
    idgMeetingId: uuid("idg_meeting_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    entityType: text("entity_type").notNull(),
    operation: text("operation").notNull(),
    targetEntityId: uuid("target_entity_id"),
    before: jsonb("before"),
    proposed: jsonb("proposed").notNull(),
    status: carePlanIdgProposedChangeStatus("status").notNull().default("proposed"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    applicationOrdinalUnique: uniqueIndex("care_plan_idg_change_application_ordinal_uq").on(
      t.applicationId,
      t.ordinal,
    ),
    decisionOrdinalUnique: uniqueIndex("care_plan_idg_change_decision_ordinal_uq").on(
      t.organizationId,
      t.idgDecisionId,
      t.ordinal,
    ),
    versionIdx: index("care_plan_idg_change_version_idx").on(t.carePlanVersionId, t.status),
  }),
);

export type CarePlanIdgDecisionApplication = typeof carePlanIdgDecisionApplications.$inferSelect;
export type NewCarePlanIdgDecisionApplication = typeof carePlanIdgDecisionApplications.$inferInsert;
export type CarePlanIdgProposedChange = typeof carePlanIdgProposedChanges.$inferSelect;
export type NewCarePlanIdgProposedChange = typeof carePlanIdgProposedChanges.$inferInsert;
