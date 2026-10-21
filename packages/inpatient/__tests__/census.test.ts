// @chartwarden/inpatient — M37-T10 unit tests for the §2.13 D14 census builder + service-day rule.
import { describe, expect, it } from "vitest";
import { isServiceDay } from "../src/domain/census/bed-day-calculator";
import {
  type CensusAdmissionFact,
  buildCensusSnapshotPayload,
} from "../src/domain/census/snapshot-builder";

const HOUR = 3_600_000;
const dayStart = 1000 * 24 * HOUR;
const dayEnd = dayStart + 24 * HOUR;

describe("service-day rule (§2.13)", () => {
  it("counts any-portion overlap as a service day", () => {
    // Admitted mid-day, still active.
    expect(isServiceDay(dayStart + 6 * HOUR, null, dayStart, dayEnd)).toBe(true);
    // Active window fully spans the day.
    expect(isServiceDay(dayStart - 100 * HOUR, dayEnd + 100 * HOUR, dayStart, dayEnd)).toBe(true);
    // Discharged one hour into the day → still a service day.
    expect(isServiceDay(dayStart - 5 * HOUR, dayStart + 1 * HOUR, dayStart, dayEnd)).toBe(true);
  });
  it("excludes windows that do not touch the day", () => {
    expect(isServiceDay(dayEnd, null, dayStart, dayEnd)).toBe(false); // admitted next day
    expect(isServiceDay(dayStart - 50 * HOUR, dayStart, dayStart, dayEnd)).toBe(false); // ended exactly at day start
  });
});

describe("census snapshot builder (§2.13)", () => {
  const key = {
    organizationId: "org-1",
    providerEntityId: "pe-1",
    serviceDate: "2026-08-02",
    unitId: "unit-1",
    remoteFacilityId: null,
  };
  const incidents = {
    roomTurnoverCount: 3,
    restraintIncidentCount: 1,
    fallIncidentCount: 0,
    infectionSurveillanceEventCount: 2,
  };

  it("buckets head-counts and bed-days by level and own-unit vs arranged", () => {
    const admissions: CensusAdmissionFact[] = [
      { level: "gip", isArranged: false, activeAtEndOfDay: true, activeAnyPortionOfDay: true },
      { level: "gip", isArranged: false, activeAtEndOfDay: false, activeAnyPortionOfDay: true }, // discharged today: bed-day only
      { level: "irc", isArranged: false, activeAtEndOfDay: true, activeAnyPortionOfDay: true },
      { level: "gip", isArranged: true, activeAtEndOfDay: true, activeAnyPortionOfDay: true }, // remote
      { level: "irc", isArranged: true, activeAtEndOfDay: true, activeAnyPortionOfDay: true }, // remote
    ];
    const p = buildCensusSnapshotPayload(key, admissions, incidents);
    expect(p.censusCountGip).toBe(1); // one active-at-EOD own-unit GIP
    expect(p.bedDaysGip).toBe(2); // both own-unit GIP had a bed-day
    expect(p.censusCountIrc).toBe(1);
    expect(p.censusCountArrangedGip).toBe(1);
    expect(p.censusCountArrangedIrc).toBe(1);
    expect(p.bedDaysArrangedGip).toBe(1);
    // incident counts pass through
    expect(p.roomTurnoverCount).toBe(3);
    expect(p.restraintIncidentCount).toBe(1);
    expect(p.infectionSurveillanceEventCount).toBe(2);
    // key stamped
    expect(p.unitId).toBe("unit-1");
    expect(p.serviceDate).toBe("2026-08-02");
  });

  it("produces an all-zero snapshot for an empty unit-day", () => {
    const p = buildCensusSnapshotPayload(key, [], {
      roomTurnoverCount: 0,
      restraintIncidentCount: 0,
      fallIncidentCount: 0,
      infectionSurveillanceEventCount: 0,
    });
    expect(p.censusCountGip + p.censusCountIrc + p.bedDaysGip + p.bedDaysIrc).toBe(0);
  });
});
