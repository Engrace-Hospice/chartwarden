// @chartwarden/db — `cahps_decedent_sample` (M30 §3.3; PARTITIONED monthly by `sampling_cycle_month`;
// retention class `phi`). The CMS CAHPS decedent sampling roster: one row per sampled decedent per
// monthly cycle, holding the envelope-encrypted primary-caregiver contact for vendor export. Registers
// a §3.7 eraser (re-encrypt the cipher to <erased>, retain the "was sampled" record). ORG-SCOPED:
// organization_id NOT NULL (canonical app.org_id RLS). deceased_admission_id / deceased_patient_id are
// logical FKs (M6 / M5, app-validated). `primary_caregiver_contact_cipher` is ciphertext PHI →
// audit-denylisted (§3.6).
//
// Monthly RANGE partitioning keyed on sampling_cycle_month: the Drizzle definition here is the LOGICAL shape
// (composite PK incl. the partition key); the PARTITION BY + monthly children + DEFAULT catch-all land
// in the RLS/tables migration. The decedent uniqueness (provider_entity_id, sampling_cycle_month,
// deceased_admission_id) INCLUDES the partition key, so it is a valid UNIQUE on the partitioned parent.
import {
  date,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const m30CahpsSampleStatus = pgEnum("m30_cahps_sample_status", [
  "pending_export",
  "exported_to_vendor",
  "vendor_acked",
  "export_failed",
]);

export const cahpsDecedentSample = pgTable(
  "cahps_decedent_sample",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with sampling_cycle_month (partition key)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    samplingCycleMonth: date("sampling_cycle_month").notNull(), // first day of month; partition key
    deceasedAdmissionId: uuid("deceased_admission_id").notNull(), // logical FK to M6
    deceasedPatientId: uuid("deceased_patient_id").notNull(), // logical FK to M5
    primaryCaregiverContactCipher: text("primary_caregiver_contact_cipher").notNull(), // envelope-enc; DENYLISTED (§3.6)
    primaryCaregiverContactKeyVersion: integer("primary_caregiver_contact_key_version").notNull(),
    exclusionReason: text("exclusion_reason"), // populated if filtered out per CMS rules
    status: m30CahpsSampleStatus("status").notNull().default("pending_export"),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    vendorAckRef: text("vendor_ack_ref"),
    vendorAckedAt: timestamp("vendor_acked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.samplingCycleMonth] }), // partition key must be in the PK
    uniqDecedent: uniqueIndex("uq_cahps_sample_decedent").on(
      t.providerEntityId,
      t.samplingCycleMonth,
      t.deceasedAdmissionId,
    ),
  }),
);

export type CahpsDecedentSample = typeof cahpsDecedentSample.$inferSelect;
export type NewCahpsDecedentSample = typeof cahpsDecedentSample.$inferInsert;
