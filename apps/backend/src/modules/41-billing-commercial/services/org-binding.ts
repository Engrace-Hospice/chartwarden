// apps/backend/src/modules/41-billing-commercial/services/org-binding.ts - resolve the clearinghouse binding of ONE organization.
//
// The platform binding may be per-organization (the tenant clearinghouse, ADR-0053 amendment 2026-11-06): then it carries `forOrg`, its
// own `vendor` / `transport` are the unbound platform default and say nothing about any organization, and every caller that acts for an
// organization resolves that organization's own binding first. A static binding (no `forOrg`) is returned unchanged, so a deployment
// with one platform vendor, and every test double, behaves exactly as before. The resolved binding has no `forOrg`, so resolving
// twice costs nothing. Structural on purpose (M41 does not import M23 or the x12 client's binding type: its `vendor` is a string).
import { ChartWardenError } from "@chartwarden/types";

export interface PerOrgBinding<B> {
  readonly forOrg?: (organizationId: string) => Promise<B>;
}

/**
 * The org's own binding, or a TYPED refusal. The per-org resolver throws a typed 503 when the stored credential cannot be opened
 * (`CLEARINGHOUSE_CREDENTIAL_UNREADABLE`): that passes through unchanged. Anything else it throws (a database fault while reading
 * the config) becomes `CLEARINGHOUSE_UNAVAILABLE`, naming nothing of the cause: a route must answer a typed 503, never a bare 500.
 */
async function resolveForOrg<B>(
  forOrg: (organizationId: string) => Promise<B>,
  organizationId: string,
): Promise<B> {
  try {
    return await forOrg(organizationId);
  } catch (err) {
    if (err instanceof ChartWardenError) throw err;
    throw new ChartWardenError(
      "CLEARINGHOUSE_UNAVAILABLE",
      "this organization's clearinghouse could not be resolved; try again shortly",
      503,
    );
  }
}

/** The binding to use for `organizationId` (its own when the platform binding is per-organization, else the one binding). */
export function resolveBinding<B extends PerOrgBinding<B>>(
  binding: B,
  organizationId: string,
): Promise<B> {
  return binding.forOrg ? resolveForOrg(binding.forOrg, organizationId) : Promise.resolve(binding);
}

/** The same deps with `binding` replaced by the organization's own resolved binding (the deps object itself when the binding is static). */
export async function withOrgBinding<B extends PerOrgBinding<B>, D extends { readonly binding: B }>(
  deps: D,
  organizationId: string,
): Promise<D> {
  if (!deps.binding.forOrg) return deps;
  return { ...deps, binding: await resolveForOrg(deps.binding.forOrg, organizationId) };
}
