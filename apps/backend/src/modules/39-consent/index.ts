// apps/backend/src/modules/39-consent — Module 39 (Consent & Authorization Management) backend
// surface, owned per module-manifest.ts codePath `apps/backend/src/modules/39-consent`.
//
// M39-T05 (./seams) registers M39's published `ConsentEvaluator` seam (§4.3) into the M1 registry and
// exposes the typed resolver every PHI-egress module consumes (the disclosure/redaction gate). Routes
// + permission keys + ABAC predicates (T07), outbox/jobs/alerts (T08), the consent flows (T09), and
// the eraser (T10) build on this. The §5 screens DEFER — the M39 manifest has no frontend codePath
// (the Wave-A deferral rule: a screen needs a manifest UI codePath to land).
export { type ConsentSeamDeps, registerConsentSeams, getConsentEvaluator } from "./seams";
