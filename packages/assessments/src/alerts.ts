// @wardenx/assessments — §4.9 M36 typed-alert builder (M9-T06).
//
// When the significant-change detector fires `m9.assessment.significant_change` inside the recording
// transaction, M9 emits a typed alert M36 delivers verbatim (§4.9 — "M9 emits the deterministic message;
// M36 doesn't re-template"). This module is the single, pure place that resolves the alert: the §4.9 /
// M09-F12 severity floor (CRITICAL_RULES → `clinical_urgent` at first emission; everything else
// `medium`, upgradable to `high` by the 24h-no-ack escalation cron), the medical-director fan-out rule,
// and the deterministic `bodyTemplate`. No DB / M36 / outbox import — the caller (route service /
// escalation job) wraps the returned payload in the outbox envelope.
//
// The rule-id taxonomy + CRITICAL_RULES + the AssessmentSignificantChangeAlert shape live in the leaf
// `@wardenx/types`; this builder is the only producer of that payload so the severity/recipients
// invariants hold in exactly one place.

import { isCriticalRule } from "@wardenx/types";
import type {
  AssessmentAlertSeverity,
  AssessmentSignificantChangeAlert,
  ScaleType,
  SignificantChangeRuleId,
} from "@wardenx/types";
import { firstEmissionSeverity } from "./significant-change";

/** The facts the detector (record path) / escalation cron pass to build one §4.9 alert. */
export interface SignificantChangeAlertInput {
  readonly organizationId: string;
  readonly patientId: string;
  readonly assessmentId: string;
  readonly ruleId: SignificantChangeRuleId;
  readonly scaleType: ScaleType;
  /** The crossing magnitude (e.g. PPS drop of 30); `null` for categorical rules (NYHA Class IV). */
  readonly deltaValue?: number | null;
  /** The platform-floor / tenant-tightened threshold the rule crossed; `null` for categorical rules. */
  readonly thresholdValue?: number | null;
}

/**
 * §4.9 — the medical-director fan-out: `clinical_urgent` notifies immediately; an escalated `high`
 * notifies on escalation; a first-emission `medium` never does (the supervisor is already in the
 * care-team channel). Derived solely from the resolved severity so the rule lives in one place.
 */
export function medicalDirectorRouting(
  severity: AssessmentAlertSeverity,
): "immediate" | "on_escalation" | false {
  switch (severity) {
    case "clinical_urgent":
      return "immediate";
    case "high":
      return "on_escalation";
    case "medium":
      return false;
  }
}

/** The deterministic message M36 delivers verbatim (§4.9). Stable for a given (rule, scale, delta). */
export function significantChangeBody(
  input: Pick<SignificantChangeAlertInput, "ruleId" | "scaleType" | "deltaValue" | "thresholdValue">,
  severity: AssessmentAlertSeverity,
): string {
  const scale = input.scaleType.toUpperCase();
  const magnitude =
    input.deltaValue != null && input.thresholdValue != null
      ? ` (Δ ${input.deltaValue} vs threshold ${input.thresholdValue})`
      : input.deltaValue != null
        ? ` (Δ ${input.deltaValue})`
        : "";
  return `Significant change on ${scale}: rule ${input.ruleId}${magnitude} — severity ${severity}.`;
}

/**
 * §4.9 — build the typed M36 alert for a significant-change firing. `severityOverride` is supplied by
 * the change-escalation cron (§4.8) when it upgrades a first-emission `medium` to `high`; the record
 * path omits it and the §4.9 / M09-F12 first-emission floor applies (CRITICAL → `clinical_urgent`).
 */
export function buildSignificantChangeAlert(
  input: SignificantChangeAlertInput,
  severityOverride?: AssessmentAlertSeverity,
): AssessmentSignificantChangeAlert {
  const severity = severityOverride ?? firstEmissionSeverity(input.ruleId);
  const deltaValue = input.deltaValue ?? null;
  const thresholdValue = input.thresholdValue ?? null;
  return {
    kind: "m9.assessment.significant_change",
    organizationId: input.organizationId,
    patientId: input.patientId,
    assessmentId: input.assessmentId,
    ruleId: input.ruleId,
    scaleType: input.scaleType,
    severity,
    deltaValue,
    thresholdValue,
    recipients: {
      careTeamChannel: true,
      caseManagerInbox: true,
      clinicalSupervisorInbox: true,
      medicalDirectorInbox: medicalDirectorRouting(severity),
    },
    bodyTemplate: significantChangeBody(
      { ruleId: input.ruleId, scaleType: input.scaleType, deltaValue, thresholdValue },
      severity,
    ),
  };
}

/** Whether a rule escalates at the 24h-no-ack mark (§2.2.2 / §4.8 — CRITICAL rules only). */
export function escalatesOnNoAck(ruleId: SignificantChangeRuleId): boolean {
  return isCriticalRule(ruleId);
}
