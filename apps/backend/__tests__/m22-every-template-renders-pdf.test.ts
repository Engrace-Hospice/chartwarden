// GAP-033 / GAP-036 - no M22 platform template may render non-PDF bytes, and the appeal packet is a real letter.
// Before: 44 of the 50 PLATFORM_TEMPLATE_TABLE keys had no registered builder and were written as JSON behind a
// "%PDF" header (a file no reader can open, hashed and stored as application/pdf).
import {
  APPEAL_TIER_LETTERS,
  type AppealTier,
  RenderPayloadError,
  appealPacketViolations,
  buildAppealPacketRenderPayload,
} from "@chartwarden/types";
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
  /** These validate a typed payload and fail closed by design (appeal_packet: its own describe below; the M6 CoP
   *  forms: m22-forms-wave1.test.ts). An id-only payload for them is a malformed request, never a generic dump. */
  const strictKeys = new Set([
    "appeal_packet",
    "adr_response_packet",
    "audit_response_packet",
    "cti",
    "f2f",
    "nor",
    "revocation",
    "discharge_summary",
    "discharge_summary_transfer",
    // Wave 2 / 3 (m22-forms-wave2.test.ts): typed order payloads and the billing correspondence.
    "order_record",
    "medication_order",
    "noe_confirmation_receipt",
    "notr_confirmation_receipt",
    "claim_acknowledgment_letter",
    "medicaid_claim_acknowledgment_letter",
    "denial_appeal_cover_letter",
    "denial_resolution_letter",
    // Wave 4 (m22-forms-wave4.test.ts): the operational documents.
    "visit_confirmation",
    "evv_verification",
    "dsar_bundle",
    "tenant_export_cover_letter",
  ]);

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
      expectValidPdf(renderPdfForTemplate("encounter", payload, "Encounter"));
    }
  });

  it.each(
    [...strictKeys].filter(
      (k) => k !== "appeal_packet" && k !== "adr_response_packet" && k !== "audit_response_packet",
    ),
  )(
    "%s: a hostile or id-only payload fails closed with a typed error (retry -> DLQ), never a blank form",
    (key) => {
      for (const payload of [
        null,
        undefined,
        "x",
        7,
        [],
        { aggregateId: "agg-1", patientId: null },
      ]) {
        expect(() => renderPdfForTemplate(key, payload, key)).toThrow(RenderPayloadError);
      }
    },
  );

  it.each(["order_record", "medication_order"])(
    "a legacy id-only %s event drained under the fallback flag renders generically, not as a form",
    (key) => {
      const bytes = renderPdfForTemplate(
        key,
        { aggregateId: "agg-1", patientId: "p-1", kind: "lab", legacyUntyped: true },
        key,
      );
      expectValidPdf(bytes);
    },
  );

  it("a legacy id-only M6 event drained under the explicit fallback flag renders generically, not as a form", () => {
    const bytes = renderPdfForTemplate(
      "cti",
      { aggregateId: "agg-1", patientId: null, legacyUntyped: true },
      "Certification of Terminal Illness",
    );
    expectValidPdf(bytes);
  });
});

