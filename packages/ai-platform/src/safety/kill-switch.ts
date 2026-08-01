// @wardenx/ai-platform — §3.2.12 / W3 kill switch, the pure half (M32-T05).
//
// The switch that stops a capability for one tenant or for everyone, and the D16 demotion a SEV-1 kill
// drags behind it. Pure: no IO, no clock (the instant is an argument), no store. The Drizzle store, the
// §4.8 `ai:kill-switch-broadcast` cache and the service that sequences them live in
// `apps/backend/src/modules/32-ai-platform/safety`.
//
// ── THE ONE RULE EVERYTHING ELSE HANGS OFF: A KILL IS A DISJUNCTION ───────────────────────────────
//
// `ai_kill_switch_state` is M32's only mixed-scope table: `organization_id IS NULL` is a PLATFORM row,
// and a row carrying an org is that tenant's. For a given (org, capability) BOTH may exist, and the
// question "is this capability killed for this caller?" is `platformRow.active OR tenantRow.active` —
// never the more natural-looking "the most specific row wins".
//
// The specificity reading is the dangerous one and it fails in both directions:
//   · a tenant admin who deactivates their own tenant row would OVERRIDE a platform-wide SEV-1 kill
//     and resume dispatching a capability the AI Safety Owner stopped for patient-safety reasons;
//   · an AI Safety Owner lifting the platform kill after an incident would silently resume a
//     capability for a tenant that had independently paused it for a reason of their own.
// Both are the same bug: treating two INDEPENDENT decisions as one overridable value. `aiKillSwitchFor`
// therefore ORs them and names which row is the reason, so W3's refusal and §5.1.3's dashboard can say
// "platform-wide, SEV-1" rather than just "off".
//
// ── ATTRIBUTION IS THE ROW'S POINT ────────────────────────────────────────────────────────────────
//
// §3.2.12's `ai_kill_active_attributed` CHECK makes an ACTIVE row carry reason + actor kind + instant.
// These rules go further and refuse the two shapes the CHECK cannot see: a human actor kind with no
// membership id (an unattributed human stop that would be indistinguishable from a monitor's), and an
// `automated_*` kind carrying one (a machine trip wearing a person's name). Deactivation is guarded the
// same way, because §3.2.12 reuses the actor-kind enum on the way out and a lift is the write an
// auditor reads hardest.
import type {
  AiCapabilityLifecycleState,
  AiKillSwitchActorKind,
  AiKillSwitchReason,
  AiKillSwitchScope,
  AiKillSwitchSeverity,
} from "@wardenx/types";
import { AI_KILL_SWITCH_AUTOMATED_ACTOR_KINDS } from "@wardenx/types";

import { aiGovernanceRefusal, type AiGovernanceRefusal } from "../governance/errors";
import { aiSev1DemotionTarget } from "../lifecycle/state-machine";

/** True for the four `automated_*` kinds — the ones §3.2.12 allows with a NULL membership id. */
export function aiKillSwitchActorIsAutomated(kind: AiKillSwitchActorKind): boolean {
  return (AI_KILL_SWITCH_AUTOMATED_ACTOR_KINDS as readonly AiKillSwitchActorKind[]).includes(kind);
}

/** `organization_id IS NULL` ⇒ platform-wide. The one place the NULL is read as a scope. */
export function aiKillSwitchScopeOf(organizationId: string | null): AiKillSwitchScope {
  return organizationId === null ? "platform" : "tenant";
}

/**
 * The reasons that make a PLATFORM kill a SEV-1 rather than a SEV-2 (§4.9's alert severity).
 *
 * The three are the ones where the model produced or would produce clinical harm: a SEV-1 hallucination
 * report (D16), a prompt injection (the model is being driven by someone other than WardenX), and
 * severe bias drift (W7's red breach, which auto-kills). A cost cap or a vendor outage stops the same
 * capability just as completely and is deliberately NOT SEV-1 — paging the on-call clinical lead for a
 * billing threshold is how a SEV-1 page stops meaning anything.
 */
export const AI_KILL_SWITCH_SEV1_REASONS: readonly AiKillSwitchReason[] = [
  "sev1_hallucination",
  "prompt_injection_detected",
  "bias_drift_severe",
];

