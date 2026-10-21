// apps/backend/src/modules/20-field-safety/alerts.ts — M20-T06 (§4.9 typed M36 alert payloads).
//
// The twelve §4.9 alert RULES plus the builders that turn a transition's declared `{kind:'alert'}` effect
// into the typed `SafetyAlertPayload` M36 renders. M20-T03 made every machine declare only the
// DISCRIMINATOR (`{kind:'alert', alert:'m20.safety.sos_alert_raised'}`) because a pure machine cannot
// resolve a recipient set; this file is where the discriminator becomes a payload, and
// `routes/effects-runner.ts` is where the payload reaches the M36 port.
//
// ── THE SEED SHAPE, AND WHY IT IS NOT M36's ─────────────────────────────────────────────────────────
//
// M36's `PlatformAlertRuleSeed.recipientResolver` is the `alert_recipient_resolver` pgEnum: seven members,
// none of them M20's. §4.9 names FOUR resolvers M20 depends on (`field_safety_composed`,
// `field_safety_composed_plus_poster`, `safety_supervisors`,
// `safety_supervisors_plus_compliance_officer`), and M20-T05 registered the first onto M36's OPEN runtime
// registry — the ADR-0024 composition-resolver pattern. The RUNTIME registry is an open `Map<string, …>`;
// the DDL enum is closed. So the seed below is an M20-LOCAL row shape whose `recipientResolver` is a
// `string`, exactly as M34's thirteen §4.8 rules are (34-saas-tenant-platform/alert-rules.ts). Widening
// the pgEnum is an M36-owned migration and is out of this wave's manifest budget; the local shape is what
// keeps the rule table HONEST about which resolver each rule actually needs in the meantime.
//
// ── THE `field_safety` CATEGORY AND THE TIER-1 VOICE RULE ALREADY EXIST ──────────────────────────────
//
// M36's platform seed (packages/messaging/src/seed/alert-rules.ts) already ships `field_safety.sos`:
// category `field_safety`, `severityFloor: critical`, `channelsOverride: ['in_app','push','sms','voice']`,
// `systemLocked: true` — and `SYSTEM_LOCKED_EVENT_TYPES` names it, `fan-out.ts` keys its voice-escalation
// path off `category === 'field_safety' && severity === 'critical'`. M20 does NOT re-declare it. What M20
// adds is the twelve `m20.safety.*` rules that ride the SAME category, with the composed resolver, so a
// tenant's catalog carries one row per alert this module actually emits rather than one generic SOS row.
//
// ── THREE PROPERTIES THAT ARE THE POINT OF THE FILE ─────────────────────────────────────────────────
//
//   1. `systemLocked` IS NOT ADVISORY, AND THE LIST IS NOT LOCAL. §4.9 marks six rules locked and
//      `@chartwarden/types` already pins that set as `M20_SYSTEM_LOCKED_ALERT_TYPES`.
//      {@link isSafetyAlertSuppressible} is the ONE function any tenant-policy check must go through and it
//      consults the PINNED list, not the rule table below — so a rule edited here can never quietly unlock
//      the six alerts an agency under staffing pressure would most want silenced. M20 has more locked rules
//      than any other module, which is the whole point of S13.
//   2. NO ALERT PAYLOAD CARRIES A COORDINATE, A PATIENT IDENTITY OR A CLEARTEXT NARRATIVE (§8.2 / §8.3).
//      The recipient set includes SMS and VOICE, so every field here leaves the platform — to a phone that
//      may be on a lock screen. `locationDescriptionMasked` is a coarse descriptor a responder can act on
//      ("Springfield, near the 12th St corridor"), and its ABSENCE is itself the message: "no location
//      available — call immediately" (M20-F16's declined-consent case). The payload TYPES have no field
//      for a latitude, which is the compile-time half of that rule.
//   3. THE CLINICIAN'S FIRST NAME IS THE MINIMUM-NECESSARY MAXIMUM. Every people-bearing payload carries
//      `postedByFirstName` / `clinicianFirstName` and nothing more (§8.2 / HIPAA §164.502(b)). A supervisor
//      woken at 3 a.m. needs to know WHO to call for; a full name on an SMS gateway is a disclosure the
//      alert does not need to make.
import type {
  IsoInstant,
  MembershipId,
  OrgId,
  ProviderEntityId,
  SafetyAlertPayload,
  SafetyCheckInEscalatedAlert,
  SafetyCheckInKind,
  SafetyCheckInOverdueAlert,
  SafetyCheckInScheduleId,
  SafetyCoverageGapDetectedAlert,
  SafetyCoverageGapReason,
  SafetyHighRiskAreaEnteredAlert,
  SafetyHighRiskAreaId,
  SafetyHighRiskCategory,
  SafetyIncidentCategory,
  SafetyIncidentId,
  SafetyIncidentSeverity,
  SafetyIncidentSubmittedAlert,
  SafetyOshaReportableIncidentFiledAlert,
  SafetyPolicyChangedAlert,
  SafetyPolicyVersionId,
  SafetySosAlertId,
  SafetySosLifecycleState,
  SafetySosOutcome,
  SosAlertAcknowledgedAlert,
  SosAlertEscalatedAlert,
  SosAlertRaisedAlert,
  SosAlertResolvedAlert,
  SosTerminusReachedAlert,
  VisitId,
} from "@chartwarden/types";
import { M20_SYSTEM_LOCKED_ALERT_TYPES } from "@chartwarden/types";

