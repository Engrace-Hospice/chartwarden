// @wardenx/messaging — platform-default alert rules seed (M36-T05; spec §3.10, §7.4).
//
// The platform-floor routing layer: `alert_rule` rows with a NULL organization_id every tenant
// inherits unless it clones + overrides (§3.10). Three are `system_locked` — SOS (life-safety),
// NOE late-risk (revenue-critical), and backup-failure (data-safety) — and tenants CANNOT disable
// them (§7.4, enforced at the DB by the M36-T03 RLS `WITH CHECK system_locked = false`; this seed
// is the source of which rules carry the flag). Kept as typed, pure data (the same place the
// resolution engine lives, M36-T04) so the §7.4 invariants are unit-assertable without live infra
// and the boot slice can UPSERT it. The `severityFloor` here is the legacy `alert_severity`
// ladder on `alert_rule` (§3.2), distinct from the `alert_payload_severity` catalog ladder (§3.11).
import type {
  AlertCategory,
  AlertRecipientResolver,
  AlertSeverity,
  NotificationChannel,
} from "../interfaces/kinds";
import type { ResolverArgs } from "../resolution";

/** One platform-default `alert_rule` (organization_id IS NULL). Typed against the §3.2 enum
 *  unions so `tsc` rejects an invalid category/severity/resolver/channel at authoring time. */
export interface PlatformAlertRuleSeed {
  readonly eventType: string;
  readonly category: AlertCategory;
  readonly severityFloor: AlertSeverity;
  readonly recipientResolver: AlertRecipientResolver;
  readonly resolverArgs: ResolverArgs;
  /** null ⇒ use recipient preferences (no channel override, §3.6). */
  readonly channelsOverride: readonly NotificationChannel[] | null;
  /** true ⇒ tenants cannot disable or loosen this rule (§7.4). */
  readonly systemLocked: boolean;
  readonly enabled: boolean;
}

/**
 * The platform-default alert rules (§3.10). Each org's effective catalog is the union of these
 * rows plus its own overrides; cloning to per-org rows happens on first override edit. The three
 * `system_locked` rules are always-on regardless of tenant config (§7.4).
 */
