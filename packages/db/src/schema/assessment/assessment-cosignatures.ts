// @wardenx/db — `assessment_cosignature` (M9 §3.3, §7.4). The LPN-cosignature record: when an
// assessment requires a supervising-RN / clinical-supervisor cosignature (cosign_required), one row
// per cosigner role attests to it. PHI-adjacent → the three-column tenancy rule (PE/location
// denormalized from the parent assessment). The clinical_assessment link is a plain uuid (the parent
// is partitioned — a composite-PK FK is impractical; integrity is enforced in the service layer).
// Actor ref goes to M1 `membership`. RLS + grants + the M4 write-audit trigger (attestation_text
// denylisted, §8.1) land in the RLS migration.
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { memberships } from "../memberships";

export const assessmentCosignatures = pgTable(
  "assessment_cosignature",
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

    clinicalAssessmentId: uuid("clinical_assessment_id").notNull(), // M9 clinical_assessment (logical; parent is partitioned)
    cosignerMembershipId: uuid("cosigner_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    cosignerRole: text("cosigner_role").notNull(), // 'rn_case_manager' | 'clinical_supervisor'
    cosignedAt: timestamp("cosigned_at", { withTimezone: true }).notNull().defaultNow(),
    attestationText: text("attestation_text").notNull(),
  },
  (t) => ({
    assessmentRoleUq: uniqueIndex("assessment_cosignature_assessment_role_uq").on(
      t.clinicalAssessmentId,
      t.cosignerRole,
    ),
  }),
);

export type AssessmentCosignature = typeof assessmentCosignatures.$inferSelect;
export type NewAssessmentCosignature = typeof assessmentCosignatures.$inferInsert;
