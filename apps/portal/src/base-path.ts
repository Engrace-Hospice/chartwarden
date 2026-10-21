// @chartwarden/portal — the URL prefix the SPA is served under (ADR-0049 Phase 4). On a tenant host the staff SPA owns
// `/` and the portal lives at `/portal/` of the SAME origin, so the session cookie and `/api/*` are shared and the
// portal needs no host of its own. Single source for the Vite `base`, the router basename, the magic-link return URL
// and the few raw-URL references; API calls stay same-origin absolute `/api/...` and are NOT prefixed.
//
// Build-time knob `VITE_PORTAL_BASE`: unset => "/portal" (tenant mode, dev). Set to "" (or "/") to build the portal for
// a deployment that serves it at the ROOT of its own origin (the single-host demo's `PORTAL_APP_URL=https://portal.example`).

/** "" / "/" => "" (served at the root); "/x/" => "/x"; unset => the tenant-mode default. Pure, for the config and tests. */
export function resolvePortalBase(raw: string | undefined): string {
  if (raw === undefined) return "/portal";
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed === "" || trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

const viteEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
export const PORTAL_BASE_PATH = resolvePortalBase(viteEnv?.VITE_PORTAL_BASE);
