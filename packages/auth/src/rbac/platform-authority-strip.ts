// @chartwarden/auth · rbac — CW-AC-22: platform authority withheld from a request that came from outside the console allowlist.
//
// `PLATFORM_CONSOLE_ALLOWED_CIDRS` refuses the console's own routes with a 403. A platform role also reaches routes that share a prefix
// with a tenant surface (`/api/v1/orgs`, `/api/v1/reporting/admin`, ...), and those cannot be refused by prefix: a tenant administrator uses
// them too. The answer is to take the authority away instead of the route: from an address outside the list the caller is judged as if
// it held no platform role, and what is left is whatever its tenant roles give it.
//
// Authorization reads platform authority from TWO places, and both must lose it:
//   - `request.context.roles` (`requireRole`, every ABAC predicate, `isPlatformOperator`): {@link stripPlatformAuthority} rewrites it;
//   - the effective-permission resolver (`requirePermission`, `resolveActorPermissions`): it re-reads the grants from the database by
//     (organization, user), so editing the context cannot reach it. The strip is therefore a FLAG on the request, and the resolver
//     drops the platform roles' grants (and skips its cache, which holds the full set) whenever the flag is up.
// Callers of the resolver pass either the whole request context or only `{ organizationId, userId }` (GET /me/permissions, the
// services that ask "may this user ...?"). The flag is read from the context when it is there and otherwise from the AMBIENT request
// context (the same object, kept in AsyncLocalStorage for the whole request), matched on the user, so a caller that has only ids is
// not a way around the strip. Nothing a client sends can raise the flag: the attribute is written here, by the server's own guard.
import { getRequestContext } from "@chartwarden/tenancy";
import type { HttpRequestContext } from "@chartwarden/types";
import { isReservedPlatformRoleKey, withoutPlatformRoles } from "../roles/platform-reserved";

/** The `request.context.attributes` key that says this request's platform authority was withheld. Written only by {@link stripPlatformAuthority}. */
export const PLATFORM_AUTHORITY_STRIPPED_ATTRIBUTE = "platformAuthorityStripped";

/**
 * Withhold platform authority from `context`: its platform role keys are removed from `roles` and the request is flagged, so the
 * permission resolver answers without them too. Returns the platform role keys that were held (empty = none: nothing changed and
 * nothing was flagged, which is every tenant user). Mutates the context in place, as the authenticate hook that filled it did: the
 * same object is the ambient request context, so the change is what the rest of the request sees.
 */
export function stripPlatformAuthority(context: HttpRequestContext): readonly string[] {
  const held = context.roles.filter(isReservedPlatformRoleKey);
  if (held.length === 0) return [];
  context.roles = [...withoutPlatformRoles(context.roles)];
  context.attributes[PLATFORM_AUTHORITY_STRIPPED_ATTRIBUTE] = true;
  return held;
}

type Flagged = { readonly attributes?: Record<string, unknown> } | undefined;
const isFlagged = (context: Flagged): boolean =>
  context?.attributes?.[PLATFORM_AUTHORITY_STRIPPED_ATTRIBUTE] === true;

/**
 * True when the caller holds platform authority, or held it before this request's strip took it off `roles`. A check that DENIES a caller
 * BECAUSE it carries platform authority (the Part 2 tenant-administrator override, ADR-0115) must ask this, never
 * `roles.some(isReservedPlatformRoleKey)`: after a strip the roles are gone, so the bare check would admit the caller from the very network
 * that lost its authority, and the strip would widen access. A check that ADMITS on a platform role needs nothing: the strip only narrows it.
 */
export function carriesPlatformAuthority(
  context: Pick<HttpRequestContext, "roles" | "userId"> & Flagged,
): boolean {
  return context.roles.some(isReservedPlatformRoleKey) || platformAuthorityStrippedFor(context);
}

/**
 * True when this actor's platform authority was withheld for the current request: the context carries the flag, or (a caller that
 * passes only ids) the ambient request context is the same user's and carries it. Outside a request (a job, a script) there is no
 * ambient context and nothing is stripped.
 */
export function platformAuthorityStrippedFor(
  actor: Pick<HttpRequestContext, "userId"> & Flagged,
): boolean {
  if (isFlagged(actor)) return true;
  const ambient = getRequestContext();
  // The ambient object IS `request.context` (typed with the tenancy subset only), so `attributes` is there at runtime.
  return (
    ambient !== undefined &&
    ambient.userId === actor.userId &&
    isFlagged(ambient as unknown as Flagged)
  );
}
