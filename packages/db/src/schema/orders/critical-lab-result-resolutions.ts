// @chartwarden/db — `critical_lab_result_resolution` (M11; #1136 / CW-CS-01, migration 1558). One APPEND-ONLY row per
// resolved quarantined critical lab result: what the clinician decided (`matched_to_order` + the order id, or
// `reviewed_no_action`), the required reason, the resolving membership + the discipline they acted under, and the
// database-stamped `resolved_at` (the app never supplies it). UNIQUE per result, so a result is resolved once; grants are
// SELECT + INSERT only and a trigger rejects UPDATE/DELETE (the destruction role's DELETE excepted), so a cleared result
// cannot be re-opened. `matched_order_id` is a plain uuid (order_record is partitioned). `reason` is free clinical text:
// the audit trigger scrubs it from the before/after images, and it never rides the outbox event.
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { patients } from "../patient/patients";
import { providerEntities } from "../provider-entities";
import { criticalLabResults } from "./critical-lab-results";

export const criticalLabResultResolutions = pgTable(
  "critical_lab_result_resolution",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    criticalLabResultId: uuid("critical_lab_result_id")
      .notNull()
      .references(() => criticalLabResults.id, { onDelete: "restrict" }),
    resolution: text("resolution").$type<"matched_to_order" | "reviewed_no_action">().notNull(),
    matchedOrderId: uuid("matched_order_id"),
    reason: text("reason").notNull(),
    resolverMembershipId: uuid("resolver_membership_id").notNull(),
    resolverDiscipline: text("resolver_discipline").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oncePerResult: uniqueIndex("clr_resolution_once_uq").on(t.organizationId, t.criticalLabResultId),
    resultIdx: index("clr_resolution_result_idx").on(t.criticalLabResultId),
    patientIdx: index("clr_resolution_patient_idx").on(t.patientId),
    providerEntityIdx: index("clr_resolution_provider_entity_idx").on(t.providerEntityId),
    locationIdx: index("clr_resolution_location_idx").on(t.locationId),
  }),
);

export type CriticalLabResultResolutionRow = typeof criticalLabResultResolutions.$inferSelect;
export type NewCriticalLabResultResolutionRow = typeof criticalLabResultResolutions.$inferInsert;
