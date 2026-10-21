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
//   · Landed consumers execute independently and record durable `(event_id, consumer_name)` receipts.
//     If other catalog-declared modules are not live yet, the source row remains `pending` on a slow
//     re-check clock without replaying completed bindings. This permits staged deployment without
//     either losing the unfinished fan-out or making completed clinical effects run repeatedly.
//   · Only an event whose catalog explicitly has `declaredConsumers: []` is record-only: the row IS
//     the durable record, so delivery-to-zero-subscribers completes immediately → `dispatched`.
//   · A legacy/unknown row absent from the boot catalog stays pending; it is never guessed record-only.
//   · Rows stuck `dispatching` longer than the visibility timeout (a crash mid-delivery) revert to
//     `pending` on a later tick — the attempt was already counted at claim.
//   · Retention: `dispatched` rows older than the retention window are purged. `failed` rows are
//     NEVER purged automatically (a dead letter is evidence), and `pending` rows are never touched.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { ModuleToken, OutboxEventEntry } from "@chartwarden/types";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { ActiveOrgEnumerator } from "./active-org-enumerator";
import { safeErrorMessage } from "./redact-database-error";

const OUTBOX = schema.outboxEvents;
const RECEIPTS = schema.outboxConsumerReceipts;

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
  /** Module named in the catalog's `declaredConsumers` list. */
  readonly consumerModule: ModuleToken;
  readonly eventTypes: readonly string[];
  handle(event: DispatchableOutboxEvent): Promise<void>;
}

/**
 * One claimed PLATFORM-wide (`organization_id IS NULL`) outbox row (GAP-099).
 *
 * A separate type rather than widening {@link DispatchableOutboxEvent}'s `organizationId` to
 * `string | null`: ~150 org-scoped bindings read that field as a `string` and pass it straight to
 * `withOrgContext`, so widening it would turn a compile-time guarantee into a runtime one across the
 * whole consumer surface. The absence of the field IS the contract here — a platform consumer has no
 * tenant to act for, and anything it writes is either org-less master data or an explicit per-org
 * fan-out it resolves itself.
 */
export interface PlatformDispatchableOutboxEvent {
  readonly id: string;
  readonly eventType: string;
  readonly aggregateKind: string;
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly attemptCount: number;
  readonly createdAt: Date;
}

/** A live PLATFORM consumer: same contract as {@link OutboxConsumerBinding}, org-less event (GAP-099). */
export interface PlatformOutboxConsumerBinding {
  /** The `(eventId, consumerName)` dedup identity (§4.11); receipts are written org-less. */
  readonly consumerName: string;
  /** Module named in the catalog's `declaredConsumers` list. */
  readonly consumerModule: ModuleToken;
  readonly eventTypes: readonly string[];
  handle(event: PlatformDispatchableOutboxEvent): Promise<void>;
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
  /**
   * TASK-040D (OPS-012) — fired exactly once per row on the SAME dead-letter transition the `☠️` log line
   * already reports (`attemptCount >= maxAttempts`), so a caller can wire real DLQ-promotion alerting
   * (`bootstrap/dlq-alerts.ts`) without scraping the log string. Optional — the dispatcher's own behavior
   * (mark `failed`, log, never auto-purge) is unchanged whether or not this is bound.
   */
  readonly onDeadLetter?: (event: {
    readonly eventId: string;
    readonly eventType: string;
    /** NULL for a PLATFORM-wide row (GAP-099) — there is no tenant the dead letter belongs to. */
    readonly organizationId: string | null;
    readonly attemptCount: number;
    readonly error: string;
  }) => void;
  /**
   * TASK-040C (OPS-005/006) — fired once per completed `tick()` call (both from `start()`'s internal
   * loop and a direct `.tick()` call), with the full org-summed {@link OutboxTickSummary} plus the
   * tick's own wall-clock duration — the metrics layer's only hook point, so `bootstrap/metrics.ts`
   * never needs to poll or re-derive dispatcher state.
   */
  readonly onTick?: (summary: OutboxTickSummary, elapsedMs: number) => void;
}

