// GAP-069 / GAP-070 (M23): the watchdog crons and the validation / revalidation / eligibility workers.
//
// No database and no Redis. The repositories are replaced with recording fakes, and every outbox payload the
// workers publish is checked against the real catalog schema (`M23_OUTBOX_EVENTS`) — the same Value.Check the
// catalog-validating publisher runs, which is what refused the old payloads at runtime.
import { Value } from "@sinclair/typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const fakes = vi.hoisted(() => ({
  noeCandidates: [] as Row[],
  notrCandidates: [] as Row[],
  stale: [] as Row[],
  latestByPatient: new Map<string, Row>(),
  claims: new Map<string, Row>(),
  appended: [] as Row[],
}));

vi.mock("@wardenx/billing", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const repos = original.repositories as Record<string, unknown>;
  class NoeRepository {
    listWindowWatchCandidates = async () => fakes.noeCandidates;
  }
  class NotrRepository {
    listWindowWatchCandidates = async () => fakes.notrCandidates;
  }
  class EligibilityCheckRepository {
    listStaleForOrg = async () => fakes.stale;
    findLatestForPatient = async (_org: string, patientId: string) =>
      fakes.latestByPatient.get(patientId) ?? null;
    append = async (row: Row) => {
      // The row's own id must be honoured, never silently replaced by a fixture id: the worker test below compares it.
      if (typeof row.id !== "string")
        throw new Error("fake append: the worker must mint the check id");
      const stored = { checkedAt: new Date("2026-10-05T12:00:00.000Z"), ...row, id: row.id };
      fakes.appended.push(stored);
      return stored;
    };
  }
  class ClaimRepository {
    findById = async (id: string) => fakes.claims.get(id) ?? null;
  }
  return {
    ...original,
    repositories: {
      ...repos,
      NoeRepository,
      NotrRepository,
      EligibilityCheckRepository,
      ClaimRepository,
    },
  };
});

vi.mock("@wardenx/tenancy", () => ({
  withOrgContext: async (
    _db: unknown,
    _ctx: { organizationId: string; userId: string },
    fn: (tx: unknown) => Promise<unknown>,
  ) => fn({}),
}));