/** The M36 alert CATEGORY every M20 rule rides (M36 §3.6's `alert_category` — already a member). */
export const M20_ALERT_CATEGORY = "field_safety" as const;

/** The three-level legacy ladder M36's `alert_severity` pgEnum / `alert_rule.severity_floor` uses. */
export type M20AlertSeverityFloor = "info" | "warn" | "critical";

/**
 * One M20 platform-default `alert_rule` (organization_id NULL). Structurally the `EmitAlertRule` M36's
 * engine routes on: `recipientResolver` is a `string` so it can name M20's four §4.9 resolvers, which the
 * `alert_recipient_resolver` pgEnum does not carry (see the module header).
 */
export interface M20AlertRuleSeed {
  readonly eventType: SafetyAlertPayload["eventType"];
  readonly category: typeof M20_ALERT_CATEGORY;
  readonly severityFloor: M20AlertSeverityFloor;
  readonly recipientResolver: string;
  readonly resolverArgs: Readonly<Record<string, unknown>>;
  /** null ⇒ use recipient preferences (no channel override, M36 §3.6). */
  readonly channelsOverride: readonly string[] | null;
  /** §4.9 — no tenant setting may disable this rule. Pinned to `M20_SYSTEM_LOCKED_ALERT_TYPES`. */
  readonly systemLocked: boolean;
  readonly enabled: boolean;
}

/**
 * §4.9's `M20_ALERT_RULES`, one row per member of the `SafetyAlertPayload` union.
 *
 * THE TIER-1 VOICE OVERRIDE APPEARS ON THREE ROWS, NOT ONE. §4.9 spells `channelsOverride` only on
 * `sos_alert_raised`, but M36's `voice` channel is SOS-only by policy (M36 §2.5) and the two other alerts
 * that mean "a human is in danger and nobody has answered" are the ESCALATION and the TERMINUS. Leaving
 * them on recipient preferences would mean the raise dials a phone and the terminus — the state that
 * exists because the raise went unanswered — sends a push notification to a locked screen. §2.2.2's
 * terminus quartet ("keeps re-escalating … until a human acknowledges") is unimplementable without it.
 *
 * `check_in_escalated` does NOT carry the override, even though §7.3's top rung routes "like an SOS
 * including Tier-1 voice". The rung is carried on the PAYLOAD (`tier: 'sos_equivalent'`, M20-T03) and only
 * the top one of four warrants a voice call — a rule-level override would dial a phone at the 15-minute
 * supervisor page. The dispatcher reads the tier; the rule stays on preferences.
 */
