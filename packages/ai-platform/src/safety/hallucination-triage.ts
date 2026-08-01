// @wardenx/ai-platform — §3.2.10 / D9 / W5 hallucination report → triage → follow-up (M32-T05).
//
// The clinician's "the model made that up" and everything it sets in motion. Pure; the store, the
// §4.8 `ai:hallucination-triage-followup` worker and the M36 alert publish live in
// `apps/backend/src/modules/32-ai-platform/safety`.
//
// ── THE FOLLOW-UP IS COMPUTED HERE, NOT CHOSEN AT THE ROUTE ───────────────────────────────────────
//
// W5.5 has the AI Safety Owner triage with a `follow_up_action`, which reads like a free choice. It is
// not one: `model_rollback_required` means the model is producing clinical harm, and a triage that
// recorded that disposition while selecting "notify the clinical lead" would be a governance record
// that contradicts itself. So the disposition DETERMINES the action, and the caller supplies the
// disposition — the judgement — rather than the consequence. The one place a human choice survives is
// escalation to the clinical-safety committee, which is a STATUS (`escalated_to_clinical_safety`), not
// a disposition, and is available from every open status.
//
// ── `critical` IS A FILING-TIME TRIGGER, NOT A TRIAGE-TIME ONE ────────────────────────────────────
//
// §3.1's enum makes `critical` "the D16 SEV-1 trigger: platform-wide kill + automatic demotion to
// DEPRECATED within 60 seconds". Sixty seconds is not a triage queue — a human has not looked at the
// report yet. So `evaluateAiHallucinationFiling` returns the SEV-1 plan at INSERT time for a critical
// report, and triage later confirms or unwinds it. The alternative (waiting for triage) would mean the
// stated 60-second guarantee depended on how quickly someone opened a queue.
//
// The cost is real and stated: a mis-severity'd report auto-kills a capability platform-wide. That is
// the direction D16 chose deliberately, and W7 states the posture for the whole module — the burden is
// to re-enable, never to enable.
//
// ── D9'S MACHINE HAS TWO TERMINALS, AND THEY MEAN DIFFERENT THINGS ────────────────────────────────
//
// `closed` is M32's own resolution. `escalated_to_clinical_safety` is terminal FOR M32 and OPEN for the
// clinical-safety committee (§3.1's enum says so in as many words) — the report has left this module's
// queue, and M32 must not later close something it no longer owns.
import type {
  AiHallucinationFollowUpAction,
  AiHallucinationKind,
  AiHallucinationSeverity,
  AiHallucinationTriageDisposition,
  AiHallucinationTriageStatus,
  AiKillSwitchReason,
} from "@wardenx/types";

import { aiGovernanceRefusal, type AiGovernanceRefusal } from "../governance/errors";

/** One edge of D9's triage machine. */
export interface AiHallucinationTriageEdge {
  readonly fromStatus: AiHallucinationTriageStatus;
  readonly toStatus: AiHallucinationTriageStatus;
  /** True when `triage_disposition` must be non-NULL to reach `toStatus` (§3.2.10's CHECK vocabulary). */
  readonly requiresDisposition: boolean;
}

/**
 * D9's queue, as edges.
 *
 * `open → closed` is DELIBERATELY ABSENT even though a false alarm is closable in one step in spirit:
 * §3.2.10's `openTriageIdx` covers `open` and `investigating`, and closing straight out of `open` means
 * a report left the queue without anyone recording that they looked. `open → investigating → closed`
 * costs one extra write and leaves a triage owner on the row.
 */
export const AI_HALLUCINATION_TRIAGE_EDGES: readonly AiHallucinationTriageEdge[] = [
  { fromStatus: "open", toStatus: "investigating", requiresDisposition: false },
  { fromStatus: "open", toStatus: "escalated_to_clinical_safety", requiresDisposition: false },
  { fromStatus: "investigating", toStatus: "root_cause_identified", requiresDisposition: true },
  { fromStatus: "investigating", toStatus: "closed", requiresDisposition: true },
  {
    fromStatus: "investigating",
    toStatus: "escalated_to_clinical_safety",
    requiresDisposition: false,
  },
  { fromStatus: "root_cause_identified", toStatus: "mitigated", requiresDisposition: true },
  {
    fromStatus: "root_cause_identified",
    toStatus: "escalated_to_clinical_safety",
    requiresDisposition: false,
  },
  { fromStatus: "mitigated", toStatus: "closed", requiresDisposition: true },
];

/** The statuses no edge leaves. Both are terminal FOR M32; only one is resolved (see the header). */
export const AI_HALLUCINATION_TERMINAL_STATUSES: readonly AiHallucinationTriageStatus[] = [
  "closed",
  "escalated_to_clinical_safety",
];

/** True when no D9 edge leaves this status. */
export function aiHallucinationStatusIsTerminal(status: AiHallucinationTriageStatus): boolean {
  return AI_HALLUCINATION_TERMINAL_STATUSES.includes(status);
}

