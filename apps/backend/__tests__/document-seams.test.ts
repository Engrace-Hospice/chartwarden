import type {
  DocumentRenderer,
  DocumentStorageProvider,
  SignedUrlDescriptor,
} from "@wardenx/types";
// apps/backend/__tests__/document-seams.test.ts — M22-T04 (§4.3 DocumentRenderer + DocumentStorageProvider).
//
// M22 publishes the two boot-registered surfaces of the §7.2 W2 render-from-typed-payload handshake. These
// cover: the renderer handshake (template resolution → PHI-free key → object write → document upsert →
// { documentId }), the W2 addendum-as-new-VERSION (not a new document) path, the unknown-template refusal,
// the storage provider (presign + version-aware destroy) over the object-store port, and the boot wiring
// (registerDocumentSeams replaces BOTH deny-stubs; validateSeams passes; the deny-stubs deny loudly).
import { afterEach, describe, expect, it } from "vitest";
import {
  NotImplementedError,
  __resetSeamsForTest,
  getSeam,
  validateSeams,
} from "../src/bootstrap/index";
import {
  type DocumentSeamStore,
  type ObjectStorePort,
  UnknownTemplateError,
  createDocumentRenderer,
  createDocumentStorageProvider,
  createInMemoryDocumentSeamStore,
  createInMemoryObjectStore,
  getDocumentRenderer,
  getDocumentStorageProvider,
  registerDocumentSeams,
} from "../src/modules/22-documents/index";
import { deriveTenantBucket, planSignedUrl } from "../src/modules/22-documents/index";

const ORG = "org-1";
const scope = { orgId: ORG };

afterEach(() => __resetSeamsForTest());

/** A renderer + its backing slices, with deterministic clock + short-id so keys/timestamps are stable. */
function makeRenderer(seed?: Parameters<typeof createInMemoryDocumentSeamStore>[0]): {
  renderer: DocumentRenderer;
  store: DocumentSeamStore;
  objects: ObjectStorePort;
  liveObjects: Map<string, Uint8Array>;
} {
  const { store } = createInMemoryDocumentSeamStore(seed);
  const objSlice = createInMemoryObjectStore();
  let n = 0;
  const renderer = createDocumentRenderer({
    store,
    objects: objSlice.store,
    now: () => "2026-06-23T00:00:00.000Z",
    shortId: () => (++n).toString(16).padStart(12, "0"),
  });
  return { renderer, store, objects: objSlice.store, liveObjects: objSlice.objects };
}

describe("DocumentRenderer — §7.2 W2 render handshake", () => {
  it("renders a typed payload: writes the object then upserts the genesis document", async () => {
    const { renderer, store, liveObjects } = makeRenderer();
    const { documentId } = await renderer.render(scope, "cti", {
      aggregateId: "cti-1",
      patientId: "pat-1",
    });
    expect(documentId).toMatch(/^[0-9a-f-]{36}$/);

    // the bytes were written under a PHI-free, opaque key in the tenant bucket (D1/D11).
    expect(liveObjects.size).toBe(1);
    const key = [...liveObjects.keys()][0];
    expect(key.startsWith(`${deriveTenantBucket(ORG)}/documents/pat-1/cti/`)).toBe(true);
    expect(key).not.toContain("Certification"); // no free-text title in the key

    // the document is now resolvable for the source aggregate (the back-ref the consumer applies).
    const back = await store.renderedDocumentForAggregate({
      aggregateType: "cti",
      aggregateId: "cti-1",
      organizationId: ORG,
    });
    expect(back?.documentId).toBe(documentId);
    expect(back?.renderedAt).toBe("2026-06-23T00:00:00.000Z");
  });

  it("W2: an addendum re-render is a NEW version, not a new document", async () => {
    const { renderer, store } = makeRenderer();
    const first = await renderer.render(scope, "encounter", {
      aggregateId: "enc-1",
      patientId: "pat-9",
    });
    const second = await renderer.render(scope, "encounter", {
      aggregateId: "enc-1",
      patientId: "pat-9",
    });
    // same document, the latest version is the addendum.
    expect(second.documentId).toBe(first.documentId);
    const back = await store.renderedDocumentForAggregate({
      aggregateType: "encounter",
      aggregateId: "enc-1",
      organizationId: ORG,
    });
    expect(back?.documentId).toBe(first.documentId);
  });

  it("routes a patient-less aggregate (intake) under the intake/ prefix, never a patient prefix", async () => {
    const { renderer, liveObjects } = makeRenderer();
    await renderer.render(scope, "consent_record", { aggregateId: "consent-1", patientId: null });
    const key = [...liveObjects.keys()][0];
    expect(key.includes("/intake/consent-1/")).toBe(true);
  });

  it("refuses an unknown template key (no document row created)", async () => {
    const { renderer, liveObjects } = makeRenderer();
    await expect(renderer.render(scope, "not-a-template", { aggregateId: "x" })).rejects.toThrow(
      UnknownTemplateError,
    );
    expect(liveObjects.size).toBe(0);
  });

  it("refuses a payload missing the aggregate identity", async () => {
    const { renderer } = makeRenderer();
    await expect(renderer.render(scope, "cti", { patientId: "pat-1" })).rejects.toThrow(
      UnknownTemplateError,
    );
  });
});

