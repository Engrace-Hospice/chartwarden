// apps/backend/src/modules/19-oncall/alerts.ts — M19-T07 (§4.9 typed M36 alert payloads).
//
// The six §4.9 alert RULES plus the builders that turn a transition's declared `{kind:'alert'}` effect into
// the typed `OncallAlertPayload` M36 renders. M19-T03 made every machine declare only the DISCRIMINATOR
// (`{kind:'alert', alert:'m19.triage.case_opened'}`) because a pure machine cannot resolve a recipient set;
// this file is where the discriminator becomes a payload, and `routes/effects-runner.ts` is where the
// payload reaches the M36 port.
//
// THREE PROPERTIES THAT ARE THE POINT OF THE FILE:
//
//   1. `systemLocked` IS NOT ADVISORY. §4.9 marks three rules locked — the red-flag hit, the mandatory
//      escalation and the coverage gap — and `@wardenx/types` already pins that set as
//      `M19_SYSTEM_LOCKED_ALERT_TYPES`. {@link isAlertSuppressible} is the ONE function any tenant-policy
//      check must go through, and it consults that pinned list rather than the local rule table, so a rule
//      edited here can never quietly unlock the three alerts an agency under staffing pressure would most
//      want silenced.
//   2. THE `case_opened` SEVERITY IS COMPUTED, NOT CONFIGURED. §4.9's comment ("sometimes warn if from
//      inbound trigger") is a rule about PROVENANCE: a call a human opened has a human looking at it, and a
//      call D10's no-show / late-checkout consumer opened has nobody. {@link caseOpenedSeverity} derives it
//      from `triage_call.source`, so the two D10 paths cannot drift from the manual one.
//   3. NO ALERT PAYLOAD CARRIES CALLER PROSE. Every field below is an id, an enum, a catalog LABEL or a
//      lay-safe summary. The §3.6 denylist columns (`caller_quote_cipher`, `transcript_cipher`,
//      `chief_complaint_text`, `trigger_detail`, `resolution`) reach an SMS gateway through no path in this
//      file, and the payload TYPES have no field for them — the compile-time half of §8.3.4.
import type {
  IsoInstant,
  OnCallCoverageGapDetectedAlert,
  OncallAlertPayload,
  OncallShiftDiscipline,
  OrgId,
  PatientId,
  ProviderEntityId,
  TriageCallId,
  TriageCallSource,
  TriageCallbackSlaBreachedAlert,
  TriageCaseOpenedAlert,
  TriageDocumentedAlert,
  TriageEscalationId,
  TriageEscalationTier,
  TriageMandatoryEscalationTriggeredAlert,
  TriageProtocolRedFlagHitAlert,
} from "@wardenx/types";
import { M19_SYSTEM_LOCKED_ALERT_TYPES } from "@wardenx/types";

/** §4.9 — how M36 resolves the recipient set for a rule. */
export type OncallAlertRecipientResolver = "on_call" | "role_set" | "care_team";

/** One §4.9 alert rule. */
export interface OncallAlertRule {
  readonly eventType: OncallAlertPayload["eventType"];
  /** The rule's BASE severity. `m19.triage.case_opened` computes it per call (see rule 2 in the header). */
  readonly severity: OncallAlertPayload["severity"];
  readonly recipientResolver: OncallAlertRecipientResolver;
  /** What the resolver needs from the payload, as §4.9 spells it. */
  readonly recipientArgs?: Readonly<Record<string, unknown>>;
  /** §4.9 — no tenant setting may disable this rule. Pinned to `M19_SYSTEM_LOCKED_ALERT_TYPES`. */
  readonly systemLocked: boolean;
}

/** §4.9's `M19_ALERT_RULES`, verbatim (the two rules §4.9 leaves `systemLocked` implicit are `false`). */
export const M19_ALERT_RULES: readonly OncallAlertRule[] = [
  {
    eventType: "m19.triage.case_opened",
    severity: "info", // …or `warn` from a D10 inbound trigger — see `caseOpenedSeverity`
    recipientResolver: "on_call",
    recipientArgs: { providerEntityIdFromPayload: true },
    systemLocked: false,
  },
  {
    eventType: "m19.triage.protocol_red_flag_hit",
    severity: "warn",
    recipientResolver: "on_call",
    systemLocked: true,
  },
  {
    eventType: "m19.triage.mandatory_escalation_triggered",
    severity: "critical",
    recipientResolver: "role_set",
    recipientArgs: { tierFromPayload: true },
    systemLocked: true,
  },
  {
    eventType: "m19.triage.callback_sla_breached",
    severity: "warn",
    recipientResolver: "on_call",
    systemLocked: false,
  },
  {
    eventType: "m19.triage.documented",
    severity: "info",
    recipientResolver: "care_team",
    recipientArgs: { patientIdFromPayload: true },
    systemLocked: false,
  },
  {
    eventType: "m19.oncall.coverage_gap_detected",
    severity: "critical",
    recipientResolver: "role_set",
    recipientArgs: { roles: ["org_admin", "clinical_supervisor"] },
    systemLocked: true,
  },
];

/** The rule for an alert type. Every `OncallAlertPayload` member has one (asserted by the §9 test). */
export function alertRuleFor(
  eventType: OncallAlertPayload["eventType"],
): OncallAlertRule | undefined {
  return M19_ALERT_RULES.find((r) => r.eventType === eventType);
}