export const PLATFORM_DEFAULT_ALERT_RULES: readonly PlatformAlertRuleSeed[] = [
  // ── Tier-1: SOS — system_locked, voice in channels (§2.5 voice is SOS-only) ──────────────
  {
    eventType: "field_safety.sos",
    category: "field_safety",
    severityFloor: "critical",
    recipientResolver: "on_call",
    resolverArgs: { providerEntityIdPath: "providerEntityId" },
    channelsOverride: ["in_app", "push", "sms", "voice"],
    systemLocked: true,
    enabled: true,
  },
  // ── Tier-2: clinical urgent ──────────────────────────────────────────────────────────────
  {
    eventType: "m10.hope.sfv_created",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "scheduler"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m10.hope.sfv_overdue",
    category: "clinical_urgent",
    severityFloor: "critical",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m10.hope.sfv_missed",
    category: "clinical_urgent",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "compliance_officer"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m10.hope.timepoint_expired",
    category: "clinical_routine",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "compliance_officer"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "emar.dose_missed",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "patient.hospitalization_risk_high",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "patient.pps_drop_20",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // ── clinical routine ─────────────────────────────────────────────────────────────────────
  {
    eventType: "admission.recert_window_opening",
    category: "clinical_routine",
    severityFloor: "info",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "admission.f2f_due",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m6.admission.discharged",
    category: "clinical_routine",
    severityFloor: "critical",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // ── operational ──────────────────────────────────────────────────────────────────────────
  {
    eventType: "visit.late",
    category: "operational",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "scheduler"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m17.visit.cancelled",
    category: "operational",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "scheduler"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m17.visit.rescheduled",
    category: "operational",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "scheduler"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m17.visit.no_show_detected",
    category: "operational",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "scheduler"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m17.stale_visit_detected",
    category: "operational",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "scheduler"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // F-187 (#248) — a lab order superseded (discontinued / replaced by a corrected order) after its ORM may already
  // be at the laboratory. T-29.08 defines no outbound cancel, so this is the ONLY signal — the care team has to
  // cancel it with the lab. Ids only in the payload (`patientId` is the care-team resolver path).
  {
    eventType: "m11.order.lab_cancellation_required",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m8.encounter.unsigned",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m8.encounter.documentation_late",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m8.encounter.cosignature_routed",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "don"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m8.encounter.cosignature_overdue",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "don"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m8.encounter.cosignature_escalated",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "don"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m8.encounter.cosignature_hard_cap_reached",
    category: "clinical_urgent",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "don"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "evv.geofence_violation",
    category: "operational",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "scheduler"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // ── administrative ───────────────────────────────────────────────────────────────────────
  {
    eventType: "claim.denied",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["billing_manager", "biller"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "cap.approaching",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["cfo", "billing_manager"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "noe.late_risk",
    category: "administrative",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["billing_manager", "org_admin"] },
    channelsOverride: null,
    systemLocked: true,
    enabled: true,
  },
  // ── system ───────────────────────────────────────────────────────────────────────────────
  {
    eventType: "system.integration_failure",
    category: "system",
    severityFloor: "warn",
    recipientResolver: "tenant_admins",
    resolverArgs: {},
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "system.ai_cost_threshold",
    category: "system",
    severityFloor: "warn",
    recipientResolver: "tenant_admins",
    resolverArgs: {},
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "system.backup_failure",
    category: "system",
    severityFloor: "critical",
    recipientResolver: "tenant_admins",
    resolverArgs: {},
    channelsOverride: null,
    systemLocked: true,
    enabled: true,
  },
  // ── M29 outbound lab-order transmission (F-188, #248; spec §5.3) ────────────────────────────────────────
  // Until F-188 none of these three kinds had a rule: the worker's alerts (also mis-typed, see
  // `29-external-interfaces/outbound/alert-routing.ts`) reached nobody. Audiences follow the §5.3 table: a failed
  // outbound ORM → "operator-on-call, M11 owners" (a tenant's operator is its `org_admin`; M11's owners are the
  // clinical leads who own lab orders); a BAA refusal on outbound → "compliance officer", with `org_admin` as the
  // backstop for a tenant that has no compliance-officer role assigned (a lapse blocks EVERY lab send for the feed).
  {
    eventType: "hl7_outbound.transmission_failed",
    category: "operational",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["org_admin", "clinical_lead"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // F-191 — the ESCALATION for a failure storm: raised once per (feed, window) when the count of failures crosses the
  // threshold. Same audience as the failure it escalates, floor `critical`; a separate kind because the failure alert
  // of that window has already paged and M36 (rightly) never re-pages a deduped alert.
  {
    eventType: "hl7_outbound.transmission_storm",
    category: "operational",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["org_admin", "clinical_lead"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "external_feed.baa_expired",
    category: "administrative",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "external_feed.baa_missing",
    category: "administrative",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // ── M11 stuck lab-order recovery (F-193, #248) ─────────────────────────────────────────────────────────────────────
  // A lab order that failed AFTER its HL7 message was built (`dlq_exhausted`, F-183's "held, delivery unverified",
  // `application_reject`, `recovery_blocked:*`) may already be at the laboratory, so it is never retried automatically: a
  // person verifies with the lab and attests (F-188). Before F-193 nothing said one was waiting. The audience is the people
  // who can act — a tenant's operator (`org_admin`) and the clinical leads who own lab orders (the §5.3 "operator, M11
  // owners" pairing F-188 used for the outbound-failure alert). Warn at 4 h, critical at 24 h (the emit severity carries the
  // stage; ids + a fixed reason token only in the payload).
  {
    eventType: "m11.order.transmission_held_aging",
    category: "operational",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["org_admin", "clinical_lead"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // The auto-retry sweep gave up on an order refused before any outbound row existed (attempts or window used up): the
  // configuration cause it was waiting out never cleared, so a person must fix it and resend. Raised ONCE per order.
  {
    eventType: "m11.order.transmission_auto_retry_exhausted",
    category: "operational",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["org_admin", "clinical_lead"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // F-194 (#248) — the two-person control on the attested lab-transmission recovery. Every EXECUTED
  // `not_received_by_lab` recovery (a re-dispatch that orders the test twice if the attestation was wrong) and every
  // lapsed / cancelled pending request goes to compliance, with `org_admin` as the backstop for a tenant that has no
  // compliance-officer role assigned. The emitter routes at max(input, floor): an executed recovery warns, and the
  // producer raises it to `critical` when the same requester keeps filing them. Ids and counts only in the payload.
  {
    eventType: "m11.order.recovery_executed",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m11.order.recovery_expired",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m11.order.recovery_cancelled",
    category: "administrative",
    severityFloor: "info",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // F-195 (#248) — the collusion / rate signal on the two-person lab-recovery control: a requester/co-signer pair that keeps
  // executing `not_received_by_lab` recoveries, or a high org-wide rate. Always critical (the floor), deduplicated per
  // window by the emit's correlation id, ids and counts only. Same audience as the other recovery alerts.
  {
    eventType: "m11.order.recovery_anomaly",
    category: "administrative",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
];

/** The event types of the three `system_locked` platform rules (§7.4) — the always-on floor a
 *  tenant can neither disable nor loosen: SOS, NOE late-risk, backup-failure. */
export const SYSTEM_LOCKED_EVENT_TYPES = [
  "field_safety.sos",
  "noe.late_risk",
  "system.backup_failure",
] as const;

/** Row shape the boot slice UPSERTs into `alert_rule` (mirrors the Drizzle columns, §3.6).
 *  Structural (no `@wardenx/db` import) so the package stays a leaf; `organizationId` is null for
 *  every platform-default row. */
export interface PlatformAlertRuleRow {
  readonly organizationId: null;
  readonly eventType: string;
  readonly category: AlertCategory;
  readonly severityFloor: AlertSeverity;
  readonly recipientResolver: AlertRecipientResolver;
  readonly resolverArgs: ResolverArgs;
  readonly channelsOverride: string[] | null;
  readonly systemLocked: boolean;
  readonly enabled: boolean;
}

/** Project the seed into the `alert_rule` rows the boot UPSERT inserts (organization_id NULL). */
export function toNewAlertRuleRows(
  rules: readonly PlatformAlertRuleSeed[] = PLATFORM_DEFAULT_ALERT_RULES,
): PlatformAlertRuleRow[] {
  return rules.map((r) => ({
    organizationId: null,
    eventType: r.eventType,
    category: r.category,
    severityFloor: r.severityFloor,
    recipientResolver: r.recipientResolver,
    resolverArgs: r.resolverArgs,
    channelsOverride: r.channelsOverride === null ? null : [...r.channelsOverride],
    systemLocked: r.systemLocked,
    enabled: r.enabled,
  }));
}

/** A §7.4/§3.10 invariant the boot slice asserts before UPSERTing the seed. */
export interface AlertRuleSeedViolation {
  readonly eventType: string;
  readonly type: "missing_system_locked" | "system_locked_disabled" | "duplicate_event_type";
  readonly detail: string;
}

/**
 * Validate the platform-default seed's §7.4/§3.10 invariants (pure, no DB): every
 * {@link SYSTEM_LOCKED_EVENT_TYPES} rule is present AND `systemLocked = true` AND `enabled = true`
 * (an always-on life-safety/data-safety floor can never ship disabled), and no event type is
 * seeded twice. Returns every violation (empty ⇒ valid).
 */
export function validateAlertRuleSeed(
  rules: readonly PlatformAlertRuleSeed[] = PLATFORM_DEFAULT_ALERT_RULES,
): AlertRuleSeedViolation[] {
  const violations: AlertRuleSeedViolation[] = [];
  const byEvent = new Map<string, PlatformAlertRuleSeed>();
  for (const r of rules) {
    if (byEvent.has(r.eventType)) {
      violations.push({
        eventType: r.eventType,
        type: "duplicate_event_type",
        detail: `event type '${r.eventType}' is seeded more than once`,
      });
    }
    byEvent.set(r.eventType, r);
  }
  for (const eventType of SYSTEM_LOCKED_EVENT_TYPES) {
    const r = byEvent.get(eventType);
    if (!r) {
      violations.push({
        eventType,
        type: "missing_system_locked",
        detail: `system_locked rule '${eventType}' is missing from the platform-default seed (§7.4)`,
      });
      continue;
    }
    if (!r.systemLocked || !r.enabled) {
      violations.push({
        eventType,
        type: "system_locked_disabled",
        detail: `'${eventType}' must be seeded systemLocked=true and enabled=true (§7.4); got systemLocked=${r.systemLocked} enabled=${r.enabled}`,
      });
    }
  }
  return violations;
}

/** Boot gate: throw if the platform-default alert rules violate the §7.4/§3.10 invariants. */
export function assertAlertRuleSeedValid(
  rules: readonly PlatformAlertRuleSeed[] = PLATFORM_DEFAULT_ALERT_RULES,
): void {
  const violations = validateAlertRuleSeed(rules);
  if (violations.length > 0) {
    const lines = violations.map((v) => `  • [${v.type}] ${v.detail}`).join("\n");
    throw new Error(
      `platform-default alert rule seed invalid (${violations.length} violation(s)) — M36 boot refuses to start:\n${lines}`,
    );
  }
}
