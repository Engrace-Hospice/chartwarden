// apps/backend/__tests__/document-seams.test.ts — M22-T04 (§4.3 / §7.2 W2 the two write-side seams).
//
// Covers the render-from-typed-payload handshake (a first render creates a `document` at v1 + stores bytes with
// the §2.2.2 sha256; a re-render of the same aggregate APPENDS v2 on the SAME document, not a new one — the W2
// addendum shape; a render with no patientId fails closed because the §2.2.2 object key is patient-prefixed),
// the per-tenant storage port (opaque presigned URL, D11), the boot wiring (registerDocumentSeams replaces the
// deny-stubs; validateSeams passes; the deny-stubs deny), and the M39 closure (renderConsentRecordDocument
// returns a real document id once M22 registers the renderer — M39's Wave-C deny-stub is closed).
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, getSeam, validateSeams } from "../src/bootstrap/index";
import { renderConsentRecordDocument } from "../src/modules/39-consent/index";
import {
  createDocumentRenderer,
  createInMemoryDocumentRenderStore,
  createInMemoryDocumentStorageProvider,
  registerDocumentSeams,
} from "../src/modules/22-documents/index";

const ORG = "org-1";
const SCOPE = { orgId: ORG };

function deterministicDeps() {
  const store = createInMemoryDocumentRenderStore();
  const storage = createInMemoryDocumentStorageProvider();
  let n = 0;
  const renderer = createDocumentRenderer({
    store: store.store,
    storage: storage.provider,
    mintId: (prefix) => `${prefix}-${++n}`,
    now: () => "2026-06-22T12:00:00.000Z",
  });
  return { store, storage, renderer };
}

const consentPayload = {
  consentRecordId: "consent-1",
  patientId: "pat-1",
  typeKey: "general_treatment",
  grantorKind: "patient",
  effectiveAt: "2026-06-22T00:00:00.000Z",
  recipients: [{ kind: "physician", displayName: "Dr. Lee" }],
};

describe("DocumentRenderer (§7.2 W2 render handshake)", () => {
  it("first render creates a document at v1 + stores the bytes with a sha256 integrity hash", async () => {
    const { store, storage, renderer } = deterministicDeps();
    const { documentId } = await renderer.render(SCOPE, "consent_record", consentPayload);

    const doc = store.store.get(documentId);
    expect(doc?.aggregateType).toBe("consent_record");
    expect(doc?.aggregateId).toBe("consent-1");
    expect(doc?.patientId).toBe("pat-1");
    expect(doc?.retentionClass).toBe("compliance"); // consent_record is compliance-class (§4.5)
    expect(doc?.sourceKind).toBe("consent_capture");
    expect(doc?.versions).toHaveLength(1);
    expect(doc?.activeVersionNumber).toBe(1);
    // The object key is patient-prefixed (D1) and the bytes landed in the per-tenant storage map with a sha256.
    const version = doc?.versions[0];
    expect(version?.minioObjectKey).toBe(`documents/pat-1/consent_record/${documentId}/${version?.id}.pdf`);
    expect(version?.sha256Hex).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.objects.has(version?.minioObjectKey ?? "")).toBe(true);
  });

  it("re-render of the same aggregate appends v2 on the SAME document (W2 addendum), not a new document", async () => {
    const { store, renderer } = deterministicDeps();
    const first = await renderer.render(SCOPE, "consent_record", consentPayload);
    const second = await renderer.render(SCOPE, "consent_record", consentPayload);
    expect(second.documentId).toBe(first.documentId);
    const doc = store.store.get(first.documentId);
    expect(doc?.versions.map((v) => v.versionNumber)).toEqual([1, 2]);
    expect(doc?.activeVersionNumber).toBe(2);
  });

  it("fails closed when the payload carries no patientId (the object key is patient-prefixed)", async () => {
    const { renderer } = deterministicDeps();
    await expect(renderer.render(SCOPE, "consent_record", { consentRecordId: "c-x" })).rejects.toThrow(
      /patientId/,
    );
  });
});

describe("DocumentStorageProvider (§1.3 per-tenant object-storage port)", () => {
  it("mints an opaque presigned URL carrying the tenant bucket + the D11 PHI-free leaf only", async () => {
    const storage = createInMemoryDocumentStorageProvider();
    const presigned = await storage.provider.presignDownload({
      scope: SCOPE,
      tenantId: ORG,
      objectKey: "documents/pat-1/consent_record/doc-1/ver-1.pdf",
      downloadFilename: "consent_record-abc123def456.pdf",
      ttlSeconds: 300,
    });
    expect(presigned.url).toContain(`tenant-${ORG}`);
    expect(presigned.url).toContain("consent_record-abc123def456.pdf");
    expect(presigned.url).not.toContain("pat-1"); // no patient identifier in a client-facing URL (D11/SEC-015)
  });
});

describe("boot wiring (registerDocumentSeams)", () => {
  afterEach(() => __resetSeamsForTest());

  it("registers both seams so validateSeams passes and they resolve as real impls", async () => {
    registerDocumentSeams();
    expect(() => validateSeams()).not.toThrow();
    const { documentId } = await getSeam("DocumentRenderer").render(SCOPE, "consent_record", consentPayload);
    expect(documentId).toMatch(/^doc-/);
    const presigned = await getSeam("DocumentStorageProvider").presignDownload({
      scope: SCOPE,
      tenantId: ORG,
      objectKey: "documents/pat-1/consent_record/d/v.pdf",
      downloadFilename: "consent_record-zzz999yyy888.pdf",
      ttlSeconds: 60,
    });
    expect(presigned.url).toContain(`tenant-${ORG}`);
  });

  it("falls back to fail-closed deny-stubs when M22 does not register", () => {
    validateSeams();
    expect(() => getSeam("DocumentRenderer").render(SCOPE, "consent_record", consentPayload)).toThrow(
      /not implemented/,
    );
    expect(() =>
      getSeam("DocumentStorageProvider").presignDownload({
        scope: SCOPE,
        tenantId: ORG,
        objectKey: "k",
        downloadFilename: "f.pdf",
        ttlSeconds: 60,
      }),
    ).toThrow(/not implemented/);
  });

  it("CLOSES M39's Wave-C deny-stub: renderConsentRecordDocument returns a real document id", async () => {
    registerDocumentSeams();
    validateSeams();
    const result = await renderConsentRecordDocument(SCOPE, {
      consentRecordId: "consent-99",
      patientId: "pat-9",
      typeKey: "general_treatment",
      grantorKind: "patient",
      effectiveAt: "2026-06-22T00:00:00.000Z",
      recipients: [{ kind: "physician", displayName: "Dr. Ng" }],
    });
    expect(result.documentId).toMatch(/^doc-/);
  });
});
