// apps/backend/src/modules/32-ai-platform/alerts.ts — M32-T07 (§4.9 typed M36 alert payloads).
//
// The ten §4.9 alert payload contracts plus the emitter that hands them to M36's alert bus through the
// §4.3 `AlertEmitter` seam (seams/consumed.ts). §4.9 is explicit about the division of labour: "M32 is
// responsible for the typed payload, not for the routing decisions" — which recipient cohort each alert
// reaches is configured in M36's alert-routing manifest, and nothing in this file names a person.
//
// ── AN ALERT IS NOT AN OUTBOX EVENT, AND M32 EMITS BOTH FOR THE SAME FACTS ───────────────────────────
//
// The two look duplicative and are not. `events-by-m32.ts` publishes into the TRANSACTIONAL outbox on the
// mutation's own transaction — it is the durable record M4 audits and M35 meters from, and it cannot
// outlive a rolled-back write. An alert is a NOTIFICATION with a recipient cohort and a channel ladder;
// it is emitted AFTER the transaction commits, and losing one costs a page, not a ledger row. Publishing
// the alert inside the transaction would page an operator about a kill switch that then rolled back.
//
// ── THE EMIT IS FAIL-SOFT, AND THAT IS THE ONE DEGRADATION M32 ACCEPTS ON PURPOSE ────────────────────
//
// `getAiAlertBus()` answers `null` when M36 is not mounted, and a bus that throws is caught here. Every
// M32 alert is ABOUT something already recorded — the kill-switch row, the ledger accrual, the
// hallucination report — so a lost page delays a human, whereas a throw would roll back or 500 the write
// that made the fact true. {@link emitAiAlert} therefore returns a boolean saying whether the alert left
// the building, so a caller that wants to surface "recorded, but nobody was paged" can. Silently
// returning void would make an unmounted M36 indistinguishable from a delivered page.
//
// ── NO PAYLOAD CARRIES PHI, AND THE TYPES ARE THE ENFORCEMENT ───────────────────────────────────────
//
// §8.2: these leave the platform over M36's channels. Ids, enum tokens, counts and instants only. The
// hallucination alerts carry `severity` and `reportId` and NOT the clinician's description; the drift
// alerts carry metric NAMES and numbers. There is no field here a §3.4-denylisted column could be
// assigned to, which is the compile-time half of the rule.
import type {
  AiHallucinationFollowUpAction,
  AiHallucinationSeverity,
  AiKillSwitchScope,
  AiKillSwitchSeverity,
} from "@wardenx/types";

import { getAiAlertBus } from "./seams/index";

/** §4.9's stable `alertType` discriminators — M36's typed-alert registry keys off these. */
export const M32_ALERT_TYPES = [
  "ai.token_soft_cap_warning",
  "ai.token_hard_cap_breached",
  "ai.kill_switch_activated",
  "ai.kill_switch_deactivated",
  "ai.drift_threshold_breached",
  "ai.hallucination_report_filed",
  "ai.hallucination_triage_escalation",
  "ai.capability_state_changed",
  "ai.evaluation_failed",
  "ai.backend_health_degraded",
] as const;

export type M32AlertType = (typeof M32_ALERT_TYPES)[number];

/**
 * §4.9's severity ladder for a drift finding.
 *
 * `red` is not merely "worse than orange": D11 makes it the tier that trips an AUTOMATED kill switch
 * (`activation_actor_kind: 'automated_drift_monitor'`). The tier therefore has to ride the alert rather
 * than be recomputed by the recipient, or an operator's dashboard and the switch that already fired would
 * be able to disagree about what happened.
 */
export type M32DriftSeverityTier = "yellow" | "orange" | "red";

/** §4.9's backend health ladder. `green` is only ever a PREVIOUS status here — see the payload. */
export type M32BackendHealthTier = "green" | "yellow" | "red";

/**
 * §4.9 — the ten typed alert payloads, as one discriminated union.
 *
 * `organizationId` is `string | null` on the platform-scoped members and a plain `string` on the
 * tenant-scoped ones, which is the union doing real work: a platform kill switch stops every agency and
 * has no org to name, while a soft-cap warning is meaningless without the agency whose budget it is.
 */