export const M20_ALERT_RULES: readonly M20AlertRuleSeed[] = [
  {
    eventType: "m20.safety.sos_alert_raised",
    category: M20_ALERT_CATEGORY,
    severityFloor: "critical",
    recipientResolver: "field_safety_composed",
    resolverArgs: {
      clinicianMembershipIdPath: "postedByMembershipId",
      providerEntityIdPath: "providerEntityId",
      eventTimePath: "postedAt",
    },
    channelsOverride: ["in_app", "push", "sms", "voice"],
    systemLocked: true,
    enabled: true,
  },
  {
    eventType: "m20.safety.sos_alert_escalated",
    category: M20_ALERT_CATEGORY,
    severityFloor: "critical",
    recipientResolver: "field_safety_composed",
    resolverArgs: {
      clinicianMembershipIdPath: "postedByMembershipId",
      providerEntityIdPath: "providerEntityId",
      eventTimePath: "escalatedAt",
    },
    channelsOverride: ["in_app", "push", "sms", "voice"],
    systemLocked: true,
    enabled: true,
  },
  {
    eventType: "m20.safety.sos_terminus_reached",
    category: M20_ALERT_CATEGORY,
    severityFloor: "critical",
    recipientResolver: "field_safety_composed",
    resolverArgs: {
      clinicianMembershipIdPath: "postedByMembershipId",
      providerEntityIdPath: "providerEntityId",
      eventTimePath: "terminusReachedAt",
    },
    channelsOverride: ["in_app", "push", "sms", "voice"],
    systemLocked: true,
    enabled: true,
  },
  {
    eventType: "m20.safety.sos_alert_acknowledged",
    category: M20_ALERT_CATEGORY,
    severityFloor: "warn",
    recipientResolver: "field_safety_composed_plus_poster",
    resolverArgs: {
      clinicianMembershipIdPath: "postedByMembershipId",
      providerEntityIdPath: "providerEntityId",
      eventTimePath: "acknowledgedAt",
    },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m20.safety.sos_alert_resolved",
    category: M20_ALERT_CATEGORY,
    severityFloor: "info",
    recipientResolver: "field_safety_composed_plus_poster",
    resolverArgs: {
      clinicianMembershipIdPath: "postedByMembershipId",
      providerEntityIdPath: "providerEntityId",
      eventTimePath: "resolvedAt",
    },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m20.safety.check_in_overdue",
    category: M20_ALERT_CATEGORY,
    severityFloor: "warn",
    recipientResolver: "safety_supervisors",
    resolverArgs: { clinicianMembershipIdPath: "clinicianMembershipId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m20.safety.check_in_escalated",
    category: M20_ALERT_CATEGORY,
    severityFloor: "critical",
    recipientResolver: "field_safety_composed",
    resolverArgs: {
      clinicianMembershipIdPath: "clinicianMembershipId",
      providerEntityIdPath: "providerEntityId",
    },
    channelsOverride: null, // see the header: the tier rides the payload, not the rule
    systemLocked: true,
    enabled: true,
  },
  {
    eventType: "m20.safety.high_risk_area_entered",
    category: M20_ALERT_CATEGORY,
    severityFloor: "warn",
    recipientResolver: "safety_supervisors",
    resolverArgs: { clinicianMembershipIdPath: "clinicianMembershipId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m20.safety.incident_submitted",
    category: M20_ALERT_CATEGORY,
    severityFloor: "warn",
    recipientResolver: "safety_supervisors_plus_compliance_officer",
    resolverArgs: { clinicianMembershipIdPath: "affectedClinicianMembershipId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m20.safety.osha_reportable_incident_filed",
    category: M20_ALERT_CATEGORY,
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roles: ["compliance_officer", "director_of_nursing", "org_admin"] },
    channelsOverride: null,
    systemLocked: true,
    enabled: true,
  },
  {
    eventType: "m20.safety.policy_changed",
    category: M20_ALERT_CATEGORY,
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roles: ["director_of_nursing", "compliance_officer"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m20.safety.coverage_gap_detected",
    category: M20_ALERT_CATEGORY,
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roles: ["director_of_nursing", "org_admin"] },
    channelsOverride: null,
    systemLocked: true,
    enabled: true,
  },
];

/** The rule for an alert type. Every `SafetyAlertPayload` member has one (asserted by the §9 test). */
export function safetyAlertRuleFor(
  eventType: SafetyAlertPayload["eventType"],
): M20AlertRuleSeed | undefined {
  return M20_ALERT_RULES.find((r) => r.eventType === eventType);
}

/**
 * §4.9 — may a tenant setting suppress this alert?
 *
 * Consults the `@chartwarden/types` pinned set, NOT the local rule table (property 1). An unknown event type
 * is treated as NOT suppressible: a rule nobody has classified must not default to silenceable, and on
 * this module the failure mode of getting it backwards is a page nobody receives.
 */
export function isSafetyAlertSuppressible(eventType: string): boolean {
  if ((M20_SYSTEM_LOCKED_ALERT_TYPES as readonly string[]).includes(eventType)) return false;
  return M20_ALERT_RULES.some((r) => r.eventType === eventType);
}

// ── payload builders (one per §4.9 rule) ─────────────────────────────────────────────────────────────

/** `m20.safety.sos_alert_raised` — the Tier-1 page. */
export function buildSosRaisedAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly sosAlertId: SafetySosAlertId;
  readonly postedByMembershipId: MembershipId;
  readonly postedByFirstName: string;
  readonly postedAt: IsoInstant;
  /** Absent when M20-F16's declined-consent fallback applies — the absence IS the message. */
  readonly locationDescriptionMasked?: string;
  readonly lastKnownVisitId?: VisitId;
}): SosAlertRaisedAlert {
  return {
    eventType: "m20.safety.sos_alert_raised",
    severity: "critical",
    severityNote: "LIFE_SAFETY",
    ...input,
  };
}

