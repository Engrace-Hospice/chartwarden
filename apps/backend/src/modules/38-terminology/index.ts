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

import type { DbClient } from "@wardenx/db";
import { createTerminologyProvider } from "@wardenx/terminology";
import type { FastifyInstance } from "fastify";
import { registerTerminologyRoutes as _registerTerminologyRoutes } from "./routes/terminology-routes";
import { createDbTerminologyStore as _createDbTerminologyStore } from "./terminology-store-db";

/**
 * Mount the M38 terminology REST routes (validate / lookup / search / value-set expand+is-member /
 * tenant value-set extensions) on a server — invoked by the composition root when a DB client is
 * present. The handlers run over the real Drizzle-backed `TerminologyProvider`; reads serve live
 * reference data and the org-scoped tenant-extension write runs under RLS. Backs the Terminology
 * Admin screen (FB-T01).
 */
export function mountTerminologyRoutes(app: FastifyInstance, db: DbClient): void {
  const provider = createTerminologyProvider(_createDbTerminologyStore(db));
  _registerTerminologyRoutes(app, { provider });
}
