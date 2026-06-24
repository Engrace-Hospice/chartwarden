// apps/backend/__tests__/document-readers.test.ts — M22-T05 the five §4.3 PUBLISHED reader seams.
//
// Covers each reader over its in-memory slice + the boot wiring: RenderedDocumentProvider (back-ref resolve),
// DocumentReader (digest list keyset-paged + by-id metadata), PortalDocumentReader (patient-facing filter +
// the three mint gates: not_owner / not_patient_facing / sud_consent_absent + happy-path URL),
// IntakeMetricsProvider (throughput counts), ExtractionProvenanceReader (per-chart-field provenance — rows
// exist though DocLens is OFF), and registerDocumentSeams replacing all five deny-stubs so validateSeams passes.
import { afterEach, describe, expect, it } from "vitest";
import {
  NotImplementedError,
  __resetSeamsForTest,
  getSeam,
  validateSeams,
} from "../src/bootstrap/index";
import {
  type DocumentReaderSeed,
  createDocumentReader,
  createExtractionProvenanceReader,
  createInMemoryDocumentReaderStore,
  createInMemoryObjectStore,
  createInMemoryPortalConsentPort,
  createIntakeMetricsProvider,
  createPortalDocumentReader,
  createRenderedDocumentProvider,
  getDocumentReader,
  getExtractionProvenanceReader,
  getIntakeMetricsProvider,
  getPortalDocumentReader,
  getRenderedDocumentProvider,
  registerDocumentSeams,
} from "../src/modules/22-documents/index";
import type { DocumentDigest } from "@wardenx/types";

const ORG = "org-1";

afterEach(() => __resetSeamsForTest());

function digest(over: Partial<DocumentDigest> & Pick<DocumentDigest, "documentId" | "createdAt">): DocumentDigest {
  return {
    organizationId: ORG,
    patientId: "pat-1",
    admissionId: null,
    aggregateType: "encounter",
    aggregateId: "agg-1",
    title: "Doc",
    retentionClass: "clinical_record",
    status: "active",
    patientFacing: true,
    activeVersionId: `${over.documentId}-v1`,
    updatedAt: over.createdAt,
    ...over,
  };
}

const SEED: DocumentReaderSeed = {
  rendered: [
    {
      aggregateType: "cti",
      aggregateId: "cti-1",
      organizationId: ORG,
      documentId: "doc-cti",
      versionId: "doc-cti-v1",
      renderedAt: "2026-06-24T00:00:00.000Z",
    },
  ],
  documents: [
    digest({ documentId: "d1", createdAt: "2026-06-20T00:00:00.000Z", aggregateType: "encounter" }),
    digest({ documentId: "d2", createdAt: "2026-06-22T00:00:00.000Z", aggregateType: "nor" }),
    digest({ documentId: "d3", createdAt: "2026-06-23T00:00:00.000Z", patientFacing: false }),
    digest({ documentId: "d4", createdAt: "2026-06-21T00:00:00.000Z", patientId: "pat-2" }),
  ],
  sudConsentByPatient: { "pat-1": false },
  intakeMetrics: [
    {
      organizationId: ORG,
      bundlesProcessed: 12,
      bundlesInReview: 3,
      avgTimeToReviewMinutes: 45,
      candidatesApproved: 30,
      candidatesRejected: 4,
    },
  ],
  provenance: [
    {
      provenanceId: "prov-1",
      extractionDecisionId: "dec-1",
      extractionCandidateId: "cand-1",
      sourceDocumentId: "d1",
      sourceDocumentVersionId: "d1-v1",
      sourcePage: 2,
      targetModule: "m12",
      targetFieldPath: "medication.name",
      targetAggregateId: "order-9",
      classifierModelVersionRef: "clf@1",
      extractorModelVersionRef: "ext@1",
      visionVerifierModelVersionRef: null,
      committedAt: "2026-06-20T00:00:00.000Z",
    },
  ],
};

describe("RenderedDocumentProvider", () => {
  it("resolves the rendered document for an aggregate, null otherwise", async () => {
    const { store } = createInMemoryDocumentReaderStore(SEED);
    const r = createRenderedDocumentProvider(store);
    expect(await r.getRenderedDocumentForAggregate({ aggregateType: "cti", aggregateId: "cti-1", organizationId: ORG }))
      .toMatchObject({ documentId: "doc-cti", versionId: "doc-cti-v1" });
    expect(await r.getRenderedDocumentForAggregate({ aggregateType: "cti", aggregateId: "nope", organizationId: ORG }))
      .toBeNull();
  });
});

describe("DocumentReader", () => {
  it("lists a patient's documents newest-first and pages by sinceCursor", async () => {
    const { store } = createInMemoryDocumentReaderStore(SEED);
    const r = createDocumentReader(store);
    const page1 = await r.documentsForPatient({ patientId: "pat-1", organizationId: ORG, limit: 2 });
    expect(page1.map((d) => d.documentId)).toEqual(["d3", "d2"]); // 06-23, 06-22
    const cursor = `${page1[1]!.createdAt}|${page1[1]!.documentId}`;
    const page2 = await r.documentsForPatient({ patientId: "pat-1", organizationId: ORG, sinceCursor: cursor, limit: 2 });
    expect(page2.map((d) => d.documentId)).toEqual(["d1"]); // 06-20 (pat-2's d4 excluded)
  });

  it("filters by aggregateType and reads by-id metadata", async () => {
    const { store } = createInMemoryDocumentReaderStore(SEED);
    const r = createDocumentReader(store);
    const nors = await r.documentsForPatient({ patientId: "pat-1", organizationId: ORG, aggregateType: "nor" });
    expect(nors.map((d) => d.documentId)).toEqual(["d2"]);
    expect(await r.documentMetadata({ documentId: "d1", organizationId: ORG })).toMatchObject({ documentId: "d1" });
    expect(await r.documentMetadata({ documentId: "ghost", organizationId: ORG })).toBeNull();
  });
});

