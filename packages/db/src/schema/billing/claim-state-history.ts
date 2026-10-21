// @chartwarden/db — `claim_state_history` (M23 Billing-Medicare §3.3; retention class `compliance`).
// Append-only audit log of every `claim.state` transition (D4 lifecycle). `from_state` is NULL on the
// initial creation row; `to_state` is always present. ORG-SCOPED: organization_id NOT NULL (canonical
// app.org_id RLS).
//
// PARTITIONING (declared in the SQL migration 0074+, NOT in Drizzle — Drizzle only carries the
// columns/indexes/types): PARTITION BY LIST (organization_id) then sub-partition each org list by
// RANGE (at) MONTHLY (spec §3.2 Phase B / §3.3 header). The migration agent MUST emit the
// LIST→RANGE monthly partition DDL + register the table with M4's partition rotation manager
// (spec §3.2 Phase F). Drizzle's pgTable below is the logical shape only.
//
// CROSS-MODULE FK POLICY (architecture WINS over the spec DDL): cross-module FK constraints are
// FORBIDDEN. Only `organization_id` (core) and `claim_id` (intra-M23 parent) get real `.references(...)`.
// `actor_membership_id` (core memberships) and the transition-context pointers
// (validation_run_id/submission_id/acknowledgment_id intra-M23, remittance_advice_id M25) are LOGICAL
// FKs — plain uuid, validated at runtime (mirrors the M27 cost-report precedent + the M23 `claim.ts`
// treatment of latest_* pointers). No PHI / MBI is ever stored here (D13, §8.7).
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { claim } from "./claim";
import { m23ClaimState } from "./types";

export const claimStateHistory = pgTable(
  "claim_state_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claim.id, { onDelete: "restrict" }),

    fromState: m23ClaimState("from_state"), // NULL on initial creation
    toState: m23ClaimState("to_state").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorMembershipId: uuid("actor_membership_id"), // logical FK → memberships; NULL for system-driven transitions
    actorKind: text("actor_kind").notNull(), // 'user'|'system'|'consumer'|'worker'
    reason: text("reason"), // free-text marker on overrides / corrections

    // Transition-context FKs (populated per transition kind; logical FKs):
    validationRunId: uuid("validation_run_id"), // intra-M23 — set when transitioning out of VALIDATING
    submissionId: uuid("submission_id"), // intra-M23 — set when transitioning to/from SUBMITTED
    acknowledgmentId: uuid("acknowledgment_id"), // intra-M23 — set when transitioning to ACK_*
    remittanceAdviceId: uuid("remittance_advice_id"), // logical FK → M25 — set when transitioning to PAID/DENIED
  },
  (t) => ({
    claimAt: index("claim_state_history_claim_at_idx").on(t.claimId, t.at),
    orgAt: index("claim_state_history_org_at_idx").on(t.organizationId, t.at),
    // §3.4 — per-claim transition-timeline panel ("show me the timeline" newest-first):
    recentPerClaim: index("claim_state_history_recent_per_claim").on(t.claimId, t.at.desc()),
  }),
);

export type ClaimStateHistory = typeof claimStateHistory.$inferSelect;
export type NewClaimStateHistory = typeof claimStateHistory.$inferInsert;
