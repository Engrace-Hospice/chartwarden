// @wardenx/quality — §4.8 ASYNC/WORKER layer UNIT TESTS (M30 §7.1 / §7.2 / §7.8 / §7.9 / §4.9).
//
// PURE port-injected processors driven by in-memory recording fakes (the M33 `refresh.test.ts` / M34
// `shred-worker.test.ts` template): each test builds the port bundle over in-memory state + a recorded
// call trail; assertions read the trail. These suites NEVER touch a DB / Valkey / BullMQ. They prove:
//   • the §4.8 `processing_log` guard short-circuits a replay (`already_processed`);
//   • the measure-recompute worker append-only inserts + supersedes, is V-8 idempotent on snapshot hash,
//     and fires the QAPI threshold-breach only on a transition INTO red;
//   • the outbreak worker dedupes a cluster against the live `uq_outbreak_window`;
//   • the cahps export worker flips rows to `export_failed` + emits only on the §4.8 terminal attempt;
//   • the pure cron decision cores (`decideSraReminder`, `priorCalendarMonthPeriod`) are total + correct.
import type { schema } from "@wardenx/db";
import {
  type CahpsExportPorts,
  type MeasureRecomputePorts,
  type OutbreakDetectionPorts,
  decideSraReminder,
  decideThresholdBreach,
  handleCahpsExport,
  handleMeasureRecompute,
  handleOutbreakDetection,
  priorCalendarMonthPeriod,
  ratioResult,
  registerMeasure,
  runNightlyRecompute,
} from "@wardenx/quality";
import type { MeasureRegistration } from "@wardenx/quality";
import { describe, expect, it } from "vitest";

const snapshot = { note: "test" } as unknown as schema.MeasureComputationSnapshot;

function trivialRegistration(rate: {
  numerator: number;
  denominator: number;
}): MeasureRegistration {
  return registerMeasure(
    "hci_composite",
    () => ratioResult({ numerator: rate.numerator, denominator: rate.denominator, snapshot }),
    {
      periodKind: "rolling_12m_to_quarter",
      family: "hci",
      activatesFy: 2025,
      calculatorVersion: "0.1.0",
    },
  );
}

function baseMeasurePorts(overrides: {
  isProcessed?: boolean;
  current?: schema.QualityMeasureValue | null;
  hash?: string;
  registration?: MeasureRegistration;
}): { ports: MeasureRecomputePorts; calls: string[] } {
  const calls: string[] = [];
  const registration =
    overrides.registration ?? trivialRegistration({ numerator: 5, denominator: 10 });
  const ports: MeasureRecomputePorts = {
    processingLog: {
      isProcessed: async () => overrides.isProcessed ?? false,
      markProcessed: async (jobId) => {
        calls.push(`markProcessed:${jobId}`);
      },
    },
    registrations: new Map([[registration.code, registration]]),
    hope: {
      timepointCompletionRollup: async () => ({ onTime: 0, late: 0 }),
      submissionPostureRollup: async () => ({ submissions: 0, acceptedSubmissions: 0 }),
      sfvTimelinessRollup: async () => ({ sfvDue: 0, sfvOnTime: 0 }),
      j2051FollowUpRollup: async () => ({
        painTriggers: 0,
        painFollowUpsInWindow: 0,
        nonPainTriggers: 0,
        nonPainFollowUpsInWindow: 0,
      }),
      openSfvObligationCount: async () => 0,
    },
    data: {
      resolveInput: async (_req, seams) => {
        calls.push(seams.hope !== undefined ? "seam:hope" : "seam:none");
        return {};
      },
    },
    values: {
      findCurrent: async () => overrides.current ?? null,
      insertValue: async (values) => {
        calls.push(`insert:${values.id}`);
        return values as schema.QualityMeasureValue;
      },
      supersede: async (id, by) => {
        calls.push(`supersede:${id}->${by}`);
      },
    },
    outbox: {
      emitValueEmitted: async (p) => {
        calls.push(`valueEmitted:${p.valueId}:${p.bandColor}`);
      },
      emitThresholdBreached: async (p) => {
        calls.push(`thresholdBreached:${p.severityBand}`);
      },
    },
    hashSnapshot: () => overrides.hash ?? "hash-A",
    newValueId: () => "value-NEW",
    now: () => new Date("2026-04-02T03:15:00Z"),
  };
  return { ports, calls };
}

