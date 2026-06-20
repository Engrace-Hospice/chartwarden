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
// M40-T07 — the §4.1–4.2 route inventory behind `requirePermission` on the §4.4 keys (registered
// into M3's catalog as M40_CONTRIBUTED_PERMISSIONS); merge approval & re-pointing (§7.6).
export { type MdmRouteDeps, registerMdmRoutes } from "./routes/mdm-routes";
// M40-T09 — the M29 NPPES-sync outbox consumers (§4.7). Phase-1 forward-seam/deny-stub: declared but
// not live-wired until M29 (Wave H); the T08 nightly job is the Phase-1 authoritative sync path.
export {
  type M29ConsumerDescriptor,
  M29_NPPES_CONSUMERS,
  M29_CONSUMERS_DEFERRED,
  createM29NppesConsumerHandlers,
} from "./outbox-consumers/m29-nppes-consumers";
// M40-T10 — the REAL `mdm_tenant_overlays` eraser (D7 tenant offboarding, §7.8): deletes the org's
// overlay/provisional/baa rows; canonical reference entities are never touched. The §5 screens DEFER
// — the M40 manifest has no frontend codePath (the Wave-A deferral rule: a screen needs a manifest UI
// codePath to land), so the entity-directory / merge-console / NPPES-console screens are tracked for
// the follow-up that adds one. Cache grammar (§4.8) + audit catalog (§8.1, `m40.*` in @wardenx/audit)
// ship with this task; DR Tier 4 (directory-style reference data; NPPES is the sole external feed).
export { type MdmEraserDeps, registerMdmErasers } from "./erasers/mdm-eraser";