/** The edge for a (from, to) pair, or `null` when D9 has none. Fails CLOSED. */
export function aiHallucinationTriageEdge(
  from: AiHallucinationTriageStatus,
  to: AiHallucinationTriageStatus,
): AiHallucinationTriageEdge | null {
  return (
    AI_HALLUCINATION_TRIAGE_EDGES.find((e) => e.fromStatus === from && e.toStatus === to) ?? null
  );
}

/**
 * The disposition → follow-up mapping (see the header for why it is a mapping and not a choice).
 *
 * `prompt_iteration_required` notifies rather than deprecates: a prompt that needs iterating is a
 * defect in WardenX's own artifact, fixable by publishing a new template version through R30 — and
 * deprecating the capability for a fault we control would take a clinically-useful tool away from every
 * tenant to fix a file in our repo.
 */
export function aiHallucinationFollowUpFor(
  disposition: AiHallucinationTriageDisposition,
): AiHallucinationFollowUpAction {
  switch (disposition) {
    case "model_rollback_required":
      return "deprecate_capability";
    case "prompt_iteration_required":
      return "notify_clinical_lead";
    case "edge_case_acknowledged":
    case "false_alarm":
      return "none";
  }
}

/** What the `ai:hallucination-triage-followup` job has to do. */
export interface AiHallucinationFollowUpPlan {
  readonly action: AiHallucinationFollowUpAction;
  /** Present when the action activates a kill switch; `null` otherwise. Always PLATFORM-scoped: a
   *  fabrication is a property of the model, and stopping it only for the agency that happened to
   *  notice would leave every other tenant exposed to the same output. */
  readonly killSwitchReason: AiKillSwitchReason | null;
  /** True when the follow-up demotes the capability through the §2.2 FSM (D16). */
  readonly demotesCapability: boolean;
}

const NO_FOLLOW_UP: AiHallucinationFollowUpPlan = {
  action: "none",
  killSwitchReason: null,
  demotesCapability: false,
};

/**
 * The plan a severity + disposition implies.
 *
 * `critical` short-circuits: whatever the disposition says, a critical report raises SEV-1. A triage
 * that downgraded a critical report to "edge case acknowledged" and thereby lifted nothing would be
 * exactly the D16 failure the auto-kill exists to prevent — the unwinding path is the R8 lift, with its
 * required resolution narrative, not a quietly gentler disposition.
 */
export function aiHallucinationFollowUpPlanFor(
  severity: AiHallucinationSeverity,
  disposition: AiHallucinationTriageDisposition | null,
): AiHallucinationFollowUpPlan {
  if (severity === "critical") {
    return { action: "raise_sev1", killSwitchReason: "sev1_hallucination", demotesCapability: true };
  }
  if (disposition === null) return NO_FOLLOW_UP;
  const action = aiHallucinationFollowUpFor(disposition);
  if (action === "deprecate_capability") {
    return {
      action,
      // NOT `sev1_hallucination`: the report was not critical, so the alert must not page as one, and
      // §3.1 gives `sev2_hallucination` for exactly this — a capability stopped on a serious but
      // non-critical finding.
      killSwitchReason: "sev2_hallucination",
      demotesCapability: true,
    };
  }
  return { action, killSwitchReason: null, demotesCapability: false };
}

// ── filing (R18 / W5.1) ────────────────────────────────────────────────────────────────────────────

/** R18's request. The narrative arrives ALREADY DEK-encrypted (§3.6) — this rule never sees plaintext. */
export interface AiHallucinationFilingRequest {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  /** `null` when the clinician cannot name the call (§3.2.10: the reports that matter most are often
   *  the ones where provenance is already broken). */
  readonly invocationId: string | null;
  readonly capabilityId: string;
  readonly reporterMembershipId: string;
  readonly reporterRole: string;
  readonly severity: AiHallucinationSeverity;
  readonly hallucinationKind: AiHallucinationKind;
  readonly reporterNarrativeCipher: Uint8Array;
}

/** The row an accepted filing writes. */
export interface AiHallucinationFilingPatch {
  readonly triageStatus: "open";
  readonly triageOwnerMembershipId: null;
  readonly triageDisposition: null;
  readonly mitigationActionRef: null;
  readonly reportedAt: string;
}

export type AiHallucinationFilingDecision =
  | {
      readonly ok: true;
      readonly patch: AiHallucinationFilingPatch;
      /** The SEV-1 plan for a `critical` report; `none` for every other severity (see the header). */
      readonly followUp: AiHallucinationFollowUpPlan;
    }
  | AiGovernanceRefusal;

