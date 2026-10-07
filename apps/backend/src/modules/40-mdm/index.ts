// apps/backend/src/modules/40-mdm — Module 40 (Master Data Management) backend surface,
// owned per module-manifest.ts codePath `apps/backend/src/modules/40-mdm`.
//
// M40-T05 (./seams) registers M40's published `MdmEntityProvider` seam (§4.5) into the M1 registry
// and exposes the typed resolver consumers use — the master-data read surface (physician/facility/
// payer; merge-aware) every clinical/billing/interop module imports. The BaaStatusProvider seam
// (T06), routes + permission keys + merge approval (T07), the NPPES nightly job (T08), and the
// D7 overlay eraser (T10) build on this. The §5 screens DEFER — the M40 manifest has no frontend
// codePath (the Wave-A deferral rule: a screen needs a manifest UI codePath to land).
export {
  type MdmSeamDeps,
  registerMdmSeams,
  getMdmEntityProvider,
  getBaaStatusProvider,
} from "./seams";
// GAP-172 — the platform-only ABAC conjunct on `/api/v1/admin/mdm/*` (registered at the composition root).
export {
  M40_ABAC_PREDICATES,
  buildMdmAbacPredicates,
  registerMdmAbacPredicates,
} from "./abac-predicates";
// GAP-173 — the §4.3 `mdm.baa_expiration_scan` cron (BullMQ shell + I/O body) and its platform job id.
export {
  type BaaScanDeps,
  type BaaScanSummary,
  runBaaExpirationScan,
  runBaaExpirationScanForOrg,
} from "./jobs/baa-scan";
export {
  type M40WorkerDeps,
  registerM40CronWorkers,
  scheduleM40Jobs,
} from "./jobs/cron-workers";
export { M40_PLATFORM_JOB_ID, wireM40Tenancy } from "./wiring";
// M40-T07 — the §4.1–4.2 route inventory behind `requirePermission` on the §4.4 keys (registered
// into M3's catalog as M40_CONTRIBUTED_PERMISSIONS); merge approval & re-pointing (§7.6).
export { type MdmRouteDeps, registerMdmRoutes } from "./routes/mdm-routes";
// M40-T09 — the M29 NPPES-sync outbox consumers (§4.7). LIVE since GAP-099: the composition root
// registers `buildM29NppesPlatformConsumers` on the dispatcher's PLATFORM binding list (these events are
// org-less), so the canonical now tracks NPPES within minutes instead of waiting on the T08 nightly delta.
export {
  type M29ConsumerDescriptor,
  M29_NPPES_CONSUMERS,
  M29_CONSUMERS_DEFERRED,
  buildM29NppesPlatformConsumers,
  createM29NppesConsumerHandlers,
} from "./outbox-consumers/m29-nppes-consumers";
export {
  type M40ActiveOrgPort,
  type M40AlertPort,
  type M40NppesConsumerDeps,
  type M40OutboxPublishPort,
  type NppesApplyRecord,
  buildNppesConsumerPorts,
} from "./outbox-consumers/nppes-consumer-ports";
// GAP-099 — M40's own outbox contributions (`m40.canonical.*`). See events-by-m40.ts for why this file
// only appears now: until migration 0202 the canonical tables had no write path, so nothing to announce.
export { M40_OUTBOX_EVENTS } from "./events-by-m40";
// M40-T10 — the REAL `mdm_tenant_overlays` eraser (D7 tenant offboarding, §7.8): deletes the org's
// overlay/provisional/baa rows; canonical reference entities are never touched. The §5 screens DEFER
// — the M40 manifest has no frontend codePath (the Wave-A deferral rule: a screen needs a manifest UI
// codePath to land), so the entity-directory / merge-console / NPPES-console screens are tracked for
// the follow-up that adds one. Cache grammar (§4.8) + audit catalog (§8.1, `m40.*` in @wardenx/audit)
// ship with this task; DR Tier 4 (directory-style reference data; NPPES is the sole external feed).
// TASK-003/ARCH-007: `createDrizzleMdmEraseStore` is the production store the composition root
// injects via `deps.store` (note the mdm_provisional DELETE-grant caveat in its header).
export {
  type MdmEraserDeps,
  createDrizzleMdmEraseStore,
  registerMdmErasers,
} from "./erasers/mdm-eraser";

// FB-T02 — the production Drizzle MDM adapters (over the M40 tables) + the composition-root route
// mount. `createDbMdmStore`/`createDbBaaStore` back the published `MdmEntityProvider` /
// `BaaStatusProvider` seams (injected in `registerMdmSeams`); `createDbMdmRouteService` backs the
// write/admin route surface. The entity-directory read surface (apps/web/src/modules/40-mdm) reads
// live through these.
// F-213 (#252) - merge-resolved facility.kind read for the M23 place-of-service binding.
export { type FacilityKindValue, facilityKindsForIds } from "./facility-kind-reader";
export { createDbBaaStore, createDbMdmRouteService, createDbMdmStore } from "./mdm-store-db";
// GAP-045 — the distinct-NPI read M29's D11 platform NPPES sync runs over. Exposed as a value-returning
// reader because `external_physician` is M40's table and `arch:tables` forbids M29 reading it directly.
export { type NppesNpiSource, createDbNppesNpiSource } from "./nppes-npi-source";

import type { DbClient } from "@wardenx/db";
import { createMdmEntityProvider } from "@wardenx/mdm";
import type { FastifyInstance } from "fastify";
import {
  createDbMdmRouteService as _createDbMdmRouteService,
  createDbMdmStore as _createDbMdmStore,
} from "./mdm-store-db";
import { registerMdmRoutes as _registerMdmRoutes } from "./routes/mdm-routes";

/**
 * Mount the M40 MDM REST routes (faceted search / resolve / overlay / BAA register / platform-ops
 * merge + NPPES) on a server — invoked by the composition root when a DB client is present. Reads run
 * over the real Drizzle-backed `MdmEntityProvider`; the org-scoped overlay/BAA writes run under RLS.
 * Backs the MDM console (FB-T02).
 */
export function mountMdmRoutes(app: FastifyInstance, db: DbClient): void {
  const provider = createMdmEntityProvider(_createDbMdmStore(db));
  _registerMdmRoutes(app, { provider, service: _createDbMdmRouteService(db) });
}
