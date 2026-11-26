import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { m24PayerAuthorizationEventKind, m24PayerAuthorizationEvidenceStatus } from "./enums";

/**
 * Append-only, source-qualified observations about M6 clinical documents and payer notification /
 * authorization. Patient, admission, payer, document and authorization references are logical IDs;
 * clinical content stays in M6 and encrypted payer references are never exposed in audit payloads.
 */
export const medicaidPayerAuthorizationEvent = pgTable(
  "medicaid_payer_authorization_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }), // nullable siting
    patientId: uuid("patient_id").notNull(),
    patientPayerId: uuid("patient_payer_id").notNull(),
    admissionId: uuid("admission_id").notNull(),
    canonicalPayerId: uuid("canonical_payer_id").notNull(),
    serviceState: text("service_state").notNull(),
    serviceFrom: date("service_from", { mode: "string" }).notNull(),
    serviceTo: date("service_to", { mode: "string" }).notNull(),
    levelOfCare: text("level_of_care"),
    eventKind: m24PayerAuthorizationEventKind("event_kind").notNull(),
    evidenceStatus: m24PayerAuthorizationEvidenceStatus("evidence_status")
      .notNull()
      .default("unverified"),
    evidenceSource: text("evidence_source").notNull(),
    evidenceReference: text("evidence_reference"),
    clinicalDocumentId: uuid("clinical_document_id"), // logical M6 secure-document reference
    encryptedAuthorizationReference: text("encrypted_authorization_reference"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    recordedByMembershipId: uuid("recorded_by_membership_id").notNull(),
    supersedesId: uuid("supersedes_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgIdUnique: unique("medicaid_payer_auth_org_id_uq").on(t.organizationId, t.id),
    supersedesSameOrg: foreignKey({
      name: "medicaid_payer_auth_supersedes_org_fk",
      columns: [t.organizationId, t.supersedesId],
      foreignColumns: [t.organizationId, t.id],
    }).onDelete("restrict"),
    patientPayerWindow: index("medicaid_payer_auth_patient_payer_window_ix").on(
      t.organizationId,
      t.patientId,
      t.patientPayerId,
      t.admissionId,
      t.canonicalPayerId,
      t.serviceFrom,
      t.serviceTo,
    ),
    supersedes: index("medicaid_payer_auth_supersedes_ix").on(t.organizationId, t.supersedesId),
    rangeValid: check("medicaid_payer_auth_service_range_valid", sql`service_from <= service_to`),
    stateValid: check("medicaid_payer_auth_state_valid", sql`length(service_state) = 2`),
    locValid: check(
      "medicaid_payer_auth_loc_valid",
      sql`level_of_care IS NULL OR level_of_care IN ('RHC', 'CHC', 'IRC', 'GIP', 'NF_RB')`,
    ),
    verifiedHasProvenance: check(
      "medicaid_payer_auth_verified_provenance",
      sql`evidence_status <> 'verified' OR (verified_at IS NOT NULL AND verified_by_membership_id IS NOT NULL AND verified_by_membership_id <> recorded_by_membership_id AND evidence_reference IS NOT NULL)`,
    ),
    evidenceSourceValid: check(
      "medicaid_payer_auth_source_valid",
      sql`evidence_source IN ('m6_document_reference', 'operator_record', 'payer_response', 'payer_portal', 'authorized_channel_receipt')`,
    ),
    evidenceReferenceShape: check(
      "medicaid_payer_auth_reference_shape",
      sql`evidence_reference IS NULL OR evidence_reference ~ '^(doc|payer-response|payer-portal|ticket):[A-Za-z0-9._/-]{1,190}$'`,
    ),
  }),
);

export type MedicaidPayerAuthorizationEvent = typeof medicaidPayerAuthorizationEvent.$inferSelect;
export type NewMedicaidPayerAuthorizationEvent =
  typeof medicaidPayerAuthorizationEvent.$inferInsert;