/** R18 / W5.1 — may this report be filed, and does filing it trip D16? */
export function evaluateAiHallucinationFiling(
  request: AiHallucinationFilingRequest,
  at: string,
): AiHallucinationFilingDecision {
  if (request.reporterNarrativeCipher.byteLength === 0) {
    return aiGovernanceRefusal(
      "AI_HALLUCINATION_NARRATIVE_REQUIRED",
      "a hallucination report with an empty narrative records that something was wrong and nothing about what",
    );
  }
  if (request.reporterRole.trim().length === 0) {
    return aiGovernanceRefusal(
      "AI_HALLUCINATION_NARRATIVE_REQUIRED",
      "the reporter's role is part of the report: a fabricated dose seen by a pharmacist and by a chaplain are not the same finding",
    );
  }
  return {
    ok: true,
    patch: {
      triageStatus: "open",
      triageOwnerMembershipId: null,
      triageDisposition: null,
      mitigationActionRef: null,
      reportedAt: at,
    },
    // Severity ALONE at filing time: no disposition exists yet, and `critical` is the one severity that
    // does not wait for one.
    followUp: aiHallucinationFollowUpPlanFor(request.severity, null),
  };
}

// ── triage (R20 / W5.5-5.7) ────────────────────────────────────────────────────────────────────────

/** The `ai_hallucination_report` columns the triage gate reads. */
export interface AiHallucinationReportSnapshot {
  readonly id: string;
  readonly capabilityId: string;
  readonly severity: AiHallucinationSeverity;
  readonly triageStatus: AiHallucinationTriageStatus;
}

/** R20's request. */
export interface AiHallucinationTriageRequest {
  readonly toStatus: AiHallucinationTriageStatus;
  readonly triageOwnerMembershipId: string;
  /** Required by every edge that claims the report was understood; `null` on `investigating` and on an
   *  escalation, where the point is precisely that M32 has NOT reached a disposition. */
  readonly disposition: AiHallucinationTriageDisposition | null;
  /** Free-text pointer at the mitigation (a PR, an incident id). Never PHI. */
  readonly mitigationActionRef: string | null;
  /** The AI Safety Owner may CONFIRM or correct the reporter's severity (W5.5). */
  readonly severity: AiHallucinationSeverity;
}

/** The columns an accepted triage writes. */
export interface AiHallucinationTriagePatch {
  readonly triageStatus: AiHallucinationTriageStatus;
  readonly severity: AiHallucinationSeverity;
  readonly triageOwnerMembershipId: string;
  readonly triageDisposition: AiHallucinationTriageDisposition | null;
  readonly mitigationActionRef: string | null;
  readonly triagedAt: string;
  /** Set only on the two terminal statuses. `escalated_to_clinical_safety` closes M32's queue while
   *  the committee's stays open — the row leaves this module either way, so both stamp a close. */
  readonly closedAt: string | null;
}

export type AiHallucinationTriageDecision =
  | {
      readonly ok: true;
      readonly patch: AiHallucinationTriagePatch;
      readonly followUp: AiHallucinationFollowUpPlan;
    }
  | AiGovernanceRefusal;

/** R20 / W5.5–5.7 — walk D9's machine and compute the follow-up the disposition implies. */
export function evaluateAiHallucinationTriage(
  request: AiHallucinationTriageRequest,
  current: AiHallucinationReportSnapshot,
  at: string,
): AiHallucinationTriageDecision {
  const edge = aiHallucinationTriageEdge(current.triageStatus, request.toStatus);
  if (edge === null) {
    return aiGovernanceRefusal(
      "AI_HALLUCINATION_TRIAGE_INVALID_TRANSITION",
      aiHallucinationStatusIsTerminal(current.triageStatus)
        ? `report ${current.id} is terminal at '${current.triageStatus}'; it cannot move to '${request.toStatus}'`
        : `'${current.triageStatus}' -> '${request.toStatus}' is not an edge of D9's triage machine`,
    );
  }

  if (request.triageOwnerMembershipId.trim().length === 0) {
    return aiGovernanceRefusal(
      "AI_HALLUCINATION_TRIAGE_OWNER_REQUIRED",
      "a triage decision must name the person who took it",
    );
  }

  if (edge.requiresDisposition && request.disposition === null) {
    return aiGovernanceRefusal(
      "AI_HALLUCINATION_DISPOSITION_REQUIRED",
      `'${request.toStatus}' asserts the report was understood, so §3.2.10's triage_disposition is required`,
    );
  }

  const terminal = aiHallucinationStatusIsTerminal(request.toStatus);
  return {
    ok: true,
    patch: {
      triageStatus: request.toStatus,
      severity: request.severity,
      triageOwnerMembershipId: request.triageOwnerMembershipId,
      // The disposition, once set, is carried forward: a report that reached `root_cause_identified`
      // with `model_rollback_required` and then moves to `mitigated` has not stopped needing a rollback.
      triageDisposition: request.disposition,
      mitigationActionRef: request.mitigationActionRef,
      triagedAt: at,
      closedAt: terminal ? at : null,
    },
    // The TRIAGED severity, not the reported one: W5.5 has the owner confirm it, and a correction that
    // did not change the consequence would make the confirmation decorative.
    followUp: aiHallucinationFollowUpPlanFor(request.severity, request.disposition),
  };
}
