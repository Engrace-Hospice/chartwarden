// GAP-025 (M06): `m6.election.period_ended` must actually be published.
//   1. the shared completion helper emits the spec payload exactly once per period (status-guarded UPDATE),
//   2. the hourly auto-end cron completes periods past their end date under the org's local date, with the
//      `next_period` cause, and publishes one event each.
// No database: a recording fake tx stands in for Drizzle (the live proof is the real-publisher live suite).
import type { DbClient } from "@chartwarden/db";
import { Value } from "@sinclair/typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeActiveElectionPeriod,
  electionPeriodEndedPayload,
} from "../src/modules/06-admission/election-period-completion";
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/events-by-m6";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const ADM = "00000000-0000-4000-8000-0000000000b1";
const PERIOD = "00000000-0000-4000-8000-0000000000c1";

type Published = { eventName: string; payload: Record<string, unknown>; aggregateId: string };

function fakeTx(updateReturns: readonly { id: string }[]) {
  const sets: Record<string, unknown>[] = [];
  const tx = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return { where: () => ({ returning: async () => updateReturns }) };
      },
    }),
  } as unknown as DbClient;
  return { tx, sets };
}

function recordingOutbox() {
  const published: Published[] = [];
  return {
    published,
    outbox: {
      async publish(
        _tx: DbClient,
        input: { eventName: string; payload: Record<string, unknown>; aggregateId: string },
      ) {
        published.push(input);
      },
    },
  };
}

const NOW = new Date("2026-10-05T12:00:00.000Z");

describe("completeActiveElectionPeriod", () => {
  it("publishes m6.election.period_ended with the spec payload when the period was active", async () => {
    const { tx, sets } = fakeTx([{ id: PERIOD }]);
    const { outbox, published } = recordingOutbox();

    const ended = await completeActiveElectionPeriod(
      tx,
      { outbox, now: () => NOW },
      {
        organizationId: ORG,
        period: { id: PERIOD, admissionId: ADM, sequenceNumber: 2, status: "active" },
        cause: "discharge",
        endDate: "2026-10-04",
      },
    );

    expect(ended).toBe(true);
    expect(sets[0]).toMatchObject({ status: "completed", actualEndAt: "2026-10-04" });
    expect(sets[0]).toMatchObject({ completedByCause: "discharge" });
    expect(published).toHaveLength(1);
    expect(published[0]?.eventName).toBe("m6.election.period_ended");
    expect(published[0]?.payload).toEqual({
      electionPeriodId: PERIOD,
      sequence: 2,
      endDate: "2026-10-04",
      admissionId: ADM,
    });
  });

  it("emits a payload that satisfies the catalog schema the real publisher validates", () => {
    const def = M6_OUTBOX_EVENTS.find((e) => e.eventName === "m6.election.period_ended");
    expect(def).toBeDefined();
    const payload = electionPeriodEndedPayload({
      electionPeriodId: PERIOD,
      sequence: 3,
      endDate: "2026-10-04",
      admissionId: ADM,
    });
    expect(Value.Check(def?.payloadSchema as never, payload)).toBe(true);
  });

  it("publishes nothing for a period that is not active (never started, or already completed)", async () => {
    const { tx } = fakeTx([{ id: PERIOD }]);
    const { outbox, published } = recordingOutbox();

    const ended = await completeActiveElectionPeriod(
      tx,
      { outbox, now: () => NOW },
      {
        organizationId: ORG,
        period: { id: PERIOD, admissionId: ADM, sequenceNumber: 1, status: "signed" },
        cause: "discharge",
        endDate: "2026-10-04",
      },
    );

    expect(ended).toBe(false);
    expect(published).toHaveLength(0);
  });

  it("publishes nothing when a concurrent writer already completed it (guarded UPDATE matched no row)", async () => {
    const { tx } = fakeTx([]);
    const { outbox, published } = recordingOutbox();

    const ended = await completeActiveElectionPeriod(
      tx,
      { outbox, now: () => NOW },
      {
        organizationId: ORG,
        period: { id: PERIOD, admissionId: ADM, sequenceNumber: 1, status: "active" },
        cause: "next_period",
        endDate: "2026-10-04",
      },
    );

    expect(ended).toBe(false);
    expect(published).toHaveLength(0);
  });
});

describe("runElectionPeriodAutoEndCron", () => {
  const withOrgContext = vi.fn();
  const activePeriodsPastEndForOrg = vi.fn();
  const startDueRecertPeriodsForOrg = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    withOrgContext.mockReset();
    activePeriodsPastEndForOrg.mockReset();
    startDueRecertPeriodsForOrg.mockReset();
  });

  it("completes each period past its end date under the org-local date and publishes one event each", async () => {
    const { tx, sets } = fakeTx([{ id: PERIOD }]);
    withOrgContext.mockImplementation(
      async (
        _db: unknown,
        ctx: { organizationId: string; userId: string },
        fn: (t: unknown) => unknown,
      ) => {
        // The NULL (system) audit actor — never a sentinel uuid (audit_event.actor_user_id FK).
        expect(ctx).toEqual({ organizationId: ORG, userId: "", systemActor: true });
        return fn(tx);
      },
    );
    activePeriodsPastEndForOrg.mockResolvedValue([
      {
        id: PERIOD,
        admissionId: ADM,
        sequenceNumber: 1,
        status: "active",
        scheduledEndAt: "2026-10-03",
      },
    ]);
    vi.doMock("@chartwarden/tenancy", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@chartwarden/tenancy")>()),
      withOrgContext,
    }));
    vi.doMock("@chartwarden/db", async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      organizationTimezone: async () => "UTC",
    }));
    vi.doMock("../src/modules/06-admission/jobs/cron-store", () => ({
      activePeriodsPastEndForOrg,
      ctiSignatureDueRowsForOrg: vi.fn(),
      f2fDueRowsForOrg: vi.fn(),
      f2fWindowMissedCandidatesForOrg: vi.fn(),
    }));
    vi.doMock("../src/modules/06-admission/recert-period-activation", () => ({
      startDueRecertPeriodsForOrg,
    }));
    const { runElectionPeriodAutoEndCron } = await import(
      "../src/modules/06-admission/jobs/cron-workers"
    );
    const { outbox, published } = recordingOutbox();

    await runElectionPeriodAutoEndCron({
      connection: {} as never,
      db: {} as never,
      outbox,
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
      now: () => NOW,
    });

    expect(activePeriodsPastEndForOrg).toHaveBeenCalledWith(tx, ORG, "2026-10-05");
    expect(sets[0]).toMatchObject({ status: "completed", completedByCause: "next_period" });
    expect(published.map((p) => p.eventName)).toEqual(["m6.election.period_ended"]);
    expect(published[0]?.payload).toMatchObject({ endDate: "2026-10-03", sequence: 1 });
    // ...then, on the same tx and org-local day, starts any signed successor whose start date has arrived
    // (§2.3.2 "setActive … on prior period auto-close"; live proof: m6-recert-period-start.live.test.ts).
    expect(startDueRecertPeriodsForOrg).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ outbox }),
      ORG,
      "2026-10-05",
    );
  });
});
