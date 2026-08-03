// apps/backend/src/bootstrap/outbox-dispatcher.ts — the transactional-outbox DISPATCHER
// (TASK-006, production-readiness audit 2026-08-03, OPS-001).
//
// Until this file, every module's catalog publisher wrote `outbox_event` rows that nothing ever
// read: the table grew unboundedly and every cross-module event contract was write-only theater.
// This is the polling relay that makes the outbox real.
//
// TENANCY: `outbox_event` is org-scoped under RLS (`outbox_event_org`, FOR ALL wardenx_app), so the
// relay never bypasses RLS. Each tick enumerates active orgs through the AUDITED platform-context
// enumerator (the M30/M33 cron precedent) and polls each org under its own `withOrgContext` —
// claim, deliver, finalize, all RLS-scoped to that org.
//
// ROUTING SEMANTICS (documented here because they are the honest part):
//   · An event type with LIVE consumers is delivered to every one; all succeed → `dispatched`
//     (dispatched_at = the success instant). Any failure → attempt_count+1, exponential backoff via
//     `next_attempt_at`, and after maxAttempts → `failed` (the DLQ terminal; never silently dropped).
//   · An event type on the DEFERRED list (a consumer is declared but its worker has not landed —
//     e.g. the M22 render handshake) stays `pending` with a slow re-check clock and NO attempt
//     count: the backlog is preserved for the worker to drain, and the pending depth metric TELLS
//     THE TRUTH about the deferral instead of faking consumption.
//   · Any other event type has no live subscriber: the row IS the durable record (the §4.10/§4.11
//     posture), so delivery-to-zero-subscribers completes immediately → `dispatched`.
//   · Rows stuck `dispatching` longer than the visibility timeout (a crash mid-delivery) revert to
//     `pending` on a later tick — the attempt was already counted at claim.
//   · Retention: `dispatched` rows older than the retention window are purged. `failed` rows are
//     NEVER purged automatically (a dead letter is evidence), and `pending` rows are never touched.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { ActiveOrgEnumerator } from "./active-org-enumerator";

const OUTBOX = schema.outboxEvents;

/** One claimed outbox row as handed to a consumer. */
export interface DispatchableOutboxEvent {
  readonly id: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly attemptCount: number;
  readonly createdAt: Date;
}

/** A live consumer: handles every event type it names; a throw fails the delivery (retried). */
export interface OutboxConsumerBinding {
  /** The `(eventId, consumerName)` dedup identity (§4.11). */
  readonly consumerName: string;
  readonly eventTypes: readonly string[];
  handle(event: DispatchableOutboxEvent): Promise<void>;
}

export interface OutboxDispatcherOptions {
  /** Max rows claimed per org per tick (default 25). */
  readonly batchSize?: number;
  /** Poll cadence (default 1000 ms). */
  readonly pollIntervalMs?: number;
  /** Attempts before a row goes to the `failed` DLQ terminal (default 8). */
  readonly maxAttempts?: number;
  /** Backoff base (default 5 s → 5s, 10s, 20s … capped). */
  readonly backoffBaseMs?: number;
  /** Backoff cap (default 15 min). */
  readonly backoffCapMs?: number;
  /** Re-check clock for DEFERRED event types (default 30 min). */
  readonly deferredRetryMs?: number;
  /** `dispatching` rows older than this revert to pending (default 5 min). */
  readonly visibilityTimeoutMs?: number;
  /** `dispatched` rows older than this are purged (default 14 days). */
  readonly retentionMs?: number;
  /** How often the active-org list refreshes (default 60 s). */
  readonly orgRefreshMs?: number;
  /** Injected clock for tests. */
  readonly clock?: () => number;
  /** Log sink (default console). */
  readonly log?: (message: string) => void;
}

export interface OutboxDispatcherDeps {
  readonly db: DbClient;
  readonly orgs: ActiveOrgEnumerator;
  readonly consumers: readonly OutboxConsumerBinding[];
  /** Event types with a DECLARED-but-not-landed consumer (kept pending on the slow clock). */
  readonly deferredEventTypes?: readonly string[];
  readonly options?: OutboxDispatcherOptions;
}

export interface OutboxDispatcher {
  /** One full poll pass over every active org. Exposed for tests/liveness; `start()` loops it. */
  tick(): Promise<OutboxTickSummary>;
  start(): void;
  stop(): Promise<void>;
}

export interface OutboxTickSummary {
  readonly orgsPolled: number;
  readonly delivered: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly deferred: number;
  readonly recordOnly: number;
  readonly reclaimed: number;
  readonly purged: number;
}

