// apps/backend/__tests__/bereavement-mailing-batch.test.ts — ADR-0109 D10: the `bereavement_mailing_batch` M22 template (one letter per recipient, a page
// break between them) and the org-level download seam (`OrgDocumentAccessProvider`) the batch is handed out through.
import {
  BEREAVEMENT_MAILING_BATCH_TEMPLATE_KEY,
  type BereavementMailingBatchRenderPayload,
  RenderPayloadError,
  assertBereavementMailingBatchRenderPayload,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { buildBereavementMailingBatchDoc } from "../src/modules/22-documents/render-pdf/bereavement-mailing-batch-doc";
import { renderPdfForTemplate } from "../src/modules/22-documents/render-pdf";
import {
  type OrgDocumentFacts,
  createOrgDocumentAccessProvider,
} from "../src/modules/22-documents/seams/org-document-access";
import { createDocumentRenderer, PLATFORM_TEMPLATE_TABLE } from "../src/modules/22-documents/seams/renderer";
import { createInMemoryDocumentSeamStore, createInMemoryObjectStore } from "../src/modules/22-documents/seams/store";

const RUN = "00000000-0000-4000-8000-0000000000a1";
const ORG = "00000000-0000-4000-8000-0000000000b1";
const DOC_ID = "00000000-0000-4000-8000-0000000000c1";
const VERSION = "00000000-0000-4000-8000-0000000000d1";

const PAYLOAD: BereavementMailingBatchRenderPayload = {
  aggregateId: RUN,
  heading: "Our autumn newsletter",
  paragraphs: ["We are thinking of you this season.", "Our office is open on weekdays."],
  signoff: "With care, the program team",
  letters: [
    { recipientName: "Ada Example", addressLines: ["10 Sample Street", "Testville, ZZ 00000"], greeting: "Dear Ada Example," },
    { recipientName: "Ben Sample", addressLines: ["22 Fixture Road", "Mockton, ZZ 00001"], greeting: "Dear Ben Sample," },
    { recipientName: "Cy Placeholder", addressLines: ["3 Demo Lane", "Stubville, ZZ 00002"], greeting: "Dear Cy Placeholder," },
  ],
};

const textOf = (bytes: Uint8Array): string =>
  [...Buffer.from(bytes).toString("latin1").matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
    .map((m) => (m[1] ?? "").replace(/\\([()\\])/g, "$1"))
    .join("\n");

const pageCount = (bytes: Uint8Array): number =>
  [...Buffer.from(bytes).toString("latin1").matchAll(/\/Type\s*\/Page[^s]/g)].length;

describe("bereavement_mailing_batch template", () => {
  it("is an internal-only descriptor filed under the bereavement retention class", () => {
    expect(PLATFORM_TEMPLATE_TABLE[BEREAVEMENT_MAILING_BATCH_TEMPLATE_KEY]).toMatchObject({
      aggregateType: "bereavement_mailing_batch",
      retentionClass: "bereavement",
      internalOnly: true,
    });
  });

  it("builds one letter per recipient with a page break between them and none after the last", () => {
    const doc = buildBereavementMailingBatchDoc(PAYLOAD);
    const breaks = doc.blocks.filter((b) => b.kind === "pageBreak").length;
    expect(breaks).toBe(PAYLOAD.letters.length - 1);
    expect(doc.blocks.at(-1)?.kind).not.toBe("pageBreak");
    expect(doc.blocks.filter((b) => b.kind === "heading")).toHaveLength(PAYLOAD.letters.length);
  });

  it("draws every addressee, address line, greeting, paragraph and sign-off, and renders one page per letter", () => {
    const bytes = renderPdfForTemplate(BEREAVEMENT_MAILING_BATCH_TEMPLATE_KEY, PAYLOAD, "Bereavement Mailing Batch (Internal)");
    const text = textOf(bytes);
    for (const letter of PAYLOAD.letters) {
      expect(text).toContain(letter.recipientName);
      for (const line of letter.addressLines) expect(text).toContain(line);
      expect(text).toContain(letter.greeting);
    }
    for (const p of PAYLOAD.paragraphs) expect(text).toContain(p);
    expect(text).toContain(PAYLOAD.signoff);
    expect(pageCount(bytes)).toBe(PAYLOAD.letters.length);
  });

  it("carries no recipient name or address in the PDF title or its running header: they appear only inside the letters", () => {
    const doc = buildBereavementMailingBatchDoc(PAYLOAD);
    expect(doc.title).toBe("Bereavement Mailing Batch (Internal)");
    expect(doc.runningHeader).toBeUndefined();
  });

  it("fails closed on a malformed batch instead of printing a blank envelope window", () => {
    for (const bad of [
      { ...PAYLOAD, letters: [] },
      { ...PAYLOAD, letters: [{ ...PAYLOAD.letters[0], addressLines: [] }] },
      { ...PAYLOAD, letters: [{ ...PAYLOAD.letters[0], recipientName: "" }] },
      { ...PAYLOAD, paragraphs: [] },
      { heading: "x" },
    ]) {
      expect(() => assertBereavementMailingBatchRenderPayload(bad)).toThrow(RenderPayloadError);
      expect(() => buildBereavementMailingBatchDoc(bad)).toThrow(RenderPayloadError);
    }
  });

  it("is filed by the real renderer as an ORG-LEVEL (patient-less) document under the internal aggregate type", async () => {
    const slice = createInMemoryDocumentSeamStore();
    const objects = createInMemoryObjectStore();
    const upserts: Parameters<typeof slice.store.upsertRenderedDocument>[0][] = [];
    const renderer = createDocumentRenderer({
      store: {
        ...slice.store,
        upsertRenderedDocument: async (input) => {
          upserts.push(input);
          return slice.store.upsertRenderedDocument(input);
        },
      },
      objects: objects.store,
    });
    const { documentId } = await renderer.render({ orgId: ORG as never }, BEREAVEMENT_MAILING_BATCH_TEMPLATE_KEY, PAYLOAD);
    expect(documentId).toBeTruthy();
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      aggregateType: "bereavement_mailing_batch",
      aggregateId: RUN,
      patientId: null,
      retentionClass: "bereavement",
      mimeType: "application/pdf",
    });
    // the generic default title: neither a name nor an address ever becomes the document row's title
    expect(upserts[0]?.title).toBe("Bereavement Mailing Batch (Internal)");
  });
});

