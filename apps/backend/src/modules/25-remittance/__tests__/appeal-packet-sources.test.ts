// GAP-036 - the appeal packet's enclosure rules, pure. The same rules run live (RLS, real seams) in
// `apps/backend/__tests__/m25-appeal-packet.live.test.ts`.
import { WardenXError } from "@wardenx/types";
import { describe, expect, it, vi } from "vitest";
import {
  type AppealDocumentPort,
  describeEnclosures,
  enclosureRefusal,
  numericToCents,
} from "../routes/appeal-packet-sources";

const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "aaaaaaaa-0000-4000-8000-0000000000a1";
const OTHER_PATIENT = "aaaaaaaa-0000-4000-8000-0000000000a2";
const D1 = "dddddddd-0000-4000-8000-000000000001";
const D2 = "dddddddd-0000-4000-8000-000000000002";

const digest = (over: Record<string, unknown> = {}) =>
  ({
    documentId: D1,
    organizationId: ORG,
    patientId: PATIENT,
    admissionId: null,
    aggregateType: "f2f",
    aggregateId: null,
    title: "Face-to-face encounter",
    retentionClass: "clinical_record",
    status: "active",
    patientFacing: false,
    activeVersionId: null,
    createdAt: "2026-02-20T09:00:00.000Z",
    updatedAt: "2026-02-20T09:00:00.000Z",
    ...over,
  }) as never;

const portOf = (byId: Record<string, unknown>): AppealDocumentPort => ({
  documentMetadata: vi.fn(async ({ documentId }) => (byId[documentId as string] ?? null) as never),
});

describe("enclosureRefusal", () => {
  it("allows an active document of the claim's patient", () => {
    expect(enclosureRefusal(digest(), PATIENT)).toBeNull();
  });
  it("allows a document on legal hold (a hold blocks destruction, not use)", () => {
    expect(enclosureRefusal(digest({ status: "legal_hold" }), PATIENT)).toBeNull();
  });
  it.each([
    [null, "not_found"],
    [digest({ status: "superseded" }), "not_active"],
    [digest({ status: "destroyed_tombstone" }), "not_active"],
    [digest({ patientId: OTHER_PATIENT }), "other_patient"],
    [digest({ patientId: null }), "other_patient"],
    [digest({ retentionClass: "compliance_42cfr_part2" }), "part2_restricted"],
    // Part 2 wins over every other reason: a restricted record is never named, whatever else is true of it
    [
      digest({ retentionClass: "compliance_42cfr_part2", patientId: OTHER_PATIENT }),
      "part2_restricted",
    ],
  ])("refuses %# (%s)", (d, reason) => {
    expect(enclosureRefusal(d as never, PATIENT)).toBe(reason);
  });
});

describe("describeEnclosures", () => {
  it("returns each enclosure's title, date and kind in the order attached, plus the bundle", async () => {
    const port = portOf({
      [D1]: digest({ title: "F2F" }),
      [D2]: digest({ documentId: D2, title: "CTI", aggregateType: "cti" }),
    });
    const out = await describeEnclosures(port, ORG, PATIENT, [D1], D2);
    expect(out.attached).toEqual([
      {
        documentId: D1,
        title: "F2F",
        documentDate: "2026-02-20T09:00:00.000Z",
        documentKind: "f2f",
      },
    ]);
    expect(out.bundle).toMatchObject({ documentId: D2, title: "CTI", documentKind: "cti" });
    expect(port.documentMetadata).toHaveBeenCalledWith({ documentId: D1, organizationId: ORG });
  });

  it("refuses a nonexistent / other-tenant id (the seam reads it as absent) with a 422 and no title", async () => {
    const err = await describeEnclosures(portOf({}), ORG, PATIENT, [D1]).catch((e) => e);
    expect(err).toBeInstanceOf(WardenXError);
    expect(err).toMatchObject({ code: "APPEAL_DOCUMENT_NOT_ATTACHABLE", statusCode: 422 });
    expect(err.message).toContain(D1);
    expect(err.message).toContain("not_found");
  });

  it("refuses another patient's document and never leaks its title", async () => {
    const port = portOf({ [D1]: digest({ patientId: OTHER_PATIENT, title: "SECRET TITLE" }) });
    const err = await describeEnclosures(port, ORG, PATIENT, [D1]).catch((e) => e);
    expect(err).toMatchObject({ code: "APPEAL_DOCUMENT_NOT_ATTACHABLE", statusCode: 422 });
    expect(err.message).toContain("other_patient");
    expect(err.message).not.toContain("SECRET TITLE");
  });

  it("refuses a Part 2 document, and one bad bundle id fails the whole filing", async () => {
    const part2 = portOf({
      [D1]: digest(),
      [D2]: digest({ documentId: D2, retentionClass: "compliance_42cfr_part2" }),
    });
    await expect(describeEnclosures(part2, ORG, PATIENT, [D1], D2)).rejects.toMatchObject({
      code: "APPEAL_DOCUMENT_NOT_ATTACHABLE",
    });
  });

  it("refuses a duplicated enclosure and a bundle that repeats a supporting document", async () => {
    const port = portOf({ [D1]: digest() });
    await expect(describeEnclosures(port, ORG, PATIENT, [D1, D1])).rejects.toMatchObject({
      code: "APPEAL_DUPLICATE_ENCLOSURE",
    });
    await expect(describeEnclosures(port, ORG, PATIENT, [D1], D1)).rejects.toMatchObject({
      code: "APPEAL_DUPLICATE_ENCLOSURE",
    });
  });

  it("refuses more enclosures than a filing may carry without reading any of them", async () => {
    const port = portOf({});
    const ids = Array.from(
      { length: 51 },
      (_, i) => `dddddddd-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    await expect(describeEnclosures(port, ORG, PATIENT, ids)).rejects.toMatchObject({
      code: "APPEAL_TOO_MANY_ENCLOSURES",
    });
    expect(port.documentMetadata).not.toHaveBeenCalled();
  });
});

describe("numericToCents", () => {
  it.each([
    ["1234.50", 123450],
    ["0", 0],
    ["0.07", 7],
    ["12", 1200],
    ["100.5", 10050],
    ["-5.25", -525],
    ["12.3456", 1234], // the column is numeric(12,2); extra digits are truncated, never rounded up
    [19.99, 1999],
  ])("%s -> %d", (input, cents) => {
    expect(numericToCents(input)).toBe(cents);
  });
  it("rejects a non-number instead of returning NaN cents", () => {
    expect(() => numericToCents("abc")).toThrow(WardenXError);
  });
});
