// @wardenx/db — M25 ADR cluster (hospice ADR/TPE/QIC PRD, milestone 2a): adr_case (a MAC's additional
// documentation request and its response clock) ─ adr_case_event (history) ─ mac_rule (per-organization
// response-window rules). NON-partitioned; organization_id NOT NULL on all three (canonical app.org_id RLS).
// State and review type are text + CHECK (closed sets mirrored in the backend domain types), so there is no
// new pgEnum to mirror. claim_id (M23) and provider_entity_id are LOGICAL uuid FKs; denial_case_id is an
// intra-M25 real FK. event_payload is audit-denylisted (§3.6).
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { denialCase } from "./denial";

export const macRule = pgTable(
  "mac_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    macName: text("mac_name").notNull(),
    reviewType: text("review_type").notNull(),
    responseDays: integer("response_days").notNull(),
    sourceNote: text("source_note"),
    verifiedOn: date("verified_on"),
    effectiveFrom: date("effective_from").notNull().defaultNow(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("mac_rule_org_ix").on(t.organizationId, t.createdAt),
  }),
);

export const adrCase = pgTable(
  "adr_case",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    claimId: uuid("claim_id").notNull(), // M23 logical FK
    denialCaseId: uuid("denial_case_id").references(() => denialCase.id, { onDelete: "restrict" }),
    macName: text("mac_name").notNull(),
    reviewType: text("review_type").notNull(),
    state: text("state").notNull().default("received"),
    adrReference: text("adr_reference"),
    requestedOn: date("requested_on").notNull(),
    windowDays: integer("window_days").notNull(),
    windowSource: text("window_source").notNull(),
    windowVerified: boolean("window_verified").notNull().default(false),
    responseDueAt: timestamp("response_due_at", { withTimezone: true }).notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // Milestone 2b — packet review and filing (mig 1109). membership ids are logical; the manifest is frozen
    // at filing by trigger. filing_confirmation_ref is free text (audit-scrubbed).
    checklist: jsonb("checklist").notNull().default(sql`'{}'::jsonb`),
    sentToReviewByMembershipId: uuid("sent_to_review_by_membership_id"),
    reviewedByMembershipId: uuid("reviewed_by_membership_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    filingChannel: text("filing_channel"),
    filingConfirmationRef: text("filing_confirmation_ref"),
    filedAt: timestamp("filed_at", { withTimezone: true }),
    filedLate: boolean("filed_late").notNull().default(false),
    receiptDocumentId: uuid("receipt_document_id"), // M22 logical FK
    packetManifest: jsonb("packet_manifest"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byClaim: index("ix_adr_claim").on(t.claimId),
    byDue: index("ix_adr_due")
      .on(t.responseDueAt)
      .where(sql`state IN ('received','in_assembly','in_review')`),
  }),
);

export const adrCaseEvent = pgTable(
  "adr_case_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    adrCaseId: uuid("adr_case_id")
      .notNull()
      .references(() => adrCase.id, { onDelete: "restrict" }),
    eventKind: text("event_kind").notNull(),
    eventPayload: jsonb("event_payload"),
    actorMembershipId: uuid("actor_membership_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCase: index("ix_adr_event_case").on(t.adrCaseId, t.occurredAt),
  }),
);

// Milestone 2b (mig 1109): the M22 documents attached to an ADR response. document_id is a LOGICAL M22 id; a
// detach stamps removed_at (rows are never deleted, and none changes once the case has been filed).
export const adrCaseDocument = pgTable(
  "adr_case_document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    adrCaseId: uuid("adr_case_id")
      .notNull()
      .references(() => adrCase.id, { onDelete: "restrict" }),
    documentId: uuid("document_id").notNull(),
    checklistKey: text("checklist_key"),
    attachedByMembershipId: uuid("attached_by_membership_id"),
    attachedAt: timestamp("attached_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => ({
    byOrg: index("adr_case_document_org_ix").on(t.organizationId, t.attachedAt),
  }),
);
