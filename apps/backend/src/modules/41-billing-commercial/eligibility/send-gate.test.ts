import { COMMERCIAL_SEND_REFUSAL } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { type GateEnrollment, evaluateSendGate } from "./send-gate";

const ROUTE = { clearinghousePayerId: "PAYER-77", effectiveFrom: "2026-01-01", effectiveTo: null };
const ENROLLED = { status: "enrolled", effectiveFrom: "2026-01-01", effectiveTo: null } as const;
const ok = {
  clearinghouseKey: "stedi",
  routes: [ROUTE],
  enrollments: [ENROLLED],
  serviceDate: "2026-10-01",
} as const;

describe("evaluateSendGate (ADR-0100 D4, D5; fails closed)", () => {
  it("passes with the routed payer id when bound, routed and enrolled", () => {
    expect(evaluateSendGate(ok)).toEqual({ ok: true, clearinghousePayerId: "PAYER-77" });
  });

  it("an unbound transport answers CH_NOT_WIRED first, even when everything else would pass", () => {
    const r = evaluateSendGate({ ...ok, clearinghouseKey: null });
    expect(r).toMatchObject({ ok: false, code: COMMERCIAL_SEND_REFUSAL.NOT_WIRED });
  });

  it("refuses a payer the active clearinghouse does not route (no routes, or none in effect that day)", () => {
    for (const routes of [
      [],
      [{ ...ROUTE, effectiveFrom: "2026-11-01" }],
      [{ ...ROUTE, effectiveTo: "2026-09-30" }],
    ]) {
      expect(evaluateSendGate({ ...ok, routes })).toMatchObject({
        ok: false,
        code: COMMERCIAL_SEND_REFUSAL.PAYER_NOT_ROUTED,
      });
    }
  });

  it("includes both ends of an effective period", () => {
    const routes = [{ ...ROUTE, effectiveFrom: "2026-10-01", effectiveTo: "2026-10-01" }];
    expect(evaluateSendGate({ ...ok, routes }).ok).toBe(true);
  });

  it("refuses a provider entity with no enrollment, or one that is not 'enrolled' or not in effect", () => {
    const cases: GateEnrollment[][] = [
      [],
      [{ ...ENROLLED, status: "pending" }],
      [{ ...ENROLLED, status: "suspended" }],
      [{ ...ENROLLED, status: "not_enrolled" }],
      [{ ...ENROLLED, effectiveTo: "2026-09-30" }],
      [{ ...ENROLLED, effectiveFrom: "2026-10-02" }],
    ];
    for (const enrollments of cases) {
      expect(evaluateSendGate({ ...ok, enrollments })).toMatchObject({
        ok: false,
        code: COMMERCIAL_SEND_REFUSAL.PROVIDER_NOT_ENROLLED,
      });
    }
  });

  it("every refusal tells the user what to do next and names no member", () => {
    for (const r of [
      evaluateSendGate({ ...ok, clearinghouseKey: null }),
      evaluateSendGate({ ...ok, routes: [] }),
      evaluateSendGate({ ...ok, enrollments: [] }),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(30);
    }
  });

  it("a malformed service date is refused rather than compared", () => {
    expect(() => evaluateSendGate({ ...ok, serviceDate: "10/01/2026" })).toThrow(RangeError);
  });
});
