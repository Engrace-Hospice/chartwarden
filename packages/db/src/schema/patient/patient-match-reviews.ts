// @wardenx/db — `patient_match_review` (M5 §3.5, §7.3). The SOFT-duplicate review queue: when the
// matching pipeline (M5-T06) scores an incoming patient in the suggestion band (not a hard block,
// not a clean miss), it queues a review here for a human to merge / mark not-a-match. PHI-bearing →
// three-column tenancy rule.
import { sql } from "drizzle-orm";
import { index, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { patientMatchReviewStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { users } from "../users";
import { patients } from "./patients";

export const patientMatchReviews = pgTable(
  "patient_match_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    candidateExistingPatientId: uuid("candidate_existing_patient_id")
      .notNull()
      .references(() => patients.id),
    newPatientId: uuid("new_patient_id").references(() => patients.id), // null = nothing created yet
    candidateIncoming: jsonb("candidate_incoming").notNull(),
    score: numeric("score", { precision: 5, scale: 4 }).notNull(),
    featureBreakdown: jsonb("feature_breakdown").notNull(),
    status: patientMatchReviewStatus("status").notNull().default("open"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("patient_match_review_org_idx").on(t.organizationId),
    openIdx: index("patient_match_review_open_idx")
      .on(t.organizationId)
      .where(sql`${t.status} = 'open'`),
  }),
);

export type PatientMatchReview = typeof patientMatchReviews.$inferSelect;
export type NewPatientMatchReview = typeof patientMatchReviews.$inferInsert;
