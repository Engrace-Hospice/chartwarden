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
// precedent (interface in @wardenx/types; impl over a port; registered into the M1 registry).
import type { DocumentRenderer, DocumentStorageProvider } from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import { createDocumentRenderer } from "./renderer";
import { createDocumentStorageProvider } from "./storage-provider";
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

/** Deps for M22's seam registration (slice defaults to the in-memory store + in-memory object store). */
export interface DocumentSeamDeps {
  /** The §4.3 document-row data port (Drizzle over M22's tables in prod; in-memory slice in tests). */
  store?: DocumentSeamStore;
  /** The §11 D1 object-storage port (the MinIO client in prod; in-memory map in tests). */
  objects?: ObjectStorePort;
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
  registerSeam("DocumentRenderer", createDocumentRenderer({ store, objects }));
  registerSeam("DocumentStorageProvider", createDocumentStorageProvider({ objects }));
}

/** Typed resolver for M22's DocumentRenderer (sound: registered real impl; validateSeams guards it). */
export function getDocumentRenderer(): DocumentRenderer {
  return getSeam("DocumentRenderer");
}

/** Typed resolver for M22's DocumentStorageProvider. */
export function getDocumentStorageProvider(): DocumentStorageProvider {
  return getSeam("DocumentStorageProvider");
}
