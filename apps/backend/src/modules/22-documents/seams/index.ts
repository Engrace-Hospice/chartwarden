// apps/backend/src/modules/22-documents/seams — M22's published §4.3 / §7.2 W2 WRITE-side seams (M22-T04).
//
// M22 publishes TWO write-side seams the §7.2 W2 render handshake runs on: `DocumentRenderer` — the
// render-from-typed-payload contract M5/M6/M8/M11/M12/M13/M14/M15/M16/M17/M18/M23/M39 consume (a source module
// hands a `templateKey` + typed payload; M22 renders, stores, and returns the new `document.id` its
// `m22-document-backref` path stamps) — and `DocumentStorageProvider` — the per-tenant object-storage port the
// renderer (and the M22-T07 Signed-URL Service) write rendered bytes / presign downloads through.
//
// `registerDocumentSeams` registers both REAL impls over their boot deny-stubs (before validateSeams()), driven
// from the composition root's wireModuleSeams(). Registering the renderer CLOSES M39's Wave-C `DocumentRenderer`
// deny-stub (M39 consumes it directly via getSeam — see modules/39-consent/consumed-seams.ts). The M6/M9/M11/M12/
// M13 PDF stubs are module-local forward-seam deny-stubs closed over the §4.11 `*.document_requested` outbox
// handshake (M22-T06), not by this registration. Both impls run over ONE injected {@link DocumentRenderStore} +
// {@link DocumentStorageProvider} (in-memory slice here; Drizzle + per-tenant MinIO in prod, M22-T07) — mirrors
// the M18-T05 seams/index.ts precedent. The published §4.3 READER seams (RenderedDocumentProvider, DocumentReader,
// PortalDocumentReader, IntakeMetricsProvider, ExtractionProvenanceReader) land in M22-T05.
import type {
  DocumentReader,
  DocumentRenderer,
  DocumentStorageProvider,
  ExtractionProvenanceReader,
  IntakeMetricsProvider,
  PortalDocumentReader,
  RenderedDocumentProvider,
} from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import { type DocumentRendererDeps, createDocumentRenderer } from "./providers";
import {
  type DocumentSeamReadStore,
  type DocumentSeamSeed,
  createInMemoryDocumentReadStore,
} from "./read-store";
import {
  type PortalPresignPort,
  type PortalSudConsentGate,
  createDocumentReader,
  createExtractionProvenanceReader,
  createIntakeMetricsProvider,
  createPortalDocumentReader,
  createRenderedDocumentProvider,
  inMemoryPortalPresign,
} from "./readers";
import {
  type DocumentRenderStore,
  createInMemoryDocumentRenderStore,
  createInMemoryDocumentStorageProvider,
} from "./store";

export {
  type DocumentRenderAdapter,
  type DocumentRenderOutput,
  type DocumentRendererDeps,
  type TemplateManifest,
  createDocumentRenderer,
  createInMemoryDocumentStorageProvider,
  defaultTemplateManifest,
  formsTemplateManifest,
  placeholderRenderAdapter,
} from "./providers";
export {
  type DocumentRenderStore,
  type InMemoryDocumentRenderStore,
  type InMemoryDocumentStorage,
  type StoredDocument,
  type StoredDocumentVersion,
  createInMemoryDocumentRenderStore,
} from "./store";
export {
  type DocumentSeamReadStore,
  type DocumentSeamRow,
  type DocumentSeamSeed,
  type InMemoryDocumentReadStore,
  type PortalVersionRow,
  createInMemoryDocumentReadStore,
} from "./read-store";
export {
  type PortalPresignPort,
  type PortalSudConsentGate,
  createDocumentReader,
  createExtractionProvenanceReader,
  createIntakeMetricsProvider,
  createPortalDocumentReader,
  createRenderedDocumentProvider,
  inMemoryPortalPresign,
} from "./readers";

/** Deps for M22's write-side seam registration (slice defaults to the in-memory store + storage adapter). */
export interface DocumentSeamDeps {
  /** The §2.2.2 `document`/`document_version` ledger (Drizzle over M22's tables in prod; in-memory in tests). */
  store?: DocumentRenderStore;
  /** The §1.3 per-tenant object-storage port (MinIO in prod; in-memory in tests). */
  storage?: DocumentStorageProvider;
  /** Override the renderer's optional ports (render adapter, manifest resolver, id minter, clock). */
  renderer?: Omit<DocumentRendererDeps, "store" | "storage">;
}

