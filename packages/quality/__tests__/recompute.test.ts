// @wardenx/quality — §4.8 measure-recompute END-TO-END + worker fail-closed UNIT TESTS (M30 §7.1 / §3.1 /
// §4.8 / V-8 / D2). The companion to `workers.test.ts`: where that file drives the recompute worker with a
// hand-rolled `trivialRegistration`, THIS file drives it through the REAL `buildMeasureRegistry()` binding
// (the Registry-binding phase) so the test exercises the actual catalog→calculator wiring the composition
// root ships — a recompute resolves a CONCRETE pure calculator by measure code, runs it over injected
// input, and persists the right rate/band/threshold verdict. It then smoke-tests the other three §4.8
// processors (cahps_export / outbreak_detection / risk_register_refresh) on their happy path AND on the
// fail-closed path where a genuinely-unbound platform port (the M1 envelope-DEK decrypt / the transactional
// outbox emit) is exercised by a running job — proving it THROWS rather than silently completing.
//
// PURE port-injected, NO DB / Valkey / BullMQ — every fact + effect is an in-memory recording fake (the
// M33 `refresh.test.ts` / M34 `shred-worker.test.ts` template). Stays green under the default `bun run test`.
import type { schema } from "@wardenx/db";
import {
  type CahpsExportPorts,
  M30WorkerPortUnbound,
  MEASURE_CATALOG,
  type MeasureRecomputeJob,
  type MeasureRecomputePorts,
  MeasureRegistrationMissing,
  type OutbreakDetectionPorts,
  type RiskRegisterRefreshPorts,
  buildMeasureRegistry,
  computeVisitOnTimeRate,
  handleCahpsExport,
  handleMeasureRecompute,
  handleOutbreakDetection,
  handleRiskRegisterRefresh,
  unboundWorkerPort,
} from "@wardenx/quality";
import { describe, expect, it } from "vitest";

// ── shared in-memory recompute harness (drives the REAL registry) ───────────────────────────────────────

const NOW = new Date("2026-04-02T03:15:00Z");

/** A minimal live-HOPE consumer stub (the recompute ports require it; the operational families ignore it). */
const hopeStub = {
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
} as unknown as MeasureRecomputePorts["hope"];

/**
 * Build the recompute ports over the REAL `buildMeasureRegistry()` plus a stateful in-memory value store, a
 * `processing_log` Set, and a content-addressed `hashSnapshot` (`JSON.stringify`) so a replay over identical
 * input genuinely content-hashes to the SAME row (the V-8 idempotency proof is real, not stubbed-equal).
 * `resolveInput` returns whatever the test injects as the calculator's already-fetched population input.
 */
function makeRecomputeHarness(injectInput: (registration: { code: string }) => unknown) {
  const processed = new Set<string>();
  const rows: schema.QualityMeasureValue[] = [];
  const emits: { value: unknown[]; breach: unknown[] } = { value: [], breach: [] };
  let seq = 0;

  const isCurrent = (r: schema.QualityMeasureValue) =>
    (r as unknown as { supersededBy: string | null }).supersededBy == null;

  const ports: MeasureRecomputePorts = {
    processingLog: {
      isProcessed: async (jobId) => processed.has(jobId),
      markProcessed: async (jobId) => {
        processed.add(jobId);
      },
    },
    registrations: buildMeasureRegistry(),
    hope: hopeStub,
    data: {
      resolveInput: async (req) => injectInput(req.registration),
    },
    values: {
      findCurrent: async (measureCode, providerEntityId, periodStart, periodEnd) =>
        rows.find(
          (r) =>
            r.measureCode === measureCode &&
            r.providerEntityId === providerEntityId &&
            r.periodStart.getTime() === periodStart.getTime() &&
            r.periodEnd.getTime() === periodEnd.getTime() &&
            isCurrent(r),
        ) ?? null,
      insertValue: async (values) => {
        const row = { ...values, supersededBy: null } as unknown as schema.QualityMeasureValue;
        rows.push(row);
        return row;
      },
      supersede: async (id, supersededBy, supersededAt) => {
        const row = rows.find((r) => r.id === id);
        if (row !== undefined) {
          (row as unknown as { supersededBy: string | null; supersededAt: Date }).supersededBy =
            supersededBy;
          (row as unknown as { supersededBy: string | null; supersededAt: Date }).supersededAt =
            supersededAt;
        }
      },
    },
    outbox: {
      emitValueEmitted: async (p) => {
        emits.value.push(p);
      },
      emitThresholdBreached: async (p) => {
        emits.breach.push(p);
      },
    },
    hashSnapshot: (snapshot) => JSON.stringify(snapshot),
    newValueId: () => `value-${++seq}`,
    now: () => NOW,
  };
  return { ports, rows, emits, processed };
}

