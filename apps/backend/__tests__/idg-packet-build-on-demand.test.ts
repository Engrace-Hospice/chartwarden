/**
 * M14 on-demand packet build (`runOnDemandPacketBuild` + the `idg.packets-cron` job dispatch). Fake db: one
 * meeting row, other tables empty; `withOrgContext` is passed through. The fake emulates the two things a real
 * UPDATE ... WHERE status AND version RETURNING does (match on version, return the row) so the double-emit race
 * is observable; the real RLS/DB path is proven in m14-packet-build.live.test.ts.
 */
import { schema } from "@chartwarden/db";
import { describe, expect, it, vi } from "vitest";

vi.mock("@chartwarden/tenancy", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withOrgContext: (db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) => fn(db),
}));

import { processPacketsBuildJob } from "../src/modules/14-idg/jobs/cron-workers";
import { runOnDemandPacketBuild } from "../src/modules/14-idg/jobs/packet-build";
import { createBullmqPacketBuildQueuePort } from "../src/modules/14-idg/jobs/packet-build-queue";

const ORG = "11111111-1111-4111-8111-111111111111";
const MEETING = "22222222-2222-4222-8222-222222222222";
const LOC = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-01T12:00:00.000Z");
const SEVENTY_TWO_H = 72 * 3_600_000;

type Row = { status: string; version: number };

function fakeDb(initial: Row) {
  const row = { ...initial };
  const meetingRow = () => ({
    id: MEETING,
    locationId: LOC,
    status: row.status,
    version: row.version,
    scheduledStart: new Date(NOW.getTime() + SEVENTY_TWO_H),
    coordinatorMembershipId: "44444444-4444-4444-8444-444444444444",
  });
  const select = () => {
    let isMeeting = false;
    const b: Record<string, unknown> = {
      from: (t: unknown) => {
        isMeeting = t === schema.idgMeeting;
        return b;
      },
      where: () => b,
      limit: () => b,
      for: () => b,
      // emulates the status IN (...) filter of the meeting lookups
      // biome-ignore lint/suspicious/noThenProperty: drizzle query builders are awaitable thenables
      then: (res: (v: unknown[]) => unknown) =>
        Promise.resolve().then(() =>
          res(
            isMeeting && ["scheduled", "packets_building"].includes(row.status)
              ? [meetingRow()]
              : [],
          ),
        ),
    };
    return b;
  };
  const update = () => {
    let values: { status: string; version: number };
    const b: Record<string, unknown> = {
      set: (v: typeof values) => {
        values = v;
        return b;
      },
      where: () => b,
      returning: () => b,
      // biome-ignore lint/suspicious/noThenProperty: drizzle query builders are awaitable thenables
      then: (res: (v: unknown[]) => unknown) =>
        Promise.resolve().then(() => {
          if (row.version !== values.version - 1) return res([]);
          row.status = values.status;
          row.version = values.version;
          return res([{ id: MEETING }]);
        }),
    };
    return b;
  };
  return { db: { select, update } as never, row };
}

function deps(db: never) {
  const publish = vi.fn(async () => undefined);
  const listActiveOrgs = vi.fn(async () => [] as { organizationId: string }[]);
  return {
    publish,
    listActiveOrgs,
    deps: {
      db,
      outbox: { publish } as never,
      activeOrgs: { listActiveOrgs },
      redis: {} as never,
      m6: { inclusionForOrg: async () => [] } as never,
      m7: {} as never,
      now: () => NOW,
    },
  };
}
const eventsOf = (publish: ReturnType<typeof vi.fn>) =>
  (publish.mock.calls as unknown as [unknown, { eventName: string }][]).map(([, e]) => e.eventName);

describe("runOnDemandPacketBuild", () => {
  it("builds a meeting 72h out (beyond the cron lookahead) to packets_ready", async () => {
    const { db, row } = fakeDb({ status: "scheduled", version: 1 });
    const d = deps(db);
    await runOnDemandPacketBuild(d.deps, { organizationId: ORG, meetingId: MEETING });
    expect(row.status).toBe("packets_ready");
    expect(eventsOf(d.publish)).toEqual(["m14.packets.build_started", "m14.packets.ready"]);
  });

  it("resumes a packets_building meeting without a second build_started", async () => {
    const { db, row } = fakeDb({ status: "packets_building", version: 2 });
    const d = deps(db);
    await runOnDemandPacketBuild(d.deps, { organizationId: ORG, meetingId: MEETING });
    expect(row.status).toBe("packets_ready");
    expect(eventsOf(d.publish)).toEqual(["m14.packets.ready"]);
  });

  it.each(["live", "cancelled", "packets_ready", "adjourned"])(
    "is a no-op for a %s meeting",
    async (status) => {
      const { db, row } = fakeDb({ status, version: 5 });
      const d = deps(db);
      await runOnDemandPacketBuild(d.deps, { organizationId: ORG, meetingId: MEETING });
      expect(row).toEqual({ status, version: 5 });
      expect(d.publish).not.toHaveBeenCalled();
    },
  );

  it("emits build_started and packets.ready exactly once when two runners race", async () => {
    const { db, row } = fakeDb({ status: "scheduled", version: 1 });
    const d = deps(db);
    await Promise.all([
      runOnDemandPacketBuild(d.deps, { organizationId: ORG, meetingId: MEETING }),
      runOnDemandPacketBuild(d.deps, { organizationId: ORG, meetingId: MEETING }),
    ]);
    expect(row.status).toBe("packets_ready");
    const events = eventsOf(d.publish);
    expect(events.filter((e) => e === "m14.packets.build_started")).toHaveLength(1);
    expect(events.filter((e) => e === "m14.packets.ready")).toHaveLength(1);
  });
});

