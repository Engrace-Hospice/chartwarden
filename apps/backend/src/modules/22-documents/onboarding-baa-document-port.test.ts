// The M22 side of the platform BAA-document seam: it files ONE document kind, with fixed shape, on the caller's transaction, and refuses a
// transaction that is not scoped to the tenant in the scope. (The real object store, the real rows and RLS are the live suite.)
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it, vi } from "vitest";
import type { OnboardingWriteScope } from "../../bootstrap/onboarding-baa-document-port";
import { buildTenantBaaDocumentOnboardingPort } from "./onboarding-baa-document-port";
import type { FiledUpload, ServerUploadService } from "./routes/server-upload";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const SCOPE: OnboardingWriteScope = {
  organizationId: ORG,
  operatorUserId: "55555555-5555-4555-8555-555555555555",
  operatorMembershipId: "66666666-6666-4666-8666-666666666666",
  operatorRoles: ["platform_ops"],
  stepUpRecent: true,
  request: { sourceIp: "127.0.0.1", userAgent: "vitest", correlationId: "c-1" },
};
const PDF = new TextEncoder().encode("%PDF-1.7 baa");
const PDF_BASE64 = Buffer.from(PDF).toString("base64");
const DIGEST = "a".repeat(64);

function txScopedTo(orgId: string | null): DbClient {
  return { execute: async () => ({ rows: [{ org_id: orgId }] }) } as unknown as DbClient;
}

function fakeUploads(discard = vi.fn(async () => undefined)) {
  const createDocumentOn = vi.fn(
    async (): Promise<FiledUpload> => ({
      documentId: "33333333-3333-4333-8333-333333333333",
      versionId: "v1",
      versionNumber: 1,
      mimeType: "application/pdf",
      byteSize: PDF.byteLength,
      sha256Hex: DIGEST,
      discard,
    }),
  );
  return { uploads: { createDocumentOn } as unknown as ServerUploadService, createDocumentOn, discard };
}

describe("buildTenantBaaDocumentOnboardingPort", () => {
  it("files the tenant_baa kind, org-level, compliance-retained, not patient-facing, under the operator", async () => {
    const { uploads, createDocumentOn } = fakeUploads();
    const tx = txScopedTo(ORG);
    const port = buildTenantBaaDocumentOnboardingPort(uploads);

    const result = await port.upload(tx, SCOPE, { contentBase64: PDF_BASE64, mimeType: "application/pdf" });

    expect(createDocumentOn).toHaveBeenCalledWith(
      tx,
      ORG,
      { userId: SCOPE.operatorUserId, membershipId: SCOPE.operatorMembershipId },
      {
        patientId: null,
        admissionId: null,
        retentionClass: "compliance",
        aggregateType: "tenant_baa",
        aggregateId: null,
        title: "Business associate agreement",
        patientFacing: false,
        tags: [],
        content: { bytes: PDF, mimeType: "application/pdf" },
      },
    );
    expect(result.resourceId).toBe("33333333-3333-4333-8333-333333333333");
    expect(result.view).toEqual({
      documentId: "33333333-3333-4333-8333-333333333333",
      mimeType: "application/pdf",
      byteSize: PDF.byteLength,
      sha256Hex: DIGEST,
    });
    expect(result.detail).toEqual({
      documentKind: "tenant_baa",
      mimeType: "application/pdf",
      byteSize: PDF.byteLength,
      sha256Hex: DIGEST,
    });
  });

  it("refuses a transaction that is not scoped to the tenant, before it stores anything", async () => {
    const { uploads, createDocumentOn } = fakeUploads();
    const port = buildTenantBaaDocumentOnboardingPort(uploads);

    await expect(
      port.upload(txScopedTo(OTHER_ORG), SCOPE, { contentBase64: PDF_BASE64, mimeType: "application/pdf" }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_MISMATCH" });
    await expect(
      port.upload(txScopedTo(null), SCOPE, { contentBase64: PDF_BASE64, mimeType: "application/pdf" }),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_MISMATCH" });
    expect(createDocumentOn).not.toHaveBeenCalled();
  });

  it("refuses text that is not base64 with a 422, before it stores anything", async () => {
    const { uploads, createDocumentOn } = fakeUploads();
    const port = buildTenantBaaDocumentOnboardingPort(uploads);

    await expect(
      port.upload(txScopedTo(ORG), SCOPE, { contentBase64: "not base64!!", mimeType: "application/pdf" }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(createDocumentOn).not.toHaveBeenCalled();
  });

  it("hands the caller the way to take the object back out", async () => {
    const { uploads, discard } = fakeUploads();
    const port = buildTenantBaaDocumentOnboardingPort(uploads);
    const result = await port.upload(txScopedTo(ORG), SCOPE, {
      contentBase64: PDF_BASE64,
      mimeType: "application/pdf",
    });

    await result.discard();

    expect(discard).toHaveBeenCalledOnce();
  });
});