function makeJob(over: Partial<MeasureRecomputeJob> = {}): MeasureRecomputeJob {
  return {
    jobId: "job-1",
    organizationId: "org-1",
    providerEntityId: "pe-1",
    measureCode: "visit_on_time_rate",
    periodStart: "2025-04-01",
    periodEnd: "2026-04-01",
    reason: "nightly_cron",
    computeVersion: "0.1.0",
    ...over,
  };
}

const gteTarget = { value: 0.9, direction: "gte" } as const;

// ── measure-recompute END-TO-END through the real registry ──────────────────────────────────────────────

describe("handleMeasureRecompute — END-TO-END over buildMeasureRegistry()", () => {
  it("resolves the REAL visit_on_time_rate calculator and persists its rate/band/threshold verdict (green)", async () => {
    const { ports, rows, emits } = makeRecomputeHarness(() => ({
      organizationId: "org-1",
      providerEntityId: "pe-1",
      periodStart: "2025-04-01",
      periodEnd: "2026-04-01",
      scheduledVisits: 10,
      onTimeVisits: 9,
      threshold: gteTarget,
    }));

    const result = await handleMeasureRecompute(makeJob(), ports);

    // The worker output must equal what the REAL exported calculator computes for the same input (9/10 = 0.9
    // meets the 0.9 gte target ⇒ green / thresholdMet). This ties the recompute to the concrete calculator.
    const expected = computeVisitOnTimeRate({
      organizationId: "org-1",
      providerEntityId: "pe-1",
      periodStart: "2025-04-01",
      periodEnd: "2026-04-01",
      scheduledVisits: 10,
      onTimeVisits: 9,
      threshold: gteTarget,
    });
    expect(expected.bandColor).toBe("green");
    expect(result).toMatchObject({
      outcome: "recomputed",
      bandColor: "green",
      thresholdBreached: false,
    });

    expect(rows).toHaveLength(1);
    const persisted = rows[0]!;
    expect(persisted.measureCode).toBe("visit_on_time_rate");
    expect(persisted.numerator).toBe(9);
    expect(persisted.denominator).toBe(10);
    expect(persisted.ratio).toBe("0.9000"); // numeric(6,4) string, rate.toFixed(4)
    expect(persisted.thresholdMet).toBe(true);
    // The catalog-derived period rule flowed through the registration onto the row.
    expect(persisted.periodKind).toBe("rolling_12m_to_quarter");
    expect(persisted.calculatorVersion).toBe("0.1.0");

    // A fresh value with no prior current row emits value_emitted exactly once and never a threshold breach.
    expect(emits.value).toHaveLength(1);
    expect(emits.value[0]).toMatchObject({
      measureId: "visit_on_time_rate",
      bandColor: "green",
      rate: 0.9,
    });
    expect(emits.breach).toHaveLength(0);
  });

  it("fires the QAPI threshold breach on a red transition (rate below target, no prior)", async () => {
    const { ports, emits } = makeRecomputeHarness(() => ({
      organizationId: "org-1",
      providerEntityId: "pe-1",
      periodStart: "2025-04-01",
      periodEnd: "2026-04-01",
      scheduledVisits: 10,
      onTimeVisits: 5, // 0.5 < 0.9 ⇒ red
      threshold: gteTarget,
    }));

    const result = await handleMeasureRecompute(makeJob(), ports);
    expect(result).toMatchObject({
      outcome: "recomputed",
      bandColor: "red",
      thresholdBreached: true,
    });
    expect(emits.breach).toHaveLength(1);
    expect(emits.breach[0]).toMatchObject({
      measureId: "visit_on_time_rate",
      severityBand: "red",
      rate: 0.5,
    });
  });

  it("is V-8 idempotent end-to-end: a replay over identical input content-hashes to the same row, inserts nothing", async () => {
    const input = {
      organizationId: "org-1",
      providerEntityId: "pe-1",
      periodStart: "2025-04-01",
      periodEnd: "2026-04-01",
      scheduledVisits: 10,
      onTimeVisits: 9,
      threshold: gteTarget,
    };
    const { ports, rows } = makeRecomputeHarness(() => input);

    const first = await handleMeasureRecompute(makeJob({ jobId: "job-A" }), ports);
    expect(first).toMatchObject({ outcome: "recomputed" });
    expect(rows).toHaveLength(1);

    // Second job, SAME triple + SAME input → identical computationSnapshot → identical content-hash → no-op.
    const replay = await handleMeasureRecompute(makeJob({ jobId: "job-B" }), ports);
    expect(replay).toMatchObject({ outcome: "unchanged", measureCode: "visit_on_time_rate" });
    expect(rows).toHaveLength(1); // V-8: no duplicate row
    expect(rows[0]!.supersededBy).toBeNull(); // the original stays current
  });

  it("appends + supersedes when the recomputed input changes the snapshot", async () => {
    let onTime = 9;
    const { ports, rows } = makeRecomputeHarness(() => ({
      organizationId: "org-1",
      providerEntityId: "pe-1",
      periodStart: "2025-04-01",
      periodEnd: "2026-04-01",
      scheduledVisits: 10,
      onTimeVisits: onTime,
      threshold: gteTarget,
    }));

    await handleMeasureRecompute(makeJob({ jobId: "job-A" }), ports);
    onTime = 7; // the underlying facts moved → a new snapshot → a new current row
    const second = await handleMeasureRecompute(makeJob({ jobId: "job-B" }), ports);

    expect(second).toMatchObject({ outcome: "recomputed" });
    expect(rows).toHaveLength(2);
    const current = rows.find((r) => r.supersededBy === null);
    const superseded = rows.find((r) => r.supersededBy !== null);
    expect(current?.numerator).toBe(7);
    expect(superseded?.numerator).toBe(9);
    expect(superseded?.supersededBy).toBe(current?.id);
  });

  it("short-circuits a replay on the §4.8 processing_log guard BEFORE resolving a calculator (already_processed)", async () => {
    let resolved = false;
    const { ports, processed } = makeRecomputeHarness(() => {
      resolved = true;
      return {};
    });
    processed.add("job-1"); // a terminal processing_log row already exists for this job id
    const result = await handleMeasureRecompute(makeJob(), ports);
    expect(result).toEqual({ skipped: true, reason: "already_processed" });
    expect(resolved).toBe(false); // the guard short-circuits before the seam fetch + calculator
  });

  it("throws MeasureRegistrationMissing for a measure code with no catalog registration", async () => {
    const { ports } = makeRecomputeHarness(() => ({}));
    await expect(
      handleMeasureRecompute(makeJob({ measureCode: "not_a_real_measure" }), ports),
    ).rejects.toBeInstanceOf(MeasureRegistrationMissing);
  });

  it("binds every MEASURE_CATALOG code (no empty-map regression — the registry resolves each calculator)", () => {
    const registry = buildMeasureRegistry();
    expect(registry.size).toBe(MEASURE_CATALOG.length);
    for (const entry of MEASURE_CATALOG) {
      const reg = registry.get(entry.code);
      expect(reg, `missing registration for ${entry.code}`).toBeDefined();
      expect(typeof reg!.calculator).toBe("function");
      expect(reg!.calculatorVersion).toBe(entry.calculatorVersion);
      expect(reg!.periodKind).toBe(entry.periodKind);
    }
  });
});

