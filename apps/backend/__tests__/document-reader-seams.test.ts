// apps/backend/__tests__/document-reader-seams.test.ts — M22-T05 (§4.3 the five published READER seams).
//
// Covers the boot wiring (registerDocumentReaderSeams replaces the deny-stubs; validateSeams passes; the
// deny-stubs deny) and each reader's projection: the W2 back-ref read (RenderedDocumentProvider), the
// document-metadata reads + org scoping + cursor (DocumentReader), the portal list + mint-URL structural gates
// (PortalDocumentReader), the org-level intake aggregate (IntakeMetricsProvider), and the per-target-aggregate
// provenance (ExtractionProvenanceReader).
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, getSeam, validateSeams } from "../src/bootstrap/index";
import {
  type DocumentSeamRow,
  type DocumentSeamSeed,
  createInMemoryDocumentReadStore,
  registerDocumentReaderSeams,
} from "../src/modules/22-documents/index";
import type {
  DocumentReader,
  ExtractionProvenanceReader,
  IntakeMetricsProvider,
  PortalDocumentReader,
  ProvenanceRecord,
  RenderedDocumentProvider,
} from "@wardenx/types";

const ORG = "org-1";
const OTHER_ORG = "org-2";

function row(over: Partial<DocumentSeamRow> & Pick<DocumentSeamRow, "id">): DocumentSeamRow {
  return {
    organizationId: ORG,
    patientId: "pat-1",
    aggregateType: "consent_record",
    aggregateId: null,
    title: "doc",
    retentionClass: "compliance",
    sourceKind: "form_render",
    status: "active",
    patientFacing: true,
    activeVersionId: `${over.id}-v`,
    versionNumber: 1,
    mimeType: "application/pdf",
    byteSize: 100,
    sha256Hex: "a".repeat(64),
    versionsCount: 1,
    sudClass: false,
    downloadFilename: `${over.id}.pdf`,
    renderedAt: "2026-06-22T12:00:00.000Z",
    createdAt: "2026-06-22T12:00:00.000Z",
    updatedAt: "2026-06-22T12:00:00.000Z",
    ...over,
  };
}

const provenance: ProvenanceRecord = {
  id: "prov-1",
  targetModule: "m11",
  targetAggregateId: "order-9",
  targetFieldPath: "dosage",
  sourceDocumentId: "doc-x",
  sourceDocumentVersionId: "doc-x-v",
  decisionKind: "approve",
  reviewerMembershipId: "mem-1",
  extractedAt: "2026-06-22T11:00:00.000Z",
  committedAt: "2026-06-22T12:00:00.000Z",
};

const SEED: DocumentSeamSeed = {
  documents: [
    row({ id: "doc-a", aggregateType: "encounter", aggregateId: "enc-1", versionNumber: 2, title: "Encounter" }),
    row({ id: "doc-b", aggregateType: "consent_record", aggregateId: "consent-1", title: "Consent" }),
    row({ id: "doc-c", patientFacing: false, title: "Internal CTI", aggregateType: "cti", aggregateId: "cti-1" }),
    row({ id: "doc-sud", title: "Lab (SUD)", sudClass: true, aggregateType: "order_record", aggregateId: "ord-1" }),
    // A different patient + a different org — must never leak into ORG/pat-1 reads.
    row({ id: "doc-other-pat", patientId: "pat-2", title: "Other patient" }),
    row({ id: "doc-other-org", organizationId: OTHER_ORG, title: "Other org" }),
  ],
  provenance: [provenance],
  intakeMetricsByOrg: {
    [ORG]: {
      batchesProcessed: 12,
      batchesInReview: 2,
      batchesWritebackComplete: 9,
      batchesDiscarded: 1,
      candidatesTotal: 140,
      candidatesApproved: 120,
      candidatesRejected: 20,
      discrepanciesOpen: 3,
      averageTimeToReviewMinutes: 45,
    },
  },
};

function register(seed: DocumentSeamSeed = SEED) {
  registerDocumentReaderSeams({ store: createInMemoryDocumentReadStore(seed).store });
}

afterEach(() => __resetSeamsForTest());

describe("M22 reader seams — boot wiring", () => {
  it("registers all five real impls and validateSeams passes", () => {
    register();
    expect(() => validateSeams()).not.toThrow();
  });

  it("falls back to fail-closed deny-stubs when M22 does not register", () => {
    validateSeams(); // applies the deny-stub default for every unregistered required seam
    const reader = getSeam("DocumentReader") as DocumentReader;
    expect(() => reader.documentMetadata({ documentId: "doc-a", organizationId: ORG })).toThrow(/DocumentReader/);
  });
});

describe("RenderedDocumentProvider (§7.2 W2 back-ref)", () => {
  it("returns the rendered document + version for an aggregate, or null when unbound", async () => {
    register();
    const provider = getSeam("RenderedDocumentProvider") as RenderedDocumentProvider;
    const hit = await provider.getRenderedDocumentForAggregate({
      aggregateType: "encounter",
      aggregateId: "enc-1",
      organizationId: ORG,
    });
    expect(hit).toEqual({ documentId: "doc-a", versionId: "doc-a-v", renderedAt: "2026-06-22T12:00:00.000Z" });
    const miss = await provider.getRenderedDocumentForAggregate({
      aggregateType: "encounter",
      aggregateId: "nope",
      organizationId: ORG,
    });
    expect(miss).toBeNull();
  });
});

