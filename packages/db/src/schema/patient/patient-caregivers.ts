// @chartwarden/db — `patient_caregiver` (M5 §3.4). The patient↔caregiver link with relationship +
// legal-representative authority (DPOA/guardian/NOK). Three-column tenancy rule. One primary
// caregiver per patient; an LR authority other than 'none' requires the legal-representative flag.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { patientCaregiverLrAuthority, patientCaregiverRelationship } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { caregivers } from "./caregivers";
import { patients } from "./patients";

export const patientCaregivers = pgTable(
  "patient_caregiver",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    caregiverId: uuid("caregiver_id")
      .notNull()
      .references(() => caregivers.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    relationship: patientCaregiverRelationship("relationship").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    isLegalRepresentative: boolean("is_legal_representative").notNull().default(false),
    lrAuthority: patientCaregiverLrAuthority("lr_authority").notNull().default("none"),
    lrProofDocRef: uuid("lr_proof_doc_ref"),
    portalInvitationConsented: boolean("portal_invitation_consented").notNull().default(false),
    involvementFrom: date("involvement_from").notNull(),
    involvementTo: date("involvement_to"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("patient_caregiver_patient_idx").on(t.patientId),
    primaryUnique: uniqueIndex("patient_caregiver_primary_unique")
      .on(t.patientId)
      .where(sql`${t.isPrimary} = true AND ${t.involvementTo} IS NULL`),
    lrAuthorityRequiresFlag: check(
      "patient_caregiver_lr_authority_requires_flag",
      sql`(${t.lrAuthority} = 'none') OR (${t.isLegalRepresentative} = true)`,
    ),
  }),
);

export type PatientCaregiver = typeof patientCaregivers.$inferSelect;
export type NewPatientCaregiver = typeof patientCaregivers.$inferInsert;
