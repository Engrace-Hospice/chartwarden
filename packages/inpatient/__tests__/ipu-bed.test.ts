// @wardenx/inpatient — M37-T03 unit tests for the §2.12 D13 bed-cleaning machine + turnover/reservation clocks.
import { describe, expect, it } from "vitest";
import {
  BED_CLEANING_GRAPH,
  INITIAL_BED_CLEANING_STATUS,
  RESERVATION_HOLD_HOURS,
  TURNOVER_SLA_FLOOR_MINUTES,
  TURNOVER_SLA_MIN_MINUTES,
  isReservationExpired,
  isTurnoverOverdue,
  normalizeTurnoverSlaMinutes,
  transitionBedCleaning,
} from "../src/machines/ipu-bed";
import { IpuStateError } from "../src/errors";

const HOUR = 3_600_000;
const MIN = 60_000;

describe("bed-cleaning state machine (§2.12 D13)", () => {
  it("seeds a bed at 'ready'", () => {
    expect(INITIAL_BED_CLEANING_STATUS).toBe("ready");
  });

  it("walks the happy-path turnover cycle ready→reserved→occupied→discharged_dirty→cleaning→ready", () => {
    expect(transitionBedCleaning("ready", "reserve").to).toBe("reserved");
    expect(transitionBedCleaning("reserved", "occupy").to).toBe("occupied");
    expect(transitionBedCleaning("occupied", "dischargeDirty").to).toBe("discharged_dirty");
    expect(transitionBedCleaning("discharged_dirty", "startCleaning").to).toBe("cleaning");
    const done = transitionBedCleaning("cleaning", "completeCleaning");
    expect(done.to).toBe("ready");
    expect(done.completesTurnover).toBe(true);
  });

  it("only completeCleaning counts as completing a turnover (census room_turnover_count)", () => {
    expect(transitionBedCleaning("ready", "reserve").completesTurnover).toBe(false);
    expect(transitionBedCleaning("cleaning", "completeCleaning").completesTurnover).toBe(true);
  });

  it("releases a lapsed reservation back to ready", () => {
    expect(transitionBedCleaning("reserved", "expireReservation").to).toBe("ready");
  });

  it("retires a ready bed; retired is terminal", () => {
    expect(transitionBedCleaning("ready", "retire").to).toBe("retired");
    expect(BED_CLEANING_GRAPH.retired).toEqual([]);
  });

  it("rejects an illegal transition with ILLEGAL_BED_CLEANING_TRANSITION (409)", () => {
    expect(() => transitionBedCleaning("occupied", "reserve")).toThrow(IpuStateError);
    try {
      transitionBedCleaning("retired", "reserve");
    } catch (e) {
      expect((e as IpuStateError).code).toBe("ILLEGAL_BED_CLEANING_TRANSITION");
      expect((e as IpuStateError).statusCode).toBe(409);
    }
    // Cannot skip cleaning: occupied cannot jump straight to ready.
    expect(() => transitionBedCleaning("occupied", "completeCleaning")).toThrow(
      /cannot completeCleaning from 'occupied'/,
    );
  });
});

describe("turnover SLA (§2.12 tighten-only, 2h floor)", () => {
  it("accepts a tightening and clamps to the 1h minimum", () => {
    expect(normalizeTurnoverSlaMinutes(120)).toBe(120);
    expect(normalizeTurnoverSlaMinutes(90)).toBe(90);
    expect(normalizeTurnoverSlaMinutes(60)).toBe(TURNOVER_SLA_MIN_MINUTES);
    expect(normalizeTurnoverSlaMinutes(30)).toBe(TURNOVER_SLA_MIN_MINUTES); // clamped up to 60
  });

  it("rejects a loosening above the 2h platform floor", () => {
    expect(() => normalizeTurnoverSlaMinutes(180)).toThrow(IpuStateError);
    try {
      normalizeTurnoverSlaMinutes(TURNOVER_SLA_FLOOR_MINUTES + 1);
    } catch (e) {
      expect((e as IpuStateError).code).toBe("TURNOVER_SLA_NOT_TIGHTENING");
    }
  });

  it("flags a bed overdue only while dirty/cleaning past the SLA", () => {
    const t0 = 10 * HOUR;
    expect(isTurnoverOverdue("discharged_dirty", t0, t0 + 121 * MIN, 120)).toBe(true);
    expect(isTurnoverOverdue("cleaning", t0, t0 + 121 * MIN, 120)).toBe(true);
    expect(isTurnoverOverdue("discharged_dirty", t0, t0 + 119 * MIN, 120)).toBe(false);
    // A bed already back to ready (or never dirtied) is never overdue.
    expect(isTurnoverOverdue("ready", t0, t0 + 999 * MIN, 120)).toBe(false);
    expect(isTurnoverOverdue("occupied", t0, t0 + 999 * MIN, 120)).toBe(false);
  });
});

describe("reservation hold (§2.12, 4h)", () => {
  it("expires a reserved bed past the hold window", () => {
    const t0 = 5 * HOUR;
    expect(isReservationExpired("reserved", t0, t0 + (RESERVATION_HOLD_HOURS + 1) * HOUR)).toBe(true);
    expect(isReservationExpired("reserved", t0, t0 + 1 * HOUR)).toBe(false);
    // Only meaningful for a reserved bed.
    expect(isReservationExpired("occupied", t0, t0 + 99 * HOUR)).toBe(false);
  });
});
