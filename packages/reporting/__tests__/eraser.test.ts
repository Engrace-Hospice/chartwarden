// @wardenx/reporting — tenant-offboarding ERASER UNIT TESTS (M33 §3.7 / D6 / D9 / §8.6 / W-R-11).
//
// The M4 destruction-registry eraseFn (`eraseTenantReporting`) is PURE port-injected orchestration over an
// injected store; these suites drive it with in-memory recording fakes (the M34 `shred-worker.test.ts`
// template — a `const calls: string[] = []` trail). They prove the §3.7 destruction invariants:
//   • `report_drilldown_audit` (retention class `compliance`, survey evidence — D9) is destruction-BLOCKED:
//     its rows are COUNTED into `complianceClassRefused`, never deleted (`tableCounts.report_drilldown_audit`=0);
//   • `materialized_view_metadata` + the platform catalogs (`report_base_catalog` / `report_metric_catalog`)
//     are shared reference data — a single-tenant offboard NEVER drops them (migration-retired only);
//   • the operational tables are deleted in the §3.7 FK-safe order (asserted via the recorded call trail);
//   • the §3.7 org-offboarding co-sign gate refuses a certificate lacking a `compliance_officer` approver.
import {
  EraseRefused,
  type ReportingEraseStore,
  createInMemoryReportingEraseStore,
  eraseTenantReporting,
} from "@wardenx/reporting";
import { describe, expect, it } from "vitest";

const ORG = "00000000-0000-0000-0000-0000000000aa";

/** Seeded per-table operational counts (+ the compliance-class drilldown-audit floor). */
const SEED = {
  counts: {
    [ORG]: {
      report_schedule: 2,
      report_schedule_run: 9,
      report_run: 40,
      dashboard_tile_cache: 17,
      report_view: 5,
      report_share: 3,
      report_definition: 4,
      report_definition_version: 11,
      report_drilldown_audit: 123, // compliance class — must be REFUSED, never deleted
    },
  },
} as const;

/** Wrap a store with a `calls[]` trail so the §3.7 sequence is assertable (delegates to the in-memory store). */
function makeRecordingStore(seed = SEED) {
  const { store, inspect } = createInMemoryReportingEraseStore(seed);
  const calls: string[] = [];
  const tap =
    <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      calls.push(name);
      return fn(...a);
    };
  const recording: ReportingEraseStore = {
    deleteSchedules: tap("deleteSchedules", store.deleteSchedules),
    deleteScheduleRuns: tap("deleteScheduleRuns", store.deleteScheduleRuns),
    deleteRuns: tap("deleteRuns", store.deleteRuns),
    deleteTileCache: tap("deleteTileCache", store.deleteTileCache),
    deleteViews: tap("deleteViews", store.deleteViews),
    deleteShares: tap("deleteShares", store.deleteShares),
    deleteDefinitions: tap("deleteDefinitions", store.deleteDefinitions),
    deleteDefinitionVersions: tap("deleteDefinitionVersions", store.deleteDefinitionVersions),
    countDrilldownAudit: tap("countDrilldownAudit", store.countDrilldownAudit),
    emitEraserComplete: store.emitEraserComplete
      ? tap("emitEraserComplete", store.emitEraserComplete)
      : undefined,
  };
  return { store: recording, inspect, calls };
}

describe("M33 §3.7 / D9 eraser — report_drilldown_audit is destruction-BLOCKED (compliance class)", () => {
  it("REFUSES to delete report_drilldown_audit — counts the rows, leaves the table count at 0", async () => {
    const { store } = makeRecordingStore();
    const result = await eraseTenantReporting(ORG, store);
    expect(result.complianceClassRefused).toBe(123); // the survey-evidence floor is reported, not destroyed
    expect(result.tableCounts.report_drilldown_audit).toBe(0); // NEVER deleted
  });

  it("the emitted `m33.tenant_eraser.complete` carries the per-table counts + the refused compliance count", async () => {
    const { store, inspect } = makeRecordingStore();
    await eraseTenantReporting(ORG, store);
    const completions = inspect.emittedCompletions();
    expect(completions).toHaveLength(1);
    expect(completions[0]!.complianceClassRefused).toBe(123);
    expect(completions[0]!.tableCounts.report_drilldown_audit).toBe(0);
  });
});

