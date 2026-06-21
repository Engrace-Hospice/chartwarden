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
import { electionSignatureMethod, electionSignerKind } from "../../enums";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { locations } from "../locations";
import { electionPeriods } from "./election-periods";

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
    representativeConsentId: uuid("representative_consent_id"), // M39 consent (app-validated)
    representativeRelationship: text("representative_relationship"),
    patientNameAtSigning: text("patient_name_at_signing").notNull(),
    hospiceNameAtSigning: text("hospice_name_at_signing").notNull(),
    attendingPhysicianId: uuid("attending_physician_id"), // M40 physician (app-validated)
    curativeCareAcknowledgment: boolean("curative_care_acknowledgment").notNull(),
    signedAt: date("signed_at").notNull(),
    signatureMethod: electionSignatureMethod("signature_method").notNull(),
    documentId: uuid("document_id"), // M22 document (app-validated)
    stateAddendum: jsonb("state_addendum").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0),
  },
  (t) => ({
    periodUnique: uniqueIndex("election_statement_period_idx").on(t.electionPeriodId),
  }),
);

export type ElectionStatement = typeof electionStatements.$inferSelect;
export type NewElectionStatement = typeof electionStatements.$inferInsert;
