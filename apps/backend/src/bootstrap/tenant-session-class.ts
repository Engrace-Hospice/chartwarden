// apps/backend/src/bootstrap/tenant-session-class.ts — ADR-0049 Phase 4: portal and staff share one Better Auth cookie
// on a tenant host (no second portal cookie), so the separation is enforced by SESSION CLASS in one onRequest hook.
//
//   a portal-class session (patient / caregiver / bereaved) may reach `/api/v1/portal/*` and the session plumbing only;
//   a staff-class session may not reach `/api/v1/portal/*` - except the pre-bind sign-in routes, which an ordinary
//   signed-in user must call to become a portal session in the first place.
//
// Registered right after the tenant-host guard and acting only where that guard stamped `tenantHostOrgId`, so the demo
// (single host) and the apex / reserved hosts are untouched. The class is read from the authenticate hook's stamp.
import { ChartWardenError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";

const PORTAL_CLASSES: ReadonlySet<string> = new Set(["patient_portal", "caregiver_portal", "bereaved_portal"]);
const PORTAL_PREFIX = "/api/v1/portal/";
const PORTAL_SIGN_IN_PREFIX = "/api/v1/portal/sign-in/";
/** What a portal session may reach besides the portal API: session plumbing, health, public routes. */
const PORTAL_SESSION_ALLOWED_PREFIXES: readonly string[] = [
  PORTAL_PREFIX,
  "/api/auth/",
  "/api/v1/auth/",
  "/api/v1/public/",
  "/health",
  "/ready",
];

export type SessionClassPathVerdict = "allowed" | "portal-session-on-staff-path" | "staff-session-on-portal-path";

export function sessionClassPathVerdict(sessionClass: string | undefined, pathname: string): SessionClassPathVerdict {
  if (!sessionClass) return "allowed";
  if (PORTAL_CLASSES.has(sessionClass)) {
    const ok = pathname === "/api/v1/portal" || PORTAL_SESSION_ALLOWED_PREFIXES.some((p) => pathname.startsWith(p));
    return ok ? "allowed" : "portal-session-on-staff-path";
  }
  if (sessionClass === "staff") {
    const onPortal = pathname === "/api/v1/portal" || pathname.startsWith(PORTAL_PREFIX);
    return onPortal && !pathname.startsWith(PORTAL_SIGN_IN_PREFIX) ? "staff-session-on-portal-path" : "allowed";
  }
  return "allowed";
}

export async function tenantSessionClassGuard(request: FastifyRequest): Promise<void> {
  const attrs = request.context.attributes;
  if (!attrs?.tenantHostOrgId) return;
  const sessionClass = typeof attrs.sessionClass === "string" ? attrs.sessionClass : undefined;
  const pathname = request.url.split("?")[0] ?? "";
  if (sessionClassPathVerdict(sessionClass, pathname) === "allowed") return;
  throw new ChartWardenError(
    "SESSION_CLASS_MISMATCH",
    "this session cannot be used here; sign in again for this part of ChartWarden",
    401,
  );
}
