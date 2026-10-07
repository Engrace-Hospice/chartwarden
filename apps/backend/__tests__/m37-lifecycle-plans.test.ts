// apps/backend/__tests__/m37-lifecycle-plans.test.ts — batch 11 (GAP-105 follow-up). The decisions behind M37's
// five lifecycle crons (reservation expiry, equipment inspection, nursing note, transfer completion, post-close
// settlement), the IRC resumption carry-over in the catch-up planner, the catalog schemas the rn-coverage
// watchdog's payloads must satisfy, and M36's alert plans for the seven newly bound events. No Redis, no
// database; the end-to-end write path is `m37-lifecycle-crons.live.test.ts`.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { planIpuAlert } from "../src/modules/36-messaging/outbox-consumers/ipu-alerts";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/events-by-m37";
import {
  M37_LIFECYCLE_QUEUES,
  M37_LIFECYCLE_SCHEDULES,
  NURSING_NOTE_GRACE_MS,
  POST_CLOSE_SETTLEMENT_DAYS,
  inspectionAlertKind,
  nursingNoteCandidates,
  planEquipmentInspection,
  planNursingNoteOverdue,
  planPostCloseSettlement,
  planReservationExpiry,
  planTransferCompletion,
} from "../src/modules/37-ipu/jobs/lifecycle-plans";
import { M37_LIFECYCLE_JOBS } from "../src/modules/37-ipu/jobs/lifecycle-workers";
import { planIrcCatchUp } from "../src/modules/37-ipu/jobs/watchdog-plans";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

describe("batch 11 — queue catalog", () => {
  it("names carry no ':', every job has schedule/params/runner, and every queue is distinct", () => {
    const queues = M37_LIFECYCLE_JOBS.map((j) => j.queue);
    expect(new Set(queues).size).toBe(queues.length);
    expect(queues.sort()).toEqual(Object.values(M37_LIFECYCLE_QUEUES).sort());
    for (const job of M37_LIFECYCLE_JOBS) {
      expect(job.queue).not.toContain(":");
      expect(job.schedule.split(" ")).toHaveLength(5);
      expect(job.params.attempts).toBeGreaterThan(0);
      expect(typeof job.run).toBe("function");
    }
    expect(M37_LIFECYCLE_SCHEDULES.reservationExpiryWatchdog).toBe("*/15 * * * *");
  });
});

describe("planReservationExpiry (§2.12)", () => {
  const bed = (reservedAgoMin: number, admissionState: string | null) => ({
    bedId: `b-${reservedAgoMin}-${admissionState}`,
    unitId: "u1",
    reservedAtMs: NOW - reservedAgoMin * MIN,
    assignment: admissionState
      ? {
          assignmentId: "as1",
          ipuAdmissionId: "adm1",
          admissionKind: "gip" as const,
          admissionState: admissionState as never,
        }
      : null,
  });

  it("releases a hold older than 4 hours whose admission still waits in bed_assigned", () => {
    const plans = planReservationExpiry([bed(241, "bed_assigned")], NOW);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      assignmentId: "as1",
      ipuAdmissionId: "adm1",
      admissionKind: "gip",
    });
  });

  it("leaves a hold inside the 4 hours alone", () => {
    expect(planReservationExpiry([bed(239, "bed_assigned")], NOW)).toEqual([]);
  });

  it("releases an orphan hold (no live assignment) without touching any admission", () => {
    const [plan] = planReservationExpiry([bed(300, null)], NOW);
    expect(plan).toMatchObject({ assignmentId: null, ipuAdmissionId: null });
  });

  it("never frees a bed whose assignment belongs to an admission in any other state", () => {
    expect(planReservationExpiry([bed(900, "active"), bed(900, "transferring")], NOW)).toEqual([]);
  });
});

