// @chartwarden/portal — the URL prefix the SPA is served under (ADR-0049 Phase 4). On a tenant host the staff SPA owns
// `/` and the portal lives at `/portal/` of the SAME origin, so the session cookie and `/api/*` are shared and the
// portal needs no host of its own. Single source for the Vite `base`, the router basename, the magic-link return URL
// and the few raw-URL references; API calls stay same-origin absolute `/api/...` and are NOT prefixed.
export const PORTAL_BASE_PATH = "/portal";