describe("DocumentStorageProvider — §11 D1 object store", () => {
  const descriptor: SignedUrlDescriptor = planSignedUrl({
    organizationId: ORG,
    objectKey: "documents/pat-1/cti/doc-1/cti-abc.pdf",
    accessKind: "content_download",
  });

  it("presigns a download URL honouring the descriptor TTL (URL is opaque, key-derived)", async () => {
    const { store } = createInMemoryObjectStore();
    const provider = createDocumentStorageProvider({ objects: store });
    const { url, expiresAt } = await provider.presignDownload({ descriptor, organizationId: ORG });
    expect(url).toContain(descriptor.objectKey);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("version-aware destroy removes the object (D12 / DR-019)", async () => {
    const slice = createInMemoryObjectStore();
    await slice.store.putObject({
      bucket: descriptor.bucket,
      objectKey: descriptor.objectKey,
      bytes: new TextEncoder().encode("pdf"),
    });
    expect(slice.objects.size).toBe(1);
    const provider = createDocumentStorageProvider({ objects: slice.store });
    await provider.destroyAllObjectVersions({
      bucket: descriptor.bucket,
      objectKey: descriptor.objectKey,
      organizationId: ORG,
    });
    expect(slice.objects.size).toBe(0);
  });
});

describe("boot wiring — registerDocumentSeams closes the deny-stubs", () => {
  it("registers BOTH real impls; validateSeams passes; resolvers return them", () => {
    registerDocumentSeams();
    validateSeams();
    const renderer = getDocumentRenderer();
    const storage = getDocumentStorageProvider();
    expect(typeof renderer.render).toBe("function");
    expect(typeof storage.presignDownload).toBe("function");
    expect(typeof storage.destroyAllObjectVersions).toBe("function");
  });

  it("the real renderer CLOSES the M39/M6/M8/M11/M12/M13/M14 forward-seam deny-stub", async () => {
    registerDocumentSeams();
    validateSeams();
    // a consumer resolving via the registry (the M39 path) now reaches the REAL publisher.
    const { documentId } = await getSeam("DocumentRenderer").render(scope, "consent_record", {
      aggregateId: "consent-7",
      patientId: "pat-7",
    });
    expect(documentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("without registration, validateSeams applies the fail-closed deny-stubs (deny loudly on call)", () => {
    validateSeams(); // no registerDocumentSeams() — deny-stubs stand
    // the deny-stubs throw synchronously (NotImplementedError) the moment they are called.
    expect(() => getSeam("DocumentRenderer").render(scope, "cti", { aggregateId: "x" })).toThrow(
      NotImplementedError,
    );
    expect(() =>
      getSeam("DocumentStorageProvider").destroyAllObjectVersions({
        bucket: "b",
        objectKey: "k",
        organizationId: ORG,
      }),
    ).toThrow(NotImplementedError);
  });

  it("a custom Drizzle-style store/object port can be injected at registration", async () => {
    const { store } = createInMemoryDocumentSeamStore();
    const { store: objects } = createInMemoryObjectStore();
    registerDocumentSeams({ store, objects });
    validateSeams();
    const { documentId } = await getSeam("DocumentRenderer").render(scope, "f2f", {
      aggregateId: "f2f-1",
      patientId: "pat-2",
    });
    expect(documentId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
