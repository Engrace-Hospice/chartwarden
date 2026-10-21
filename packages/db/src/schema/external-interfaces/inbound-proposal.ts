// @chartwarden/db — `hl7_inbound_proposal` (M29 §3.3). A low-confidence ADT event staged as a PROPOSAL: M29
// never writes an M5 patient or an M6 admission itself — it stages the parsed candidate and an M5/M6
// reviewer accepts (apply through the owner module) or rejects (§2.2 propose-then-review, W-XI-01..04).
//
// MONTHLY PARTITIONED BY RANGE (`proposed_at`); the composite PK `(id, proposed_at)` is declared in SQL
// (0147), so `id` is Drizzle-`.primaryKey()` for type inference only. RLS + the GENERATED write-audit
// trigger are on the PARTITIONED PARENT and propagate to every partition.
//
// §3.6 DENYLIST: `proposed_patient_candidate` carries the parsed PID demographic candidate (PHI) —
// denylisted from the audit value_capture and captured by its hash digest; the §3.7 eraser re-encrypts it
// to null while the row's status / decision / timestamps survive as §164.528 evidence. What stays OFF the
// list is deliberate: `proposal_status`, `match_outcome`, `decided_by_membership_id` and the rationale are
// exactly what a disclosure accounting reads.
//
// FK POLICY (architecture §25.15): `source_message_id` references the PARTITIONED `hl7_message_inbound`
// (no DB FK to a partitioned parent — app-side, §3.5), and `matched_patient_id` / `match_candidate_ids` /
// `decided_by_membership_id` / `accepted_aggregate_id` are LOGICAL uuids validated at the write boundary.
// `owner_module` is a `text` column validated against the `Hl7ProposalOwnerModule` union ('m5' | 'm6').
import { index, jsonb, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { hl7InboundMatchOutcome, hl7InboundProposalKind, hl7InboundProposalStatus } from "./enums";

export const hl7InboundProposal = pgTable(
  "hl7_inbound_proposal",
  {
    // Composite PK (id, proposed_at) declared in SQL (0147).
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    /** app-side ref → partitioned `hl7_message_inbound` (§3.5 cross-partition note). */
    sourceMessageId: uuid("source_message_id").notNull(),
    resourceKind: hl7InboundProposalKind("resource_kind").notNull(),
    /** Parsed PID demographics — §3.6-denylisted, re-encrypted to null by the §3.7 eraser. */
    proposedPatientCandidate: jsonb("proposed_patient_candidate").notNull(),
    matchOutcome: hl7InboundMatchOutcome("match_outcome").notNull(),
    matchedPatientId: uuid("matched_patient_id"),
    matchConfidence: numeric("match_confidence", { precision: 4, scale: 3 }),
    matchCandidateIds: jsonb("match_candidate_ids").notNull().default([]).$type<string[]>(),
    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(), // PARTITION KEY
    /** 'm5' (demographic update) | 'm6' (admission/discharge/cancel) — the apply owner on accept (§4.1.2). */
    ownerModule: text("owner_module").notNull().default("m5"),
    proposalStatus: hl7InboundProposalStatus("proposal_status").notNull().default("pending"),
    decidedByMembershipId: uuid("decided_by_membership_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** ≥40 chars on reject (W-XI-04). */
    decisionRationale: text("decision_rationale"),
    acceptedAggregateId: uuid("accepted_aggregate_id"),
    validationErrors: jsonb("validation_errors"),
    /** proposed_at + tenant review-SLA hours (default 72h, W-XI-04 SLA-watch expiry scan). */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    orgStatusIdx: index("idx_hip_org_status").on(t.organizationId, t.proposalStatus),
    expiresIdx: index("idx_hip_expires").on(t.expiresAt),
    matchedPatientIdx: index("idx_hip_matched_patient").on(t.matchedPatientId),
  }),
);

export type Hl7InboundProposalRow = typeof hl7InboundProposal.$inferSelect;
export type NewHl7InboundProposalRow = typeof hl7InboundProposal.$inferInsert;
