// @wardenx/reporting — scheduled-report CRON-EVALUATOR + RUNNER + DELIVERY UNIT TESTS
// (M33 §2.2 / §2.5–§2.6 / §4.3 / §4.8 W-R-04 / D7).
//
// PURE port-injected handlers driven by in-memory recording fakes (the M34 `shred-worker.test.ts` template):
// a `makePorts()` factory over in-memory state + a `const calls: string[] = []` trail; assertions read the
// recorded trail. NEVER touches a DB. They prove the §1.1 scheduled-report handshake:
//   • the cron evaluator is AT-MOST-ONCE per `(schedule_id, scheduled_for)` — a redelivered tick before the
//     `next_run_at` advance persisted collapses onto the existing occurrence (the §3.4 per-leaf UNIQUE oracle);
//   • the runner drives `queued → running → rendered_pending` and emits `m33.scheduled_report.render_requested`
//     to M22 (idempotencyKey = runId), then the delivery consumer flips the occurrence `→ delivered` on the M22
//     render reply (spec D7 names it `m22.document.created`; M22 publishes `m22.document.rendered`);
//   • a fully-revoked recipient set AUTO-PAUSES the schedule (§2.5) — nothing is rendered for nobody.
import type { schema } from "@wardenx/db";
import {
  ALL_RECIPIENTS_REVOKED_REASON,
  type M22DocumentRenderedPayload,
  M33_SCHEDULED_REPORT_AGGREGATE_TYPE,
  type ScheduledDeliveryFacts,
  type ScheduledDeliveryPorts,
  type ScheduledRunPorts,
  applyScheduledDelivery,
  decideRecipientRevocationCascade,
  decideScheduledDelivery,
  evaluateDueSchedules,
  handleScheduledRun,
} from "@wardenx/reporting";
import { describe, expect, it } from "vitest";

// The run-patch shapes exactly as the PORTS declare them. Restating them inline made each double refuse
// its own port's argument: `status` is OPTIONAL on the `Pick<…>` the ports take and was pinned to a
// required `string` in the copies.
type ScheduledRunPatch = Parameters<ScheduledRunPorts["runs"]["settle"]>[2];
type ScheduledDeliveryPatch = Parameters<ScheduledDeliveryPorts["runs"]["settleDelivered"]>[2];

const ORG = "00000000-0000-0000-0000-0000000000aa";
const FIXED_NOW = new Date("2026-06-25T06:00:00.000Z");
const DUE_SLOT = new Date("2026-06-25T06:00:00.000Z");
const NEXT_FIRE = new Date("2026-06-26T06:00:00.000Z"); // a daily cadence (> 5-min min interval)

function makeSchedule(overrides: Partial<schema.ReportSchedule> = {}): schema.ReportSchedule {
  return {
    id: "sched_1",
    organizationId: ORG,
    reportViewId: "view_1",
    ownerMembershipId: "owner_1",
    cronExpression: "0 6 * * *",
    tenantTimezone: "America/New_York",
    format: "pdf",
    recipientMembershipIds: ["rcpt_1", "rcpt_2"],
    deliveryChannel: "in_app",
    nextRunAt: DUE_SLOT,
    status: "active",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    cancelledAt: null,
    ...overrides,
  };
}

function makeRun(overrides: Partial<schema.ReportScheduleRun> = {}): schema.ReportScheduleRun {
  return {
    id: "run_1",
    scheduleId: "sched_1",
    organizationId: ORG,
    scheduledFor: DUE_SLOT,
    startedAt: null,
    finishedAt: null,
    status: "queued",
    documentId: null,
    failureReason: null,
    rowCount: null,
    ...overrides,
  };
}

// ── (1) cron evaluator — at-most-once per (schedule_id, scheduled_for) ───────────────────────────────────────

/** An enqueue port whose `report_schedule_run` is keyed `(scheduleId, scheduledFor)` — a second create for the
 *  SAME leaf returns `enqueued:false` (the §3.4 per-leaf UNIQUE the at-most-once invariant rides on). */
function makeCronPorts(schedules: readonly schema.ReportSchedule[]) {
  const calls: string[] = [];
  const occurrences = new Set<string>();
  const advanced: { scheduleId: string; nextRunAt: string }[] = [];
  return {
    calls,
    advanced,
    ports: {
      schedules: {
        listDue: async () => {
          calls.push("listDue");
          return schedules;
        },
      },
      cron: {
        nextRunAfter: () => NEXT_FIRE,
      },
      enqueue: {
        enqueueRun: async (input: { scheduleId: string; scheduledFor: Date }) => {
          const key = `${input.scheduleId}:${input.scheduledFor.toISOString()}`;
          const fresh = !occurrences.has(key);
          occurrences.add(key);
          calls.push(`enqueueRun:${key}:${fresh ? "new" : "dup"}`);
          return { enqueued: fresh, runId: fresh ? "run_1" : null };
        },
      },
      advance: {
        advanceNextRun: async (scheduleId: string, nextRunAt: Date) => {
          advanced.push({ scheduleId, nextRunAt: nextRunAt.toISOString() });
        },
      },
      now: () => FIXED_NOW,
    },
  };
}

