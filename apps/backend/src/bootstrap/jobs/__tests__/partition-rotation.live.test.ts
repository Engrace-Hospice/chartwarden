/**
 * F-033 / #93 — the time-partition rotation surface, proved against a real PostgreSQL.
 *
 * The pure severity rule is unit-tested in `partition-rotation.test.ts`. Everything interesting here is
 * behaviour of the DATABASE, and none of it can be asserted without one: whether rotation is genuinely
 * idempotent, whether the catalog scan finds every time-RANGE table including sub-partitions, and — the
 * one that motivated the whole change — what actually happens when a DEFAULT partition has already
 * started collecting rows.
 *
 * That last point is why this suite exists rather than a static fitness gate. `arch:fitness` runs where
 * there is no database, so a gate would have to derive the table→creator mapping by parsing migration
 * TEXT. The first attempt at this change did exactly that and silently missed 3 of the 43 tables (the
 * M29 `hl7_*` ones). `pg_catalog` cannot be wrong about the schema; a regex over 224 migration files
 * demonstrably can.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:partition-rotation:live
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("time-partition rotation — LIVE Postgres (F-033)", () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
  }, 60_000);

  afterAll(async () => {
    await db?.end();
  });

  // ── The real schema ───────────────────────────────────────────────────────────────────────────────

  it("discovers every time-RANGE partitioned table in the live schema, and each has a creator", async () => {
    const { rows } = await db.query<{
      table_name: string;
      has_creator: boolean;
      months_headroom: string;
    }>("SELECT table_name, has_creator, months_headroom FROM time_partition_coverage()");

    // Not a fixed count: the assertion is that the scan finds a real schema's worth of tables, so it
    // keeps holding as modules add partitioned tables. A count would need editing on every migration,
    // which is the maintenance burden this whole design exists to avoid.
    expect(rows.length).toBeGreaterThan(30);

    // The one that must never regress: a time-RANGE table nothing can extend is a DEFAULT-trap with no
    // remedy, and the cheapest moment to catch it is the migration that introduces it.
    const orphans = rows.filter((r) => !r.has_creator).map((r) => r.table_name);
    expect(orphans).toEqual([]);
  });

  it("rotates the real schema and is idempotent on the second run", async () => {
    await db.query("SELECT * FROM rotate_time_partitions(3)");
    const { rows } = await db.query<{ status: string; table_name: string }>(
      "SELECT table_name, status FROM rotate_time_partitions(3)",
    );
    // Second run over the same window: everything is already there, so nothing may be created and
    // nothing may fail. `CREATE TABLE IF NOT EXISTS` is what buys this, and it is the reason the job
    // can safely run three times a month instead of betting on one tick.
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.filter((r) => r.status !== "ok")).toEqual([]);
  });

  it("leaves at least the requested months of headroom on every table after a run", async () => {
    await db.query("SELECT * FROM rotate_time_partitions(3)");
    const { rows } = await db.query<{ table_name: string; months_headroom: string }>(
      "SELECT table_name, months_headroom FROM time_partition_coverage()",
    );
    const short = rows.filter((r) => Number(r.months_headroom) < 3);
    expect(short).toEqual([]);
  });

  it("refuses an out-of-range window rather than silently clamping it", async () => {
    await expect(db.query("SELECT rotate_time_partitions(0)")).rejects.toThrow(/between 1 and 24/);
    await expect(db.query("SELECT rotate_time_partitions(99)")).rejects.toThrow(/between 1 and 24/);
  });

  // ── The three statuses, on throwaway tables ───────────────────────────────────────────────────────
  //
  // Each runs inside a transaction that is rolled back, so the real schema is never mutated — these
  // create their own partitioned tables and creator functions to drive the paths that must never be
  // exercised on real data.

  async function inRollback(fn: () => Promise<void>): Promise<void> {
    await db.query("BEGIN");
    try {
      await fn();
    } finally {
      await db.query("ROLLBACK");
    }
  }

  const scaffold = (name: string) => `
    CREATE TABLE ${name} (id int, at timestamptz NOT NULL) PARTITION BY RANGE (at);
    CREATE TABLE ${name}_default PARTITION OF ${name} DEFAULT;
    CREATE OR REPLACE FUNCTION create_${name}_partition(start_date date) RETURNS void AS $f$
    DECLARE pn text; ed date;
    BEGIN
      pn := '${name}_' || to_char(start_date,'YYYY_MM');
      ed := start_date + INTERVAL '1 month';
      EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF ${name} FOR VALUES FROM (%L) TO (%L)', pn, start_date, ed);
    END; $f$ LANGUAGE plpgsql;`;

  it("reports 'created' for a table missing forward months, then 'ok'", async () => {
    await inRollback(async () => {
      await db.query(scaffold("wx_rot_created"));
      const first = await db.query<{ status: string; detail: string }>(
        "SELECT status, detail FROM rotate_time_partitions(3) WHERE table_name = 'wx_rot_created'",
      );
      expect(first.rows[0]?.status).toBe("created");
      expect(first.rows[0]?.detail).toContain("4 partition(s) added");

      const second = await db.query<{ status: string }>(
        "SELECT status FROM rotate_time_partitions(3) WHERE table_name = 'wx_rot_created'",
      );
      expect(second.rows[0]?.status).toBe("ok");
    });
  });

  it("a write past the coverage edge SUCCEEDS into DEFAULT — the failure the runbook mispredicted", async () => {
    await inRollback(async () => {
      await db.query(scaffold("wx_rot_default"));
      // No partition covers now(); the table has a DEFAULT. The runbook said this INSERT is rejected
      // ("a write-path outage on the affected table, not a slow query"). It is not rejected. It lands
      // in DEFAULT, which is why nothing ever surfaced the missing rotation job.
      await db.query("INSERT INTO wx_rot_default VALUES (1, now())");
      const { rows } = await db.query<{ n: string }>(
        "SELECT count(*) n FROM wx_rot_default_default",
      );
      expect(Number(rows[0]?.n)).toBe(1);
    });
  });

  it("reports 'blocked' once DEFAULT holds rows, because the partition can no longer be created", async () => {
    await inRollback(async () => {
      await db.query(scaffold("wx_rot_blocked"));
      await db.query("INSERT INTO wx_rot_blocked VALUES (1, now())");
      const { rows } = await db.query<{ status: string; detail: string }>(
        "SELECT status, detail FROM rotate_time_partitions(1) WHERE table_name = 'wx_rot_blocked'",
      );
      expect(rows[0]?.status).toBe("blocked");
      // The exact PostgreSQL refusal, kept verbatim in `detail` so an operator reading the job output
      // gets the real diagnosis rather than a paraphrase of it.
      expect(rows[0]?.detail).toContain("default partition");
      // And the probe flags it independently of the rotation run — this is the critical signal.
      const cov = await db.query<{ default_occupied: boolean }>(
        "SELECT default_occupied FROM time_partition_coverage() WHERE table_name = 'wx_rot_blocked'",
      );
      expect(cov.rows[0]?.default_occupied).toBe(true);
    });
  });

  it("one blocked table does not stop the other tables from rotating", async () => {
    await inRollback(async () => {
      await db.query(scaffold("wx_rot_blocked2"));
      await db.query(scaffold("wx_rot_healthy"));
      await db.query("INSERT INTO wx_rot_blocked2 VALUES (1, now())");
      const { rows } = await db.query<{ table_name: string; status: string }>(
        "SELECT table_name, status FROM rotate_time_partitions(2) " +
          "WHERE table_name IN ('wx_rot_blocked2','wx_rot_healthy')",
      );
      const byTable = Object.fromEntries(rows.map((r) => [r.table_name, r.status]));
      expect(byTable.wx_rot_blocked2).toBe("blocked");
      expect(byTable.wx_rot_healthy).toBe("created");
    });
  });

  it("reports 'no_creator' for a time-partitioned table nothing can extend", async () => {
    await inRollback(async () => {
      await db.query(
        "CREATE TABLE wx_rot_orphan (id int, at timestamptz NOT NULL) PARTITION BY RANGE (at)",
      );
      const { rows } = await db.query<{ status: string }>(
        "SELECT status FROM rotate_time_partitions(1) WHERE table_name = 'wx_rot_orphan'",
      );
      expect(rows[0]?.status).toBe("no_creator");
    });
  });

  it("scans a LIST→RANGE sub-partition, not only top-level parents", async () => {
    // The billing tables (claim, medicaid_claim, *_state_history, validation_*, rb_day) are LIST by
    // tenant with a monthly RANGE level underneath, created by the write path when a tenant first
    // writes. Those sub-levels need rotating exactly like a parent — and they do not exist until a
    // tenant does, which is the second reason this is a run-time catalog scan and not a fixed list.
    await inRollback(async () => {
      await db.query(`
        CREATE TABLE wx_rot_list (org uuid, at timestamptz NOT NULL) PARTITION BY LIST (org);
        CREATE TABLE wx_rot_sub PARTITION OF wx_rot_list
          FOR VALUES IN ('00000000-0000-0000-0000-000000000001') PARTITION BY RANGE (at);
        CREATE TABLE wx_rot_sub_default PARTITION OF wx_rot_sub DEFAULT;`);
      const { rows } = await db.query<{ table_name: string }>(
        "SELECT table_name FROM time_partition_coverage() WHERE table_name = 'wx_rot_sub'",
      );
      expect(rows).toHaveLength(1);
    });
  });
});