import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/events-by-m23";
import {
  type M23WorkerDeps,
  runEligibilityRefresh,
  runEligibilityStaleWatch,
  runNoeWindowWatch,
  runNotrWindowWatch,
  runRevalidateConsumer,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-10-05T12:00:00.000Z");

type Published = { eventName: string; payload: Record<string, unknown> };

function catalogAccepts(event: Published): boolean {
  const def = M23_OUTBOX_EVENTS.find((e) => e.eventName === event.eventName);
  if (!def) throw new Error(`no catalog entry for ${event.eventName}`);
  return Value.Check(def.payloadSchema as never, event.payload);
}

function harness(overrides: Partial<M23WorkerDeps> = {}) {
  const published: Published[] = [];
  const alerts: { alertCode: string; payload: Record<string, unknown> }[] = [];
  const breaches: { kind: string; noticeId: string }[] = [];
  const deps = {
    connection: {} as never,
    db: {} as never,
    now: () => NOW,
    outbox: {
      publish: async (_tx: unknown, input: Published) => {
        published.push(input);
      },
    },
    alerts: {
      dispatch: async (a: { alertCode: string; payload: Record<string, unknown> }) => {
        alerts.push(a);
      },
    },
    activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
    noticeWindow: {
      recordBreach: async (b: { kind: string; noticeId: string }) => {
        breaches.push(b);
      },
    },
    ...overrides,
  } as unknown as M23WorkerDeps;
  return { deps, published, alerts, breaches };
}

beforeEach(() => {
  fakes.noeCandidates = [];
  fakes.notrCandidates = [];
  fakes.stale = [];
  fakes.latestByPatient = new Map();
  fakes.claims = new Map();
  fakes.appended = [];
});

describe("GAP-069 watchdog crons", () => {
  it("throws unboundWorkerPort when no active-org enumerator is bound (the pre-fix production state)", async () => {
    const { deps } = harness({ activeOrgs: undefined });
    await expect(runNoeWindowWatch(deps)).rejects.toThrow(/activeOrgs/);
  });

  it("stamps a breached NOE, publishes a catalog-valid window_breached and alerts", async () => {
    fakes.noeCandidates = [
      { id: "noe-1", admissionId: "adm-1", version: 3, windowTargetAt: "2026-10-01" },
    ];
    const { deps, published, alerts, breaches } = harness();

    await runNoeWindowWatch(deps);

    expect(breaches).toMatchObject([
      { kind: "noe", noticeId: "noe-1", expectedVersion: 3, breachedAt: NOW },
    ]);
    expect(published.map((p) => p.eventName)).toEqual(["m23.noe.window_breached"]);
    expect(published.every(catalogAccepts)).toBe(true);
    expect(alerts.map((a) => a.alertCode)).toEqual(["m23.noe.window_breached"]);
  });

  it("publishes a catalog-valid window_warning on the target day", async () => {
    fakes.noeCandidates = [
      { id: "noe-2", admissionId: "adm-2", version: 1, windowTargetAt: "2026-10-05" },
    ];
    const { deps, published, breaches } = harness();

    await runNoeWindowWatch(deps);

    expect(breaches).toHaveLength(0);
    expect(published.map((p) => p.eventName)).toEqual(["m23.noe.window_warning"]);
    expect(published.every(catalogAccepts)).toBe(true);
  });

  it("covers NOTR the same way, with catalog-valid payloads", async () => {
    fakes.notrCandidates = [
      { id: "notr-1", admissionId: "adm-3", version: 2, windowTargetAt: "2026-10-02" },
    ];
    const { deps, published, breaches } = harness();

    await runNotrWindowWatch(deps);

    expect(breaches.map((b) => b.kind)).toEqual(["notr"]);
    expect(published.map((p) => p.eventName)).toEqual(["m23.notr.window_breached"]);
    expect(published.every(catalogAccepts)).toBe(true);
  });

  it("raises eligibility.expired only for a patient whose LATEST check is the stale one", async () => {
    const staleAt = new Date("2026-09-01T00:00:00.000Z");
    const checkedAt = new Date("2026-08-02T00:00:00.000Z");
    fakes.stale = [
      { id: "old-check", patientId: "p-fresh", checkedAt, staleAt },
      { id: "last-check", patientId: "p-stale", checkedAt, staleAt },
    ];
    fakes.latestByPatient.set("p-fresh", { id: "newer-check", patientId: "p-fresh" });
    fakes.latestByPatient.set("p-stale", { id: "last-check", patientId: "p-stale" });
    const { deps, published, alerts } = harness();

    await runEligibilityStaleWatch(deps);

    expect(published).toHaveLength(1);
    expect(published[0]?.payload).toMatchObject({ patientId: "p-stale" });
    expect(catalogAccepts(published[0] as Published)).toBe(true);
    expect(alerts.map((a) => a.payload.patientId)).toEqual(["p-stale"]);
  });
});

describe("GAP-070 workers", () => {
  it("eligibility.refresh appends the check and publishes a catalog-valid eligibility.checked", async () => {
    const { deps, published } = harness({
      hets: {
        check: async () => ({
          outcome: "active_part_a",
          reason: null,
          partAEffectiveDate: "2025-01-01",
          partATerminationDate: null,
          hospiceElectionOnFile: false,
          hospice: null,
          rejectionCodes: [],
          transport: "sandbox",
          correlationId: "trace-1",
          responseFileUri: null,
          staleAt: new Date("2026-11-04T12:00:00.000Z"),
        }),
      },
    } as Partial<M23WorkerDeps>);

    await runEligibilityRefresh({} as never, deps, {
      organizationId: ORG,
      patientId: "p-1",
      providerEntityId: "pe-1",
      asOfServiceDate: "2026-10-05",
    });

    expect(fakes.appended).toHaveLength(1);
    expect(published.map((p) => p.eventName)).toEqual(["m23.eligibility.checked"]);
    expect(catalogAccepts(published[0] as Published)).toBe(true);
  });

  it("eligibility.refresh passes hets.check the same id it appends and publishes as checkId", async () => {
    const seenIds: unknown[] = [];
    const { deps, published } = harness({
      hets: {
        check: async (input: { eligibilityCheckId: string }) => {
          seenIds.push(input.eligibilityCheckId);
          return {
            outcome: "active_part_a",
            reason: null,
            partAEffectiveDate: "2025-01-01",
            partATerminationDate: null,
            hospiceElectionOnFile: false,
            hospice: null,
            rejectionCodes: [],
            transport: "sandbox",
            correlationId: "trace-1",
            responseFileUri: null,
            staleAt: new Date("2026-11-04T12:00:00.000Z"),
          };
        },
      },
    } as Partial<M23WorkerDeps>);

    await runEligibilityRefresh({} as never, deps, {
      organizationId: ORG,
      patientId: "p-1",
      providerEntityId: "pe-1",
      asOfServiceDate: "2026-10-05",
    });

    expect(seenIds).toHaveLength(1);
    expect(seenIds[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect((fakes.appended[0] as { id: string }).id).toBe(seenIds[0]);
    expect(published[0]?.payload.checkId).toBe(seenIds[0]);
  });

  it("eligibility.refresh persists the structured hospice history and refuses an MBI-bearing payload", async () => {
    const hospice = {
      periods: [
        {
          kind: "benefit_period" as const,
          periodNumber: 1,
          startDate: "2023-01-10",
          endDate: "2023-04-09",
          hospiceNpi: "1649726464",
          revocationOrDischargeDate: "2023-04-09",
          revocationCode: "1" as const,
          daysUsed: 90,
        },
      ],
      electionOpen: false,
      truncated: false,
      billedPeriodCount: 1,
      nextPeriodNumber: 2,
      nextPeriodBasis: "computed" as const,
    };
    const result = {
      outcome: "active_part_a" as const,
      reason: null,
      partAEffectiveDate: "2005-04-01",
      partATerminationDate: null,
      hospiceElectionOnFile: true,
      hospice,
      rejectionCodes: [],
      transport: "core_mime" as const,
      correlationId: "trace-2",
      responseFileUri: null,
      staleAt: new Date("2026-11-04T12:00:00.000Z"),
    };
    const job = {
      organizationId: ORG,
      patientId: "p-1",
      providerEntityId: "pe-1",
      asOfServiceDate: "2026-10-05",
    };
    const { deps } = harness({ hets: { check: async () => result } } as Partial<M23WorkerDeps>);
    await runEligibilityRefresh({} as never, deps, job);
    const row = fakes.appended.at(-1) as Record<string, unknown>;
    expect(row.workerCorrelationId).toBe("trace-2");
    expect(row.rawResponseFileUri).toBeNull();
    expect(row.parsedPayload).toMatchObject({
      partAActive: true,
      hospicePeriods: hospice.periods,
      hospiceElectionOpen: false,
      hospiceNextPeriodNumber: 2,
      hospiceNextPeriodBasis: "computed",
      transport: "core_mime",
    });

    // A port that (wrongly) leaks an MBI-shaped value into the payload is refused before any write.
    const before = fakes.appended.length;
    const leaky = harness({
      hets: { check: async () => ({ ...result, reason: "1EG4TE5MK73" }) },
    } as Partial<M23WorkerDeps>);
    await expect(runEligibilityRefresh({} as never, leaky.deps, job)).rejects.toThrow(/MBI_LEAK/);
    expect(fakes.appended).toHaveLength(before);
  });

  it("revalidate.consumer fans out one validation-run per VALIDATING/READY target with a real uuid run id", async () => {
    fakes.claims.set("c-ready", { id: "c-ready", state: "ready" });
    fakes.claims.set("c-draft", { id: "c-draft", state: "draft" });
    const enqueued: { queue: string; key: string; payload: Record<string, unknown> }[] = [];
    const { deps } = harness({
      revalidationTargets: {
        resolve: async () => [{ claimId: "c-ready" }, { claimId: "c-draft" }, { claimId: "gone" }],
      },
      enqueue: {
        enqueue: async (queue: string, key: string, payload: Record<string, unknown>) => {
          enqueued.push({ queue, key, payload });
          return { jobId: key };
        },
      },
    } as Partial<M23WorkerDeps>);

    const job = {
      organizationId: ORG,
      eventId: "evt-1",
      eventName: "m6.election.period_ended",
      eventPayload: {},
    };
    await runRevalidateConsumer({} as never, deps, job);
    await runRevalidateConsumer({} as never, deps, job);

    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]?.queue).toBe("m23.validation-run");
    expect(enqueued[0]?.payload.claimId).toBe("c-ready");
    expect(enqueued[0]?.payload.trigger).toBe("re_validation_after_correction");
    expect(String(enqueued[0]?.payload.validationRunId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // a redelivery of the same upstream event derives the SAME run id (idempotent downstream)
    expect(enqueued[1]?.payload.validationRunId).toBe(enqueued[0]?.payload.validationRunId);
  });
});
