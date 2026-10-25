// @chartwarden/db - M25 milestone 13a (migration 1240): beneficiary-filed appeals and appointments of representative.
// RECORD-KEEPING ONLY: no CMS rule is encoded and nothing is seeded. representative_form_version is an organization's own
// appointment form version as a person typed it; representative_appointment is patient-level and always recorded from a claim;
// beneficiary_appeal is separate from the hospice's own appeal_case chain. Closed sets are text + CHECK mirrored in
// domain/representative.ts and domain/beneficiary-appeal.ts; no pgEnum. Names, labels and notes are audit-scrubbed.
import { date, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { denialCase } from "./denial";

export const representativeFormVersion = pgTable(
  "representative_form_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    label: text("label").notNull(),
    formIdentifier: text("form_identifier"), // as entered
    editionText: text("edition_text"), // as entered
    sourceNote: text("source_note").notNull(),
    verifiedOn: date("verified_on"),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    requiredElements: jsonb("required_elements").notNull().default([]), // array of non-blank labels
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdByMembershipId: uuid("created_by_membership_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("representative_form_version_org_ix").on(t.organizationId, t.createdAt),
  }),
);

export const representativeAppointment = pgTable(
  "representative_appointment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    patientId: uuid("patient_id").notNull(), // M5 logical FK, resolved from the claim
    recordedFromClaimId: uuid("recorded_from_claim_id").notNull(), // M23 logical FK
    instrumentKind: text("instrument_kind").notNull(), // org_form | other_written_instrument
    formVersionId: uuid("form_version_id").references(() => representativeFormVersion.id, {
      onDelete: "restrict",
    }),
    instrumentNote: text("instrument_note"),
    representativeName: text("representative_name").notNull(), // audit-scrubbed
    relationshipLabel: text("relationship_label"), // audit-scrubbed
    representativeKind: text("representative_kind").notNull(), // family_or_friend | legal_representative | attorney | other
    beneficiarySignedOn: date("beneficiary_signed_on"),
    representativeSignedOn: date("representative_signed_on"),
    validThroughOn: date("valid_through_on"), // typed, never computed
    validitySourceNote: text("validity_source_note"),
    elementsConfirmed: jsonb("elements_confirmed").notNull().default([]), // [{ label, state: missing | confirmed }]
    documentId: uuid("document_id"), // M22 logical FK
    documentVersionId: uuid("document_version_id"), // the validated ACTIVE version
    state: text("state").notNull().default("draft"), // draft | active | revoked | superseded
    recordedByMembershipId: uuid("recorded_by_membership_id").notNull(),
    lastEditedByMembershipId: uuid("last_edited_by_membership_id").notNull(),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    revokedOn: date("revoked_on"),
    revokedByMembershipId: uuid("revoked_by_membership_id"),
    revocationNote: text("revocation_note"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPatient: index("ix_representative_appointment_patient").on(
      t.organizationId,
      t.patientId,
      t.createdAt,
    ),
  }),
);

export const beneficiaryAppeal = pgTable(
  "beneficiary_appeal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    claimId: uuid("claim_id").notNull(), // M23 logical FK
    patientId: uuid("patient_id").notNull(), // resolved from the claim
    denialCaseId: uuid("denial_case_id").references(() => denialCase.id, { onDelete: "restrict" }),
    filerKind: text("filer_kind").notNull(), // beneficiary | representative
    representativeAppointmentId: uuid("representative_appointment_id").references(
      () => representativeAppointment.id,
      { onDelete: "restrict" },
    ),
    tierLabel: text("tier_label").notNull(),
    filedOn: date("filed_on"), // typed
    externalReference: text("external_reference"), // audit-scrubbed
    sourceNote: text("source_note").notNull(), // audit-scrubbed
    state: text("state").notNull().default("recorded"), // recorded | supporting | decided | closed | withdrawn
    outcomeLabel: text("outcome_label"), // favorable | partial | unfavorable | dismissed | other (a label, never acted on)
    outcomeNote: text("outcome_note"), // audit-scrubbed
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdByMembershipId: uuid("created_by_membership_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byClaim: index("ix_beneficiary_appeal_claim").on(t.claimId),
    byOrg: index("beneficiary_appeal_org_ix").on(t.organizationId, t.createdAt),
  }),
);

export const beneficiaryAppealDocument = pgTable(
  "beneficiary_appeal_document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    beneficiaryAppealId: uuid("beneficiary_appeal_id")
      .notNull()
      .references(() => beneficiaryAppeal.id, { onDelete: "restrict" }),
    documentId: uuid("document_id").notNull(), // M22 logical FK
    documentVersionId: uuid("document_version_id").notNull(), // the validated ACTIVE version
    attachedByMembershipId: uuid("attached_by_membership_id"),
    attachedAt: timestamp("attached_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => ({
    byOrg: index("beneficiary_appeal_document_org_ix").on(t.organizationId, t.attachedAt),
  }),
);

export const beneficiaryAppealEvent = pgTable(
  "beneficiary_appeal_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    beneficiaryAppealId: uuid("beneficiary_appeal_id")
      .notNull()
      .references(() => beneficiaryAppeal.id, { onDelete: "restrict" }),
    eventKind: text("event_kind").notNull(),
    eventPayload: jsonb("event_payload"), // ids and counts only; denylisted
    actorMembershipId: uuid("actor_membership_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byAppeal: index("ix_beneficiary_appeal_event_case").on(t.beneficiaryAppealId, t.occurredAt),
  }),
);