describe("DocumentReader", () => {
  it("lists a patient's documents scoped to the org + patient", async () => {
    register();
    const reader = getSeam("DocumentReader") as DocumentReader;
    const docs = await reader.documentsForPatient({ patientId: "pat-1", organizationId: ORG });
    const ids = docs.map((d) => d.id);
    expect(ids).toContain("doc-a");
    expect(ids).toContain("doc-b");
    expect(ids).not.toContain("doc-other-pat"); // different patient
    expect(ids).not.toContain("doc-other-org"); // different org
  });

  it("filters by aggregate type and paginates by cursor", async () => {
    register();
    const reader = getSeam("DocumentReader") as DocumentReader;
    const consents = await reader.documentsForPatient({
      patientId: "pat-1",
      organizationId: ORG,
      aggregateType: "consent_record",
    });
    expect(consents.map((d) => d.id)).toEqual(["doc-b"]);

    const page = await reader.documentsForPatient({ patientId: "pat-1", organizationId: ORG, limit: 2 });
    expect(page).toHaveLength(2);
    const next = await reader.documentsForPatient({
      patientId: "pat-1",
      organizationId: ORG,
      sinceCursor: page[page.length - 1].id,
    });
    expect(next.map((d) => d.id)).not.toContain(page[0].id);
  });

  it("reads a single document's metadata, or null cross-org", async () => {
    register();
    const reader = getSeam("DocumentReader") as DocumentReader;
    const meta = await reader.documentMetadata({ documentId: "doc-a", organizationId: ORG });
    expect(meta?.aggregateType).toBe("encounter");
    expect(meta?.versionsCount).toBe(1);
    expect(await reader.documentMetadata({ documentId: "doc-other-org", organizationId: ORG })).toBeNull();
  });
});

describe("PortalDocumentReader", () => {
  it("strips non-patient-facing documents from the portal list", async () => {
    register();
    const portal = getSeam("PortalDocumentReader") as PortalDocumentReader;
    const docs = await portal.documentsForPatient({ patientId: "pat-1", organizationId: ORG });
    const ids = docs.map((d) => d.id);
    expect(ids).toContain("doc-a");
    expect(ids).not.toContain("doc-c"); // patientFacing: false
  });

  it("mints a URL for a patient-facing version but denies on the structural + SUD gates", async () => {
    register();
    const portal = getSeam("PortalDocumentReader") as PortalDocumentReader;
    const ok = await portal.mintPortalDownloadUrl({
      documentVersionId: "doc-b-v",
      portalSessionId: "sess-1",
      patientId: "pat-1",
      organizationId: ORG,
    });
    expect("url" in ok && ok.url).toContain("portal/");

    // Wrong patient → not_owner.
    const notOwner = await portal.mintPortalDownloadUrl({
      documentVersionId: "doc-b-v",
      portalSessionId: "sess-1",
      patientId: "pat-2",
      organizationId: ORG,
    });
    expect(notOwner).toEqual({ denied: true, reason: "not_owner" });

    // Non-patient-facing → not_patient_facing.
    const notFacing = await portal.mintPortalDownloadUrl({
      documentVersionId: "doc-c-v",
      portalSessionId: "sess-1",
      patientId: "pat-1",
      organizationId: ORG,
    });
    expect(notFacing).toEqual({ denied: true, reason: "not_patient_facing" });

    // SUD-class without a wired consent gate → sud_consent_absent (fail closed; M22-T06 wires ConsentEvaluator).
    const sud = await portal.mintPortalDownloadUrl({
      documentVersionId: "doc-sud-v",
      portalSessionId: "sess-1",
      patientId: "pat-1",
      organizationId: ORG,
    });
    expect(sud).toEqual({ denied: true, reason: "sud_consent_absent" });
  });
});

describe("IntakeMetricsProvider + ExtractionProvenanceReader", () => {
  it("returns the org intake aggregate (empty for an org with no batches)", async () => {
    register();
    const metrics = getSeam("IntakeMetricsProvider") as IntakeMetricsProvider;
    const m = await metrics.metricsForOrg({ organizationId: ORG, from: "2026-06-01", to: "2026-06-30" });
    expect(m.batchesProcessed).toBe(12);
    expect(m.candidatesApproved).toBe(120);
    const empty = await metrics.metricsForOrg({ organizationId: OTHER_ORG, from: "2026-06-01", to: "2026-06-30" });
    expect(empty.batchesProcessed).toBe(0);
  });

  it("returns provenance for a write-back target aggregate", async () => {
    register();
    const prov = getSeam("ExtractionProvenanceReader") as ExtractionProvenanceReader;
    const rows = await prov.provenanceForTargetAggregate({
      targetModule: "m11",
      targetAggregateId: "order-9",
      organizationId: ORG,
    });
    expect(rows.map((r) => r.id)).toEqual(["prov-1"]);
    const none = await prov.provenanceForTargetAggregate({
      targetModule: "m11",
      targetAggregateId: "order-absent",
      organizationId: ORG,
    });
    expect(none).toHaveLength(0);
  });
});
