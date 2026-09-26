// @wardenx/emar — §5.11 five-rights validator — M13-T03.
import { describe, expect, it } from "vitest";
import {
  type FiveRightsOrderContext,
  type FiveRightsRequest,
  assertFiveRights,
  checkFiveRights,
} from "../src/five-rights";

const NOW = "2026-06-22T17:00:00.000Z";

// Order: Haloperidol 0.5 mg PO BID (the §5.11 fixture).
const order: FiveRightsOrderContext = {
  patientId: "pat-1",
  medicationOrderId: "ord-1",
  route: "PO",
  doseAmount: 0.5,
  doseUnit: "mg",
};

const goodRequest: FiveRightsRequest = {
  patientId: "pat-1",
  medicationOrderId: "ord-1",
  route: "PO",
  doseAmount: 0.5,
  doseUnit: "mg",
  administeredAt: "2026-06-22T16:55:00.000Z",
};

describe("§5.11 five-rights", () => {
  it("a matching administration passes all five rights", () => {
    expect(checkFiveRights(goodRequest, order, NOW)).toEqual({ ok: true, failedRights: [] });
  });

  it("the §5.11 wrong-route catch: PO order, IM entered → route fails", () => {
    const r = checkFiveRights({ ...goodRequest, route: "IM" }, order, NOW);
    expect(r.ok).toBe(false);
    expect(r.failedRights).toEqual(["route"]);
  });

  it("route comparison is case-insensitive and trimmed", () => {
    expect(checkFiveRights({ ...goodRequest, route: " po " }, order, NOW).ok).toBe(true);
  });

  it("wrong patient fails the patient right", () => {
    expect(
      checkFiveRights({ ...goodRequest, patientId: "pat-2" }, order, NOW).failedRights,
    ).toContain("patient");
  });

  it("wrong order fails the drug right", () => {
    expect(
      checkFiveRights({ ...goodRequest, medicationOrderId: "ord-2" }, order, NOW).failedRights,
    ).toContain("drug");
  });

  it("a partial dose (half) passes the dose right (§5.12)", () => {
    expect(checkFiveRights({ ...goodRequest, doseAmount: 0.25 }, order, NOW).ok).toBe(true);
  });

  it("an over-dose (greater than the order) fails the dose right", () => {
    expect(checkFiveRights({ ...goodRequest, doseAmount: 1.0 }, order, NOW).failedRights).toContain(
      "dose",
    );
  });

  it("a unit mismatch fails the dose right", () => {
    expect(checkFiveRights({ ...goodRequest, doseUnit: "mcg" }, order, NOW).failedRights).toContain(
      "dose",
    );
  });

  it("a non-positive dose fails the dose right", () => {
    expect(checkFiveRights({ ...goodRequest, doseAmount: 0 }, order, NOW).failedRights).toContain(
      "dose",
    );
  });

  it("a null order dose (non-discrete IV) skips the dose right", () => {
    const ivOrder: FiveRightsOrderContext = { ...order, doseAmount: null, doseUnit: null };
    const ivReq: FiveRightsRequest = { ...goodRequest, doseAmount: null, doseUnit: null };
    expect(checkFiveRights(ivReq, ivOrder, NOW).ok).toBe(true);
  });

  it("a far-future administeredAt fails the time right (beyond skew tolerance)", () => {
    const future = "2026-06-22T18:00:00.000Z"; // 1h ahead of NOW
    expect(
      checkFiveRights({ ...goodRequest, administeredAt: future }, order, NOW).failedRights,
    ).toContain("time");
  });

  it("a small forward clock skew within tolerance passes the time right", () => {
    const slightlyAhead = "2026-06-22T17:03:00.000Z"; // 3 min ahead (< 5 min default)
    expect(checkFiveRights({ ...goodRequest, administeredAt: slightlyAhead }, order, NOW).ok).toBe(
      true,
    );
  });

  it("a far-PAST administeredAt is NOT a five-rights failure (it is a late entry)", () => {
    const past = "2026-06-20T17:00:00.000Z"; // 2 days ago
    expect(checkFiveRights({ ...goodRequest, administeredAt: past }, order, NOW).ok).toBe(true);
  });

  it("multiple failures are all reported at once", () => {
    const r = checkFiveRights(
      { ...goodRequest, route: "IM", doseAmount: 5, patientId: "pat-9" },
      order,
      NOW,
    );
    expect([...r.failedRights].sort()).toEqual(["dose", "patient", "route"]);
  });

  it("assertFiveRights throws FIVE_RIGHTS_VIOLATION (422) naming the failed rights", () => {
    expect(() => assertFiveRights({ ...goodRequest, route: "IM" }, order, NOW)).toThrow(
      expect.objectContaining({ code: "FIVE_RIGHTS_VIOLATION", statusCode: 422 }),
    );
    expect(() => assertFiveRights(goodRequest, order, NOW)).not.toThrow();
  });
});