// ── cahps_export smoke + PHI fail-closed ────────────────────────────────────────────────────────────────

describe("handleCahpsExport — smoke + fail-closed decrypt", () => {
  function pendingRows(): schema.CahpsDecedentSample[] {
    return [{ id: "s1" }, { id: "s2" }] as unknown as schema.CahpsDecedentSample[];
  }

  const okAdapter = {
    vendor: "SHP",
    renderExport: async () => ({ filename: "f.csv", body: "x", rowCount: 2 }),
    pushExport: async () => ({ status: "pushed", vendorJobId: "vj-1" }),
  } as unknown as ReturnType<CahpsExportPorts["adapters"]["resolve"]>;

  const job = {
    jobId: "j",
    organizationId: "org-1",
    samplingCycleMonth: "2026-03-01",
    samplePeriodStart: "2026-03-01",
    samplePeriodEnd: "2026-03-31",
    vendorBindingId: "vb-1",
    attempt: 0,
  };

  it("happy path: renders, pushes, stamps every sample row exported, and emits export_completed", async () => {
    const calls: string[] = [];
    const ports: CahpsExportPorts = {
      processingLog: { isProcessed: async () => false, markProcessed: async () => {} },
      adapters: { resolve: () => okAdapter },
      samples: {
        listPendingForCycle: async () => pendingRows(),
        markExported: async (id) => void calls.push(`exported:${id}`),
        markExportFailed: async (id) => void calls.push(`failed:${id}`),
      },
      decrypt: { toVendorRow: async () => ({}) as never },
      bindingConfig: { load: async () => ({}) },
      outbox: {
        emitExportCompleted: async (p) => void calls.push(`completed:${p.status}`),
        emitExportFailed: async () => void calls.push("failedEvt"),
      },
      now: () => NOW,
    };
    const result = await handleCahpsExport(job, ports);
    expect(result).toEqual({ outcome: "exported", exportedCount: 2, pushed: true });
    expect(calls).toEqual(["exported:s1", "exported:s2", "completed:pushed"]);
  });

  it("fail-closed: an UNBOUND envelope-DEK decrypt port throws (never exports un-decrypted PHI)", async () => {
    const calls: string[] = [];
    const ports: CahpsExportPorts = {
      processingLog: { isProcessed: async () => false, markProcessed: async () => {} },
      adapters: { resolve: () => okAdapter },
      samples: {
        listPendingForCycle: async () => pendingRows(),
        markExported: async (id) => void calls.push(`exported:${id}`),
        markExportFailed: async (id) => void calls.push(`failed:${id}`),
      },
      // The genuinely-missing M1 DEK helper is bound to a lazy fail-closed thunk (the §8 PHI guard).
      decrypt: {
        toVendorRow: async () =>
          unboundWorkerPort("cahps.decrypt", "M1 envelope-DEK helper unbound"),
      },
      bindingConfig: { load: async () => ({}) },
      outbox: {
        emitExportCompleted: async () => void calls.push("completed"),
        emitExportFailed: async () => void calls.push("failedEvt"),
      },
      maxAttempts: 4,
      now: () => NOW,
    };
    // A run with the decrypt port unbound throws rather than silently exporting; on a non-terminal attempt
    // it neither stamps rows exported nor emits completion (fail-closed, never silent).
    await expect(handleCahpsExport(job, ports)).rejects.toThrow(/CAHPS export/);
    expect(calls).not.toContain("exported:s1");
    expect(calls).not.toContain("completed:pushed");
  });
});