describe("measureRecomputeProcessor", () => {
  it("short-circuits on the §4.8 processing_log guard (already_processed)", async () => {
    const { ports } = baseMeasurePorts({ isProcessed: true });
    const result = await handleMeasureRecompute(makeMeasureJob(), ports);
    expect(result).toEqual({ skipped: true, reason: "already_processed" });
  });

  it("inserts a fresh value, reaches the live HOPE seam, and emits value_emitted (no prior)", async () => {
    const { ports, calls } = baseMeasurePorts({ current: null });
    const result = await handleMeasureRecompute(makeMeasureJob(), ports);
    expect(result.outcome).toBe("recomputed");
    expect(calls).toContain("seam:hope");
    expect(calls).toContain("insert:value-NEW");
    expect(calls).toContain("valueEmitted:value-NEW:green");
    // no prior current row → no supersede
    expect(calls.some((c) => c.startsWith("supersede:"))).toBe(false);
  });

  it("supersedes the prior current row when one exists", async () => {
    const prior = {
      id: "value-OLD",
      snapshotContentHash: "hash-OLD",
      ratio: "0.5",
      thresholdMet: true,
    } as schema.QualityMeasureValue;
    const { ports, calls } = baseMeasurePorts({ current: prior, hash: "hash-NEW" });
    await handleMeasureRecompute(makeMeasureJob(), ports);
    expect(calls).toContain("supersede:value-OLD->value-NEW");
  });

  it("is V-8 idempotent: an identical snapshot hash on the current row inserts nothing", async () => {
    const prior = {
      id: "value-OLD",
      snapshotContentHash: "hash-A",
      ratio: "0.5",
      thresholdMet: true,
    } as schema.QualityMeasureValue;
    const { ports, calls } = baseMeasurePorts({ current: prior, hash: "hash-A" });
    const result = await handleMeasureRecompute(makeMeasureJob(), ports);
    expect(result).toEqual({
      outcome: "unchanged",
      measureCode: "hci_composite",
      valueId: "value-OLD",
    });
    expect(calls.some((c) => c.startsWith("insert:"))).toBe(false);
  });
});

describe("decideThresholdBreach (pure)", () => {
  const red = ratioResult({
    numerator: 1,
    denominator: 10,
    snapshot,
    threshold: { value: 0.9, direction: "gte" },
  });
  const green = ratioResult({
    numerator: 10,
    denominator: 10,
    snapshot,
    threshold: { value: 0.9, direction: "gte" },
  });
  it("fires on a transition INTO red (no prior)", () => {
    expect(decideThresholdBreach(null, null, red)).toBe(true);
  });
  it("stays silent when the prior was already red", () => {
    expect(decideThresholdBreach({ ratio: "0.1" } as schema.QualityMeasureValue, "red", red)).toBe(
      false,
    );
  });
  it("never breaches on a green value", () => {
    expect(decideThresholdBreach(null, null, green)).toBe(false);
  });
});

describe("outbreakDetectionProcessor", () => {
  function makeEvents(): schema.InfectionSurveillanceEvent[] {
    const base = (id: string, observedAt: string) =>
      ({
        id,
        organizationId: "org-1",
        providerEntityId: "pe-1",
        pathogen: "MRSA",
        bodySite: "skin",
        observedAt: new Date(observedAt),
      }) as schema.InfectionSurveillanceEvent;
    return [
      base("e1", "2026-04-01T00:00:00Z"),
      base("e2", "2026-04-03T00:00:00Z"),
      base("e3", "2026-04-05T00:00:00Z"),
    ];
  }

  it("opens a case for a fresh cluster and emits outbreak_opened", async () => {
    const calls: string[] = [];
    const ports: OutbreakDetectionPorts = {
      processingLog: { isProcessed: async () => false, markProcessed: async () => {} },
      events: { recentForOrg: async () => makeEvents() },
      cases: {
        findByWindow: async () => null,
        create: async (v) => ({ ...v, id: "case-NEW" }) as schema.InfectionOutbreakCase,
      },
      outbox: {
        emitOutbreakOpened: async (p) => {
          calls.push(`opened:${p.caseId}:${p.eventCount}`);
        },
      },
    };
    const result = await handleOutbreakDetection(
      { jobId: "j1", organizationId: "org-1", surveillanceEventId: "e3" },
      ports,
    );
    expect(result).toMatchObject({ outcome: "detected", casesOpened: 1 });
    expect(calls).toEqual(["opened:case-NEW:3"]);
  });

  it("dedupes against an existing uq_outbreak_window (idempotent skip)", async () => {
    const calls: string[] = [];
    const ports: OutbreakDetectionPorts = {
      processingLog: { isProcessed: async () => false, markProcessed: async () => {} },
      events: { recentForOrg: async () => makeEvents() },
      cases: {
        findByWindow: async () => ({ id: "case-EXISTING" }) as schema.InfectionOutbreakCase,
        create: async () => {
          calls.push("create");
          return {} as schema.InfectionOutbreakCase;
        },
      },
      outbox: { emitOutbreakOpened: async () => calls.push("emit") },
    };
    const result = await handleOutbreakDetection(
      { jobId: "j2", organizationId: "org-1", surveillanceEventId: "e3" },
      ports,
    );
    expect(result).toMatchObject({ casesOpened: 0 });
    expect(calls).toEqual([]);
  });
});

