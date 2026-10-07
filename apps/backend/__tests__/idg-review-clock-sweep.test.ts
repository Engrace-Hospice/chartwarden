// apps/backend/__tests__/idg-review-clock-sweep.test.ts — GAP-092 (§4.8 / M14-F01 / ADR-0018 D2). The
// pure `planReviewClockSweep` T-3/T-0/T+1 escalation scan: deterministic over an injected `now`, exactly
// three named calendar-day stages (never a repeating reminder), the never-reviewed fallback origin, and
// the queue catalog's declared cron cadence.
import { describe, expect, it } from "vitest";
import {
  M14_JOB_SCHEDULES,
  M14_QUEUES,
  REVIEW_FLOOR_DAYS,
  type ReviewClockSnapshot,
  planReviewClockSweep,
} from "../src/modules/14-idg/index";

describe("§4.8 queue catalog", () => {
  it("declares the review-clock-sweep queue and its daily cron cadence", () => {
    expect(M14_QUEUES.reviewClockSweep).toBe("idg.review-clock-sweep");
    expect(M14_JOB_SCHEDULES.reviewClockSweep).toBe("0 6 * * *");
    expect(REVIEW_FLOOR_DAYS).toBe(15);
  });
});

describe("planReviewClockSweep — M14-F01 / ADR-0018 D2 T-3/T-0/T+1 escalation", () => {
  const NOW = new Date("2026-06-20T12:00:00.000Z");
  const snap = (over: Partial<ReviewClockSnapshot>): ReviewClockSnapshot => ({
    patientId: "pat-1",
    admissionId: "adm-1",
    locationId: "loc-1",
    lastIdgReviewedAt: null,
    activatedAtIso: "2026-06-05T00:00:00.000Z", // + 15d = 2026-06-20 (T-0 from NOW)
    ...over,
  });

  it("escalates t_zero when the floor is exactly today (clinical_routine → critical tightening)", () => {
    const plan = planReviewClockSweep([snap({})], NOW);
    expect(plan).toEqual([
      {
        patientId: "pat-1",
        admissionId: "adm-1",
        locationId: "loc-1",
        lastIdgReviewedAt: null,
        floorAt: "2026-06-20T00:00:00.000Z",
        stage: "t_zero",
        severity: "critical",
      },
    ]);
  });

  it("escalates t_minus_3 when the floor is 3 calendar days out (clinical_routine)", () => {
    const plan = planReviewClockSweep(
      [snap({ activatedAtIso: "2026-06-08T00:00:00.000Z" })], // +15d = 2026-06-23
      NOW,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ stage: "t_minus_3", severity: "clinical_routine" });
  });

  it("escalates t_plus_1 when the floor lapsed exactly 1 calendar day ago (critical)", () => {
    const plan = planReviewClockSweep(
      [snap({ activatedAtIso: "2026-06-04T00:00:00.000Z" })], // +15d = 2026-06-19
      NOW,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ stage: "t_plus_1", severity: "critical" });
  });

  it("does not escalate on any other day — T-4, T-2, T-1, T+2 all produce nothing", () => {
    // cursor + 15d = the resulting floorAt; NOW is 2026-06-20.
    const cursorsForNonStageDays = [
      "2026-06-09T00:00:00.000Z", // floor 2026-06-24 → T-4
      "2026-06-07T00:00:00.000Z", // floor 2026-06-22 → T-2
      "2026-06-06T00:00:00.000Z", // floor 2026-06-21 → T-1
      "2026-06-03T00:00:00.000Z", // floor 2026-06-18 → T+2
    ];
    for (const cursor of cursorsForNonStageDays) {
      const plan = planReviewClockSweep([snap({ activatedAtIso: cursor })], NOW);
      expect(plan).toEqual([]);
    }
  });

  it("uses lastIdgReviewedAt as the floor origin when present, ignoring the earlier since-cursor fallback", () => {
    const plan = planReviewClockSweep(
      [
        snap({
          lastIdgReviewedAt: "2026-06-05T00:00:00.000Z", // +15d = 2026-06-20 → t_zero
          activatedAtIso: "2026-01-01T00:00:00.000Z", // would be far past T+1 if used instead
        }),
      ],
      NOW,
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ stage: "t_zero", floorAt: "2026-06-20T00:00:00.000Z" });
  });

  it("evaluates every patient independently in one tick", () => {
    const plan = planReviewClockSweep(
      [
        snap({ patientId: "pat-a", activatedAtIso: "2026-06-05T00:00:00.000Z" }), // t_zero
        snap({ patientId: "pat-b", activatedAtIso: "2026-06-08T00:00:00.000Z" }), // t_minus_3
        snap({ patientId: "pat-c", activatedAtIso: "2026-06-01T00:00:00.000Z" }), // no stage
      ],
      NOW,
    );
    expect(plan.map((e) => e.patientId).sort()).toEqual(["pat-a", "pat-b"]);
  });

  it("returns nothing for an empty snapshot set", () => {
    expect(planReviewClockSweep([], NOW)).toEqual([]);
  });
});
