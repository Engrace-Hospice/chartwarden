// apps/backend/src/modules/24-billing-medicaid/wiring.ts — M24 published-seam registration into the M1
// SeamRegistry (the M26 `registerM26PublishedSeams` precedent). M24 publishes the eight §4.3 reader seams;
// today NONE has a live cross-module `getSeam` consumer (M27/M28/M30/M37 deny-stub or are unbuilt), so this
// builds the impls but registers nothing yet — M24 stays reachable cross-module via its §4.11 outbox events
// (the M26 unconsumed-seam posture). When a consumer binds, register the relevant seam here following the
// EXACT M26 precedent: add the SeamName to @wardenx/types' `SeamName` union + `SeamContracts` (opaque
// `unknown`), add a fail-closed deny-stub provider in bootstrap/seams/providers.ts, list it in
// REQUIRED_SEAMS, then `registerSeam(name, impls.x)` here. The read runs under withOrgContext (RLS-scoped).
import type { DbClient } from "@wardenx/db";
import { buildDrizzleM24ReadService } from "./routes/read-service-drizzle";
import { type M24SeamImpls, buildM24SeamImpls } from "./seam-impls";

/**
 * Build M24's eight published-seam impls (ready for M1 registration). No-op registration today — no live
 * consumer calls `getSeam` on an M24 seam yet, so the impls are constructed but not registered (the M26
 * deferred posture). Returns the impls so a follow-up bind can `registerSeam(...)` the consumed ones.
 */
export function registerM24PublishedSeams(db: DbClient | undefined): M24SeamImpls | undefined {
  if (!db) return undefined;
  return buildM24SeamImpls(db, buildDrizzleM24ReadService(db));
}
