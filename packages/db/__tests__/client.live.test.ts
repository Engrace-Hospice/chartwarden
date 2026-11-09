// packages/db/__tests__/client.live.test.ts — AUTH-T01 (ADR-0033) live-PG smoke.
// Skipped in the infra-free unit lane; runs when CHARTWARDEN_TEST_DATABASE_URL points at real Postgres
// (the rls-live env, or a local pg). Proves createDbClient actually opens a pooled connection.
// The dedicated auth/live CI lane that runs this end-to-end lands at AUTH-T06.
import { describe, expect, it } from "vitest";
import { type DbConnectionError, createDbClient } from "../src/client";

const url = process.env.CHARTWARDEN_TEST_DATABASE_URL;

function observedConnectionError(): {
  readonly promise: Promise<DbConnectionError>;
  readonly observe: (error: DbConnectionError) => void;
} {
  let resolve!: (error: DbConnectionError) => void;
  const promise = new Promise<DbConnectionError>((done) => {
    resolve = done;
  });
  return { promise, observe: resolve };
}

async function withinFiveSeconds<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("timed out waiting for the pg connection error")),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.skipIf(!url)("createDbClient — live Postgres connection (AUTH-T01)", () => {
  it("connects and runs SELECT 1", async () => {
    const handle = createDbClient({ connectionString: url as string });
    try {
      const res = await handle.pool.query("select 1 as ok");
      expect(res.rows[0]?.ok).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it("survives termination of an idle backend and replaces the connection", async () => {
    const observed = observedConnectionError();
    const victim = createDbClient({
      connectionString: url as string,
      max: 1,
      onConnectionError: observed.observe,
    });
    const killer = createDbClient({ connectionString: url as string, max: 1 });
    try {
      const pid = await victim.pool.query<{ pid: number }>("select pg_backend_pid() as pid");
      const backendPid = pid.rows[0]?.pid;
      if (!backendPid) throw new Error("the victim connection returned no backend pid");
      await killer.pool.query("select pg_terminate_backend($1)", [backendPid]);

      expect(await withinFiveSeconds(observed.promise)).toMatchObject({ source: "pool" });
      await expect(victim.pool.query("select 1 as ok")).resolves.toMatchObject({
        rows: [{ ok: 1 }],
      });
    } finally {
      await Promise.all([victim.close(), killer.close()]);
    }
  }, 15_000);

  it("survives termination of a checked-out backend and replaces the connection", async () => {
    const observed = observedConnectionError();
    const victim = createDbClient({
      connectionString: url as string,
      max: 1,
      onConnectionError: observed.observe,
    });
    const killer = createDbClient({ connectionString: url as string, max: 1 });
    const client = await victim.pool.connect();
    let released = false;
    try {
      const pid = await client.query<{ pid: number }>("select pg_backend_pid() as pid");
      const backendPid = pid.rows[0]?.pid;
      if (!backendPid) throw new Error("the checked-out connection returned no backend pid");
      await killer.pool.query("select pg_terminate_backend($1)", [backendPid]);

      expect(await withinFiveSeconds(observed.promise)).toMatchObject({
        source: "checked_out_client",
      });
      client.release(true);
      released = true;
      await expect(victim.pool.query("select 1 as ok")).resolves.toMatchObject({
        rows: [{ ok: 1 }],
      });
    } finally {
      if (!released) client.release(true);
      await Promise.all([victim.close(), killer.close()]);
    }
  }, 15_000);
});