describe("planEquipmentInspection (§2.9)", () => {
  const today = "2026-10-05";
  const dueIn = (days: number) => new Date(NOW + days * DAY).toISOString().slice(0, 10);
  const plan = (days: number) =>
    planEquipmentInspection([{ equipmentId: "e1", dueDate: dueIn(days) }], today);

  it("raises inspection_due at exactly 14 / 7 / 2 / 0 days", () => {
    for (const days of [14, 7, 2, 0]) {
      expect(plan(days)).toEqual([
        { kind: "due", equipmentId: "e1", dueDate: dueIn(days), daysUntilDue: days },
      ]);
    }
  });

  it("is silent on every other day before the due date", () => {
    for (const days of [30, 15, 13, 8, 6, 3, 1]) expect(plan(days)).toEqual([]);
  });

  it("raises inspection_overdue at +1 day, then silence, then weekly (+8, +15)", () => {
    expect(plan(-1)).toEqual([
      { kind: "overdue", equipmentId: "e1", dueDate: dueIn(-1), daysOverdue: 1 },
    ]);
    for (const days of [-2, -3, -7]) expect(plan(days)).toEqual([]);
    expect(plan(-8)[0]).toMatchObject({ kind: "overdue", daysOverdue: 8 });
    expect(plan(-15)[0]).toMatchObject({ kind: "overdue", daysOverdue: 15 });
  });

  it("agrees with the SQL prefilter's rule (inspectionAlertKind is the single definition)", () => {
    expect(inspectionAlertKind(14)).toBe("due");
    expect(inspectionAlertKind(-1)).toBe("overdue");
    expect(inspectionAlertKind(-2)).toBeNull();
    expect(inspectionAlertKind(5)).toBeNull();
  });
});

describe("nursing-note shift watchdog (§5.14)", () => {
  const shiftEnd = NOW - 40 * MIN; // grace ended 10 minutes ago
  const shift = (over: Partial<{ rn: string[]; endMs: number }> = {}) => ({
    shiftId: "s1",
    unitId: "u1",
    shiftStartMs: shiftEnd - 12 * HOUR,
    shiftEndMs: over.endMs ?? shiftEnd,
    rnMembershipIds: over.rn ?? ["alice"],
  });
  const adm = (id: string, activatedAgoH: number, unitId = "u1") => ({
    ipuAdmissionId: id,
    patientId: `p-${id}`,
    unitId,
    activatedAtMs: NOW - activatedAgoH * HOUR,
  });

  it("only considers a shift whose grace ended within the last nag window", () => {
    const early = shift({ endMs: NOW - 10 * MIN }); // grace not over yet
    const late = shift({ endMs: NOW - 5 * HOUR }); // window long gone
    expect(nursingNoteCandidates([early, late], [adm("a1", 100)], NOW)).toEqual([]);
    expect(nursingNoteCandidates([shift()], [adm("a1", 100)], NOW)).toHaveLength(1);
  });

  it("skips a shift with no RN (that is rn_uncovered's alert) and a patient admitted mid-shift or elsewhere", () => {
    expect(nursingNoteCandidates([shift({ rn: [] })], [adm("a1", 100)], NOW)).toEqual([]);
    const cands = nursingNoteCandidates(
      [shift()],
      [adm("a1", 100), adm("mid", 1), adm("other", 100, "u2")],
      NOW,
    );
    expect(cands.map((c) => c.ipuAdmissionId)).toEqual(["a1"]);
  });

  it("flags a patient with no note by an assigned RN inside [start, end+30min], not one who has it", () => {
    const cands = nursingNoteCandidates([shift()], [adm("a1", 100), adm("a2", 100)], NOW);
    const c1 = cands[0]?.shiftStartMs as number;
    const notes = new Map([
      ["p-a1", [{ signedAtMs: c1 + HOUR, signedByMembershipId: "alice" }]],
      // a2: signed by someone NOT assigned to the shift, and one signed after the grace window closed
      [
        "p-a2",
        [
          { signedAtMs: c1 + HOUR, signedByMembershipId: "bob" },
          { signedAtMs: shiftEnd + NURSING_NOTE_GRACE_MS + MIN, signedByMembershipId: "alice" },
        ],
      ],
    ]);
    expect(planNursingNoteOverdue(cands, notes).map((c) => c.ipuAdmissionId)).toEqual(["a2"]);
  });

  it("accepts a note signed inside the 30-minute grace after the shift ended", () => {
    const cands = nursingNoteCandidates([shift()], [adm("a1", 100)], NOW);
    const notes = new Map([
      ["p-a1", [{ signedAtMs: shiftEnd + 20 * MIN, signedByMembershipId: "alice" }]],
    ]);
    expect(planNursingNoteOverdue(cands, notes)).toEqual([]);
  });
});

