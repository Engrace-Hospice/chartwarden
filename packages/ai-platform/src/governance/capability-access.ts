// @wardenx/ai-platform — the composed §2.2 + §5.3 + §5.4 access gate (M32-T03).
//
// Three of the SDK's gates, in one pure function: the lifecycle posture the registry publishes, the
// tenant's opt-in, and the clinician's opt-out. Every refusal is the §2.2/W9 `AiCapabilityUnavailable`
// envelope — the SAME shape the published seams return and `aiSdk.invoke` throws — so a consumer that
// falls back to its Layer-1 path never has to learn a second vocabulary.
//
// ── WHAT THIS FUNCTION IS NOT ──────────────────────────────────────────────────────────────────────
//
// It is NOT "may this call run". §4.1's SDK order is kill-switch → tenant opt-in → clinician opt-out →
// PHI minimisation → routing → dispatch, and this file owns only the middle two plus the lifecycle
// posture that precedes them. THREE further gates can turn an `allowed` here into a refusal:
//
//   · the kill switch (`ai_kill_switch_state`, W3) — M32-T05. It runs BEFORE this one and must,
//     because a SEV-1 platform-wide kill has to answer identically for every capability whether or not
//     the caller's tenant ever opted in; asking the opt-in question first would let the refusal reason
//     disclose which capabilities a tenant has.
//   · the hard token cap (`ai_token_ledger`, W2) — M32-T04.
//   · the Phase-1 `ai.full` flag — the whole wave ships as a capability shell, so even a capability
//     that passes every gate below still refuses with `phase_1_capability_shell` until Phase 2.
//
// Naming this function `aiCapabilityAvailable` would therefore have been a lie by omission; it is
// `aiGovernanceGateFor` because governance is exactly what it decides.
//
// ── THE ORDER OF THE THREE IS THE ORDER OF THE AUTHORITIES ─────────────────────────────────────────
//
// Lifecycle first (the platform's own governance — a RETIRED capability is not the tenant's decision
// to make), then the tenant (§10.1's default-off posture is the agency's), then the clinician (§10.3
// sits UNDER the tenant's by construction — "after tenant opts in, individual clinicians can opt
// out"). Evaluating the clinician first would tell a clinician at a non-opted-in agency that their
// personal preference was what stopped the call.
import type {
  AiCapabilityConsumerPosture,
  AiCapabilityLifecycleState,
  AiCapabilityUnavailable,
  AiTenantOptInStatus,
} from "@wardenx/types";

import { aiConsumerPostureFor } from "../lifecycle/state-machine";

/** Everything the governance gate needs about one (capability, org, clinician) triple. */
export interface AiGovernanceGateInput {
  readonly lifecycleState: AiCapabilityLifecycleState;
  /** §3.2.1 — `false` makes the capability available without a tenant decision (operational only). */
  readonly tenantOptInRequired: boolean;
  /** `null` when the org has no `ai_tenant_opt_in_record` row at all. */
  readonly tenantOptInStatus: AiTenantOptInStatus | null;
  /** §3.2.6 — needed for the §2.2 `pilot_tenants_only` posture, where an active opt-in is NOT enough. */
  readonly tenantPilotEnrollment: boolean;
  /** True when the clinician has a live `ai_clinician_opt_out` row (opted_out, not reverted). */
  readonly clinicianOptedOut: boolean;
}

/** Allowed, or the §2.2/W9 envelope saying why not. */
export type AiGovernanceGateDecision =
  | { readonly allowed: true; readonly posture: AiCapabilityConsumerPosture }
  | { readonly allowed: false; readonly unavailable: AiCapabilityUnavailable };

function deny(
  reason: AiCapabilityUnavailable["reason"],
  currentState?: AiCapabilityLifecycleState,
): AiGovernanceGateDecision {
  return {
    allowed: false,
    unavailable: {
      status: "capability_unavailable",
      reason,
      // `currentState` rides ONLY the lifecycle refusals (§2.2/W9): a caller refused for an opt-out has
      // no business learning the platform's governance state for a capability.
      ...(currentState === undefined ? {} : { currentState }),
    },
  };
}

/**
 * Evaluate the lifecycle + tenant-opt-in + clinician-opt-out gates. Pure; fails CLOSED at every step.
 *
 * Read `allowed: true` as "governance does not object", never as "the capability is on" — see the
 * three gates the header lists that this function deliberately does not apply.
 */
export function aiGovernanceGateFor(input: AiGovernanceGateInput): AiGovernanceGateDecision {
  const posture = aiConsumerPostureFor(input.lifecycleState);

  if (posture.kind === "unavailable") {
    return deny(posture.reason, input.lifecycleState);
  }

  const active = input.tenantOptInStatus === "active";

  if (posture.kind === "pilot_tenants_only") {
    // §2.2 verbatim: `status='active' AND pilot_enrollment=true`. A plain active opt-in is not enough,
    // and the refusal names the pilot requirement rather than the generic "not opted in" — a tenant
    // admin looking at an active opt-in that still refuses needs to be told which half is missing.
    if (!active || !input.tenantPilotEnrollment) {
      return deny("not_enrolled_as_pilot_tenant", input.lifecycleState);
    }
  } else if (input.tenantOptInRequired && !active) {
    // Covers `generally_available` and `existing_opt_ins_only` alike. DEPRECATED is deliberately NOT a
    // refusal for a tenant already `active`: D16 demotes to DEPRECATED precisely so in-flight use and
    // history survive while re-activation is foreclosed, and that foreclosure is enforced at the
    // OPT-IN (`aiTenantOptInOfferable`), not here. `paused` refuses like any non-active status.
    return deny("tenant_not_opted_in");
  }

  if (input.clinicianOptedOut) {
    return deny("clinician_opted_out");
  }

  return { allowed: true, posture };
}
