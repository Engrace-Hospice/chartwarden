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
// compliance officer, go-live attestation, account, BAA attestation); the tenant clearinghouse, MAC credential and pricing-read
// routes the billing steps need; and the identity administration its staffing steps need (members, invitations, role grants,
// provider entities, locations). `bootstrap/onboarding-org-gate-routes.test` (apps/backend/
// __tests__/onboarding-org-gate-routes.test.ts) fails when an entry names a route that does not exist.
//
// FAIL CLOSED, twice over. It is an ALLOWlist: a route added later is refused until someone adds it here on purpose. And a request
// that matched no route (a 404 has no template) is refused rather than judged by its URL. The one exception is the vendor auth
// catch-all (Better Auth mounts a single `/api/auth/*` wildcard, so it has no per-endpoint template): it is admitted only for a
// path that decodes cleanly and stays under `/api/auth/` (a dotted, backslashed or undecodable path is refused).
import { ChartWardenError } from "@chartwarden/types";

/** The exact `METHOD /template` pairs a session on ANY confined organization (created, suspended, closed, unreadable) may call. */
const CONFINED_ROUTES: readonly string[] = [
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
  "POST /api/v1/tenant/onboarding/:taskId/skip", // the organization's own skip of MAC credentials, payer enrollment or DoseSpot kickoff (step-up, Idempotency-Key)
  "POST /api/v1/tenant/onboarding/:taskId/start",
  "PATCH /api/v1/tenant/org-profile",
  "PUT /api/v1/tenant/compliance-officer",
  "POST /api/v1/tenant/go-live/attest",
  "GET /api/v1/tenant/account",
  "GET /api/v1/tenant/baa",
  "POST /api/v1/tenant/baa/:id/attest",
  // ── consented support safety controls (read/terminate only; no new PHI grant) ───────────────────────────
  "GET /api/v1/tenant/support-consent-grants",
  "POST /api/v1/tenant/support-consent-grants/:id/revoke",
  "GET /api/v1/tenant/support-sessions",
  "GET /api/v1/tenant/support-sessions/:id/events",
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
  // ── M34 help requests (slice 7): file, read, approve (consent) and end. Through these four a confined organization can
  // create only a non-PHI `assist` grant; the generic grant-issue route remains refused, while the safety routes above let the
  // tenant inspect and terminate existing support access. The service refuses ChartWarden staff, auditor and family sessions and
  // AI principals on every help-request route.
  "GET /api/v1/tenant/help-requests",
  "POST /api/v1/tenant/help-requests",
  "POST /api/v1/tenant/help-requests/:id/approve",
  "POST /api/v1/tenant/help-requests/:id/close",
];

/**
 * The billing steps (7: clearinghouse, 8: MAC credential, and the plan the tenant reads on step 2), open ONLY while the organization is
 * `created`. They reach PHI-routing configuration (a vendor, a sealed credential, an activation), so the third line the other pairs rely
 * on (a suspended or closed organization has its sessions revoked and a fresh bind refused) is not enough: the gate asks the reader
 * whether the organization is `created` and refuses these for any other confined stage.
 *
 * The tenant settles these itself, so its session has to reach them before go-live. Every write keeps its own guards (the
 * billing.clearinghouse / billing.mac_credential permission, a fresh step-up, the AI-actor block, an Idempotency-Key). The
 * clearinghouse writes and the MAC credential save also void a pending go-live attestation in their own transaction (the MAC /test
 * probe only stamps a timestamp and does not). Exact pairs, no prefix.
 *
 * DELIBERATELY NOT in either list, so a confined session still cannot reach them: the generic support-consent-grant issue route
 * (it would let a not-yet-live organization issue PHI-scoped consent), the DSAR and tenant export downloads, and every other
 * `/api/v1/billing/*` and `/api/v1/subscription/*` route (claims, rate tables, payers: clinical billing opens at go-live with the
 * rest of the app). The read/revoke and session-ledger safety routes are in the confined list above.
 */
export const CREATED_ONLY_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/v1/tenant/clearinghouse",
  "PUT /api/v1/tenant/clearinghouse",
  "POST /api/v1/tenant/clearinghouse/baa",
  "POST /api/v1/tenant/clearinghouse/verify",
  "POST /api/v1/tenant/clearinghouse/activate",
  "GET /api/v1/subscription/pricing", // the tenant's own plan and latest statement, read-only (it cannot change a contract)
  "GET /api/v1/billing/mac-credentials",
  "GET /api/v1/billing/mac-credentials/:providerEntityId",
  "POST /api/v1/billing/mac-credentials",
  "POST /api/v1/billing/mac-credentials/:providerEntityId/test",
]);

/** Every pair a not-yet-live session may call at some stage: the confined list plus the `created`-only billing steps. */
export const PRE_ACTIVATION_ALLOWED_ROUTES: ReadonlySet<string> = new Set([
  ...CONFINED_ROUTES,
  ...CREATED_ONLY_ROUTES,
]);

/** True when the pair is one only a `created` organization may call (the gate then asks the reader for the stage). */
export function isCreatedOnlyRoute(method: string, routeTemplate: string | undefined): boolean {
  return (
    routeTemplate !== undefined &&
    CREATED_ONLY_ROUTES.has(`${method.toUpperCase()} ${routeTemplate}`)
  );
}

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
  /** True only when the organization is `created`; absent is false, so the `created`-only billing steps fail closed. */
  readonly organizationCreated?: boolean;
}): boolean {
  const { routeTemplate } = input;
  if (!routeTemplate) return false;
  if (routeTemplate === VENDOR_AUTH_ROUTE_TEMPLATE) return isCleanVendorAuthPath(input.rawUrl);
  const pair = `${input.method.toUpperCase()} ${routeTemplate}`;
  if (CREATED_ONLY_ROUTES.has(pair)) return input.organizationCreated === true;
  return CONFINED_ROUTES.includes(pair);
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
  /**
   * True only when the organization's status is `created` (not suspended, closed, unknown or unreadable-as-null). The billing-step pairs
   * are open to `created` alone. Optional so a reader that cannot say fails CLOSED for those pairs (the hook treats absent as false).
   */
  isCreated?(organizationId: string): Promise<boolean>;
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
  const cache = new Map<
    string,
    { readonly confined: boolean; readonly created: boolean; readonly at: number }
  >();
  const generations = new Map<string, number>();
  /** One status read answers both questions, cached together. */
  async function stageOf(organizationId: string) {
    const hit = cache.get(organizationId);
    if (hit && now() - hit.at < ttlMs) return hit;
    const generation = generations.get(organizationId) ?? 0;
    const status = await readStatus(organizationId);
    const entry = { confined: status !== "active", created: status === "created", at: now() };
    // A lifecycle transition may invalidate while this read is in flight. Do not let the stale completion
    // repopulate the cache after that invalidation.
    if ((generations.get(organizationId) ?? 0) === generation) cache.set(organizationId, entry);
    return entry;
  }
  return {
    async isConfined(organizationId) {
      return (await stageOf(organizationId)).confined;
    },
    async isCreated(organizationId) {
      return (await stageOf(organizationId)).created;
    },
    invalidate(organizationId) {
      cache.delete(organizationId);
      generations.set(organizationId, (generations.get(organizationId) ?? 0) + 1);
    },
  };
}
