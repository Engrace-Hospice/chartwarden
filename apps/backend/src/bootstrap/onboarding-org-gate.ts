// apps/backend/src/bootstrap/onboarding-org-gate.ts — what a session on a NOT-YET-LIVE organization may call.
//
// WHY THIS EXISTS. A new tenant's first admin has to sign in to finish onboarding and to attest go-live readiness, but the
// organization stays `created` (M2 §11 D19) until the platform operator approves go-live. Clinical and PHI routes are NOT gated
// on the tenant's own status anywhere else: they trust "the organization is active". So the organization is NOT activated
// early to let the admin in (that would open charting before the two-party go-live); instead `select-organization` admits a
// `created` organization whose tenant is provisioning/onboarding, and THIS gate keeps such a session to an allowlist:
// sign-in plumbing, the M34 tenant surface (onboarding wizard, go-live attestation, account), and the identity administration
// the wizard's staffing steps need (organization, members, invitations, roles, locations, provider entities). Everything else,
// every clinical, patient, billing and messaging route, answers 403 ORGANIZATION_ONBOARDING until go-live approval activates
// the organization (the cache below is evicted by that transition).
//
// FAIL CLOSED. It is an ALLOWlist: a route added later is refused until someone adds it here on purpose. The path is decoded
// once and refused when it cannot be decoded or tries to climb (`..`, a backslash), so an encoded or dotted path cannot borrow
// an allowed prefix for a route outside it.
import { ChartWardenError } from "@chartwarden/types";

/** Path roots a pre-activation session may call (the root itself or anything below it). No trailing slash. */
export const PRE_ACTIVATION_ALLOWED_ROOTS: readonly string[] = [
  "/api/auth", // Better Auth: session, sign-out, second factor, passkey
  "/api/v1/auth", // organization picker, CSRF, unlock, credential status
  "/api/v1/me", // /me/session, /me/permissions
  "/api/v1/sessions/step-up", // the step-up challenge (the go-live attestation requires a fresh one)
  "/api/v1/tenant", // M34 tenant surface: onboarding wizard, go-live attestation, account, org profile, officer
  "/api/v1/orgs", // M2 organization administration: members, invitations (first admin, officer)
  "/api/v1/locations", // M2: the wizard's locations step
  "/api/v1/provider-entities", // M2: the wizard's provider-entity / CCN step
  "/api/v1/memberships", // M3: role grants on a member
  "/api/v1/roles",
  "/api/v1/permissions",
  "/api/v1/invitations", // accepting an invitation
  "/health",
  "/ready",
];

const underRoot = (path: string, root: string): boolean =>
  path === root || path.startsWith(`${root}/`);

/** True when a session on a not-yet-live organization may call `rawUrl` (query string ignored). */
export function preActivationMayCall(rawUrl: string): boolean {
  let path: string;
  try {
    path = decodeURIComponent(rawUrl.split("?")[0] ?? "");
  } catch {
    return false;
  }
  if (path.includes("\\") || path.split("/").includes("..")) return false;
  return PRE_ACTIVATION_ALLOWED_ROOTS.some((root) => underRoot(path, root));
}

/** The refusal for everything else: a typed 403 carrying no organization data. */
export function organizationOnboardingRefusal(): ChartWardenError {
  return new ChartWardenError(
    "ORGANIZATION_ONBOARDING",
    "this organization is still being onboarded; only onboarding, go-live, account and sign-in routes are available until go-live is approved",
    403,
  );
}

/** What the authenticate hook asks: is this org-bound session on an organization that is created but not yet activated? */
export interface OrganizationStageReader {
  isPreActivation(organizationId: string): Promise<boolean>;
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
  const cache = new Map<string, { readonly preActivation: boolean; readonly at: number }>();
  return {
    async isPreActivation(organizationId) {
      const hit = cache.get(organizationId);
      if (hit && now() - hit.at < ttlMs) return hit.preActivation;
      const preActivation = (await readStatus(organizationId)) === "created";
      cache.set(organizationId, { preActivation, at: now() });
      return preActivation;
    },
    invalidate(organizationId) {
      cache.delete(organizationId);
    },
  };
}
