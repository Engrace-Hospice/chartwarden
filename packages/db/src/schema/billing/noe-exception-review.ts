// M23-CM-4C.2: tenant-scoped NOE late-filing exception review. This is a local evidence/review record,
// never a MAC/CMS decision unless external provenance and its protected evidence are explicitly recorded.
import { sql } from "drizzle-orm";
import { date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const noeExceptionReview = pgTable("noe_exception_review", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  noeId: uuid("noe_id").notNull(), // M23 parent; organization relation enforced by trigger
  category: text("category").notNull().$type<"operations_disruption" | "cms_mac_system_issue" | "new_hospice_access_delay" | "other_external_determination">(),
  justificationDocumentId: uuid("justification_document_id").notNull(), // protected M22 evidence; no free-text PHI here
  status: text("status").notNull().default("draft").$type<"draft" | "evidence_required" | "ready_for_external_request" | "request_recorded" | "awaiting_external_determination" | "external_approved_recorded" | "external_denied_recorded" | "withdrawn">(),
  evidenceDocumentIds: uuid("evidence_document_ids").array().notNull().default(sql`'{}'::uuid[]`), // protected M22 references only
  externalRequestReference: text("external_request_reference"),
  externalRequestDate: date("external_request_date"),
  externalAuthority: text("external_authority").$type<"a_b_mac" | "cms">(),
  externalDecision: text("external_decision").$type<"approved" | "denied">(),
  externalDecisionDate: date("external_decision_date"),
  externalDecisionDocumentId: uuid("external_decision_document_id"), // protected M22 reference
  createdByMembershipId: uuid("created_by_membership_id").notNull(),
  updatedByMembershipId: uuid("updated_by_membership_id").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byNoe: index("noe_exception_review_noe_ix").on(t.organizationId, t.noeId, t.createdAt),
  oneActive: uniqueIndex("noe_exception_review_active_uq").on(t.organizationId, t.noeId)
    .where(sql`status NOT IN ('external_approved_recorded','external_denied_recorded','withdrawn')`),
}));

export const noeExceptionReviewEvent = pgTable("noe_exception_review_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  reviewId: uuid("review_id").notNull().references(() => noeExceptionReview.id, { onDelete: "restrict" }),
  eventType: text("event_type").notNull().$type<"created" | "evidence_updated" | "request_recorded" | "decision_recorded" | "withdrawn">(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  actorMembershipId: uuid("actor_membership_id").notNull(),
  evidenceDocumentIds: uuid("evidence_document_ids").array().notNull().default(sql`'{}'::uuid[]`),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ byReview: index("noe_exception_review_event_history_ix").on(t.organizationId, t.reviewId, t.occurredAt, t.id) }));

export type NoeExceptionReviewRow = typeof noeExceptionReview.$inferSelect;
export type NoeExceptionReviewEventRow = typeof noeExceptionReviewEvent.$inferSelect;
