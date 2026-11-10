// The sweep's two warning counts (receipts waiting under another key id; receipts that went terminal `failed` in the last
// day) run INSIDE the sweep's own transaction. A count that fails there must not abort the transaction and roll back every
// settlement the sweep just made, every minute: each runs in a savepoint, is logged by SQLSTATE or error class only, and counts as zero.
// And the failed-receipt summary goes through the alert sink ONCE when the count rises from zero, not every sweep.
import type { DbClient } from "@chartwarden/db";
import type { SQL } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  type ClaimMdRecentFailedDetail,
  type ClaimMdSweepDeps,
  createRecentFailedAlerter,
  runClaimMdWebhookSweep,
} from "./sweep";

const dialect = new PgDialect();
const NOW = new Date("2026-11-09T12:00:00.000Z");
const SECRET = "900-12-3456"; // synthetic: area 9xx is never issued

/**
 * The failure production sees: Drizzle 0.45 wraps the driver's error in a DrizzleQueryError whose `name` stays "Error" and whose
 * message embeds the query and its bound values; the SQLSTATE is on the cause.
 */
const databaseFailure = (sqlstate: string | undefined) => () =>
  new DrizzleQueryError(
    "select count(*) from claimmd_webhook_event where x = $1",
    [SECRET],
    Object.assign(new Error(`driver: ${SECRET}`), sqlstate ? { code: sqlstate } : {}),
  );

/** A transaction that answers every statement with no rows, throws on the ones matching `failOn`, and records its savepoints. */
function fakeTransaction(failOn: RegExp, failure: () => Error = databaseFailure("22012")) {
  let depth = 0;
  const ran: Array<{ sql: string; savepointDepth: number }> = [];
  const tx = {
    execute: async (query: SQL) => {
      const text = dialect.sqlToQuery(query).sql;
      ran.push({ sql: text, savepointDepth: depth });
      if (failOn.test(text)) throw failure();
      return { rows: [] };
    },
    transaction: async <T>(run: (sp: unknown) => Promise<T>): Promise<T> => {
      depth += 1;
      try {
        return await run(tx);
      } finally {
        depth -= 1;
      }
    },
  };
  return { tx, ran };
}

function deps(tx: unknown, extra: Partial<ClaimMdSweepDeps> = {}): ClaimMdSweepDeps {
  return {
    runner: async (fn) => fn(tx as DbClient),
    cipher: { keyId: "k1" } as never,
    entitlement: { isEntitled: async () => true },
    outbox: { publish: async () => undefined },
    now: () => NOW,
    ...extra,
  };
}

const RECENT_FAILED_COUNT = /processing_outcome = 'failed' AND processed_at >=/;
const OTHER_KEY_COUNT = /payload_key_ref IS DISTINCT FROM/;

