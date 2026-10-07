// @wardenx/messaging — platform-default alert rules seed (M36-T05; spec §3.10, §7.4).
//
// The platform-floor routing layer: `alert_rule` rows with a NULL organization_id every tenant
// inherits unless it clones + overrides (§3.10). Three are `system_locked` — SOS (life-safety),
// NOE late-risk (revenue-critical), and backup-failure (data-safety) — and tenants CANNOT disable
// them (§7.4, enforced in the service + the migration-0334 trigger (GAP-102, tighten-only); this seed
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
  // GAP-039/040 — M13's deadline alerts (`36-messaging/outbox-consumers/emar-alerts.ts`); `emar.dose_missed`
  // above is the missed-dose rule. Recipients: the patient's care team (payload `patientId`).
  {
    eventType: "m13.prn_reassessment.overdue",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m13.reconciliation.due_at_warning",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m13.reconciliation.overdue",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m13.comfort_kit.return_overdue",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // GAP-061 — M20's check-in watchdog alerts (`36-messaging/outbox-consumers/field-safety-alerts.ts`). An alert
  // rule has ONE resolver and `role_set` cannot express the M19 on-call roster, so the escalation pages two
  // ways: `check_in_escalated` reaches the supervisor/DON role set, and the consumer raises a SECOND alert,
  // `m20.safety.check_in_escalated_oncall`, resolved by `on_call` (the M19 roster for the provider entity).
  // That event type is an alert-rule key only — NOT an outbox catalog event. The coverage-gap rule follows M20
  // spec §4.9 (critical, DON + org-admin) and is system-locked (migration 0346 flips an already-seeded row).
  {
    eventType: "m20.safety.check_in_overdue",
    category: "field_safety",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_supervisor", "clinical_lead"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m20.safety.check_in_escalated",
    category: "field_safety",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_supervisor", "clinical_lead", "don"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m20.safety.check_in_escalated_oncall",
    category: "field_safety",
    severityFloor: "critical",
    recipientResolver: "on_call",
    resolverArgs: { providerEntityIdPath: "providerEntityId" },
    channelsOverride: ["in_app", "push", "sms"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m20.safety.coverage_gap_detected",
    category: "field_safety",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["don", "org_admin"] },
    channelsOverride: null,
    systemLocked: true,
    enabled: true,
  },
  // GAP-105 — M37's §4.8 watchdog alerts (`36-messaging/outbox-consumers/ipu-alerts.ts`). The payloads carry no
  // patient id (unit / admission / bed scoped), so each resolves a `role_set`. `cap_breached` is the spec's
  // block-severity alert (`critical` on the legacy ladder) and blocks billing at the ABAC gate, so it reaches
  // compliance as well as nursing leadership.
  {
    eventType: "m37.irc_episode.cap_approaching",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "don"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m37.irc_episode.cap_breached",
    category: "clinical_urgent",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["don", "compliance_officer", "org_admin"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m37.restraint.reassessment_due",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_supervisor", "clinical_lead", "don"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m37.bed.cleaning_overdue",
    category: "operational",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "don"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m37.gip_criteria.reassessment_due",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "don"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // Batch 11 — the remaining M37 §4.8/§4.9 alerts (same consumer). Spec recipients named roles this platform has
  // no key for (charge nurse, admissions coordinator, facilities manager, medical director): they resolve to the
  // nearest platform role set (`clinical_lead` / `don` / `org_admin`) until those roles exist. `rn_uncovered` is
  // the block-severity CoP 418.100 24/7-RN alert, so it is system-locked (migration 0363 flips a seeded row).
  {
    eventType: "m37.shift.rn_uncovered",
    category: "clinical_urgent",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["don", "clinical_lead", "org_admin"] },
    channelsOverride: null,
    systemLocked: true,
    enabled: true,
  },
  {
    eventType: "m37.shift.coverage_gap_projected",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["don", "clinical_lead"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m37.equipment.inspection_due",
    category: "operational",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "org_admin"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m37.equipment.inspection_overdue",
    category: "operational",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["org_admin", "don"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m37.nursing_note.shift_overdue",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "don"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m37.bed.reservation_expired",
    category: "operational",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "don"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m37.ipu_admission.transfer_unconfirmed",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_lead", "don"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // GAP-057 — M19's coverage-gap watchdog page (`36-messaging/outbox-consumers/oncall-alerts.ts`). M19 spec
  // §4.9: critical, `role_set` of org_admin + clinical_supervisor, system-locked — an uncovered clinical_rn
  // window is the CoP 418.100(c)(2) hole no tenant setting may silence (migration 0352 flips an already-seeded row).
  {
    eventType: "m19.oncall.coverage_gap_detected",
    category: "clinical_urgent",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["org_admin", "clinical_supervisor"] },
    channelsOverride: null,
    systemLocked: true,
    enabled: true,
  },
  // GAP-057 follow-up — M19's §4.8 SLA crons (`36-messaging/outbox-consumers/oncall-alerts.ts`). The callback
  // breach is the §4.9 `m19.triage.callback_sla_breached` rule verbatim (warn, `on_call`, NOT locked). The
  // escalation-SLA page is not in §4.9: it reaches the supervisory role set (an unacknowledged escalation
  // means the tier's own recipient did not answer, so paging that same recipient again would be circular);
  // the consumer raises it at `critical` for a mandatory (D7) row. Unlocked, like every §4.9 rule the spec
  // does not name locked (a user decision whether the mandatory case should be — flagged in the M19 changelog).
  {
    eventType: "m19.triage.callback_sla_breached",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "on_call",
    resolverArgs: { providerEntityIdPath: "providerEntityId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m19.triage.escalation_sla_breached",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["clinical_supervisor", "don", "org_admin"] },
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
  // FY2027 (CMS-1851-F) — the 42 CFR 418.24(d) election statement addendum window passed unfurnished
  // (`36-messaging/outbox-consumers/admission-compliance-alerts.ts`). The addendum is a condition for payment,
  // so the miss pages the patient's care team AND the compliance/clinical leads (a second rule, the
  // m20 `check_in_escalated_oncall` two-audience precedent).
  {
    eventType: "m6.election_addendum.overdue",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m6.election_addendum.overdue_compliance",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "clinical_lead"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // GAP-026 — any other compliance window (CTI, NOR, assessments, care plan, recert) passing its due time.
  {
    eventType: "m6.compliance.window.overdue",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m6.compliance.window.overdue_compliance",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "clinical_lead"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // GAP-118 — a §164.526 amendment request nearing / past its 60-day deadline
  // (`36-messaging/outbox-consumers/amendment-sla-alerts.ts`). Records-management work, so it pages the privacy
  // officer and compliance, not the care team.
  {
    eventType: "m5.patient.amendment_sla_due_soon",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["hipaa_privacy_officer", "compliance_officer"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m5.patient.amendment_sla_overdue",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["hipaa_privacy_officer", "compliance_officer"] },
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
  // GAP-071 — M24 §4.10 `medicaid.eligibility.stale_at_assembly` (severity warn, audience biller_for_pe): the
  // eligibility-stale-watchdog cron's per-patient alert. `biller_for_pe`: the billers/billing managers
  // assigned to the patient's provider entity (the payload's `providerEntityId` ↔ the member's default PE);
  // only when nobody is assigned to that PE (or the check carries none) does it fall back to the org-wide
  // billing_manager, so a standing stale check never pages every biller in the org yet never goes unseen.
  {
    eventType: "medicaid.eligibility.stale_at_assembly",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: {
      providerEntityIdPath: "providerEntityId",
      providerEntityScopedRoleKeys: ["billing_manager", "biller"],
      providerEntityFallbackRoleKeys: ["billing_manager"],
    },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // GAP-084 — M28 §4.9 `fhir.inbound.proposal_overdue`: the `fhir.inbound-sla-watch` cron expired a staged inbound
  // proposal nobody reviewed inside the tenant's SLA (W-FHIR-06 "alert to Compliance Officer"). Org Admin is the
  // fallback holder so an org with no Compliance Officer role assigned still sees it.
  {
    eventType: "fhir.inbound.proposal_overdue",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // M23 — the MAC rejected a Notice of Election / Notice of Termination-Revocation (999 syntax or 277CA content
  // reject), raised by the ack-pull crons with the PHI-free reason codes. A rejected NOE leaves the election
  // unfiled (the claim cannot bill) and a rejected NOTR leaves the prior election open (a readmission's NOE is
  // rejected), so it pages the billers of the notice's provider entity; org-wide billing_manager is the fallback.
  ...(["m23.noe.rejected", "m23.notr.rejected"] as const).map(
    (eventType): PlatformAlertRuleSeed => ({
      eventType,
      category: "administrative",
      severityFloor: "critical",
      recipientResolver: "role_set",
      resolverArgs: {
        providerEntityIdPath: "providerEntityId",
        providerEntityScopedRoleKeys: ["billing_manager", "biller"],
        providerEntityFallbackRoleKeys: ["billing_manager"],
      },
      channelsOverride: null,
      systemLocked: false,
      enabled: true,
    }),
  ),
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
  // F-199 — the ESCALATION for a failure storm: raised once per (feed, window) when the count of failures crosses the
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
  // ── M3 break-glass (GAP-010; M3 spec §4.5/§7.4) ────────────────────────────────────────────────────────────────────
  // `m3.breakglass.invoked` is published in the invoke's own transaction and delivered by M36's
  // `breakglass-alert` outbox consumer. Critical, to the Compliance Officer with `org_admin` as the backstop for a
  // tenant that has no compliance-officer role assigned. `system_locked` (§7.4): a break-glass invocation is the
  // audit-critical override of access control, so a tenant may tighten this rule but never disable, downgrade or
  // re-route it (GAP-102 tighten-only floor).
  {
    eventType: "m3.breakglass.invoked",
    category: "administrative",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
    channelsOverride: null,
    systemLocked: true,
    enabled: true,
  },
  // ── M11 stuck lab-order recovery (F-201, #248) ─────────────────────────────────────────────────────────────────────
  // A lab order that failed AFTER its HL7 message was built (`dlq_exhausted`, F-183's "held, delivery unverified",
  // `application_reject`, `recovery_blocked:*`) may already be at the laboratory, so it is never retried automatically: a
  // person verifies with the lab and attests (F-188). Before F-201 nothing said one was waiting. The audience is the people
  // who can act — a tenant's operator (`org_admin`) and the clinical leads who own lab orders (the §5.3 "operator, M11
  // owners" pairing F-188 used for the outbound-failure alert). Warn at 4 h, critical at 24 h (the emit severity carries the
  // stage; ids + a fixed reason token only in the payload).
  // GAP-032 — the verbal-order pre-expiry (12h warn / 2h critical) and lab-results-overdue sweeps.
  {
    eventType: "m11.order.verbal_expiring_soon",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m11.order.results_overdue",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
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
  // F-202 (#248) — the two-person control on the attested lab-transmission recovery. Every EXECUTED
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
  // F-203 (#248) — the collusion / rate signal on the two-person lab-recovery control: a requester/co-signer pair that keeps
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
  // M14 §2.7 / D8 — an IDG action item was carried forward into its THIRD distinct non-cancelled meeting (the
  // count CROSSING 3; the producer flags the crossing, the consumer raises ONE alert per action item). The catalog
  // names the resolver `idg_compliance_inbox` (alerts-by-m14.ts); M36 resolves it as a `role_set` — the compliance
  // inbox (`compliance_officer`), the clinical supervisor (`clinical_supervisor`), the `org_admin` backstop for a
  // tenant that assigns neither — plus the target meeting's coordinator off the payload (`coordinatorUserId`).
  // Always critical (the floor); ids and counts only in the payload. Channels follow the catalog's defaults
  // (inbox -> in_app, socket_push -> push, email).
  {
    eventType: "m14.action_item.carry_forward.compliance",
    category: "administrative",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: {
      roleKeys: ["compliance_officer", "clinical_supervisor", "org_admin"],
      userIdPaths: ["coordinatorUserId"],
    },
    channelsOverride: ["in_app", "push", "email"],
    systemLocked: false,
    enabled: true,
  },
  // ── M14 typed IDG alerts (alerts-by-m14.ts). The catalog names its resolvers `idg_meeting_attendees`,
  // `idg_action_item_assignee`, `idg_meeting_coordinator` and `idg_compliance_inbox`; none is a value of the closed
  // `alert_recipient_resolver` enum — M36 owns what they mean (ADR-0024) and realises each as a `role_set` over the
  // audience the producer-side consumer resolved onto the payload (ACTIVE org members' USER ids, ids only):
  //   attendees  -> `attendeeUserIds` (array)  |  assignee -> `assigneeUserId`  |  coordinator -> `coordinatorUserId`.
  // M14 §4.10: the T-24h "packets ready" reminder to the meeting's expected attendees (per MEETING, not per packet).
  {
    eventType: "m14.packets.ready",
    category: "operational",
    severityFloor: "info",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: [], userIdPaths: ["attendeeUserIds"] },
    channelsOverride: ["in_app", "push"],
    systemLocked: false,
    enabled: true,
  },
  // M14 §4.10: an action item was assigned — the DM-style notice to the assignee (with its due date).
  {
    eventType: "m14.action_item.created",
    category: "operational",
    severityFloor: "info",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: [], userIdPaths: ["assigneeUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  // M14 §4.10: a decision was recorded without quorum — the low-severity notice to the IDG coordinator.
  {
    eventType: "m14.decision.non_quorate",
    category: "operational",
    severityFloor: "info",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: [], userIdPaths: ["coordinatorUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  // M14-F01 / ADR-0018 D2 — the per-patient 15-day review-clock escalation. The audience is TIERED by stage (spec §4.9
  // / §7.14): T-3 the coordinator; T-0 + the clinical supervisor; T+1 + the compliance inbox. The consumer puts the
  // tier's extra role keys on the payload (`audienceRoleKeys`) and the coordinator's user id (`coordinatorUserId`);
  // one rule serves all three tiers. The emit severity carries the tier (warn at T-3, critical at T-0/T+1).
  {
    eventType: "m14.review_clock.escalated",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: {
      roleKeys: [],
      roleKeysPath: "audienceRoleKeys",
      userIdPaths: ["coordinatorUserId"],
    },
    channelsOverride: ["in_app", "email"],
    systemLocked: false,
    enabled: true,
  },
  // M14-F01: an audited CANCEL/RESCHEDULE override of the review-floor guard — the compliance audit alert
  // (compliance inbox + clinical supervisor, `org_admin` backstop for a tenant that assigns neither).
  {
    eventType: "m14.review_floor.override_recorded",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "clinical_supervisor", "org_admin"] },
    channelsOverride: ["in_app", "email"],
    systemLocked: false,
    enabled: true,
  },
  // GAP-107 — M37 §2.6/D7's `iv-bedside-check-watchdog` (`36-messaging/outbox-consumers/ipu-iv-alerts.ts`): a
  // running IV infusion on an IPU patient went a full bedside-check interval unchecked. Warn, to the patient's
  // care team (the primary IPU nurse is on it) via the payload's `patientId`.
  {
    eventType: "m37.iv_safety_overlay.bedside_check_overdue",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "care_team",
    resolverArgs: { patientIdPath: "patientId" },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // GAP-108 — M38 §4.3 `terminology.tenant_deprecation_scan` / §7.3 / §8.1: after a code-system load that deprecated
  // codes, each tenant whose records still use them is told once (warn, the Compliance Officer + org admin; in-app +
  // email — a coding-compliance exposure, not a page). Raised by the M38 worker through AlertEmitter, so there is no
  // outbox consumer; the payload is counts + up to ten code strings (reference data, no PHI).
  {
    eventType: "m38.tenant_deprecation_scan.completed",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
    channelsOverride: ["in_app", "email"],
    systemLocked: false,
    enabled: true,
  },
  // GAP-155 (M30 spec 4.9) - the SRA reminder calendar (m30.sra_reminders cron emits these payload types as the
  // event type) and the CAP-overdue alert (m30.cap_overdue_scan cron). Previously rule-less, so an emit reached nobody.
  // sra_due_30 also carries the 7-day milestone (the payload catalog has no sra_due_7).
  {
    eventType: "m30.alerts.sra_due_90",
    category: "administrative",
    severityFloor: "info",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["hipaa_security_officer", "compliance_officer"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m30.alerts.sra_due_60",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["hipaa_security_officer", "compliance_officer", "administrator"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m30.alerts.sra_due_30",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["hipaa_security_officer", "compliance_officer", "administrator"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m30.alerts.sra_overdue",
    category: "administrative",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["administrator", "org_admin", "compliance_officer"] },
    channelsOverride: ["in_app", "push", "email"],
    systemLocked: false,
    enabled: true,
  },
  // GAP-171 — M39 §2.2.3 / §4.10: a consent-revocation cascade exhausted its retry budget with a consumer still
  // un-ACKed (`partial_failed`). A revoked consent that some surface still honours is a privacy exposure, so it is
  // `critical` and goes to the Compliance Officer + org admin on in-app + email. Raised by the M39
  // `revocation_cascade_retry` cron / manual retry through AlertEmitter (no outbox consumer). Payload: ids and
  // consumer names only — no PHI.
  {
    eventType: "m39.consent.revoked_cascade_failed",
    category: "administrative",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
    channelsOverride: ["in_app", "email"],
    systemLocked: false,
    enabled: true,
  },
  // GAP-173 — M40 §4.3 `mdm.baa_expiration_scan` / §4.4: a facility/payer BAA is 90, 30 or 0 days from expiry.
  // Once it lapses the §7.7 gate denies disclosure to that entity, so the Compliance Officer + org admin hear
  // about it in time to renew. The scan's own severity ladder (info / warn / critical per window) is the input
  // severity; this rule's floor is `info` so the 90-day heads-up is not inflated. Raised through AlertEmitter
  // by the M40 daily cron (no outbox consumer); payload is a BAA record id + entity ref + dates, no PHI.
  // GAP-173 — M40 §4.4 `mdm.license_expiring` (Phase 1: from manual entry): a physician/credential license is 90, 30
  // or 0 days from expiry. Compliance Officer + org admin, in-app + email; payload `{ physicianId, state,
  // daysUntilExpiry }` + entity ref and window, no PHI. Raised by the M40 daily cron through AlertEmitter.
  {
    eventType: "mdm.license_expiring",
    category: "administrative",
    severityFloor: "info",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
    channelsOverride: ["in_app", "email"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m30.incident.cap_overdue",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["qapi_coordinator", "compliance_officer", "clinical_lead"] },
    channelsOverride: ["in_app", "push", "email"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "mdm.baa_expiring",
    category: "administrative",
    severityFloor: "info",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
    channelsOverride: ["in_app", "email"],
    systemLocked: false,
    enabled: true,
  },
];

/** The event types of the `system_locked` platform rules (§7.4) — the always-on floor a
 *  tenant can neither disable nor loosen: SOS, NOE late-risk, backup-failure, M3 break-glass, and the
 *  M20 coverage-gap alert (nobody is subscribed to be paged for a field clinician's safety; migration 0346). */
export const SYSTEM_LOCKED_EVENT_TYPES = [
  "field_safety.sos",
  "noe.late_risk",
  "system.backup_failure",
  "m3.breakglass.invoked",
  "m20.safety.coverage_gap_detected",
  "m19.oncall.coverage_gap_detected",
  "m37.shift.rn_uncovered",
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
