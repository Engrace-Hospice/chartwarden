// apps/backend/src/bootstrap/ambient-org-guard.ts — the guard an org-explicit seam body runs first (slice 2: NetCollectionsReader of M25,
// BillingServiceModeReader of M35, which may not import each other).
//
// A seam body takes an `organizationId` argument because workers call it with no request around them. But a REQUEST can reach the same
// body, and then the argument is only as trustworthy as the caller: a handler of tenant A that passes tenant B's id would read B's
// contract or collections through code that was written for workers. So when an ambient request context exists (AsyncLocalStorage, set
// per HTTP request) and it belongs to a DIFFERENT organisation, the call is refused. No ambient context (a worker, a relay tick) and an
// ambient context of the SAME organisation both pass; a platform operator's request (its own organisation is the platform's) is a
// different organisation and is refused too: the platform surface reads a tenant's pricing through its own audited routes, not a seam.
import { getRequestContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";

export function refuseForeignAmbientOrg(organizationId: string, seam: string): void {
  const ambient = getRequestContext();
  if (ambient && ambient.organizationId !== organizationId) {
    throw new ChartWardenError(
      "SEAM_FOREIGN_ORGANIZATION",
      `${seam}: the call is made inside another organisation's request; refusing to read across tenants`,
      403,
    );
  }
}