export type M32AlertPayload =
  | {
      readonly alertType: "ai.token_soft_cap_warning";
      readonly organizationId: string;
      readonly capabilityId: string;
      readonly capabilityKey: string;
      readonly spentTokens: number;
      readonly softCap: number;
      readonly windowStart: string;
      readonly windowEnd: string;
    }
  | {
      readonly alertType: "ai.token_hard_cap_breached";
      readonly organizationId: string;
      readonly capabilityId: string;
      readonly capabilityKey: string;
      readonly spentTokens: number;
      readonly hardCap: number;
      /** W2: the cap is reached and the FALLBACK is already engaged — the literal `true` is §4.9's, and
       *  it is a claim about what M32 did, not a request for the recipient to do it. */
      readonly fallbackEngaged: true;
      readonly windowStart: string;
      readonly windowEnd: string;
    }
  | {
      readonly alertType: "ai.kill_switch_activated";
      readonly capabilityId: string;
      readonly capabilityKey: string;
      readonly scope: AiKillSwitchScope;
      readonly organizationId: string | null;
      readonly activatedByMembershipId: string | null;
      readonly reasonCategory: string;
      readonly severity: AiKillSwitchSeverity;
    }
  | {
      readonly alertType: "ai.kill_switch_deactivated";
      readonly capabilityId: string;
      readonly capabilityKey: string;
      readonly scope: AiKillSwitchScope;
      readonly organizationId: string | null;
      readonly deactivatedByMembershipId: string | null;
      readonly resolutionNarrative: string;
    }
  | {
      readonly alertType: "ai.drift_threshold_breached";
      readonly capabilityId: string;
      readonly capabilityKey: string;
      readonly organizationId: string | null;
      readonly metric: string;
      readonly observedValue: number;
      readonly baselineValue: number;
      readonly deltaPercent: number;
      readonly severityTier: M32DriftSeverityTier;
      readonly suggestedAction: string;
    }
  | {
      readonly alertType: "ai.hallucination_report_filed";
      readonly reportId: string;
      readonly capabilityId: string;
      readonly capabilityKey: string;
      readonly organizationId: string;
      readonly severity: AiHallucinationSeverity;
      readonly reporterMembershipId: string;
    }
  | {
      readonly alertType: "ai.hallucination_triage_escalation";
      readonly reportId: string;
      readonly capabilityId: string;
      readonly capabilityKey: string;
      readonly organizationId: string;
      /** `none` is absent from this member on purpose: §4.8's `ai:hallucination-triage-followup` queue
       *  exists to EXECUTE an action, and "no action" is a triage decision to record, never a page. */
      readonly followUpAction: Exclude<AiHallucinationFollowUpAction, "none">;
    }
  | {
      readonly alertType: "ai.capability_state_changed";
      readonly capabilityId: string;
      readonly capabilityKey: string;
      readonly organizationId: null;
      readonly previousState: string;
      readonly newState: string;
      readonly transitionedByMembershipId: string;
    }
  | {
      readonly alertType: "ai.evaluation_failed";
      readonly runId: string;
      readonly capabilityId: string;
      readonly capabilityKey: string;
      readonly organizationId: null;
      readonly failureReason: string;
    }
  | {
      readonly alertType: "ai.backend_health_degraded";
      readonly backendId: string;
      readonly backendKey: string;
      readonly organizationId: null;
      /** `green` is expressible only HERE. §4.9's `currentStatus` excludes it, because an alert whose
       *  current status is healthy is a recovery notice and §4.9 defines no such alert — a recipient
       *  reading `currentStatus: 'green'` would page an operator about a backend that came back. */
      readonly previousStatus: M32BackendHealthTier;
      readonly currentStatus: Exclude<M32BackendHealthTier, "green">;
      readonly consecutiveFailures: number;
    };

/** The `AlertEmitter` shape M32 needs; injectable so the §10 tests exercise the rules with no seams. */
export interface AiAlertPort {
  emit(input: {
    readonly organizationId: string | null;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
}

/**
 * The alerts §4.9 marks as ones a tenant may NOT silence.
 *
 * Both are SAFETY signals whose whole value is that the recipient did not choose to receive them: a
 * kill-switch activation says a capability just stopped mid-shift, and a `critical` hallucination report
 * is D16's SEV-1 trigger. An agency under cost pressure has an obvious motive to mute exactly these, so
 * the list lives beside the payload types and {@link isAiAlertSuppressible} is the one function a
 * tenant-policy check goes through (the M20 §4.9 precedent).
 */
export const M32_SYSTEM_LOCKED_ALERT_TYPES: readonly M32AlertType[] = [
  "ai.kill_switch_activated",
  "ai.hallucination_triage_escalation",
];

/** Whether a tenant's notification policy may suppress this alert type. */
export function isAiAlertSuppressible(alertType: M32AlertType): boolean {
  return !M32_SYSTEM_LOCKED_ALERT_TYPES.includes(alertType);
}

/** The org an alert belongs to — `null` for the platform-scoped members (see the union's doc-comment). */
export function alertOrganizationId(payload: M32AlertPayload): string | null {
  return payload.organizationId;
}

/**
 * Hand one §4.9 payload to M36, fail-soft.
 *
 * Returns `true` when the bus accepted it and `false` when M36 is unmounted or the emit threw — see the
 * module header on why that distinction is a return value rather than a swallowed void. The port is
 * injectable; the default resolves M36 through the §4.3 seam at CALL time, so registration order does not
 * matter and a worker running before `wireModuleSeams()` degrades rather than crashing.
 */
export async function emitAiAlert(
  payload: M32AlertPayload,
  port: AiAlertPort | null = getAiAlertBus(),
): Promise<boolean> {
  if (port === null) return false;
  try {
    await port.emit({
      organizationId: alertOrganizationId(payload),
      eventType: payload.alertType,
      payload: payload as unknown as Readonly<Record<string, unknown>>,
    });
    return true;
  } catch {
    return false;
  }
}
