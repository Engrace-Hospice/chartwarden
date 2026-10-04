// apps/backend/__tests__/m5-privacy-snapshot-rebuild.test.ts — M5 §4.5 `patient.snapshot_rebuild` (the
// quarterly PrivacyFlag snapshot rebuild, D3): the pure "does this re-derivation drift the row" decision the
// rebuild writes on, the cadence/queue catalog, and the per-org fan-out's failure isolation + counts-only
// summary. The per-org Drizzle rebuild (paging, per-patient transactions, RLS, events) is proven live in
// `m39-consent-privacy.live.test.ts`.
import { describe, expect, it } from "vitest";
import {
  M5_JOB_SCHEDULES,
  M5_QUEUES,
  M5_SNAPSHOT_REBUILD_PLATFORM_JOB_ID,
  M5_SNAPSHOT_REBUILD_QUEUE,
  M5_SNAPSHOT_REBUILD_SCHEDULE,
  NO_PART2_CONSENT,
  type Part2ConsentState,
  SnapshotRebuildPartialFailure,
  type SnapshotRebuildSummary,
  decideResync,
  runSnapshotRebuildFanout,
  snapshotNeedsWrite,
} from "../src/modules/05-patient/index";

const snap = (
  flags: string[],
  origin: string | null,
  scv: string | null = null,
  invalidatedAt: string | null = null,
) => ({
  flags,
  sudFlagOrigin: origin,
  sourceConsentVersion: scv,
  capturedAt: "2026-07-01T03:00:00.000Z",
  invalidatedAt,
});
const consent = (state: Part2ConsentState["state"], id = "c-1"): Part2ConsentState => ({
  ...NO_PART2_CONSENT,
  state,
  consentRecordId: state === "none" ? null : id,
  status: state === "active" ? "active" : state === "inactive" ? "expired" : null,
});
const detected = {
  batchId: "b-1",
  sudStatus: "detected" as const,
  batchStatus: "in_review",
  receivedAt: "2026-06-01T00:00:00.000Z",
  pageCount: 4,
  resolvedAt: null,
};

describe("snapshotNeedsWrite — the rebuild writes only drifted rows (M5 §4.5 'reconciles any drift')", () => {
  it("an in-sync DocLens flag with M39 silent is left untouched (never lifted, no write)", () => {
    const current = snap(["sud"], "m22_intake_unconfirmed");
    const d = decideResync(current, NO_PART2_CONSENT, [detected]);
    expect(d.flags).toEqual(["sud"]);
    expect(snapshotNeedsWrite(current, d)).toBe(false);
  });

  it("a DocLens flag whose detection was rejected is still kept while M39 is silent", () => {
    const current = snap(["sud"], "m22_intake_unconfirmed");
    const d = decideResync(current, NO_PART2_CONSENT, []);
    expect(d.flags).toEqual(["sud"]);
    expect(snapshotNeedsWrite(current, d)).toBe(false);
  });

  it("a consent-derived flag whose Part 2 release is now in force is lifted (write + flag change)", () => {
    const current = snap(["hiv", "sud"], null, "c-old");
    const d = decideResync(current, consent("active", "c-new"), []);
    expect(d.flags).toEqual(["hiv"]);
    expect(d.flagsChanged).toBe(true);
    expect(snapshotNeedsWrite(current, d)).toBe(true);
  });

  it("a stale snapshot is always rewritten (clears invalidated_at) even when its flags match", () => {
    const current = snap(["sud"], null, "c-1", "2026-09-30T00:00:00.000Z");
    const d = decideResync(current, consent("inactive", "c-1"), []);
    expect(d.flagsChanged).toBe(false);
    expect(snapshotNeedsWrite(current, d)).toBe(true);
  });

  it("an attribution-only drift (pending → confirmed detection) is written without a flag change", () => {
    const current = snap(["sud"], "m22_intake_unconfirmed");
    const d = decideResync(current, NO_PART2_CONSENT, [
      { ...detected, sudStatus: "confirmed", resolvedAt: "2026-06-02T00:00:00.000Z" },
    ]);
    expect(d).toMatchObject({ flagsChanged: false, sudFlagOrigin: "m22_intake_confirmed" });
    expect(snapshotNeedsWrite(current, d)).toBe(true);
  });

  it("a newer consent record id on the same lifted state is reconciled", () => {
    const current = snap([], null, "c-old");
    const d = decideResync(current, consent("active", "c-new"), []);
    expect(d.flagsChanged).toBe(false);
    expect(snapshotNeedsWrite(current, d)).toBe(true);
  });

  it("no row + nothing to record writes nothing (an absent row already means 'no flag')", () => {
    const d = decideResync(null, NO_PART2_CONSENT, []);
    expect(snapshotNeedsWrite(null, d)).toBe(false);
  });

  it("no row but M39 holds an expired release (a missed consent event) creates the restriction", () => {
    const d = decideResync(null, consent("inactive"), []);
    expect(d.flags).toEqual(["sud"]);
    expect(snapshotNeedsWrite(null, d)).toBe(true);
  });

  it("no row but a live DocLens detection re-applies the interim flag", () => {
    const d = decideResync(null, NO_PART2_CONSENT, [detected]);
    expect(d).toMatchObject({ flags: ["sud"], sudFlagOrigin: "m22_intake_unconfirmed" });
    expect(snapshotNeedsWrite(null, d)).toBe(true);
  });

  it("is idempotent: the row a write produces needs no second write", () => {
    const current = snap(["hiv"], null, null, "2026-09-30T00:00:00.000Z");
    const d1 = decideResync(current, consent("inactive", "c-9"), []);
    expect(snapshotNeedsWrite(current, d1)).toBe(true);
    const after = snap([...d1.flags], d1.sudFlagOrigin, d1.sourceConsentVersion);
    const d2 = decideResync(after, consent("inactive", "c-9"), []);
    expect(snapshotNeedsWrite(after, d2)).toBe(false);
  });
});