describe("planTransferCompletion (§2.2)", () => {
  it("does nothing inside the first hour, raises once past it, and re-raises every 6 hours", () => {
    const t = (agoMin: number) => [{ ipuAdmissionId: "a1", initiatedAtMs: NOW - agoMin * MIN }];
    expect(planTransferCompletion(t(50), NOW)).toEqual([]);
    expect(planTransferCompletion(t(70), NOW)[0]).toMatchObject({ cycle: 0 });
    // 1h + 6h + 10min after initiation: second cycle
    expect(planTransferCompletion(t(60 + 360 + 10), NOW)[0]).toMatchObject({ cycle: 1 });
    // mid-cycle (3h past the deadline): quiet — the cycle's window has closed
    expect(planTransferCompletion(t(60 + 180), NOW)).toEqual([]);
  });
});

describe("planPostCloseSettlement (§2.2)", () => {
  const fact = (over: Record<string, unknown> = {}) => ({
    ipuAdmissionId: "a1",
    kind: "gip" as const,
    state: "discharged" as const,
    settledAtMs: NOW - (POST_CLOSE_SETTLEMENT_DAYS + 1) * DAY,
    openIrcEpisodes: 0,
    activeRestraints: 0,
    bodyReleaseOpen: false,
    ...over,
  });

  it("closes an admission past T+7 with nothing open", () => {
    expect(planPostCloseSettlement([fact()], NOW)).toHaveLength(1);
  });

  it("waits for T+7, an open IRC episode, an active restraint, and a death's open body release", () => {
    expect(planPostCloseSettlement([fact({ settledAtMs: NOW - 6 * DAY })], NOW)).toEqual([]);
    expect(planPostCloseSettlement([fact({ openIrcEpisodes: 1 })], NOW)).toEqual([]);
    expect(planPostCloseSettlement([fact({ activeRestraints: 1 })], NOW)).toEqual([]);
    expect(
      planPostCloseSettlement([fact({ state: "deceased", bodyReleaseOpen: true })], NOW),
    ).toEqual([]);
  });
});

describe("IRC resumption carry-over (§2.5) in the catch-up planner", () => {
  const episode = (
    carried: number,
    count: number,
    state: "active" | "approaching_cap" | "breached",
  ) => ({
    consecutiveDayCount: count,
    state,
    overrideExtensionDays: 0,
    startedLocalDate: "2026-10-05",
    carriedOverDays: carried,
  });

  it("is a no-op on the start date of a resumed episode (the open handler already set the count)", () => {
    expect(planIrcCatchUp(episode(3, 4, "approaching_cap"), "2026-10-05")).toBeNull();
  });

  it("counts the inherited days: a 3-day carry-over breaches on the next local day, not on day 5", () => {
    const plan = planIrcCatchUp(episode(3, 4, "approaching_cap"), "2026-10-06");
    expect(plan?.consecutiveDayCount).toBe(5);
    expect(plan?.state).toBe("breached");
    expect(plan?.events.map((e) => e.event)).toEqual(["m37.irc_episode.cap_breached"]);
  });

  it("is unchanged for a fresh episode (carriedOverDays 0 or absent)", () => {
    const fresh = { ...episode(0, 1, "active"), carriedOverDays: undefined };
    expect(planIrcCatchUp(fresh, "2026-10-06")?.consecutiveDayCount).toBe(2);
  });
});

