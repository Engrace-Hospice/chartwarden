/**
 * TASK-006 — the transactional-outbox DISPATCHER, proven against real Postgres.
 *
 * Drives `createOutboxDispatcher.tick()` (exposed for exactly this) as the NOBYPASSRLS
 * `chartwarden_app` role over the real `outbox_event` table + RLS policy, with a stub
 * ActiveOrgEnumerator returning the seeded org (no platform credential needed). Asserts the
 * acceptance triangle: an emitted event reaches a registered consumer; the pending depth stays
 * bounded (every non-deferred row reaches a terminal); and the tick summary gives liveness.
 * Covers delivery, retry/backoff eligibility, the `failed` DLQ terminal, deferred routing
 * (backlog preserved, no attempt burn), record-only completion, and the retention purge
 * (`dispatched` purged, `failed` never).
 *
 * Gated on a live DB:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/outbox-dispatcher.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import type { OutboxEventEntry } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import {
  type DispatchableOutboxEvent,
  type OutboxConsumerBinding,
  type OutboxDispatcherOptions,
  createOutboxDispatcher,
} from "../src/bootstrap/outbox-dispatcher";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-111111111111";

// One fixed id per case so cross-test seeds can never collide.
const EV_DELIVER = "aaaaaaaa-0000-4000-8000-000000000001";
const EV_RETRY = "aaaaaaaa-0000-4000-8000-000000000002";
const EV_DLQ = "aaaaaaaa-0000-4000-8000-000000000003";
const EV_DEFERRED = "aaaaaaaa-0000-4000-8000-000000000004";
const EV_RECORD_ONLY = "aaaaaaaa-0000-4000-8000-000000000005";
const EV_PURGE_DISPATCHED = "aaaaaaaa-0000-4000-8000-000000000006";
const EV_PURGE_FAILED = "aaaaaaaa-0000-4000-8000-000000000007";
const EV_PARTIAL = "aaaaaaaa-0000-4000-8000-000000000008";

describe.skipIf(!DB_URL)("Outbox dispatcher — LIVE Postgres (TASK-006)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;

  // Stub enumerator: the dispatcher fans out over exactly the seeded org — no platform
  // credential/withPlatformContext needed to exercise the per-org claim/deliver/finalize path.
  const orgs: ActiveOrgEnumerator = {
    listActiveOrgs: async () => [{ organizationId: ORG_A }],
  };

  function makeDispatcher(
    consumers: readonly OutboxConsumerBinding[],
    deferredEventTypes?: readonly string[],
    options?: OutboxDispatcherOptions,
    declaredByType: Readonly<Record<string, OutboxEventEntry["declaredConsumers"]>> = {},
  ) {
    const declared = new Map<string, Set<OutboxConsumerBinding["consumerModule"]>>();
    for (const consumer of consumers) {
      for (const eventType of consumer.eventTypes) {
        const modules = declared.get(eventType) ?? new Set();
        modules.add(consumer.consumerModule);
        declared.set(eventType, modules);
      }
    }
    for (const eventType of deferredEventTypes ?? []) {
      const modules = declared.get(eventType) ?? new Set();
      modules.add("m40");
      declared.set(eventType, modules);
    }
    for (const [eventType, modules] of Object.entries(declaredByType)) {
      declared.set(eventType, new Set(modules));
    }
    const eventCatalog = new Map<string, OutboxEventEntry>();
    for (const [eventName, modules] of declared) {
      eventCatalog.set(eventName, {
        // The catalog's `eventName` is the `m<N>.<a>.<b>` template type; this harness builds entries from
        // strings the test supplies, deliberately including one off-convention name below.
        eventName: eventName as OutboxEventEntry["eventName"],
        moduleOwner: "m1",
        description: eventName,
        payloadSchema: Type.Object({}, { additionalProperties: true }),
        declaredConsumers: [...modules],
        isOutboxOnly: true,
      });
    }
    eventCatalog.set("outbox.test.unrouted", {
      eventName: "outbox.test.unrouted" as OutboxEventEntry["eventName"],
      moduleOwner: "m1",
      description: "Explicit record-only live-test event",
      payloadSchema: Type.Object({}, { additionalProperties: true }),
      declaredConsumers: [],
      isOutboxOnly: true,
    });
    return createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers,
      eventCatalog,
      options: { log: () => {}, ...options },
    });
  }

  /** Seed an outbox row as superuser (bypasses RLS; the outbox audit trigger is a no-op by design). */
  async function seed(e: {
    id: string;
    eventType: string;
    status?: "pending" | "dispatching" | "dispatched" | "failed";
    dispatchedAt?: Date | null;
    lastError?: string | null;
  }) {
    await admin.query(
      "INSERT INTO outbox_event (id, organization_id, event_type, aggregate_kind, aggregate_id, payload, status, dispatched_at, last_error) " +
        "VALUES ($1,$2,$3,'test_aggregate',gen_random_uuid(),$4::jsonb,$5,$6,$7)",
      [
        e.id,
        ORG_A,
        e.eventType,
        JSON.stringify({ hello: "world", seededId: e.id }),
        e.status ?? "pending",
        e.dispatchedAt ?? null,
        e.lastError ?? null,
      ],
    );
  }

  async function fetchRow(id: string) {
    const res = await admin.query("SELECT * FROM outbox_event WHERE id=$1", [id]);
    return res.rows[0];
  }

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG_A],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
  }, 300_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("delivery: a pending event with a registered consumer is delivered and finalized 'dispatched'", async () => {
    const received: DispatchableOutboxEvent[] = [];
    // TASK-040C (OPS-005/006) — onTick fires once per tick with the org-summed summary + elapsed ms.
    const ticks: Array<{ summary: unknown; elapsedMs: number }> = [];
    await seed({ id: EV_DELIVER, eventType: "outbox.test.deliver" });
    const dispatcher = makeDispatcher(
      [
        {
          consumerName: "test-deliver-consumer",
          consumerModule: "m1",
          eventTypes: ["outbox.test.deliver"],
          handle: async (event) => {
            received.push(event);
          },
        },
      ],
      undefined,
      { onTick: (summary, elapsedMs) => ticks.push({ summary, elapsedMs }) },
    );

    const summary = await dispatcher.tick();
    expect(summary.orgsPolled).toBe(1);
    expect(summary.delivered).toBe(1);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.summary).toEqual(summary);
    expect(ticks[0]!.elapsedMs).toBeGreaterThanOrEqual(0);

    // The consumer actually got the row's content (the acceptance's "reaches a registered consumer").
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(EV_DELIVER);
    expect(received[0].organizationId).toBe(ORG_A);
    expect(received[0].eventType).toBe("outbox.test.deliver");
    expect(received[0].payload).toMatchObject({ hello: "world", seededId: EV_DELIVER });

    const row = await fetchRow(EV_DELIVER);
    expect(row.status).toBe("dispatched");
    expect(row.dispatched_at).toBeTruthy();
    expect(row.last_error).toBeNull();
    expect(row.attempt_count).toBe(1);
  });

  it("retry/backoff: a throwing consumer backs the row off; not eligible → no redelivery; eligible → delivered", async () => {
    let calls = 0;
    await seed({ id: EV_RETRY, eventType: "outbox.test.retry" });
    const dispatcher = makeDispatcher(
      [
        {
          consumerName: "flaky-consumer",
          consumerModule: "m1",
          eventTypes: ["outbox.test.retry"],
          handle: async () => {
            calls += 1;
            if (calls === 1) throw new Error("transient boom");
          },
        },
      ],
      undefined,
      { backoffBaseMs: 10 * 60_000 }, // first retry lands ~10 min out — unreachable in-test until forced
    );

    const beforeTick = Date.now();
    const s1 = await dispatcher.tick();
    expect(s1.retried).toBe(1);
    let row = await fetchRow(EV_RETRY);
    expect(row.status).toBe("pending");
    expect(row.attempt_count).toBe(1);
    expect(row.dispatched_at).toBeNull();
    expect(String(row.last_error)).toContain("transient boom");
    // next_attempt_at ≈ now + backoffBase (attempt 1 → base·2⁰).
    const eta = new Date(row.next_attempt_at).getTime();
    expect(eta).toBeGreaterThan(beforeTick + 9 * 60_000);
    expect(eta).toBeLessThan(beforeTick + 11 * 60_000);

    // A tick BEFORE next_attempt_at must not redeliver.
    const s2 = await dispatcher.tick();
    expect(s2.delivered).toBe(0);
    expect(s2.retried).toBe(0);
    expect(calls).toBe(1);

    // Force eligibility → the next tick claims + delivers.
    await admin.query(
      "UPDATE outbox_event SET next_attempt_at = now() - interval '1 second' WHERE id=$1",
      [EV_RETRY],
    );
    const s3 = await dispatcher.tick();
    expect(s3.delivered).toBe(1);
    expect(calls).toBe(2);
    row = await fetchRow(EV_RETRY);
    expect(row.status).toBe("dispatched");
    expect(row.attempt_count).toBe(2);
    expect(row.last_error).toBeNull();
    expect(row.dispatched_at).toBeTruthy();
  });

  it("DLQ: maxAttempts exhausted → 'failed' terminal with lastError; a later tick never touches it", async () => {
    let calls = 0;
    // TASK-040D (OPS-012) — the DLQ-promotion alert hook fires exactly once, on the SAME transition.
    // `organizationId` is NULLABLE on the callback (GAP-099 — a PLATFORM row belongs to no tenant) and
    // the payload carries `error`; the local restatement had neither.
    const deadLetters: Array<{
      eventId: string;
      eventType: string;
      organizationId: string | null;
      attemptCount: number;
      error: string;
    }> = [];
    await seed({ id: EV_DLQ, eventType: "outbox.test.dlq" });
    const dispatcher = makeDispatcher(
      [
        {
          consumerName: "always-failing-consumer",
          consumerModule: "m1",
          eventTypes: ["outbox.test.dlq"],
          handle: async () => {
            calls += 1;
            throw new Error("permanent boom");
          },
        },
      ],
      undefined,
      { maxAttempts: 1, onDeadLetter: (e) => deadLetters.push(e) },
    );

    const s1 = await dispatcher.tick();
    expect(s1.deadLettered).toBe(1);
    let row = await fetchRow(EV_DLQ);
    expect(row.status).toBe("failed");
    expect(row.attempt_count).toBe(1);
    expect(String(row.last_error)).toContain("permanent boom");
    expect(deadLetters).toEqual([
      {
        eventId: EV_DLQ,
        eventType: "outbox.test.dlq",
        organizationId: ORG_A,
        attemptCount: 1,
        error: expect.stringContaining("permanent boom"),
      },
    ]);

    // Dead letters are terminal: never reclaimed, never redelivered, never purged.
    const s2 = await dispatcher.tick();
    expect(s2.deadLettered).toBe(0);
    expect(s2.retried).toBe(0);
    expect(s2.delivered).toBe(0);
    expect(calls).toBe(1);
    row = await fetchRow(EV_DLQ);
    expect(row.status).toBe("failed");
    expect(row.attempt_count).toBe(1);
    expect(deadLetters).toHaveLength(1); // never re-fires on a later tick over the same terminal row
  });

  it("deferred: a declared-but-not-landed type stays 'pending' with no attempt burn, pushed ~deferredRetryMs out", async () => {
    await seed({ id: EV_DEFERRED, eventType: "outbox.test.deferred" });
    const dispatcher = makeDispatcher([], ["outbox.test.deferred"], {
      deferredRetryMs: 30 * 60_000,
    });

    const beforeTick = Date.now();
    const s1 = await dispatcher.tick();
    expect(s1.deferred).toBe(1);

    const row = await fetchRow(EV_DEFERRED);
    expect(row.status).toBe("pending"); // backlog preserved for the worker to drain
    expect(row.attempt_count).toBe(0); // the claim's count was undone — a deferral is not a failed attempt
    expect(row.dispatched_at).toBeNull();
    expect(String(row.last_error)).toContain("deferred");
    const eta = new Date(row.next_attempt_at).getTime();
    expect(eta).toBeGreaterThan(beforeTick + 29 * 60_000);
    expect(eta).toBeLessThan(beforeTick + 31 * 60_000);

    // Not due again until the slow clock elapses — an immediate tick leaves it alone.
    const s2 = await dispatcher.tick();
    expect(s2.deferred).toBe(0);
    expect((await fetchRow(EV_DEFERRED)).attempt_count).toBe(0);
  });

  it("record-only: no consumer and not deferred → 'dispatched' immediately (the row IS the durable record)", async () => {
    await seed({ id: EV_RECORD_ONLY, eventType: "outbox.test.unrouted" });
    // A consumer for a DIFFERENT type proves routing selectivity (it must not receive this event).
    const received: DispatchableOutboxEvent[] = [];
    const dispatcher = makeDispatcher([
      {
        consumerName: "other-type-consumer",
        consumerModule: "m1",
        eventTypes: ["outbox.test.some-other-type"],
        handle: async (event) => {
          received.push(event);
        },
      },
    ]);

    const summary = await dispatcher.tick();
    expect(summary.recordOnly).toBe(1);
    expect(summary.delivered).toBe(0);
    expect(received).toHaveLength(0);

    const row = await fetchRow(EV_RECORD_ONLY);
    expect(row.status).toBe("dispatched");
    expect(row.dispatched_at).toBeTruthy();
    expect(row.last_error).toBeNull();
  });

  it("purge: a 'dispatched' row past retention is deleted; a 'failed' row of the same age survives", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60_000);
    await seed({
      id: EV_PURGE_DISPATCHED,
      eventType: "outbox.test.purge",
      status: "dispatched",
      dispatchedAt: oneHourAgo,
    });
    await seed({
      id: EV_PURGE_FAILED,
      eventType: "outbox.test.purge",
      status: "failed",
      dispatchedAt: oneHourAgo,
      lastError: "dead letter — evidence, never auto-purged",
    });
    const dispatcher = makeDispatcher([], undefined, { retentionMs: 5 * 60_000 });

    const summary = await dispatcher.tick();
    expect(summary.purged).toBe(1);

    expect(await fetchRow(EV_PURGE_DISPATCHED)).toBeUndefined();
    const failed = await fetchRow(EV_PURGE_FAILED);
    expect(failed).toBeTruthy();
    expect(failed.status).toBe("failed");
  });

  it("partial fan-out: durable receipts prevent replay across restart while missing modules keep the source pending", async () => {
    let m7Calls = 0;
    let m8Calls = 0;
    await seed({ id: EV_PARTIAL, eventType: "outbox.test.partial" });
    const m7: OutboxConsumerBinding = {
      consumerName: "m7.partial-proof",
      consumerModule: "m7",
      eventTypes: ["outbox.test.partial"],
      handle: async () => {
        m7Calls += 1;
      },
    };
    const declared = { "outbox.test.partial": ["m7", "m8"] } as const;

    const first = makeDispatcher([m7], undefined, { deferredRetryMs: 60_000 }, declared);
    expect((await first.tick()).deferred).toBe(1);
    expect(m7Calls).toBe(1);
    let row = await fetchRow(EV_PARTIAL);
    expect(row.status).toBe("pending");
    expect(row.attempt_count).toBe(0);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM outbox_consumer_receipt WHERE event_id=$1",
          [EV_PARTIAL],
        )
      ).rows[0].n,
    ).toBe(1);

    await admin.query(
      "UPDATE outbox_event SET next_attempt_at=now() - interval '1 second' WHERE id=$1",
      [EV_PARTIAL],
    );
    const restarted = makeDispatcher([m7], undefined, { deferredRetryMs: 60_000 }, declared);
    expect((await restarted.tick()).deferred).toBe(1);
    expect(m7Calls).toBe(1);

    await admin.query(
      "UPDATE outbox_event SET next_attempt_at=now() - interval '1 second' WHERE id=$1",
      [EV_PARTIAL],
    );
    const completed = makeDispatcher(
      [
        m7,
        {
          consumerName: "m8.partial-proof",
          consumerModule: "m8",
          eventTypes: ["outbox.test.partial"],
          handle: async () => {
            m8Calls += 1;
          },
        },
      ],
      undefined,
      undefined,
      declared,
    );
    expect((await completed.tick()).delivered).toBe(1);
    expect(m7Calls).toBe(1);
    expect(m8Calls).toBe(1);
    row = await fetchRow(EV_PARTIAL);
    expect(row.status).toBe("dispatched");
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM outbox_consumer_receipt WHERE event_id=$1",
          [EV_PARTIAL],
        )
      ).rows[0].n,
    ).toBe(2);
  });

  it("liveness/pending depth: after the full pass an idle tick is a no-op and only the deferred backlog stays pending", async () => {
    const dispatcher = makeDispatcher([]);
    const summary = await dispatcher.tick();
    expect(summary).toEqual({
      orgsPolled: 1,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      deferred: 0,
      recordOnly: 0,
      reclaimed: 0,
      purged: 0,
    });

    // Pending depth is BOUNDED: every non-deferred row reached a terminal; only the deferred
    // backlog row (intentionally preserved) remains pending.
    const depth = await admin.query(
      "SELECT count(*)::int AS n FROM outbox_event WHERE status='pending'",
    );
    expect(depth.rows[0].n).toBe(1);
    const failedDepth = await admin.query(
      "SELECT count(*)::int AS n FROM outbox_event WHERE status='failed'",
    );
    expect(failedDepth.rows[0].n).toBe(2); // the DLQ case + the purge-survivor

    // TASK-040B — the readiness probe's outbox-depth source reads the SAME count under RLS.
    expect(await dispatcher.pendingDepth()).toBe(1);
  });
});
