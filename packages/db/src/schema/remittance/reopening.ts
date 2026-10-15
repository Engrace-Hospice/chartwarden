// @wardenx/db — M25 milestone 3 (migration 1112): where a denial goes (denial_route_rule), and the MAC reopening
// aggregate (reopening_case ─ reopening_case_event). NON-partitioned; organization_id NOT NULL on all three (canonical
// app.org_id RLS). States, channels, outcomes and route kinds are text + CHECK (closed sets mirrored in
// domain/denial-route.ts and domain/reopening-machine.ts), so there is no new pgEnum. claim_id (M23) and
// provider_entity_id are LOGICAL uuid FKs; denial_case_id and adr_case_id are intra-M25 real FKs. The filing facts are
// frozen by trigger once recorded; filing_confirmation_ref and event_payload are audit-scrubbed.
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { adrCase } from "./adr";
import { denialCase } from "./denial";

export const denialRouteRule = pgTable(
  "denial_route_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    macName: text("mac_name"), // null = every MAC
    codeKind: text("code_kind").notNull(),
    code: varchar("code", { length: 16 }).notNull(),
    route: text("route").notNull(),
    sourceNote: text("source_note"),
    verifiedOn: date("verified_on"),
    effectiveFrom: date("effective_from").notNull().defaultNow(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("denial_route_rule_org_ix").on(t.organizationId, t.createdAt),
  }),
);

export const reopeningCase = pgTable(
  "reopening_case",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    claimId: uuid("claim_id").notNull(), // M23 logical FK
    denialCaseId: uuid("denial_case_id")
      .notNull()
      .references(() => denialCase.id, { onDelete: "restrict" }),
    adrCaseId: uuid("adr_case_id").references(() => adrCase.id, { onDelete: "restrict" }),
    macName: text("mac_name").notNull(),
    state: text("state").notNull().default("draft"),
    formName: text("form_name"),
    filingChannel: text("filing_channel"),
    filingConfirmationRef: text("filing_confirmation_ref"),
    filedAt: timestamp("filed_at", { withTimezone: true }),
    proofDocumentId: uuid("proof_document_id"), // logical M22 id
    dueAt: timestamp("due_at", { withTimezone: true }), // optional: the MAC states no reopening deadline
    outcome: text("outcome"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byClaim: index("ix_reopening_claim").on(t.claimId),
    byOrg: index("reopening_case_org_ix").on(t.organizationId, t.createdAt),
  }),
);

export const reopeningCaseEvent = pgTable(
  "reopening_case_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    reopeningCaseId: uuid("reopening_case_id")
      .notNull()
      .references(() => reopeningCase.id, { onDelete: "restrict" }),
    eventKind: text("event_kind").notNull(),
    eventPayload: jsonb("event_payload"), // denylisted free text (§3.6)
    actorMembershipId: uuid("actor_membership_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCase: index("ix_reopening_event_case").on(t.reopeningCaseId, t.occurredAt),
  }),
);
