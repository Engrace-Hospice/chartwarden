// apps/backend/src/modules/22-documents/seams — M22's published §4.3 seams (M22-T04). M22 publishes the two
// boot-registered surfaces of the §7.2 W2 render-from-typed-payload handshake every source module consumes
// instead of importing M22's schema (architecture §11 blocks the schema import):
//
//   • DocumentRenderer (the W2 render handshake) — render(scope, templateKey, payload) → { documentId }.
//     Registering the real impl over its boot deny-stub CLOSES the forward-seam deny-stub M39 consent's
//     Wave-C render path resolved to (M39 `getConsentDocumentRenderer`), and the M6/M8/M11/M12/M13/M14/…
//     PDF render stubs every source module's `m22-document-backref` consumer awaited.
//   • DocumentStorageProvider (the §11 D1 per-tenant object store) — presign-download + version-aware
//     destroy. Pure key/presign math is the T03 lifecycle/storage logic; this impl is the thin IO layer.
//
// `registerDocumentSeams` registers both real impls over their boot deny-stubs (before validateSeams()),
// driven from the composition root's wireModuleSeams(). Both compose over an injected store/object-store
// port (in-memory slice here; Drizzle + MinIO in prod, under the consumer's RLS). Mirrors the M7/M8 seams
// precedent (interface in @chartwarden/types; impl over a port; registered into the M1 registry).
import type {
  DocumentReader,
  DocumentRenderer,
  DocumentStorageProvider,
  ExtractionProvenanceReader,
  IntakeMetricsProvider,
  PortalDocumentReader,
  RenderedDocumentProvider,
} from "@chartwarden/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import {
  createDocumentReader,
  createExtractionProvenanceReader,
  createIntakeMetricsProvider,
  createPortalDocumentReader,
  createRenderedDocumentProvider,
} from "./readers";
import {
  type DocumentReaderStore,
  type PortalAccessLogPort,
  type PortalConsentPort,
  createInMemoryDocumentReaderStore,
  createInMemoryPortalAccessLog,
  createInMemoryPortalConsentPort,
} from "./readers-store";
import { createDocumentRenderer } from "./renderer";
import { createDocumentStorageProvider } from "./storage-provider";
export {
  createDrizzleDocumentReaderStore,
  createDrizzlePortalAccessLog,
  createDrizzleStaffMintAccessLog,
  createRefusingObjectStore,
} from "./drizzle-readers-store";
export { RENDER_SYSTEM_MEMBERSHIP_ID, createDrizzleDocumentSeamStore } from "./drizzle-seam-store";
// The PRODUCTION MinIO/S3 ObjectStorePort (dependency-free SigV4 over fetch + node:crypto) — binds
// over the refusing adapter when the MINIO_* env contract is present (composition-root decision).
export {
  type ListedObjectVersion,
  type ParsedVersionList,
  type S3ObjectStoreConfig,
  type S3ObjectStoreDeps,
  type TenantStorageEnsureResult,
  DEFAULT_PRESIGN_TTL_SECONDS,
  createS3ObjectStore,
  createS3TenantStorageProvisioner,
  parseListObjectVersionsXml,
  s3ObjectStoreConfigFromEnv,
  sigV4AmzDate,
  sigV4CanonicalQuery,
  sigV4CanonicalRequest,
  sigV4Sha256Hex,
  sigV4Signature,
  sigV4SigningKey,
  sigV4StringToSign,
  sigV4UriEncode,
} from "./s3-object-store";
import {
  type DocumentSeamStore,
  type ObjectStorePort,
  createInMemoryDocumentSeamStore,
  createInMemoryObjectStore,
} from "./store";

export {
  type DocumentSeamSeed,
  type DocumentSeamStore,
  type ObjectStorePort,
  type RenderUpsert,
  type RenderedDocumentRow,
  createInMemoryDocumentSeamStore,
  createInMemoryObjectStore,
} from "./store";
export {
  type DocumentRendererDeps,
  type NowClock,
  type RenderPayloadCore,
  type ShortIdFn,
  type TemplateDescriptor,
  PLATFORM_TEMPLATE_TABLE,
  UnknownTemplateError,
  createDocumentRenderer,
} from "./renderer";
export {
  type DocumentStorageProviderDeps,
  createDocumentStorageProvider,
} from "./storage-provider";
export {
  type DocumentReaderSeed,
  type DocumentReaderStore,
  type PortalConsentPort,
  type RenderedAggregateRow,
  createInMemoryDocumentReaderStore,
  type PortalAccessLogEntry,
  type PortalAccessLogPort,
  createInMemoryPortalAccessLog,
  createInMemoryPortalConsentPort,
  createSudConsentEvaluatorPortalConsentPort,
} from "./readers-store";
export {
  createDocumentReader,
  createExtractionProvenanceReader,
  createIntakeMetricsProvider,
  createPortalDocumentReader,
  createRenderedDocumentProvider,
} from "./readers";

