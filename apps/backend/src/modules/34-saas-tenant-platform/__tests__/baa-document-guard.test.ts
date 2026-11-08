// The BAA register's document link: judged by M22's check on the write's own transaction (the live wizard suite proves it on real rows).
import { describe, expect, it, vi } from "vitest";
import {
  assertBaaDocumentFiled,
  baaLinkNeedsJudging,
  governingBaaDocumentFiled,
  governingFactsOf,
} from "../routes/platform/baa-guards";

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

describe("baaLinkNeedsJudging", () => {
  const executed = { baaStatus: "executed", documentId: "legacy-doc" };
  it("judges a new link and a transition to executed", () => {
    expect(baaLinkNeedsJudging(executed, { documentId: "new-doc" })).toBe(true);
    expect(
      baaLinkNeedsJudging({ baaStatus: "pending", documentId: null }, { baaStatus: "executed" }),
    ).toBe(true);
  });

  it("does not re-judge an executed row on an unrelated edit, or when the same link is sent again", () => {
    expect(baaLinkNeedsJudging(executed, {})).toBe(false);
    expect(baaLinkNeedsJudging(executed, { documentId: "legacy-doc" })).toBe(false);
    expect(baaLinkNeedsJudging(executed, { baaStatus: "executed" })).toBe(false);
  });
});

describe("governingFactsOf", () => {
  const row = (
    id: string,
    tenantAccountId: string,
    baaStatus: string,
    executedOn: string | null,
    documentId: string | null = null,
  ) => ({
    id,
    tenantAccountId,
    organizationId: `org-${tenantAccountId}`,
    baaStatus,
    executedOn,
    expiresOn: null,
    documentId,
  });

  it("marks the record the go-live guard picks, per tenant, and asks M22 about its document only", async () => {
    const isFiled = vi.fn(async () => true);
    const facts = await governingFactsOf(
      [
        row("t1-pending", "t1", "pending", null),
        row("t1-new", "t1", "executed", "2026-10-01", "doc-new"),
        row("t1-old", "t1", "executed", "2025-01-01", "doc-old"),
        row("t2-term", "t2", "terminated", null),
        row("t2-exec", "t2", "executed", "2026-01-01", "doc-2"),
      ],
      isFiled,
    );
    expect(facts.get("t1-new")).toEqual({ governing: true, documentFiled: true });
    expect(facts.get("t1-old")).toEqual({ governing: false, documentFiled: null });
    expect(facts.get("t1-pending")).toEqual({ governing: false, documentFiled: null });
    // an undated termination governs, and with no document it is not filed
    expect(facts.get("t2-term")).toEqual({ governing: true, documentFiled: false });
    expect(facts.get("t2-exec")?.governing).toBe(false);
    expect(isFiled).toHaveBeenCalledTimes(1);
    expect(isFiled).toHaveBeenCalledWith({ organizationId: "org-t1", documentId: "doc-new" });
  });

  it("says null (not judged) when no M22 check is bound", async () => {
    const facts = await governingFactsOf(
      [row("a", "t1", "executed", "2026-01-01", "d")],
      undefined,
    );
    expect(facts.get("a")).toEqual({ governing: true, documentFiled: null });
  });
});