describe("patient.snapshot_rebuild cadence + queue (M5 §4.5 'scheduled (quarterly)')", () => {
  it("is quarterly — the 1st of Jan/Apr/Jul/Oct — on the m5 queue catalog", () => {
    expect(M5_SNAPSHOT_REBUILD_SCHEDULE).toBe("0 3 1 1,4,7,10 *");
    expect(M5_SNAPSHOT_REBUILD_SCHEDULE).toBe(M5_JOB_SCHEDULES.snapshotRebuild);
    expect(M5_SNAPSHOT_REBUILD_QUEUE).toBe(M5_QUEUES.snapshotRebuild);
    expect(M5_SNAPSHOT_REBUILD_PLATFORM_JOB_ID).toBe("m5.snapshot_rebuild");
  });
});

describe("runSnapshotRebuildFanout — per-org isolation, counts-only summary", () => {
  const summary = (organizationId: string, n: number): SnapshotRebuildSummary => ({
    organizationId,
    patients: n,
    rewritten: 1,
    flagsChanged: 1,
    staleCleared: 0,
    unchanged: n - 1,
    failed: 0,
  });

  it("rebuilds every active org and totals the counts", async () => {
    const seen: string[] = [];
    const logs: [string, Record<string, unknown>][] = [];
    const run = await runSnapshotRebuildFanout({
      activeOrgs: {
        listActiveOrgs: async () => [{ organizationId: "o1" }, { organizationId: "o2" }],
      },
      rebuildForOrg: async (org) => {
        seen.push(org);
        return summary(org, org === "o1" ? 5 : 3);
      },
      log: (msg, detail) => logs.push([msg, detail]),
    });
    expect(seen).toEqual(["o1", "o2"]);
    expect(run).toEqual({
      orgs: 2,
      patients: 8,
      rewritten: 2,
      flagsChanged: 2,
      staleCleared: 0,
      failedOrgs: 0,
    });
    // The run summary is logged, counts only (no patient ids, no flags).
    const json = JSON.stringify(logs);
    expect(logs.map(([m]) => m)).toContain("m5.privacy_snapshot.rebuild_run");
    expect(json).not.toMatch(/patientId|"sud"/);
  });

  it("one org's failure never skips the others, and the failures are re-raised together", async () => {
    const seen: string[] = [];
    const failed = new SnapshotRebuildPartialFailure([new Error("boom")], {
      ...summary("o1", 4),
      failed: 1,
    });
    await expect(
      runSnapshotRebuildFanout({
        activeOrgs: {
          listActiveOrgs: async () => [{ organizationId: "o1" }, { organizationId: "o2" }],
        },
        rebuildForOrg: async (org) => {
          seen.push(org);
          if (org === "o1") throw failed;
          return summary(org, 2);
        },
      }),
    ).rejects.toThrow(/M5_SNAPSHOT_REBUILD: 1 org failure/);
    expect(seen).toEqual(["o1", "o2"]);
  });
});
