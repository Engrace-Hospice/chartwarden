// apps/backend/src/modules/39-consent — Module 39 (Consent & Authorization Management) backend
// surface, owned per module-manifest.ts codePath `apps/backend/src/modules/39-consent`.
//
// M39-T05 (./seams) registers M39's published `ConsentEvaluator` seam (§4.3) into the M1 registry and
// exposes the typed resolver every PHI-egress module consumes (the disclosure/redaction gate). Routes
// + permission keys + ABAC predicates (T07), outbox/jobs/alerts (T08), the consent flows (T09), and
// the eraser (T10) build on this. The §5 screens DEFER — the M39 manifest has no frontend codePath
// (the Wave-A deferral rule: a screen needs a manifest UI codePath to land).
export { type ConsentSeamDeps, registerConsentSeams, getConsentEvaluator } from "./seams";
// M39-T06 (./consumed-seams) — the seams M39 CONSUMES (spec §4.4): M5 PatientReader (real, identity
// resolution) + M22 DocumentRenderer (deny-stub forward seam, D15 signed-PDF). Resolved through the
// M1 registry so there is NO 22→39 import edge (ADR-0006).
export {
  type ConsentRecordRenderPayload,
  getConsentPatientReader,
  getConsentDocumentRenderer,
  resolvePatientForConsent,
  renderConsentRecordDocument,
} from "./consumed-seams";
// M39-T07 — the §4.1 route inventory behind requirePermission/requireStepUp on the §4.7 keys
// (M39_CONTRIBUTED_PERMISSIONS in @wardenx/auth), plus the eleven §4.8 ABAC predicate resolvers M39
// registers into M3's named-predicate registry (resolved through the ConsentEvaluator seam).
export { type ConsentRouteDeps, registerConsentRoutes } from "./routes/consent-routes";
export { M39_ABAC_PREDICATES, registerConsentAbacPredicates } from "./abac-predicates";
