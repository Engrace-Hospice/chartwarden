// @chartwarden/db — `patient_payer` (M5 §3.4). A patient's insurance coverages, ranked (1=primary).
// `payer_id` resolves an M40 canonical Payer — validated at runtime via the MdmEntityProvider seam,
// NOT a cross-module FK constraint (modules own their tables; cross-module refs are app-validated).
// PHI-bearing → three-column tenancy rule. One active coverage per (patient, rank).
// Dates are INCLUSIVE at both ends; migration 1291 adds `patient_payer_rank_no_overlap` (an EXCLUDE USING gist over
// org/patient/rank and `daterange(effective_from, effective_to, '[]')`, skipping empty windows), which Drizzle cannot
// express, so it lives in SQL only. Writers close a replaced row the day BEFORE its successor (#845).
import { sql } from "drizzle-orm";
import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { patientPayerCoverageKind } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { patients } from "./patients";

export const patientPayers = pgTable(
  "patient_payer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    payerId: uuid("payer_id").notNull(), // M40 canonical Payer (runtime-validated; no cross-module FK)
    rank: integer("rank").notNull(), // 1 = primary
    coverageKind: patientPayerCoverageKind("coverage_kind").notNull(),
    subscriberId: text("subscriber_id").notNull(), // MBI for medicare_ffs
    groupNumber: text("group_number"),
    binPcn: text("bin_pcn"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    cardImageDocRef: uuid("card_image_doc_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("patient_payer_patient_idx").on(t.patientId),
    activeRankUnique: uniqueIndex("patient_payer_active_rank_unique")
      .on(t.patientId, t.rank)
      .where(sql`${t.effectiveTo} IS NULL`),
  }),
);

export type PatientPayer = typeof patientPayers.$inferSelect;
export type NewPatientPayer = typeof patientPayers.$inferInsert;
