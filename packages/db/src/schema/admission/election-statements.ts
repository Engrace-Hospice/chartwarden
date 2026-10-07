// @wardenx/db — `election_statement` (M6 §3.3). The signed hospice-benefit election for a period.
// PHI-bearing (carries a patient reference) → the three-column tenancy rule (org NOT NULL + nullable
// provider_entity_id / location_id). Cross-module refs (M5 patient, M39 representative consent, M40
// attending physician, M22 document) are plain uuid app-validated; the election_period FK is
// intra-M6. RLS + the M4 write-audit trigger land in M6-T03 (§3.6–3.7).
import {
  bigint,
  boolean,
  date,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { businessRule } from "../../business-rules";
import { electionSignatureMethod, electionSignerKind, electionStatementStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { electionPeriods } from "./election-periods";

// Registered business rules (Bug 4): a `23505` on these indexes — two writers racing past the service's
// own pre-check — answers 409 with this sentence instead of a bare 500 (the F-022 / #55 convention).
// Declared outside `pgTable`'s lazily-invoked config callback so the error handler can see them.
const ELECTION_STATEMENT_PERIOD_IDX = businessRule(
  "election_statement_period_idx",
  "This benefit period already has an election statement. Open the existing statement instead of drafting a second one.",
);

export const electionStatements = pgTable(
  "election_statement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }), // ARCH-011 (nullable)
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }), // ARCH-011 (nullable)
    electionPeriodId: uuid("election_period_id")
      .notNull()
      .references(() => electionPeriods.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    signerKind: electionSignerKind("signer_kind").notNull(),
    // §7.3 draft → signed → voided (M6L-T03). A draft carries only intent; the signed-document fields
    // below are nullable at draft and filled by signElection.
    status: electionStatementStatus("status").notNull().default("drafted"),
    representativeConsentId: uuid("representative_consent_id"), // M39 consent (app-validated)
    representativeRelationship: text("representative_relationship"),
    patientNameAtSigning: text("patient_name_at_signing"),
    hospiceNameAtSigning: text("hospice_name_at_signing"),
    attendingPhysicianId: uuid("attending_physician_id"), // M40 physician (app-validated)
    curativeCareAcknowledgment: boolean("curative_care_acknowledgment"),
    signedAt: date("signed_at"),
    signatureMethod: electionSignatureMethod("signature_method"),
    documentId: uuid("document_id"), // M22 document (app-validated)
    stateAddendum: jsonb("state_addendum").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    periodUnique: uniqueIndex(ELECTION_STATEMENT_PERIOD_IDX).on(t.electionPeriodId),
  }),
);

export type ElectionStatement = typeof electionStatements.$inferSelect;
export type NewElectionStatement = typeof electionStatements.$inferInsert;
