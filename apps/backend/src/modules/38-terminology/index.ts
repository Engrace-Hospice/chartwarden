// apps/backend/src/modules/38-terminology — Module 38 (Clinical Terminology) backend surface,
// owned per module-manifest.ts codePath `apps/backend/src/modules/38-terminology`.
//
// M38-T05 (./seams) registers M38's published `TerminologyProvider` seam (§4.5) into the M1
// registry and exposes the typed resolver consumers use. M38-T06 (./routes) adds the §4.1–4.2
// route inventory. Value-set expansion (T07) and seed (T08) landed; T09 makes the FHIR projection
// golden-stable (§7.9) and gates semantic search on `ai.full` (§7.7).
//
// M38-T10 lands the operational surface: the §4.3 jobs (queue catalog + pure processors), the §4.6
// cache key grammar + invalidation, the §8.1 audit-event action catalog (`m38.*`, in @wardenx/audit),
// and the D8 tenant-offboarding eraser (below). The §5 screens DEFER — the M38 manifest has no
// frontend/admin codePath (the same Wave-A deferral rule: a screen needs a manifest UI codePath to
// land), so they are tracked for the follow-up that adds one.
//
// DR/INT (ADR-0009): M38 is **DR Tier 4** — terminology is reference data; a degradation pauses
// version LOADS while cached/last-loaded lookups keep serving, so patient care and billing are
// unaffected (no RTO pressure). Its sole external surface — the terminology source feeds (CMS
// ICD-10, NLM/UMLS SNOMED, Regenstrief LOINC, RxNorm) — is row #23 of `WARDENX_INTEGRATIONS_v0_1`
// (inbound, scheduled, no PHI, platform license creds, `packages/terminology-loader`, Tier 4).
export {
  type TerminologySeamDeps,
  registerTerminologySeams,
  getTerminologyProvider,
} from "./seams";
// M38-T10 — the REAL `terminology_tenant_extensions` eraser (registered over the deny-stub by the
// composition root): D8 tenant offboarding deletes the org's value-set extensions; platform tables
// (reference data) are never touched.
// TASK-003/ARCH-007: `createDrizzleTerminologyEraseStore` narrows the FB-T01 Drizzle
// `TerminologyStore` to the erase port — the composition root injects it via `deps.store`.
export {
  type TerminologyEraserDeps,
  createDrizzleTerminologyEraseStore,
  createTerminologyEraser,
  registerTerminologyErasers,
} from "./erasers/terminology-eraser";
// M38-T06 — the §4.1–4.2 route inventory behind `requirePermission` on the §4.4 keys; the
// add-only tenant value-set extension is the only tenant write (§7.4 canonical lockdown).
// M38-T09 adds the §7.7 `ai.full` semantic-search gate (`TerminologyFeatureFlagReader`/`AI_FULL_FLAG`).
export {
  type TerminologyRouteDeps,
  type TerminologyFeatureFlagReader,
  AI_FULL_FLAG,
  registerTerminologyRoutes,
} from "./routes/terminology-routes";

// FB-T01 — the production Drizzle `TerminologyStore` (over the M38 tables) + the composition-root
// route mount. The store backs both the published `TerminologyProvider` seam (injected in
// `registerTerminologySeams`) and the consumer-facing route inventory below.
export { createDbTerminologyStore } from "./terminology-store-db";

// GAP-063 — the six §4.1 routes that had no registration anywhere: the value-set catalog, the §7.3
// tenant remediation report, and the four platform-ops `/api/v1/admin/terminology/*` routes. The
// admin write door is migration 0206's `terminology_loader` SECURITY DEFINER pair (`wardenx_app` has
// no canonical write grant, §7.4), and the platform-only conjunct is M38's own ABAC predicate.
export {
  type TerminologyOpsStore,
  type TerminologyOpsSeed,
  type ValueSetCatalogEntry,
  type TerminologyLoadHistoryEntry,
  type TenantExtensionGovernanceRow,
  createInMemoryTerminologyOpsStore,
} from "./ops-store";
export { createDbTerminologyOpsStore } from "./terminology-ops-store-db";
export {
  type AdminTerminologyRouteDeps,
  registerAdminTerminologyRoutes,
} from "./routes/admin-terminology-routes";
export {
  type CodeUsageProducer,
  type RemediationResponse,
  carePlanCodeUsageProducer,
  createRemediationService,
  defaultRemediationSince,
  recommendedActionFor,
  REMEDIATION_COVERED_RECORD_TYPES,
} from "./remediation-service";
export {
  M38_ABAC_PREDICATES,
  buildTerminologyAbacPredicates,
  registerTerminologyAbacPredicates,
} from "./abac-predicates";

import type { DbClient } from "@wardenx/db";
import { createTerminologyProvider } from "@wardenx/terminology";
import type { FastifyInstance } from "fastify";
import { getSeam } from "../../bootstrap/index";
import {
  carePlanCodeUsageProducer as _carePlanCodeUsageProducer,
  createRemediationService as _createRemediationService,
} from "./remediation-service";
import { registerAdminTerminologyRoutes as _registerAdminTerminologyRoutes } from "./routes/admin-terminology-routes";
import {
  type TerminologyFeatureFlagReader as _TerminologyFeatureFlagReader,
  registerTerminologyRoutes as _registerTerminologyRoutes,
} from "./routes/terminology-routes";
import { createDbTerminologyOpsStore as _createDbTerminologyOpsStore } from "./terminology-ops-store-db";
import { createDbTerminologyStore as _createDbTerminologyStore } from "./terminology-store-db";

/**
 * Mount the M38 terminology REST routes (validate / lookup / search / value-set expand+is-member /
 * tenant value-set extensions) on a server — invoked by the composition root when a DB client is
 * present. The handlers run over the real Drizzle-backed `TerminologyProvider`; reads serve live
 * reference data and the org-scoped tenant-extension write runs under RLS. Backs the Terminology
 * Admin screen (FB-T01).
 *
 * `flags` is the M1 `feature_flag` reader the composition root now binds (F-091). It is what makes the
 * §7.7 `ai.full` semantic-search gate ANSWERABLE: without a reader the gate cannot resolve anything but
 * "off", so `mode=semantic` returned FEATURE_NOT_ENABLED for every tenant on every deployment whether or
 * not the capability had been granted. Optional because a no-db/slice boot has no reader to give, and
 * absent still means every flag off — the Phase-1 default this module documents.
 */
export function mountTerminologyRoutes(
  app: FastifyInstance,
  db: DbClient,
  flags?: _TerminologyFeatureFlagReader,
): void {
  const provider = createTerminologyProvider(_createDbTerminologyStore(db));
  const ops = _createDbTerminologyOpsStore(db);
  // The remediation report's ONE bound producer today is M7's problem list, reached opaquely through
  // the seam registry (no `@wardenx/care-plan` import edge, so M38 `dependsOn` stays [1,2,3,4]).
  // Resolved lazily per call: registration order at boot is then irrelevant.
  const remediation = _createRemediationService({
    ops,
    producers: [_carePlanCodeUsageProducer(() => getSeam("CarePlanReader"))],
  });
  _registerTerminologyRoutes(app, { provider, ops, remediation, ...(flags ? { flags } : {}) });
  _registerAdminTerminologyRoutes(app, { ops });
}
