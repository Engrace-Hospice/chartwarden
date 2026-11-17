// M10 §4.8 cron registration: the repeatables are registered with `upsertJobScheduler` under ONE scheduler id per queue,
// so a change of attempts / backoff / cron takes effect on an environment that already has the repeatable stored, and a
// repeatable an earlier deploy registered with `queue.add({ repeat })` is removed. (The real-BullMQ behaviour this relies
// on, a legacy repeatable keeping its stored options for ever, is the one `m36-integrity-jobs.live.test.ts` observed
// against BullMQ 5.81; this test pins what M10 asks of the Queue.)
import { describe, expect, it, vi } from "vitest";

interface UpsertCall {
  queue: string;
  schedulerId: string;
  repeat: { pattern?: string };
  template: {
    name?: string;
    data?: unknown;
    opts?: {
      attempts?: number;
      backoff?: { type?: string; delay?: number };
      removeOnComplete?: boolean;
      removeOnFail?: boolean;
    };
  };
}
const calls: string[] = [];
const upserts: UpsertCall[] = [];
const removed: Array<{ queue: string; key: string }> = [];
const closed: string[] = [];
const failure = { upsertOn: null as string | null };
vi.mock("bullmq", () => ({
  Queue: class {
    constructor(public readonly name: string) {}
    async getRepeatableJobs() {
      return [
        // What an earlier deploy left in Redis: a `queue.add({ repeat })` trigger carrying its old attempts.
        { key: "legacy-repeat-key", name: "scheduled", pattern: "*/15 * * * *" },
        // The scheduler this registration upserts (BullMQ lists schedulers beside legacy repeatables).
        { key: `${this.name}.schedule`, name: "scheduled", pattern: "x" },
        { key: "someone-elses", name: "other", pattern: "x" },
      ];
    }
    async removeRepeatableByKey(key: string) {
      calls.push(`remove:${this.name}:${key}`);
      removed.push({ queue: this.name, key });
      return true;
    }
    async close() {
      closed.push(this.name);
    }
    async upsertJobScheduler(
      schedulerId: string,
      repeat: UpsertCall["repeat"],
      template: UpsertCall["template"],
    ) {
      if (failure.upsertOn === this.name) throw new Error("redis blip");
      calls.push(`upsert:${this.name}`);
      upserts.push({ queue: this.name, schedulerId, repeat, template });
    }
  },
  Worker: class {},
}));

import { m10SchedulerId, scheduleM10Jobs } from "../src/modules/10-hope/jobs/cron-schedule";
import { M10_JOB_PARAMS, M10_JOB_SCHEDULES, M10_QUEUES } from "../src/modules/10-hope/jobs/index";

const reset = () => {
  calls.length = 0;
  upserts.length = 0;
  removed.length = 0;
  closed.length = 0;
  failure.upsertOn = null;
};

describe("scheduleM10Jobs", () => {
  it("upserts one scheduler per wired queue at its catalogued cadence", async () => {
    reset();

    await scheduleM10Jobs({});

    expect(upserts.map((u) => [u.queue, u.schedulerId, u.repeat.pattern])).toEqual([
      [
        M10_QUEUES.windows,
        m10SchedulerId(M10_QUEUES.windows),
        M10_JOB_SCHEDULES["hope-window-watchdog"],
      ],
      [M10_QUEUES.sfv, m10SchedulerId(M10_QUEUES.sfv), M10_JOB_SCHEDULES["sfv-watchdog"]],
      [
        M10_QUEUES.retention,
        m10SchedulerId(M10_QUEUES.retention),
        M10_JOB_SCHEDULES["hope-retention-scan"],
      ],
    ]);
  });

  it("registers the two watchdogs with attempts 1 and the retention scan with its catalogued attempts (the options a stored repeatable would have kept)", async () => {
    reset();

    await scheduleM10Jobs({});

    const optsOf = (queue: string) => upserts.find((u) => u.queue === queue)?.template.opts;
    expect(optsOf(M10_QUEUES.windows)).toMatchObject({
      attempts: 1,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
    expect(optsOf(M10_QUEUES.sfv)).toMatchObject({ attempts: 1 });
    expect(optsOf(M10_QUEUES.retention)).toMatchObject({
      attempts: M10_JOB_PARAMS["hope-retention-scan"].attempts,
      backoff: { type: "exponential", delay: 120_000 },
    });
    // The template name stays the literal "scheduled": the workers do not dispatch on it, and renaming it would orphan
    // the repeatable already stored under that name.
    expect(upserts.map((u) => u.template.name)).toEqual(["scheduled", "scheduled", "scheduled"]);
  });

  it("removes a repeatable an earlier deploy registered (any 'scheduled' key but its own scheduler id), and nothing else, AFTER the upsert", async () => {
    reset();

    await scheduleM10Jobs({});

    expect(removed).toEqual([
      { queue: M10_QUEUES.windows, key: "legacy-repeat-key" },
      { queue: M10_QUEUES.sfv, key: "legacy-repeat-key" },
      { queue: M10_QUEUES.retention, key: "legacy-repeat-key" },
    ]);
    for (const queue of [M10_QUEUES.windows, M10_QUEUES.sfv, M10_QUEUES.retention]) {
      expect(calls.indexOf(`upsert:${queue}`)).toBeLessThan(
        calls.indexOf(`remove:${queue}:legacy-repeat-key`),
      );
    }
  });

  it("keeps the legacy repeatable when an upsert fails (never zero schedules) and closes the queues it opened", async () => {
    reset();
    failure.upsertOn = M10_QUEUES.sfv;

    await expect(scheduleM10Jobs({})).rejects.toThrow("redis blip");

    // The windows queue was upserted and its legacy trigger removed; the sfv queue failed BEFORE any removal.
    expect(removed).toEqual([{ queue: M10_QUEUES.windows, key: "legacy-repeat-key" }]);
    expect(closed).toEqual([M10_QUEUES.windows, M10_QUEUES.sfv]);
  });
});
