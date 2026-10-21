// M25 milestone 4 - the reconsideration block of the appeal packet payload: when it is required, that every document it
// points at is an enclosure the letter lists, and that the rendered request shows the CMS elements and never claims
// to hold an identity this system does not have.
import { appealPacketViolations, buildAppealPacketRenderPayload } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { buildAppealPacketDoc } from "../src/modules/22-documents/render-pdf/appeal-packet-doc";

const NOTICE = "dddddddd-0000-4000-8000-000000000001";
const NOTE = "dddddddd-0000-4000-8000-000000000002";

type Facts = Parameters<typeof buildAppealPacketRenderPayload>[0];

const enclosure = (documentId: string, title: string) => ({
  documentId,
  title,
  documentDate: "2026-02-20T09:00:00.000Z",
  documentKind: "f2f",
});

const facts = (over: Partial<Facts> = {}): Facts => ({
  appealCaseId: "aaaaaaaa-0000-4000-8000-000000000001",
  denialCaseId: "bbbbbbbb-0000-4000-8000-000000000002",
  claimId: "cccccccc-0000-4000-8000-000000000003",
  tier: "reconsideration",
  tierDeadlineAt: "2026-12-01T00:00:00.000Z",
  submittedAt: "2026-10-08T12:00:00.000Z",
  appealNarrative: "The redetermination missed the timely face-to-face note.",
  attachedDocuments: [enclosure(NOTICE, "Redetermination notice"), enclosure(NOTE, "F2F note")],
  claimCopy: {
    controlNumber: "CCN-1",
    tob: "811",
    state: "denied",
    serviceFrom: "2026-01-01",
    serviceTo: "2026-01-31",
    totalChargeCents: 100_000,
    lines: [
      {
        lineNumber: 1,
        revenueCode: "0651",
        hcpcsCode: "Q5001",
        serviceFrom: "2026-01-01",
        serviceTo: "2026-01-31",
        units: 31,
        chargeCents: 100_000,
      },
    ],
  },
  denial: { carcCode: "50", rarcCode: null, dollarValue: "1000.00", remittanceLineId: null },
  reconsideration: {
    redeterminationMacName: "Example MAC",
    redeterminationNoticeDate: "2026-02-01",
    redeterminationNoticeDocumentId: NOTICE,
    citedEvidence: [{ label: "Face-to-face note", documentId: NOTE, notAvailableReason: null }],
    citedEvidenceNone: false,
    evidencePreclusionAcknowledged: false,
  },
  ...over,
});

describe("reconsideration block of the appeal packet", () => {
  it("is valid with the notice copy and the cited item enclosed", () => {
    expect(appealPacketViolations(buildAppealPacketRenderPayload(facts()))).toEqual([]);
  });

  it("is required for a reconsideration and refused on any other tier", () => {
    expect(() => buildAppealPacketRenderPayload(facts({ reconsideration: undefined }))).toThrow(
      /reconsideration: required/,
    );
    expect(() => buildAppealPacketRenderPayload(facts({ tier: "redetermination" }))).toThrow(
      /only a reconsideration/,
    );
  });

  it("refuses a notice copy or cited document that is not among the enclosures", () => {
    const base = facts().reconsideration!;
    expect(() =>
      buildAppealPacketRenderPayload(
        facts({ reconsideration: { ...base, redeterminationNoticeDocumentId: "x-not-enclosed" } }),
      ),
    ).toThrow(/must be an enclosure/);
    expect(() =>
      buildAppealPacketRenderPayload(
        facts({
          reconsideration: {
            ...base,
            citedEvidence: [
              { label: "Orders", documentId: "x-not-enclosed", notAvailableReason: null },
            ],
          },
        }),
      ),
    ).toThrow(/not among the enclosures/);
  });

  it("needs the preclusion acknowledgement when an item is explained instead of enclosed", () => {
    const base = facts().reconsideration!;
    const explained = {
      ...base,
      citedEvidence: [
        { label: "Visit notes", documentId: null, notAvailableReason: "Not released yet." },
      ],
    };
    expect(() => buildAppealPacketRenderPayload(facts({ reconsideration: explained }))).toThrow(
      /evidencePreclusionAcknowledged/,
    );
    expect(
      appealPacketViolations(
        buildAppealPacketRenderPayload(
          facts({ reconsideration: { ...explained, evidencePreclusionAcknowledged: true } }),
        ),
      ),
    ).toEqual([]);
  });

  it("refuses a list that is empty without the attestation, or full with it", () => {
    const base = facts().reconsideration!;
    expect(() =>
      buildAppealPacketRenderPayload(facts({ reconsideration: { ...base, citedEvidence: [] } })),
    ).toThrow(/attest the notice named none/);
    expect(() =>
      buildAppealPacketRenderPayload(
        facts({ reconsideration: { ...base, citedEvidenceNone: true } }),
      ),
    ).toThrow(/must be empty/);
  });
});

describe("rendered reconsideration request", () => {
  const textOf = (payload: unknown): string => JSON.stringify(buildAppealPacketDoc(payload).blocks);

  it("shows the request elements, the cited-evidence table and blank identity cells", () => {
    const text = textOf(buildAppealPacketRenderPayload(facts()));
    expect(text).toContain("Example MAC");
    expect(text).toContain("Redetermination notice dated");
    expect(text).toContain("Face-to-face note");
    expect(text).toContain("Enclosed: #2 F2F note");
    expect(text).toContain("Copy of the redetermination notice");
    // identity this system does not hold is a labeled blank, never invented
    expect(text).toContain('["Medicare number (MBI)",""]');
    expect(text).toContain('["Beneficiary name",""]');
  });

  it("warns, as a banner, when an item is not enclosed", () => {
    const base = facts().reconsideration!;
    const blocks = buildAppealPacketDoc(
      buildAppealPacketRenderPayload(
        facts({
          reconsideration: {
            ...base,
            citedEvidence: [
              { label: "Visit notes", documentId: null, notAvailableReason: "Not released yet." },
            ],
            evidencePreclusionAcknowledged: true,
          },
        }),
      ),
    ).blocks;
    expect(blocks.some((b) => b.kind === "banner" && /excluded at later levels/.test(b.text))).toBe(
      true,
    );
    expect(JSON.stringify(blocks)).toContain("Not enclosed: Not released yet.");
  });

  it("states that the notice named nothing when attested, and prints no table", () => {
    const base = facts().reconsideration!;
    const text = textOf(
      buildAppealPacketRenderPayload(
        facts({ reconsideration: { ...base, citedEvidence: [], citedEvidenceNone: true } }),
      ),
    );
    expect(text).toContain("named no missing documentation");
  });

  it("leaves a redetermination letter exactly as before", () => {
    const text = textOf(
      buildAppealPacketRenderPayload(
        facts({ tier: "redetermination", reconsideration: undefined }),
      ),
    );
    expect(text).not.toContain("required elements");
  });
});
