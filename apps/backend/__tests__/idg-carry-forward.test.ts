// apps/backend/__tests__/idg-carry-forward.test.ts — M14 §2.7 / D8 / §7.6 `idg.carry-forward`
// (`compute-carry-forward`). The PURE selection + idempotency-filter logic (target meeting per location,
// which (item, meeting) carries are still to be made) and the queue catalog. The DB idempotency (unique
// index + ON CONFLICT + increment-only-on-insert) is proven live in `m14-packet-build.live.test.ts`.
import { planCarryForward } from "@wardenx/idg";
import { describe, expect, it } from "vitest";
import {
  CARRY_FORWARD_LOOKAHEAD_MS,
  M14_JOB_SCHEDULES,
  M14_QUEUES,
  M14_QUEUE_PARAMS,
  type OverdueActionItem,
  pickTargetMeetings,
  planCarryForwards,
} from "../src/modules/14-idg/index";

const NOW = new Date("2026-06-20T12:00:00.000Z");
const H = 3_600_000;
const at = (hours: number): Date => new Date(NOW.getTime() + hours * H);

const meeting = (id: string, loc: string, startH: number, status = "scheduled") => ({
  meetingId: id,
  locationId: loc,
  scheduledStart: at(startH),
  coordinatorMembershipId: "coord",
  status,
});

const item = (over: Partial<OverdueActionItem>): OverdueActionItem => ({
  id: "ai-1",
  patientId: "pat-1",
  locationId: "loc-1",
  originMeetingId: "m-old",
  originMeetingStart: at(-24 * 14),
  dueDate: at(-24 * 7),
  count: 0,
  ...over,
});

describe("queue catalog", () => {
  it("declares idg.carry-forward hourly at :30 (before the :00 packet build) with the §4.9.1 params", () => {
    expect(M14_QUEUES.carryForward).toBe("idg.carry-forward");
    expect(M14_JOB_SCHEDULES.carryForward).toBe("30 * * * *");
    expect(M14_QUEUE_PARAMS.carryForward.priority).toBe(6);
    expect(M14_QUEUE_PARAMS.carryForward.attempts).toBe(3);
    expect(M14_QUEUE_PARAMS.carryForward.backoff).toBe("exponential 20s");
    expect(M14_QUEUE_PARAMS.carryForward.concurrency).toBe(5);
    // wider than the packet builder's 24h so the carry always precedes the build
    expect(CARRY_FORWARD_LOOKAHEAD_MS).toBeGreaterThan(24 * H);
  });
});

describe("pickTargetMeetings", () => {
  it("picks the EARLIEST eligible upcoming meeting per location", () => {
    const t = pickTargetMeetings(
      [
        meeting("late", "loc-1", 30),
        meeting("early", "loc-1", 10, "packets_ready"),
        meeting("other-loc", "loc-2", 20, "packets_building"),
      ],
      NOW,
    );
    expect(t.get("loc-1")?.meetingId).toBe("early");
    expect(t.get("loc-2")?.meetingId).toBe("other-loc");
  });

  it("ignores live/adjourned/cancelled/rescheduled, past, and beyond-lookahead meetings", () => {
    const t = pickTargetMeetings(
      [
        meeting("live", "loc-1", 1, "live"),
        meeting("adj", "loc-1", 2, "adjourned"),
        meeting("cxl", "loc-1", 3, "cancelled"),
        meeting("rsc", "loc-1", 4, "rescheduled"),
        meeting("past", "loc-1", -1),
        meeting("far", "loc-1", 24 * 14),
      ],
      NOW,
    );
    expect(t.size).toBe(0);
  });
});

describe("planCarryForwards", () => {
  const targets = pickTargetMeetings([meeting("m-next", "loc-1", 20)], NOW);

  it("plans one carry per overdue item onto its location's target meeting, oldest due first", () => {
    const plans = planCarryForwards(
      [item({ id: "b", dueDate: at(-24) }), item({ id: "a", dueDate: at(-72) })],
      targets,
      new Set(),
      NOW,
    );
    expect(plans.map((p) => p.item.id)).toEqual(["a", "b"]);
    expect(plans.every((p) => p.target.meetingId === "m-next")).toBe(true);
  });

  it("is idempotent: an (item, meeting) pair already carried is not planned again", () => {
    const already = new Set(["ai-1:m-next"]);
    expect(planCarryForwards([item({})], targets, already, NOW)).toEqual([]);
  });

  it("skips items with no target at their location, not yet due, or raised at the target itself", () => {
    expect(planCarryForwards([item({ locationId: "loc-9" })], targets, new Set(), NOW)).toEqual([]);
    expect(planCarryForwards([item({ dueDate: at(1) })], targets, new Set(), NOW)).toEqual([]);
    expect(
      planCarryForwards([item({ originMeetingId: "m-next" })], targets, new Set(), NOW),
    ).toEqual([]);
    // an origin meeting that does not start BEFORE the target can never be "carried forward" into it
    expect(
      planCarryForwards([item({ originMeetingStart: at(21) })], targets, new Set(), NOW),
    ).toEqual([]);
  });
});

describe("planCarryForward (packages/idg) — the count / compliance threshold the cron reuses", () => {
  it("count 0→1, 1→2 are not alerts; 2→3 and beyond are compliance alerts", () => {
    const of = (prior: number) =>
      planCarryForward({ priorCarryForwardCount: prior, isOpenAndOverdue: true });
    expect(of(0)).toMatchObject({ newCarryForwardCount: 1, isComplianceAlert: false });
    expect(of(1)).toMatchObject({ newCarryForwardCount: 2, isComplianceAlert: false });
    expect(of(2)).toMatchObject({ newCarryForwardCount: 3, isComplianceAlert: true });
    expect(of(3)).toMatchObject({ newCarryForwardCount: 4, isComplianceAlert: true });
  });
});
