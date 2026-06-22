// @wardenx/emar — §2.4 D3 PRN minimum-interval enforcement — M13-T04.
import { describe, expect, it } from "vitest";
import { assertPrnInterval, checkPrnInterval } from "../src/prn";

const LAST = "2026-06-22T08:35:00.000Z";

describe("§2.4 D3 checkPrnInterval", () => {
  it("passes the first dose (no prior PRN administration)", () => {
    expect(
      checkPrnInterval({
        minimumIntervalMinutes: 60,
        lastAdministeredAt: null,
        requestedAdministeredAt: LAST,
      }).ok,
    ).toBe(true);
  });
  it("passes when the order sets no positive minimum", () => {
    expect(
      checkPrnInterval({
        minimumIntervalMinutes: null,
        lastAdministeredAt: LAST,
        requestedAdministeredAt: "2026-06-22T08:40:00.000Z",
      }).ok,
    ).toBe(true);
  });
  it("the §5 fixture: 6h since last dose, minimum 60 → passes", () => {
    const r = checkPrnInterval({
      minimumIntervalMinutes: 60,
      lastAdministeredAt: LAST,
      requestedAdministeredAt: "2026-06-22T14:35:00.000Z",
    });
    expect(r.ok).toBe(true);
    expect(r.currentDeltaMinutes).toBe(360);
  });
  it("the §5 edge: 20 min after the prior dose, minimum 60 → violation with delta+minimum echoed", () => {
    const r = checkPrnInterval({
      minimumIntervalMinutes: 60,
      lastAdministeredAt: LAST,
      requestedAdministeredAt: "2026-06-22T08:55:00.000Z",
    });
    expect(r).toEqual({ ok: false, currentDeltaMinutes: 20, minimumIntervalMinutes: 60 });
  });
  it("passes exactly at the minimum boundary", () => {
    expect(
      checkPrnInterval({
        minimumIntervalMinutes: 60,
        lastAdministeredAt: LAST,
        requestedAdministeredAt: "2026-06-22T09:35:00.000Z",
      }).ok,
    ).toBe(true);
  });
});

describe("§2.4 D3 assertPrnInterval (the override path)", () => {
  const violation = {
    minimumIntervalMinutes: 60,
    lastAdministeredAt: LAST,
    requestedAdministeredAt: "2026-06-22T08:55:00.000Z",
  };

  it("a passing interval returns { overridden: false } with no override needed", () => {
    expect(assertPrnInterval({ ...violation, minimumIntervalMinutes: 10 })).toEqual({ overridden: false });
  });
  it("throws PRN_INTERVAL_VIOLATION (422) without an override", () => {
    expect(() => assertPrnInterval(violation)).toThrow(
      expect.objectContaining({ code: "PRN_INTERVAL_VIOLATION", statusCode: 422 }),
    );
  });
  it("throws PRN_INTERVAL_OVERRIDE_NOT_PERMITTED (403) when the override lacks the permission", () => {
    expect(() =>
      assertPrnInterval(violation, { hasOverridePermission: false, reason: "x".repeat(50) }),
    ).toThrow(expect.objectContaining({ code: "PRN_INTERVAL_OVERRIDE_NOT_PERMITTED", statusCode: 403 }));
  });
  it("throws PRN_INTERVAL_OVERRIDE_REASON_TOO_SHORT (422) when the reason is under 40 chars", () => {
    expect(() =>
      assertPrnInterval(violation, { hasOverridePermission: true, reason: "too short" }),
    ).toThrow(expect.objectContaining({ code: "PRN_INTERVAL_OVERRIDE_REASON_TOO_SHORT", statusCode: 422 }));
  });
  it("permits the write with { overridden: true } given permission + a ≥40-char reason", () => {
    expect(
      assertPrnInterval(violation, {
        hasOverridePermission: true,
        reason: "Breakthrough pain unrelieved; supervisor approved early redose per protocol.",
      }),
    ).toEqual({ overridden: true });
  });
});
