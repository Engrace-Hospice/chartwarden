// @chartwarden/hope — §4.9 / §4.9.1 M36 typed-alert builders (M10-T06).
//
// M10 emits typed alerts through M36's dispatch seam (M36 §4.9 — "M10 emits the deterministic message;
// M36 doesn't re-template"). This module is the single, pure place that constructs each §4.9 payload and
// the §4.9.1 channel-specific projections:
//
//   • buildInAppPayload(alert)      — the FULL typed payload (PHI in-app render only, M10-F13). Delivered
//                                      to the M36 §5.4 `inApp` channel + Socket.IO room.
//   • buildOutOfBandPayload(alert)  — the PHI-STRIPPED projection for push / SMS (SEC-048 / ARCH-185):
//                                      window + SFV alerts carry ONLY a deep-link + a static template
//                                      string (no patientDisplayName / rfaKind / symptom labels / dueAt);
//                                      submission deadline + iQIES rejection alerts carry NO patient
//                                      identifier and so keep their non-PHI counters/rule-ids.
//
// No DB / M36 / outbox import — the caller (route service / `hope:alerts` dispatcher) wraps the returned
// payload in the outbox envelope and M36 selects the per-channel builder before calling Twilio / VAPID.
// The §4.9 alert SHAPES live in the leaf `@chartwarden/types` (`hope.ts`); this builder is the only producer.

import type {
  HopeAlertPayload,
  HopeIqiesRejectionAlert,
  HopeSfvAlert,
  HopeSubmissionDeadlineAlert,
  HopeTimepointWindowAlert,
} from "@chartwarden/types";

/** M36 severity tiers M10 routes alerts at (mirrors M36's dispatch vocabulary). */
export type HopeAlertSeverity = "info" | "warning" | "clinical_urgent" | "critical";

/** The static, PHI-free template strings carried out-of-band per §4.9.1 (no patient identifiers). */
export const OUT_OF_BAND_TEMPLATES = {
  timepoint_window_state: "HOPE timepoint action required — open ChartWarden",
  sfv_obligation: "Symptom Follow-Up Visit due — open ChartWarden",
} as const;

// ── §4.9 typed-alert builders (the deterministic payloads M10 hands to M36) ────────────────────────────

/** §4.9 — build a HOPE timepoint-window alert. `windowState` drives M36 severity escalation. */
export function buildTimepointWindowAlert(input: {
  scheduleId: HopeTimepointWindowAlert["scheduleId"];
  rfaKind: HopeTimepointWindowAlert["rfaKind"];
  patientId: HopeTimepointWindowAlert["patientId"];
  patientDisplayName: string;
  windowState: HopeTimepointWindowAlert["windowState"];
  hoursUntilDeadline: number;
  ctaUrl: string;
}): HopeTimepointWindowAlert {
  return { source: "hope_engine", kind: "timepoint_window_state", ...input };
}

/** §4.9 / M10-F19 — build a Symptom-Follow-Up-Visit obligation alert. `created` is clinical-urgent. */
export function buildSfvAlert(input: {
  sfvId: HopeSfvAlert["sfvId"];
  triggeringAssessmentId: HopeSfvAlert["triggeringAssessmentId"];
  patientId: HopeSfvAlert["patientId"];
  patientDisplayName: string;
  state: HopeSfvAlert["state"];
  hoursUntilDue: number;
  triggeringSymptoms: HopeSfvAlert["triggeringSymptoms"];
  ctaUrl: string;
}): HopeSfvAlert {
  return { source: "hope_engine", kind: "sfv_obligation", ...input };
}

/** §4.9 — build a submission-deadline alert (no patient identifier → out-of-band safe). */
export function buildSubmissionDeadlineAlert(input: {
  submissionId: HopeSubmissionDeadlineAlert["submissionId"];
  providerEntityId: HopeSubmissionDeadlineAlert["providerEntityId"];
  itemCount: number;
  daysUntilDeadline: number;
  ctaUrl: string;
}): HopeSubmissionDeadlineAlert {
  return { source: "hope_engine", kind: "submission_deadline", ...input };
}