describe("appeal_packet (GAP-036)", () => {
  const DOC_A = "dddddddd-0000-4000-8000-000000000004";
  const DOC_B = "eeeeeeee-0000-4000-8000-000000000005";
  const REMIT_LINE = "ffffffff-0000-4000-8000-000000000006";
  const claimCopy = {
    controlNumber: "CCN-2026-0042",
    tob: "811",
    state: "denied",
    serviceFrom: "2026-03-01",
    serviceTo: "2026-03-31",
    totalChargeCents: 1_234_500,
    lines: [
      {
        lineNumber: 1,
        revenueCode: "0651",
        hcpcsCode: "Q5001",
        serviceFrom: "2026-03-01",
        serviceTo: "2026-03-31",
        units: 31,
        chargeCents: 1_234_500,
      },
    ],
  };
  const remitCopy = {
    remittanceAdviceId: "99999999-0000-4000-8000-000000000009",
    receivedAt: "2026-04-15T10:00:00.000Z",
    paymentMethod: "eft",
    checkOrEftTrace: "TRC123456",
    payerIcn: "ICN-777",
    claimStatusCode: 4,
    chargeCents: 1_234_500,
    paidCents: 0,
    patientResponsibilityCents: 0,
    adjustments: [{ group: "CO", carc: "50", amountCents: 1_234_500 }],
    remarks: [{ kind: "rarc", rarc: "N115" }],
    serviceLines: [
      { revenueCode: "0651", hcpcsCode: "Q5001", chargeCents: 1_234_500, paidCents: 0 },
    ],
  };
  const facts = (over: Partial<Parameters<typeof buildAppealPacketRenderPayload>[0]> = {}) => ({
    appealCaseId: "aaaaaaaa-0000-4000-8000-000000000001",
    denialCaseId: "bbbbbbbb-0000-4000-8000-000000000002",
    claimId: "cccccccc-0000-4000-8000-000000000003",
    tier: "redetermination" as AppealTier,
    tierDeadlineAt: "2026-12-01T00:00:00.000Z",
    submittedAt: "2026-10-08T12:00:00.000Z",
    appealNarrative: "The patient was certified terminally ill; the F2F encounter was timely.",
    attachedDocuments: [
      {
        documentId: DOC_A,
        title: "Face-to-face encounter 2026-02-20",
        documentDate: "2026-02-20T09:00:00.000Z",
        documentKind: "f2f",
      },
      {
        documentId: DOC_B,
        title: "Certification of terminal illness",
        documentDate: "2026-02-18T09:00:00.000Z",
        documentKind: "cti",
      },
    ],
    claimCopy,
    remitCopy,
    denial: {
      carcCode: "50",
      rarcCode: "N115",
      dollarValue: "1234.50",
      remittanceLineId: REMIT_LINE,
    },
    ...over,
  });

  it("builds a valid typed payload from server-held facts, indexing the attached documents", () => {
    const payload = buildAppealPacketRenderPayload(facts());
    expect(appealPacketViolations(payload)).toEqual([]);
    expect(payload.supportingDocuments.map((d) => d.ordinal)).toEqual([1, 2]);
    expect(payload.supportingDocuments[0]?.title).toBe("Face-to-face encounter 2026-02-20");
    expect(payload.tierLetterTitle).toBe(APPEAL_TIER_LETTERS.redetermination.title);
    expect(payload.signedClaimCopyRef.claimId).toBe(facts().claimId);
    expect(payload.remitCopyRef.remittanceLineId).toBe(REMIT_LINE);
    expect(payload.claimCopy.lines).toHaveLength(1);
    expect(payload.remitCopy?.adjustments[0]).toEqual({
      group: "CO",
      carc: "50",
      amountCents: 1_234_500,
    });
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

  it("a remittance reference and its payment detail must travel together", () => {
    const { remitCopy: _omit, ...withoutRemit } = facts();
    expect(() => buildAppealPacketRenderPayload(withoutRemit)).toThrow(/remitCopy: required/);
    expect(() =>
      buildAppealPacketRenderPayload(
        facts({ denial: { ...facts().denial, remittanceLineId: null } }),
      ),
    ).toThrow(/remitCopy: must be absent/);
    // a pre-835 denial (no remittance line) is valid with no remit copy at all
    expect(
      appealPacketViolations(
        buildAppealPacketRenderPayload({
          ...withoutRemit,
          denial: { ...facts().denial, remittanceLineId: null },
        }),
      ),
    ).toEqual([]);
  });

  it("renders the claim lines, the 835 payment detail and the enclosures in words, not short ids", () => {
    const payload = buildAppealPacketRenderPayload(
      facts({
        tier: "reconsideration",
        lateGoodCause: { justification: "The MAC notice was misdelivered." },
        reconsideration: {
          redeterminationMacName: "Example MAC",
          redeterminationNoticeDate: "2026-02-01",
          redeterminationNoticeDocumentId: DOC_B,
          citedEvidence: [
            { label: "Face-to-face note", documentId: DOC_A, notAvailableReason: null },
          ],
          citedEvidenceNone: false,
          evidencePreclusionAcknowledged: false,
        },
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
    expect(text).toContain("good cause");
    expect(text).toContain("The MAC notice was misdelivered.");
    // the QIC request elements: MAC, notice, cited evidence, fill-in identity cells
    expect(text).toContain("Example MAC");
    expect(text).toContain("Face-to-face note");
    expect(text).toContain("Medicare number");
    // the as-submitted claim: control number, type of bill, lines with revenue code / HCPCS / units / charge
    expect(text).toContain("CCN-2026-0042");
    expect(text).toContain("811");
    expect(text).toContain("0651");
    expect(text).toContain("Q5001");
    expect(text).toContain("$12,345.00");
    // the 835 payment: trace, adjustment (group + CARC + amount), remark
    expect(text).toContain("TRC123456");
    expect(text).toContain("ICN-777");
    expect(text).toContain("CO");
    expect(text).toContain("N115");
    // the enclosures are named, not cited by uuid prefix
    expect(text).toContain("Face-to-face encounter 2026-02-20");
    expect(text).toContain("Certification of terminal illness");
    // truthful wording: an 837I carries no wet signature
    expect(text).toContain("As-submitted claim");
    expect(text.toLowerCase()).not.toContain("signed claim");
  });

  it("lists a medical-records bundle by title when the biller attached one", () => {
    const payload = buildAppealPacketRenderPayload(
      facts({
        medicalRecordsBundle: {
          documentId: "12121212-0000-4000-8000-000000000012",
          title: "Medical records March 2026",
          documentDate: "2026-04-01T00:00:00.000Z",
          documentKind: "encounter",
        },
      }),
    );
    const text = textOf(
      expectValidPdf(
        renderPdfForTemplate(
          "appeal_packet",
          { ...payload, aggregateId: payload.appealCaseId, patientId: null },
          "Appeal Packet",
        ),
      ),
    );
    expect(text).toContain("Medical records March 2026");
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
