// apps/backend/src/modules/22-documents — M22 Document Management backend module.
//
// M22-T03 landed the pure §2.2 document-lifecycle domain under `./domain` (the aggregate state machine, the
// append-only version ledger, retention-class rules, legal hold, the §164.528 access-log + signed-URL TTL,
// the D1 per-tenant MinIO key model, and the §2.4 patient-merge redirect). The schema landed in M22-T02. M22-T04
// adds the §4.3 / §7.2 W2 write-side seams (`DocumentRenderer` + `DocumentStorageProvider`) under `./seams`,
// registered into the M1 registry via `registerDocumentSeams` (closes M39's deny-stub). M22-T05 adds the five
// §4.3 published READER seams (`RenderedDocumentProvider`, `DocumentReader`, `PortalDocumentReader`,
// `IntakeMetricsProvider`, `ExtractionProvenanceReader`) via `registerDocumentReaderSeams`. M22-T06 adds the §4.11
// outbox render-handshake consumers (`./consumers` — `*.document_requested` → render → `m22.document.rendered`
// back-ref), wires M39's REAL `ConsentEvaluator` into the portal SUD gate, and adds the §4.12 external-partner
// signed-URL service (`./services` — M40 `BaaStatusProvider`-gated).
//
// M22-T07 lands the §4.1 route inventory (`./routes` — over an in-memory `DocumentRouteService`; Drizzle in prod
// under withOrgContext so RLS backstops) behind the REAL M3 Authorization Contract over the §4.6 keys M22 registers
// into M3's catalog (`M22_CONTRIBUTED_PERMISSIONS`), plus the seven §4.7 ABAC predicate resolvers M22 owns
// (`./abac-predicates` — `document_owner_or_caseload` / `legal_hold_aware` / `extraction_reviewer_eligible` / …)
// registered into M3. PHI list routes use opaque cursor pagination (SD-052); the content route mints a TTL-clamped
// signed URL.
//
// M22-T08 lands DocLens (Pillar 3) built but gated OFF behind `documents.doclens` (`./extraction`): the
// `503 EXTRACTION_DISABLED` route gate + the backend's consumption of the `@wardenx/intake-extraction` §7.1 W1
// pipeline over the four §8.5 M32 capability deny-stubs (fail-safe `awaiting_capability` until M32 binds them).
//
// M22-T09 lands the §7 render-variant consumers (`./render-variants`): the §164.526 Statement-of-Disagreement
// pipeline (§7.5 W5 / D13), the SUD-aware lab-results render with the M29 `LabObservationReader` deny-stub
// (§7.15 W-M22-22 / §7.16 W-M22-23 / §7.18 W-M22-25 — M29 = Wave H, inert until then), and the EVV (§7.12 W12) /
// encounter (§7.13 W13) layout variants. The pure render-CONTENT shaping (incl. the D20 SUD redaction
// placeholder/banner + the D22 critical watermark) lives in `@wardenx/forms` (`render-variants`). Screens land in
// M22-T10.
export * from "./domain";
export * from "./seams/index";
export * from "./consumers/index";
export * from "./services/signed-url-service";
export {
  type DocumentEraseCandidate,
  type DocumentEraseCounts,
  type DocumentEraseOptions,
  type DocumentEraseStore,
  type DocumentEraserDeps,
  type DocumentDestroyResult,
  type InMemoryDocumentEraseSeed,
  createDocumentEraser,
  createInMemoryDocumentEraseStore,
  eraseDocumentRecord,
  registerDocumentErasers,
} from "./services/eraser";
export * from "./extraction/index";
export * from "./render-variants/index";
export {
  type DocumentAbacDeps,
  type DocumentAbacResolver,
  M22_ABAC_PREDICATES,
  buildDocumentAbacPredicates,
  registerDocumentAbacPredicates,
} from "./abac-predicates";
export { type DocumentRouteDeps, registerDocumentRoutes } from "./routes/documents-routes";
export {
  type DocumentServiceDeps,
  type DocumentSeed,
  type DocumentView,
  type InternalPresignPort,
  type RecordedDocumentEvent,
  DocumentRouteService,
} from "./routes/service";
