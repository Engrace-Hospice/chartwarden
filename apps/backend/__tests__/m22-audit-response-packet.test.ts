// Milestone 7a-2 — the audit response packet render: the typed payload, the cover-and-index document, the real PDF,
// and the render-time enclosure guard (the audit packet takes the ADR branch: a Part 2 reclassification stops the
// retained copy, a superseded document does not, because it is still what was filed).
import { buildAuditResponsePacketRenderPayload } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import { buildAppealPacketRenderGuard } from "../src/modules/22-documents/outbox-consumers/appeal-render-guard";
import { buildAuditResponseDoc } from "../src/modules/22-documents/render-pdf/audit-response-doc";
import { renderPdfForTemplate } from "../src/modules/22-documents/render-pdf/registry";

const ORG = "00000000-0000-4000-8000-0000000000ee";
const CLAIM = "00000000-0000-4000-8000-0000000000c1";
const D_OK = "dddddddd-0000-4000-8000-000000000001";
const D_P2 = "dddddddd-0000-4000-8000-000000000002";
const D_OLD = "dddddddd-0000-4000-8000-000000000003";

const facts = (docs: string[] = [D_OK]) => ({
  auditRequestId: "00000000-0000-4000-8000-0000000000bb",
  authorityKind: "upic",
  authorityName: null,
  requestReference: "REQ-77-1",
  requestDatedOn: "2026-01-28",
  receivedOn: "2026-02-02",
  filedAt: "2026-03-10T15:00:00.000Z",
  filedLate: false,
  filingChannel: "mail",
  filingConfirmationRef: "TRACK-12345",
  reviewedAt: "2026-03-09T15:00:00.000Z",
  noDeadlineStatedAttested: false,
  deadlines: [{ label: "Records due", dueOn: "2026-03-20", satisfiedOn: null }],
  checklist: [
    { label: "Orders for the period", state: "ready" as const },
    { label: "Visit notes", state: "not_applicable" as const },
  ],
  claims: [{ claimId: CLAIM, claimControlNumber: "CCN-1" }],
  enclosures: docs.map((d, i) => ({
    documentId: d,
    claimId: CLAIM,
    title: `Certification ${i + 1}`,
    documentDate: "2026-02-20T09:00:00.000Z",
    documentKind: "cti",
  })),
});

const flat = (m: ReturnType<typeof buildAuditResponseDoc>): string => JSON.stringify(m.blocks);

describe("buildAuditResponsePacketRenderPayload", () => {
  it("numbers the enclosures in the order they were attached", () => {
    const p = buildAuditResponsePacketRenderPayload(facts([D_OK, D_OLD]));
    expect(p.enclosures.map((e) => [e.ordinal, e.documentId])).toEqual([
      [1, D_OK],
      [2, D_OLD],
    ]);
  });
  it("refuses a packet with no enclosures, so a blank record is never rendered", () => {
    expect(() => buildAuditResponsePacketRenderPayload(facts([]))).toThrow(
      /invalid AuditResponsePacketRenderPayload/,
    );
  });
});

describe("buildAuditResponseDoc", () => {
  it("shows the filing facts, the typed due date and the checklist as typed, and names every enclosure", () => {
    const text = flat(
      buildAuditResponseDoc(buildAuditResponsePacketRenderPayload(facts([D_OK, D_OLD]))),
    );
    expect(text).toContain("TRACK-12345");
    expect(text).toContain("REQ-77-1");
    expect(text).toContain("Records due");
    expect(text).toContain("Orders for the period");
    expect(text).toContain("Certification 2");
    expect(text).not.toContain("Filed after a recorded due date");
  });
  it("states that the letter names no due date when that was attested, and flags a late filing", () => {
    const m = buildAuditResponseDoc(
      buildAuditResponsePacketRenderPayload({
        ...facts(),
        filedLate: true,
        deadlines: [],
        noDeadlineStatedAttested: true,
      }),
    );
    expect(flat(m)).toContain("The request letter states no due date");
    expect(flat(m)).toContain("Filed after a recorded due date");
  });
  it("throws on a malformed payload rather than rendering a half-empty record", () => {
    expect(() => buildAuditResponseDoc({ auditRequestId: "x" })).toThrow(
      /invalid AuditResponsePacketRenderPayload/,
    );
  });
  it("renders a real PDF through the registry", () => {
    const bytes = renderPdfForTemplate(
      "audit_response_packet",
      buildAuditResponsePacketRenderPayload(facts()),
      "Audit Response Packet",
    );
    expect(Buffer.from(bytes).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("the render guard for an audit response", () => {
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
    templateKey: "audit_response_packet",
    content: buildAuditResponsePacketRenderPayload(facts(docs)) as unknown as Record<
      string,
      unknown
    >,
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
