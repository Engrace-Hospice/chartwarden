// GAP-033 / GAP-036 - no M22 platform template may render non-PDF bytes, and the appeal packet is a real letter.
// Before: 44 of the 50 PLATFORM_TEMPLATE_TABLE keys had no registered builder and were written as JSON behind a
// "%PDF" header (a file no reader can open, hashed and stored as application/pdf).
import {
  APPEAL_TIER_LETTERS,
  type AppealTier,
  appealPacketViolations,
  buildAppealPacketRenderPayload,
} from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PDF_RENDERERS,
  renderPdfForTemplate,
} from "../src/modules/22-documents/render-pdf";
import { PLATFORM_TEMPLATE_TABLE } from "../src/modules/22-documents/seams/renderer";

/** Structural PDF validity: header, trailer, an xref whose offsets land on their objects, exact stream lengths. */
function expectValidPdf(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  expect(raw.startsWith("%PDF-1.4\n")).toBe(true);
  expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(raw)?.[1]);
  expect(raw.slice(startxref, startxref + 4)).toBe("xref");
  const [, header, ...rest] = raw.slice(startxref).split("\n");
  const size = Number(header?.split(" ")[1]);
  rest.slice(1, size).forEach((entry, i) => {
    const off = Number(entry.slice(0, 10));
    expect(raw.slice(off, off + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
  });
  for (const m of raw.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) {
    expect((m[2] as string).length).toBe(Number(m[1]));
  }
  expect(raw).not.toContain("wardenx-render");
  return raw;
}

const textOf = (raw: string): string =>
  [...raw.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[1]).join("\n");

const RICH_PAYLOAD = {
  aggregateId: "agg-12345678",
  patientId: "pat-1",
  title: undefined,
  status: "final",
  signedAt: "2026-09-30T14:05:00.000Z",
  nested: { reviewer: "RN Smith", flags: { urgent: true } },
  lines: [
    { code: "0651", days: 30, note: "routine" },
    { code: "0656", days: 3, note: "gip" },
  ],
  tags: ["alpha", "beta"],
};

describe("every platform template renders a real PDF (GAP-033)", () => {
  const keys = Object.keys(PLATFORM_TEMPLATE_TABLE);
  /** appeal_packet validates its typed payload and fails closed by design - covered in its own describe below. */
  const strictKeys = new Set(["appeal_packet"]);

  it("covers the full template table (guards against the loop matching nothing)", () => {
    expect(keys.length).toBeGreaterThanOrEqual(50);
  });

  it.each(keys.filter((k) => !strictKeys.has(k)))("%s: minimal payload", (key) => {
    const descriptor = PLATFORM_TEMPLATE_TABLE[key];
    expect(descriptor).toBeDefined();
    const bytes = renderPdfForTemplate(
      key,
      { aggregateId: "agg-1", patientId: null },
      descriptor?.defaultTitle ?? key,
    );
    expectValidPdf(bytes);
  });

  it.each(keys.filter((k) => !Object.hasOwn(DEFAULT_PDF_RENDERERS, k)))(
    "%s: rich payload is laid out readably and deterministically",
    (key) => {
      const title = PLATFORM_TEMPLATE_TABLE[key]?.defaultTitle ?? key;
      const a = renderPdfForTemplate(key, RICH_PAYLOAD, title);
      const b = renderPdfForTemplate(key, RICH_PAYLOAD, title);
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
      const text = textOf(expectValidPdf(a));
      expect(text).toContain(title.slice(0, 12));
      expect(text).toContain("RN Smith");
      expect(text).toContain("0656");
    },
  );

  it("never throws on a hostile payload shape (a render must not loop through the DLQ on it)", () => {
    for (const payload of [
      null,
      undefined,
      "x",
      7,
      [],
      { a: { b: { c: { d: 1 } } } },
      { a: [null, [1, 2], { b: null }] },
    ]) {
      expectValidPdf(renderPdfForTemplate("cti", payload, "Certification of Terminal Illness"));
    }
  });
});

describe("appeal_packet (GAP-036)", () => {
  const facts = (over: Partial<Parameters<typeof buildAppealPacketRenderPayload>[0]> = {}) => ({
    appealCaseId: "aaaaaaaa-0000-4000-8000-000000000001",
    denialCaseId: "bbbbbbbb-0000-4000-8000-000000000002",
    claimId: "cccccccc-0000-4000-8000-000000000003",
    tier: "redetermination" as AppealTier,
    tierDeadlineAt: "2026-12-01T00:00:00.000Z",
    submittedAt: "2026-10-08T12:00:00.000Z",
    appealNarrative: "The patient was certified terminally ill; the F2F encounter was timely.",
    attachedDocumentIds: [
      "dddddddd-0000-4000-8000-000000000004",
      "eeeeeeee-0000-4000-8000-000000000005",
    ],
    denial: {
      carcCode: "50",
      rarcCode: "N115",
      dollarValue: "1234.50",
      remittanceLineId: "ffffffff-0000-4000-8000-000000000006",
    },
    ...over,
  });

  it("builds a valid typed payload from server-held facts, indexing the attached documents", () => {
    const payload = buildAppealPacketRenderPayload(facts());
    expect(appealPacketViolations(payload)).toEqual([]);
    expect(payload.supportingDocuments.map((d) => d.ordinal)).toEqual([1, 2]);
    expect(payload.tierLetterTitle).toBe(APPEAL_TIER_LETTERS.redetermination.title);
    expect(payload.signedClaimCopyRef.claimId).toBe(facts().claimId);
    expect(payload.remitCopyRef.remittanceLineId).toBe(facts().denial.remittanceLineId);
  });

  it("requires the justification on a late good-cause filing and a non-empty narrative", () => {
    expect(
      appealPacketViolations({
        ...buildAppealPacketRenderPayload(facts()),
        lateGoodCauseFiling: true,
      }),
    ).not.toEqual([]);
    expect(() => buildAppealPacketRenderPayload(facts({ appealNarrative: "" }))).toThrow(
      /AppealPacketRenderPayload/,
    );
  });

  it("renders the narrative, the document index and the enclosure references as a real PDF", () => {
    const payload = buildAppealPacketRenderPayload(
      facts({
        tier: "reconsideration",
        lateGoodCause: { justification: "The MAC notice was misdelivered." },
      }),
    );
    const bytes = renderPdfForTemplate(
      "appeal_packet",
      { ...payload, aggregateId: payload.appealCaseId, patientId: null },
      "Appeal Packet",
    );
    const text = textOf(expectValidPdf(bytes));
    expect(text).toContain("Request for Reconsideration");
    expect(text).toContain("The patient was certified terminally ill");
    expect(text).toContain("dddddddd");
    expect(text).toContain("eeeeeeee");
    expect(text).toContain("good cause");
    expect(text).toContain("The MAC notice was misdelivered.");
  });

  it("fails the render closed on an empty payload instead of filing a blank appeal", () => {
    expect(() =>
      renderPdfForTemplate(
        "appeal_packet",
        { aggregateId: "x", patientId: null, tier: "alj" },
        "Appeal Packet",
      ),
    ).toThrow(/invalid AppealPacketRenderPayload/);
  });
});
