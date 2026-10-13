// The offboarding chain (offboarding_initiated → final_export_pending → retained → destruction_pending) had no route,
// so a tenant could never reach `destruction_pending` and the shred route (which requires it) was unreachable.
// completeExport opens the retention window; scheduleDestruction needs it elapsed AND no legal hold (§2.2).
import { describe, expect, it } from "vitest";
import {
  TENANT_RETENTION_YEARS,
  evaluateDestructionGuards,
  retentionEndsAtFrom,
} from "../routes/platform/offboarding-guards";

const NOW = new Date("2026-10-13T12:00:00Z");

describe("retentionEndsAtFrom", () => {
  it("opens a six-year window (HIPAA 45 CFR 164.316(b)(2)(i) documentation retention)", () => {
    expect(TENANT_RETENTION_YEARS).toBe(6);
    expect(retentionEndsAtFrom(NOW).toISOString()).toBe("2032-10-13T12:00:00.000Z");
  });

  it("does not mutate the date it was given", () => {
    const start = new Date(NOW);

    retentionEndsAtFrom(start);

    expect(start.toISOString()).toBe(NOW.toISOString());
  });
});

describe("evaluateDestructionGuards", () => {
  it("passes once the window has elapsed and no legal hold is active", () => {
    expect(
      evaluateDestructionGuards({
        retentionEndsAt: new Date("2026-10-13T11:59:59Z"),
        now: NOW,
        legalHoldClear: true,
      }),
    ).toEqual({ retentionElapsed: true, legalHoldClear: true });
  });

  it("is not elapsed while the window is open, and never when retention was not recorded", () => {
    const open = evaluateDestructionGuards({
      retentionEndsAt: new Date("2030-01-01T00:00:00Z"),
      now: NOW,
      legalHoldClear: true,
    });
    const unset = evaluateDestructionGuards({
      retentionEndsAt: null,
      now: NOW,
      legalHoldClear: true,
    });

    expect(open.retentionElapsed).toBe(false);
    expect(unset.retentionElapsed).toBe(false);
  });

  it("carries a legal hold through so the machine can refuse", () => {
    const held = evaluateDestructionGuards({
      retentionEndsAt: new Date("2020-01-01T00:00:00Z"),
      now: NOW,
      legalHoldClear: false,
    });

    expect(held.legalHoldClear).toBe(false);
  });
});