describe("a failing warning count never aborts the sweep", () => {
  it.each([
    ["the recent-failed count", RECENT_FAILED_COUNT, "claimmd.webhook.recent_failed_count_failed"],
    ["the other-key count", OTHER_KEY_COUNT, "claimmd.webhook.unsettled_count_failed"],
  ])(
    "%s runs in a savepoint, is logged by error class only, and counts as zero",
    async (_label, failOn, event) => {
      const { tx, ran } = fakeTransaction(failOn);
      const logs: Array<{ event: string; detail: Record<string, unknown> }> = [];
      const warn = (e: string, detail: Record<string, unknown>) => logs.push({ event: e, detail });
      const result = await runClaimMdWebhookSweep(deps(tx, { warn }));
      expect(result).toEqual({ seen: 0, outcomes: {} }); // the sweep completed
      const failing = ran.find((r) => failOn.test(r.sql));
      expect(failing?.savepointDepth).toBe(1); // it ran inside a savepoint
      // the SQLSTATE off the wrapped cause, never the message (which embeds the query and its bound values)
      expect(logs).toEqual([{ event, detail: { errorClass: "22012" } }]);
      expect(JSON.stringify(logs)).not.toContain(SECRET);
    },
  );

  it.each([
    ["a wrapped driver error with no SQLSTATE", databaseFailure(undefined), "DrizzleQueryError"],
    [
      "a wrapped error whose code is not a SQLSTATE",
      databaseFailure("ECONNRESET"),
      "DrizzleQueryError",
    ],
    ["a bare error", () => new Error(`boom ${SECRET}`), "Error"],
    [
      "a bare error carrying a SQLSTATE",
      () => Object.assign(new Error("x"), { code: "40P01" }),
      "40P01",
    ],
    ["a non-error throw", () => "text" as unknown as Error, "Error"],
  ])("logs %s as its class name or SQLSTATE only", async (_label, failure, expected) => {
    const { tx } = fakeTransaction(RECENT_FAILED_COUNT, failure);
    const logs: Array<Record<string, unknown>> = [];
    await runClaimMdWebhookSweep(deps(tx, { warn: (_event, detail) => logs.push(detail) }));
    expect(logs).toEqual([{ errorClass: expected }]);
  });

  it("still runs the other count after one fails, and says nothing about a count it could not take (no zero that would re-arm the alert)", async () => {
    const { tx, ran } = fakeTransaction(RECENT_FAILED_COUNT);
    const seen: ClaimMdRecentFailedDetail[] = [];
    await runClaimMdWebhookSweep(
      deps(tx, { warn: () => undefined, onRecentFailedCount: (d) => seen.push(d) }),
    );
    expect(ran.some((r) => OTHER_KEY_COUNT.test(r.sql))).toBe(true);
    expect(seen).toEqual([]);
  });

  it("reports every sweep's recent-failed count (zero included) to onRecentFailedCount, after the transaction", async () => {
    const { tx } = fakeTransaction(/never matches/);
    const seen: ClaimMdRecentFailedDetail[] = [];
    await runClaimMdWebhookSweep(deps(tx, { onRecentFailedCount: (d) => seen.push(d) }));
    await runClaimMdWebhookSweep(deps(tx, { onRecentFailedCount: (d) => seen.push(d) }));
    expect(seen).toHaveLength(2);
  });

  it("a throwing onRecentFailedCount is logged by sink name and never fails the sweep", async () => {
    const { tx } = fakeTransaction(/never matches/);
    const logs: string[] = [];
    await expect(
      runClaimMdWebhookSweep(
        deps(tx, {
          log: (event) => logs.push(event),
          onRecentFailedCount: () => {
            throw new Error("sink down");
          },
        }),
      ),
    ).resolves.toEqual({ seen: 0, outcomes: {} });
    expect(logs).toContain("claimmd.webhook.alert_sink_failed");
  });
});

describe("createRecentFailedAlerter: one summary when the count rises from zero", () => {
  const detail = (count: number): ClaimMdRecentFailedDetail => ({
    count,
    oldestProcessedAt: count > 0 ? "2026-11-09T11:00:00.000Z" : null,
    windowHours: 24,
  });

  it("alerts the first time it sees failures (a restarted process included), then stays quiet while they persist", () => {
    const sent: ClaimMdRecentFailedDetail[] = [];
    const alert = createRecentFailedAlerter((d) => sent.push(d));
    alert(detail(3));
    alert(detail(3));
    alert(detail(5)); // more failures: each already had its own per-receipt alert
    expect(sent).toEqual([detail(3)]);
  });

  it("stays silent while there is nothing, and alerts again after the count has returned to zero", () => {
    const sent: number[] = [];
    const alert = createRecentFailedAlerter((d) => sent.push(d.count));
    alert(detail(0));
    alert(detail(0));
    expect(sent).toEqual([]);
    alert(detail(2));
    alert(detail(2));
    alert(detail(0)); // the 24-hour window passed
    alert(detail(1));
    expect(sent).toEqual([2, 1]);
  });

  it("does not call the sink every minute: 60 sweeps with failures make one call", () => {
    let calls = 0;
    const alert = createRecentFailedAlerter(() => {
      calls += 1;
    });
    for (let minute = 0; minute < 60; minute += 1) alert(detail(1));
    expect(calls).toBe(1);
  });

  it("a sink that throws is not retried every sweep (at most once, like the per-receipt alert)", () => {
    let calls = 0;
    const alert = createRecentFailedAlerter(() => {
      calls += 1;
      throw new Error("sink down");
    });
    expect(() => alert(detail(1))).toThrow("sink down");
    alert(detail(1));
    expect(calls).toBe(1);
  });
});