// ── outbreak_detection smoke + outbox fail-closed ───────────────────────────────────────────────────────

describe("handleOutbreakDetection — smoke + fail-closed outbox", () => {
  function cluster(): schema.InfectionSurveillanceEvent[] {
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

  it("happy path: opens a case for a fresh ≥3/14d cluster and emits outbreak_opened", async () => {
    const opened: string[] = [];
    const ports: OutbreakDetectionPorts = {
      processingLog: { isProcessed: async () => false, markProcessed: async () => {} },
      events: { recentForOrg: async () => cluster() },
      cases: {
        findByWindow: async () => null,
        create: async (v) => ({ ...v, id: "case-1" }) as schema.InfectionOutbreakCase,
      },
      outbox: { emitOutbreakOpened: async (p) => void opened.push(p.caseId) },
    };
    const result = await handleOutbreakDetection(
      { jobId: "j1", organizationId: "org-1", surveillanceEventId: "e3" },
      ports,
    );
    expect(result).toMatchObject({
      outcome: "detected",
      casesOpened: 1,
      openedCaseIds: ["case-1"],
    });
    expect(opened).toEqual(["case-1"]);
  });

  it("fail-closed: an UNBOUND outbox emit throws and leaves the job UNMARKED (so BullMQ retries, never silent)", async () => {
    let marked = false;
    const ports: OutbreakDetectionPorts = {
      processingLog: {
        isProcessed: async () => false,
        markProcessed: async () => {
          marked = true;
        },
      },
      events: { recentForOrg: async () => cluster() },
      cases: {
        findByWindow: async () => null,
        create: async (v) => ({ ...v, id: "case-1" }) as schema.InfectionOutbreakCase,
      },
      // The genuinely-missing transactional-outbox emit is a lazy fail-closed thunk.
      outbox: {
        emitOutbreakOpened: async () =>
          unboundWorkerPort("outbreak.outbox", "transactional outbox unbound"),
      },
    };
    await expect(
      handleOutbreakDetection(
        { jobId: "j2", organizationId: "org-1", surveillanceEventId: "e3" },
        ports,
      ),
    ).rejects.toBeInstanceOf(M30WorkerPortUnbound);
    expect(marked).toBe(false); // never stamps processing_log on the throw path → safe to replay
  });
});

// ── risk_register_refresh smoke + outbox fail-closed ────────────────────────────────────────────────────

describe("handleRiskRegisterRefresh — smoke + fail-closed outbox", () => {
  const emptySources = { sraFindings: [], incidents: [], qapiProjects: [], copStatuses: [] };

  it("happy path: REFRESHes the MV, reprojects the register, and emits risk_register.refreshed", async () => {
    const calls: string[] = [];
    const ports: RiskRegisterRefreshPorts = {
      processingLog: { isProcessed: async () => false, markProcessed: async () => {} },
      refresh: { refreshConcurrently: async (orgId) => void calls.push(`refresh:${orgId}`) },
      sources: { loadOpenRiskSources: async () => emptySources },
      outbox: { emitRefreshed: async (p) => void calls.push(`refreshed:${p.totalRows}`) },
      now: () => NOW,
    };
    const result = await handleRiskRegisterRefresh(
      { jobId: "j1", organizationId: "org-1", force: true },
      ports,
    );
    expect(result).toMatchObject({ outcome: "refreshed", totalRows: 0 });
    expect(calls).toEqual(["refresh:org-1", "refreshed:0"]);
  });

  it("fail-closed: an UNBOUND outbox emit throws and leaves the job UNMARKED", async () => {
    let marked = false;
    const ports: RiskRegisterRefreshPorts = {
      processingLog: {
        isProcessed: async () => false,
        markProcessed: async () => {
          marked = true;
        },
      },
      refresh: { refreshConcurrently: async () => {} },
      sources: { loadOpenRiskSources: async () => emptySources },
      outbox: {
        emitRefreshed: async () => unboundWorkerPort("risk.outbox", "transactional outbox unbound"),
      },
      now: () => NOW,
    };
    await expect(
      handleRiskRegisterRefresh({ jobId: "j2", organizationId: "org-1", force: true }, ports),
    ).rejects.toBeInstanceOf(M30WorkerPortUnbound);
    expect(marked).toBe(false);
  });
});
