// @wardenx/db — `patient` (M5 Patient & Demographics §3.3). The patient SPINE: one row per
// real-world person per org, the only thing FKs point to (§2.2 `patient.id` immutable forever).
// PHI-bearing → the three-column tenancy rule (M05-F04 / ADR-0010 D1): organization_id NOT NULL +
// provider_entity_id / location_id nullable (the spine is org-level until admission activates them).
// race/ethnicity/SOGI/marital are USCDI TEXT codes resolved via M38 value-sets (§3.2). A `merged`
// row carries a non-null `merged_into_id` and redirects transparently (§2.4). RLS + the M4
// write-audit trigger (sensitive columns on the denylist) land in M5-T05 (§3.6–3.7).
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { patientStatus } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";

export const patients = pgTable(
  "patient",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }), // ARCH-011 / M05-F04 (nullable — org-level until admission)
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }), // ARCH-011 / M05-F04 (nullable)
    mrn: text("mrn").notNull(), // mirrored from patient_identifier(kind='mrn') for hot-path joins
    legalFirstName: text("legal_first_name").notNull(),
    legalMiddleName: text("legal_middle_name"),
    legalLastName: text("legal_last_name").notNull(),
    legalNameSuffix: text("legal_name_suffix"),
    dob: date("dob").notNull(),
    sexAssignedAtBirth: text("sex_assigned_at_birth").notNull(), // USCDI value-set code (M38)
    genderIdentityCode: text("gender_identity_code"), // USCDI (SNOMED via M38)
    sexualOrientationCode: text("sexual_orientation_code"), // USCDI (SNOMED via M38)
    pronounsCode: text("pronouns_code"), // LOINC LL5144-2 codes
    maritalStatusCode: text("marital_status_code"), // HL7 v3 MaritalStatus
    raceCodes: text("race_codes").array(), // USCDI (OMB + granular)
    ethnicityCodes: text("ethnicity_codes").array(), // USCDI (OMB + granular)
    status: patientStatus("status").notNull().default("prospective"),
    deceasedDate: date("deceased_date"), // set when status='deceased'
    nppAcknowledgmentDocRef: uuid("npp_acknowledgment_doc_ref"), // M22 document id
    mergedIntoId: uuid("merged_into_id").references((): AnyPgColumn => patients.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdx: index("patient_org_idx").on(t.organizationId),
    // SD-028 composite (organization_id, location_id, natural_key) for partition/plan locality.
    orgLocMrnIdx: index("patient_org_loc_mrn_idx").on(t.organizationId, t.locationId, t.mrn),
    mrnUnique: uniqueIndex("patient_mrn_org_unique").on(t.organizationId, t.mrn),
    nameSearchIdx: index("patient_name_search_idx").using(
      "gin",
      sql`(lower(${t.legalLastName} || ' ' || ${t.legalFirstName}) gin_trgm_ops)`,
    ),
    dobIdx: index("patient_dob_idx").on(t.organizationId, t.dob),
    statusIdx: index("patient_status_idx").on(t.organizationId, t.status),
    deceasedRequiresDate: check(
      "patient_deceased_requires_date",
      sql`(${t.status} <> 'deceased') OR (${t.deceasedDate} IS NOT NULL)`,
    ),
    dobNotFuture: check("patient_dob_not_future", sql`${t.dob} <= CURRENT_DATE`),
    mergedRequiresTarget: check(
      "patient_merged_requires_target",
      sql`(${t.status} <> 'merged') OR (${t.mergedIntoId} IS NOT NULL)`,
    ),
  }),
);

export type Patient = typeof patients.$inferSelect;
export type NewPatient = typeof patients.$inferInsert;
