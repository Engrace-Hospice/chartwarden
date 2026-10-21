import { sql } from "drizzle-orm";
// @chartwarden/db — M25 Remittance & Denials §3.3 — the denial worklist cluster:
//   denial_case (worklist aggregate) ─┬─ denial_case_assignment (assignee history)
//                                     └─ appeal_case (spawned; in appeal.ts)
//   denial_taxonomy_overlay (per-tenant plain-language + suggested-action layer over the M38 catalog)
//
// NON-partitioned (low row count; the worklist surface). organization_id NOT NULL on every table —
// denial_case_assignment carries organization_id (added beyond the spec §3.3 column list: the canonical
// app.org_id RLS posture / three-column rule WINS over the spec proposal, so the child gets direct
// RLS rather than a parent-join policy). denial_taxonomy_overlay is STRICTLY org-scoped (M25-F09 /
// ADR-0010): organization_id NOT NULL, standard generator RLS — NO platform-default NULL-org rows
// (platform defaults live in M38 and are resolved at read time). `category` is NOT an overlay column:
// it is the M38 regulatory floor, read from M38, never stored/edited here (M25-F09).
//
// CROSS-MODULE FK POLICY: only organization_id → organizations and the intra-M25 parent
// (denial_case_assignment.denial_case_id → denial_case, both non-partitioned) are real FKs.
// claim_id (M23), remittance_*_id (partitioned M25 lines), assignee/*_membership_id (core),
// source_evv_aggregator_submission_id (M18) are LOGICAL uuid FKs. override_payload / reason are
// audit-denylisted (§3.6).
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import {
  m25DenialCategory,
  m25DenialClosureOutcome,
  m25DenialSource,
  m25DenialState,
  m25TaxonomyOwnerRole,
  m25TaxonomySeverity,
  m25TaxonomyStatus,
} from "./enums";

// ---- denial_case (worklist aggregate) ----
export const denialCase = pgTable(
  "denial_case",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK → M40/M2
    claimId: uuid("claim_id"), // M23 logical FK (nullable for 277CA-pre-835 cases)
    remittanceLineId: uuid("remittance_line_id"),
    remittanceServiceLineId: uuid("remittance_service_line_id"),
    remittanceAdjustmentId: uuid("remittance_adjustment_id"),
    sourceEvvAggregatorSubmissionId: uuid("source_evv_aggregator_submission_id"), // M18 logical FK
    carcCode: varchar("carc_code", { length: 8 }).notNull(),
    rarcCode: varchar("rarc_code", { length: 8 }),
    // The MAC's own reason code (FISS 56900 etc.), not a CARC; entered by the user (milestone 3, mig 1112).
    macReasonCode: varchar("mac_reason_code", { length: 16 }),
    category: m25DenialCategory("category").notNull(),
    source: m25DenialSource("source").notNull(),
    state: m25DenialState("state").notNull().default("open"),
    closureOutcome: m25DenialClosureOutcome("closure_outcome"),
    assigneeMembershipId: uuid("assignee_membership_id"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    firstActionedAt: timestamp("first_actioned_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    dollarValue: numeric("dollar_value", { precision: 12, scale: 2 }).notNull(),
    agingBucketDays: smallint("aging_bucket_days").notNull().default(0),
    overridePayload: jsonb("override_payload"), // denylisted in audit (§3.6)
    taxonomyStatus: m25TaxonomyStatus("taxonomy_status").notNull(),
    // F-153/F-156 (#248) — the pre-835 seed idempotency key the two upstream consumers' own header
    // comment has always promised ("the 277CA seed dedupes on (claimId, source, UTC date); the EVV seed
    // on the aggregator submission id … the store enforces the dedupe") while no column or index ever
    // backed it — only non-unique indexes existed, so a redelivery or a dispatcher-tick race could
    // double-seed a row silently. NULL for every `remittance_adjustment`-sourced row (the existing WX-
    // PR-012 ingest path): that source is already naturally 1:1 with its `remittance_adjustment_id`
    // (one CAS adjustment posts at most once inside one transactional 835 post), so it needs no key here.
    // Populated only by the two pre-835 seed sources: `277ca:${claimId}:${utcDateOfOccurredAt}` /
    // `evv:${aggregatorSubmissionId}` — computed by the caller (not derived from `opened_at`, which is
    // insertion time, not the source event's `occurredAt`; a redelivery near a UTC midnight boundary
    // would otherwise evade the dedupe).
    sourceIdempotencyKey: varchar("source_idempotency_key", { length: 160 }),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    byAssignee: index("ix_denial_assignee").on(t.assigneeMembershipId, t.state),
    byClaim: index("ix_denial_claim").on(t.claimId).where(sql`claim_id IS NOT NULL`),
    byCarc: index("ix_denial_carc").on(t.carcCode),
    byAging: index("ix_denial_aging")
      .on(t.agingBucketDays, t.state)
      .where(sql`state IN ('open','in_progress','escalated')`),
    byProviderEntity: index("ix_denial_pe").on(t.providerEntityId, t.state),
    // F-153/F-156 (#248) — the real dedupe guard: one denial_case per (org, idempotency key), only for
    // rows that carry one. `.onConflictDoNothing()` against this (the `elevated-approvals.ts` grant() /
    // `report_definition_system_org_base_uq` precedent) makes a redelivery or a concurrent dispatcher-tick
    // race a genuine no-op re-select rather than a duplicate worklist row.
    bySourceIdempotencyKey: unique("denial_case_source_idempotency_key_uq").on(
      t.organizationId,
      t.sourceIdempotencyKey,
    ),
  }),
);

// ---- denial_case_assignment (assignee history) ----
export const denialCaseAssignment = pgTable(
  "denial_case_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    denialCaseId: uuid("denial_case_id")
      .notNull()
      .references(() => denialCase.id, { onDelete: "restrict" }),
    assignedToMembershipId: uuid("assigned_to_membership_id").notNull(),
    assignedByMembershipId: uuid("assigned_by_membership_id").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    unassignedAt: timestamp("unassigned_at", { withTimezone: true }),
    reason: text("reason"), // denylisted in audit (§3.6)
  },
  (t) => ({
    byCase: index("ix_assignment_case").on(t.denialCaseId, t.assignedAt),
  }),
);

// ---- denial_taxonomy_overlay (per-tenant overlay; strictly org-scoped, M25-F09) ----
export const denialTaxonomyOverlay = pgTable(
  "denial_taxonomy_overlay",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    carcCode: varchar("carc_code", { length: 8 }).notNull(),
    rarcCode: varchar("rarc_code", { length: 8 }), // nullable; CARC-only match
    plainLanguageOverride: text("plain_language_override"),
    suggestedAction: text("suggested_action").notNull(),
    ownerRole: m25TaxonomyOwnerRole("owner_role").notNull(),
    severity: m25TaxonomySeverity("severity").notNull(),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Per-org overlay uniqueness on (carc, rarc) pair
    byOrgCarcRarc: unique("ux_taxonomy_overlay_org_carc_rarc").on(
      t.organizationId,
      t.carcCode,
      t.rarcCode,
    ),
  }),
);
