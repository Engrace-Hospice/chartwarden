// @wardenx/ai-platform — the §6 / §4.1 SDK gate sequence (M32-T04).
//
// ONE PURE FUNCTION OWNS THE ORDER. Every gate that can refuse an `aiSdk.invoke` is evaluated here, in
// the order the spec numbers them, over facts the service has already resolved. The service short-
// circuits its IO (it does not sum a token ledger for a call the flag already refused) but it cannot
// DISAGREE with this function about which gate wins — there is a test that runs the pure evaluator with
// every gate failing at once and asserts which reason comes out.
//
// That matters because the reported reason is not cosmetic: it is what the consumer module logs, what
// the tenant admin reads on the §5.3.1 board, and — for the two gates that emit — which M36 alert
// fires. A pipeline where the order lived in the sequence of `await`s would drift the first time
// someone reordered two lookups for latency.
//
// ── THE ORDER, AND WHY EACH POSITION IS WHERE IT IS ────────────────────────────────────────────────
//
//   0. `ai.full`             — the WAVE's gate, ahead of §6's list. The platform-wide posture: with the
//                              flag off, WardenX runs no AI at all. It precedes everything for the same
//                              non-disclosure reason the kill switch precedes the consent gates — a
//                              caller must not learn a tenant's opt-in state, or a capability's
//                              governance state, from a platform that is not running AI in the first
//                              place. It is also the only refusal that writes NO ledger row (see
//                              `aiInvocationGateRecordsLedgerRow`).
//   1. lifecycle state       — §6.1. Platform governance; not the tenant's decision to make. Discloses
//                              nothing tenant-specific, which is why it may precede the kill switch.
//   2. kill switch           — §6.2. A SEV-1 platform-wide kill must answer identically for every
//                              tenant whether or not they ever opted in; asking the opt-in question
//                              first would let the refusal reason enumerate a tenant's capabilities.
//   3. tenant opt-in         — §6.3 / §10.1's default-off posture. The agency's decision.
//   4. clinician opt-out     — §6.4 / §10.3, which sits UNDER the tenant's by construction ("after the
//                              tenant opts in, individual clinicians can opt out"). Evaluating it first
//                              would tell a clinician at a non-opted-in agency that their own
//                              preference was what stopped the call.
//   5. token cap             — §6.5 / D7. Last of §6's five: a cost guardrail must not pre-empt a
//                              safety or consent refusal, because the operator's response to the two is
//                              different and the more serious one has to be the one that surfaces.
//   6. PHI minimisation      — §4.1 / §8.3. After the five, before routing: it is the last thing that
//                              can refuse WITHOUT consulting the backend registry, and running it
//                              before the consent gates would mean parsing a caller's chart context for
//                              a capability the tenant never authorised.
//   7. routing               — §4.1. Nothing dispatches without a healthy, permitted backend.
//
// Gates 1, 3 and 4 are `aiGovernanceGateFor`'s (M32-T03) and are NOT re-implemented here; this file
// calls it, having already taken gate 1 on its own so gate 2 can be interleaved at §6's position.
import type { AiCapabilityUnavailable, AiCapabilityUnavailableReason } from "@wardenx/types";

import { aiGovernanceGateFor, type AiGovernanceGateInput } from "../governance/capability-access";
import { aiConsumerPostureFor } from "../lifecycle/state-machine";
import type { AiResolvedRoute, AiRouteResolution } from "./routing";
import { aiTokenCapRefuses, type AiTokenCapState } from "./token-cap";

/** Which gate decided. The ledger's `error_class` and the operator's first question. */
export type AiInvocationGate =
  | "ai_full_flag"
  | "lifecycle"
  | "kill_switch"
  | "tenant_opt_in"
  | "clinician_opt_out"
  | "token_cap"
  | "phi_minimization"
  | "routing";

/** The caller's chart context, already checked against the capability's §8.3 schema. */
export interface AiPhiMinimizationVerdict {
  readonly permitted: boolean;
  /** Operator-facing. Field NAMES only — never a field VALUE, which is the PHI this gate rejected. */
  readonly detail: string;
}

/** Everything the gate sequence decides over. */
export interface AiInvocationGateFacts extends AiGovernanceGateInput {
  /** The wave's Phase-1 posture (`ai.full`). A flag read that failed must arrive here as `false`. */
  readonly aiFullEnabled: boolean;
  /** §3.2.12 — M32-T05 owns the store; T04 owns this position in the order. */
  readonly killSwitchActive: boolean;
  readonly tokenCapState: AiTokenCapState;
  readonly phiMinimization: AiPhiMinimizationVerdict;
  readonly route: AiRouteResolution;
}

/** Dispatch, or the §2.2/W9 envelope plus the operator-facing extras the ledger row needs. */
export type AiInvocationGateDecision =
  | { readonly dispatch: true; readonly route: AiResolvedRoute }
  | {
      readonly dispatch: false;
      readonly gate: AiInvocationGate;
      readonly unavailable: AiCapabilityUnavailable;
      /** Safe to log and safe to store: never PHI, never a governance state a consumer may not see. */
      readonly detail: string;
      /** What `ai_invocation` names for this refusal; `null` when no truthful route exists. */
      readonly ledgerRoute: AiResolvedRoute | null;
    };