/** §4.9 — build an iQIES per-batch rejection alert (rule ids are not PHI → out-of-band safe). */
export function buildIqiesRejectionAlert(input: {
  submissionId: HopeIqiesRejectionAlert["submissionId"];
  rejectedCount: number;
  topRejectionReasons: HopeIqiesRejectionAlert["topRejectionReasons"];
  ctaUrl: string;
}): HopeIqiesRejectionAlert {
  return { source: "hope_engine", kind: "iqies_rejection", ...input };
}

// ── §4.9 severity routing (escalates as the alert state advances) ─────────────────────────────────────

/** §4.9 — the timepoint-window severity floor: climbs as `windowState` advances toward `expired`. */
export function timepointWindowSeverity(
  state: HopeTimepointWindowAlert["windowState"],
): HopeAlertSeverity {
  switch (state) {
    case "opening":
    case "mid_window":
      return "info";
    case "closing":
      return "warning";
    case "late":
      return "clinical_urgent";
    case "expired":
      return "critical";
  }
}

/** §4.9 / M10-F19 — SFV severity: `created` is clinical-urgent from first emission; `critical_overdue` is critical. */
export function sfvAlertSeverity(state: HopeSfvAlert["state"]): HopeAlertSeverity {
  switch (state) {
    case "created":
    case "due_tomorrow":
      return "clinical_urgent";
    case "overdue":
      return "clinical_urgent";
    case "critical_overdue":
      return "critical";
  }
}

// ── §4.9.1 channel-specific projections (PHI strip for out-of-band push / SMS) ─────────────────────────

/** The full typed payload for the in-app channel (M36 §5.4 `inApp`); PHI is render-only here (M10-F13). */
export function buildInAppPayload(alert: HopeAlertPayload): HopeAlertPayload {
  return alert;
}

/** The PHI-free out-of-band body delivered to push / SMS (no patient identifiers, only a deep link). */
export interface HopeOutOfBandPayload {
  readonly kind: HopeAlertPayload["kind"];
  /** Static, PHI-free notice — "open ChartWarden" + the deep link. Never carries a patient name/symptom. */
  readonly body: string;
  /** Authenticated deep-link to the relevant surface (the only contextual field carried out-of-band). */
  readonly ctaUrl: string;
  /** Non-PHI counters that are safe out-of-band (submission alerts only); omitted for clinical alerts. */
  readonly meta?: Record<string, number | string>;
}

/**
 * §4.9.1 (SEC-048 / ARCH-185 — M10-F13) — strip every patient-identifying field before push / SMS. Window
 * + SFV alerts carry ONLY a static template + the deep link (no `patientDisplayName`, `rfaKind`,
 * symptom labels, or `dueAt`). Submission-deadline + iQIES-rejection alerts carry no patient identifier,
 * so their non-PHI counters / rule-id summary travel out-of-band.
 */
export function buildOutOfBandPayload(alert: HopeAlertPayload): HopeOutOfBandPayload {
  switch (alert.kind) {
    case "timepoint_window_state":
      return {
        kind: alert.kind,
        body: OUT_OF_BAND_TEMPLATES.timepoint_window_state,
        ctaUrl: alert.ctaUrl,
      };
    case "sfv_obligation":
      return {
        kind: alert.kind,
        body: OUT_OF_BAND_TEMPLATES.sfv_obligation,
        ctaUrl: alert.ctaUrl,
      };
    case "submission_deadline":
      return {
        kind: alert.kind,
        body: `HOPE submission deadline approaching: ${alert.itemCount} item(s), ${alert.daysUntilDeadline} day(s) left`,
        ctaUrl: alert.ctaUrl,
        meta: { itemCount: alert.itemCount, daysUntilDeadline: alert.daysUntilDeadline },
      };
    case "iqies_rejection":
      return {
        kind: alert.kind,
        body: `iQIES rejected ${alert.rejectedCount} HOPE item(s)`,
        ctaUrl: alert.ctaUrl,
        meta: { rejectedCount: alert.rejectedCount },
      };
  }
}
