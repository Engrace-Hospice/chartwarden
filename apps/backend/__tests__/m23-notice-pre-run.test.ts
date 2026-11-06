// A NOE / NOTR / transfer-notice job for an organization whose clearinghouse is not live (owner decision D4). Before this the
// worker failed it with CH_NOT_WIRED, BullMQ retried it and it landed in the DLQ. Now, decided BEFORE the job opens its transaction:
//   outside                 NOE / NOTR: PARK the notice (external_filing_status 'pending') and complete the job WITHOUT running
//                           the submit, so nothing is generated, uploaded or announced; transfer notice: HOLD (nothing is sent);
//   nothing chosen / draft  HOLD (moved to delayed, no attempt spent, one alert), whatever the notice;
//   live vendor / legacy    run as before.
// No database, no Redis: the notice repositories are in-memory fakes and `bullmq`'s Worker only records its processor.
import { randomUUID } from "node:crypto";
import {
  type ClearinghouseBinding,
  UNBOUND_NOT_ACTIVE,
  UNBOUND_NOT_CHOSEN,
  UNBOUND_OUTSIDE,
} from "@chartwarden/x12-837-client";
import { InMemoryClearinghouse } from "@chartwarden/x12-837-client/testing";
import { DelayedError } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const fakes = vi.hoisted(() => ({
  noes: new Map<string, Record<string, unknown>>(),
  notrs: new Map<string, Record<string, unknown>>(),
  processors: new Map<string, (job: unknown, token?: string) => Promise<unknown>>(),
  /** The `claim_submission` attempt log (append-only: a row only ever leaves `queued`). */
  attempts: [] as Record<string, unknown>[],
}));

vi.mock("bullmq", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  class Worker {
    constructor(queue: string, processor: (job: unknown, token?: string) => Promise<unknown>) {
      fakes.processors.set(queue, processor);
    }
    close = async () => undefined;
  }
  return { ...original, Worker };
});

vi.mock("@chartwarden/billing", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const repos = original.repositories as Record<string, unknown>;
  const notice = (table: Map<string, Row>) =>
    class {
      findById = async (id: string) => table.get(id) ?? null;
      transitionToState = async (
        id: string,
        expectedVersion: number,
        next: string,
        patch: Row = {},
      ) => {
        const row = table.get(id);
        if (!row || row.version !== expectedVersion) {
          return { ok: false, conflict: "VERSION_CONFLICT", currentVersion: row?.version ?? null };
        }
        const updated = { ...row, ...patch, state: next, version: expectedVersion + 1 };
        table.set(id, updated);
        return { ok: true, row: updated };
      };
    };
  return {
    ...original,
    repositories: {
      ...repos,
      NoeRepository: notice(fakes.noes),
      NotrRepository: notice(fakes.notrs),
      ClaimSubmissionRepository: class {
        findById = async (id: string) => fakes.attempts.find((r) => r.id === id) ?? null;
        findLatestAttempt = async (providerEntityId: string, controlNumber: string) =>
          fakes.attempts
            .filter(
              (r) =>
                r.providerEntityId === providerEntityId && r.claimControlNumber === controlNumber,
            )
            .sort((a, b) => (b.attemptIndex as number) - (a.attemptIndex as number))[0] ?? null;
        append = async (values: Row) => {
          const existing = fakes.attempts.find(
            (r) =>
              r.providerEntityId === values.providerEntityId &&
              r.claimControlNumber === values.claimControlNumber &&
              r.attemptIndex === values.attemptIndex,
          );
          if (existing) return existing;
          const row = { id: `appended-${fakes.attempts.length + 1}`, ...values };
          fakes.attempts.push(row);
          return row;
        };
        terminalize = async (id: string, patch: Row) => {
          const at = fakes.attempts.findIndex((r) => r.id === id);
          const row = fakes.attempts[at];
          if (!row) throw new Error(`claim_submission ${id} not found`);
          if (row.outcome !== "queued") return row;
          const updated = { ...row, ...patch };
          fakes.attempts[at] = updated;
          return updated;
        };
      },
    },
  };
});

vi.mock("@chartwarden/tenancy", () => ({
  withOrgContext: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({}),
}));

