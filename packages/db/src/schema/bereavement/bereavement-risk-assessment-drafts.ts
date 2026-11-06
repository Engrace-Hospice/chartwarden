// @chartwarden/db — `bereavement_risk_assessment_draft` (ADR-0109 D5, migration 1343). The eight D17 risk factors for an ADMISSION,
// recorded by an MSW, chaplain or bereavement counselor on the care team (or bereavement oversight) BEFORE the death. It keys on
// the admission, not on a plan, because it exists before any plan; `patient_id` / `admission_id` are logical uuids (M5 / M6 own
// those rows). At plan seed it is carried into the initial risk score and stamped `carried_score_id` / `carried_at`.
//
// Tri-state values only (true | false | "unknown", default all unknown), NO free text, so nothing is audit-denylisted. The
// substance-use slot is forced "unknown" by the service unless the writer is cleared for 42 CFR Part 2 content. Writable only while
// no plan exists for the admission (409 DRAFT_LOCKED, checked in the writing transaction).
//
// TENANCY: organization_id + provider_entity_id NOT NULL, location_id nullable, sited from the admission.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { bereavementRiskScore } from "./bereavement-risk-scores";

export const bereavementRiskAssessmentDraft = pgTable(
  "bereavement_risk_assessment_draft",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // logical M5
    admissionId: uuid("admission_id").notNull(), // logical M6

    /** The eight rubric keys (`ambivalentRelationship` … `activeSubstanceUse`), each true | false | "unknown". */
    factorsJsonb: jsonb("factors_jsonb").notNull(),
    lastEditedByMembershipId: uuid("last_edited_by_membership_id").notNull(), // logical M2
    lastEditedDiscipline: text("last_edited_discipline").notNull(),
    carriedScoreId: uuid("carried_score_id").references(() => bereavementRiskScore.id, {
      onDelete: "restrict",
    }),
    carriedAt: timestamp("carried_at", { withTimezone: true }),

    version: integer("version").notNull().default(1), // If-Match: 1 on the first write; "nothing yet" reads as 0
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    admissionUnique: uniqueIndex("berv_assessment_draft_admission_uniq").on(
      t.organizationId,
      t.admissionId,
    ),
    patientIdx: index("berv_assessment_draft_patient_idx").on(t.organizationId, t.patientId),
    orgIdx: index("berv_assessment_draft_org_ix").on(t.organizationId, t.createdAt),
    carriedScoreIdx: index("berv_assessment_draft_carried_score_idx")
      .on(t.carriedScoreId)
      .where(sql`carried_score_id IS NOT NULL`),
    providerEntityIdx: index("berv_assessment_draft_provider_entity_idx").on(t.providerEntityId),
    locationIdx: index("berv_assessment_draft_location_idx")
      .on(t.locationId)
      .where(sql`location_id IS NOT NULL`),

    factorsShape: check(
      "berv_assessment_draft_factors_chk",
      sql`jsonb_typeof(factors_jsonb) = 'object' AND factors_jsonb ?& ARRAY['ambivalentRelationship', 'suddenUnexpectedDeath', 'priorUnresolvedLoss', 'preExistingMentalHealth', 'socialIsolation', 'financialStrain', 'primaryCaregiverRole', 'activeSubstanceUse']`,
    ),
    disciplineLength: check(
      "berv_assessment_draft_discipline_chk",
      sql`char_length(btrim(last_edited_discipline)) BETWEEN 1 AND 64`,
    ),
    carriedTogether: check(
      "berv_assessment_draft_carried_chk",
      sql`(carried_score_id IS NULL) = (carried_at IS NULL)`,
    ),
  }),
);

export type BereavementRiskAssessmentDraftRow = typeof bereavementRiskAssessmentDraft.$inferSelect;
export type NewBereavementRiskAssessmentDraftRow =
  typeof bereavementRiskAssessmentDraft.$inferInsert;
