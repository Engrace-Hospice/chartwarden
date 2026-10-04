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
import type { DbClient } from "@wardenx/db";
import { DegradedError } from "@wardenx/types";
import type { FastifyInstance } from "fastify";
import { getSeam } from "../../bootstrap/index";
import { registerDocumentAbacPredicates as _registerM22Abac } from "./abac-predicates";
import { createDbDocumentBackend } from "./documents-route-service-db";
import {
  type DocumentFeatureFlagReader as _DocumentFeatureFlagReader,
  createDocLensPipelineService as _createDocLensPipelineService,
  registerDocLensExtractionRoutes as _registerDocLensExtractionRoutes,
  resolveDocLensCapability as _resolveDocLensCapability,
} from "./extraction/index";
import type { DocLensIntakeEnqueue } from "./extraction/intake-queue";
import type { ExtractionWritebackDeps } from "./extraction/writeback-commit-db";
import { registerDocumentRoutes as _registerM22Routes } from "./routes/documents-routes";
import { createSignedUrlService as _createSignedUrlService } from "./routes/signed-url-service";
import { createVerifiedUploadService } from "./routes/verified-upload";
import { registerVerifiedUploadRoutes } from "./routes/verified-upload-routes";
import {
  createDocumentStorageProvider,
  createS3ObjectStore,
  s3ObjectStoreConfigFromEnv,
} from "./seams/index";

/**
 * M22L-T01 — mount the M22 document routes over the PRODUCTION Drizzle read backend + ABAC/object
 * resolvers (RLS-scoped under `withOrgContext`). Called from the composition root's db branch. Reads are
 * live (document library + detail, version ledger, intake batch/classification/job/candidate/review,
 * form-template catalog + overlays + fills); metadata/review writes are live, while upload/version creation
 * and signed-URL presigning stay typed `DegradedError` refusals until M22's object-storage
 * adapter is unwired, and a presign resolving to a URL nothing can serve is a download failure a clinician
 * reads as data loss (a WORKING one would hand out PHI from a store with no BAA gate). Replaces the
 * in-memory clinical-core scaffold mount for M22.
 */
export function mountDocumentRoutes(
  app: FastifyInstance,
  db: DbClient,
  flags?: _DocumentFeatureFlagReader,
  writeback: ExtractionWritebackDeps = {},
  intake?: DocLensIntakeEnqueue,
): void {
  const backend = createDbDocumentBackend(db, writeback);
  const objectStoreConfig = s3ObjectStoreConfigFromEnv(process.env);
  const objects = objectStoreConfig ? createS3ObjectStore(objectStoreConfig) : null;
  _registerM22Abac({ resolver: backend.abacResolver });
  _registerM22Routes(app, {
    service: backend.service,
    signedUrl: _createSignedUrlService({
      storage: objects
        ? createDocumentStorageProvider({ objects })
        : {
            presignDownload: () => {
              throw new DegradedError(
                "document-storage",
                "no object-storage presigner is bound (MINIO_* is not configured)",
              );
            },
          },
      resolver: backend.objectResolver,
    }),
    referralReader: {
      canAccessReferral(input) {
        return getSeam("ReferralReader").canAccessReferral(input);
      },
    },
  });
  registerVerifiedUploadRoutes(
    app,
    createVerifiedUploadService({
      db,
      objects,
      referralReader: {
        canAccessReferral(input) {
          return getSeam("ReferralReader").canAccessReferral(input);
        },
      },
    }),
  );

  // §7.1 W1 / depends-on-32 — the DocLens extraction surface (F-090). It was BUILT and MOUNTED BY
  // NOTHING: `registerDocLensExtractionRoutes` was re-exported from `extraction/index.ts` and called
  // from no composition root, so `POST /api/v1/intake/uploads/:id/extraction/run` and
  // `/api/v1/intake/jobs/:id/extraction/commit` — both of which the published contract advertises,
  // because `scan-routes.ts` reads SOURCE — answered 404 rather than the 503 this module spends a
  // paragraph specifying. Those are different statements: 404 tells an integrator the endpoint does
  // not exist, 503 EXTRACTION_DISABLED with `Retry-After: 0` tells them the capability is off for
  // this tenant. The second is the true one, and it is what the routes now return.
  //
  // It also meant the activation switch was wired to nothing. `documents.doclens` is a CAPABILITY
  // flag whose whole job is to turn this surface on when M32 lands; flipping it on an unmounted
  // registrar does nothing at all.
  //
  // F-091 — this is where that line changed. The comment here used to say no flag reader was threaded
  // because nothing at boot read the `feature_flag` table: M1's `createDefaultFeatureFlagReader` answered
  // `{}` for every org, and M34's admin surface — which the note credited with WRITING flags — was in
  // fact bound to a stub that threw on all three methods, so the table had neither a reader nor a writer
  // and `documents.doclens` was unreachable from both ends. The composition root now binds the real M1
  // reader and passes it here; `flags` stays optional because a no-db/slice boot has none to give, and
  // absent still resolves to the documented Phase-1 503.
  //
  // Turning the flag ON does not, on its own, make DocLens work — the pipeline still needs M32 to bind a
  // classifier/extractor/vision-verifier, which `_resolveDocLensCapability()` reports. What changes is
  // that the switch is now connected to something: a tenant that has been granted the capability gets the
  // capability's own answer instead of a blanket "off" that no operator could lift.
  _registerDocLensExtractionRoutes(app, {
    // Both layers take the reader: the route gate answers 503 before any work, and the pipeline
    // service re-checks so a caller reaching it by another path cannot skip the capability gate.
    pipeline: _createDocLensPipelineService({
      capability: _resolveDocLensCapability(),
      ...(flags ? { flags } : {}),
    }),
    ...(flags ? { flags } : {}),
    ...(intake ? { intake } : {}),
  });
}

export {
  createDbDocumentBackend,
  createDbDocumentRouteService,
  createDbDocumentAbacResolver,
  createDbSignedUrlObjectResolver,
} from "./documents-route-service-db";

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
  type DrizzleDocumentEraseDeps,
  createDocumentEraser,
  createDrizzleDocumentEraseStore,
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
export { registerVerifiedUploadRoutes } from "./routes/verified-upload-routes";
export {
  type InitiateVerifiedUploadInput,
  MAX_DOCUMENT_UPLOAD_BYTES,
  type VerifiedUploadService,
  createVerifiedUploadService,
} from "./routes/verified-upload";
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
export { M22_OUTBOX_EVENTS, M22_DOCUMENT_RENDERED_EVENT } from "./events-by-m22";
