// @chartwarden/db — `patient_identifier` (M5 §3.3, §2.2). Every identifier a patient carries (MRN/MBI/
// SSN/state-id/prior/hospice-external/partner-mrn). PHI-bearing → three-column tenancy rule.
// §2.2 storage split: ssn/state_id are ENVELOPE-ENCRYPTED (`value_encrypted` bytea + plaintext
// `value_last4` for display, `value` NULL); every other kind is plaintext `value`. CHECK constraints
// enforce the split + the CMS MBI format. `value_encrypted` is on the M4 audit denylist (M5-T05) so
// the write-audit trigger never captures the ciphertext (and never the plaintext, which never lands
// in a column). The envelope KEK/DEK encrypt/decrypt happens in the app writer (M5-T08/T09), not here.
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  date,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { patientIdentifierKind } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { patients } from "./patients";

/** Envelope-encrypted identifier value, stored as PostgreSQL bytea (§2.2 ssn/state_id). */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const patientIdentifiers = pgTable(
  "patient_identifier",
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
    kind: patientIdentifierKind("kind").notNull(),
    value: text("value"), // plaintext for mrn/mbi/prior_mrn/hospice_external/partner_mrn
    valueEncrypted: bytea("value_encrypted"), // envelope-encrypted for ssn/state_id
    valueLast4: text("value_last4"), // display tail for ssn/state_id
    // GAP-010 — ssn rows only: HMAC-SHA256(HKDF(tenant DEK), nine digits), the equality-search token. Never
    // unique (a duplicate SSN is what the matcher exists to find). Null for state_id and for a shredded row.
    valueBlindIndex: bytea("value_blind_index"),
    // The DEK version the ciphertext and the blind index were produced under (multi-version matcher probe).
    valueDekVersion: text("value_dek_version"),
    issuer: text("issuer"), // state code, predecessor slug, partner assigning-authority, etc.
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("patient_identifier_patient_idx").on(t.patientId),
    mrnUnique: uniqueIndex("patient_identifier_mrn_unique")
      .on(t.organizationId, t.value)
      .where(sql`${t.kind} = 'mrn'`),
    mbiUnique: uniqueIndex("patient_identifier_mbi_unique")
      .on(t.organizationId, t.value)
      .where(sql`${t.kind} = 'mbi' AND ${t.effectiveTo} IS NULL`),
    priorMrnUnique: uniqueIndex("patient_identifier_prior_mrn_unique")
      .on(t.organizationId, t.issuer, t.value)
      .where(sql`${t.kind} = 'prior_mrn'`),
    partnerMrnIdx: index("patient_identifier_partner_mrn_idx")
      .on(t.organizationId, t.issuer, t.value)
      .where(sql`${t.kind} = 'partner_mrn'`),
    ssnStateIdEncrypted: check(
      "patient_identifier_sensitive_encrypted",
      sql`(${t.kind} NOT IN ('ssn','state_id')) OR (${t.valueEncrypted} IS NOT NULL AND ${t.value} IS NULL)`,
    ),
    ssnBlindIndex: check(
      "patient_identifier_ssn_blind_index",
      sql`(${t.kind} <> 'ssn') OR (${t.valueBlindIndex} IS NOT NULL) OR (octet_length(${t.valueEncrypted}) = 0)`,
    ),
    ssnBlindIdx: index("patient_identifier_ssn_blind_idx")
      .on(t.organizationId, t.valueBlindIndex)
      .where(
        sql`${t.kind} = 'ssn' AND ${t.effectiveTo} IS NULL AND ${t.valueBlindIndex} IS NOT NULL`,
      ),
    publicKindsPlaintext: check(
      "patient_identifier_public_plaintext",
      sql`(${t.kind} IN ('ssn','state_id')) OR (${t.value} IS NOT NULL)`,
    ),
    mbiFormat: check(
      "patient_identifier_mbi_format",
      sql`(${t.kind} <> 'mbi') OR (${t.value} ~ '^[1-9][AC-HJ-NP-RT-Y][0-9AC-HJ-NP-RT-Y]{9}$')`,
    ),
  }),
);

export type PatientIdentifier = typeof patientIdentifiers.$inferSelect;
export type NewPatientIdentifier = typeof patientIdentifiers.$inferInsert;
