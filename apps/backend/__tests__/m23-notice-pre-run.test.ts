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
  attempts: new Map<string, Record<string, unknown>>(),
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
        findLatestAttempt = async (providerEntityId: string, controlNumber: string) =>
          fakes.attempts.get(`${providerEntityId}:${controlNumber}`) ?? null;
        terminalize = async (id: string, patch: Row) => {
          for (const [key, row] of fakes.attempts) {
            if (row.id === id) fakes.attempts.set(key, { ...row, ...patch });
          }
          return { id, ...patch };
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

function depsFor(binding: ClearinghouseBinding | null) {
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
        throw new Error("stop after generate");
      },
      generateNotr: async () => {
        generated.push("notr");
        throw new Error("stop after generate");
      },
    },
    macPortal: {},
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
  fakes.attempts.clear();
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

  it("closes the notice's QUEUED attempt when it parks (failed_worker, a stable reason), so nothing is left reading as in flight; a settled attempt is left alone", async () => {
    const { deps } = depsFor(UNBOUND_OUTSIDE);
    const row = make();
    const key = `pe-1:${(row.noeControlNumber ?? row.notrControlNumber) as string}`;
    table.set(id, row);
    fakes.attempts.set(key, { id: "att-1", outcome: "queued" });
    await expect(pre(deps, queue, data, jobOf().job)).resolves.toBe("parked");
    expect(fakes.attempts.get(key)).toMatchObject({
      outcome: "failed_worker",
      outcomeReason: "PARKED_FOR_EXTERNAL_FILING",
    });

    table.set(id, make());
    fakes.attempts.set(key, { id: "att-2", outcome: "submitted" });
    await expect(pre(deps, queue, data, jobOf().job)).resolves.toBe("parked");
    expect(fakes.attempts.get(key)).toEqual({ id: "att-2", outcome: "submitted" });
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
