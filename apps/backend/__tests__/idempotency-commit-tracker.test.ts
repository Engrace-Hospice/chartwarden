/**
 * A retryable failure is released only when the request provably committed nothing.
 *
 * `idempotency-release.test.ts` proves a 5xx / the deadlock 409 frees the key when the handler failed BEFORE any write. This
 * proves the other half, the review's MEDIUM: a handler whose transaction COMMITTED and which then failed (a throwing post-commit
 * step, a second transaction that deadlocks, a response the serializer refuses) has written, so releasing the key would let a
 * same-key retry write twice. Those outcomes are cached and replayed exactly as before.
 *
 * The commit signal is the real pool instrumentation (`@chartwarden/db` instrumentPoolForCommits) over a fake pg pool that
 * behaves like pg-pool where it matters here (the `connect` event, promise and callback checkouts); the live proof against real
 * Postgres and the real createDbClient is in `gap-007-idempotency-claim.live.test.ts`.
 */
import { EventEmitter } from "node:events";
import {
  createCommitTracker,
  instrumentPoolForCommits,
  runWithCommitTracker,
} from "@chartwarden/db";
import { HopeStateError } from "@chartwarden/hope";
import type { IdempotencyStore } from "@chartwarden/shared";
import { ForbiddenError } from "@chartwarden/types";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import {
  applyIdempotency,
  createInMemoryIdempotencyStore,
} from "../src/bootstrap/plugins/idempotency";

const ORG = "00000000-0000-4000-8000-000000000001";

type Done = () => void;
type CheckoutCallback = (err: undefined, client: FakeClient, done: Done) => void;
type AnswerCallback = (err: Error | undefined, result?: { rows: unknown[] }) => void;
interface FakeClient {
  query: (arg: unknown, ...rest: unknown[]) => Promise<{ rows: unknown[] }> | undefined;
}

class FakePool extends EventEmitter {
  readonly sent: string[] = [];
  /** An error to answer a statement with (matched on its text), the way the server would. */
  failWith: (text: string) => Error | undefined = () => undefined;
  private readonly client: FakeClient = {
    query: (arg, ...rest) => {
      const text = typeof arg === "string" ? arg : String((arg as { text: string }).text);
      this.sent.push(text);
      const failure = this.failWith(text);
      const callback = rest[rest.length - 1];
      if (typeof callback === "function") {
        // pg-pool's `pool.query` and a checkout used with a callback: the answer arrives there, not as a promise.
        queueMicrotask(() =>
          failure
            ? (callback as AnswerCallback)(failure)
            : (callback as AnswerCallback)(undefined, { rows: [] }),
        );
        return undefined;
      }
      return failure ? Promise.reject(failure) : Promise.resolve({ rows: [] });
    },
  };
  private announced = false;
  private held: CheckoutCallback[] = [];

  connect(callback?: CheckoutCallback): Promise<FakeClient> | undefined {
    if (!this.announced) {
      this.announced = true;
      this.emit("connect", this.client); // like pg-pool: once per new client, before it is handed out
    }
    if (typeof callback === "function") {
      this.held.push(callback); // delivered by pulse(), possibly from ANOTHER async context (a queued checkout resuming)
      return undefined;
    }
    return Promise.resolve(this.client);
  }

  pulse(): void {
    for (const callback of this.held.splice(0)) callback(undefined, this.client, () => undefined);
  }

  inserts(): number {
    return this.sent.filter((s) => /^insert/i.test(s)).length;
  }
}

const deadlock = (): Error =>
  Object.assign(new Error("deadlock detected"), { code: "40P01", severity: "ERROR" });
const serverError = (code: string, severity = "ERROR"): Error =>
  Object.assign(new Error(`server error ${code}`), { code, severity });

/** A transaction as drizzle issues it: begin, the statements, commit. */
async function transaction(
  pool: FakePool,
  statements: string[],
  end: "commit" | "rollback" = "commit",
) {
  const client = (await pool.connect()) as FakeClient;
  await client.query("begin");
  for (const s of statements) await client.query(s);
  await client.query(end);
}

/** `pool.query(text, values, callback)`: how pg-pool answers an autocommit statement, awaited by the caller. */
function queryWithCallback(client: FakeClient, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.query(text, [], ((err?: Error) => (err ? reject(err) : resolve())) as never);
  });
}

