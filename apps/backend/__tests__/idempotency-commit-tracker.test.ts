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
interface FakeClient {
  query: (arg: unknown) => Promise<{ rows: unknown[] }>;
}

class FakePool extends EventEmitter {
  readonly sent: string[] = [];
  private readonly client: FakeClient = {
    query: async (arg) => {
      this.sent.push(typeof arg === "string" ? arg : String((arg as { text: string }).text));
      return { rows: [] };
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

describe("idempotency release needs proof that nothing committed", () => {
  let app: FastifyInstance;
  let pool: FakePool;
  let runs: number;

  async function build(
    handler: (run: number, reply: import("fastify").FastifyReply) => unknown,
    extra?: (app: FastifyInstance) => void,
    schema?: object,
  ): Promise<void> {
    runs = 0;
    pool = new FakePool();
    instrumentPoolForCommits(pool as never);
    app = Fastify();
    app.decorateRequest("context", undefined as never);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { context: unknown }).context = {
        organizationId: ORG,
        correlationId: "cid-test",
      };
    });
    applyErrorHandler(app);
    applyIdempotency(app, createInMemoryIdempotencyStore());
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

  it("(i) a request outside the tracker (no key, or a read) is untouched by the instrumentation", async () => {
    await build(async (_run, reply) => {
      await transaction(pool, ["insert into t (n) values (1)"]);
      return reply.code(201).send({ saved: true });
    });
    const res = await app.inject({ method: "POST", url: "/write", payload: { a: 1 } });
    expect(res.statusCode).toBe(201);
    expect(pool.inserts()).toBe(1);
  });
});
