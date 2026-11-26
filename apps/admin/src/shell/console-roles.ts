// apps/admin/src/shell — the roles that may enter the platform console (CW-AC-22). `platform_ops` was the only one; the BAA steward,
// go-live approver and pricing operator were split off it, and each works inside the console, so each is admitted. Mirrors
// `PLATFORM_ONBOARDING_ROLE_KEYS` in @chartwarden/auth (packages/auth/src/roles/templates.ts): the browser bundle imports no auth runtime,
// and console-roles.test.ts pins the two lists together. A UX guard only: the server still decides every route.
export const CONSOLE_ROLE_KEYS = [
  "platform_ops",
  "platform_baa_steward",
  "platform_go_live_approver",
  "platform_pricing_operator",
] as const;

/** True when the session's role keys include a role that works the platform console. */
export function holdsConsoleRole(roles: readonly string[] | undefined): boolean {
  return roles?.some((role) => (CONSOLE_ROLE_KEYS as readonly string[]).includes(role)) ?? false;
}