/**
 * Register M22's two §4.3 / §7.2 W2 write-side seams into the M1 registry over their boot deny-stubs (M22-T04;
 * before validateSeams()). `DocumentStorageProvider` is registered first so the `DocumentRenderer` impl resolves
 * over the real storage port. Registering the renderer CLOSES M39's Wave-C deny-stub. Called by wireModuleSeams().
 */
export function registerDocumentSeams(deps: DocumentSeamDeps = {}): void {
  const storage = deps.storage ?? createInMemoryDocumentStorageProvider().provider;
  const store = deps.store ?? createInMemoryDocumentRenderStore().store;
  registerSeam("DocumentStorageProvider", storage);
  registerSeam("DocumentRenderer", createDocumentRenderer({ store, storage, ...deps.renderer }));
}

/** Typed resolver for M22's `DocumentRenderer` (the §7.2 W2 handshake M39 et al. consume; closes M39's deny-stub). */
export function getDocumentRenderer(): DocumentRenderer {
  return getSeam("DocumentRenderer");
}

/** Typed resolver for M22's `DocumentStorageProvider` (the per-tenant object-storage port the renderer/T07 use). */
export function getDocumentStorageProvider(): DocumentStorageProvider {
  return getSeam("DocumentStorageProvider");
}

/** Deps for M22's §4.3 reader-seam registration (slice defaults to the in-memory read store + deterministic presign). */
export interface DocumentReaderSeamDeps {
  /** The §4.3 read port (Drizzle over M22's tables in prod, under consumer RLS; in-memory slice in tests). */
  store?: DocumentSeamReadStore;
  /** Seed for the default in-memory read store (ignored when an explicit `store` is supplied). */
  seed?: DocumentSeamSeed;
  /** The §1.3 presign port the portal reader mints download URLs through (MinIO in prod; deterministic in tests). */
  presign?: PortalPresignPort;
  /** The §2.31 / 42 CFR Part 2 SUD-consent gate the portal reader checks before minting a SUD-class URL (M22-T06).
   *  The composition root adapts M39's REAL `ConsentEvaluator` into it; absent it, the portal fails closed for SUD. */
  consentGate?: PortalSudConsentGate;
}

/**
 * Register M22's five §4.3 published READER seams into the M1 registry over their boot deny-stubs (M22-T05; before
 * validateSeams()). All five share ONE injected {@link DocumentSeamReadStore} so a single Drizzle adapter backs the
 * whole document-metadata + portal + intake-metrics + provenance read surface. None is a mutate path — M22 owns the
 * document/extraction lifecycle internally. Called by the composition root's wireModuleSeams() after the write-side
 * seams (M22-T04). When `consentGate` is supplied (M22-T06 — the composition root adapts M39's REAL
 * `ConsentEvaluator`) the portal reader gates SUD-class downloads on consent; absent it, it fails closed.
 */
export function registerDocumentReaderSeams(deps: DocumentReaderSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryDocumentReadStore(deps.seed ?? {}).store;
  const presign = deps.presign ?? inMemoryPortalPresign;
  registerSeam("RenderedDocumentProvider", createRenderedDocumentProvider(store));
  registerSeam("DocumentReader", createDocumentReader(store));
  registerSeam("PortalDocumentReader", createPortalDocumentReader(store, presign, deps.consentGate));
  registerSeam("IntakeMetricsProvider", createIntakeMetricsProvider(store));
  registerSeam("ExtractionProvenanceReader", createExtractionProvenanceReader(store));
}

/** Typed resolver for M22's `RenderedDocumentProvider` (the §7.2 W2 back-ref read every source module consumes). */
export function getRenderedDocumentProvider(): RenderedDocumentProvider {
  return getSeam("RenderedDocumentProvider");
}

/** Typed resolver for M22's `DocumentReader` (M28 FHIR DocumentReference / M31 portal list / M33 reporting). */
export function getDocumentReader(): DocumentReader {
  return getSeam("DocumentReader");
}

/** Typed resolver for M22's `PortalDocumentReader` (M31 portal read + mint download URL, Phase 2). */
export function getPortalDocumentReader(): PortalDocumentReader {
  return getSeam("PortalDocumentReader");
}

/** Typed resolver for M22's `IntakeMetricsProvider` (M33 reporting + M30 quality measures). */
export function getIntakeMetricsProvider(): IntakeMetricsProvider {
  return getSeam("IntakeMetricsProvider");
}

/** Typed resolver for M22's `ExtractionProvenanceReader` (M28 FHIR Provenance + M30 HQRP AI signal). */
export function getExtractionProvenanceReader(): ExtractionProvenanceReader {
  return getSeam("ExtractionProvenanceReader");
}