describe("event catalog schemas match what the producers publish", () => {
  const schema = (name: string) => {
    const entry = M37_OUTBOX_EVENTS.find((e) => e.eventName === name);
    if (!entry) throw new Error(`no catalog entry ${name}`);
    return entry.payloadSchema;
  };

  it("rn_uncovered / coverage_gap_projected accept the rn-coverage-watchdog's real payloads", () => {
    // These two schemas used to name different fields (`hourAt`, `firstGapAt`/`uncoveredCount`) from what
    // the watchdog publishes, so a catalog-validating publisher would have refused every coverage alert.
    expect(
      Value.Check(schema("m37.shift.rn_uncovered"), {
        unitId: "u1",
        organizationId: "o1",
        hourStartAt: "2026-10-05T12:00:00.000Z",
        coveredHours: 100,
        totalHours: 216,
      }),
    ).toBe(true);
    expect(
      Value.Check(schema("m37.shift.coverage_gap_projected"), {
        unitId: "u1",
        organizationId: "o1",
        gapStartsAt: "2026-10-05T14:00:00.000Z",
        alertHorizonHours: 8,
      }),
    ).toBe(true);
  });

  it("the new events validate their own payloads", () => {
    expect(
      Value.Check(schema("m37.bed.reservation_expired"), {
        bedId: "b",
        organizationId: "o",
        unitId: "u",
        reservedAt: "2026-10-05T00:00:00Z",
      }),
    ).toBe(true);
    expect(
      Value.Check(schema("m37.ipu_admission.transfer_unconfirmed"), {
        ipuAdmissionId: "a",
        organizationId: "o",
        initiatedAt: "2026-10-05T00:00:00Z",
        reminderCycle: 0,
      }),
    ).toBe(true);
  });
});

describe("M36 alert plans for the batch 11 events", () => {
  const ev = (eventType: string, payload: Record<string, unknown>) =>
    ({ id: "e1", organizationId: "org-1", eventType, payload }) as never;

  it("rn_uncovered is critical and keyed per unit per uncovered hour (the 5-minute tick dedupes)", () => {
    const p = (hour: string) =>
      planIpuAlert(ev("m37.shift.rn_uncovered", { unitId: "u1", hourStartAt: hour }));
    expect(p("h1").severity).toBe("critical");
    expect(p("h1").correlationKey).toBe(p("h1").correlationKey);
    expect(p("h1").correlationKey).not.toBe(p("h2").correlationKey);
  });

  it("coverage_gap_projected is a warn keyed by unit + the gap's start", () => {
    const plan = planIpuAlert(
      ev("m37.shift.coverage_gap_projected", {
        unitId: "u1",
        gapStartsAt: "g1",
        alertHorizonHours: 8,
      }),
    );
    expect(plan.severity).toBe("warn");
    expect(plan.correlationKey).toBe("u1:g1");
  });

  it("equipment alerts key by equipment + due date + threshold; overdue is critical", () => {
    const due = planIpuAlert(
      ev("m37.equipment.inspection_due", {
        equipmentId: "e1",
        dueDate: "2026-10-19",
        daysUntilDue: 14,
      }),
    );
    const overdue = planIpuAlert(
      ev("m37.equipment.inspection_overdue", {
        equipmentId: "e1",
        dueDate: "2026-10-04",
        daysOverdue: 1,
      }),
    );
    expect(due.severity).toBe("warn");
    expect(due.correlationKey).toBe("e1:2026-10-19:14");
    expect(overdue.severity).toBe("critical");
    expect(overdue.correlationKey).toBe("e1:2026-10-04:1");
  });

  it("nursing-note, reservation and transfer alerts are warns with stable keys", () => {
    expect(
      planIpuAlert(ev("m37.nursing_note.shift_overdue", { ipuAdmissionId: "a1", shiftId: "s1" }))
        .correlationKey,
    ).toBe("s1:a1");
    expect(
      planIpuAlert(ev("m37.bed.reservation_expired", { bedId: "b1", reservedAt: "t" }))
        .correlationKey,
    ).toBe("b1:t");
    const k = (cycle: number) =>
      planIpuAlert(
        ev("m37.ipu_admission.transfer_unconfirmed", {
          ipuAdmissionId: "a1",
          reminderCycle: cycle,
        }),
      ).correlationKey;
    expect(k(0)).not.toBe(k(1));
  });

  it("throws on a malformed payload so the relay dead-letters it", () => {
    expect(() => planIpuAlert(ev("m37.shift.rn_uncovered", { unitId: "u1" }))).toThrow(
      /hourStartAt/,
    );
    expect(() => planIpuAlert(ev("m37.equipment.inspection_due", { equipmentId: "e" }))).toThrow(
      /numeric/,
    );
  });
});
