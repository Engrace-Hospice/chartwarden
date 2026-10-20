/**
 * GAP-008 - structural legal-hold matching. A hold whose ONLY selector is a dateRange or resourceKinds names no id,
 * and the old substring match (resource id / patient id inside the criteria JSON) released its rows to destruction.
 */
import { describe, expect, it } from "vitest";
import {
  type EraseInput,
  eraseAuditRows,
  firstCoveringHold,
  holdCoversGroup,
  isMessagingOnlyCriteria,
  widenSpan,
} from "../src";
import { createInMemoryEraserPorts } from "../src/lifecycle/ports";

const PATIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const group = (over: Partial<EraseInput> = {}): EraseInput => ({
  retentionClass: "compliance",
  resourceKind: "patient_address",
  resourceId: "33333333-3333-4333-8333-333333333333",
  organizationId: "org_1",
  destructionCertificateId: "cert_1",
  createdAtFrom: "2026-03-05T00:00:00.000Z",
  createdAtTo: "2026-03-20T00:00:00.000Z",
  ...over,
});

describe("holdCoversGroup", () => {
  it("a resourceKinds-only hold covers a group of that kind and nothing else", () => {
    const hold = { resourceKinds: ["patient_address"] };
    expect(holdCoversGroup(hold, group())).toBe(true);
    expect(holdCoversGroup(hold, group({ resourceKind: "login" }))).toBe(false);
  });

  it("a dateRange-only hold covers a group whose span overlaps it, not one wholly outside", () => {
    const hold = { dateRange: { from: "2026-03-18T00:00:00Z", to: "2026-03-31T00:00:00Z" } };
    expect(holdCoversGroup(hold, group())).toBe(true); // overlaps on the 18th-20th
    expect(
      holdCoversGroup(hold, group({ createdAtFrom: "2026-01-01T00:00:00Z", createdAtTo: "2026-02-01T00:00:00Z" })),
    ).toBe(false);
  });

  it("a group with no recorded span is assumed to overlap a dateRange hold (over-hold, never release)", () => {
    const hold = { dateRange: { from: "2030-01-01T00:00:00Z", to: "2030-02-01T00:00:00Z" } };
    expect(
      holdCoversGroup(hold, group({ createdAtFrom: undefined, createdAtTo: undefined })),
    ).toBe(true);
  });

  it("every named selector must match (AND), as the hold's own matchedRecordCount does", () => {
    const hold = {
      patientIds: [PATIENT],
      resourceKinds: ["patient_address"],
      dateRange: { from: "2026-03-01T00:00:00Z", to: "2026-03-31T00:00:00Z" },
    };
    expect(holdCoversGroup(hold, group({ patientId: PATIENT }))).toBe(true);
    expect(holdCoversGroup(hold, group({ patientId: OTHER }))).toBe(false);
    expect(holdCoversGroup(hold, group({ patientId: PATIENT, resourceKind: "login" }))).toBe(false);
  });

  it("a patient-keyed group is covered through its resource id", () => {
    expect(holdCoversGroup({ patientIds: [PATIENT] }, group({ resourceId: PATIENT }))).toBe(true);
  });

  it("an empty or malformed criteria covers nothing", () => {
    for (const criteria of [{}, null, undefined]) expect(holdCoversGroup(criteria, group())).toBe(false);
  });
});

describe("firstCoveringHold + the eraser", () => {
  it("returns the first covering hold id", () => {
    const holds = [
      { id: "h_other", criteria: { resourceKinds: ["login"] } },
      { id: "h_kind", criteria: { resourceKinds: ["patient_address"] } },
    ];
    expect(firstCoveringHold(holds, group())).toBe("h_kind");
    expect(firstCoveringHold([], group())).toBeNull();
  });

  it("eraseAuditRows refuses a group a structural hold covers (the port is what the backend binds)", async () => {
    const { ports, erasedCalls } = createInMemoryEraserPorts();
    const holds = [{ id: "h_kind", criteria: { resourceKinds: ["patient_address"] } }];
    const guarded = { ...ports, legalHoldFor: (input: EraseInput) => firstCoveringHold(holds, input) };
    expect(await eraseAuditRows(group(), guarded)).toEqual({
      kind: "refused_legal_hold",
      legalHoldId: "h_kind",
    });
    expect(await eraseAuditRows(group({ resourceKind: "login" }), guarded)).toEqual({
      kind: "erased",
      rowsErased: 1,
    });
    expect(erasedCalls()).toBe(1);
  });
});

describe("messaging selectors (ADR-0086 proposed, WP 5.6)", () => {
  const CH = ["44444444-4444-4444-8444-444444444444"];
  it("a channelIds-only or userIds-only hold covers no audit group, even with a dateRange", () => {
    const range = { from: "2026-03-01T00:00:00Z", to: "2026-03-31T00:00:00Z" };
    expect(holdCoversGroup({ channelIds: CH }, group())).toBe(false);
    expect(holdCoversGroup({ userIds: CH, dateRange: range }, group())).toBe(false);
  });
  it("a hold that also names a patient still scopes by that patient", () => {
    expect(
      holdCoversGroup({ channelIds: CH, patientIds: [PATIENT] }, group({ patientId: PATIENT })),
    ).toBe(true);
    expect(
      holdCoversGroup({ channelIds: CH, patientIds: [OTHER] }, group({ patientId: PATIENT })),
    ).toBe(false);
  });
  it("isMessagingOnlyCriteria is false for audit selectors, empty and malformed criteria", () => {
    expect(isMessagingOnlyCriteria({ channelIds: CH })).toBe(true);
    expect(isMessagingOnlyCriteria({ channelIds: CH, resourceKinds: ["x"] })).toBe(false);
    expect(isMessagingOnlyCriteria({ channelIds: [] })).toBe(false);
    expect(isMessagingOnlyCriteria(null)).toBe(false);
  });
});

describe("widenSpan", () => {
  it("grows a span immutably in both directions", () => {
    const a = widenSpan(undefined, "2026-03-10T00:00:00.000Z");
    const b = widenSpan(a, "2026-03-01T00:00:00.000Z");
    const c = widenSpan(b, "2026-03-31T00:00:00.000Z");
    expect(a).toEqual({ from: "2026-03-10T00:00:00.000Z", to: "2026-03-10T00:00:00.000Z" });
    expect(c).toEqual({ from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T00:00:00.000Z" });
  });
});
