// @chartwarden/db - M25 milestone 7a-1 (migration 1171): the AUDIT REQUEST aggregate (a RAC / UPIC / SMRC / other request
// for records) - audit_request, audit_request_claim (many claims, soft-removed), audit_request_event (append-only).
// States and authority kinds are text + CHECK (closed sets mirrored in domain/audit-request.ts), so there is no new
// pgEnum. The authority kind is a LABEL only; the due date lives in recorded_deadline (1172), never here. claim_id (M23)
// and provider_entity_id are LOGICAL uuid FKs; adr_case_id / denial_case_id are intra-M25 real FKs. Free text
// (authority_name, request_reference, scope_note, the per-claim note, event_payload) is audit-scrubbed.
import { date, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