/** Deps for M22's seam registration (slice defaults to the in-memory store + in-memory object store). */
export interface DocumentSeamDeps {
  /** The §4.3 document-row data port (Drizzle over M22's tables in prod; in-memory slice in tests). */
  store?: DocumentSeamStore;
  /** The §11 D1 object-storage port (the MinIO client in prod; in-memory map in tests). */
  objects?: ObjectStorePort;
  /** The §4.3 published-reader data port (Drizzle over M22's read projections in prod; in-memory in tests). */
  readers?: DocumentReaderStore;
  /** The §4.3 portal SUD-consent gate (M39 ConsentEvaluator in prod; in-memory map in tests). */
  portalConsent?: PortalConsentPort;
  /** F-225 (#248) — the §164.528 `document_access_log` appender the portal mint writes through (Drizzle in prod). */
  portalAccessLog?: PortalAccessLogPort;
}

/**
 * Register M22's two §4.3 published seams into the M1 registry over their boot deny-stubs (M22-T04; before
 * validateSeams()). `DocumentRenderer` (W2 render handshake) + `DocumentStorageProvider` (object store)
 * share one injected object-store port so a single MinIO adapter backs the render-write + the
 * presign/destroy paths. Called by the composition root's wireModuleSeams(). Registering the renderer
 * CLOSES the forward-seam deny-stub M39/M6/M8/M11/M12/M13/M14 awaited — getSeam("DocumentRenderer") now
 * resolves to the real publisher.
 */
export function registerDocumentSeams(deps: DocumentSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryDocumentSeamStore().store;
  const objects = deps.objects ?? createInMemoryObjectStore().store;
  const readers = deps.readers ?? createInMemoryDocumentReaderStore().store;
  const portalConsent = deps.portalConsent ?? createInMemoryPortalConsentPort();
  const portalAccessLog = deps.portalAccessLog ?? createInMemoryPortalAccessLog();
  registerSeam("DocumentRenderer", createDocumentRenderer({ store, objects }));
  registerSeam("DocumentStorageProvider", createDocumentStorageProvider({ objects }));
  // §4.3 the five PUBLISHED reader seams — all real impls over the shared reader port (+ object/consent ports
  // for the portal mint). Registering them CLOSES the M28/M30/M31/M33 + every source module back-ref deny-stub.
  registerSeam("RenderedDocumentProvider", createRenderedDocumentProvider(readers));
  registerSeam("DocumentReader", createDocumentReader(readers));
  registerSeam(
    "PortalDocumentReader",
    createPortalDocumentReader({
      store: readers,
      objects,
      consent: portalConsent,
      accessLog: portalAccessLog,
    }),
  );
  registerSeam("IntakeMetricsProvider", createIntakeMetricsProvider(readers));
  registerSeam("ExtractionProvenanceReader", createExtractionProvenanceReader(readers));
}

/** Typed resolver for M22's DocumentRenderer (sound: registered real impl; validateSeams guards it). */
export function getDocumentRenderer(): DocumentRenderer {
  return getSeam("DocumentRenderer");
}

/** Typed resolver for M22's DocumentStorageProvider. */
export function getDocumentStorageProvider(): DocumentStorageProvider {
  return getSeam("DocumentStorageProvider");
}

/** Typed resolver for M22's RenderedDocumentProvider (every source module's back-ref consumer resolves it). */
export function getRenderedDocumentProvider(): RenderedDocumentProvider {
  return getSeam("RenderedDocumentProvider");
}

/** Typed resolver for M22's DocumentReader (M28 FHIR / M31 portal list / M33 reporting resolve it). */
export function getDocumentReader(): DocumentReader {
  return getSeam("DocumentReader");
}

/** Typed resolver for M22's PortalDocumentReader (M31 portal resolves it — Phase 2). */
export function getPortalDocumentReader(): PortalDocumentReader {
  return getSeam("PortalDocumentReader");
}

/** Typed resolver for M22's IntakeMetricsProvider (M33/M30 reporting resolve it). */
export function getIntakeMetricsProvider(): IntakeMetricsProvider {
  return getSeam("IntakeMetricsProvider");
}

/** Typed resolver for M22's ExtractionProvenanceReader (M28 FHIR Provenance / M30 resolve it). */
export function getExtractionProvenanceReader(): ExtractionProvenanceReader {
  return getSeam("ExtractionProvenanceReader");
}
