// @chartwarden/db — `portal_signature_request` (M31 ADR-0107 PROPOSED; migration 1301). The portal-facing WORKFLOW record for a
// staff-sent request that a patient or their representative sign an admission document in the portal. M06 (election, notice of
// rights) and M39 (consent) stay the authoritative signing state machines; `target_ref` is a logical FK to the row the sign path
// produced there. Patient-bearing, so it carries the ARCH-011 provider_entity_id NOT NULL + location_id (nullable). The signer's
// typed name, relationship and reasons are PHI and audit-denylisted (the audit trigger scrubs them). Names match the migration.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { users } from "../users";
import { portalAccounts } from "./portal-accounts";
import { portalDocumentUploads } from "./portal-document-uploads";

/** The four admission documents a portal signer can be asked to sign (CHECK-constrained in the migration). */
export const PORTAL_SIGNATURE_DOC_KINDS = [
  "election_statement",
  "notice_of_patient_rights",
  "hipaa_npp_acknowledgement",
  "consent_to_treat",
] as const;
export type PortalSignatureDocKind = (typeof PORTAL_SIGNATURE_DOC_KINDS)[number];

/** pending -> signed | uploaded_pending_review | voided; uploaded_pending_review -> signed | pending | voided; signed/voided final. */
export const PORTAL_SIGNATURE_STATUSES = [
  "pending",
  "signed",
  "uploaded_pending_review",
  "voided",
] as const;
export type PortalSignatureStatus = (typeof PORTAL_SIGNATURE_STATUSES)[number];

/** Who signed: the patient, a legal representative (healthcare agent), or a caregiver when the patient could not. */
export const PORTAL_SIGNER_ROLES = [
  "patient",
  "legal_representative",
  "caregiver_on_behalf",
] as const;
export type PortalSignerRole = (typeof PORTAL_SIGNER_ROLES)[number];

export const portalSignatureRequests = pgTable(
  "portal_signature_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // logical FK → M5 patient
    docKind: text("doc_kind").$type<PortalSignatureDocKind>().notNull(),
    templateKey: text("template_key").notNull(),
    templateVersion: text("template_version").notNull(),
    /** The M06 election / NOR admission or M39 consent the sign path produced; null until signed. Logical FK. */
    targetRef: uuid("target_ref"),
    status: text("status").$type<PortalSignatureStatus>().notNull().default("pending"),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true }),
    reminderCount: integer("reminder_count").notNull().default(0),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    /** PHI-adjacent free text — audit-denylisted. */
    voidReason: text("void_reason"),
    signedByPortalAccountId: uuid("signed_by_portal_account_id").references(
      () => portalAccounts.id,
      {
        onDelete: "restrict",
      },
    ),
    signerGrantKind: text("signer_grant_kind"),
    signerRole: text("signer_role").$type<PortalSignerRole>(),
    /** PHI — audit-denylisted. */
    signedTypedName: text("signed_typed_name"),
    /** PHI — audit-denylisted. Required unless the patient signed. */
    signerRelationshipText: text("signer_relationship_text"),
    /** PHI — audit-denylisted. Required when a caregiver signed on the patient's behalf. */
    patientUnableReason: text("patient_unable_reason"),
    /** SHA-256 of the exact attestation text the signer agreed to. */
    attestationSha256: text("attestation_sha256"),
    portalSessionId: uuid("portal_session_id"),
    idempotencyKey: text("idempotency_key"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    uploadedDocumentUploadId: uuid("uploaded_document_upload_id").references(
      () => portalDocumentUploads.id,
      { onDelete: "restrict" },
    ),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewOutcome: text("review_outcome").$type<"accepted" | "rejected">(),
  },
  (t) => ({
    orgIdUnique: unique("portal_signature_request_org_id_unique").on(t.organizationId, t.id),
    reminderNonNegative: check(
      "portal_signature_request_reminder_chk",
      sql`${t.reminderCount} >= 0`,
    ),
    openUnique: uniqueIndex("portal_signature_request_open_unique")
      .on(t.organizationId, t.patientId, t.docKind)
      .where(sql`${t.status} IN ('pending', 'uploaded_pending_review')`),
    idemUnique: uniqueIndex("portal_signature_request_idem_unique")
      .on(t.organizationId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    patientIdx: index("portal_signature_request_patient_idx").on(
      t.organizationId,
      t.patientId,
      t.status,
    ),
    reminderIdx: index("portal_signature_request_reminder_idx")
      .on(t.organizationId, t.lastRemindedAt)
      .where(sql`${t.status} = 'pending'`),
    requestedByIdx: index("portal_signature_request_requested_by_idx").on(t.requestedBy),
    voidedByIdx: index("portal_signature_request_voided_by_idx")
      .on(t.voidedBy)
      .where(sql`${t.voidedBy} IS NOT NULL`),
    reviewedByIdx: index("portal_signature_request_reviewed_by_idx")
      .on(t.reviewedBy)
      .where(sql`${t.reviewedBy} IS NOT NULL`),
    accountIdx: index("portal_signature_request_account_idx")
      .on(t.signedByPortalAccountId)
      .where(sql`${t.signedByPortalAccountId} IS NOT NULL`),
    uploadIdx: index("portal_signature_request_upload_idx")
      .on(t.uploadedDocumentUploadId)
      .where(sql`${t.uploadedDocumentUploadId} IS NOT NULL`),
    providerEntityIdx: index("portal_signature_request_provider_entity_idx").on(t.providerEntityId),
    locationIdx: index("portal_signature_request_location_idx")
      .on(t.locationId)
      .where(sql`${t.locationId} IS NOT NULL`),
  }),
);

export type PortalSignatureRequestRow = typeof portalSignatureRequests.$inferSelect;
export type NewPortalSignatureRequestRow = typeof portalSignatureRequests.$inferInsert;
