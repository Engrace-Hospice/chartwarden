// apps/backend/src/modules/26-cap/wiring.ts — M26 published-seam registration into the M1 SeamRegistry
// (the M33 `registerReportingMetricsSeam` precedent). Registers the §4.3 `CapAccrualReader` so M27's
// cost-report Worksheet-E cap calc resolves the live cap-period aggregate via `getSeam` over the fail-closed
// deny-stub. The read runs under withOrgContext (RLS-scoped to the caller's org). When no db is present the
// M1 fail-closed deny-stub stands. Called by the composition root in `wireModuleSeams`.
//
// Only `CapAccrualReader` is registered here (the M27 cost-report bind). M26's other published seams
// (CapProjectionProvider / InpatientCapProvider / CapSettlementProvider / CapAlertSubscriberProvider /
// CapMetricsProvider) stay reachable via outbox events until their consumers' binds land.
import type { DbClient } from "@wardenx/db";
import { registerSeam } from "../../bootstrap/index";
import { buildDrizzleM26ReadService } from "./routes/read-service-drizzle";
import { buildM26SeamImpls } from "./seam-impls";

/** Register M26's `CapAccrualReader` published seam into the M1 registry. No-op without a db (deny-stub stands). */
export function registerM26PublishedSeams(db: DbClient | undefined): void {
  if (!db) return;
  const impls = buildM26SeamImpls(db, buildDrizzleM26ReadService(db));
  registerSeam("CapAccrualReader", impls.accrual);
}
