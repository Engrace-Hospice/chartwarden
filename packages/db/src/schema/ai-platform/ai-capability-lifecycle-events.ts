// @chartwarden/db — `ai_capability_lifecycle_event` (M32 §3.2.2). The append-only governance ledger: one
// row per D2 lifecycle transition, naming the gate that was passed, who signed it, and the rationale.
//
// PLATFORM-SHARED (§3.3): the transition is a fact about the CAPABILITY, not about any tenant, so there
// is no organization_id. Listed in check-tenancy.ts's NON_ORG_SCOPED set.
//
// APPEND-ONLY (§3.5): UPDATE and DELETE are both refused by the immutability trigger in migration 0116,
// and `chartwarden_app` is granted SELECT/INSERT only. This is the table an FDA inquiry or a deposition
// reads to answer "who approved this and on what evidence" — a correction is a NEW transition row, never
// an edit, because an edited approval is indistinguishable from an approval that never happened.
//
// `approval_kind` names the GATE, not the outcome (the M32-T01 reading): a stage-3 evaluation that
// REJECTS is still `stage_3_evaluation`, and the edge is keyed on the (from_state, to_state,
// approval_kind) TRIPLE — APPROVED→DEPRECATED is a different edge under `deprecation` than under
// `incident_demotion`. `packages/ai-platform`'s state machine is the authority on which triples are legal;
// this table records what actually happened.
//
// `from_state` is NULLABLE for exactly one row per capability — the initial arrival at PROPOSED, which
// has no predecessor. Making it NOT NULL would force the first row to invent a fictional prior state.
//
// `linked_evaluation_run_id` is a LOGICAL uuid rather than an FK to `ai_evaluation_run`: a deprecation or
// a manual demotion has no run, and the two tables are written by different actors in different
// transactions (the run completes asynchronously; the transition is a human signature).
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  aiCapabilityLifecycleState,
  aiCapabilityOwningRole,
  aiLifecycleApprovalKind,
} from "../../enums";
import { aiCapability } from "./ai-capabilities";

export const aiCapabilityLifecycleEvent = pgTable(
  "ai_capability_lifecycle_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => aiCapability.id, { onDelete: "restrict" }),

    /** NULL only on the initial arrival at PROPOSED (see header). */
    fromState: aiCapabilityLifecycleState("from_state"),
    toState: aiCapabilityLifecycleState("to_state").notNull(),

    /** Logical FK → M2 membership: the human who signed this gate. */
    actorMembershipId: uuid("actor_membership_id").notNull(),
    /** Constrained to the four accountable governance roles by the enum type itself. */
    actorRole: aiCapabilityOwningRole("actor_role").notNull(),
    approvalKind: aiLifecycleApprovalKind("approval_kind").notNull(),

    reason: text("reason").notNull(),
    /** The signer's own words. §3.4-denylisted out of the audit capture (it can quote evaluation PHI). */
    rationaleText: text("rationale_text").notNull(),

    /** Logical uuid → `ai_evaluation_run` (see header); absent on non-evaluation gates. */
    linkedEvaluationRunId: uuid("linked_evaluation_run_id"),
    /** Stage evidence pointers (MLflow refs, review minutes). §3.4-denylisted. */
    stageArtifacts: jsonb("stage_artifacts").notNull().default({}),

    transitionedAt: timestamp("transitioned_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    capabilityIdx: index("ai_cap_lifecycle_capability_idx").on(
      t.capabilityId,
      t.transitionedAt.desc(),
    ),
  }),
);

export type AiCapabilityLifecycleEventRow = typeof aiCapabilityLifecycleEvent.$inferSelect;
export type NewAiCapabilityLifecycleEventRow = typeof aiCapabilityLifecycleEvent.$inferInsert;
