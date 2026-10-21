// @chartwarden/messaging — platform-default alert rules seed (M36-T05; spec §3.10, §7.4).
//
// The platform-floor routing layer: `alert_rule` rows with a NULL organization_id every tenant
// inherits unless it clones + overrides (§3.10). Three are `system_locked` — SOS (life-safety),
// NOE late-risk (revenue-critical), and backup-failure (data-safety) — and tenants CANNOT disable
// them (§7.4, enforced in the service + the migration-0334 trigger (GAP-102, tighten-only); this seed
// is the source of which rules carry the flag). Kept as typed, pure data (the same place the
// resolution engine lives, M36-T04) so the §7.4 invariants are unit-assertable without live infra
// and the boot slice can UPSERT it. The `severityFloor` here is the legacy `alert_severity`
// ladder on `alert_rule` (§3.2), distinct from the `alert_payload_severity` catalog ladder (§3.11).
import type { AlertCategory, AlertRecipientResolver, AlertSeverity } from "../interfaces/kinds";
import type { ResolverArgs } from "../resolution";
import type { PlatformAlertRuleSeed } from "./alert-rule-seed-type";
import { BILLING_CAP_ALERT_RULES } from "./alert-rules-billing-cap";

export type { PlatformAlertRuleSeed } from "./alert-rule-seed-type";

/**
 * The platform-default alert rules (§3.10). Each org's effective catalog is the union of these
 * rows plus its own overrides; cloning to per-org rows happens on first override edit. The three
 * `system_locked` rules are always-on regardless of tenant config (§7.4).
 */