describe("M33 §2.5 cron evaluator — at-most-once per (schedule_id, scheduled_for)", () => {
  it("a fresh due slot enqueues ONE occurrence and advances next_run_at", async () => {
    const { ports, advanced } = makeCronPorts([makeSchedule()]);
    const report = await evaluateDueSchedules(ports);
    expect(report.dispositions).toEqual([
      {
        scheduleId: "sched_1",
        outcome: "enqueued",
        scheduledFor: DUE_SLOT.toISOString(),
        nextRunAt: NEXT_FIRE.toISOString(),
      },
    ]);
    expect(advanced).toEqual([{ scheduleId: "sched_1", nextRunAt: NEXT_FIRE.toISOString() }]);
  });

  it("a REDELIVERED tick for the same (schedule_id, scheduled_for) COLLAPSES — at-most-once (§2.6)", async () => {
    // The schedule's next_run_at is still the same DUE_SLOT (the advance has not yet persisted) on the redelivery.
    const { ports } = makeCronPorts([makeSchedule()]);
    const first = await evaluateDueSchedules(ports);
    const second = await evaluateDueSchedules(ports);
    expect(first.dispositions[0]!.outcome).toBe("enqueued"); // first create wins
    expect(second.dispositions[0]!.outcome).toBe("collapsed"); // the UNIQUE collapsed the duplicate
  });

  it("a `cancelled` schedule is skipped (the belt-and-braces decide-fire guard)", async () => {
    const { ports } = makeCronPorts([makeSchedule({ status: "cancelled" })]);
    const report = await evaluateDueSchedules(ports);
    expect(report.dispositions[0]).toEqual({
      scheduleId: "sched_1",
      outcome: "skipped",
      reason: "not_active",
    });
  });
});

// ── (2) runner — render_requested → delivered on the M22 reply ───────────────────────────────────────────────

function makeRunnerPorts(
  opts: {
    schedule?: schema.ReportSchedule | null;
    run?: schema.ReportScheduleRun | null;
    entitled?: (membershipId: string) => boolean;
  } = {},
) {
  const calls: string[] = [];
  const renderRequests: unknown[] = [];
  const entitled = opts.entitled ?? (() => true);
  return {
    calls,
    renderRequests,
    ports: {
      schedules: {
        findById: async () => (opts.schedule === undefined ? makeSchedule() : opts.schedule),
      },
      runs: {
        findRun: async () => (opts.run === undefined ? makeRun() : opts.run),
        settle: async (_id: string, _f: Date, patch: ScheduledRunPatch) => {
          calls.push(`settle:${patch.status}`);
        },
      },
      recipients: {
        isRecipientEntitled: async (membershipId: string) => {
          calls.push(`entitled:${membershipId}`);
          return entitled(membershipId);
        },
      },
      snapshot: {
        build: async () => {
          calls.push("snapshot.build");
          return {
            snapshotQuery: "SELECT 1",
            viewId: "view_1",
            viewName: "Census",
            // GAP-051 — the port MATERIALIZES: the rows travel with the render request, because M22
            // has no reporting database to run `snapshotQuery` against.
            snapshot: {
              columns: [
                { key: "census_day", sourceKey: "census_day", kind: "dimension" as const },
                { key: "active", sourceKey: "active_patient_count", kind: "measure" as const },
              ],
              rows: [{ census_day: "2026-03-01", active: 12 }],
              rowCount: 1,
            },
          };
        },
      },
      outbox: {
        emitRenderRequested: async (payload: unknown) => {
          calls.push("emitRenderRequested");
          renderRequests.push(payload);
        },
        emitFailed: async () => {
          calls.push("emitFailed");
        },
      },
      pause: {
        autoPause: async (_id: string, reason: string) => {
          calls.push(`autoPause:${reason}`);
        },
      },
      audit: {
        recordRecipientLostAccess: async (_id: string, m: string) => {
          calls.push(`lostAccess:${m}`);
        },
        recordAllRecipientsRevoked: async () => {
          calls.push("allRevoked");
        },
      },
      now: () => FIXED_NOW,
    },
  };
}

const RUN_JOB = {
  scheduleId: "sched_1",
  runId: "run_1",
  organizationId: ORG,
  scheduledFor: DUE_SLOT.toISOString(),
};