/** `m20.safety.sos_alert_escalated` — one per tier advance. */
export function buildSosEscalatedAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly sosAlertId: SafetySosAlertId;
  readonly fromTier: SafetySosLifecycleState;
  readonly toTier: SafetySosLifecycleState;
  readonly escalatedAt: IsoInstant;
  readonly reasonCode: string;
}): SosAlertEscalatedAlert {
  return { eventType: "m20.safety.sos_alert_escalated", severity: "critical", ...input };
}

/**
 * `m20.safety.sos_terminus_reached` — M20-F05 / S13 / INT-031.
 *
 * `psapNumberAvailable` is a BOOLEAN, never the number: §8.8.2 keeps the PSAP number out of every outbox
 * and audit payload, and the responder's client fetches it from M40 against the jurisdiction id. A
 * `false` here is the fact a responder most needs — it means dialling emergency services is on them.
 */
export function buildSosTerminusAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly sosAlertId: SafetySosAlertId;
  readonly terminusReachedAt: IsoInstant;
  readonly loopIteration: number;
  readonly emergencyContactCallInitiated: boolean;
  readonly psapNumberAvailable: boolean;
}): SosTerminusReachedAlert {
  return { eventType: "m20.safety.sos_terminus_reached", severity: "critical", ...input };
}

/** `m20.safety.sos_alert_acknowledged` — to the composed set PLUS the original poster. */
export function buildSosAcknowledgedAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly sosAlertId: SafetySosAlertId;
  readonly acknowledgedByMembershipId: MembershipId;
  readonly acknowledgedAt: IsoInstant;
}): SosAlertAcknowledgedAlert {
  return { eventType: "m20.safety.sos_alert_acknowledged", severity: "warn", ...input };
}

/** `m20.safety.sos_alert_resolved`. */
export function buildSosResolvedAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly sosAlertId: SafetySosAlertId;
  readonly resolvedByMembershipId: MembershipId;
  readonly outcome: SafetySosOutcome;
  readonly resolvedAt: IsoInstant;
}): SosAlertResolvedAlert {
  return { eventType: "m20.safety.sos_alert_resolved", severity: "info", ...input };
}

/** `m20.safety.check_in_overdue` — the D4 gentle rung. */
export function buildCheckInOverdueAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly scheduleId: SafetyCheckInScheduleId;
  readonly clinicianMembershipId: MembershipId;
  readonly clinicianFirstName: string;
  readonly visitId?: VisitId;
  readonly kind: SafetyCheckInKind;
  readonly expectedAt: IsoInstant;
  readonly minutesOverdue: number;
}): SafetyCheckInOverdueAlert {
  return { eventType: "m20.safety.check_in_overdue", severity: "warn", ...input };
}

/** `m20.safety.check_in_escalated` — every rung above the gentle one (§7.3). */
export function buildCheckInEscalatedAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly scheduleId: SafetyCheckInScheduleId;
  readonly clinicianMembershipId: MembershipId;
  readonly clinicianFirstName: string;
  readonly visitId?: VisitId;
  readonly minutesOverdue: number;
}): SafetyCheckInEscalatedAlert {
  return { eventType: "m20.safety.check_in_escalated", severity: "critical", ...input };
}

