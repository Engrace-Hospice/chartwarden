// Milestone 2b — the ADR response packet render: the typed payload, the cover-and-index document, the real PDF,
// and the render-time enclosure guard (a Part 2 reclassification stops the retained copy; a superseded document
// does not, because it is still what was filed).
import { buildAdrPacketRenderPayload } from "@wardenx/types";
import { describe, expect, it, vi } from "vitest";
import {
  adrEnclosureIds,
  buildAppealPacketRenderGuard,
} from "../src/modules/22-documents/outbox-consumers/appeal-render-guard";
import { buildAdrResponseDoc } from "../src/modules/22-documents/render-pdf/adr-response-doc";
import { renderPdfForTemplate } from "../src/modules/22-documents/render-pdf/registry";

const ORG = "00000000-0000-4000-8000-0000000000ee";
const D_OK = "dddddddd-0000-4000-8000-000000000001";
const D_P2 = "dddddddd-0000-4000-8000-000000000002";
const D_OLD = "dddddddd-0000-4000-8000-000000000003";

const facts = (docs: string[] = [D_OK]) => ({
  adrCaseId: "00000000-0000-4000-8000-0000000000bb",
  claimId: "00000000-0000-4000-8000-0000000000c1",
  macName: "CGS",
  reviewType: "adr" as const,
  adrReference: "ADR-77-1",
  requestedOn: "2026-01-28",
  responseDueAt: "2026-03-14T03:59:59.999Z",
  filedAt: "2026-03-10T15:00:00.000Z",
  filedLate: false,
  filingChannel: "mac_portal",
  filingConfirmationRef: "CONF-12345",
  reviewedAt: "2026-03-09T15:00:00.000Z",
  checklist: [
    { key: "certification_of_terminal_illness", state: "ready" as const },
    { key: "visit_notes", state: "not_applicable" as const },
  ],
  enclosures: docs.map((d, i) => ({
    documentId: d,
    title: `Certification ${i + 1}`,
    documentDate: "2026-02-20T09:00:00.000Z",
    documentKind: "cti",
    checklistKey: i === 0 ? "certification_of_terminal_illness" : null,
  })),
});

const flat = (m: ReturnType<typeof buildAdrResponseDoc>): string => JSON.stringify(m.blocks);

describe("buildAdrPacketRenderPayload", () => {
  it("numbers the enclosures in the order they were attached", () => {
    const p = buildAdrPacketRenderPayload(facts([D_OK, D_OLD]));
    expect(p.enclosures.map((e) => [e.ordinal, e.documentId])).toEqual([
      [1, D_OK],
      [2, D_OLD],
    ]);
  });
  it("refuses a packet with no enclosures, so a blank record is never rendered", () => {
    expect(() => buildAdrPacketRenderPayload(facts([]))).toThrow(/invalid AdrPacketRenderPayload/);
  });
});

describe("buildAdrResponseDoc", () => {
  it("shows the filing facts and names every enclosure", () => {
    const text = flat(buildAdrResponseDoc(buildAdrPacketRenderPayload(facts([D_OK, D_OLD]))));
    expect(text).toContain("CONF-12345");
    expect(text).toContain("ADR-77-1");
    expect(text).toContain("Certification 2");
    expect(text).not.toContain("Filed after the response due date");
  });
  it("flags a late filing and titles a re-ADR", () => {
    const m = buildAdrResponseDoc(
      buildAdrPacketRenderPayload({ ...facts(), filedLate: true, reviewType: "re_adr" }),
    );
    expect(m.title).toBe("Re-ADR Response Packet");
    expect(flat(m)).toContain("Filed after the response due date");
  });
  it("throws on a malformed payload rather than rendering a half-empty record", () => {
    expect(() => buildAdrResponseDoc({ adrCaseId: "x" })).toThrow(/invalid AdrPacketRenderPayload/);
  });
  it("renders a real PDF through the registry", () => {
    const bytes = renderPdfForTemplate(
      "adr_response_packet",
      buildAdrPacketRenderPayload(facts()),
      "ADR Response Packet",
    );
    expect(Buffer.from(bytes).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("the render guard for an ADR response", () => {
  const digestOf = (over: Record<string, unknown>) =>
    ({ patientId: "p", status: "active", retentionClass: "clinical_record", ...over }) as never;
  const guard = (byId: Record<string, unknown>) =>
    buildAppealPacketRenderGuard(
      () =>
        ({
          documentMetadata: vi.fn(
            async ({ documentId }: { documentId: string }) => byId[documentId] ?? null,
          ),
        }) as never,
    );
  const req = (docs: string[]) => ({
    organizationId: ORG,
    templateKey: "adr_response_packet",
    content: buildAdrPacketRenderPayload(facts(docs)) as unknown as Record<string, unknown>,
  });

  it("reads the enclosure ids, tolerant of a malformed payload", () => {
    expect(adrEnclosureIds(req([D_OK, D_OLD]).content)).toEqual([D_OK, D_OLD]);
    expect(adrEnclosureIds({ enclosures: [null, 3, { documentId: 7 }] })).toEqual([]);
  });
  it("still renders when a filed document has since been superseded", async () => {
    const g = guard({ [D_OK]: digestOf({}), [D_OLD]: digestOf({ status: "superseded" }) });
    expect(await g(req([D_OK, D_OLD]))).toBeNull();
  });
  it("refuses when a filed document was reclassified to 42 CFR Part 2", async () => {
    const g = guard({
      [D_OK]: digestOf({}),
      [D_P2]: digestOf({ retentionClass: "compliance_42cfr_part2" }),
    });
    expect(await g(req([D_OK, D_P2]))).toEqual({ detail: `${D_P2}:part2_restricted` });
  });
  it("refuses a document that can no longer be read", async () => {
    expect(await guard({ [D_OK]: digestOf({}) })(req([D_OK, D_OLD]))).toEqual({
      detail: `${D_OLD}:not_found`,
    });
  });
});
