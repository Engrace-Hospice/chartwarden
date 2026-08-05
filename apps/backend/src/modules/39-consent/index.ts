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
// M39-T08 — outbox catalog (§4.5), M36 alert payloads (§4.10), the §4.6 consumer bridges. The
// events/alerts are published/registered now; consumer wiring (BullMQ/Valkey) lands with M1 infra.
export { M39_OUTBOX_EVENTS } from "./events-by-m39";
export { M39_ALERT_PAYLOADS } from "./alerts-by-m39";
export {
  type ConsentChangedForPrivacy,
  type ConsentPrivacyFlag,
  type ConsentPrivacySignal,
  consentChangeToPrivacyPayload,
  decideConsentDocumentLink,
  decideDeceasedConsentExpiry,
  decidePatientMergeRepoint,
} from "./consumers";
// M39-T10 — the REAL `consent` DataEraser (§3.8 right-to-erasure / destruction-cert): deletes the
// patient's consent subtree EXCEPT rows under a legal hold or a 42 CFR Part 2 release retained for
// the patient's lifetime; consent_eval_audit destruction is M4's certified audit-retention path.
export {
  type ConsentEraserDeps,
  createConsentEraser,
  createDrizzleConsentEraseStore,
  registerConsentErasers,
} from "./erasers/consent-eraser";

// FB-T03 — the production Drizzle consent adapters (over the M39 tables) + the composition-root route
// mount. `createDbConsentStore`/`createDbConsentEvaluator` back the published `ConsentEvaluator` seam
// (injected in `registerConsentSeams`); `createDbConsentRouteService` backs the §4.1 read routes. The
// Patient Chart consent tab (apps/web/src/modules/05-patient, FB-T10) reads live through these.
export {
  type ConsentInternalNotesCipher,
  type ConsentPatientReader,
  type ConsentWriteOutboxPort,
  type DbConsentRouteServiceDeps,
  createDbConsentEvaluator,
  createDbConsentRouteService,
  createDbConsentStore,
} from "./consent-store-db";
export { buildM39ConsentRenderConsumer } from "./render-consumer";
export {
  type ConsentTenantKeyProvider,
  createConsentInternalNotesCipher,
} from "./consent-crypto";

import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import {
  type DbConsentRouteServiceDeps,
  createDbConsentRouteService as _createDbConsentRouteService,
} from "./consent-store-db";
import { registerConsentRoutes as _registerConsentRoutes } from "./routes/consent-routes";

/**
 * Mount the M39 consent REST routes (catalog / patient consents / record / decision audit + the
 * lifecycle endpoints) on a server — invoked by the composition root when a DB client is present.
 * Reads and lifecycle writes run over the real Drizzle-backed `ConsentRouteService` under RLS. The
 * injected outbox/cipher/patient ports are mandatory at production composition for operative writes.
 */
export function mountConsentRoutes(
  app: FastifyInstance,
  db: DbClient,
  deps: DbConsentRouteServiceDeps = {},
): void {
  _registerConsentRoutes(app, { service: _createDbConsentRouteService(db, deps) });
}
