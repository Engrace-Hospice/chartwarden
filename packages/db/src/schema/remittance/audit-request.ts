import { sql } from "drizzle-orm";
// @chartwarden/db - M25 milestone 7a-1 (migration 1171): the AUDIT REQUEST aggregate (a RAC / UPIC / SMRC / other request
// for records) - audit_request, audit_request_claim (many claims, soft-removed), audit_request_event (append-only).
// States and authority kinds are text + CHECK (closed sets mirrored in domain/audit-request.ts), so there is no new
// pgEnum. The authority kind is a LABEL only; the due date lives in recorded_deadline (1172), never here. claim_id (M23)
// and provider_entity_id are LOGICAL uuid FKs; adr_case_id / denial_case_id are intra-M25 real FKs. Free text
// (authority_name, request_reference, scope_note, the per-claim note, event_payload) is audit-scrubbed.
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { adrCase } from "./adr";
import { denialCase } from "./denial";

export const auditRequest = pgTable(
  "audit_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK -> M40/M2
    authorityKind: text("authority_kind").notNull(),
    authorityName: text("authority_name"),
    requestReference: text("request_reference"),
    requestDatedOn: date("request_dated_on"),
    receivedOn: date("received_on").notNull(),
    state: text("state").notNull().default("received"),
    scopeNote: text("scope_note"),
    adrCaseId: uuid("adr_case_id").references(() => adrCase.id, { onDelete: "restrict" }),
    denialCaseId: uuid("denial_case_id").references(() => denialCase.id, { onDelete: "restrict" }),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    noDeadlineAlertedAt: timestamp("no_deadline_alerted_at", { withTimezone: true }),
    // Milestone 7a-2 (migration 1175): the response packet. The checklist is typed by the person from the request
    // letter (nothing seeded); the manifest freezes at filing; the attestation says the letter states no due date.
    responseItems: jsonb("response_items").notNull().default([]), // denylisted free text
    sentToReviewByMembershipId: uuid("sent_to_review_by_membership_id"),
    reviewedByMembershipId: uuid("reviewed_by_membership_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    signedOffHash: text("signed_off_hash"), // fingerprint of what the reviewer signed off
    deadlineNoneStatedAt: timestamp("deadline_none_stated_at", { withTimezone: true }),
    deadlineNoneStatedByMembershipId: uuid("deadline_none_stated_by_membership_id"),
    responseChannel: text("response_channel"),
    responseConfirmationRef: text("response_confirmation_ref"), // denylisted
    responseFiledLate: boolean("response_filed_late").notNull().default(false),
    packetManifest: jsonb("packet_manifest"),
    createdByMembershipId: uuid("created_by_membership_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("audit_request_org_ix").on(t.organizationId, t.createdAt),
    byState: index("ix_audit_request_state").on(t.organizationId, t.state),
  }),
);

export const auditRequestClaim = pgTable(
  "audit_request_claim",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    auditRequestId: uuid("audit_request_id")
      .notNull()
      .references(() => auditRequest.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id").notNull(), // M23 logical FK
    dateOfServiceNote: text("date_of_service_note"),
    addedByMembershipId: uuid("added_by_membership_id"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedByMembershipId: uuid("removed_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byClaim: index("ix_audit_request_claim_claim").on(t.claimId),
    byOrg: index("audit_request_claim_org_ix").on(t.organizationId, t.createdAt),
  }),
);

// Milestone 7a-2 (migration 1175): the documents of the response. claim_id is the live claim the document is validated
// against (its patient). Soft-removed; frozen once the packet is filed.
export const auditRequestDocument = pgTable(
  "audit_request_document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    auditRequestId: uuid("audit_request_id")
      .notNull()
      .references(() => auditRequest.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id").notNull(), // M23 logical FK
    documentId: uuid("document_id").notNull(), // M22 logical FK
    attachedByMembershipId: uuid("attached_by_membership_id"),
    attachedAt: timestamp("attached_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => ({
    liveUnique: uniqueIndex("audit_request_document_live_unique")
      .on(t.auditRequestId, t.documentId)
      .where(sql`${t.removedAt} IS NULL`),
    byOrg: index("audit_request_document_org_ix").on(t.organizationId, t.attachedAt),
  }),
);

export const auditRequestEvent = pgTable(
  "audit_request_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    auditRequestId: uuid("audit_request_id")
      .notNull()
      .references(() => auditRequest.id, { onDelete: "restrict" }),
    eventKind: text("event_kind").notNull(),
    eventPayload: jsonb("event_payload"), // denylisted
    actorMembershipId: uuid("actor_membership_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCase: index("ix_audit_request_event_case").on(t.auditRequestId, t.occurredAt),
    byOrg: index("audit_request_event_org_ix").on(t.organizationId, t.occurredAt),
  }),
);
