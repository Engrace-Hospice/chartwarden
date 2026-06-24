// apps/backend/src/modules/22-documents — M22 Document Management module root.
// M22-T03 adds the pure §2.2 document-lifecycle domain under ./lifecycle (versioning, retention classes,
// legal hold, access-log, patient-merge redirect). Storage stays a port (DocumentStorageProvider).
// M22-T04 adds the two §4.3 published seams under ./seams (the §7.2 W2 render handshake + the object store),
// registered into the M1 registry via `registerDocumentSeams` — closing the M39/M6/M8/M11/M12/M13/M14 stubs.
// M22-T06 adds the §4.11 outbox subscriptions (the eight `*.document_requested` render-request consumers)
// + the §4.12 disclosure gates (M39 `ConsentEvaluator` SUD gate + M40 `BaaStatusProvider` external-presign
// gate) under ./outbox-consumers — a pure decision core + real-seam resolvers; the dispatcher binding is
// forward-declared/deferred (M6-T11 / M7-T08 precedent; no new dependsOn edge — M22 deps stay [1, 5]).
export * from "./lifecycle/index";
export * from "./seams/index";
export * from "./outbox-consumers/index";