/**
 * §4.9 / §8.6 — may a tenant setting suppress this alert?
 *
 * Consults the `@wardenx/types` pinned set, NOT the local rule table (rule 1). An unknown event type is
 * treated as NOT suppressible: a rule nobody has classified must not default to silenceable.
 */
export function isAlertSuppressible(eventType: string): boolean {
  if ((M19_SYSTEM_LOCKED_ALERT_TYPES as readonly string[]).includes(eventType)) return false;
  // An event type with no §4.9 rule has not been classified, and an unclassified alert must not default
  // to silenceable: the failure mode of getting this backwards is a page nobody receives.
  return M19_ALERT_RULES.some((r) => r.eventType === eventType);
}

/** The §3.2 `triage_call_source` values that mean "a machine opened this, not a person" (D10 + §2.7). */
const MACHINE_OPENED_SOURCES: readonly TriageCallSource[] = [
  "no_show",
  "late_checkout",
  "geofence_anomaly",
  "m36_delivery_failure",
  "m36_afterhours_request",
];

/**
 * §4.9 rule 1 — the `case_opened` severity for a call from this source.
 *
 * `paper_origin` is deliberately `info`: a BCP re-entry is a human typing up a night that already happened,
 * so paging the on-call nurse about it at the moment of data entry would be noise about the past. `manual`
 * is `info` for the plain reason that the person who opened it is looking at it.
 */
export function caseOpenedSeverity(source: TriageCallSource): "info" | "warn" {
  return MACHINE_OPENED_SOURCES.includes(source) ? "warn" : "info";
}

// ── payload builders (one per §4.9 rule) ─────────────────────────────────────────────────────────────

/** `m19.triage.case_opened`. */
export function buildCaseOpenedAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly triageCallId: TriageCallId;
  readonly source: TriageCallSource;
  readonly openedAt: IsoInstant;
}): TriageCaseOpenedAlert {
  return {
    eventType: "m19.triage.case_opened",
    severity: caseOpenedSeverity(input.source),
    orgId: input.orgId,
    providerEntityId: input.providerEntityId,
    triageCallId: input.triageCallId,
    source: input.source,
    openedAt: input.openedAt,
  };
}

/**
 * `m19.triage.protocol_red_flag_hit`.
 *
 * `questionPrompt` is the CATALOG's prompt ("Has the patient fallen in the last 24h?"), never the caller's
 * answer text. The prompt is org-visible reference data; the answer is §3.6-denylisted PHI, and an alert is
 * delivered over SMS to a phone that may be on a lock screen.
 */
export function buildRedFlagHitAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly triageCallId: TriageCallId;
  readonly escalationId: TriageEscalationId;
  readonly questionPrompt: string;
}): TriageProtocolRedFlagHitAlert {
  return { eventType: "m19.triage.protocol_red_flag_hit", severity: "warn", ...input };
}

/** `m19.triage.mandatory_escalation_triggered` — §7.2's page. `protocolLabel` is the catalog label. */
export function buildMandatoryEscalationAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly triageCallId: TriageCallId;
  readonly escalationId: TriageEscalationId;
  readonly tier: TriageEscalationTier;
  readonly protocolLabel: string;
}): TriageMandatoryEscalationTriggeredAlert {
  return { eventType: "m19.triage.mandatory_escalation_triggered", severity: "critical", ...input };
}

/** `m19.triage.callback_sla_breached` — the §4.8 per-minute detector's. */
export function buildCallbackSlaBreachedAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly triageCallId: TriageCallId;
  readonly slaTargetMinutes: number;
  readonly minutesElapsed: number;
}): TriageCallbackSlaBreachedAlert {
  return { eventType: "m19.triage.callback_sla_breached", severity: "warn", ...input };
}

/** `m19.triage.documented` — the care-team channel's lay-language preview. */
export function buildDocumentedAlert(input: {
  readonly orgId: OrgId;
  readonly patientId: PatientId;
  readonly triageCallId: TriageCallId;
  readonly dispositionSummary: string;
}): TriageDocumentedAlert {
  return { eventType: "m19.triage.documented", severity: "info", ...input };
}

/** `m19.oncall.coverage_gap_detected` — the §4.8 watchdog's critical page. */
export function buildCoverageGapAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly gapStartsAt: IsoInstant;
  readonly gapEndsAt: IsoInstant;
  readonly discipline: OncallShiftDiscipline;
}): OnCallCoverageGapDetectedAlert {
  return { eventType: "m19.oncall.coverage_gap_detected", severity: "critical", ...input };
}

/**
 * §2.7 class D-D — the fallback the status endpoint surfaces when M36's alert circuit breaker is OPEN.
 *
 * Not an alert: it is what an org-admin is shown INSTEAD of one, so the agency's own published after-hours
 * number (`tenant_oncall_policy.emergency_contact_e164`) is reachable while the alerting fabric is down.
 * `null` is a real answer — a tenant that configured no fallback number has none, and the screen must say
 * so rather than render an empty string that reads like a number nobody dialled.
 */
export interface OncallDegradedAlertFallback {
  readonly alertingDegraded: true;
  readonly emergencyContactE164: string | null;
  readonly providerEntityId: ProviderEntityId;
}