describe("M33 §3.7 eraser — materialized_view_metadata + the platform catalogs are LEFT UNTOUCHED", () => {
  it("never DROPS the MV registry or the shared catalogs (a single-tenant offboard touches neither)", async () => {
    const { store } = makeRecordingStore();
    const result = await eraseTenantReporting(ORG, store);
    // The MV registry is shared reference data — migration-retired only, never dropped on a tenant offboard.
    expect(result.tableCounts).not.toHaveProperty("materialized_view_metadata");
    // The platform catalogs are global reference data — out of the per-tenant erase scope entirely.
    expect(result.tableCounts).not.toHaveProperty("report_base_catalog");
    expect(result.tableCounts).not.toHaveProperty("report_metric_catalog");
  });
});

describe("M33 §3.7 eraser — the FK-safe deletion sequence", () => {
  it("deletes the operational tables in the §3.7 order, then COUNTS the compliance class LAST", async () => {
    const { store, calls } = makeRecordingStore();
    await eraseTenantReporting(ORG, store);
    const deleteSteps = calls.filter((c) => c !== "emitEraserComplete");
    expect(deleteSteps).toEqual([
      "deleteSchedules", // FIRST — stop future runs
      "deleteScheduleRuns",
      "deleteRuns",
      "deleteTileCache",
      "deleteViews",
      "deleteShares",
      "deleteDefinitions",
      "deleteDefinitionVersions",
      "countDrilldownAudit", // LAST — counted (not deleted), the compliance class
    ]);
    // The eraser-complete emit fires only after the whole sequence.
    expect(calls.indexOf("emitEraserComplete")).toBeGreaterThan(
      calls.indexOf("countDrilldownAudit"),
    );
  });

  it("the operational `erased` total sums every deleted table (excludes the refused compliance class)", async () => {
    const { store } = makeRecordingStore();
    const result = await eraseTenantReporting(ORG, store);
    // 2+9+40+17+5+3+4+11 = 91 operational rows; the 123 drilldown-audit rows are NOT in the total.
    expect(result.erased).toBe(91);
  });
});

describe("M33 §3.7 eraser — the org-offboarding compliance co-sign gate", () => {
  it("REFUSES an `org_offboarding` certificate without a `compliance_officer` approver", async () => {
    const { store } = makeRecordingStore();
    await expect(
      eraseTenantReporting(ORG, store, {
        decisionCert: { scope: "org_offboarding", approverIds: ["org_admin"] },
      }),
    ).rejects.toBeInstanceOf(EraseRefused);
    await expect(
      eraseTenantReporting(ORG, store, {
        decisionCert: { scope: "org_offboarding", approverIds: ["org_admin"] },
      }),
    ).rejects.toThrow(/compliance_class_destruction_needs_co_sign/);
  });

  it("PROCEEDS when the `org_offboarding` certificate carries a `compliance_officer` co-sign", async () => {
    const { store } = makeRecordingStore();
    const result = await eraseTenantReporting(ORG, store, {
      decisionCert: { scope: "org_offboarding", approverIds: ["org_admin", "compliance_officer"] },
    });
    expect(result.complianceClassRefused).toBe(123);
    expect(result.erased).toBe(91);
  });

  it("a non-offboarding scope needs no co-sign (operational erase proceeds unguarded)", async () => {
    const { store } = makeRecordingStore();
    const result = await eraseTenantReporting(ORG, store, {
      decisionCert: { scope: "tenant_cleanup", approverIds: [] },
    });
    expect(result.erased).toBe(91);
  });
});
