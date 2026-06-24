// apps/backend/src/modules/22-documents — M22 Document Management module root.
// M22-T03 adds the pure §2.2 document-lifecycle domain under ./lifecycle (versioning, retention classes,
// legal hold, access-log, patient-merge redirect). Storage stays a port (DocumentStorageProvider).
// M22-T04 adds the two §4.3 published seams under ./seams (the §7.2 W2 render handshake + the object store),
// registered into the M1 registry via `registerDocumentSeams` — closing the M39/M6/M8/M11/M12/M13/M14 stubs.
// M22-T06 adds the §4.11 outbox subscriptions (the eight `*.document_requested` render-request consumers)
// + the §4.12 disclosure gates (M39 `ConsentEvaluator` SUD gate + M40 `BaaStatusProvider` external-presign
// gate) under ./outbox-consumers — a pure decision core + real-seam resolvers; the dispatcher binding is
// forward-declared/deferred (M6-T11 / M7-T08 precedent; no new dependsOn edge — M22 deps stay [1, 5]).
// M22-T07 adds the §4.1–4.2 route inventory (33 routes) over an in-memory DocumentRouteService under
// ./routes — behind the REAL Authorization Contract on the §4.6 keys M22 registers into M3's catalog
// (M22_CONTRIBUTED_PERMISSIONS, @wardenx/auth) — plus the §4.7 ABAC predicates M22 owns (./abac-predicates)
// and the §4.1/§4.12 signed-URL service (T03 plan + T04 presign port + §4.12 BAA gate). Cursor (keyset)
// pagination on every PHI list; If-Match optimistic concurrency on the overlay PUT. M22 deps stay [1, 5]
// (@wardenx/auth needs no dep edge; the M5 CaseloadProvider seam is reached opaquely via getSeam).
// M22-T08 adds the §7.1 W1 DocLens extraction pipeline under ./extraction — BUILT-NOT-ACTIVE behind the
// `documents.doclens` feature flag (default OFF → routes return 503 EXTRACTION_DISABLED with Retry-After: 0).
// The pure pipeline (classify → extract → discrepancy → review → decide → provenance) lives in
// @wardenx/intake-extraction; the M32 classifier/extractor/vision capability is consumed OPAQUELY as a
// deny-stub via getSeam (the M22-T06 consent-gate precedent), so M22 deps stay [1, 5] (no M32 edge).
export * from "./lifecycle/index";
export * from "./seams/index";
export * from "./outbox-consumers/index";
export * from "./extraction/index";
// M22-T09 — §7.5 Statement-of-Disagreement attachment + §7.12/§7.13/§7.15 EVV/encounter/lab render variants
// + §7.16 SUD-redacted placeholder render + the §7.15 lab back-ref deny-stub (M29, Wave H). Pure planning;
// the live render + dispatcher binding are deferred (T06 precedent); M22 deps stay [1, 5].
export * from "./render-variants/index";
// M22-T10 — the `documents` data eraser (§8.6 / D9 / D12): DEK-first crypto-erase → legal-hold/Part-2 skip
// → version-aware MinIO + row deletion. Registered over the Phase-0 `documents` deny-stub by the composition
// root (wireModuleErasers, after wireErasers() and before validateErasers()).
export {
  type DocumentEraseCounts,
  type DocumentEraseSkips,
  type DocumentEraseStore,
  type DocumentEraserDeps,
  createDocumentEraser,
  createInMemoryDocumentEraseStore,
  eraseDocumentRecord,
  registerDocumentErasers,
} from "./erasers/document-eraser";
export {
  type DocumentAbacDeps,
  type DocumentAbacFacts,
  type DocumentAbacResolver,
  M22_ABAC_PREDICATES,
  buildDocumentAbacPredicates,
  registerDocumentAbacPredicates,
} from "./abac-predicates";
export { type DocumentRouteDeps, registerDocumentRoutes } from "./routes/documents-routes";
export {
  type DocumentBackendInspect,
  type DocumentRouteSeed,
  type DocumentRouteService,
  type DocumentView,
  createInMemoryDocumentBackend,
} from "./routes/service";
export {
  type CursorPage,
  type CursorKeyset,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  paginate,
} from "./routes/concurrency";
export {
  type MintedSignedUrl,
  type SignedUrlObjectResolver,
  type SignedUrlService,
  createSignedUrlService,
} from "./routes/signed-url-service";
