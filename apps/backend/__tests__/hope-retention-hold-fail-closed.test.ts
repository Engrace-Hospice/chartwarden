import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type M10WorkerDeps, runHopeRetentionCron } from "../src/modules/10-hope/jobs/cron-workers";
import {
  HopeLegalHoldUnreadableError,
  hopeRetentionFactsForOrg,
} from "../src/modules/10-hope/jobs/retention-store";
import { scriptedDb } from "./_hope-g3-fake-db";

// A legal hold that names a patient with something that is no uuid must not be read as "that patient is not held": the
// organisation's scan fails closed (nothing flagged, nothing published) and the cron carries on with the other
// organisations. Real retention store over a scripted database (no Postgres); the same case against real Postgres is in
// m10-hope-retention.live.test.ts.
const ORG_HELD = "11111111-1111-4111-8111-111111111111";
const ORG_OK = "22222222-2222-4222-8222-222222222222";
const CORRUPT_VALUE = "SECRET-HOLD-VALUE";
const NOW = new Date("2026-11-15T00:00:00.000Z");

let warn: MockInstance;
let error: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});
const logged = (spy: MockInstance): string =>
  spy.mock.calls.map((call) => String(call[0])).join("\n");

describe("hopeRetentionFactsForOrg — a hold id that is no uuid fails the organisation closed", () => {
  it("throws before reading anything, and logs the organisation and the count, never the value", async () => {
    const { tx, statements } = scriptedDb([]);

    await expect(
      hopeRetentionFactsForOrg(tx, ORG_HELD, new Set([CORRUPT_VALUE, "also-not-a-uuid"])),
    ).rejects.toBeInstanceOf(HopeLegalHoldUnreadableError);

    expect(statements).toEqual([]);
    expect(logged(warn)).toContain("2 legal-hold patient id(s)");
    expect(logged(warn)).toContain(ORG_HELD);
    expect(logged(warn)).not.toContain(CORRUPT_VALUE);
  });

  it("a hold whose ids are all readable still scans, with nothing logged", async () => {
    const { tx } = scriptedDb([[], []]);

    await expect(
      hopeRetentionFactsForOrg(tx, ORG_HELD, new Set(["abcdef01-2345-4678-89ab-cdef01234567"])),
    ).resolves.toEqual([]);

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("hope-retention-scan — one organisation's unreadable hold does not stop the others", () => {
  it("flags and publishes nothing for that organisation, scans the next, and fails the run naming only the organisation", async () => {
    // Only the readable organisation reads: its assessments, its submission items, its ledger rows.
    const { db, statements } = scriptedDb([[], [], []]);
    const publish = vi.fn(async () => undefined);
    const deps = {
      connection: {} as never,
      db,
      outbox: { publish },
      activeOrgs: {
        listActiveOrgs: async () => [{ organizationId: ORG_HELD }, { organizationId: ORG_OK }],
      },
      retentionHolds: {
        activeLegalHoldScopeForOrg: async (org: string) => ({
          orgWide: false,
          patientIds: new Set(org === ORG_HELD ? [CORRUPT_VALUE] : []),
        }),
      },
      now: () => NOW,
    } as unknown as M10WorkerDeps;

    const run = runHopeRetentionCron(deps);

    await expect(run).rejects.toBeInstanceOf(AggregateError);
    await expect(run).rejects.toMatchObject({
      errors: [expect.any(HopeLegalHoldUnreadableError)],
      message: expect.stringMatching(/1 organization\(s\) failed/),
    });
    expect(publish).not.toHaveBeenCalled();
    // Three reads, all the readable organisation's; the held organisation's transaction wrote nothing.
    expect(statements.filter((s) => s.kind === "select")).toHaveLength(3);
    expect(statements.some((s) => s.kind === "insert" || s.kind === "update")).toBe(false);
    expect(logged(error)).toContain("hope-retention-scan");
    expect(logged(error)).toContain(ORG_HELD);
    expect(logged(error)).toContain("HopeLegalHoldUnreadableError");
    expect(logged(error)).not.toContain(ORG_OK);
    expect(logged(error)).not.toContain(CORRUPT_VALUE);
    expect(logged(warn)).not.toContain(CORRUPT_VALUE);
  });
});