describe("OrgDocumentAccessProvider", () => {
  const FACTS: OrgDocumentFacts = {
    documentId: DOC_ID,
    aggregateType: "bereavement_mailing_batch",
    patientId: null,
    status: "active",
    activeVersionId: VERSION,
    objectKey: "tenant/intake/run-1/batch.pdf",
  };

  function build(facts: OrgDocumentFacts | null, logFails = false) {
    const logged: unknown[] = [];
    const presigned: unknown[] = [];
    const provider = createOrgDocumentAccessProvider({
      port: { loadDocument: async () => facts },
      objects: {
        presign: async (args) => {
          presigned.push(args);
          return { url: "https://objects.example.test/signed", expiresAt: "2026-11-05T12:05:00.000Z" };
        },
      },
      accessLog: {
        append: async (entry) => {
          if (logFails) throw new Error("ledger down");
          logged.push(entry);
        },
      },
    });
    return { provider, logged, presigned };
  }
  const ask = (provider: ReturnType<typeof build>["provider"], over: Partial<{ allowed: string[]; member: string }> = {}) =>
    provider.mintOrgDownloadUrl({
      organizationId: ORG as never,
      documentId: DOC_ID as never,
      allowedAggregateTypes: (over.allowed ?? ["bereavement_mailing_batch"]) as never,
      accessorMembershipId: over.member ?? "membership-1",
    });

  it("mints a URL for an active org-level document of an allowed type, and writes the access ledger row first", async () => {
    const { provider, logged } = build(FACTS);
    const out = await ask(provider);
    expect(out).toMatchObject({ url: "https://objects.example.test/signed", documentVersionId: VERSION });
    expect(logged).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        documentId: DOC_ID,
        documentVersionId: VERSION,
        patientId: null,
        accessorMembershipId: "membership-1",
        accessKind: "signed_url_issued",
        purpose: "operations",
      }),
    ]);
  });

  it("refuses with one indistinguishable family: absent, another type, a patient's document, not active, no version", async () => {
    const cases: [OrgDocumentFacts | null, string][] = [
      [null, "not_found"],
      [{ ...FACTS, aggregateType: "bereavement_physician_letter" }, "wrong_type"],
      [{ ...FACTS, patientId: "00000000-0000-4000-8000-0000000000e1" }, "not_org_level"],
      [{ ...FACTS, status: "legal_hold" }, "not_active"],
      [{ ...FACTS, activeVersionId: null, objectKey: null }, "no_active_version"],
    ];
    for (const [facts, reason] of cases) {
      const { provider, logged, presigned } = build(facts);
      expect(await ask(provider)).toEqual({ denied: true, reason });
      expect(logged).toEqual([]);
      expect(presigned).toEqual([]);
    }
  });

  it("is not a general document door: the caller's allowed types decide", async () => {
    const { provider } = build(FACTS);
    expect(await ask(provider, { allowed: ["bereavement_letter"] })).toEqual({ denied: true, reason: "wrong_type" });
  });

  it("releases no URL when the access ledger cannot be written, and none for a member it cannot record", async () => {
    await expect(ask(build(FACTS, true).provider)).rejects.toThrow("ledger down");
    await expect(ask(build(FACTS).provider, { member: "" })).rejects.toThrow(/cannot be recorded/);
  });
});
