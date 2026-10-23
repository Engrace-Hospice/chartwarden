// @chartwarden/db - M25 milestone 8a-1 (migration 1180): ADVISORY ADR documentation readiness - adr_readiness_review (one per
// requested review, immutable) and adr_readiness_finding (the assistant findings that survived the citation filter, each
// with a human disposition). They sit BESIDE adr_case / adr_case_document and the checklist, never inside them. States
// are text + CHECK (closed sets mirrored in domain/readiness.ts), so there is no new pgEnum. checklist_key is free text on
// purpose: the SME-unconfirmed key list lives in code, not in a table constraint. invocation_id is a LOGICAL FK to the M32
// ai_invocation ledger (NULL while AI is off). The finding note and the unavailable reason are audit-scrubbed.
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { adrCase } from "./adr";

export const adrReadinessReview = pgTable(
  "adr_readiness_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    adrCaseId: uuid("adr_case_id")
      .notNull()
      .references(() => adrCase.id, { onDelete: "restrict" }),
    requestedByMembershipId: uuid("requested_by_membership_id").notNull(),
    status: text("status").notNull(),
    source: text("source").notNull(),
    caseVersion: integer("case_version").notNull(),
    invocationId: uuid("invocation_id"), // logical FK -> M32 ai_invocation
    promptTemplateVersion: text("prompt_template_version"),
    modelVersionPin: text("model_version_pin"),
    unavailableReason: text("unavailable_reason"), // denylisted
    droppedFindingCount: integer("dropped_finding_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCase: index("adr_readiness_review_case_ix").on(t.adrCaseId, t.createdAt),
    byOrg: index("adr_readiness_review_org_ix").on(t.organizationId, t.createdAt),
  }),
);

export const adrReadinessFinding = pgTable(
  "adr_readiness_finding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => adrReadinessReview.id, { onDelete: "restrict" }),
    adrCaseId: uuid("adr_case_id")
      .notNull()
      .references(() => adrCase.id, { onDelete: "restrict" }),
    checklistKey: text("checklist_key").notNull(),
    status: text("status").notNull(),
    citedDocumentIds: uuid("cited_document_ids").array().notNull().default([]),
    note: text("note").notNull(), // denylisted
    disposition: text("disposition"),
    disposedByMembershipId: uuid("disposed_by_membership_id"),
    disposedAt: timestamp("disposed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byReview: index("adr_readiness_finding_review_ix").on(t.reviewId),
    byCase: index("adr_readiness_finding_case_ix").on(t.adrCaseId),
    byOrg: index("adr_readiness_finding_org_ix").on(t.organizationId, t.createdAt),
  }),
);
