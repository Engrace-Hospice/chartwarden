import type { DbClient } from "@chartwarden/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  openHopeSchedulesForOrg,
  recentlyExpiredSchedulesForOrg,
  sfvsToReplayAlertsForOrg,
  updateHopeScheduleStatus,
} from "../src/modules/10-hope/jobs/cron-store";

type Sql = Parameters<PgDialect["sqlToQuery"]>[0];

/** A tx whose query chain records the SQL of `where` / `orderBy`, and resolves the scripted rows. */
function recordingTx(rows: unknown[] = []) {
  const dialect = new PgDialect();
  const seen = { where: "", params: [] as unknown[], orderBy: "" };
  const link: Record<string, unknown> = {
    // biome-ignore lint/suspicious/noThenProperty: a Drizzle query chain is awaited at a different link per query
    then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
  };
  for (const name of ["from", "leftJoin", "limit", "set", "returning"]) link[name] = () => link;
  link.where = (condition: Sql) => {
    const query = dialect.sqlToQuery(condition);
    seen.where = query.sql;
    seen.params = query.params;
    return link;
  };
  link.orderBy = (...order: Sql[]) => {
    seen.orderBy = order.map((o) => dialect.sqlToQuery(o).sql).join(", ");
    return link;
  };
  const tx = { select: () => link, update: () => link } as unknown as DbClient;
  return { tx, seen };
}

describe("the window watchdog's store", () => {
  it("reads its snapshot in id order, so overlapping ticks flip rows in one order", async () => {
    const { tx, seen } = recordingTx();

    await openHopeSchedulesForOrg(tx, "org-1");

    expect(seen.orderBy).toMatch(/"hope_timepoint_schedule"\."id" asc/);
  });

  it("flips a schedule only while it is still open, and reports a lost race as false", async () => {
    const { tx, seen } = recordingTx([]);

    await expect(updateHopeScheduleStatus(tx, "sched-1", "expired")).resolves.toBe(false);

    expect(seen.where).toMatch(/"status" = \$\d+/);
    expect(seen.params).toContain("open");
    expect(seen.params).not.toContain("completed");
  });

  it("reports a written flip as true", async () => {
    const { tx } = recordingTx([{ id: "sched-1" }]);

    await expect(updateHopeScheduleStatus(tx, "sched-1", "expired")).resolves.toBe(true);
  });

  it("replays only schedules expired since the window start, in id order", async () => {
    const { tx, seen } = recordingTx();

    await recentlyExpiredSchedulesForOrg(tx, "org-1", new Date("2026-06-01T00:00:00.000Z"));

    expect(seen.where).toMatch(/"status" = \$\d+/);
    expect(seen.params).toContain("expired");
    expect(seen.where).toMatch(/"updated_at" >= \$\d+/);
    expect(seen.orderBy).toMatch(/"id" asc/);
  });
});

describe("the SFV watchdog's alert replay", () => {
  it("re-plans from every overdue SFV and every missed one since the window start, in id order", async () => {
    const { tx, seen } = recordingTx();

    await sfvsToReplayAlertsForOrg(tx, "org-1", new Date("2026-06-01T00:00:00.000Z"));

    expect(seen.params).toEqual(expect.arrayContaining(["overdue", "missed"]));
    expect(seen.where).toMatch(
      /"status" = \$\d+ or \(.*"status" = \$\d+ and .*"updated_at" >= \$\d+\)/,
    );
    expect(seen.orderBy).toMatch(/"id" asc/);
  });
});
