// apps/backend/src/bootstrap/onboarding-org-gate.ts — what a session on a NOT-YET-LIVE organization may call.
//
// WHY THIS EXISTS. A new tenant's first admin has to sign in to finish onboarding and to attest go-live readiness, but the
// organization stays `created` (M2 §11 D19) until the platform operator approves go-live. Clinical and PHI routes are NOT gated
// on the tenant's own status anywhere else: they trust "the organization is active". So the organization is NOT activated
// early to let the admin in (that would open charting before the two-party go-live); instead `select-organization` admits a
// `created` organization whose tenant is provisioning/onboarding, and THIS gate keeps such a session to an allowlist.
//
// THE ALLOWLIST IS EXACT `METHOD + ROUTE TEMPLATE` PAIRS, matched on the template Fastify resolved (`request.routeOptions.url`,
// e.g. `/api/v1/tenant/onboarding/:taskId/start`), the way `AUDITOR_ENROLMENT_ROUTES` (plugins/authenticate.ts) does. A root
// prefix (`/api/v1/tenant`, `/api/v1/orgs`, ...) was too wide: it exposed the DSAR / tenant export downloads, the support-consent
// grants, the care-team staff list, member credentials and direct user provisioning to a session that is not live yet. Listed
// here is only what onboarding needs: sign-in, session and step-up plumbing; the M34 tenant wizard (onboarding steps, org profile,
// compliance officer, go-live attestation, account, BAA attestation); and the identity administration its staffing steps need
// (members, invitations, role grants, provider entities, locations). `bootstrap/onboarding-org-gate-routes.test` (apps/backend/
// __tests__/onboarding-org-gate-routes.test.ts) fails when an entry names a route that does not exist.
//
// FAIL CLOSED, twice over. It is an ALLOWlist: a route added later is refused until someone adds it here on purpose. And a request
// that matched no route (a 404 has no template) is refused rather than judged by its URL. The one exception is the vendor auth
// catch-all (Better Auth mounts a single `/api/auth/*` wildcard, so it has no per-endpoint template): it is admitted only for a
// path that decodes cleanly and stays under `/api/auth/` (a dotted, backslashed or undecodable path is refused).
import { ChartWardenError } from "@chartwarden/types";

/** The exact `METHOD /template` pairs a session on a not-yet-live organization may call. */
export const PRE_ACTIVATION_ALLOWED_ROUTES: ReadonlySet<string> = new Set([
  // ── sign-in, session and step-up plumbing ───────────────────────────────────────────────────────────────
  "GET /api/v1/auth/context",
  "GET /api/v1/auth/credential-status",
  "GET /api/v1/auth/csrf",
  "GET /api/v1/auth/memberships",
  "POST /api/v1/auth/password/complete-required-change",
  "POST /api/v1/auth/select-organization",
  "POST /api/v1/auth/unlock",
  "GET /api/v1/me/permissions",
  "GET /api/v1/me/session",
  "POST /api/v1/sessions/step-up", // the go-live attestation requires a fresh one
  "POST /api/v1/sessions/step-up/initiate",
  "GET /health",
  "GET /ready",
  // ── M34 tenant wizard ───────────────────────────────────────────────────────────────────────────────────
  "GET /api/v1/tenant/onboarding",
  "POST /api/v1/tenant/onboarding/:taskId/attest",
  "POST /api/v1/tenant/onboarding/:taskId/block",
  "POST /api/v1/tenant/onboarding/:taskId/complete", // the deprecated alias of /attest, still called by existing clients
  "POST /api/v1/tenant/onboarding/:taskId/reopen",
  "POST /api/v1/tenant/onboarding/:taskId/start",
  "PATCH /api/v1/tenant/org-profile",
  "PUT /api/v1/tenant/compliance-officer",
  "POST /api/v1/tenant/go-live/attest",
  "GET /api/v1/tenant/account",
  "GET /api/v1/tenant/baa",
  "POST /api/v1/tenant/baa/:id/attest",
  // ── the identity administration the wizard's staffing steps need ────────────────────────────────────────
  "GET /api/v1/orgs/:id/members",
  "GET /api/v1/orgs/:id/invitations",
  "POST /api/v1/orgs/:id/invitations",
  "DELETE /api/v1/orgs/:id/invitations/:invId",
  "POST /api/v1/orgs/:id/invitations/:invId/resend",
  "GET /api/v1/roles",
  "GET /api/v1/memberships/:id/roles",
  "POST /api/v1/memberships/:id/roles",
  "DELETE /api/v1/memberships/:id/roles/:rid",
  // ── the wizard's provider-entity and location steps ─────────────────────────────────────────────────────
  "GET /api/v1/provider-entities",
  "POST /api/v1/provider-entities",
  "GET /api/v1/provider-entities/:id",
  "PATCH /api/v1/provider-entities/:id",
  "GET /api/v1/locations",
  "POST /api/v1/locations",
  "GET /api/v1/locations/:id",
  "PATCH /api/v1/locations/:id",
]);

