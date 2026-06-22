// @wardenx/db — `hope_validation_finding` (M10 §3.3). One row per CMS HOPE pre-submission rule result
// against a hope_assessment: rule id, severity (error blocks submission / warning advisory), the
// section + item code, and the resolved lifecycle. PHI-bearing (the `message` may quote item values) →
// the three-column tenancy rule (PE/location denormalized from the assessment, §3.3 tenancy note). RLS
// keys on app.org_id alone. The hope_assessment link is a plain uuid (the parent is partitioned — a
// composite-PK FK is impractical; integrity is enforced in the service layer). RLS + grants + the M4
// write-audit trigger (message denylisted, §8.1) land in the RLS migration.
import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { hopeValidationSeverity } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";

export const hopeValidationFindings = pgTable(
  "hope_validation_finding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),

    hopeAssessmentId: uuid("hope_assessment_id").notNull(), // M10 hope_assessment (logical; parent partitioned)
    ruleId: text("rule_id").notNull(),
    severity: hopeValidationSeverity("severity").notNull(),
    section: text("section").notNull(),
    itemCode: text("item_code"),
    message: text("message").notNull(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
    resolved: boolean("resolved").notNull().default(false),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    byAssessment: index("idx_hope_finding_assessment").on(
      t.hopeAssessmentId,
      t.severity,
      t.resolved,
    ),
    // Latest unresolved error blocks submission.
    byOrgUnresolvedError: index("idx_hope_finding_org_unresolved_error")
      .on(t.organizationId, t.severity, t.resolved)
      .where(sql`severity = 'error' AND resolved = false`),
  }),
);

export type HopeValidationFinding = typeof hopeValidationFindings.$inferSelect;
export type NewHopeValidationFinding = typeof hopeValidationFindings.$inferInsert;
