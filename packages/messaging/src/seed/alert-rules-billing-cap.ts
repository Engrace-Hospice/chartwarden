// @wardenx/messaging — platform-default alert rules for the billing / remittance / cap / cost-report cron
// alerts (GAP-035). Each code below is raised by a worker through `AlertEmitter.emit` (the `alertCode` of
// its `WorkerAlertPort.dispatch`); with no `alert_rule` row the emitter persists the alert with zero
// recipients (`alert-emitter-impl.ts` — "no rule -> a no-op alert"), so a missed NOE/NOTR window or an
// approaching cap reached nobody. Kept in its own file so the main seed stays reviewable; spliced into
// `PLATFORM_DEFAULT_ALERT_RULES` there. The `alert-code-seed-coverage` test fails when an emit site gains a
// code with no rule here.
import type { PlatformAlertRuleSeed } from "./alert-rules";

type Audience = Pick<PlatformAlertRuleSeed, "recipientResolver" | "resolverArgs">;

const BILLING_MANAGERS: Audience = {
  recipientResolver: "role_set",
  resolverArgs: { roleKeys: ["billing_manager"] },
};
const BILLING_AND_COMPLIANCE: Audience = {
  recipientResolver: "role_set",
  resolverArgs: { roleKeys: ["billing_manager", "compliance_officer", "org_admin"] },
};
const FINANCE_LEADS: Audience = {
  recipientResolver: "role_set",
  resolverArgs: { roleKeys: ["cfo", "billing_manager"] },
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
  // ── M26 cap crons (threshold-crossing alerts reuse the seeded `cap.approaching` rule) ─────────
  rule("m26.cap.year_close_reminder", "warn", FINANCE_LEADS),
  rule("m26.cap.psr_variance_detected", "warn", FINANCE_LEADS),
  // ── M27 §4.9 filing-deadline tiers ────────────────────────────────────────────────────────────
  rule("m27.filing_deadline.t4_months_due", "info", FINANCE_LEADS),
  rule("m27.filing_deadline.t4_5_months_due", "warn", FINANCE_LEADS),
  rule("m27.filing_deadline.t4_75_months_due", "critical", BILLING_AND_COMPLIANCE),
  rule("m27.filing_deadline.past_deadline", "critical", BILLING_AND_COMPLIANCE),
];