/** `m20.safety.high_risk_area_entered` — advisory only (D12). The message is tenant-authored, ≤200 chars. */
export function buildHighRiskAreaEnteredAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly clinicianMembershipId: MembershipId;
  readonly clinicianFirstName: string;
  readonly areaId: SafetyHighRiskAreaId;
  readonly riskCategory: SafetyHighRiskCategory;
  readonly advisoryMessage: string;
  readonly enteredAt: IsoInstant;
  readonly visitId?: VisitId;
}): SafetyHighRiskAreaEnteredAlert {
  return { eventType: "m20.safety.high_risk_area_entered", severity: "warn", ...input };
}

/**
 * `m20.safety.incident_submitted`.
 *
 * The field is `severityLevel`, not `severity` — the payload's own `severity` is the M36 ALERT severity
 * (`warn`), and the incident's clinical severity is a different ladder entirely (`minor` …
 * `life_threatening`). @chartwarden/types named them apart at M20-T01 so a builder cannot collapse them; the
 * builders below take the incident value under its own name for the same reason.
 */
export function buildIncidentSubmittedAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly incidentId: SafetyIncidentId;
  readonly affectedClinicianMembershipId: MembershipId;
  readonly category: SafetyIncidentCategory;
  readonly severityLevel: SafetyIncidentSeverity;
  readonly occurredAt: IsoInstant;
  readonly oshaReportable: boolean;
}): SafetyIncidentSubmittedAlert {
  return { eventType: "m20.safety.incident_submitted", severity: "warn", ...input };
}

/**
 * `m20.safety.osha_reportable_incident_filed` — §7.6's sign-off page.
 *
 * `stateCode` and `reportingWindowHours` come from the SIGN-OFF, not from a platform table: §7.6's whole
 * point is that the classification is state-specific, and M20 holds no state-OSHA rule set. The compliance
 * officer who receives this needs to know which clock is running, and the only honest source of that
 * number is the human who classified the injury.
 */
export function buildOshaFiledAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly incidentId: SafetyIncidentId;
  readonly category: SafetyIncidentCategory;
  readonly severityLevel: SafetyIncidentSeverity;
  readonly signedOffByMembershipId: MembershipId;
  readonly stateCode: string;
  readonly reportingWindowHours: number;
}): SafetyOshaReportableIncidentFiledAlert {
  return { eventType: "m20.safety.osha_reportable_incident_filed", severity: "warn", ...input };
}

/** `m20.safety.policy_changed` — the §8.8.2 compliance read is "why did they loosen it". */
export function buildPolicyChangedAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly newVersionId: SafetyPolicyVersionId;
  readonly changedByMembershipId: MembershipId;
  readonly changeSummary: string;
}): SafetyPolicyChangedAlert {
  return { eventType: "m20.safety.policy_changed", severity: "warn", ...input };
}

/** `m20.safety.coverage_gap_detected` — nobody is paged for this clinician (§7.8). System-locked. */
export function buildCoverageGapAlert(input: {
  readonly orgId: OrgId;
  readonly providerEntityId: ProviderEntityId;
  readonly clinicianMembershipId: MembershipId;
  readonly reason: SafetyCoverageGapReason;
  readonly detectedAt: IsoInstant;
}): SafetyCoverageGapDetectedAlert {
  return { eventType: "m20.safety.coverage_gap_detected", severity: "critical", ...input };
}

/**
 * §2.7 / M20-F01 — the fallback the status surface renders when M36's alert circuit breaker is OPEN.
 *
 * Not an alert: it is what a supervisor is shown INSTEAD of one, so a human path to the field still exists
 * while the alerting fabric is down. `null` is a real answer — a tenant that configured no fallback number
 * has none, and the screen must say so rather than render an empty string that reads like a number nobody
 * dialled. M20 owns no such column, so the value is resolved from M19's `tenant_oncall_policy` through the
 * seam the composed resolver already consults; absent M19, it is `null` and the screen says so.
 */
export interface SafetyDegradedAlertFallback {
  readonly alertingDegraded: true;
  readonly emergencyContactE164: string | null;
  readonly providerEntityId: ProviderEntityId;
}
