// The deadline tracker must keep counting for a tenant that files outside ChartWarden (owner decision D4): the window watch and
// the DDE watchdog still return a notice parked as `pending` and one nobody marked, and stop returning one the tenant recorded
// as `filed`. No database here: the repositories run against a stub that captures the WHERE clause, rendered to SQL. The rows
// themselves are proven on a real database in the live suite (`test:m23:noe-draft:live`, `test:m23:dde-queue:live`).
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { NoeRepository, NotrRepository } from "../src/repositories";

interface Captured {
  sql: string;
}

function captureWhere(run: (db: never) => Promise<unknown>): Promise<Captured> {
  const dialect = new PgDialect();
  const captured: Captured = { sql: "" };
  const chain = {
    from: () => chain,
    where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      captured.sql = dialect.sqlToQuery(condition).sql;
      return chain;
    },
    orderBy: () => chain,
    limit: async () => [],
  };
  return run({ select: () => chain } as never).then(() => captured);
}

// `x <> 'filed'` would drop every NULL (unmarked) row: only IS DISTINCT FROM keeps pending and unmarked notices.
const EXCLUDES_FILED_KEEPS_NULL = /"external_filing_status" is distinct from 'filed'/i;

describe("the deadline tracker and external filing", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const cases = [
    [
      "NOE window watch",
      (db: never) => new NoeRepository(db).listWindowWatchCandidates(ORG, "2026-11-05"),
    ],
    [
      "NOE DDE watch",
      (db: never) => new NoeRepository(db).listDdeWatchCandidates(ORG, "2026-11-08"),
    ],
    [
      "NOTR window watch",
      (db: never) => new NotrRepository(db).listWindowWatchCandidates(ORG, "2026-11-05"),
    ],
    [
      "NOTR DDE watch",
      (db: never) => new NotrRepository(db).listDdeWatchCandidates(ORG, "2026-11-08"),
    ],
  ] as const;

  it.each(cases)(
    "%s drops a notice recorded as filed, and keeps pending and unmarked ones",
    async (_name, run) => {
      const { sql } = await captureWhere(run);
      expect(sql).toMatch(EXCLUDES_FILED_KEEPS_NULL);
      expect(sql).not.toMatch(/"external_filing_status" (=|<>|!=|in|not in) /i);
    },
  );
});
