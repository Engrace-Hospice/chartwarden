// apps/backend/__tests__/care-plan-outbox-jobs.test.ts — M7-T07 (§2.4 outbox contract + §7.1/§7.2 gate
// scans + §4.6 job catalog). Locks the full `m7.*` event catalog (naming/ownership/consumers, the same
// invariants arch:gaps enforces) against M7_EVENT_NAMES, the org-tz due-date clock (gate-clock), and the
// two pure gate scans for emission + idempotency.
import { Value } from "@sinclair/typebox/value";
import { M7_EVENT_NAMES } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  type CarePlanGateSnapshot,
  DEFAULT_ORG_TIME_ZONE,
  M7_DLQ,
  M7_JOB_SCHEDULES,
  M7_OUTBOX_EVENTS,
  M7_QUEUES,
  M7_QUEUE_PARAMS,
  computeInitialDueAt,
  computeNextReviewDueAt,
  gateScanIdempotencyKey,
  idgApplyIdempotencyKey,
  planInitialGateScan,
  planReviewGateScan,
  summaryJobId,
} from "../src/modules/07-care-plan/index";

describe("M7 outbox event contract (§2.4)", () => {
  it("publishes exactly the §2.4 taxonomy (M7_EVENT_NAMES), no more, no less", () => {
    const published = M7_OUTBOX_EVENTS.map((e) => e.eventName).sort();
    expect(published).toEqual([...M7_EVENT_NAMES].sort());
  });

  it("every event is owned by m7 and namespaced under its own prefix", () => {
    for (const e of M7_OUTBOX_EVENTS) {
      expect(e.moduleOwner).toBe("m7");
      expect(e.eventName.startsWith("m7.")).toBe(true);
      expect(e.eventName).toMatch(/^m\d+\.[a-z0-9_]+\.[a-z0-9_.]+$/);
      expect(e.description.length).toBeGreaterThan(0);
    }
  });

  it("only `review_overdue` is non-outbox-only (§4.4 also pushes it over Socket.IO)", () => {
    for (const e of M7_OUTBOX_EVENTS) {
      expect(e.isOutboxOnly).toBe(e.eventName !== "m7.care_plan.review_overdue");
    }
  });

  it("declares only real module-id consumers in `mN` form", () => {
    for (const e of M7_OUTBOX_EVENTS) {
      for (const c of e.declaredConsumers) expect(c).toMatch(/^m\d+$/);
    }
  });

  it("has no duplicate event names (catalog is collision-free)", () => {
    const names = M7_OUTBOX_EVENTS.map((e) => e.eventName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("version_signed fans out to M14/M17/M22", () => {
    const signed = M7_OUTBOX_EVENTS.find((e) => e.eventName === "m7.care_plan.version_signed");
    expect(signed?.declaredConsumers).toEqual(expect.arrayContaining(["m14", "m17", "m22"]));
    // M33's reporting intake is a PULL over `report_mv.*`, not a subscription — it moved to the field
    // that says so, which is what stopped this event deferring on every emit (#103).
    expect(signed?.seamConsumers).toContain("m33");
    // F-140 (#248) — m8 dropped: M8's own spec is decisive its encounter-authoring gate reads M7's
    // `CarePlanReader` seam fresh at sign time, never a cached outbox push.
    expect(signed?.declaredConsumers).not.toContain("m8");
  });

  it("validates a representative payload and rejects one missing a required key", () => {
    const overdue = M7_OUTBOX_EVENTS.find((e) => e.eventName === "m7.care_plan.review_overdue")!;
    expect(
      Value.Check(overdue.payloadSchema, {
        planId: "p1",
        patientId: "pt1",
        dueAt: "2026-01-01T00:00:00.000Z",
        overdueAt: "2026-01-16T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(Value.Check(overdue.payloadSchema, { planId: "p1" })).toBe(false);
  });
});

describe("M7 job catalog (§4.6)", () => {
  it("declares the three §4.6 queues and the daily gates cron", () => {
    expect(M7_QUEUES.gates).toBe("care-plan.gates");
    expect(M7_QUEUES.idg).toBe("care-plan.idg");
    expect(M7_QUEUES.snapshot).toBe("care-plan.snapshot");
    expect(M7_JOB_SCHEDULES.gates).toBe("0 6 * * *");
  });

  it("keeps exhausted jobs for DLQ promotion on every queue (OPS-035)", () => {
    for (const params of Object.values(M7_QUEUE_PARAMS)) {
      expect(params.removeOnFail).toBe(false);
    }
    expect(M7_QUEUE_PARAMS.gates.dlq).toBe(M7_DLQ.gates);
    expect(M7_QUEUE_PARAMS.idg.dlq).toBe(M7_DLQ.idg);
    expect(M7_QUEUE_PARAMS.snapshot.dlq).toBe(M7_DLQ.snapshot);
  });

  it("builds the §4.6 idempotency keys", () => {
    expect(gateScanIdempotencyKey({ date: "2026-06-21", planId: "p1" })).toBe(
      "care-plan.gates.scanned:2026-06-21:p1",
    );
    expect(idgApplyIdempotencyKey("d1")).toBe("idg:apply:d1");
    expect(summaryJobId({ planId: "p1", versionId: "v2" })).toBe("summary:p1:v2");
  });
});

describe("gate-clock due-date computation (§7.1/§7.2)", () => {
  // America/Los_Angeles is UTC−7 in June (PDT) → 23:59:59.999 local = 06:59:59.999Z next day.
  it("computes initial_due_at as activation day + 5 calendar days, end-of-day org-tz (§7.1)", () => {
    expect(computeInitialDueAt("2026-06-01T15:00:00.000Z", DEFAULT_ORG_TIME_ZONE)).toBe(
      "2026-06-07T06:59:59.999Z",
    );
  });

  it("computes next_review_due_at as signed day + 15 calendar days, end-of-day org-tz (§7.2)", () => {
    expect(computeNextReviewDueAt("2026-06-01T15:00:00.000Z", DEFAULT_ORG_TIME_ZONE)).toBe(
      "2026-06-17T06:59:59.999Z",
    );
  });

  it("counts calendar days regardless of the time of day of activation", () => {
    const early = computeInitialDueAt("2026-06-01T08:01:00.000Z", DEFAULT_ORG_TIME_ZONE);
    const late = computeInitialDueAt("2026-06-01T15:59:00.000Z", DEFAULT_ORG_TIME_ZONE);
    expect(early).toBe(late);
  });
});

function snap(over: Partial<CarePlanGateSnapshot>): CarePlanGateSnapshot {
  return {
    planId: "p1",
    patientId: "pt1",
    admissionActivatedAt: "2026-06-01T15:00:00.000Z",
    hasSignedInitialVersion: false,
    initialDueAt: "2026-06-07T06:59:59.999Z",
    nextReviewDueAt: null,
    initialWarningEmitted: false,
    reviewDueEmitted: false,
    reviewOverdueEmitted: false,
    ...over,
  };
}

describe("5day-warning gate scan (§7.1)", () => {
  it("emits initial_overdue only inside the 2-day lead and only for unsigned plans", () => {
    const plan = planInitialGateScan(
      [
        snap({ planId: "p-far", initialDueAt: "2026-07-01T06:59:59.999Z" }), // outside lead
        snap({ planId: "p-due" }), // day 3 → within 2-day lead of day-5 due
        snap({ planId: "p-signed", hasSignedInitialVersion: true }),
      ],
      "2026-06-05T12:00:00.000Z",
    );
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]?.eventName).toBe("m7.care_plan.initial_overdue");
    expect(plan.events[0]?.payload).toMatchObject({ planId: "p-due", patientId: "pt1" });
    expect(plan.markedPlanIds).toEqual(["p-due"]);
  });

  it("is idempotent — a plan already warned emits nothing", () => {
    const plan = planInitialGateScan(
      [snap({ initialWarningEmitted: true })],
      "2026-06-05T12:00:00.000Z",
    );
    expect(plan.events).toHaveLength(0);
  });
});

describe("15day-overdue gate scan (§7.2)", () => {
  const signed = (over: Partial<CarePlanGateSnapshot>): CarePlanGateSnapshot =>
    snap({ hasSignedInitialVersion: true, nextReviewDueAt: "2026-06-17T06:59:59.999Z", ...over });

  it("fires review_due inside the T+13 lead, before the deadline", () => {
    const plan = planReviewGateScan([signed({})], "2026-06-15T12:00:00.000Z");
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]?.eventName).toBe("m7.care_plan.review_due");
  });

  it("opens the review_due window at the START of org-local day 13 (D3), not dueAt − 48h", () => {
    // Signed 2026-06-01 (LA) → due end of 06-16 LA. Day 13 = 06-14 LA, which starts at 06-14T07:00Z.
    expect(planReviewGateScan([signed({})], "2026-06-14T06:59:59.999Z").events).toHaveLength(0);
    const plan = planReviewGateScan([signed({})], "2026-06-14T07:00:00.000Z");
    expect(plan.events[0]?.eventName).toBe("m7.care_plan.review_due");
  });

  it("fires review_overdue once the deadline passes (supersedes the due warning)", () => {
    const plan = planReviewGateScan([signed({})], "2026-06-18T12:00:00.000Z");
    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]?.eventName).toBe("m7.care_plan.review_overdue");
    expect(plan.events[0]?.payload).toMatchObject({
      planId: "p1",
      overdueAt: "2026-06-18T12:00:00.000Z",
    });
  });

  it("is idempotent on each marker and skips plans without a signed initial version", () => {
    expect(
      planReviewGateScan([signed({ reviewDueEmitted: true })], "2026-06-15T12:00:00.000Z").events,
    ).toHaveLength(0);
    expect(
      planReviewGateScan([signed({ reviewOverdueEmitted: true })], "2026-06-18T12:00:00.000Z")
        .events,
    ).toHaveLength(0);
    expect(
      planReviewGateScan([snap({ hasSignedInitialVersion: false })], "2026-06-18T12:00:00.000Z")
        .events,
    ).toHaveLength(0);
  });
});