describe("idempotency release needs proof that nothing committed", () => {
  let app: FastifyInstance;
  let pool: FakePool;
  let runs: number;
  let logLines: string[] = [];

  async function build(
    handler: (run: number, reply: import("fastify").FastifyReply) => unknown,
    extra?: (app: FastifyInstance) => void,
    schema?: object,
    makeStore?: (pool: FakePool) => IdempotencyStore,
  ): Promise<void> {
    runs = 0;
    pool = new FakePool();
    instrumentPoolForCommits(pool as never);
    logLines = [];
    app = Fastify({
      logger: { level: "warn", stream: { write: (line: string) => void logLines.push(line) } },
    });
    app.decorateRequest("context", undefined as never);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { context: unknown }).context = {
        organizationId: ORG,
        correlationId: "cid-test",
      };
    });
    applyErrorHandler(app);
    applyIdempotency(app, makeStore ? makeStore(pool) : createInMemoryIdempotencyStore());
    extra?.(app);
    app.post("/write", { ...(schema ? { schema } : {}) }, async (_request, reply) => {
      runs += 1;
      return handler(runs, reply);
    });
    await app.ready();
  }

  afterEach(async () => {
    await app?.close();
  });

  const post = (key = "key-1") =>
    app.inject({
      method: "POST",
      url: "/write",
      headers: { "idempotency-key": key },
      payload: { a: 1 },
    });

  it("(a) a handler that COMMITS a write and then throws a 500: the same-key retry replays, never writes again", async () => {
    await build(async () => {
      await transaction(pool, ["insert into t (n) values (1)"]);
      throw new Error("post-commit step failed");
    });
    expect((await post()).statusCode).toBe(500);
    const retry = await post();
    expect(retry.statusCode).toBe(500);
    expect(runs).toBe(1);
    expect(pool.inserts()).toBe(1);
  });

  it("(b) a handler that fails before any commit: the retry runs and can succeed", async () => {
    await build(async (run, reply) => {
      if (run === 1) {
        await transaction(pool, ["insert into t (n) values (1)"], "rollback"); // rolled back: nothing durable
        throw new Error("failed before commit");
      }
      await transaction(pool, ["insert into t (n) values (2)"]);
      return reply.code(201).send({ saved: true });
    });
    expect((await post()).statusCode).toBe(500);
    const retry = await post();
    expect(retry.statusCode).toBe(201);
    expect(runs).toBe(2);
  });

  it("(c) a commit followed by a 409 CONCURRENT_UPDATE from a SECOND transaction: cached, not released", async () => {
    await build(async () => {
      await transaction(pool, ["insert into t (n) values (1)"]); // the first transaction committed
      throw deadlock(); // the second one deadlocked
    });
    const first = await post();
    expect(first.statusCode).toBe(409);
    expect(first.json().error.code).toBe("CONCURRENT_UPDATE");
    const retry = await post();
    expect(retry.statusCode).toBe(409);
    expect(runs).toBe(1);
    expect(pool.inserts()).toBe(1);
  });

  it("(c3) a commit followed by a 409 M10_RECORD_BUSY from a LATER lock: cached, not released (the earlier step is durable)", async () => {
    await build(async () => {
      await transaction(pool, ["insert into t (n) values (1)"]); // e.g. a legacy draft's spec initialisation committed
      throw new HopeStateError("M10_RECORD_BUSY", "The record is busy."); // the next lock timed out
    });
    const first = await post();
    expect(first.statusCode).toBe(409);
    expect(first.json().error.code).toBe("M10_RECORD_BUSY");
    expect((await post()).statusCode).toBe(409);
    expect(runs).toBe(1);
    expect(pool.inserts()).toBe(1);
  });

  it("(c4) a commit followed by a 403 refusal: cached, not released (the write is durable, so a retry must not run it again)", async () => {
    await build(async () => {
      await transaction(pool, ["insert into t (n) values (1)"]);
      throw new ForbiddenError("a later check refused");
    });
    expect((await post()).statusCode).toBe(403);
    expect((await post()).statusCode).toBe(403);
    expect(runs).toBe(1);
    expect(pool.inserts()).toBe(1);
  });

  it("(c2) the deadlock of the ONLY transaction (nothing committed) is still released and retries", async () => {
    await build(async (run, reply) => {
      if (run === 1) {
        const client = (await pool.connect()) as FakeClient;
        await client.query("begin");
        await client.query("insert into t (n) values (1)");
        await client.query("rollback"); // the database aborted it
        throw deadlock();
      }
      await transaction(pool, ["insert into t (n) values (1)"]);
      return reply.code(201).send({ saved: true });
    });
    expect((await post()).statusCode).toBe(409);
    expect((await post()).statusCode).toBe(201);
    expect(runs).toBe(2);
  });

  it("(d) a response the serializer refuses AFTER the service committed: cached, the write is not run again", async () => {
    await build(
      async (_run, reply) => {
        await transaction(pool, ["insert into t (n) values (1)"]);
        return reply.code(201).send({}); // the required `id` is missing: the serializer throws
      },
      undefined,
      {
        response: {
          201: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        },
      },
    );
    expect((await post()).statusCode).toBe(500);
    expect((await post()).statusCode).toBe(500);
    expect(runs).toBe(1);
    expect(pool.inserts()).toBe(1);
  });

  it("(e) an autocommit write (no transaction block) counts as committed", async () => {
    await build(async () => {
      const client = (await pool.connect()) as FakeClient;
      await client.query("update t set n = 1");
      throw new Error("failed after an autocommit write");
    });
    await post();
    await post();
    expect(runs).toBe(1);
  });

  it("(f) read-only transactions and reads outside a transaction do not count: a guard's reads never block the release", async () => {
    await build(async (run, reply) => {
      await transaction(pool, [
        "select set_config('app.org_id', $1, true)",
        'select "id" from "t" for update',
      ]);
      const client = (await pool.connect()) as FakeClient;
      await client.query('select count(*) from "t"');
      if (run === 1) return reply.code(503).send({ error: { code: "DEGRADED" } });
      return reply.code(201).send({ saved: true });
    });
    expect((await post()).statusCode).toBe(503);
    expect((await post()).statusCode).toBe(201);
    expect(runs).toBe(2);
  });

  it("(g) a write committed BEFORE the claim (e.g. authentication touching a session) is not this request's write", async () => {
    await build(
      async (run, reply) => {
        if (run === 1) throw new Error("failed before any write of its own");
        return reply.code(201).send({ saved: true });
      },
      (instance) => {
        instance.addHook("onRequest", async () => {
          await transaction(pool, ["update session set last_seen = now()"]);
        });
      },
    );
    expect((await post()).statusCode).toBe(500);
    expect((await post()).statusCode).toBe(201);
    expect(runs).toBe(2);
  });

  it("(h) a checkout resumed from ANOTHER async context (a queued checkout) still names this request", async () => {
    await build(async () => {
      await new Promise<void>((resolve) => {
        pool.connect(async (_err, client) => {
          await client.query("insert into t (n) values (1)"); // autocommit, from the resumed callback
          resolve();
        });
      });
      throw new Error("failed after the write");
    });
    const pending = post();
    await new Promise((resolve) => setTimeout(resolve, 10));
    pool.pulse(); // runs the held callback from the test's context, where no tracker is ambient
    expect((await pending).statusCode).toBe(500);
    await post();
    expect(runs).toBe(1);
  });

  it("(j) the async context is LOST after the tracker opened: the writes go unseen, so the outcome is cached, never released", async () => {
    await build(
      async () => {
        await transaction(pool, ["insert into t (n) values (1)"]); // not attributed: no ambient tracker
        throw new Error("post-commit step failed");
      },
      (instance) => {
        // A later hook that continues the request OUTSIDE the tracker's store (a callback API that drops the context).
        instance.addHook("onRequest", (_request, _reply, done) => {
          runWithCommitTracker(undefined as never, () => done());
        });
      },
    );
    expect((await post()).statusCode).toBe(500);
    expect((await post()).statusCode).toBe(500);
    expect(runs).toBe(1);
    expect(pool.inserts()).toBe(1);
    // the fail-closed rule says so (a warning with the key and no payload), instead of silently caching every failure
    const warnings = logLines.filter((line) =>
      line.includes("commit tracker is not the ambient one"),
    );
    expect(warnings).toHaveLength(1); // the replay of the cached outcome never runs the handler
    expect(warnings.join("")).not.toContain('"a":1');
  });

  it("(k) the ambient tracker belongs to ANOTHER request: cached too", async () => {
    await build(
      async () => {
        await transaction(pool, ["insert into t (n) values (1)"]); // marks the other request's tracker, not this one's
        throw new Error("post-commit step failed");
      },
      (instance) => {
        instance.addHook("onRequest", (_request, _reply, done) => {
          runWithCommitTracker(createCommitTracker(), () => done());
        });
      },
    );
    await post();
    await post();
    expect(runs).toBe(1);
  });

  it("(l) a write still OPEN in another transaction when a sibling fails: cached, so its late COMMIT cannot land under a freed key", async () => {
    let commitSecondTransaction: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      commitSecondTransaction = resolve;
    });
    let secondTransaction: Promise<void> = Promise.resolve();
    await build(async () => {
      secondTransaction = (async () => {
        const client = (await pool.connect()) as FakeClient;
        await client.query("begin");
        await client.query("insert into t (n) values (1)"); // written, not committed
        await gate;
        await client.query("commit");
      })();
      while (pool.inserts() === 0) await new Promise((resolve) => setTimeout(resolve, 1)); // its INSERT has been issued
      throw deadlock(); // the other half of the Promise.all loses
    });
    const first = await post();
    expect(first.statusCode).toBe(409);
    expect(first.json().error.code).toBe("CONCURRENT_UPDATE");
    commitSecondTransaction(); // the COMMIT now lands, after the answer
    await secondTransaction;
    const retry = await post();
    expect(retry.statusCode).toBe(409); // the cached outcome, not a second run
    expect(runs).toBe(1);
    expect(pool.inserts()).toBe(1);
  });

  it("(l2) a deadline 503 over a transaction that is still running is cached too", async () => {
    await build(async (_run, reply) => {
      const client = (await pool.connect()) as FakeClient;
      await client.query("begin");
      await client.query("insert into t (n) values (1)"); // never reaches COMMIT within this request
      return reply.code(503).send({ error: { code: "DEADLINE_EXCEEDED" } });
    });
    expect((await post()).statusCode).toBe(503);
    expect((await post()).statusCode).toBe(503);
    expect(runs).toBe(1);
  });

  it("(l3) once the other transaction has rolled back, the failure is released again", async () => {
    await build(async (run, reply) => {
      if (run === 1) {
        await transaction(pool, ["insert into t (n) values (1)"], "rollback");
        throw deadlock();
      }
      return reply.code(201).send({ saved: true });
    });
    expect((await post()).statusCode).toBe(409);
    expect((await post()).statusCode).toBe(201);
    expect(runs).toBe(2);
  });

  it("(m) a COMMIT the server refused (40001, 40P01, a constraint) provably applied nothing: the retry runs", async () => {
    const failedStatus = { "40001": 409, "40P01": 409, "23505": 500 } as const;
    for (const code of ["40001", "40P01", "23505"] as const) {
      await build(async (run, reply) => {
        if (run === 1) {
          pool.failWith = (text) => (/^commit$/i.test(text) ? serverError(code) : undefined);
          await transaction(pool, ["insert into t (n) values (1)"]);
        }
        return reply.code(201).send({ saved: true });
      });
      expect((await post(`key-${code}`)).statusCode).toBe(failedStatus[code]); // the refused COMMIT rejects: the handler fails
      pool.failWith = () => undefined;
      expect((await post(`key-${code}`)).statusCode).toBe(201);
      expect(runs).toBe(2);
      await app.close();
    }
  });

  it("(m2) a COMMIT that fails without a server answer (a lost connection) or with FATAL may have applied: cached", async () => {
    const lost = Object.assign(new Error("Connection terminated unexpectedly"), {
      code: "ECONNRESET",
    });
    for (const failure of [
      lost,
      serverError("57P01", "FATAL"),
      serverError("08006", "ERROR"),
      new Error("who knows"),
    ]) {
      await build(async () => {
        pool.failWith = (text) => (/^commit$/i.test(text) ? failure : undefined);
        await transaction(pool, ["insert into t (n) values (1)"]);
        return { saved: true };
      });
      expect((await post()).statusCode).toBe(500);
      expect((await post()).statusCode).toBe(500);
      expect(runs).toBe(1);
      await app.close();
    }
  });

  it("(m3) an autocommit write refused by the server clears; one answered through a callback (pg-pool) too", async () => {
    await build(async (run, reply) => {
      const client = (await pool.connect()) as FakeClient;
      if (run === 1) {
        pool.failWith = (text) => (/^update/i.test(text) ? serverError("23514") : undefined);
        await queryWithCallback(client, "update t set n = 1"); // rejects: the handler fails
      }
      return reply.code(201).send({ saved: true });
    });
    expect((await post()).statusCode).toBe(500);
    pool.failWith = () => undefined;
    expect((await post()).statusCode).toBe(201);
    expect(runs).toBe(2);
  });

  it("(m4) a refused write does not clear the mark of one that DID apply", async () => {
    await build(async () => {
      const client = (await pool.connect()) as FakeClient;
      await client.query("update t set n = 1"); // applied
      pool.failWith = (text) =>
        /^update t set n = 2/i.test(text) ? serverError("23505") : undefined;
      await client.query("update t set n = 2"); // refused
      return { saved: true };
    });
    // the refused update rejected, so the handler failed with a 500 after the first update applied
    expect((await post()).statusCode).toBe(500);
    pool.failWith = () => undefined;
    expect((await post()).statusCode).toBe(500);
    expect(runs).toBe(1);
  });

  it("(i) a request outside the tracker (no key, or a read) is untouched by the instrumentation", async () => {
    await build(async (_run, reply) => {
      await transaction(pool, ["insert into t (n) values (1)"]);
      return reply.code(201).send({ saved: true });
    });
    const res = await app.inject({ method: "POST", url: "/write", payload: { a: 1 } });
    expect(res.statusCode).toBe(201);
    expect(pool.inserts()).toBe(1);
  });

  // CW-AC-36. The release is decided from a snapshot at `onSend`; what the snapshot cannot see is a write the request has not
  // issued YET (a Promise.race deadline answered 503 while the work behind it carries on). Releasing the key without stopping
  // that work let the same-key retry AND the abandoned work both commit. Releasing now FENCES the request at the pool: from
  // that instant every write its connections issue is refused before it reaches the server, whichever route it came from.
  describe("(n) a released claim fences the request's later writes", () => {
    const FENCED = { code: "IDEMPOTENCY_WRITE_FENCED" };
    let startLater: () => void = () => undefined;
    let later: Promise<unknown> = Promise.resolve();

    /** Work the handler abandons at a deadline: it issues `steps` only once `startLater` runs, after the 503 has gone out. */
    const abandonedWork = (steps: () => Promise<unknown>): void => {
      const gate = new Promise<void>((resolve) => {
        startLater = resolve;
      });
      later = gate.then(steps).then(
        () => "done",
        (error: unknown) => error,
      );
    };

    it("(n1) a 503 over work that has NOT written yet: released, the late first write is refused, the retry writes once", async () => {
      await build(async (run, reply) => {
        if (run === 1) {
          abandonedWork(() => transaction(pool, ["insert into t (n) values (1)"]));
          return reply.code(503).send({ error: { code: "DEADLINE_EXCEEDED" } });
        }
        await transaction(pool, ["insert into t (n) values (2)"]);
        return reply.code(201).send({ saved: true });
      });
      expect((await post()).statusCode).toBe(503);
      startLater(); // the abandoned work now reaches its first write, after the claim was released
      expect(await later).toMatchObject(FENCED);
      expect(pool.inserts()).toBe(0); // refused before it reached the server
      expect((await post()).statusCode).toBe(201); // the key was released: the retry runs
      expect(runs).toBe(2);
      expect(pool.inserts()).toBe(1); // one write in all
      expect(logLines.some((line) => line.includes("a write was refused"))).toBe(true);
    });

    it.each([
      [401, { error: { code: "UNAUTHENTICATED" } }],
      [403, { error: { code: "FORBIDDEN" } }],
      [409, { error: { code: "CONCURRENT_UPDATE" } }],
    ])(
      "(n8) a retryable %i releases AND fences: the late first write is refused, the retry writes once",
      async (status, body) => {
        await build(async (run, reply) => {
          if (run === 1) {
            abandonedWork(() => transaction(pool, ["insert into t (n) values (1)"]));
            return reply.code(status).send(body);
          }
          await transaction(pool, ["insert into t (n) values (2)"]);
          return reply.code(201).send({ saved: true });
        });
        expect((await post()).statusCode).toBe(status);
        startLater();
        expect(await later).toMatchObject(FENCED);
        expect(pool.inserts()).toBe(0);
        expect((await post()).statusCode).toBe(201); // released, so the retry ran
        expect(pool.inserts()).toBe(1);
      },
    );

    it("(n2) reads, SET and an open read-only transaction still work after the release; only the first write is refused", async () => {
      await build(async (_run, reply) => {
        const client = (await pool.connect()) as FakeClient;
        await client.query("begin");
        await client.query("select 1"); // read-only so far: the tracker counts nothing
        abandonedWork(async () => {
          await client.query("select count(*) from t");
          await client.query("set local app.org_id = '1'");
          try {
            await client.query("insert into t (n) values (1)");
          } finally {
            await client.query("rollback");
          }
        });
        return reply.code(503).send({ error: { code: "DEADLINE_EXCEEDED" } });
      });
      expect((await post()).statusCode).toBe(503);
      startLater();
      expect(await later).toMatchObject(FENCED);
      expect(pool.sent).toEqual([
        "begin",
        "select 1",
        "select count(*) from t",
        "set local app.org_id = '1'",
        "rollback",
      ]);
    });

    it("(n3) the callback form (pg-pool's own checkout) is refused through its callback", async () => {
      let held: FakeClient | undefined;
      await build(async (_run, reply) => {
        held = (await pool.connect()) as FakeClient;
        abandonedWork(() => queryWithCallback(held as FakeClient, "update t set n = 2"));
        return reply.code(500).send({ error: { code: "INTERNAL" } });
      });
      expect((await post()).statusCode).toBe(500);
      startLater();
      expect(await later).toMatchObject(FENCED);
      expect(pool.sent).toEqual([]);
    });

    it("(n4) a failure that is CACHED (a write committed) does not fence: nothing was released, the replay is the answer", async () => {
      await build(async (_run, reply) => {
        await transaction(pool, ["insert into t (n) values (1)"]);
        abandonedWork(() => transaction(pool, ["insert into t (n) values (2)"]));
        return reply.code(503).send({ error: { code: "DEADLINE_EXCEEDED" } });
      });
      expect((await post()).statusCode).toBe(503);
      startLater();
      expect(await later).toBe("done"); // the key holds the cached 503; the request's own late write is not refused
      expect((await post()).statusCode).toBe(503); // replay
      expect(runs).toBe(1);
      expect(pool.inserts()).toBe(2);
    });

    it("(n6) the release is itself a write through the same pool: the fence must not refuse it, or the key stays pending", async () => {
      // The Postgres store releases with a DELETE on a pooled connection, inside the request's async context. An in-memory store
      // never touched the pool, which is how a fence that also caught its own release went unseen until the live suite.
      let releaseDeletes = 0;
      await build(
        async (_run, reply) => reply.code(503).send({ error: { code: "DEADLINE_EXCEEDED" } }),
        undefined,
        undefined,
        (fakePool) => {
          const inner = createInMemoryIdempotencyStore();
          return {
            ...inner,
            release: async (orgId, key, claimId, requestHash) => {
              const client = (await fakePool.connect()) as FakeClient;
              await client.query("begin");
              await client.query("delete from idempotency_key where key = 'k'");
              await client.query("commit");
              releaseDeletes += 1;
              return inner.release(orgId, key, claimId, requestHash);
            },
          };
        },
      );
      expect((await post()).statusCode).toBe(503);
      expect(releaseDeletes).toBe(1);
      expect(pool.sent.filter((s) => /^delete/i.test(s))).toHaveLength(1); // it reached the "server"
      expect((await post()).statusCode).toBe(503);
      expect(runs).toBe(2); // released, so the retry ran
    });

    it("(n7) a write still QUEUED for a pool connection when the 503 goes out is refused when its connection arrives", async () => {
      // Pool exhaustion often causes the deadline. The write is not counted yet (the tracker counts at `client.query`), so the key is
      // released and fenced; the checkout is served later, from another async context, and must still name the fenced request.
      let queued: Promise<unknown> = Promise.resolve();
      await build(async (_run, reply) => {
        queued = new Promise((resolve) => {
          pool.connect(((_error: undefined, client: FakeClient) => {
            queryWithCallback(client, "insert into t (n) values (1)").then(
              () => resolve("done"),
              (error: unknown) => resolve(error),
            );
          }) as never);
        });
        return reply.code(503).send({ error: { code: "DEADLINE_EXCEEDED" } });
      });
      expect((await post()).statusCode).toBe(503);
      pool.pulse(); // the queued checkout is served now, outside the request's context
      expect(await queued).toMatchObject(FENCED);
      expect(pool.inserts()).toBe(0);
    });

    it("(n5) a request that is not fenced (a 2xx) keeps writing after the response, as before", async () => {
      await build(async (_run, reply) => {
        abandonedWork(() => transaction(pool, ["insert into t (n) values (1)"]));
        return reply.code(201).send({ saved: true });
      });
      expect((await post()).statusCode).toBe(201);
      startLater();
      expect(await later).toBe("done");
      expect(pool.inserts()).toBe(1);
    });
  });
});
