// apps/backend/src/modules/08-encounters/supervisor-roles.ts — the ONE set of role keys M8 treats as
// "supervisor" (route `isSupervisor` guard, the `is_author_or_supervisor` ABAC predicate, the
// cosignature-SLA cron's supervisor lookup).
//
// `director_of_nursing` is the canonical DON key (packages/auth/src/roles/templates.ts); `don` and
// `clinical_lead` are the legacy/alias keys. Same four-key set as migration 1103_m36_review_queue.sql.
// packages/messaging cannot import from apps/backend, so the cosignature alert seed rules
// (packages/messaging/src/seed/alert-rules.ts) carry a literal copy — keep the two in step
// (alert-rules-seed.test.ts pins it).
export const SUPERVISOR_ROLE_KEYS = [
  "clinical_supervisor",
  "director_of_nursing",
  "don",
  "clinical_lead",
] as const;

/** Whether any of the caller's role keys is a supervisor key (org-wide scope alone is NOT enough). */
export const hasSupervisorRole = (roles: readonly string[]): boolean =>
  SUPERVISOR_ROLE_KEYS.some((key) => roles.includes(key));
