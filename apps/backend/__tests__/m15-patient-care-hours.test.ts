/**
 * M15-F04 — the 418.78(e) denominator: signed hands-on staff visit minutes from M8's digests.
 */
import type { PatientId, SignedEncounterDigest } from "@wardenx/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reader = vi.hoisted(() => ({ signedEncountersForPatientSince: vi.fn() }));
vi.mock("../src/modules/15-discipline-care-plans/seams/index", () => ({
  getSignedEncountersReader: () => reader,
}));

import { tallyStaffPatientCareMinutes } from "../src/modules/15-discipline-care-plans/consumers/patient-care-hours";
import { computeVolunteerHourRatio } from "../src/modules/15-discipline-care-plans/volunteer/hours";
import {
  denominatorFromTally,
  tallyPatientCareMinutes,
} from "../src/modules/15-discipline-care-plans/volunteer/patient-care-hours";

const digest = (over: Partial<SignedEncounterDigest>): SignedEncounterDigest =>
  ({
    encounterId: "e",
    encounterType: "routine_visit",
    discipline: "rn",
    serviceDate: "2026-03-10",
    durationMinutes: 60,
    ...over,
  }) as unknown as SignedEncounterDigest;

describe("tallyPatientCareMinutes", () => {
  it("sums RN, LPN, aide, MSW and chaplain minutes served in the fiscal year", () => {
    const tally = tallyPatientCareMinutes(
      [
        digest({ discipline: "rn", durationMinutes: 60 }),
        digest({ discipline: "lpn", durationMinutes: 30 }),
        digest({ discipline: "chha", encounterType: "chha_visit", durationMinutes: 45 }),
        digest({ discipline: "msw", encounterType: "msw_followup", durationMinutes: 20 }),
        digest({ discipline: "chaplain", encounterType: "chaplain_visit", durationMinutes: 15 }),
      ],
      2026,
    );
    expect(tally).toEqual({ minutes: 170, resolvedCount: 5, unresolvedCount: 0 });
  });

  it("excludes volunteer, physician/NP and bereavement contacts", () => {
    const tally = tallyPatientCareMinutes(
      [
        digest({ discipline: "volunteer", encounterType: "volunteer_visit" }),
        digest({ discipline: "md", encounterType: "face_to_face" }),
        digest({ discipline: "np", encounterType: "face_to_face" }),
        digest({ discipline: "msw", encounterType: "bereavement_contact" }),
      ],
      2026,
    );
    expect(tally).toEqual({ minutes: 0, resolvedCount: 0, unresolvedCount: 0 });
  });

  it("excludes and counts null durations instead of treating them as zero", () => {
    const tally = tallyPatientCareMinutes(
      [digest({ durationMinutes: 40 }), digest({ durationMinutes: null })],
      2026,
    );
    expect(tally).toEqual({ minutes: 40, resolvedCount: 1, unresolvedCount: 1 });
  });

  it("buckets by service date, not by signature", () => {
    const tally = tallyPatientCareMinutes(
      [digest({ serviceDate: "2025-12-31" }), digest({ serviceDate: "2026-01-01" })],
      2026,
    );
    expect(tally.minutes).toBe(60);
  });
});

describe("denominatorFromTally", () => {
  it("is null (unavailable) when no qualifying encounter has a resolved duration", () => {
    expect(denominatorFromTally({ minutes: 0, resolvedCount: 0, unresolvedCount: 3 })).toBeNull();
  });
  it("is the minutes otherwise", () => {
    expect(denominatorFromTally({ minutes: 600, resolvedCount: 2, unresolvedCount: 0 })).toBe(600);
  });
});

describe("tallyStaffPatientCareMinutes", () => {
  beforeEach(() => reader.signedEncountersForPatientSince.mockReset());

  it("rolls per-patient digests up through the org-explicit seam and yields a real ratio", async () => {
    reader.signedEncountersForPatientSince.mockImplementation(async (_org: string, p: string) =>
      p === "p1"
        ? [digest({ durationMinutes: 600 }), digest({ durationMinutes: null })]
        : [digest({ discipline: "chha", durationMinutes: 400 })],
    );
    const tally = await tallyStaffPatientCareMinutes({
      organizationId: "org",
      patientIds: ["p1" as PatientId, "p2" as PatientId],
      fiscalYear: 2026,
    });
    expect(reader.signedEncountersForPatientSince).toHaveBeenCalledWith(
      "org",
      "p1",
      "2026-01-01T00:00:00.000Z",
    );
    expect(tally).toEqual({ minutes: 1000, resolvedCount: 2, unresolvedCount: 1 });

    const ratio = computeVolunteerHourRatio({
      providerEntityId: "pe" as never,
      fiscalYear: 2026 as never,
      volunteerHourMinutes: 50,
      staffPatientCareMinutes: denominatorFromTally(tally),
    });
    expect(ratio.ratio).toBeCloseTo(0.05);
    expect(ratio.status).not.toBe("unavailable");
  });

  it("leaves the ratio unavailable when there are no encounters", async () => {
    reader.signedEncountersForPatientSince.mockResolvedValue([]);
    const tally = await tallyStaffPatientCareMinutes({
      organizationId: "org",
      patientIds: ["p1" as PatientId],
      fiscalYear: 2026,
    });
    expect(denominatorFromTally(tally)).toBeNull();
  });
});

describe("computeVolunteerHourRatio — persisted denominator (migration 0347)", () => {
  const base = {
    providerEntityId: "pe" as never,
    fiscalYear: 2026 as never,
    volunteerHourMinutes: 50,
  };
  it("is unavailable with a never-computed reason when the aggregator has not persisted it", () => {
    const r = computeVolunteerHourRatio({
      ...base,
      staffPatientCareMinutes: null,
      denominatorComputedAt: null,
    });
    expect(r.status).toBe("unavailable");
    expect(r.reason).toContain("not been computed");
  });
  it("keeps the no-resolved-duration reason when computed but nothing resolved", () => {
    const r = computeVolunteerHourRatio({
      ...base,
      staffPatientCareMinutes: null,
      denominatorComputedAt: "2026-10-04T03:00:00.000Z",
    });
    expect(r.reason).toContain("no signed staff patient-care visit");
  });
  it("serves a fresh value without a reason", () => {
    const r = computeVolunteerHourRatio({
      ...base,
      staffPatientCareMinutes: 1000,
      denominatorComputedAt: "2026-10-04T03:00:00.000Z",
      now: "2026-10-05T03:00:00.000Z",
    });
    expect(r.ratio).toBeCloseTo(0.05);
    expect(r.reason).toBeUndefined();
  });
  it("serves a value older than 48h but marks it stale", () => {
    const r = computeVolunteerHourRatio({
      ...base,
      staffPatientCareMinutes: 1000,
      denominatorComputedAt: "2026-10-01T03:00:00.000Z",
      now: "2026-10-05T03:00:00.000Z",
    });
    expect(r.ratio).toBeCloseTo(0.05);
    expect(r.status).not.toBe("unavailable");
    expect(r.reason).toContain("stale");
  });
});
