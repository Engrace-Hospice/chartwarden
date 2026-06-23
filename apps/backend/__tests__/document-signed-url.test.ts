// apps/backend/__tests__/document-signed-url.test.ts — M22-T06 (§4.12 external-partner BAA gate +
// the REAL cross-module seam consumption: M40 BaaStatusProvider, M39 ConsentEvaluator).
//
// Covers: (1) the pure §4.12 signed-URL service — an active BAA presigns, a missing/expired BAA throws
// DOCUMENT_EXTERNAL_DISCLOSURE_BAA_BLOCKED (403), an invalid TTL throws (fakes for the gate + presign);
// (2) M22 consuming M40's REAL BaaStatusProvider end-to-end through the composition-root adapter
// (a facility with no BAA on file blocks the URL); (3) M22 consuming M39's REAL ConsentEvaluator through the
// portal SUD gate (an active 42 CFR Part 2 consent mints the SUD URL; no consent fails closed).
import { createInMemoryConsentStore, type StoredConsent } from "@wardenx/consent";
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, validateSeams } from "../src/bootstrap/seams/registry";
import {
  createDocumentSignedUrlService,
  createExternalPartnerBaaGate,
  createPortalSudConsentGate,
  wireModuleSeams,
} from "../src/index";
import { registerConsentSeams } from "../src/modules/39-consent/index";
import {
  type ExternalDisclosureEntityKind,
  type ExternalPartnerBaaGate,
  type SignedUrlPresignPort,
  createExternalPartnerSignedUrlService,
  createInMemoryDocumentReadStore,
  createPortalDocumentReader,
  inMemoryPortalPresign,
} from "../src/modules/22-documents/index";

const ORG = "org-1";

afterEach(() => __resetSeamsForTest());

const fakePresign: SignedUrlPresignPort = {
  async presignDownload({ tenantId, downloadFilename, ttlSeconds }) {
    return { url: `memory://tenant-${tenantId}/${downloadFilename}?ttl=${ttlSeconds}`, expiresAt: `+${ttlSeconds}s` };
  },
};

function gateReturning(decision: { isActive: boolean; status: string }): ExternalPartnerBaaGate {
  return { async checkDisclosure() { return decision; } };
}

const REQUEST = {
  organizationId: ORG,
  objectKey: "lab_results_pdf-abc123def456.pdf",
  downloadFilename: "lab.pdf",
  partnerEntityKind: "facility" as ExternalDisclosureEntityKind,
  partnerEntityId: "fac-1",
  ttlSeconds: 300,
};

describe("createExternalPartnerSignedUrlService (§4.12 BAA gate)", () => {
  it("presigns when the BAA gate reports an active disclosure", async () => {
    const svc = createExternalPartnerSignedUrlService({
      baaGate: gateReturning({ isActive: true, status: "executed" }),
      presign: fakePresign,
    });
    const { url } = await svc.grantExternalPartnerDownloadUrl(REQUEST);
    expect(url).toContain("lab.pdf");
  });

  it("blocks (403) when the BAA gate reports no active disclosure", async () => {
    const svc = createExternalPartnerSignedUrlService({
      baaGate: gateReturning({ isActive: false, status: "missing" }),
      presign: fakePresign,
    });
    await expect(svc.grantExternalPartnerDownloadUrl(REQUEST)).rejects.toThrow(
      /DOCUMENT_EXTERNAL_DISCLOSURE_BAA_BLOCKED|no active BAA/,
    );
  });

  it("refuses a non-positive TTL before any gate/presign work (§7.10 D11)", async () => {
    const svc = createExternalPartnerSignedUrlService({
      baaGate: gateReturning({ isActive: true, status: "executed" }),
      presign: fakePresign,
    });
    await expect(
      svc.grantExternalPartnerDownloadUrl({ ...REQUEST, ttlSeconds: 0 }),
    ).rejects.toThrow(/DOCUMENT_SIGNED_URL_TTL_INVALID|at least one second/);
  });
});

describe("M22 consumes M40's REAL BaaStatusProvider (§4.12)", () => {
  it("blocks an external-partner URL for a facility with no BAA on file", async () => {
    wireModuleSeams(); // registers M40's real BaaStatusProvider + M22's storage seam over the deny-stubs
    validateSeams();
    const decision = await createExternalPartnerBaaGate().checkDisclosure({
      organizationId: ORG,
      entityKind: "facility",
      entityId: "fac-unknown",
    });
    expect(decision.isActive).toBe(false);
    expect(decision.status).toBe("missing");

    const svc = createDocumentSignedUrlService();
    await expect(svc.grantExternalPartnerDownloadUrl(REQUEST)).rejects.toThrow(/no active BAA/);
  });
});

describe("M22 consumes M39's REAL ConsentEvaluator (portal SUD gate)", () => {
  function sudReadStore() {
    return createInMemoryDocumentReadStore({
      documents: [
        {
          id: "doc-sud",
          organizationId: ORG,
          patientId: "pat-1",
          aggregateType: "order_record",
          aggregateId: "ord-1",
          title: "Lab (SUD)",
          retentionClass: "compliance_42cfr_part2",
          sourceKind: "form_render",
          status: "active",
          patientFacing: true,
          activeVersionId: "doc-sud-v",
          versionNumber: 1,
          mimeType: "application/pdf",
          byteSize: 100,
          sha256Hex: "a".repeat(64),
          versionsCount: 1,
          sudClass: true,
          downloadFilename: "doc-sud.pdf",
          renderedAt: "2026-06-22T12:00:00.000Z",
          createdAt: "2026-06-22T12:00:00.000Z",
          updatedAt: "2026-06-22T12:00:00.000Z",
        },
      ],
    }).store;
  }

  function activePart2Consent(patientId: string): StoredConsent {
    return {
      id: `consent-${patientId}`,
      organizationId: ORG,
      patientId,
      typeKey: "42_cfr_part_2_release",
      status: "active",
      version: 1,
      effectiveAtMs: Date.now() - 60_000,
      expiresAtMs: null,
      survivesDeath: false,
      scopeDescriptor: {},
      recipients: [{ removedAtMs: null, expiresAtMs: null }],
    };
  }

  it("mints the SUD portal URL when the real evaluator finds an active Part 2 consent", async () => {
    registerConsentSeams({ store: createInMemoryConsentStore({ consents: [activePart2Consent("pat-1")], deceasedPatientIds: new Set() }).store });
    const portal = createPortalDocumentReader(sudReadStore(), inMemoryPortalPresign, createPortalSudConsentGate());
    const res = await portal.mintPortalDownloadUrl({
      documentVersionId: "doc-sud-v",
      portalSessionId: "sess-1",
      patientId: "pat-1",
      organizationId: ORG,
    });
    expect("url" in res && res.url).toContain("portal/");
  });

  it("denies the SUD portal URL when the real evaluator finds no consent on file", async () => {
    registerConsentSeams({ store: createInMemoryConsentStore().store });
    const portal = createPortalDocumentReader(sudReadStore(), inMemoryPortalPresign, createPortalSudConsentGate());
    const res = await portal.mintPortalDownloadUrl({
      documentVersionId: "doc-sud-v",
      portalSessionId: "sess-1",
      patientId: "pat-1",
      organizationId: ORG,
    });
    expect(res).toEqual({ denied: true, reason: "sud_consent_absent" });
  });
});
