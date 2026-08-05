// @wardenx/db - M7's durable, tenant-scoped idempotency/provenance marker for the
// `idg.decision_recorded` care-plan consumer. The unique decision key is committed in the same
// transaction as every care-plan mutation, so a dispatcher retry cannot apply a decision twice.
import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    sourceOutboxEventId: uuid("source_outbox_event_id").notNull(),
    carePlanId: uuid("care_plan_id")
      .notNull()
      .references(() => carePlans.id, { onDelete: "restrict" }),
    carePlanVersionId: uuid("care_plan_version_id")
      .notNull()
      .references(() => carePlanVersions.id, { onDelete: "restrict" }),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
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
  }),
);

export type CarePlanIdgDecisionApplication = typeof carePlanIdgDecisionApplications.$inferSelect;
export type NewCarePlanIdgDecisionApplication = typeof carePlanIdgDecisionApplications.$inferInsert;
