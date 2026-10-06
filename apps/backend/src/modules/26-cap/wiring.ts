// apps/backend/src/modules/26-cap/wiring.ts — M26 published-seam registration into the M1 SeamRegistry
// (the M33 `registerReportingMetricsSeam` precedent). Registers the §4.3 `CapAccrualReader` so M27's
// cost-report Worksheet-E cap calc resolves the live cap-period aggregate via `getSeam` over the fail-closed
// deny-stub. The read runs under withOrgContext (RLS-scoped to the caller's org). When no db is present the
// M1 fail-closed deny-stub stands. Called by the composition root in `wireModuleSeams`.
//
// `CapAccrualReader` (M27 cost-report cap calc) + `CapProjectionProvider` (M23 §11.A pre-submission cap
// rules) are registered here. M26's other published seams (InpatientCapProvider / CapSettlementProvider /
// CapAlertSubscriberProvider / CapMetricsProvider) stay reachable via outbox events until their consumers bind.
import type { DbClient } from "@wardenx/db";
import { registerPlatformJob } from "@wardenx/tenancy";
import { registerSeam } from "../../bootstrap/index";
import { buildDrizzleM26ReadService } from "./routes/read-service-drizzle";
import { buildM26SeamImpls } from "./seam-impls";

/** Register M26's published seams into the M1 registry. No-op without a db (the deny-stubs stand). */
export function registerM26PublishedSeams(db: DbClient | undefined): void {
  if (!db) return;
  const impls = buildM26SeamImpls(db, buildDrizzleM26ReadService(db));
  registerSeam("CapAccrualReader", impls.accrual);
  registerSeam("CapProjectionProvider", impls.projection);
}

/**
 * The platform job id M26's §4.8 platform-scoped crons (nightly projection, cap-year auto-close, PS&R
 * watchdog) enter `withPlatformContext` under to enumerate active orgs. Registered on the
 * `@wardenx/tenancy` PLATFORM_CONTEXT_ALLOWLIST (empty → fail-closed) by {@link wireM26Tenancy}.
 */
export const M26_PLATFORM_JOB_ID = "m26.platform_crons";

/** Allowlist M26's platform job id so its cron fan-outs may enter `withPlatformContext` (idempotent). */
export function wireM26Tenancy(): void {
  registerPlatformJob(M26_PLATFORM_JOB_ID);
}
