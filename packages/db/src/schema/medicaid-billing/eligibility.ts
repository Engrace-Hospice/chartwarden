// @wardenx/db — M24 Billing — Medicaid §3.3 — the per-patient-per-asOfServiceDate eligibility cache
// (NON-partitioned). 30-day freshness mirrors M23. The state Recipient ID digits are NEVER stored — only
// recipient_id_masked_at_check (last-4) and the KMS-wrapped raw_response_cipher (both audit-denylisted §3.6;
// the recipient_id* column-name family is globally denylisted from audit value-capture).
//
// CROSS-MODULE FK POLICY: organization_id / provider_entity_id / location_id (M1 core) get real FKs (PE +
// location nullable — a probe may precede admission). patient_id / patient_payer_id (M5) and mco_id (M40)
// are LOGICAL uuid.
import { index, jsonb, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { m24EligibilityOutcome } from "./enums";

export const medicaidEligibilityCheck = pgTable(
  "medicaid_eligibility_check",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id), // nullable (§3.3)
    locationId: uuid("location_id").references(() => locations.id), // nullable (§3.3)
    patientId: uuid("patient_id").notNull(), // logical FK → M5
    patientPayerId: uuid("patient_payer_id").notNull(), // logical FK → M5
    serviceState: varchar("service_state", { length: 2 }).notNull(),
    asOfServiceDate: timestamp("as_of_service_date", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    outcome: m24EligibilityOutcome("outcome").notNull(),
    mcoId: uuid("mco_id"), // logical FK → M40
    mcoSnapshot: jsonb("mco_snapshot"),
    recipientIdMaskedAtCheck: varchar("recipient_id_masked_at_check", { length: 32 }), // last-4 only (denylisted)
    rawResponseCipher: text("raw_response_cipher"), // KMS-wrapped (denylisted)
    vendorTransactionId: varchar("vendor_transaction_id", { length: 64 }),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    staleAt: timestamp("stale_at", { withTimezone: true }).notNull(), // checked_at + 30d
    errorMessage: text("error_message"),
  },
  (t) => ({
    byPatientAsOf: index("medicaid_eligibility_check_by_patient_asof").on(
      t.patientId,
      t.asOfServiceDate,
      t.checkedAt,
    ),
    byStaleAt: index("medicaid_eligibility_check_by_stale_at").on(t.staleAt),
  }),
);
