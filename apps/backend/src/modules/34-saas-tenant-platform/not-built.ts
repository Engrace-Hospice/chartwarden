// apps/backend/src/modules/34-saas-tenant-platform/not-built.ts — the typed "this route is registered but not built yet" refusal.
//
// Slice 7 froze its wire contract (routes, guards, schemas, generated client) before the services behind it exist. Until the
// owner piece replaces a stub it answers 501 NOT_IMPLEMENTED in the standard error envelope, the same refusal M22 and M31 give
// for an unavailable catalog. Each owner piece deletes the call sites it replaces; nothing here ever succeeds.
import { ChartWardenError } from "@chartwarden/types";

export const NOT_BUILT_STATUS = 501;

/** The 501 NOT_IMPLEMENTED error for `feature` (a short noun phrase: "help requests", "tenant onboarding skip"). */
export function notBuilt(feature: string): ChartWardenError {
  return new ChartWardenError("NOT_IMPLEMENTED", `${feature} is not built yet`, NOT_BUILT_STATUS);
}