export const PLATFORM_DEFAULT_ALERT_RULES: readonly PlatformAlertRuleSeed[] = [
  {
    eventType: "m36.message.mentioned",
    category: "clinical_routine",
    severityFloor: "info",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: [], userIdPaths: ["mentionedUserId"] },
    // Mention notifications are deliberately in-app only: no message/patient context leaves ChartWarden.
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.task.created",
    category: "clinical_routine",
    severityFloor: "info",
    recipientResolver: "role_set",
    // WP 3.4: the assignee is told, in-app only, with generic text (no message, channel or patient).
    resolverArgs: { roleKeys: [], userIdPaths: ["assigneeUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.task.reassigned",
    category: "clinical_routine",
    severityFloor: "info",
    recipientResolver: "role_set",
    // WP 3.4: only the NEW assignee is told, in-app only, with generic text.
    resolverArgs: { roleKeys: [], userIdPaths: ["toUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.task.needs_owner",
    category: "clinical_routine",
    severityFloor: "info",
    recipientResolver: "role_set",
    // WP 3.4: the creator is told a task lost its owner, in-app only, with generic text.
    resolverArgs: { roleKeys: [], userIdPaths: ["creatorUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.message.urgent_sent",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    // WP 4.1: the named recipient of an urgent clinical message is told, in-app only, with generic text (no patient, no
    // name, no message). This is NOT a page and NOT an acknowledgment request (WP 4.2 - 4.4). WP 4.6 (ADR-0073) adds this alert's out-of-band routes in CODE (the platform floor, behind `messaging.notification_policy`); the rule itself stays in-app only.
    resolverArgs: { roleKeys: [], userIdPaths: ["recipientUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.ack.requested",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    // WP 4.2: the assignee of an IMPORTANT acknowledgment request is told, in-app only, with generic text (an urgent message has
    // its own m36.message.urgent_sent alert; the consumer sends nothing for that class). NOT a page and NOT the emergency path.
    resolverArgs: { roleKeys: [], userIdPaths: ["recipientUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.ack.reassigned",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    // WP 4.2: the NEW assignee of a reassigned request is told, in-app only, with generic text. Out-of-band routes come from the WP 4.6 policy in code (ADR-0073), not from this rule.
    resolverArgs: { roleKeys: [], userIdPaths: ["recipientUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.ack.supervisor_reassigned",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    // ADR-0078: a supervisor moved a waiting request; the previous assignee and the sender are told, in-app only, with generic text. NOT a
    // designated safety route (the new assignee's alert is the m36.ack.reassigned one) and never out-of-band.
    resolverArgs: { roleKeys: [], userIdPaths: ["recipientUserIds"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.ack.escalated",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    // WP 4.4: the tier's clinician an unacknowledged request was escalated to is told, in-app only, with generic text. Out-of-band
    // delivery is WP 4.6. NOT a page and NOT the emergency path.
    resolverArgs: { roleKeys: [], userIdPaths: ["recipientUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.ack.route_unavailable",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    // WP 4.4: the deadline passed and no tier could be reached; the sender and the current assignee are told it is still open.
    resolverArgs: { roleKeys: [], userIdPaths: ["recipientUserIds"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.ack.ladder_exhausted",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    // WP 4.4: no further tier exists; the sender and the assignee are told it is still open. The supervisor audience is told by
    // m36.ack.supervisor_attention (ADR-0079), not by this rule, so a supervisor gets one alert per event, not two.
    resolverArgs: { roleKeys: [], userIdPaths: ["recipientUserIds"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.ack.failed_unreachable",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    // WP 4.5: every out-of-band route to the assignee failed and no further tier could be reached. The sender and the assignee are
    // told it is still open and that nobody is known to have been reached. The supervisor audience is told by
    // m36.ack.supervisor_attention (ADR-0079).
    resolverArgs: { roleKeys: [], userIdPaths: ["recipientUserIds"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.ack.supervisor_attention",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    // ADR-0079 (G-3/G-5): a request no human is known to be handling (ladder exhausted, router unavailable, unreachable, or unreachable
    // and still unwatched) is raised to the supervisor audience (role keys copied from m36.medication_question.unrouted; tenants
    // re-aim it through the alert-rule admin; NOT pinned). In-app always; with `messaging.notification_policy` + `messaging.ack_requests`
    // on, the platform floor of the request's class adds an out-of-band page to each supervisor's VERIFIED endpoint (SUPERVISOR_PAGE_EVENT_TYPES).
    // Fixed generic text; no vendor transport exists, so a planned page can still fail (the ops notice says so).
    resolverArgs: { roleKeys: ["clinical_supervisor", "don"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.medication_question.unrouted",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "role_set",
    // WP 3.10: supervisors are told a medication question has no assigned nurse. Org-wide by role (role keys copied from
    // m36.handoff.supervisor_review); tenants re-aim it through the alert-rule admin. In-app only, never the emergency path.
    resolverArgs: { roleKeys: ["clinical_supervisor", "don"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.handoff.offered",
    category: "clinical_routine",
    severityFloor: "info",
    recipientResolver: "role_set",
    // WP 3.5: the receiver is told a handoff is waiting, in-app only, with generic text (no patient, no item).
    resolverArgs: { roleKeys: [], userIdPaths: ["toUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.handoff.accepted",
    category: "clinical_routine",
    severityFloor: "info",
    recipientResolver: "role_set",
    // WP 3.5: the sender is told items were accepted, in-app only.
    resolverArgs: { roleKeys: [], userIdPaths: ["fromUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.handoff.unaccepted",
    category: "clinical_routine",
    severityFloor: "info",
    recipientResolver: "role_set",
    // WP 3.5: the sender is told items were not accepted and stay with them, in-app only.
    resolverArgs: { roleKeys: [], userIdPaths: ["fromUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.handoff.no_supervisor",
    category: "clinical_routine",
    severityFloor: "info",
    recipientResolver: "role_set",
    // WP 3.5: the sender is told no supervisor could be reached about an unaccepted handoff (loud fallback).
    resolverArgs: { roleKeys: [], userIdPaths: ["fromUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.handoff.supervisor_review",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "role_set",
    // WP 3.5: supervisors are told a handoff went unaccepted. Org-wide by role; tenants re-aim it through the alert-rule admin.
    resolverArgs: { roleKeys: ["clinical_supervisor", "don"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.review.queued",
    category: "clinical_routine",
    severityFloor: "warn",
    recipientResolver: "role_set",
    // WP 3.8: supervisors are told open messaging tasks wait for a decision after a patient left care. Org-wide by role; tenants re-aim it through the alert-rule admin.
    resolverArgs: { roleKeys: ["clinical_supervisor", "don"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.review.task_needs_decision",
    category: "clinical_routine",
    severityFloor: "info",
    recipientResolver: "role_set",
    // WP 3.8: each affected assignee is told their task needs a decision (always-on fallback to the supervisor alert), in-app only.
    resolverArgs: { roleKeys: [], userIdPaths: ["assigneeUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.promotion.decided",
    category: "clinical_routine",
    severityFloor: "info",
    recipientResolver: "role_set",
    // WP 3.7: the requester is told a chart promotion was accepted or not accepted, in-app only, generic text.
    resolverArgs: { roleKeys: [], userIdPaths: ["requestedByUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.promotion.review_requested",
    category: "clinical_routine",
    severityFloor: "info",
    recipientResolver: "role_set",
    // WP 3.7: one care-team clinician who can sign an addendum is told a proposal is waiting (the consumer picks them), in-app only.
    resolverArgs: { roleKeys: [], userIdPaths: ["reviewerUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.promotion.idg_review_requested",
    category: "clinical_routine",
    severityFloor: "info",
    recipientResolver: "permission_holders",
    // WP 3.7: IDG coordinators are told a proposal is waiting. Org-wide by permission, with NO tenant-admin fallback so an empty audience reaches the requester (no_reviewer).
    resolverArgs: { permissionKeys: ["idg.coordinate"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.promotion.no_reviewer",
    category: "clinical_routine",
    severityFloor: "info",
    recipientResolver: "role_set",
    // WP 3.7: the requester is told no reviewer could be reached (loud fallback), in-app only.
    resolverArgs: { roleKeys: [], userIdPaths: ["requestedByUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.message.schedule_blocked",
    category: "clinical_routine",
    severityFloor: "info",
    recipientResolver: "role_set",
    // WP 2.6: only the SENDER of the scheduled message is told, and only in-app with generic text (no channel/patient).
    resolverArgs: { roleKeys: [], userIdPaths: ["senderUserId"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m36.reminder.due",
    category: "clinical_routine",
    severityFloor: "info",
    recipientResolver: "role_set",
    // WP 4.10 (ADR-0077): only the person who set the reminder is told, with fixed generic text and an in-app link. No override, so the
    // user's own routing map decides any out-of-band copy, and that copy is the sanitiser's fixed generic line with an opaque link.
    resolverArgs: { roleKeys: [], userIdPaths: ["recipientUserId"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
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
  // GAP-035 — the M23 window/ack crons, M25 denial/appeal crons, M26 cap crons and M27 filing-deadline tiers.
  ...BILLING_CAP_ALERT_RULES,
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
  // GAP-086 — the MLLP listener supervisor could not bind an ACTIVE inbound feed for a reason other than a BAA gate
  // refusal (cleartext protocol refused in production, no/undecryptable mTLS credential, port unavailable). No inbound HL7
  // is being accepted on that feed, so the audience is the one that can fix the feed: compliance + org admins.
  {
    eventType: "external_feed.listener_blocked",
    category: "administrative",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // GAP-043 — an ACTIVE inbound HL7 feed went silent (no frame for the §4.11.5 down-threshold) while its listener is
  // not serving (`evaluateListenerCircuit` tripped OPEN). Inbound ADT / lab results are not arriving: same audience as
  // `listener_blocked` — the people who can fix the feed.
  {
    eventType: "external_feed.listener_down",
    category: "administrative",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  },
  // GAP-043 - the paired notice: a feed whose `listener_down` page went out is serving again. `alert` has no
  // open/resolved state to auto-resolve (only an `outcome`), so recovery is announced to the same audience instead.
  {
    eventType: "external_feed.listener_recovered",
    category: "administrative",
    severityFloor: "info",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
    channelsOverride: ["in_app"],
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
  // ── M36 break-glass (WP 5.8, ADR-0087 PROPOSED) ────────────────────────────────────────────────────────────────────
  // `m36.break_glass.granted` is published in the grant's own transaction and delivered by M36's `break-glass-notifications` consumer, one
  // fixed-text alert (no name, channel or reason) per grant. Warn, to the holders of messaging.break_glass.review, with the tenant
  // administrators as the backstop when nobody holds it (permissions are granted per tenant, never by template alone). `system_locked`: a
  // self-approved read of a conversation the reader is not in is an audit-critical override, so a tenant may tighten this rule but never
  // disable, downgrade or re-route it (GAP-102 tighten-only floor), exactly like m3.breakglass.invoked.
  {
    eventType: "m36.break_glass.granted",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "permission_holders",
    resolverArgs: {
      permissionKeys: ["messaging.break_glass.review"],
      fallbackToTenantAdmins: true,
    },
    channelsOverride: null,
    systemLocked: true,
    enabled: true,
  },
  // A break-glass review still open three days after its grant ended (ADR-0087 D5, a default pending compliance confirmation): the hourly
  // `break_glass_review_sweep` raises it once per review. Same audience and same lock as the grant alert: an unanswered review is the
  // control failing, so a tenant may tighten it but never disable or re-route it.
  {
    eventType: "m36.break_glass.review_overdue",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "permission_holders",
    resolverArgs: {
      permissionKeys: ["messaging.break_glass.review"],
      fallbackToTenantAdmins: true,
    },
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
  // M4 §4.4 / §11.1 `audit.integrity_mismatch` — the sampled audit hash-chain verification (`audit.integrity_sample`)
  // found a sealed month whose live rows no longer hash to its `audit_seal` (or a broken `prev_chain_hash` link):
  // the append-only log was altered out of band. `critical`, to the Security Officer + Compliance Officer + org
  // admin on every channel the recipient has (in-app, push, email); raised by the M4 job through AlertEmitter.
  // Payload: run id, partition names and break reasons only — no row content, no PHI.
  {
    eventType: "m4.audit.integrity_mismatch",
    category: "administrative",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["hipaa_security_officer", "compliance_officer", "org_admin"] },
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
  // GAP-049 (M30 spec §4.9) — the quality alerts raised by M36's `quality-alerts` outbox consumer (sentinel / abuse
  // incident submitted, outbreak opened, threshold breached, CAHPS sample ready) and by the M30
  // `review_overdue_sweep` cron (mortality review due, CoP re-attestation overdue). Previously rule-less, so no
  // m30.* event ever reached a person. Payloads are ids / enums / counts only — no PHI.
  {
    eventType: "m30.alerts.incident_sentinel",
    category: "administrative",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: {
      roleKeys: ["administrator", "compliance_officer", "medical_director", "qapi_coordinator"],
    },
    channelsOverride: ["in_app", "push", "email"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m30.alerts.incident_abuse_allegation",
    category: "administrative",
    severityFloor: "critical",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["administrator", "compliance_officer", "medical_director"] },
    channelsOverride: ["in_app", "push", "email"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m30.alerts.outbreak_detected",
    category: "clinical_urgent",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["infection_control_lead", "medical_director", "administrator"] },
    channelsOverride: ["in_app", "push", "email"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m30.alerts.measure_threshold_breached",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["qapi_coordinator", "medical_director"] },
    channelsOverride: ["in_app", "push"],
    systemLocked: false,
    enabled: true,
  },
  // GAP-049 - the safety-page safety net. A quality alert whose role_set resolved to NOBODY (the tenant never
  // provisioned `qapi_coordinator` / `infection_control_lead`, or the holders are all inactive) is persisted with no
  // deliveries and its correlation id is then spent, so a repeat would be absorbed too. The consumer and the repeat sweep
  // therefore re-emit the SAME page, once, under this event type and a `:fb` correlation id, to the tenant admins.
  {
    eventType: "m30.alerts.recipient_fallback",
    category: "administrative",
    severityFloor: "info",
    recipientResolver: "tenant_admins",
    resolverArgs: {},
    channelsOverride: ["in_app", "push", "email"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m30.alerts.cahps_sample_ready",
    category: "administrative",
    severityFloor: "info",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["qapi_coordinator"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m30.alerts.mortality_review_due",
    category: "administrative",
    severityFloor: "info",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["medical_director", "qapi_coordinator"] },
    channelsOverride: ["in_app"],
    systemLocked: false,
    enabled: true,
  },
  {
    eventType: "m30.alerts.cop_review_overdue",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["compliance_officer", "administrator"] },
    channelsOverride: ["in_app", "push"],
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
  // GAP-068 — M40 §4.7.2: the NPPES source deactivated a physician record this organisation prefers. Raised by
  // the M40 NPPES consumer / fallback job through AlertEmitter; without a rule the emit persists an alert with
  // recipientCount 0. Tenant admins + referral/intake coordinators, in-app + email; payload `{ canonicalId, npi,
  // kind, deepLink, message }` — an NPI is a public identifier, no PHI.
  {
    eventType: "mdm.physician_deactivated",
    category: "administrative",
    severityFloor: "warn",
    recipientResolver: "role_set",
    resolverArgs: { roleKeys: ["org_admin", "intake_coordinator", "intake_supervisor"] },
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
  "m36.break_glass.granted",
  "m36.break_glass.review_overdue",
  "m20.safety.coverage_gap_detected",
  "m19.oncall.coverage_gap_detected",
  "m37.shift.rn_uncovered",
] as const;

/** Row shape the boot slice UPSERTs into `alert_rule` (mirrors the Drizzle columns, §3.6).
 *  Structural (no `@chartwarden/db` import) so the package stays a leaf; `organizationId` is null for
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