describe("cahpsExportProcessor terminal-failure path", () => {
  function failingPorts(attempt: number): { ports: CahpsExportPorts; calls: string[] } {
    const calls: string[] = [];
    const ports: CahpsExportPorts = {
      processingLog: { isProcessed: async () => false, markProcessed: async () => {} },
      adapters: {
        resolve: () =>
          ({
            vendor: "SHP",
            renderExport: async () => {
              throw new Error("vendor render boom");
            },
            pushExport: async () => ({ status: "no_push", reason: "x" }),
            validateConfig: async () => ({ ok: true }),
            parseResultIngest: async () => [],
            minimumCellSize: () => 30,
          }) as unknown as ReturnType<CahpsExportPorts["adapters"]["resolve"]>,
      },
      samples: {
        listPendingForCycle: async () => [{ id: "s1" }] as unknown as schema.CahpsDecedentSample[],
        markExported: async () => calls.push("markExported"),
        markExportFailed: async (id) => calls.push(`markExportFailed:${id}`),
      },
      decrypt: { toVendorRow: async () => ({}) as never },
      bindingConfig: { load: async () => ({}) },
      outbox: {
        emitExportCompleted: async () => calls.push("completed"),
        emitExportFailed: async () => calls.push("failed"),
      },
      maxAttempts: 4,
      now: () => new Date("2026-04-02T02:00:00Z"),
    };
    void attempt;
    return { ports, calls };
  }

  it("rethrows WITHOUT marking export_failed on a non-terminal attempt", async () => {
    const { ports, calls } = failingPorts(0);
    await expect(
      handleCahpsExport(
        {
          jobId: "j",
          organizationId: "org-1",
          samplingCycleMonth: "2026-03-01",
          samplePeriodStart: "2026-03-01",
          samplePeriodEnd: "2026-03-31",
          vendorBindingId: "vb-1",
          attempt: 0,
        },
        ports,
      ),
    ).rejects.toThrow(/CAHPS export/);
    expect(calls).toEqual([]); // no export_failed, no event on a retryable attempt
  });

  it("marks export_failed + emits on the §4.8 terminal attempt, then rethrows for the DLQ", async () => {
    const { ports, calls } = failingPorts(3);
    await expect(
      handleCahpsExport(
        {
          jobId: "j",
          organizationId: "org-1",
          samplingCycleMonth: "2026-03-01",
          samplePeriodStart: "2026-03-01",
          samplePeriodEnd: "2026-03-31",
          vendorBindingId: "vb-1",
          attempt: 3,
        },
        ports,
      ),
    ).rejects.toThrow(/CAHPS export/);
    expect(calls).toContain("markExportFailed:s1");
    expect(calls).toContain("failed");
  });
});

describe("cron decision cores (pure)", () => {
  it("priorCalendarMonthPeriod returns the whole previous month", () => {
    expect(priorCalendarMonthPeriod(new Date("2026-03-02T02:00:00Z"))).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
    });
  });

  it("decideSraReminder fires the matching milestone alert", () => {
    const now = new Date("2026-01-01T09:00:00Z");
    const due90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    expect(decideSraReminder(due90, now)).toMatchObject({
      kind: "milestone",
      payloadType: "m30.alerts.sra_due_90",
      daysRemaining: 90,
    });
  });

  it("decideSraReminder folds the 7-day milestone into the HIGH sra_due_30 alert", () => {
    const now = new Date("2026-01-01T09:00:00Z");
    const due7 = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(decideSraReminder(due7, now)).toMatchObject({
      payloadType: "m30.alerts.sra_due_30",
      daysRemaining: 7,
    });
  });

  it("decideSraReminder escalates past the anniversary to sra_overdue", () => {
    const now = new Date("2026-01-10T09:00:00Z");
    const due = new Date("2026-01-01T09:00:00Z");
    expect(decideSraReminder(due, now)).toMatchObject({
      kind: "overdue",
      payloadType: "m30.alerts.sra_overdue",
    });
  });

  it("decideSraReminder is quiet on a non-milestone day", () => {
    const now = new Date("2026-01-01T09:00:00Z");
    const due45 = new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000);
    expect(decideSraReminder(due45, now)).toEqual({ kind: "none" });
  });

  it("runNightlyRecompute fans out across every active org", async () => {
    const report = await runNightlyRecompute({
      orgs: { listActiveOrgs: async () => [{ organizationId: "o1" }, { organizationId: "o2" }] },
      enqueue: { enqueueForOrg: async () => ({ enqueued: 3 }) },
      now: () => new Date("2026-04-02T03:15:00Z"),
    });
    expect(report).toMatchObject({ orgsProcessed: 2, totalEnqueued: 6 });
  });
});

function makeMeasureJob() {
  return {
    jobId: "job-1",
    organizationId: "org-1",
    providerEntityId: "pe-1",
    measureCode: "hci_composite",
    periodStart: "2025-04-01",
    periodEnd: "2026-04-01",
    reason: "nightly_cron",
    computeVersion: "0.1.0",
  };
}