export interface OutboxDispatcherDeps {
  readonly db: DbClient;
  readonly orgs: ActiveOrgEnumerator;
  readonly consumers: readonly OutboxConsumerBinding[];
  /**
   * GAP-099 — consumers of PLATFORM-wide (`organization_id IS NULL`) events. Separate list because the
   * two kinds handle structurally different events; a module may appear in both (bound to different
   * event types). Consumer NAMES must still be unique per event type across both lists.
   */
  readonly platformConsumers?: readonly PlatformOutboxConsumerBinding[];
  /** Full boot catalog. Routing is derived from its declared-consumer contract. */
  readonly eventCatalog: ReadonlyMap<string, OutboxEventEntry>;
  readonly options?: OutboxDispatcherOptions;
}

export interface OutboxDispatcher {
  /** One full poll pass over every active org. Exposed for tests/liveness; `start()` loops it. */
  tick(): Promise<OutboxTickSummary>;
  /** TASK-040B — total `pending`-row backlog across every active org (readiness-probe depth check). */
  pendingDepth(): Promise<number>;
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

export interface OutboxRoutingPlan {
  readonly live: ReadonlyMap<string, readonly OutboxConsumerBinding[]>;
  /** GAP-099 — the same map for PLATFORM (`organization_id IS NULL`) bindings. */
  readonly livePlatform: ReadonlyMap<string, readonly PlatformOutboxConsumerBinding[]>;
  /** Events still missing at least one catalog-declared consumer module. */
  readonly deferred: ReadonlySet<string>;
  readonly recordOnly: ReadonlySet<string>;
}

/** The catalog checks that are identical for an org binding and a platform binding. */
function assertBindableAgainstCatalog(
  eventCatalog: ReadonlyMap<string, OutboxEventEntry>,
  eventType: string,
  consumerName: string,
  consumerModule: ModuleToken,
): void {
  const entry = eventCatalog.get(eventType);
  if (!entry) {
    throw new Error(`outbox consumer '${consumerName}' binds unknown catalog event '${eventType}'`);
  }
  if (entry.declaredConsumers.length === 0) {
    throw new Error(
      `outbox event '${eventType}' is catalogued record-only but has live consumer bindings`,
    );
  }
  if (!entry.declaredConsumers.includes(consumerModule)) {
    throw new Error(
      `outbox consumer '${consumerName}' module '${consumerModule}' is not declared for '${eventType}'`,
    );
  }
}

/**
 * Build the exhaustive routing plan from the same catalog that validates publishes. Available bindings
 * are live even when another declared module is not yet wired; durable receipts make that partial fan-out
 * restart-safe while `deferred` keeps the source row pending. Only an explicit empty consumer list is
 * record-only. Unknown, undeclared, and duplicate bindings fail boot.
 *
 * GAP-099: org and platform bindings are collected separately (they handle structurally different events)
 * but scored TOGETHER for `deferred` — "is every declared consumer module live?" is a question about the
 * module, not about which scope it happens to listen on. A consumer NAME may not repeat for one event
 * type across the two lists either: the `(event_id, consumer_name)` receipt identity is shared.
 */
export function buildOutboxRoutingPlan(
  eventCatalog: ReadonlyMap<string, OutboxEventEntry>,
  consumers: readonly OutboxConsumerBinding[],
  platformConsumers: readonly PlatformOutboxConsumerBinding[] = [],
): OutboxRoutingPlan {
  const bindingsByType = new Map<string, OutboxConsumerBinding[]>();
  const platformBindingsByType = new Map<string, PlatformOutboxConsumerBinding[]>();
  const namesByType = new Map<string, Set<string>>();

  const claimName = (eventType: string, consumerName: string) => {
    const names = namesByType.get(eventType) ?? new Set<string>();
    if (names.has(consumerName)) {
      throw new Error(
        `outbox consumer '${consumerName}' is bound more than once for '${eventType}'`,
      );
    }
    names.add(consumerName);
    namesByType.set(eventType, names);
  };

  for (const consumer of consumers) {
    for (const eventType of consumer.eventTypes) {
      assertBindableAgainstCatalog(
        eventCatalog,
        eventType,
        consumer.consumerName,
        consumer.consumerModule,
      );
      claimName(eventType, consumer.consumerName);
      const bucket = bindingsByType.get(eventType) ?? [];
      bucket.push(consumer);
      bindingsByType.set(eventType, bucket);
    }
  }

  for (const consumer of platformConsumers) {
    for (const eventType of consumer.eventTypes) {
      assertBindableAgainstCatalog(
        eventCatalog,
        eventType,
        consumer.consumerName,
        consumer.consumerModule,
      );
      claimName(eventType, consumer.consumerName);
      const bucket = platformBindingsByType.get(eventType) ?? [];
      bucket.push(consumer);
      platformBindingsByType.set(eventType, bucket);
    }
  }

  const live = new Map<string, readonly OutboxConsumerBinding[]>();
  const livePlatform = new Map<string, readonly PlatformOutboxConsumerBinding[]>();
  const deferred = new Set<string>();
  const recordOnly = new Set<string>();
  for (const [eventType, entry] of eventCatalog) {
    const bindings = bindingsByType.get(eventType) ?? [];
    const platformBindings = platformBindingsByType.get(eventType) ?? [];
    if (entry.declaredConsumers.length === 0) {
      if (bindings.length > 0 || platformBindings.length > 0) {
        throw new Error(
          `outbox event '${eventType}' is catalogued record-only but has live consumer bindings`,
        );
      }
      recordOnly.add(eventType);
      continue;
    }

    if (bindings.length > 0) live.set(eventType, bindings);
    if (platformBindings.length > 0) livePlatform.set(eventType, platformBindings);
    const boundModules = new Set([
      ...bindings.map((binding) => binding.consumerModule),
      ...platformBindings.map((binding) => binding.consumerModule),
    ]);
    const allDeclaredConsumersBound = entry.declaredConsumers.every((module) =>
      boundModules.has(module),
    );
    if (!allDeclaredConsumersBound) deferred.add(eventType);
  }

  return { live, livePlatform, deferred, recordOnly };
}

/** Exponential backoff with cap: base·2^(attempt-1), attempt 1-based. Exported for the unit tests. */
export function outboxBackoffMs(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** The relay's actor id — dispatch runs on behalf of the platform, not a user (NULL audit actor). */
const DISPATCHER_USER_ID = "";

/** The @chartwarden/tenancy platform-job id the relay's org enumeration is allowlisted under. */
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
  const onDeadLetter = opt.onDeadLetter ?? (() => {});
  const onTick = opt.onTick ?? (() => {});

  const routing = buildOutboxRoutingPlan(
    deps.eventCatalog,
    deps.consumers,
    deps.platformConsumers ?? [],
  );

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
          // dispatched_at was doubling as the claim instant — null it so the column keeps its
          // documented meaning (the SUCCESS instant) on reclaimed rows (live-test finding).
          .set({ status: "pending", dispatchedAt: null })
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
      // `row.organizationId` types as `string | null` post-migration-0186 (the column is now nullable
      // for the SEPARATE platform-event path, `pollPlatform()` below) — but every row THIS function claims
      // is scoped `WHERE organization_id = ${organizationId}` (a real, non-null uuid), so the outer loop
      // variable is the true, narrowed value.
      const event: DispatchableOutboxEvent = { ...row, organizationId, payload: row.payload };
      const finalize = (patch: Partial<typeof OUTBOX.$inferInsert>) =>
        withOrgContext(deps.db, { organizationId, userId: DISPATCHER_USER_ID }, (tx) =>
          tx
            .update(OUTBOX)
            .set(patch)
            .where(and(eq(OUTBOX.organizationId, organizationId), eq(OUTBOX.id, row.id))),
        );

      if (!deps.eventCatalog.has(row.eventType)) {
        // Unknown legacy event: preserve the backlog, no attempt burn.
        await finalize({
          status: "pending",
          attemptCount: row.attemptCount - 1,
          dispatchedAt: null,
          nextAttemptAt: new Date(now.getTime() + deferredRetryMs),
          lastError: "deferred: event type is absent from the boot catalog",
        });
        summary.deferred += 1;
        continue;
      }

      const bindings = routing.live.get(row.eventType);
      if (!bindings || bindings.length === 0) {
        if (routing.deferred.has(row.eventType)) {
          await finalize({
            status: "pending",
            attemptCount: row.attemptCount - 1,
            dispatchedAt: null,
            nextAttemptAt: new Date(now.getTime() + deferredRetryMs),
            lastError: "deferred: one or more declared consumers are not live",
          });
          summary.deferred += 1;
          continue;
        }
        if (!routing.recordOnly.has(row.eventType)) {
          // Every declared consumer module IS live, but all of them bound this event type on the
          // PLATFORM list while this row carries an org (GAP-099). The row is not deliverable here and
          // never will be — but it is also not a bug worth crashing the relay for, so it defers with a
          // message that names the actual mismatch instead of the old "no routing classification" throw.
          await finalize({
            status: "pending",
            attemptCount: row.attemptCount - 1,
            dispatchedAt: null,
            nextAttemptAt: new Date(now.getTime() + deferredRetryMs),
            lastError:
              "deferred: consumers for this event are bound platform-scoped, not org-scoped",
          });
          summary.deferred += 1;
          continue;
        }
        // The catalog explicitly declares no consumers: the row itself is the durable record.
        await finalize({
          status: "dispatched",
          dispatchedAt: now,
          lastError: null,
          nextAttemptAt: null,
        });
        summary.recordOnly += 1;
        continue;
      }

      try {
        for (const binding of bindings) {
          const completed = await withOrgContext(
            deps.db,
            { organizationId, userId: DISPATCHER_USER_ID },
            async (tx) => {
              const [receipt] = await tx
                .select({ id: RECEIPTS.id })
                .from(RECEIPTS)
                .where(
                  and(
                    eq(RECEIPTS.organizationId, organizationId),
                    eq(RECEIPTS.eventId, row.id),
                    eq(RECEIPTS.consumerName, binding.consumerName),
                  ),
                )
                .limit(1);
              return receipt !== undefined;
            },
          );
          if (completed) continue;

          await binding.handle(event);
          await withOrgContext(deps.db, { organizationId, userId: DISPATCHER_USER_ID }, (tx) =>
            tx
              .insert(RECEIPTS)
              .values({
                organizationId,
                eventId: row.id,
                consumerName: binding.consumerName,
                consumerModule: binding.consumerModule,
                completedAt: new Date(clock()),
              })
              .onConflictDoNothing(),
          );
        }

        if (routing.deferred.has(row.eventType)) {
          await finalize({
            status: "pending",
            attemptCount: row.attemptCount - 1,
            dispatchedAt: null,
            nextAttemptAt: new Date(now.getTime() + deferredRetryMs),
            lastError:
              "deferred: completed live bindings; one or more declared consumers are not live",
          });
          summary.deferred += 1;
          continue;
        }
        await finalize({
          status: "dispatched",
          dispatchedAt: new Date(clock()),
          lastError: null,
          nextAttemptAt: null, // a stale retry clock on a dispatched row is a trap (live-test finding)
        });
        summary.delivered += 1;
      } catch (err) {
        // PHI-safe: this string is PERSISTED to `outbox_event.last_error` and served by the
        // ops-outbox route, so a Drizzle wrapper here would put the failed statement's bound
        // parameters in a database column and an ops response (F-027 / #65).
        const message = safeErrorMessage(err);
        if (row.attemptCount >= maxAttempts) {
          // dispatched_at nulled: the row never succeeded, and the column means SUCCESS instant.
          await finalize({
            status: "failed",
            dispatchedAt: null,
            lastError: message.slice(0, 2000),
          });
          summary.deadLettered += 1;
          log(
            `☠️  outbox-dispatcher: '${row.eventType}' (${row.id}) dead-lettered after ${row.attemptCount} attempts — ${message}`,
          );
          onDeadLetter({
            eventId: row.id,
            eventType: row.eventType,
            organizationId,
            attemptCount: row.attemptCount,
            error: message,
          });
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

  // ── the platform-wide (organization_id IS NULL) pass — mirrors pollOrg's shape exactly, but every
  // claim/finalize/reclaim/purge step routes through the SECURITY DEFINER `report_writer_*` functions
  // (migration 0186) instead of a direct table statement: `wardenx_app` has no RLS policy admitting a
  // `organization_id IS NULL` row (ADR-0010 D2/D3 forbid one), so a plain `tx.update(OUTBOX)...` would be
  // silently denied by RLS for these rows. EXECUTE on each function is granted directly to `wardenx_app`
  // — no `withOrgContext`/`withPlatformContext` envelope is needed here (the function body, not the
  // caller's session, carries the elevated privilege).
  //
  // GAP-099 — this pass now DELIVERS. It mirrors pollOrg's outcome set exactly (unknown-event, deferred,
  // record-only, delivered, retried, dead-lettered) over `deps.platformConsumers`, whose
  // `PlatformOutboxConsumerBinding`/`PlatformDispatchableOutboxEvent` pair is the org-less twin of the
  // org types (see their declarations for why widening the existing pair was the wrong move). The §4.11
  // receipt — the thing that makes partial fan-out restart-safe — goes through the migration-0201
  // `report_writer_*_platform_receipt*` functions, since `outbox_consumer_receipt.organization_id` is NULL
  // for these rows and no `app.org_id` policy can admit them.
  //
  // Until GAP-099 this pass could claim a platform row and only ever put it back down as `deferred`, so
  // `m29.nppes.provider_synced` (M40's canonical applier) and every `m33.mv.*` row accumulated pending
  // forever — durable and honestly reported, but never acted on.
  async function pollPlatform(): Promise<Omit<OutboxTickSummary, "orgsPolled">> {
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

    const reclaimResult = await deps.db.execute(
      sql`SELECT * FROM report_writer_reclaim_platform_outbox(${now}, ${visibilityTimeoutMs})`,
    );
    summary.reclaimed += ((reclaimResult as unknown as { rows?: unknown[] }).rows ?? []).length;

    const claimResult = await deps.db.execute(
      sql`SELECT * FROM report_writer_claim_platform_outbox(${now}, ${batchSize})`,
    );
    const claimed = (
      (
        claimResult as unknown as {
          rows?: Array<{
            id: string;
            event_type: string;
            aggregate_kind: string;
            aggregate_id: string;
            payload: unknown;
            attempt_count: number;
            created_at: string | Date;
          }>;
        }
      ).rows ?? []
    ).map((r) => ({
      id: r.id,
      eventType: r.event_type,
      aggregateKind: r.aggregate_kind,
      aggregateId: r.aggregate_id,
      payload: r.payload,
      attemptCount: r.attempt_count,
      createdAt: new Date(r.created_at),
    }));

    for (const row of claimed) {
      if (!deps.eventCatalog.has(row.eventType)) {
        await deps.db.execute(
          sql`SELECT report_writer_finalize_platform_outbox_deferred(${row.id}, ${row.attemptCount - 1}, ${new Date(now.getTime() + deferredRetryMs)}, ${"deferred: event type is absent from the boot catalog"})`,
        );
        summary.deferred += 1;
        continue;
      }

      const deferRow = async (reason: string) => {
        await deps.db.execute(
          sql`SELECT report_writer_finalize_platform_outbox_deferred(${row.id}, ${row.attemptCount - 1}, ${new Date(now.getTime() + deferredRetryMs)}, ${reason})`,
        );
        summary.deferred += 1;
      };

      const bindings = routing.livePlatform.get(row.eventType);
      if (!bindings || bindings.length === 0) {
        if (routing.deferred.has(row.eventType)) {
          await deferRow("deferred: one or more declared consumers are not live");
          continue;
        }
        if (!routing.recordOnly.has(row.eventType)) {
          // The mirror of pollOrg's case: every declared module is live, but bound ORG-scoped while this
          // row is platform-wide. Defer with the mismatch named rather than crash the relay.
          await deferRow(
            "deferred: consumers for this event are bound org-scoped, not platform-scoped",
          );
          continue;
        }
        await deps.db.execute(
          sql`SELECT report_writer_finalize_platform_outbox_dispatched(${row.id}, ${now})`,
        );
        summary.recordOnly += 1;
        continue;
      }

      const event: PlatformDispatchableOutboxEvent = row;
      try {
        for (const binding of bindings) {
          const receiptResult = await deps.db.execute(
            sql`SELECT report_writer_platform_receipt_exists(${row.id}, ${binding.consumerName}) AS completed`,
          );
          const completed =
            (receiptResult as unknown as { rows?: Array<{ completed?: boolean }> }).rows?.[0]
              ?.completed === true;
          if (completed) continue;

          await binding.handle(event);
          await deps.db.execute(
            sql`SELECT report_writer_insert_platform_receipt(${row.id}, ${binding.consumerName}, ${binding.consumerModule}, ${new Date(clock())})`,
          );
        }

        if (routing.deferred.has(row.eventType)) {
          await deferRow(
            "deferred: completed live bindings; one or more declared consumers are not live",
          );
          continue;
        }
        await deps.db.execute(
          sql`SELECT report_writer_finalize_platform_outbox_dispatched(${row.id}, ${new Date(clock())})`,
        );
        summary.delivered += 1;
      } catch (err) {
        // PHI-safe: this string is PERSISTED to `outbox_event.last_error` and served by the
        // ops-outbox route, so a Drizzle wrapper here would put the failed statement's bound
        // parameters in a database column and an ops response (F-027 / #65).
        const message = safeErrorMessage(err);
        if (row.attemptCount >= maxAttempts) {
          await deps.db.execute(
            sql`SELECT report_writer_finalize_platform_outbox_dead_letter(${row.id}, ${message.slice(0, 2000)})`,
          );
          summary.deadLettered += 1;
          log(
            `☠️  outbox-dispatcher: platform '${row.eventType}' (${row.id}) dead-lettered after ${row.attemptCount} attempts — ${message}`,
          );
          // `organizationId: null` rather than a made-up sentinel uuid: the ops sink already renders the
          // org clause conditionally, and a fake org id in a DLQ alert is worse than none.
          onDeadLetter({
            eventId: row.id,
            eventType: row.eventType,
            organizationId: null,
            attemptCount: row.attemptCount,
            error: message,
          });
        } else {
          await deps.db.execute(
            sql`SELECT report_writer_finalize_platform_outbox_retry(${row.id}, ${new Date(now.getTime() + outboxBackoffMs(row.attemptCount, backoffBaseMs, backoffCapMs))}, ${message.slice(0, 2000)})`,
          );
          summary.retried += 1;
        }
      }
    }

    const purgeResult = await deps.db.execute(
      sql`SELECT * FROM report_writer_purge_platform_outbox(${new Date(now.getTime() - retentionMs)})`,
    );
    summary.purged += ((purgeResult as unknown as { rows?: unknown[] }).rows ?? []).length;

    return summary;
  }

  // TASK-040B — a plain per-org COUNT under the same RLS-scoped org enumeration `tick()` uses. Not
  // folded into `pollOrg()`: this is a READ for the readiness probe, never claims/mutates rows.
  async function pendingDepth(): Promise<number> {
    const orgs = await activeOrgs();
    let total = 0;
    for (const org of orgs) {
      const result = await withOrgContext(
        deps.db,
        { organizationId: org.organizationId, userId: DISPATCHER_USER_ID },
        (tx) =>
          tx.execute(sql`
            SELECT count(*)::int AS count FROM outbox_event
            WHERE organization_id = ${org.organizationId} AND status = 'pending'
          `),
      );
      const row = (result as unknown as { rows?: Array<{ count?: number }> }).rows?.[0];
      total += row?.count ?? 0;
    }
    // GAP-099 — platform-wide (organization_id IS NULL) pending rows are now included, through the
    // migration-0201 SECURITY DEFINER counter. `wardenx_app` still has no RLS policy admitting those rows
    // (by design, ADR-0010 D2/D3), so a plain SELECT here would silently UNDERCOUNT rather than error —
    // which is why this needed its own function. Before platform delivery existed, a platform backlog was
    // the expected steady state and leaving it out was defensible; now it is the exact symptom the depth
    // check is for.
    const platformResult = await deps.db.execute(
      sql`SELECT report_writer_platform_outbox_pending_depth() AS count`,
    );
    const platformRow = (platformResult as unknown as { rows?: Array<{ count?: number }> })
      .rows?.[0];
    total += Number(platformRow?.count ?? 0);
    return total;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  async function tick(): Promise<OutboxTickSummary> {
    const startedAt = clock();
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
    const platform = await pollPlatform();
    (total as { delivered: number }).delivered += platform.delivered;
    (total as { retried: number }).retried += platform.retried;
    (total as { deadLettered: number }).deadLettered += platform.deadLettered;
    (total as { deferred: number }).deferred += platform.deferred;
    (total as { recordOnly: number }).recordOnly += platform.recordOnly;
    (total as { reclaimed: number }).reclaimed += platform.reclaimed;
    (total as { purged: number }).purged += platform.purged;
    onTick(total, clock() - startedAt);
    return total;
  }

  return {
    tick,
    pendingDepth,
    start() {
      if (running) return;
      running = true;
      const loop = () => {
        if (!running) return;
        inFlight = tick()
          .catch((err) => {
            // A failing tick must not kill the relay — log and keep polling (the rows are durable).
            // `safeErrorMessage` because a tick IS a database query: the claim/deliver statements
            // bind the event payload, so a raw wrapper message here logs it (F-027 / #65).
            log(`⚠️  outbox-dispatcher tick failed: ${safeErrorMessage(err)}`);
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
