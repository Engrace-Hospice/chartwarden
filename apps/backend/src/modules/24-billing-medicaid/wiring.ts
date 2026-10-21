// apps/backend/src/modules/24-billing-medicaid/wiring.ts — M24 published-seam registration into the M1
// SeamRegistry (the M26 `registerM26PublishedSeams` precedent). M24 publishes nine §4.3 reader seams;
// eight have no live cross-module `getSeam` consumer yet (M27/M28/M30/M37 deny-stub or are unbuilt), so
// this builds the impls but registers nothing for those eight — M24 stays reachable cross-module via its
// §4.11 outbox events for them (the M26 unconsumed-seam posture). The ninth, `claimMatch`
// (`MedicaidClaimMatchProvider`), IS registered (F-172, #248, m24 group) — M25's `postAdvice` auto-match
// is its first live consumer. When another of the eight gains a consumer, register it here following the
// EXACT M26 precedent: add the SeamName to @chartwarden/types' `SeamName` union + `SeamContracts` (opaque
// `unknown`), add a fail-closed deny-stub provider in bootstrap/seams/providers.ts, list it in
// REQUIRED_SEAMS, then `registerSeam(name, impls.x)` here. The read runs under withOrgContext (RLS-scoped).
import type { DbClient } from "@chartwarden/db";
import { registerPlatformJob } from "@chartwarden/tenancy";
import { registerSeam } from "../../bootstrap/index";
import { buildDrizzleM24ReadService } from "./routes/read-service-drizzle";
import { type M24SeamImpls, buildM24SeamImpls } from "./seam-impls";

/**
 * Build M24's nine published-seam impls (ready for M1 registration). Registers only `claimMatch` today —
 * the other eight are constructed but not registered (the M26 deferred posture). Returns the impls so a
 * follow-up bind can `registerSeam(...)` the rest as their own consumers land.
 */
export function registerM24PublishedSeams(db: DbClient | undefined): M24SeamImpls | undefined {
  if (!db) return undefined;
  const impls = buildM24SeamImpls(db, buildDrizzleM24ReadService(db));
  registerSeam("MedicaidClaimMatchProvider", impls.claimMatch);
  return impls;
}

// F-172 (#248, m1 group) — platform-tenancy registration for the §4.9 `state-channel-health` cron (the
// M25/M30/M33/M34 `wireM<N>Tenancy` precedent). The cron's active-org fan-out enters `withPlatformContext`
// under this job id; the id must be on the `@chartwarden/tenancy` PLATFORM_CONTEXT_ALLOWLIST (starts empty →
// fail-closed) for the enumerator to be admitted.

/** The platform job id M24's `state-channel-health` cron enters `withPlatformContext` under to enumerate
 * active orgs (the cron fan-out source). Registered on the allowlist by {@link wireM24Tenancy} at boot. */
export const M24_PLATFORM_JOB_ID = "m24.platform_crons";

/**
 * Register M24's platform job id on the PLATFORM_CONTEXT_ALLOWLIST so the `state-channel-health` cron
 * fan-out may enter `withPlatformContext` (idempotent `Set.add`). Called once at boot by the composition
 * root, alongside wireM25Tenancy / wireM30Tenancy / wireM33Tenancy / wireM34Tenancy.
 */
export function wireM24Tenancy(): void {
  registerPlatformJob(M24_PLATFORM_JOB_ID);
}
