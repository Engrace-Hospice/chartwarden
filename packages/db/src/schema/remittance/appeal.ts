import { sql } from "drizzle-orm";
// @chartwarden/db — M25 Remittance & Denials §3.3 — the Medicare appeal cluster:
//   appeal_case (five-tier hierarchy: redetermination → reconsideration → alj → council →
//     federal_court) ─ appeal_case_event (lifecycle history)
//
// NON-partitioned. organization_id NOT NULL on both — appeal_case_event carries organization_id (added
// beyond the spec §3.3 column list: canonical app.org_id RLS / three-column rule WINS over the spec
// proposal). The closed-row immutability + tier-deadline INSERT trigger + the `appeal_within_deadline`
// hard block on submit land in the SQL migration / service layer, not Drizzle (§2.2, §2.3, D6/D7).
//
// CROSS-MODULE FK POLICY: only organization_id → organizations and the intra-M25 parents
// (appeal_case.denial_case_id → denial_case; appeal_case_event.appeal_case_id → appeal_case) are real
// FKs. claim_id (M23), appeal_packet_document_id (M22), prior_tier_appeal_case_id (self, logical to
// avoid a self-FK ordering constraint), actor_membership_id (core) are LOGICAL uuid FKs.
// appeal_narrative / mac_reference_numbers / event_payload are audit-denylisted (§3.6).
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
import {
  m25AppealDecisionOutcome,
  m25AppealEventKind,
  m25AppealState,
  m25AppealTier,
} from "./enums";

// ---- appeal_case ----
export const appealCase = pgTable(
  "appeal_case",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK → M40/M2
    denialCaseId: uuid("denial_case_id")
      .notNull()
      .references(() => denialCase.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id").notNull(), // denormalized from denial_case for indexing; M23 logical FK
    priorTierAppealCaseId: uuid("prior_tier_appeal_case_id"), // null for first tier (logical self-FK)
    tier: m25AppealTier("tier").notNull(),
    state: m25AppealState("state").notNull().default("draft"),
    decisionOutcome: m25AppealDecisionOutcome("decision_outcome"),
    tierDeadlineAt: timestamp("tier_deadline_at", { withTimezone: true }).notNull(),
    // The date printed on the notice this tier's clock runs from (remittance advice / prior decision
    // letter). The deadline is derived from it (receipt presumed 5 days later); NULL on rows created before
    // CMS-correct deadlines, whose stored tier_deadline_at is left as it was.
    noticeDatedOn: date("notice_dated_on"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    appealPacketDocumentId: uuid("appeal_packet_document_id"), // M22 back-ref
    appealNarrative: jsonb("appeal_narrative"), // denylisted in audit (§3.6)
    macReferenceNumbers: jsonb("mac_reference_numbers"),
    // Milestone 4 (migration 1117) - QIC reconsideration only (CHECK-guarded: NULL / default on every other tier).
    // The documentation the redetermination notice named as missing (audit-scrubbed), or the attestation it named none.
    citedEvidence: jsonb("cited_evidence"),
    citedEvidenceNone: boolean("cited_evidence_none").notNull().default(false),
    // The date the QIC received the request; its 60-day decision clock is derived from it on read.
    qicReceivedOn: date("qic_received_on"),
    qicClockExtensions: jsonb("qic_clock_extensions").notNull().default([]), // append-only [{days, recordedAt}]
    // The OMHA escalation request (made outside WardenX), frozen once recorded, and the date the QIC forwarded the case.
    escalationRequestedAt: timestamp("escalation_requested_at", { withTimezone: true }),
    escalationChannel: text("escalation_channel"),
    escalationConfirmationRef: text("escalation_confirmation_ref"), // audit-scrubbed
    escalationConfirmedOn: date("escalation_confirmed_on"),
    // True on the ALJ case an escalation opens (filed by the QIC's forwarding: no filing deadline of its own).
    filedByEscalation: boolean("filed_by_escalation").notNull().default(false),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDenialCase: index("ix_appeal_denial").on(t.denialCaseId),
    byClaim: index("ix_appeal_claim").on(t.claimId),
    byDeadline: index("ix_appeal_deadline")
      .on(t.tierDeadlineAt, t.state)
      .where(sql`state IN ('draft','submitted','under_review')`),
    byTier: index("ix_appeal_tier").on(t.tier, t.state),
  }),
);

// ---- appeal_case_event ----
export const appealCaseEvent = pgTable(
  "appeal_case_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    appealCaseId: uuid("appeal_case_id")
      .notNull()
      .references(() => appealCase.id, { onDelete: "restrict" }),
    eventKind: m25AppealEventKind("event_kind").notNull(),
    eventPayload: jsonb("event_payload"), // denylisted free-text columns (§3.6)
    actorMembershipId: uuid("actor_membership_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCase: index("ix_appeal_event_case").on(t.appealCaseId, t.occurredAt),
  }),
);
