// @wardenx/messaging — platform seed barrel (M36-T05; spec §3.10, §7.4). The platform-default
// alert rules (with the three §7.4 `system_locked` floors) the boot slice UPSERTs into
// `alert_rule`, plus the §7.4 invariant validators.
export {
  PLATFORM_DEFAULT_ALERT_RULES,
  SYSTEM_LOCKED_EVENT_TYPES,
  toNewAlertRuleRows,
  validateAlertRuleSeed,
  assertAlertRuleSeedValid,
  type PlatformAlertRuleSeed,
  type PlatformAlertRuleRow,
  type AlertRuleSeedViolation,
} from "./alert-rules";

// M36-T09 — the six §3.13 platform-floor notification templates (ADR-0024, moved from M14) the
// boot slice UPSERTs into `notification_template`, plus the §3.13 seed invariant validators.
export {
  PLATFORM_NOTIFICATION_TEMPLATES,
  toNewNotificationTemplateRows,
  validateNotificationTemplateSeed,
  assertNotificationTemplateSeedValid,
  type PlatformNotificationTemplateRow,
  type NotificationTemplateSeedViolation,
} from "./notification-templates";
