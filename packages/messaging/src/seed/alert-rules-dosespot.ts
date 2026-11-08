// @chartwarden/messaging — platform-default alert rules for the M12 DoseSpot e-prescribing alerts. Each code is raised through
// `AlertEmitter.emit`; with no `alert_rule` row the emitter persists the alert with zero recipients ("no rule -> a no-op alert"), so
// a tenant whose signed prescriptions stopped reaching the pharmacy reached nobody. Kept in its own file so the main seed stays
// reviewable; spliced into `PLATFORM_DEFAULT_ALERT_RULES` there. The `alert-code-seed-coverage` test fails when one is missing.
//
// The audience is the tenant's administrators for all three: they own the registration, can ask the platform operator to look at it,
// and decide when to fall back to the downtime prescribing procedure. (A platform operator is told through the platform's own paging,
// not through a tenant's alert rule.)
import type { PlatformAlertRuleSeed } from "./alert-rule-seed-type";

function rule(
  eventType: string,
  severityFloor: PlatformAlertRuleSeed["severityFloor"],
  channelsOverride: PlatformAlertRuleSeed["channelsOverride"],
): PlatformAlertRuleSeed {
  return {
    eventType,
    category: "administrative",
    severityFloor,
    recipientResolver: "tenant_admins",
    resolverArgs: {},
    channelsOverride,
    systemLocked: false,
    enabled: true,
  };
}

export const DOSESPOT_ALERT_RULES: readonly PlatformAlertRuleSeed[] = [
  // The circuit breaker opened, the org's configuration could not be opened, or signed orders have waited over an hour (M36 `dosespot-alerts`).
  rule("m12.dosespot_degraded", "critical", null),
  // The paired notice (`alert` has no open/resolved state to auto-resolve).
  rule("m12.dosespot_recovered", "info", ["in_app"]),
  // A NewRx call whose outcome DoseSpot did not confirm (an unreadable 2xx, a lost send answer, a send 5xx but 503): the order is held (never retried) until a person checks DoseSpot (M36 `dosespot-alerts`).
  rule("m12.medication_order.transmission_unconfirmed", "critical", null),
  // A signed prescription exhausted its retry budget (or an administrator resolved a held one as never sent): it has not reached the pharmacy and the
  // prescriber must retransmit it. Described as "M36 high-severity" since the worker was written, and consumed by nobody until `dosespot-alerts`.
  rule("m12.medication_order.transmission_failed", "critical", null),
  // ADR-0110: a tenant's clinic registration stopped being active (deactivated, or its credential changed): newly signed orders activate
  // locally and queued ones wait. Raised directly by the clinic service after its commit; before this rule it reached nobody.
  rule("m12.dosespot_config.deactivated", "warn", null),
];