import { configureClaimsBillingGate } from "../src/bootstrap/claims-billing-gate";
import type { M23TransportDeps } from "../src/modules/23-billing-medicare/jobs/clearinghouse-submission";
import {
  type M23WorkerDeps,
  holdBeforeRun,
  registerM23LaunchWorkers,
  registerM23Workers,
  runNoeSubmit,
  runNotrSubmit,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";
import { M23_QUEUES } from "../src/modules/23-billing-medicare/jobs/queues";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const LIVE: ClearinghouseBinding = { vendor: "stedi", transport: new InMemoryClearinghouse() };

const noe = (over: Row = {}): Row => ({
  id: "noe-1",
  organizationId: ORG,
  state: "ready",
  version: 4,
  externalFilingStatus: null,
  noeControlNumber: "H00001-261101-0abcd-00",
  providerEntityId: "pe-1",
  ...over,
});
const notr = (over: Row = {}): Row => ({
  id: "notr-1",
  organizationId: ORG,
  state: "ready",
  version: 4,
  externalFilingStatus: null,
  notrControlNumber: "H00001-261101-0abcd-01",
  providerEntityId: "pe-1",
  ...over,
});

/** An attempt row of notice `row` (`pe-1`, its control number), by default attempt 0, QUEUED. */
function seedAttempt(row: Row, over: Row = {}): Row {
  const attempt = {
    id: `att-${fakes.attempts.length}`,
    providerEntityId: "pe-1",
    claimControlNumber: (row.noeControlNumber ?? row.notrControlNumber) as string,
    attemptIndex: 0,
    outcome: "queued",
    ...over,
  };
  fakes.attempts.push(attempt);
  return attempt;
}
const attemptById = (id: string) => fakes.attempts.find((r) => r.id === id);

function depsFor(binding: ClearinghouseBinding | null, opts: { transmits?: boolean } = {}) {
  const alerts: { alertCode: string; organizationId: string }[] = [];
  const generated: string[] = [];
  const transport: M23TransportDeps | undefined = binding
    ? {
        binding: { ...UNBOUND_NOT_CHOSEN, forOrg: async () => binding },
        contexts: { contextFor: async () => ({}) as never, providerEntitiesFor: async () => [] },
      }
    : undefined;
  const deps = {
    db: {} as never,
    connection: {} as never,
    ...(transport ? { transport } : {}),
    alerts: { dispatch: async (a: never) => void alerts.push(a) },
    x12: {
      generateNoe: async () => {
        generated.push("noe");
        if (opts.transmits) return { x12: "ISA*~", correlationId: "corr-1" };
        throw new Error("stop after generate");
      },
      generateNotr: async () => {
        generated.push("notr");
        if (opts.transmits) return { x12: "ISA*~", correlationId: "corr-1" };
        throw new Error("stop after generate");
      },
    },
    macPortal: {
      upload: async () => ({ accepted: true, generatedFileUri: "s3://notices/x.x12" }),
    },
    outbox: { publish: async () => undefined },
    jurisdictions: { listJurisdictions: async () => [] },
    claim837i: {},
  } as unknown as M23WorkerDeps;
  return { deps, alerts, generated };
}
const jobOf = () => {
  const moved: number[] = [];
  return { moved, job: { moveToDelayed: async (at: number) => void moved.push(at) } };
};
const pre = (
  deps: M23WorkerDeps,
  queue: string,
  data: Record<string, unknown>,
  job: { moveToDelayed(at: number): Promise<void> },
) => holdBeforeRun(deps, job, "tok", queue, { organizationId: ORG, ...data } as never);

beforeEach(() => {
  configureClaimsBillingGate({ mode: "shadow" });
  fakes.noes.clear();
  fakes.notrs.clear();
  fakes.processors.clear();
  fakes.attempts.length = 0;
});

describe.each([
  ["NOE", M23_QUEUES.noeSubmit, { noeId: "noe-1" }, fakes.noes, "noe-1", noe],
  ["NOTR", M23_QUEUES.notrSubmit, { notrId: "notr-1" }, fakes.notrs, "notr-1", notr],
] as const)("%s job pre-flight (holdBeforeRun)", (_k, queue, data, table, id, make) => {
  it("PARKS the notice for an organization that bills outside and says the job is handled; nothing is held or alerted", async () => {
    table.set(id, make());
    const { deps, alerts } = depsFor(UNBOUND_OUTSIDE);
    const { job, moved } = jobOf();

    await expect(pre(deps, queue, data, job)).resolves.toBe("parked");

    expect(table.get(id)).toMatchObject({
      state: "ready",
      version: 5,
      externalFilingStatus: "pending",
    });
    expect(moved).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it("parks a draft too, and leaves a notice already pending, already filed, already settled, unknown or another org's alone", async () => {
    const { deps } = depsFor(UNBOUND_OUTSIDE);
    table.set(id, make({ state: "draft" }));
    await expect(pre(deps, queue, data, jobOf().job)).resolves.toBe("parked");
    expect(table.get(id)).toMatchObject({ state: "draft", externalFilingStatus: "pending" });

    const untouched: Row[] = [
      make({ externalFilingStatus: "pending" }),
      make({ externalFilingStatus: "filed" }),
      make({ state: "submitted" }),
      make({ state: "ack_accepted" }),
      make({ organizationId: OTHER_ORG }),
    ];
    for (const row of untouched) {
      table.set(id, row);
      await expect(pre(deps, queue, data, jobOf().job)).resolves.toBe("parked");
      expect(table.get(id)).toEqual(row);
    }
    table.clear();
    await expect(pre(deps, queue, data, jobOf().job)).resolves.toBe("parked");
  });

  it("closes the job's OWN queued attempt when it parks (failed_worker, a stable reason), so nothing is left reading as in flight; a settled attempt is left alone", async () => {
    const { deps } = depsFor(UNBOUND_OUTSIDE);
    table.set(id, make());
    const own = seedAttempt(make(), { id: "att-1" });
    await expect(pre(deps, queue, { ...data, submissionId: own.id }, jobOf().job)).resolves.toBe(
      "parked",
    );
    expect(attemptById("att-1")).toMatchObject({
      outcome: "failed_worker",
      outcomeReason: "PARKED_FOR_EXTERNAL_FILING",
    });

    fakes.attempts.length = 0;
    table.set(id, make());
    seedAttempt(make(), { id: "att-2", outcome: "submitted" });
    await expect(pre(deps, queue, { ...data, submissionId: "att-2" }, jobOf().job)).resolves.toBe(
      "parked",
    );
    expect(attemptById("att-2")).toMatchObject({ outcome: "submitted" });
    expect(attemptById("att-2")).not.toHaveProperty("outcomeReason");
  });

  it("still closes the job's own attempt when the notice already carries the marker (the tenant recorded it filed, or the route parked it, while the job waited): nothing is orphaned", async () => {
    const { deps } = depsFor(UNBOUND_OUTSIDE);
    for (const externalFilingStatus of ["pending", "filed"] as const) {
      fakes.attempts.length = 0;
      table.set(id, make({ externalFilingStatus }));
      seedAttempt(make(), { id: "att-own" });
      await expect(
        pre(deps, queue, { ...data, submissionId: "att-own" }, jobOf().job),
      ).resolves.toBe("parked");
      expect(attemptById("att-own"), externalFilingStatus).toMatchObject({
        outcome: "failed_worker",
        outcomeReason: "PARKED_FOR_EXTERNAL_FILING",
      });
      // the marker itself is left exactly as the tenant / route set it
      expect(table.get(id)).toMatchObject({ externalFilingStatus });
    }
  });

  it("closes ONLY the job's own attempt: a stale job whose attempt was long closed never closes the newer live attempt of a resubmit", async () => {
    const { deps } = depsFor(UNBOUND_OUTSIDE);
    table.set(id, make({ externalFilingStatus: "pending" }));
    seedAttempt(make(), { id: "att-old", outcome: "failed_worker", outcomeReason: "PARKED" });
    seedAttempt(make(), { id: "att-new", attemptIndex: 1 });
    await expect(pre(deps, queue, { ...data, submissionId: "att-old" }, jobOf().job)).resolves.toBe(
      "parked",
    );
    expect(attemptById("att-new")).toMatchObject({ outcome: "queued" });
  });

  it("a job without a submissionId (enqueued before the attempt was carried) falls back to the notice's latest QUEUED attempt", async () => {
    const { deps } = depsFor(UNBOUND_OUTSIDE);
    table.set(id, make());
    seedAttempt(make(), { id: "att-1" });
    await expect(pre(deps, queue, data, jobOf().job)).resolves.toBe("parked");
    expect(attemptById("att-1")).toMatchObject({ outcome: "failed_worker" });
  });

  it("HOLDS the job (delayed, no attempt spent) with ONE alert per organization and reason, whatever the notice", async () => {
    for (const binding of [UNBOUND_NOT_CHOSEN, UNBOUND_NOT_ACTIVE]) {
      table.set(id, make());
      const organizationId = randomUUID(); // the alert memory is per (org, reason) and process-wide
      const { deps, alerts } = depsFor(binding);
      const first = jobOf();
      const second = jobOf();
      const hold = (j: { moveToDelayed(at: number): Promise<void> }) =>
        holdBeforeRun(deps, j, "tok", queue, { organizationId, ...data } as never);
      await expect(hold(first.job)).rejects.toBeInstanceOf(DelayedError);
      await expect(hold(second.job)).rejects.toBeInstanceOf(DelayedError);
      expect(first.moved).toHaveLength(1);
      expect(second.moved).toHaveLength(1);
      expect(alerts).toEqual([expect.objectContaining({ organizationId })]);
      expect(table.get(id)).toEqual(make()); // a held notice is left exactly as it was
    }
  });

  it("lets the job run when the org's vendor is live, and on the legacy single-vendor path", async () => {
    table.set(id, make());
    for (const binding of [LIVE, null]) {
      const { deps } = depsFor(binding);
      const { job, moved } = jobOf();
      await expect(pre(deps, queue, data, job)).resolves.toBeUndefined();
      expect(moved).toEqual([]);
    }
    expect(table.get(id)).toEqual(make());
  });
});

describe("transfer-notice job pre-flight", () => {
  const data = { transferNoticeId: "tn-1", submissionId: "sub-1" };

  it("HOLDS the job for every unbound reason, outside included: nothing is transmitted and nothing is failed", async () => {
    for (const binding of [UNBOUND_OUTSIDE, UNBOUND_NOT_CHOSEN, UNBOUND_NOT_ACTIVE]) {
      const { deps } = depsFor(binding);
      const { job, moved } = jobOf();
      await expect(pre(deps, M23_QUEUES.transferNoticeSubmit, data, job)).rejects.toBeInstanceOf(
        DelayedError,
      );
      expect(moved).toHaveLength(1);
    }
  });

  it("lets it run when the org's vendor is live", async () => {
    const { deps } = depsFor(LIVE);
    await expect(
      pre(deps, M23_QUEUES.transferNoticeSubmit, data, jobOf().job),
    ).resolves.toBeUndefined();
  });
});

describe.each([
  ["registerM23Workers", (deps: M23WorkerDeps) => registerM23Workers(deps)],
  ["registerM23LaunchWorkers", (deps: M23WorkerDeps) => registerM23LaunchWorkers(deps, {})],
] as const)("%s: the submit workers honour the pre-flight verdict", (_name, register) => {
  const cases = [
    ["NOE", M23_QUEUES.noeSubmit, { noeId: "noe-1" }, fakes.noes, "noe-1", noe, "noe"],
    ["NOTR", M23_QUEUES.notrSubmit, { notrId: "notr-1" }, fakes.notrs, "notr-1", notr, "notr"],
  ] as const;

  it.each(cases)(
    "%s: an outside org's job completes WITHOUT running the submit (nothing generated or uploaded), parked",
    async (_k, queue, data, table, id, make) => {
      table.set(id, make());
      const { deps, generated } = depsFor(UNBOUND_OUTSIDE);
      register(deps);
      const process = fakes.processors.get(queue);
      expect(process).toBeDefined();

      const { job, moved } = jobOf();
      await expect(
        (process as NonNullable<typeof process>)(
          { ...job, data: { organizationId: ORG, ...data } },
          "tok",
        ),
      ).resolves.toBeUndefined();

      expect(generated).toEqual([]);
      expect(moved).toEqual([]);
      expect(table.get(id)).toMatchObject({ externalFilingStatus: "pending" });
    },
  );

  it.each(cases)(
    "%s: a live org's job runs the submit",
    async (_k, queue, data, table, id, make, kind) => {
      table.set(id, make());
      const { deps, generated } = depsFor(LIVE);
      register(deps);
      const { job } = jobOf();
      await expect(
        (fakes.processors.get(queue) as NonNullable<ReturnType<typeof fakes.processors.get>>)(
          { ...job, data: { organizationId: ORG, ...data } },
          "tok",
        ),
      ).rejects.toThrow("stop after generate");
      expect(generated).toEqual([kind]);
    },
  );

  it.each(cases)(
    "%s: a held job is moved to delayed and never run",
    async (_k, queue, data, table, id, make) => {
      table.set(id, make());
      const { deps, generated } = depsFor(UNBOUND_NOT_CHOSEN);
      register(deps);
      const { job, moved } = jobOf();
      await expect(
        (fakes.processors.get(queue) as NonNullable<ReturnType<typeof fakes.processors.get>>)(
          { ...job, data: { organizationId: ORG, ...data } },
          "tok",
        ),
      ).rejects.toBeInstanceOf(DelayedError);
      expect(moved).toHaveLength(1);
      expect(generated).toEqual([]);
    },
  );
});

describe("runNoeSubmit / runNotrSubmit: the defensive guard (the org may switch between the pre-flight and the run)", () => {
  const cases = [
    ["NOE", runNoeSubmit, { noeId: "noe-1" }, fakes.noes, "noe-1", noe, "noe"],
    ["NOTR", runNotrSubmit, { notrId: "notr-1" }, fakes.notrs, "notr-1", notr, "notr"],
  ] as const;

  it.each(cases)(
    "%s: never reaches generation or the transport for an org whose clearinghouse is not live",
    async (_k, run, data, table, id, make) => {
      table.set(id, make());
      for (const binding of [UNBOUND_OUTSIDE, UNBOUND_NOT_CHOSEN, UNBOUND_NOT_ACTIVE]) {
        const { deps, generated } = depsFor(binding);
        await expect(
          run({} as never, deps, { organizationId: ORG, ...data } as never),
        ).rejects.toThrow(/clearinghouse is not live/);
        expect(generated).toEqual([]);
      }
    },
  );

  it.each(cases)(
    "%s: refuses to transmit a notice the tenant recorded as filed outside ChartWarden: the job ends (no throw, so the close commits) and its own attempt is closed",
    async (_k, run, data, table, id, make) => {
      table.set(id, make({ externalFilingStatus: "filed" }));
      seedAttempt(make(), { id: "att-own" });
      const { deps, generated } = depsFor(LIVE);
      await expect(
        run({} as never, deps, { organizationId: ORG, ...data, submissionId: "att-own" } as never),
      ).resolves.toBeUndefined();
      expect(generated).toEqual([]);
      expect(attemptById("att-own")).toMatchObject({
        outcome: "failed_worker",
        outcomeReason: "NOTICE_FILED_EXTERNALLY",
      });
      expect(table.get(id)).toMatchObject({ externalFilingStatus: "filed", state: "ready" });
    },
  );

  it.each(cases)(
    "%s: a job whose own attempt was already closed transmits nothing (its mandate ended; the notice's live attempt has its own job)",
    async (_k, run, data, table, id, make) => {
      table.set(id, make());
      seedAttempt(make(), { id: "att-0", outcome: "failed_worker", outcomeReason: "PARKED" });
      const { deps, generated } = depsFor(LIVE);
      await expect(
        run({} as never, deps, { organizationId: ORG, ...data, submissionId: "att-0" } as never),
      ).resolves.toBeUndefined();
      expect(generated).toEqual([]);
      expect(table.get(id)).toMatchObject({ state: "ready", version: 4 });
    },
  );

  it.each(cases)(
    "%s: records the transmission on the job's OWN attempt (a resubmit's attempt 1), never on a closed attempt 0",
    async (_k, run, data, table, id, make, kind) => {
      table.set(id, make());
      seedAttempt(make(), { id: "att-0", outcome: "failed_worker", outcomeReason: "PARKED" });
      seedAttempt(make(), { id: "att-1", attemptIndex: 1 });
      const { deps, generated } = depsFor(LIVE, { transmits: true });
      await run({} as never, deps, {
        organizationId: ORG,
        ...data,
        submissionId: "att-1",
      } as never);
      expect(generated).toEqual([kind]);
      expect(attemptById("att-1")).toMatchObject({ outcome: "submitted" });
      expect(attemptById("att-0")).toMatchObject({
        outcome: "failed_worker",
        outcomeReason: "PARKED",
      });
      expect(fakes.attempts).toHaveLength(2); // nothing appended
      expect(table.get(id)).toMatchObject({ state: "submitted", latestSubmissionId: "att-1" });
    },
  );

  it.each(cases)(
    "%s: without a submissionId and without a queued attempt it appends a NEW attempt after the latest terminal one",
    async (_k, run, data, table, id, make) => {
      table.set(id, make());
      seedAttempt(make(), { id: "att-0", outcome: "failed_worker", outcomeReason: "PARKED" });
      const { deps } = depsFor(LIVE, { transmits: true });
      await run({} as never, deps, { organizationId: ORG, ...data } as never);
      const appended = fakes.attempts.find((r) => String(r.id).startsWith("appended-"));
      expect(appended).toMatchObject({ attemptIndex: 1, outcome: "submitted" });
      expect(table.get(id)).toMatchObject({ state: "submitted", latestSubmissionId: appended?.id });
    },
  );

  it.each(cases)(
    "%s: still runs for a live vendor and on the legacy path",
    async (_k, run, data, table, id, make, kind) => {
      table.set(id, make());
      for (const binding of [LIVE, null]) {
        const { deps, generated } = depsFor(binding);
        await expect(
          run({} as never, deps, { organizationId: ORG, ...data } as never),
        ).rejects.toThrow("stop after generate");
        expect(generated).toEqual([kind]);
      }
    },
  );
});