describe("M33 §2.2 / W-R-04 runner — the §1.1 render handshake", () => {
  it("drives queued → running → rendered_pending and requests the M22 render (idempotencyKey = runId)", async () => {
    const { ports, calls, renderRequests } = makeRunnerPorts();
    const result = await handleScheduledRun(RUN_JOB, ports);
    expect(result).toEqual({ kind: "render_requested", recipientCount: 2 });
    // The run flips `running` BEFORE the render-request, then parks at `rendered_pending`.
    expect(calls.indexOf("settle:running")).toBeLessThan(calls.indexOf("emitRenderRequested"));
    expect(calls.indexOf("emitRenderRequested")).toBeLessThan(
      calls.indexOf("settle:rendered_pending"),
    );
    expect((renderRequests[0] as { idempotencyKey: string }).idempotencyKey).toBe("run_1");
    // GAP-051 — the request carries the RENDERABLE snapshot (M22 renders content, it does not execute
    // `snapshotQuery`), and the `aggregateType` that tells M22 which of this wire name's two producers
    // sent it — and therefore which template / document_aggregate_type applies.
    const sent = renderRequests[0] as {
      aggregateType: string;
      title: string;
      rows: unknown[];
      rowCount: number;
      columns: unknown[];
    };
    expect(sent.aggregateType).toBe("report_schedule_run");
    expect(sent.title).toBe("Census");
    expect(sent.rowCount).toBe(1);
    expect(sent.rows).toHaveLength(1);
    expect(sent.columns).toHaveLength(2);
  });

  it("is idempotent — a run already past `queued` is a no-op (§2.6)", async () => {
    const { ports, calls } = makeRunnerPorts({ run: makeRun({ status: "rendered_pending" }) });
    const result = await handleScheduledRun(RUN_JOB, ports);
    expect(result).toEqual({ kind: "idempotent_skip", status: "rendered_pending" });
    expect(calls).not.toContain("emitRenderRequested");
  });

  it("the delivery consumer flips the occurrence → delivered on the M22 render reply", async () => {
    const payload: M22DocumentRenderedPayload = {
      organizationId: ORG,
      aggregateType: M33_SCHEDULED_REPORT_AGGREGATE_TYPE,
      aggregateId: "run_1",
      documentId: "doc_1",
    };
    const facts: ScheduledDeliveryFacts = {
      runExists: true,
      scheduledFor: DUE_SLOT,
      scheduleId: "sched_1",
      alreadyDelivered: false,
      recipientCount: 2,
    };
    const action = decideScheduledDelivery(payload, facts);
    expect(action.kind).toBe("apply_delivery");

    const settled: ScheduledDeliveryPatch[] = [];
    const delivered: unknown[] = [];
    await applyScheduledDelivery(action, {
      runs: {
        settleDelivered: async (_id: string, _f: Date, patch: ScheduledDeliveryPatch) => {
          settled.push(patch);
        },
      },
      outbox: {
        emitDelivered: async (p: unknown) => {
          delivered.push(p);
        },
      },
      now: () => FIXED_NOW,
    });
    expect(settled).toEqual([{ status: "delivered", documentId: "doc_1", finishedAt: FIXED_NOW }]);
    expect(delivered).toHaveLength(1); // the §4.9 `m33.scheduled_report.delivered` fan-out fired
  });

  it("a re-delivered M22 reply never re-settles an already-delivered occurrence (idempotency, D14)", () => {
    const payload: M22DocumentRenderedPayload = {
      organizationId: ORG,
      aggregateType: M33_SCHEDULED_REPORT_AGGREGATE_TYPE,
      aggregateId: "run_1",
      documentId: "doc_1",
    };
    const action = decideScheduledDelivery(payload, {
      runExists: true,
      scheduledFor: DUE_SLOT,
      scheduleId: "sched_1",
      alreadyDelivered: true,
      recipientCount: 2,
    });
    expect(action).toEqual({ kind: "idempotent_skip" });
  });
});

// ── (3) recipient-revoked → auto-pause ───────────────────────────────────────────────────────────────────────

describe("M33 §2.5 / §4.3 recipient revocation — a fully-revoked schedule AUTO-PAUSES", () => {
  it("ZERO surviving recipients → auto-pause + fail the run (nothing rendered for nobody)", async () => {
    const { ports, calls } = makeRunnerPorts({ entitled: () => false }); // every recipient lost access
    const result = await handleScheduledRun(RUN_JOB, ports);
    expect(result).toEqual({ kind: "all_recipients_revoked" });
    expect(calls).toContain(`autoPause:${ALL_RECIPIENTS_REVOKED_REASON}`);
    expect(calls).toContain("allRevoked");
    expect(calls).toContain("settle:failed");
    // Each dropped recipient is audited (§164.528 access-loss); the render is NEVER requested.
    expect(calls).toContain("lostAccess:rcpt_1");
    expect(calls).not.toContain("emitRenderRequested");
  });

  it("the §4.3 cascade core: removing the LAST recipient flags auto-pause; an already-absent one is a no-op", () => {
    expect(decideRecipientRevocationCascade(["rcpt_1"], "rcpt_1")).toEqual({
      newRecipientMembershipIds: [],
      affected: true,
      autoPause: true,
    });
    expect(decideRecipientRevocationCascade(["rcpt_1", "rcpt_2"], "rcpt_2")).toEqual({
      newRecipientMembershipIds: ["rcpt_1"],
      affected: true,
      autoPause: false, // one survives → no pause
    });
    expect(decideRecipientRevocationCascade(["rcpt_1"], "ghost")).toEqual({
      newRecipientMembershipIds: ["rcpt_1"],
      affected: false,
      autoPause: false, // idempotent — already absent
    });
  });
});