/**
 * §4.9's `severity` for an activation.
 *
 * TENANT SCOPE IS ITS OWN CLASS, not a demoted SEV. One agency pausing a capability for itself is a
 * routine tenant-admin action that pages nobody outside that agency; rendering it as `sev2` would put
 * every tenant's local caution into the platform incident channel.
 */
export function aiKillSwitchSeverityFor(
  scope: AiKillSwitchScope,
  reason: AiKillSwitchReason,
): AiKillSwitchSeverity {
  if (scope === "tenant") return "tenant";
  return AI_KILL_SWITCH_SEV1_REASONS.includes(reason) ? "sev1" : "sev2";
}

/** A `ai_kill_switch_state` row as the gate and the §5.1.3 dashboard read it. */
export interface AiKillSwitchRowSnapshot {
  readonly id: string;
  /** `null` = the platform row. */
  readonly organizationId: string | null;
  readonly capabilityId: string;
  readonly active: boolean;
  readonly reason: AiKillSwitchReason | null;
  readonly activationActorKind: AiKillSwitchActorKind | null;
  readonly activationActorMembershipId: string | null;
  readonly activationMessage: string | null;
  readonly activatedAt: string | null;
}

/** Whether a capability is killed for one caller, and — when it is — which row decided. */
export interface AiKillSwitchVerdict {
  readonly killed: boolean;
  /** The row that is stopping the call. `null` when nothing is. */
  readonly decidedBy: AiKillSwitchRowSnapshot | null;
  readonly scope: AiKillSwitchScope | null;
  readonly severity: AiKillSwitchSeverity | null;
}

/** `AiKillSwitchVerdict`'s not-killed value, so the negative arm has one construction point. */
export const AI_KILL_SWITCH_CLEAR: AiKillSwitchVerdict = {
  killed: false,
  decidedBy: null,
  scope: null,
  severity: null,
};

/**
 * Is this capability killed for this organization?
 *
 * The disjunction from the header. `rows` is every `ai_kill_switch_state` row for the capability that
 * the caller may see — which, under 0116's `ai_kill_switch_read` policy, is the platform row plus their
 * own; a row belonging to ANOTHER tenant is filtered here as well as by RLS, because a cache built
 * under `wardenx_admin` would otherwise let one agency's pause stop another agency's calls.
 *
 * The PLATFORM row is reported as the decider when both are active: the operator's first question about
 * a stopped capability is "is this just us?", and answering with the tenant row would say yes when a
 * platform-wide SEV-1 is running.
 */
export function aiKillSwitchFor(
  organizationId: string,
  rows: readonly AiKillSwitchRowSnapshot[],
): AiKillSwitchVerdict {
  const platform = rows.find((r) => r.organizationId === null && r.active) ?? null;
  const tenant = rows.find((r) => r.organizationId === organizationId && r.active) ?? null;
  const decidedBy = platform ?? tenant;
  if (decidedBy === null) return AI_KILL_SWITCH_CLEAR;
  const scope = aiKillSwitchScopeOf(decidedBy.organizationId);
  return {
    killed: true,
    decidedBy,
    scope,
    // `reason` cannot be NULL on an active row (the CHECK), but the column is nullable and a cache is
    // not the place to discover otherwise: an active row with no reason is still a kill.
    severity: decidedBy.reason === null ? null : aiKillSwitchSeverityFor(scope, decidedBy.reason),
  };
}

// ── activation / deactivation ──────────────────────────────────────────────────────────────────────

/** R7's request. `organizationId: null` is the platform-wide activation (see `requiresPlatformCredential`). */
export interface AiKillSwitchActivationRequest {
  readonly organizationId: string | null;
  readonly capabilityId: string;
  readonly reason: AiKillSwitchReason;
  readonly actorKind: AiKillSwitchActorKind;
  /** NULL for the `automated_*` kinds and REQUIRED for the human ones (see the header). */
  readonly actorMembershipId: string | null;
  /** The operator's own words. Required for a human actor. */
  readonly activationMessage: string | null;
}

