// @chartwarden/messaging — platform-default alert rules for the billing / remittance / cap / cost-report cron
// alerts (GAP-035). Each code below is raised by a worker through `AlertEmitter.emit` (the `alertCode` of
// its `WorkerAlertPort.dispatch`); with no `alert_rule` row the emitter persists the alert with zero
// recipients (`alert-emitter-impl.ts` — "no rule -> a no-op alert"), so a missed NOE/NOTR window or an
// approaching cap reached nobody. Kept in its own file so the main seed stays reviewable; spliced into
// `PLATFORM_DEFAULT_ALERT_RULES` there. The `alert-code-seed-coverage` test fails when an emit site gains a
// code with no rule here.
import type { PlatformAlertRuleSeed } from "./alert-rule-seed-type";

type Audience = Pick<PlatformAlertRuleSeed, "recipientResolver" | "resolverArgs">;

const BILLING_MANAGERS: Audience = {
  recipientResolver: "role_set",
  resolverArgs: { roleKeys: ["billing_manager"] },
};
const BILLING_AND_COMPLIANCE: Audience = {
  recipientResolver: "role_set",
  resolverArgs: { roleKeys: ["billing_manager", "compliance_officer", "org_admin"] },
};
// GAP-040 - the M26 cap audiences are "whoever holds `cap.event.read`" (exact key, resolved live from the tenant's
// own role grants), NOT a hand-made `cfo` / `billing_manager` role: neither is a role template, and no template
// grants `cap.event.read`, so those role keys resolved nobody in a fresh tenant. The org administrators are the
// floor (`fallbackToTenantAdmins`), so a cap alert is never addressed to an empty audience; a breach additionally
// keeps the compliance-officer and org-admin escalation the previous seed intended.
const CAP_PERMISSION_KEYS = ["cap.event.read"];
const CAP_EVENT_HOLDERS: Audience = {
  recipientResolver: "permission_holders",
  resolverArgs: { permissionKeys: CAP_PERMISSION_KEYS, fallbackToTenantAdmins: true },
};
const CAP_HOLDERS_AND_COMPLIANCE: Audience = {
  recipientResolver: "permission_holders",
  resolverArgs: {
    permissionKeys: CAP_PERMISSION_KEYS,
    alsoRoleKeys: ["compliance_officer", "org_admin"],
    fallbackToTenantAdmins: true,
  },
};
const FINANCE_LEADS: Audience = {
  recipientResolver: "role_set",
  resolverArgs: { roleKeys: ["cfo", "billing_manager"] },
};
const FINANCE_AND_COMPLIANCE: Audience = {
  recipientResolver: "role_set",
  resolverArgs: { roleKeys: ["cfo", "billing_manager", "compliance_officer", "org_admin"] },
};
const TENANT_ADMINS: Audience = { recipientResolver: "tenant_admins", resolverArgs: {} };

function rule(
  eventType: string,
  severityFloor: PlatformAlertRuleSeed["severityFloor"],
  audience: Audience,
): PlatformAlertRuleSeed {
  return {
    eventType,
    category: "administrative",
    severityFloor,
    ...audience,
    channelsOverride: null,
    systemLocked: false,
    enabled: true,
  };
}

/** The alert codes M23 / M25 / M26 / M27 raise from their crons and consumers, each with a seeded rule. */
export const BILLING_CAP_ALERT_RULES: readonly PlatformAlertRuleSeed[] = [
  // ── M23 §4.9 window-watch / ack / eligibility / portal crons ──────────────────────────────────
  rule("m23.noe.window_breached", "critical", BILLING_AND_COMPLIANCE),
  rule("m23.noe.window_warning", "warn", BILLING_MANAGERS),
  rule("m23.notr.window_breached", "critical", BILLING_AND_COMPLIANCE),
  rule("m23.notr.window_warning", "warn", BILLING_MANAGERS),
  rule("m23.claim.submission_stalled", "critical", BILLING_MANAGERS),
  rule("m23.eligibility.expired", "warn", BILLING_MANAGERS),
  // Platform-status events: the composition root fans them out once per active org.
  rule("m23.mac_portal.unavailable", "critical", TENANT_ADMINS),
  rule("m23.mac_portal.recovered", "info", TENANT_ADMINS),
  rule("m23.taxonomy.unmapped_taxonomy_alert", "warn", BILLING_MANAGERS),
  // ── M25 denial aging + appeal deadline crons ──────────────────────────────────────────────────
  rule("denial.aging_threshold_breached", "warn", BILLING_MANAGERS),
  rule("denial.high_value", "critical", BILLING_MANAGERS),
  rule("appeal.deadline_approaching", "warn", BILLING_MANAGERS),
  rule("adr.deadline_approaching", "warn", BILLING_MANAGERS),
  // Milestone 4: a QIC reconsideration past its recorded decision date; escalation to OMHA is now available.
  rule("appeal.qic_decision_overdue", "warn", BILLING_MANAGERS),
  // Milestone 6a: a filing made outside WardenX whose receipt (confirmation reference) was never recorded.
  rule("submission.proof_missing", "warn", BILLING_MANAGERS),
  // ── M26 band escalations (GAP-040): raised by M36's `cap-threshold-alerts` consumer of
  // `m26.cap.threshold_crossed`. Watch/warn page finance leads; a breach also pages compliance + org admins.
  ...(["agency", "patient"] as const).flatMap((family) => [
    rule(`m26.cap.${family}_watch_90`, "warn", CAP_EVENT_HOLDERS),
    rule(`m26.cap.${family}_warn_95`, "warn", CAP_EVENT_HOLDERS),
    rule(`m26.cap.${family}_breach_100`, "critical", CAP_HOLDERS_AND_COMPLIANCE),
  ]),
  rule("m26.cap.inpatient_watch_18", "warn", CAP_EVENT_HOLDERS),
  rule("m26.cap.inpatient_breach", "critical", CAP_HOLDERS_AND_COMPLIANCE),
  // ── M26 cap crons ──────────────────────────────────────────────────────────────────────────────
  rule("m26.cap.year_close_reminder", "warn", CAP_EVENT_HOLDERS),
  rule("m26.cap.psr_variance_detected", "warn", CAP_EVENT_HOLDERS),
  // ── M27 §4.9 filing-deadline tiers ────────────────────────────────────────────────────────────
  rule("m27.filing_deadline.t4_months_due", "info", FINANCE_LEADS),
  rule("m27.filing_deadline.t4_5_months_due", "warn", FINANCE_LEADS),
  rule("m27.filing_deadline.t4_75_months_due", "critical", BILLING_AND_COMPLIANCE),
  rule("m27.filing_deadline.past_deadline", "critical", BILLING_AND_COMPLIANCE),
];
