// @chartwarden/db — `hope_assessment_answer` (M10 HOPE modernization Phase 1A). Canonical current
// item-level answer rows for a HOPE assessment. The assessment link remains a logical UUID because
// `hope_assessment` is partitioned by target_date with a composite PK; service code enforces parent
// integrity just like the existing M10 child tables.
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { hopeAnswerSource, hopeAnswerState } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { hopeSpecItems } from "./hope-spec-items";
import { hopeSpecVersions } from "./hope-spec-versions";

/**
 * `jsonb` decoded ONCE. node-postgres already parses a jsonb column into a JS value; drizzle's own `jsonb`
 * then `JSON.parse`s any string it is handed a second time — so the coded answer `"2"` (stored as the JSON
 * string "2") read back as the number 2, and free text that happens to be JSON ("007", "true", "null")
 * was rewritten. HOPE answer values are strings by contract (`normalizeHopeAnswerValue`), so this column
 * passes the driver's value through untouched.
 */
const answerValueJsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  toDriver: (value) => JSON.stringify(value),
  fromDriver: (value) => value,
});

export const hopeAssessmentAnswers = pgTable(
  "hope_assessment_answer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    hopeAssessmentId: uuid("hope_assessment_id").notNull(),
    specVersionId: uuid("spec_version_id")
      .notNull()
      .references(() => hopeSpecVersions.id, { onDelete: "restrict" }),
    specItemId: uuid("spec_item_id")
      .notNull()
      .references(() => hopeSpecItems.id, { onDelete: "restrict" }),

    state: hopeAnswerState("state").notNull(),
    value: answerValueJsonb("value"),
    source: hopeAnswerSource("source").notNull(),
    sourceReference: jsonb("source_reference"),

    answeredAt: timestamp("answered_at", { withTimezone: true }),
    answeredByMembershipId: uuid("answered_by_membership_id").references(() => memberships.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneAnswerPerAssessmentItem: uniqueIndex("uniq_hope_answer_assessment_item").on(
      t.hopeAssessmentId,
      t.specItemId,
    ),
    byAssessment: index("idx_hope_answer_assessment").on(t.hopeAssessmentId),
    byAssessmentState: index("idx_hope_answer_assessment_state").on(t.hopeAssessmentId, t.state),
    bySpecItem: index("idx_hope_answer_spec_item").on(t.specItemId),
    valueState: check(
      "hope_answer_state_value_ck",
      sql`(state = 'skipped' AND value IS NULL) OR (state = 'answered' AND value IS NOT NULL)`,
    ),
  }),
);

export type HopeAssessmentAnswer = typeof hopeAssessmentAnswers.$inferSelect;
export type NewHopeAssessmentAnswer = typeof hopeAssessmentAnswers.$inferInsert;