/** The columns an accepted activation writes. */
export interface AiKillSwitchActivationPatch {
  readonly active: true;
  readonly reason: AiKillSwitchReason;
  readonly activationActorKind: AiKillSwitchActorKind;
  readonly activationActorMembershipId: string | null;
  readonly activationMessage: string | null;
  readonly activatedAt: string;
  /** Cleared: a re-activation must not carry the PREVIOUS incident's resolution narrative, which would
   *  read as though the new pause had already been explained away. */
  readonly deactivationActorKind: null;
  readonly deactivationActorMembershipId: null;
  readonly deactivationMessage: null;
  readonly deactivatedAt: null;
}

/** What a SEV-1 activation additionally demands of the capability (D16). */
export interface AiKillSwitchDemotionPlan {
  readonly required: boolean;
  /** `null` when there is nothing to demote (below APPROVED, or already DEPRECATED/RETIRED). */
  readonly toState: AiCapabilityLifecycleState | null;
  readonly rationaleText: string;
}

/** The activation gate's verdict. */
export type AiKillSwitchActivationDecision =
  | {
      readonly ok: true;
      readonly scope: AiKillSwitchScope;
      readonly severity: AiKillSwitchSeverity;
      readonly patch: AiKillSwitchActivationPatch;
      readonly demotion: AiKillSwitchDemotionPlan;
    }
  | AiGovernanceRefusal;

function attributionRefusal(
  actorKind: AiKillSwitchActorKind,
  membershipId: string | null,
  side: "activation" | "deactivation",
): AiGovernanceRefusal | null {
  const automated = aiKillSwitchActorIsAutomated(actorKind);
  if (automated && membershipId !== null) {
    return aiGovernanceRefusal(
      "AI_KILL_SWITCH_ACTOR_ATTRIBUTION_INVALID",
      `${side} actor kind '${actorKind}' is automated and must not name a membership; a machine trip wearing a person's name is not attribution`,
    );
  }
  if (!automated && (membershipId === null || membershipId.trim().length === 0)) {
    return aiGovernanceRefusal(
      "AI_KILL_SWITCH_ACTOR_ATTRIBUTION_INVALID",
      `${side} actor kind '${actorKind}' is a person and requires a membership id`,
    );
  }
  return null;
}

/**
 * D16 — what a kill implies for the capability's lifecycle.
 *
 * Only a SEV-1 PLATFORM kill demotes. A tenant-scoped pause must never move a platform-shared
 * governance state: one agency's caution is not a finding about the capability, and letting it demote
 * would take the capability away from every other tenant on the platform.
 */
export function aiKillSwitchDemotionPlanFor(
  severity: AiKillSwitchSeverity,
  lifecycleState: AiCapabilityLifecycleState,
  reason: AiKillSwitchReason,
): AiKillSwitchDemotionPlan {
  if (severity !== "sev1") {
    return { required: false, toState: null, rationaleText: "" };
  }
  const toState = aiSev1DemotionTarget(lifecycleState);
  return {
    required: toState !== null,
    toState,
    rationaleText:
      toState === null
        ? ""
        : `auto-deprecate following SEV-1 kill switch (${reason})`,
  };
}

/**
 * Does this activation have to run on the platform credential?
 *
 * Yes for every platform-wide row. 0116 splits `ai_kill_switch_state`'s policies by command precisely
 * so `wardenx_app` cannot INSERT a NULL-org row — without that split any tenant admin could mint a
 * platform-wide kill and stop a capability for every other agency. Stated here as a rule so the service
 * chooses the credential from the SCOPE rather than from which store method it happened to call.
 */
export function aiKillSwitchRequiresPlatformCredential(scope: AiKillSwitchScope): boolean {
  return scope === "platform";
}

/**
 * R7 / W3 — may this activation be written, and what does it drag with it?
 *
 * `current` is the existing row for the SAME scope (`null` when none exists yet); a platform activation
 * is not blocked by a tenant's own active row, and vice versa, because they are independent decisions.
 */
