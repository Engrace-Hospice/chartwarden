// @chartwarden/ai-platform — §5.4 / AI Governance §10.3 per-clinician opt-out rules (M32-T03).
//
// The individual's refusal, sitting UNDER the tenant's opt-in and independent of it. Pure.
//
// ── FOUR PROPERTIES, EACH OF WHICH IS EASY TO GET BACKWARDS ────────────────────────────────────────
//
//  1. OPTING OUT DOES NOT REQUIRE THE TENANT TO HAVE OPTED IN. §10.6 makes withdrawal available "at any
//     time", and a clinician who states their position BEFORE their agency turns a capability on has
//     said something the platform must keep. Gating the write on the tenant's opt-in would mean the
//     day the agency flips the switch, that clinician's work silently starts running through the model
//     they already declined. The only capability-level gate is `clinician_opt_out_supported`.
//
//  2. A SECOND OPT-OUT IS A NO-OP, NOT A CONFLICT. §3.2.7's unique index is partial —
//     `WHERE opted_out = true AND reverted_at IS NULL` — so a duplicate insert is a constraint
//     violation, and there is no version of "you already opted out" that is useful to a clinician who
//     tapped a toggle twice. The rule reports `alreadyOptedOut` and the caller writes nothing.
//
//  3. REVERTING WRITES `reverted_at` ON THE LIVE ROW, IT NEVER DELETES IT. The history is the record
//     that explains why three months of that clinician's notes carry no AI provenance; the partial
//     index exists precisely so that history survives a revert-and-reopt-out cycle.
//
//  4. NEITHER DIRECTION TOUCHES WORK ALREADY DONE. §10.5: "previously generated AI outputs in chart
//     remain (with provenance marking them as AI-assisted from time when capability was active)". An
//     opt-out that retracted past outputs would be rewriting the chart, not expressing a preference.
import { type AiGovernanceRefusal, aiGovernanceRefusal } from "./errors";

/** The `ai_capability` columns the opt-out gate reads. */
export interface AiOptOutCapabilitySnapshot {
  readonly clinicianOptOutSupported: boolean;
}

/** The clinician's live `ai_clinician_opt_out` row for this capability, if any. */
export interface AiLiveClinicianOptOut {
  readonly id: string;
  readonly optedOutAt: string;
}

/** The `ai_clinician_opt_out` values a new opt-out implies. */
export interface AiClinicianOptOutPatch {
  readonly optedOut: true;
  readonly reason: string | null;
  readonly optedOutAt: string;
  readonly revertedAt: null;
}

export type AiClinicianOptOutDecision =
  | {
      readonly ok: true;
      /** True when a live opt-out already exists — the caller writes NOTHING (property 2). */
      readonly alreadyOptedOut: boolean;
      readonly patch: AiClinicianOptOutPatch | null;
    }
  | AiGovernanceRefusal;

/**
 * R13 / §5.4 — record a clinician's personal opt-out.
 *
 * A reason is accepted and never required: §10.6's "no questions asked" applies to the individual at
 * least as strongly as to the tenant, and a required free-text field on a refusal is a friction that
 * exists only to discourage the refusal.
 */
export function evaluateAiClinicianOptOut(
  capability: AiOptOutCapabilitySnapshot,
  live: AiLiveClinicianOptOut | null,
  reason: string | null,
  at: string,
): AiClinicianOptOutDecision {
  if (!capability.clinicianOptOutSupported) {
    return aiGovernanceRefusal(
      "AI_OPT_OUT_NOT_SUPPORTED",
      "this capability does not support a per-clinician opt-out (ai_capability.clinician_opt_out_supported)",
    );
  }
  if (live !== null) return { ok: true, alreadyOptedOut: true, patch: null };
  return {
    ok: true,
    alreadyOptedOut: false,
    patch: { optedOut: true, reason: reason?.trim() || null, optedOutAt: at, revertedAt: null },
  };
}

/** The `ai_clinician_opt_out` values a revert implies (property 3 — the row stays). */
export interface AiClinicianOptOutRevertPatch {
  readonly optOutId: string;
  readonly revertedAt: string;
}

/**
 * R14 / §5.4 — the clinician re-enables the capability for themselves.
 *
 * Refuses when there is nothing live to revert. This one IS a refusal rather than a no-op, because the
 * toggle's ON state is the default: a revert with no opt-out behind it means the client's view of the
 * clinician's preferences disagrees with the server's, and silently succeeding would leave the UI
 * showing a change that never happened.
 */
export function evaluateAiClinicianOptOutRevert(
  live: AiLiveClinicianOptOut | null,
  at: string,
): { readonly ok: true; readonly patch: AiClinicianOptOutRevertPatch } | AiGovernanceRefusal {
  if (live === null) {
    return aiGovernanceRefusal(
      "AI_OPT_OUT_NOT_FOUND",
      "the clinician has no live opt-out for this capability",
    );
  }
  return { ok: true, patch: { optOutId: live.id, revertedAt: at } };
}