/** The one wildcard template admitted by path rather than by name: Better Auth's catch-all (packages/auth identity/mount.ts). */
export const VENDOR_AUTH_ROUTE_TEMPLATE = "/api/auth/*";
const VENDOR_AUTH_ROOT = "/api/auth";

/** True when `rawUrl` (query ignored) decodes cleanly and stays under the vendor auth root, with no dot segment or backslash. */
function isCleanVendorAuthPath(rawUrl: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(rawUrl.split("?")[0] ?? "");
  } catch {
    return false;
  }
  if (path.includes("\\") || path.split("/").includes("..")) return false;
  return path.startsWith(`${VENDOR_AUTH_ROOT}/`);
}

/**
 * True when a session on a not-yet-live organization may call this request: its method and the route template Fastify matched
 * are an allowlisted pair. `routeTemplate` is `request.routeOptions.url`; absent (no route matched) is refused.
 */
export function preActivationMayCall(input: {
  readonly method: string;
  readonly routeTemplate: string | undefined;
  readonly rawUrl: string;
}): boolean {
  const { routeTemplate } = input;
  if (!routeTemplate) return false;
  if (routeTemplate === VENDOR_AUTH_ROUTE_TEMPLATE) return isCleanVendorAuthPath(input.rawUrl);
  return PRE_ACTIVATION_ALLOWED_ROUTES.has(`${input.method.toUpperCase()} ${routeTemplate}`);
}

/** The refusal for everything else: a typed 403 carrying no organization data. */
export function organizationOnboardingRefusal(): ChartWardenError {
  return new ChartWardenError(
    "ORGANIZATION_ONBOARDING",
    "this organization is still being onboarded; only onboarding, go-live, account and sign-in routes are available until go-live is approved",
    403,
  );
}

/**
 * What the authenticate hook asks: is this org-bound session on an organization that is NOT live (anything but `active`)? Such a
 * session is confined to the allowlist above. `created` is the onboarding case; `suspended`, `closed` and an unknown or unreadable
 * status are confined too (their sessions are revoked and a fresh bind is refused, so this is the third line, and it fails closed).
 */
export interface OrganizationStageReader {
  isConfined(organizationId: string): Promise<boolean>;
}

/** The `organization.status` reader the cache wraps (M2's lifecycle writer's `getStatus`). */
type OrganizationStatusRead = (
  organizationId: string,
) => Promise<"created" | "active" | "suspended" | "closed" | null>;

const STAGE_CACHE_TTL_MS = 5_000;

/**
 * The per-request reader, cached briefly so the gate costs about one indexed read per organization per few seconds. A
 * stale answer is bounded by the TTL and errs the safe way after go-live (a few seconds of the allowlist); `invalidate` makes
 * the activation visible at once. A read that throws propagates: the request fails closed rather than skipping the gate.
 */
export function createOrganizationStageReader(
  readStatus: OrganizationStatusRead,
  options: { readonly ttlMs?: number; readonly now?: () => number } = {},
): OrganizationStageReader & { invalidate(organizationId: string): void } {
  const ttlMs = options.ttlMs ?? STAGE_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { readonly confined: boolean; readonly at: number }>();
  return {
    async isConfined(organizationId) {
      const hit = cache.get(organizationId);
      if (hit && now() - hit.at < ttlMs) return hit.confined;
      const confined = (await readStatus(organizationId)) !== "active";
      cache.set(organizationId, { confined, at: now() });
      return confined;
    },
    invalidate(organizationId) {
      cache.delete(organizationId);
    },
  };
}