/**
 * Does a refusal at this gate write the §164.528 `ai_invocation` row?
 *
 * Every gate except `ai_full_flag`. W2.4 and W9.3 both require the row for a refused call, because a
 * gate refusal is itself the evidence that no PHI left the platform and only a written row proves a
 * negative.
 *
 * `ai.full` is the exception, and deliberately: the flag is a DEPLOYMENT POSTURE, not a decision about
 * a tenant, a patient or a capability. No governance evaluation happened, no vendor was selected, and
 * the fact it records ("AI was switched off") is a platform-level one already evidenced once by the
 * flag store — where a `compliance`-retention row per consumer poll, for seven years, across every
 * capability M8/M14/M16/M19/M22/M25 probe, would bury the rows that document real disclosures under
 * rows that document a config value.
 */
export function aiInvocationGateRecordsLedgerRow(gate: AiInvocationGate): boolean {
  return gate !== "ai_full_flag";
}

function deny(
  gate: AiInvocationGate,
  reason: AiCapabilityUnavailableReason,
  detail: string,
  ledgerRoute: AiResolvedRoute | null,
  unavailable?: AiCapabilityUnavailable,
): AiInvocationGateDecision {
  return {
    dispatch: false,
    gate,
    unavailable: unavailable ?? { status: "capability_unavailable", reason },
    detail,
    ledgerRoute,
  };
}

/**
 * Run the gates in §6/§4.1 order and return the first refusal, or the route to dispatch to.
 *
 * Pure and total: no throw, no clock, no IO. The `route` fact is resolved by the caller even for calls
 * that will be refused — resolving a route is reading the registry, not choosing to use it, and it is
 * what lets a refused call name the backend it was aimed at in the disclosure ledger.
 */
export function evaluateAiInvocationGates(
  facts: AiInvocationGateFacts,
): AiInvocationGateDecision {
  const ledgerRoute = facts.route.ledgerRoute;

  // 0 — the wave's platform posture.
  if (!facts.aiFullEnabled) {
    return deny(
      "ai_full_flag",
      "phase_1_capability_shell",
      "the 'ai.full' feature flag is off; WardenX dispatches no AI in Phase 1",
      null,
    );
  }

  // 1 — capability lifecycle (§6.1). Taken separately from `aiGovernanceGateFor` so gate 2 can sit at
  // its §6 position; the composed gate re-evaluates it below, which is idempotent and free.
  const posture = aiConsumerPostureFor(facts.lifecycleState);
  if (posture.kind === "unavailable") {
    return deny(
      "lifecycle",
      posture.reason,
      `capability lifecycle state '${facts.lifecycleState}' does not serve consumers`,
      ledgerRoute,
      {
        status: "capability_unavailable",
        reason: posture.reason,
        // §2.2/W9: `currentState` rides the LIFECYCLE refusal and no other.
        currentState: facts.lifecycleState,
      },
    );
  }

  // 2 — kill switch (§6.2).
  if (facts.killSwitchActive) {
    return deny(
      "kill_switch",
      "kill_switch_active",
      "a kill switch is active for this capability",
      ledgerRoute,
    );
  }

  // 3 + 4 — tenant opt-in and clinician opt-out (§6.3, §6.4), via M32-T03's composed gate.
  const governance = aiGovernanceGateFor(facts);
  if (!governance.allowed) {
    const reason = governance.unavailable.reason;
    const gate: AiInvocationGate = reason === "clinician_opted_out" ? "clinician_opt_out" : "tenant_opt_in";
    return deny(gate, reason, `governance gate refused: ${reason}`, ledgerRoute, governance.unavailable);
  }

  // 5 — token cap (§6.5 / D7).
  if (aiTokenCapRefuses(facts.tokenCapState)) {
    return deny(
      "token_cap",
      "token_hard_cap_reached",
      facts.tokenCapState === "budget_unconfigured"
        ? "no monthly token budget is configured for this organization and capability"
        : "the monthly hard token cap has been reached",
      // D7's whole point is that the cap fallback must be tellable from a vendor outage in the ledger,
      // and §3.1 adds `cost_cap_fallback` for exactly that. The row names the backend the call was
      // aimed at, with the reason that stopped it.
      ledgerRoute === null ? null : { ...ledgerRoute, reason: "cost_cap_fallback" },
    );
  }

  // 6 — PHI minimisation (§4.1 / §8.3).
  if (!facts.phiMinimization.permitted) {
    return deny(
      "phi_minimization",
      "phi_minimization_failure",
      facts.phiMinimization.detail,
      ledgerRoute,
    );
  }

  // 7 — routing (§4.1 / W8).
  if (facts.route.servable === null) {
    return deny(
      "routing",
      "backend_unhealthy",
      facts.route.refusal?.detail ?? "no backend is available to serve this capability",
      ledgerRoute,
    );
  }

  return { dispatch: true, route: facts.route.servable };
}
