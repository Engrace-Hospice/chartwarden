// @chartwarden/ai-platform — the shape EVERY §4.2 published seam shares (M32-T06).
//
// ── ABSENCE IS A VALUE, NOT AN EXCEPTION ─────────────────────────────────────────────────────────
//
// §4.2.1 states it for the whole family: "this seam never throws to indicate AI absence — absence is a
// first-class result, not an error". That is not a stylistic preference. Every consumer of these seams
// (M8's encounter finalize, M22's extraction pipeline, M19's 2 a.m. intake path) has a Layer-1 path it
// must fall back to, and a thrown deny-stub makes falling back conditional on somebody remembering a
// try/catch — the M20-T01 finding, and the reason M19's own `TriageAiUnavailableReason` is a discriminated
// union rather than a null.
//
// ── THE REFUSAL ENVELOPE IS `AiCapabilityUnavailable`, NOT §4.2's SIX-VALUE `reason` UNION ───────
//
// §4.2's interface sketches spell the refusal inline as
// `{ available: false; reason: 'unavailable' | 'kill_switch' | ... ; detail?: string }`. M32-T01 already
// resolved that into `AiCapabilityUnavailable` in `@chartwarden/types` — "the §2.2/W9 envelope EVERY M32
// published seam returns instead of throwing when a gate refuses" — with a strictly finer reason union
// (`lifecycle_state_below_approved` and `lifecycle_state_retired` split §4.2's flat `'unavailable'`,
// `not_enrolled_as_pilot_tenant` splits its `'tenant_opt_out'`). The finer union is what the M32-T04
// invocation pipeline already returns, so using it here means a seam hands its caller EXACTLY the gate
// decision the pipeline made rather than a lossy re-encoding of it. §4.2's six values are all reachable;
// none is lost.
//
// `detail` is kept, verbatim from §4.2, and its contract is kept too: operator-facing, safe to log,
// NEVER PHI. It is the only field that distinguishes "M32 is not wired" from "M32 is wired and Phase-1
// off" once both have collapsed to the same refusal reason at the consumer.
import type { AiCapabilityUnavailable, AiCapabilityUnavailableReason } from "@chartwarden/types";

/**
 * §4.2.1's advisory warning band. Rides an AVAILABLE answer — a warning is a caveat on a result, never
 * a substitute for one; a call with nothing to return refuses instead.
 */
export interface AIWarning {
  readonly code:
    | "high_uncertainty"
    | "phi_redacted_in_response"
    | "partial_context"
    | "model_fallback_used";
  readonly message: string;
}

/** The refused arm every §4.2 seam result union carries. See the header for why it is this envelope. */
export interface AiSeamRefusal {
  readonly available: false;
  readonly unavailable: AiCapabilityUnavailable;
  /** Operator-facing; never PHI. */
  readonly detail?: string;
}

/** Build a refusal without repeating the envelope at forty call sites. */
export function aiSeamRefusal(
  reason: AiCapabilityUnavailableReason,
  detail?: string,
): AiSeamRefusal {
  return {
    available: false,
    unavailable: { status: "capability_unavailable", reason },
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * The refusal a boot deny-stub answers: M32 registered NOTHING under this seam name.
 *
 * DISTINCT from `phase_1_capability_shell` on purpose. In Phase 1 the two are behaviourally identical —
 * both mean no model runs — but they stop being identical the moment Phase 2 flips `ai.full` on: then
 * `phase_1_capability_shell` becomes unreachable and this one means a boot that forgot to wire M32. A
 * deny-stub that answered `phase_1_capability_shell` forever would report a wiring fault as a policy
 * decision, and the operator would go read the flag table instead of the boot log.
 */
export function aiSeamUnregistered(seamName: string): AiSeamRefusal {
  return aiSeamRefusal(
    "provider_unregistered",
    `no M32 implementation is registered for '${seamName}'; the fail-closed deny-stub answered`,
  );
}