describe("processPacketsBuildJob (idg.packets-cron dispatch)", () => {
  it("runs the on-demand build for an on-demand job, not the org sweep", async () => {
    const { db, row } = fakeDb({ status: "scheduled", version: 1 });
    const d = deps(db);
    await processPacketsBuildJob(
      { name: "on-demand", data: { organizationId: ORG, meetingId: MEETING } },
      d.deps,
    );
    expect(row.status).toBe("packets_ready");
    expect(d.listActiveOrgs).not.toHaveBeenCalled();
  });

  it("runs the org sweep for the registered repeatable cron job name only", async () => {
    const { db } = fakeDb({ status: "scheduled", version: 1 });
    const d = deps(db);
    await processPacketsBuildJob({ name: "scheduled", data: {} }, d.deps);
    expect(d.listActiveOrgs).toHaveBeenCalledOnce();
  });

  it("fails any other job name instead of falling through to the cross-tenant sweep", async () => {
    const { db } = fakeDb({ status: "scheduled", version: 1 });
    const d = deps(db);
    await expect(processPacketsBuildJob({ name: "surprise", data: {} }, d.deps)).rejects.toThrow(
      /unknown job/,
    );
    expect(d.listActiveOrgs).not.toHaveBeenCalled();
  });

  it("accepts an optional uuid requestedByMembershipId and logs it with ids only", async () => {
    const { db } = fakeDb({ status: "scheduled", version: 1 });
    const d = deps(db);
    const log = vi.fn();
    const by = "55555555-5555-4555-8555-555555555555";
    await processPacketsBuildJob(
      {
        name: "on-demand",
        data: { organizationId: ORG, meetingId: MEETING, requestedByMembershipId: by },
      },
      d.deps,
      log,
    );
    expect(log).toHaveBeenCalledWith("idg on-demand packet build", {
      organizationId: ORG,
      meetingId: MEETING,
      requestedByMembershipId: by,
    });
    await expect(
      processPacketsBuildJob(
        {
          name: "on-demand",
          data: { organizationId: ORG, meetingId: MEETING, requestedByMembershipId: "nope" },
        },
        d.deps,
      ),
    ).rejects.toThrow(/invalid on-demand job data/);
  });

  it.each([
    ["missing fields", {}],
    ["non-uuid ids", { organizationId: "x", meetingId: "y" }],
    ["non-string ids", { organizationId: 1, meetingId: MEETING }],
    ["null data", null],
  ])("rejects bad on-demand job data (%s) without touching the db", async (_n, data) => {
    const { db, row } = fakeDb({ status: "scheduled", version: 1 });
    const d = deps(db);
    await expect(processPacketsBuildJob({ name: "on-demand", data }, d.deps)).rejects.toThrow(
      /invalid on-demand job data/,
    );
    expect(row.status).toBe("scheduled");
    expect(d.publish).not.toHaveBeenCalled();
  });
});

describe("createBullmqPacketBuildQueuePort (fake queue)", () => {
  const job = { organizationId: ORG, meetingId: MEETING };
  const fakeQueue = (state: string | null, add = vi.fn(async () => undefined)) => {
    const remove = vi.fn(async () => undefined);
    const queue = {
      getJob: vi.fn(async () => (state ? { getState: async () => state, remove } : undefined)),
      add,
    };
    return { queue: queue as never, remove, add };
  };

  it.each(["failed", "completed"])("removes a retained %s job before adding", async (state) => {
    const f = fakeQueue(state);
    await createBullmqPacketBuildQueuePort(f.queue).enqueue(job);
    expect(f.remove).toHaveBeenCalledOnce();
    expect(f.add).toHaveBeenCalledOnce();
  });

  it.each(["waiting", "active", "delayed"])("leaves a %s job alone (dedupe)", async (state) => {
    const f = fakeQueue(state);
    await createBullmqPacketBuildQueuePort(f.queue).enqueue(job);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it("adds with a stable job id, retained failures (DLQ convention) and retry attempts", async () => {
    const f = fakeQueue(null);
    await createBullmqPacketBuildQueuePort(f.queue).enqueue(job);
    expect(f.add).toHaveBeenCalledWith(
      "on-demand",
      job,
      expect.objectContaining({
        jobId: `build-${ORG}-${MEETING}`,
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 2,
      }),
    );
  });

  it("rejects fast when Redis hangs instead of blocking the request", async () => {
    const f = fakeQueue(
      null,
      vi.fn(() => new Promise<undefined>(() => {})),
    );
    await expect(
      createBullmqPacketBuildQueuePort(f.queue, { timeoutMs: 20 }).enqueue(job),
    ).rejects.toThrow(/timed out/);
  });
});