describe("PortalDocumentReader", () => {
  function makePortal(seed = SEED, isSudVersion?: (v: string) => boolean) {
    const { store } = createInMemoryDocumentReaderStore(seed);
    const objects = createInMemoryObjectStore().store;
    const consent = createInMemoryPortalConsentPort(seed.sudConsentByPatient);
    return createPortalDocumentReader({ store, objects, consent, isSudVersion });
  }

  it("returns only patient-facing documents as the portal-safe digest", async () => {
    const portal = makePortal();
    const list = await portal.documentsForPatient({ patientId: "pat-1", organizationId: ORG });
    // d3 is patient_facing:false → excluded; d1/d2 included; the projection has no internal tags
    expect(list.map((d) => d.documentId).sort()).toEqual(["d1", "d2"]);
    expect(Object.keys(list[0]!)).toEqual(
      expect.arrayContaining(["documentId", "aggregateType", "title", "activeVersionId", "createdAt"]),
    );
    expect(list[0]).not.toHaveProperty("retentionClass");
  });

  it("mints a download URL on the happy path", async () => {
    const portal = makePortal();
    const res = await portal.mintPortalDownloadUrl({
      documentVersionId: "d1-v1",
      portalSessionId: "sess-1",
      patientId: "pat-1",
      organizationId: ORG,
    });
    expect("url" in res ? res.url : undefined).toContain("d1-v1");
  });

  it("denies not_owner when the version belongs to a different patient", async () => {
    const portal = makePortal();
    const res = await portal.mintPortalDownloadUrl({
      documentVersionId: "d4-v1", // pat-2's
      portalSessionId: "s",
      patientId: "pat-1",
      organizationId: ORG,
    });
    expect(res).toEqual({ denied: true, reason: "not_owner" });
  });

  it("denies not_patient_facing for a non-portal document", async () => {
    const portal = makePortal();
    const res = await portal.mintPortalDownloadUrl({
      documentVersionId: "d3-v1", // patient_facing:false
      portalSessionId: "s",
      patientId: "pat-1",
      organizationId: ORG,
    });
    expect(res).toEqual({ denied: true, reason: "not_patient_facing" });
  });

  it("denies sud_consent_absent when the version is SUD-class and consent is missing", async () => {
    const portal = makePortal(SEED, (v) => v === "d1-v1");
    const res = await portal.mintPortalDownloadUrl({
      documentVersionId: "d1-v1",
      portalSessionId: "s",
      patientId: "pat-1",
      organizationId: ORG,
    });
    expect(res).toEqual({ denied: true, reason: "sud_consent_absent" });
  });

  it("allows a SUD-class download when consent is present", async () => {
    const seed = { ...SEED, sudConsentByPatient: { "pat-1": true } };
    const portal = makePortal(seed, (v) => v === "d1-v1");
    const res = await portal.mintPortalDownloadUrl({
      documentVersionId: "d1-v1",
      portalSessionId: "s",
      patientId: "pat-1",
      organizationId: ORG,
    });
    expect("url" in res).toBe(true);
  });
});

describe("IntakeMetricsProvider", () => {
  it("returns the org's throughput counts (zeros when unseeded)", async () => {
    const { store } = createInMemoryDocumentReaderStore(SEED);
    const m = createIntakeMetricsProvider(store);
    expect(await m.metricsForOrg({ organizationId: ORG, from: "2026-06-01T00:00:00.000Z", to: "2026-06-30T00:00:00.000Z" }))
      .toMatchObject({ bundlesProcessed: 12, candidatesApproved: 30 });
    expect(await m.metricsForOrg({ organizationId: "org-x", from: "a", to: "b" }))
      .toMatchObject({ bundlesProcessed: 0 });
  });
});

describe("ExtractionProvenanceReader", () => {
  it("returns the provenance records for a chart-target aggregate (data exists, DocLens OFF)", async () => {
    const { store } = createInMemoryDocumentReaderStore(SEED);
    const p = createExtractionProvenanceReader(store);
    const recs = await p.provenanceForTargetAggregate({ targetModule: "m12", targetAggregateId: "order-9", organizationId: ORG });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ sourceDocumentId: "d1", sourcePage: 2 });
    expect(await p.provenanceForTargetAggregate({ targetModule: "m12", targetAggregateId: "none", organizationId: ORG }))
      .toHaveLength(0);
  });
});

describe("boot wiring (registerDocumentSeams)", () => {
  it("registers all five readers over their deny-stubs so validateSeams passes", () => {
    registerDocumentSeams({ readers: createInMemoryDocumentReaderStore(SEED).store });
    expect(() => validateSeams()).not.toThrow();
    expect(getRenderedDocumentProvider()).toBeDefined();
    expect(getDocumentReader()).toBeDefined();
    expect(getPortalDocumentReader()).toBeDefined();
    expect(getIntakeMetricsProvider()).toBeDefined();
    expect(getExtractionProvenanceReader()).toBeDefined();
  });

  it("without registration, validateSeams applies the fail-closed deny-stubs (deny loudly on call)", () => {
    validateSeams(); // no registerDocumentSeams() — deny-stubs stand
    expect(() => getSeam("DocumentReader").documentMetadata({ documentId: "x", organizationId: ORG }))
      .toThrowError(NotImplementedError);
    expect(() =>
      getSeam("ExtractionProvenanceReader").provenanceForTargetAggregate({
        targetModule: "m12",
        targetAggregateId: "x",
        organizationId: ORG,
      }),
    ).toThrowError(NotImplementedError);
  });
});