/** Exponential backoff with cap: base·2^(attempt-1), attempt 1-based. Exported for the unit tests. */
export function outboxBackoffMs(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** The relay's actor id — dispatch runs on behalf of the platform, not a user (NULL audit actor). */
const DISPATCHER_USER_ID = "";

/** The @wardenx/tenancy platform-job id the relay's org enumeration is allowlisted under. */
export const M1_OUTBOX_DISPATCHER_JOB_ID = "m1-outbox-dispatcher";

export function createOutboxDispatcher(deps: OutboxDispatcherDeps): OutboxDispatcher {
  const opt = deps.options ?? {};
  const batchSize = opt.batchSize ?? 25;
  const pollIntervalMs = opt.pollIntervalMs ?? 1000;
  const maxAttempts = opt.maxAttempts ?? 8;
  const backoffBaseMs = opt.backoffBaseMs ?? 5_000;
  const backoffCapMs = opt.backoffCapMs ?? 15 * 60_000;
  const deferredRetryMs = opt.deferredRetryMs ?? 30 * 60_000;
  const visibilityTimeoutMs = opt.visibilityTimeoutMs ?? 5 * 60_000;
  const retentionMs = opt.retentionMs ?? 14 * 24 * 60 * 60_000;
  const orgRefreshMs = opt.orgRefreshMs ?? 60_000;
  const clock = opt.clock ?? Date.now;
  const log = opt.log ?? ((m: string) => console.log(m));

  // event type → the live bindings for it (a type may fan out to several consumers).
  const routes = new Map<string, OutboxConsumerBinding[]>();
  for (const consumer of deps.consumers) {
    for (const eventType of consumer.eventTypes) {
      const bucket = routes.get(eventType) ?? [];
      bucket.push(consumer);
      routes.set(eventType, bucket);
    }
  }
  const deferred = new Set(deps.deferredEventTypes ?? []);
  // A type both live-routed AND deferred is a wiring bug — the live consumer wins, loudly.
  for (const type of deferred) {
    if (routes.has(type)) {
      log(`⚠️  outbox-dispatcher: '${type}' is both live-routed and deferred — treating as LIVE`);
      deferred.delete(type);
    }
  }

  let orgCache: { at: number; orgs: readonly { organizationId: string }[] } | null = null;
  async function activeOrgs(): Promise<readonly { organizationId: string }[]> {
    const now = clock();
    if (orgCache && now - orgCache.at < orgRefreshMs) return orgCache.orgs;
    const orgs = await deps.orgs.listActiveOrgs();
    orgCache = { at: now, orgs };
    return orgs;
  }

  async function pollOrg(organizationId: string): Promise<Omit<OutboxTickSummary, "orgsPolled">> {
    const summary = {
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      deferred: 0,
      recordOnly: 0,
      reclaimed: 0,
      purged: 0,
    };
    const now = new Date(clock());

    // ── claim (one short tx): due pending rows → `dispatching`, attempt counted at claim ──────────
    const claimed = await withOrgContext(
      deps.db,
      { organizationId, userId: DISPATCHER_USER_ID },
      async (tx) => {
        // Crash sweep first: dispatching rows past the visibility timeout revert to pending.
        const reclaimed = await tx
          .update(OUTBOX)
          .set({ status: "pending" })
          .where(
            and(
              eq(OUTBOX.organizationId, organizationId),
              eq(OUTBOX.status, "dispatching"),
              lt(OUTBOX.dispatchedAt, new Date(now.getTime() - visibilityTimeoutMs)),
            ),
          )
          .returning({ id: OUTBOX.id });
        summary.reclaimed += reclaimed.length;

        const due = await tx.execute(sql`
          SELECT id FROM outbox_event
          WHERE organization_id = ${organizationId}
            AND status = 'pending'
            AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
          ORDER BY created_at
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        `);
        const ids = ((due as unknown as { rows?: Array<{ id: string }> }).rows ?? []).map(
          (r) => r.id,
        );
        if (ids.length === 0) return [];
        // `dispatched_at` doubles as the CLAIM instant while status='dispatching' (the visibility
        // clock); it is overwritten with the true success instant on finalize.
        const rows = await tx
          .update(OUTBOX)
          .set({
            status: "dispatching",
            attemptCount: sql`${OUTBOX.attemptCount} + 1`,
            dispatchedAt: now,
          })
          .where(and(eq(OUTBOX.organizationId, organizationId), inArray(OUTBOX.id, ids)))
          .returning({
            id: OUTBOX.id,
            organizationId: OUTBOX.organizationId,
            eventType: OUTBOX.eventType,
            aggregateKind: OUTBOX.aggregateKind,
            aggregateId: OUTBOX.aggregateId,
            payload: OUTBOX.payload,
            attemptCount: OUTBOX.attemptCount,
            createdAt: OUTBOX.createdAt,
          });
        return rows;
      },
    );

    // ── deliver + finalize (per event; each finalize is its own short org tx) ─────────────────────
    for (const row of claimed) {
      const event: DispatchableOutboxEvent = { ...row, payload: row.payload };
      const finalize = (patch: Partial<typeof OUTBOX.$inferInsert>) =>
        withOrgContext(deps.db, { organizationId, userId: DISPATCHER_USER_ID }, (tx) =>
          tx
            .update(OUTBOX)
            .set(patch)
            .where(and(eq(OUTBOX.organizationId, organizationId), eq(OUTBOX.id, row.id))),
        );

      if (deferred.has(row.eventType)) {
        // Declared consumer not landed: preserve the backlog, no attempt burn (undo the claim's
        // count — a deferral is not a failed attempt).
        await finalize({
          status: "pending",
          attemptCount: row.attemptCount - 1,
          dispatchedAt: null,
          nextAttemptAt: new Date(now.getTime() + deferredRetryMs),
          lastError: `deferred: declared consumer not yet live (TASK-006 routing)`,
        });
        summary.deferred += 1;
        continue;
      }

      const bindings = routes.get(row.eventType);
      if (!bindings || bindings.length === 0) {
        // No live subscriber and not deferred: the row is the durable record — delivery to zero
        // subscribers is complete.
        await finalize({ status: "dispatched", dispatchedAt: now, lastError: null });
        summary.recordOnly += 1;
        continue;
      }

      try {
        for (const binding of bindings) await binding.handle(event);
        await finalize({ status: "dispatched", dispatchedAt: new Date(clock()), lastError: null });
        summary.delivered += 1;
      } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        if (row.attemptCount >= maxAttempts) {
          await finalize({ status: "failed", lastError: message.slice(0, 2000) });
          summary.deadLettered += 1;
          log(
            `☠️  outbox-dispatcher: '${row.eventType}' (${row.id}) dead-lettered after ${row.attemptCount} attempts — ${message}`,
          );
        } else {
          await finalize({
            status: "pending",
            dispatchedAt: null,
            nextAttemptAt: new Date(
              now.getTime() + outboxBackoffMs(row.attemptCount, backoffBaseMs, backoffCapMs),
            ),
            lastError: message.slice(0, 2000),
          });
          summary.retried += 1;
        }
      }
    }

    // ── retention purge: dispatched rows past the window; failed/pending NEVER auto-purged ───────
    const purged = await withOrgContext(
      deps.db,
      { organizationId, userId: DISPATCHER_USER_ID },
      (tx) =>
        tx
          .delete(OUTBOX)
          .where(
            and(
              eq(OUTBOX.organizationId, organizationId),
              eq(OUTBOX.status, "dispatched"),
              lt(OUTBOX.dispatchedAt, new Date(now.getTime() - retentionMs)),
            ),
          )
          .returning({ id: OUTBOX.id }),
    );
    summary.purged += purged.length;
    return summary;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  async function tick(): Promise<OutboxTickSummary> {
    const orgs = await activeOrgs();
    const total: OutboxTickSummary = {
      orgsPolled: orgs.length,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      deferred: 0,
      recordOnly: 0,
      reclaimed: 0,
      purged: 0,
    };
    for (const org of orgs) {
      const s = await pollOrg(org.organizationId);
      (total as { delivered: number }).delivered += s.delivered;
      (total as { retried: number }).retried += s.retried;
      (total as { deadLettered: number }).deadLettered += s.deadLettered;
      (total as { deferred: number }).deferred += s.deferred;
      (total as { recordOnly: number }).recordOnly += s.recordOnly;
      (total as { reclaimed: number }).reclaimed += s.reclaimed;
      (total as { purged: number }).purged += s.purged;
    }
    return total;
  }

  return {
    tick,
    start() {
      if (running) return;
      running = true;
      const loop = () => {
        if (!running) return;
        inFlight = tick()
          .catch((err) => {
            // A failing tick must not kill the relay — log and keep polling (the rows are durable).
            log(`⚠️  outbox-dispatcher tick failed: ${err instanceof Error ? err.message : err}`);
          })
          .finally(() => {
            if (running) timer = setTimeout(loop, pollIntervalMs);
          });
      };
      loop();
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      await inFlight; // drain the in-flight tick so shutdown never abandons a claimed batch mid-way
    },
  };
}