export function evaluateAiKillSwitchActivation(
  request: AiKillSwitchActivationRequest,
  current: AiKillSwitchRowSnapshot | null,
  lifecycleState: AiCapabilityLifecycleState,
  at: string,
): AiKillSwitchActivationDecision {
  if (current !== null && current.active) {
    return aiGovernanceRefusal(
      "AI_KILL_SWITCH_ALREADY_ACTIVE",
      `capability ${request.capabilityId} already has an active ${aiKillSwitchScopeOf(request.organizationId)} kill switch (activated ${current.activatedAt ?? "at an unrecorded instant"}); lift it before re-activating so the first incident's attribution survives`,
    );
  }

  const attribution = attributionRefusal(request.actorKind, request.actorMembershipId, "activation");
  if (attribution !== null) return attribution;

  const message = request.activationMessage?.trim() ?? "";
  if (!aiKillSwitchActorIsAutomated(request.actorKind) && message.length === 0) {
    return aiGovernanceRefusal(
      "AI_KILL_SWITCH_ACTIVATION_MESSAGE_REQUIRED",
      `a person activating a kill switch must say why in their own words; reason '${request.reason}' alone does not record it`,
    );
  }

  const scope = aiKillSwitchScopeOf(request.organizationId);
  const severity = aiKillSwitchSeverityFor(scope, request.reason);
  return {
    ok: true,
    scope,
    severity,
    patch: {
      active: true,
      reason: request.reason,
      activationActorKind: request.actorKind,
      activationActorMembershipId: request.actorMembershipId,
      activationMessage: message.length === 0 ? null : message,
      activatedAt: at,
      deactivationActorKind: null,
      deactivationActorMembershipId: null,
      deactivationMessage: null,
      deactivatedAt: null,
    },
    demotion: aiKillSwitchDemotionPlanFor(severity, lifecycleState, request.reason),
  };
}

/** R8's request — "requires resolution narrative". */
export interface AiKillSwitchDeactivationRequest {
  readonly organizationId: string | null;
  readonly capabilityId: string;
  readonly actorKind: AiKillSwitchActorKind;
  readonly actorMembershipId: string | null;
  readonly resolutionNarrative: string;
}

/** The columns an accepted deactivation writes. The activation half is left ALONE — the incident record
 *  of who stopped it and why is what a post-mortem reads, and clearing it on the lift would delete it. */
export interface AiKillSwitchDeactivationPatch {
  readonly active: false;
  readonly deactivationActorKind: AiKillSwitchActorKind;
  readonly deactivationActorMembershipId: string | null;
  readonly deactivationMessage: string;
  readonly deactivatedAt: string;
}

export type AiKillSwitchDeactivationDecision =
  | {
      readonly ok: true;
      readonly scope: AiKillSwitchScope;
      readonly patch: AiKillSwitchDeactivationPatch;
    }
  | AiGovernanceRefusal;

/**
 * R8 — lift the switch.
 *
 * NOTHING HERE UNDOES THE D16 DEMOTION. A SEV-1 kill demoted the capability to DEPRECATED through a
 * §2.2 lifecycle edge with its own signers and rationale; lifting the switch is an operations action and
 * cannot walk that edge backwards. W7 states the posture in one line — "the burden is to re-enable,
 * never to enable" — so a capability that was auto-deprecated stays deprecated until someone signs it
 * back up the FSM, and the lifted switch simply stops being the reason it refuses.
 */
export function evaluateAiKillSwitchDeactivation(
  request: AiKillSwitchDeactivationRequest,
  current: AiKillSwitchRowSnapshot | null,
  at: string,
): AiKillSwitchDeactivationDecision {
  if (current === null || !current.active) {
    return aiGovernanceRefusal(
      "AI_KILL_SWITCH_NOT_ACTIVE",
      `capability ${request.capabilityId} has no active ${aiKillSwitchScopeOf(request.organizationId)} kill switch to lift`,
    );
  }

  const attribution = attributionRefusal(
    request.actorKind,
    request.actorMembershipId,
    "deactivation",
  );
  if (attribution !== null) return attribution;

  const narrative = request.resolutionNarrative.trim();
  if (narrative.length === 0) {
    return aiGovernanceRefusal(
      "AI_KILL_SWITCH_RESOLUTION_REQUIRED",
      "R8 requires a resolution narrative: resuming a stopped clinical AI capability must state what was resolved",
    );
  }

  return {
    ok: true,
    scope: aiKillSwitchScopeOf(request.organizationId),
    patch: {
      active: false,
      deactivationActorKind: request.actorKind,
      deactivationActorMembershipId: request.actorMembershipId,
      deactivationMessage: narrative,
      deactivatedAt: at,
    },
  };
}
