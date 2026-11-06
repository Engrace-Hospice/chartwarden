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

/** A PHI-free log sink: the event name and the error CLASS only (never a message, a stack or a cause). */
export type ResolveLog = (event: { readonly event: string; readonly errorClass: string }) => void;

/**
 * The org's own binding, or a TYPED refusal. The per-org resolver throws a typed 503 when the stored credential cannot be opened
 * (`CLEARINGHOUSE_CREDENTIAL_UNREADABLE`): that passes through unchanged. Anything else it throws (a database fault while reading
 * the config) becomes `CLEARINGHOUSE_UNAVAILABLE`, naming nothing of the cause: a route must answer a typed 503, never a bare 500.
 * The cause is not lost to the operator: its error CLASS (and nothing else) goes to `log`, so a fault is visible without the
 * message, which can carry a connection string or a row.
 */
async function resolveForOrg<B>(
  forOrg: (organizationId: string) => Promise<B>,
  organizationId: string,
  log?: ResolveLog,
): Promise<B> {
  try {
    return await forOrg(organizationId);
  } catch (err) {
    if (err instanceof ChartWardenError) throw err;
    log?.({
      event: "clearinghouse.resolve_failed",
      errorClass: err instanceof Error ? err.name : typeof err,
    });
    throw new ChartWardenError(
      "CLEARINGHOUSE_UNAVAILABLE",
      "this organization's clearinghouse could not be resolved; try again shortly",
      503,
    );
  }
}

/** The two refusals `resolveForOrg` can end in. Each is ONE tenant's problem (its credential, its config read), not the shared job's. */
const PER_ORG_RESOLVE_FAILURES: readonly string[] = [
  "CLEARINGHOUSE_CREDENTIAL_UNREADABLE",
  "CLEARINGHOUSE_UNAVAILABLE",
];

/**
 * True when `err` is the org's own binding failing to resolve. A shared cron reports such an org (and carries on) instead of
 * failing the tick: a tick failure retries the whole job into the DLQ for every tenant, for one tenant's broken credential.
 */
export const isPerOrgResolveFailure = (err: unknown): err is ChartWardenError =>
  err instanceof ChartWardenError && PER_ORG_RESOLVE_FAILURES.includes(err.code);

/** What a failure line says about an error: its code when it has one (the class of a typed error is always `ChartWardenError`). */
export const failureLabel = (err: unknown): string =>
  err instanceof ChartWardenError ? err.code : err instanceof Error ? err.name : "failed";

/** The binding to use for `organizationId` (its own when the platform binding is per-organization, else the one binding). */
export function resolveBinding<B extends PerOrgBinding<B>>(
  binding: B,
  organizationId: string,
  log?: ResolveLog,
): Promise<B> {
  return binding.forOrg
    ? resolveForOrg(binding.forOrg, organizationId, log)
    : Promise.resolve(binding);
}

/** The same deps with `binding` replaced by the organization's own resolved binding (the deps object itself when the binding is static). */
export async function withOrgBinding<B extends PerOrgBinding<B>, D extends { readonly binding: B }>(
  deps: D,
  organizationId: string,
  log?: ResolveLog,
): Promise<D> {
  if (!deps.binding.forOrg) return deps;
  return { ...deps, binding: await resolveForOrg(deps.binding.forOrg, organizationId, log) };
}
