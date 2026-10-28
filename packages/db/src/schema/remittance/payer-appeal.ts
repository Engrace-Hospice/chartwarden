// @chartwarden/db - M25 milestone 12a-1 (migrations 1206-1207): payer appeals. payer_appeal_path (+ _level) is the payer's
// own appeal path as a PERSON wrote it from a contract or notice: nothing is seeded and there is no platform default.
// payer_appeal_case is one row per level of that path, separate from the Medicare appeal_case chain (its tier enum and
// NOT NULL Medicare deadline are Medicare rules). Closed sets are text + CHECK mirrored in domain/payer-appeal-path.ts and
// domain/payer-appeal.ts; no pgEnum. payer_id is a logical M40 id (M25 does not depend on M40). Free text is audit-scrubbed.
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

export const payerAppealPath = pgTable(
  "payer_appeal_path",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    payerId: uuid("payer_id").notNull(), // M40 logical FK
    payerNameSnapshot: text("payer_name_snapshot").notNull(),
    program: text("program").notNull(), // commercial | medicare_advantage
    contractLabel: text("contract_label"), // audit-scrubbed
    status: text("status").notNull().default("draft"), // draft | active | retired
    effectiveFrom: date("effective_from").notNull(),
    sourceNote: text("source_note").notNull(), // audit-scrubbed
    sourceDocumentId: uuid("source_document_id"), // M22 logical FK
    authoredByMembershipId: uuid("authored_by_membership_id").notNull(),
    verifiedOn: date("verified_on"),
    verifiedByMembershipId: uuid("verified_by_membership_id"),
    supersedesPathId: uuid("supersedes_path_id"), // a real self-FK in SQL
    revision: integer("revision").notNull().default(1),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPayer: index("payer_appeal_path_payer_ix").on(t.organizationId, t.payerId, t.effectiveFrom),
  }),
);

export const payerAppealPathLevel = pgTable(
  "payer_appeal_path_level",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    pathId: uuid("path_id")
      .notNull()
      .references(() => payerAppealPath.id, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    levelKind: text("level_kind").notNull(), // internal | external_review | other
    levelLabel: text("level_label").notNull(),
    whoFiles: text("who_files").notNull().default("unknown"), // provider | member | either | unknown
    filingWindowDays: integer("filing_window_days"),
    anchorKind: text("anchor_kind"),
    receiptPresumptionDays: integer("receipt_presumption_days"),
    dayBasis: text("day_basis"), // calendar | business_us_federal
    roll: text("roll"), // none | back | forward, present exactly when day_basis is business
    decisionDays: integer("decision_days"),
    formLabel: text("form_label"),
    formDocumentId: uuid("form_document_id"), // M22 logical FK
    channelNote: text("channel_note"),
    sourceNote: text("source_note").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("payer_appeal_path_level_org_ix").on(t.organizationId, t.createdAt),
  }),
);

export const payerAppealCase = pgTable(
  "payer_appeal_case",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK -> M40/M2
    denialCaseId: uuid("denial_case_id")
      .notNull()
      .references(() => denialCase.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id"), // M23 logical FK; NULL for a commercial denial
    payerId: uuid("payer_id").notNull(), // M40 logical FK
    program: text("program").notNull(),
    pathId: uuid("path_id").references(() => payerAppealPath.id, { onDelete: "restrict" }),
    pathRevision: integer("path_revision"),
    levelOrdinal: integer("level_ordinal"),
    levelKind: text("level_kind").notNull(),
    levelLabel: text("level_label").notNull(),
    windowDays: integer("window_days"),
    anchorKind: text("anchor_kind"),
    receiptPresumptionDays: integer("receipt_presumption_days"),
    dayBasis: text("day_basis"),
    roll: text("roll"),
    decisionDays: integer("decision_days"),
    priorLevelCaseId: uuid("prior_level_case_id"), // a real self-FK in SQL
    state: text("state").notNull().default("draft"),
    noticeDatedOn: date("notice_dated_on"),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    deadlineZone: text("deadline_zone"),
    deadlineSource: text("deadline_source").notNull().default("none"), // path_rule | none
    windowVerified: boolean("window_verified").notNull().default(false),
    payerReference: text("payer_reference"),
    externalReviewerName: text("external_reviewer_name"),
    decisionOutcome: text("decision_outcome"), // favorable | partial | unfavorable
    dispositionKind: text("disposition_kind"),
    dispositionNote: text("disposition_note"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdByMembershipId: uuid("created_by_membership_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDenial: index("ix_payer_appeal_denial").on(t.denialCaseId),
    byOrg: index("payer_appeal_case_org_ix").on(t.organizationId, t.createdAt),
  }),
);

export const payerAppealCaseEvent = pgTable(
  "payer_appeal_case_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    payerAppealCaseId: uuid("payer_appeal_case_id")
      .notNull()
      .references(() => payerAppealCase.id, { onDelete: "restrict" }),
    eventKind: text("event_kind").notNull(),
    eventPayload: jsonb("event_payload"), // denylisted
    actorMembershipId: uuid("actor_membership_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCase: index("ix_payer_appeal_event_case").on(t.payerAppealCaseId, t.occurredAt),
  }),
);
