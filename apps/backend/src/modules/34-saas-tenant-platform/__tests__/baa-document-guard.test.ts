// The BAA register's document link: judged by M22's check on the write's own transaction (the live wizard suite proves it on real rows).
import { describe, expect, it, vi } from "vitest";
import { assertBaaDocumentFiled, governingBaaDocumentFiled } from "../routes/platform/baa-guards";

const REF = { organizationId: "org-1", documentId: "doc-1" };

describe("assertBaaDocumentFiled", () => {
  it("passes when the document is a BAA filed for the record's organization, asking M22 with exactly that pair", async () => {
    const isFiled = vi.fn(async () => true);
    await expect(assertBaaDocumentFiled(isFiled, REF)).resolves.toBeUndefined();
    expect(isFiled).toHaveBeenCalledWith(REF);
  });

  it("refuses any other link with 422 BAA_DOCUMENT_INVALID on the documentId field", async () => {
    await expect(assertBaaDocumentFiled(async () => false, REF)).rejects.toMatchObject({
      statusCode: 422,
      code: "BAA_DOCUMENT_INVALID",
      details: [expect.objectContaining({ field: "documentId" })],
    });
  });

  it("has nothing to judge without a document id, and never asks M22", async () => {
    const isFiled = vi.fn(async () => false);
    for (const documentId of [null, undefined, ""]) {
      await expect(
        assertBaaDocumentFiled(isFiled, { organizationId: "org-1", documentId }),
      ).resolves.toBeUndefined();
    }
    expect(isFiled).not.toHaveBeenCalled();
  });

  it("answers 503 BAA_DOCUMENTS_UNBOUND when a link is written and no adapter is bound", async () => {
    await expect(assertBaaDocumentFiled(undefined, REF)).rejects.toMatchObject({
      statusCode: 503,
      code: "BAA_DOCUMENTS_UNBOUND",
    });
  });
});

describe("governingBaaDocumentFiled: the one rule go-live rests on", () => {
  it("asks M22 with exactly the BAA's own organization and document, and says what it answers", async () => {
    const isFiled = vi.fn(async () => true);
    await expect(governingBaaDocumentFiled({ ...REF }, isFiled)).resolves.toBe(true);
    expect(isFiled).toHaveBeenCalledWith(REF);
    await expect(governingBaaDocumentFiled({ ...REF }, async () => false)).resolves.toBe(false);
  });

  it("is false, without asking, for a BAA that links no document", async () => {
    const isFiled = vi.fn(async () => true);
    await expect(
      governingBaaDocumentFiled({ organizationId: "org-1", documentId: null }, isFiled),
    ).resolves.toBe(false);
    expect(isFiled).not.toHaveBeenCalled();
  });
});
