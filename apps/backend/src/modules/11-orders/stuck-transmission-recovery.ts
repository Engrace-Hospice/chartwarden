// apps/backend/src/modules/11-orders/stuck-transmission-recovery.ts — get a stuck lab order out of that state without
// waiting for a human to notice (F-191, #248). The DB shell; the rules are the pure `orm-request/stuck-recovery.ts`.
//
// THREE JOBS, one service, each an org-explicit method (a worker tick is not a request — the sweeps run under
// `withOrgContext` per tenant, and the org list comes from the platform-context enumerator, never from this file):
//   • `sweepAutoRetries`  — re-emit the ORM for an order refused BEFORE any outbound row existed, once its cause is
//                           fixed, bounded so a permanently broken configuration cannot loop or re-alert.
//   • `sweepHeldAging`    — alert (warn, then critical) when an order that needs a human's verification with the lab
//                           (`dlq_exhausted` / `application_reject` / `recovery_blocked:*`) has waited too long.
//   • `listHeld`          — the operator's worklist of exactly those orders, oldest first, cursor-paginated.
//
// THE RE-EMISSION IS F-182's RESEND, NOT A SECOND IMPLEMENTATION. `deps.resend` is `resendLabTransmission` — the same row
// lock, the same conditional update, the same fresh attempt id, the same `m11.order.hl7_orm_requested`. Two sweepers (or a
// sweeper and an operator's click) serialize on the row lock and the loser reads `pending` and is refused, so a
// concurrent double-dispatch is impossible by the SAME two guards a manual resend relies on. This file adds only WHEN to
// call it and how many times.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, ValidationError } from "@wardenx/types";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { getMdmEntityProvider } from "../40-mdm/seams";
import { RECOVERABLE_M29_FAILURE_REASONS, RECOVERY_BLOCKED_PREFIX, DISPATCH_REFUSED_PREFIX, ORM_REFUSAL_PREFIX } from "./orm-request/orm-resend";
import type { OrmMdmReader } from "./orm-request/ports";
import {
  AUTO_RETRY_BATCH_SIZE,
  type AutoRetryCandidate,
  DEFAULT_HELD_THRESHOLDS,
  type HeldStage,
  type HeldThresholds,
  autoRetryExhaustedCorrelationId,
  classifyAutoRetry,
  heldAgingCorrelationId,
  heldStage,
} from "./orm-request/stuck-recovery";

const OR = schema.orderRecords;

/** §3.3 — a system-driven write names no acting user (the F-102 `CONSUMER_USER_ID` convention). */
const SYSTEM_USER_ID = "";

/** The M36 `AlertEmitter` seam's structural shape — declared locally, M11 never imports a concrete M36 package. */
export interface StuckOrderAlertPort {
  emit(
    organizationId: string,
    input: {
      readonly eventType: string;
      readonly payload: Record<string, unknown>;
      readonly severity: "info" | "warn" | "critical";
      readonly correlationId: string;
    },
  ): Promise<unknown>;
}

export interface StuckTransmissionRecoveryDeps {
  readonly db: DbClient;
  /**
   * F-182's `resendLabTransmission`, bound at the composition root with no acting user. Anything but `requested` means
   * the producer still refused (nothing was emitted); a `ConflictError` means another sweeper/operator won the row.
   */
  readonly resend: (organizationId: string, orderId: string) => Promise<{ readonly outcome: string }>;
  /**
   * M29's D16 BAA gate for a destination facility, as of `asOf` — injected because M11 has no `dependsOn` edge to M29.
   * The producer does not check the BAA (the worker does), so this is the ONE cause the sweep verifies before it
   * re-emits; without it a still-lapsed BAA would round-trip through the worker and re-alert the provider every retry.
   */
  readonly baaCleared: (input: {
    readonly organizationId: string;
    readonly destinationFacilityId: string;
    readonly asOf: Date;
  }) => Promise<boolean>;
  readonly alerts: StuckOrderAlertPort;
  /** M29's outbound-row facts for the worklist's `feedId` column — optional; absent ⇒ `feedId: null`. */
  readonly feedsForOrders?: (
    tx: DbClient,
    organizationId: string,
    orderIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
  readonly mdm?: () => OrmMdmReader;
  readonly now?: () => Date;
  readonly thresholds?: HeldThresholds;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface AutoRetrySweepSummary {
  readonly examined: number;
  readonly retried: number;
  /** The producer (or the BAA pre-check) says the cause is still there — nothing was emitted, nothing was spent. */
  readonly causeNotCleared: number;
  readonly stillRefused: number;
  readonly backoff: number;
  readonly notEligible: number;
  readonly exhausted: number;
  /** Lost the row to a concurrent sweeper/operator — benign, the winner dispatched. */
  readonly raced: number;
  readonly errors: number;
}

export interface HeldAgingSweepSummary {
  readonly examined: number;
  readonly alerted: number;
  readonly errors: number;
}

export interface HeldTransmissionItem {
  readonly orderId: string;
  readonly patientId: string;
  /** The order's `transmission_failure_reason` — a fixed token (`dlq_exhausted`, `application_reject`, `recovery_blocked:*`). */
  readonly reason: string;
  /** When the applier marked the order failed. */
  readonly failedAt: string;
  readonly ageSeconds: number;
  readonly stage: HeldStage;
  /** The feed the (dead-ended) outbound message went to; null when no outbound row is on record. */
  readonly feedId: string | null;
}

export interface HeldTransmissionPage {
  readonly items: readonly HeldTransmissionItem[];
  readonly nextCursor: string | null;
}

// ── keyset cursor over (updated_at, id) ──────────────────────────────────────────────────────────────────────────────

const ISO_MICROS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(updatedAtIso: string, id: string): string {
  return Buffer.from(JSON.stringify({ u: updatedAtIso, i: id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { readonly u: string; readonly i: string } {
  const bad = () =>
    new ValidationError("invalid cursor", [{ field: "cursor", code: "INVALID", message: "cursor is not valid" }]);
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { u?: unknown; i?: unknown };
    if (typeof parsed.u !== "string" || typeof parsed.i !== "string" || !ISO_MICROS.test(parsed.u) || !UUID.test(parsed.i)) {
      throw bad();
    }
    return { u: parsed.u, i: parsed.i };
  } catch {
    throw bad();
  }
}

/** `updated_at` at MICROSECOND precision as an ISO string — a JS `Date` would truncate to ms and break the keyset. */
const updatedAtIso = sql<string>`to_char(${OR.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// `starts_with`, not LIKE: `_` is a LIKE wildcard and `orm_refused:` contains one.
const reasonStartsWith = (prefix: string) => sql`starts_with(${OR.transmissionFailureReason}, ${prefix})`;

/** The failure reasons an operator must resolve with the lab — the worklist and the aging sweep read exactly these. */
const heldReasonFilter = () =>
  sql`(${inArray(OR.transmissionFailureReason, [...RECOVERABLE_M29_FAILURE_REASONS])} OR ${reasonStartsWith(RECOVERY_BLOCKED_PREFIX)})`;

const failedActiveLab = (organizationId: string) =>
  and(
    eq(OR.organizationId, organizationId),
    eq(OR.kind, "lab"),
    eq(OR.status, "active"),
    eq(OR.transmissionStatus, "failed"),
  );

export function createStuckTransmissionRecovery(deps: StuckTransmissionRecoveryDeps) {
  const now = deps.now ?? (() => new Date());
  const thresholds = deps.thresholds ?? DEFAULT_HELD_THRESHOLDS;
  const mdm = deps.mdm ?? (() => getMdmEntityProvider() as unknown as OrmMdmReader);
  const log = deps.log ?? (() => undefined);

  /** Is the BAA for this order's destination in force NOW? Fail-closed: any unresolved fact is "not cleared". */
  async function baaIsCleared(organizationId: string, data: unknown, asOf: Date): Promise<boolean> {
    const routingLabId = (data as { routingLabId?: unknown } | null)?.routingLabId;
    if (typeof routingLabId !== "string" || routingLabId.length === 0) return false;
    const facility = await mdm().resolveFacility(organizationId, routingLabId);
    if (facility === null || facility.status !== "active") return false;
    return deps.baaCleared({ organizationId, destinationFacilityId: facility.id, asOf });
  }

  /**
   * The sweep gave up on this order (attempts or window used up): raise the ONE operator alert, then stamp the marker so
   * it can never repeat. The alert goes FIRST — if it throws the marker is not set and the next tick retries; a repeat
   * emit is harmless because the correlation id is stable (the `alert` table de-duplicates on it).
   */
  async function markExhausted(
    organizationId: string,
    row: { readonly id: string; readonly reason: string; readonly attemptId: string | null; readonly count: number },
    why: "attempts" | "window",
    at: Date,
  ): Promise<boolean> {
    await deps.alerts.emit(organizationId, {
      eventType: "m11.order.transmission_auto_retry_exhausted",
      severity: "warn",
      correlationId: autoRetryExhaustedCorrelationId(row.id, row.attemptId),
      // ids + fixed tokens only — no patient data.
      payload: { orderId: row.id, reason: row.reason, attempts: row.count, why },
    });
    const stamped = await withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) =>
      (tx as unknown as DbClient)
        .update(OR)
        .set({ transmissionAutoRetryExhaustedAt: at })
        .where(
          and(
            eq(OR.organizationId, organizationId),
            eq(OR.id, row.id),
            eq(OR.kind, "lab"),
            eq(OR.transmissionStatus, "failed"),
            eq(OR.transmissionFailureReason, row.reason),
            isNull(OR.transmissionAutoRetryExhaustedAt),
          ),
        )
        .returning({ id: OR.id }),
    );
    return stamped.length > 0;
  }

  return {
    /**
     * One tenant's auto-retry pass. Every candidate is isolated: one order's failure never stops the rest.
     * Nothing here is emitted for an order the resend's own gates refuse (SUD, an immutable-order refusal, an M29-terminal
     * failure) — {@link classifyAutoRetry} defers to `classifyOrmResend` for that, so the two cannot drift.
     */
    async sweepAutoRetries(organizationId: string): Promise<AutoRetrySweepSummary> {
      const at = now();
      const rows = await withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) =>
        (tx as unknown as DbClient)
          .select({
            id: OR.id,
            kind: OR.kind,
            status: OR.status,
            transmissionStatus: OR.transmissionStatus,
            transmissionFailureReason: OR.transmissionFailureReason,
            attemptId: OR.transmissionAttemptId,
            data: OR.data,
            count: OR.transmissionAutoRetryCount,
            retryAt: OR.transmissionAutoRetryAt,
            exhaustedAt: OR.transmissionAutoRetryExhaustedAt,
            failedAt: OR.updatedAt,
          })
          .from(OR)
          .where(
            and(
              failedActiveLab(organizationId),
              isNull(OR.transmissionAutoRetryExhaustedAt),
              sql`(${reasonStartsWith(DISPATCH_REFUSED_PREFIX)} OR ${reasonStartsWith(ORM_REFUSAL_PREFIX)})`,
            ),
          )
          // The order the sweep's own candidate index (`idx_order_transmission_failed`) is keyed in.
          .orderBy(asc(OR.updatedAt), asc(OR.id))
          .limit(AUTO_RETRY_BATCH_SIZE),
      );

      const tally = { retried: 0, causeNotCleared: 0, stillRefused: 0, backoff: 0, notEligible: 0, exhausted: 0, raced: 0, errors: 0 };
      for (const row of rows) {
        try {
          const candidate: AutoRetryCandidate = {
            kind: row.kind,
            status: row.status,
            transmissionStatus: row.transmissionStatus,
            transmissionFailureReason: row.transmissionFailureReason,
            autoRetryCount: row.count,
            autoRetryAt: row.retryAt,
            autoRetryExhaustedAt: row.exhaustedAt,
            failedAt: row.failedAt,
          };
          const verdict = classifyAutoRetry(candidate, at);
          if (verdict.action === "skip") {
            if (verdict.why === "backoff") tally.backoff++;
            else tally.notEligible++;
            continue;
          }
          if (verdict.action === "exhausted") {
            if (await markExhausted(organizationId, { id: row.id, reason: row.transmissionFailureReason as string, attemptId: row.attemptId, count: row.count }, verdict.why, at)) {
              tally.exhausted++;
            }
            continue;
          }
          if (verdict.needsBaaCheck && !(await baaIsCleared(organizationId, row.data, at))) {
            tally.causeNotCleared++;
            continue;
          }
          const result = await deps.resend(organizationId, row.id);
          if (result.outcome !== "requested") {
            tally.stillRefused++;
            continue;
          }
          // Only an ACTUAL re-emission spends an attempt. (A crash between the resend's commit and this write leaves the
          // count one short — the order is `pending` then, so the bound still holds: worst case one extra attempt.)
          await withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) =>
            (tx as unknown as DbClient)
              .update(OR)
              .set({ transmissionAutoRetryCount: sql`${OR.transmissionAutoRetryCount} + 1`, transmissionAutoRetryAt: at })
              .where(and(eq(OR.organizationId, organizationId), eq(OR.id, row.id), eq(OR.kind, "lab"))),
          );
          tally.retried++;
        } catch (error) {
          if (error instanceof ConflictError) {
            tally.raced++; // another sweeper / an operator's click got there first — the winner dispatched
            continue;
          }
          tally.errors++;
          log("m11.stuck_recovery.auto_retry_error", { orderId: row.id, error: error instanceof Error ? error.name : "unknown" });
        }
      }
      return { examined: rows.length, ...tally };
    },

    /**
     * One tenant's held-order escalation pass. The alert id is stable per (order, hold episode, stage), so this may run
     * on every tick: a stage that already paged is absorbed by the `alert` table's unique correlation id, and the next
     * stage (`critical`) is a NEW id. Held orders are few and human-scale, so re-emitting each tick is cheap.
     */
    async sweepHeldAging(organizationId: string): Promise<HeldAgingSweepSummary> {
      const at = now();
      const rows = await withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) =>
        (tx as unknown as DbClient)
          .select({
            id: OR.id,
            reason: OR.transmissionFailureReason,
            attemptId: OR.transmissionAttemptId,
            failedAt: OR.updatedAt,
          })
          .from(OR)
          .where(
            and(
              failedActiveLab(organizationId),
              heldReasonFilter(),
              lte(OR.updatedAt, new Date(at.getTime() - thresholds.warnAfterMs)),
            ),
          )
          .orderBy(asc(OR.updatedAt), asc(OR.id))
          .limit(AUTO_RETRY_BATCH_SIZE),
      );

      let alerted = 0;
      let errors = 0;
      for (const row of rows) {
        const ageMs = at.getTime() - row.failedAt.getTime();
        const stage = heldStage(ageMs, thresholds);
        if (stage === "none") continue;
        try {
          await deps.alerts.emit(organizationId, {
            eventType: "m11.order.transmission_held_aging",
            severity: stage,
            correlationId: heldAgingCorrelationId(row.id, row.attemptId, stage),
            // ids + fixed tokens + a coarse age — no patient data.
            payload: { orderId: row.id, stage, reason: row.reason, ageHours: Math.floor(ageMs / 3_600_000) },
          });
          alerted++;
        } catch (error) {
          errors++;
          log("m11.stuck_recovery.held_aging_error", { orderId: row.id, error: error instanceof Error ? error.name : "unknown" });
        }
      }
      return { examined: rows.length, alerted, errors };
    },

    /** The operator's worklist: orders waiting on a human's verification with the lab, oldest first. */
    async listHeld(
      organizationId: string,
      opts: { readonly limit: number; readonly cursor?: string | undefined },
    ): Promise<HeldTransmissionPage> {
      const at = now();
      const limit = Math.max(1, Math.min(opts.limit, 100));
      const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
      return withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (scoped) => {
        const tx = scoped as unknown as DbClient;
        const rows = await tx
          .select({
            id: OR.id,
            patientId: OR.patientId,
            reason: OR.transmissionFailureReason,
            failedAt: OR.updatedAt,
            failedAtIso: updatedAtIso,
          })
          .from(OR)
          .where(
            and(
              failedActiveLab(organizationId),
              heldReasonFilter(),
              after === null ? undefined : sql`(${OR.updatedAt}, ${OR.id}) > (${after.u}::timestamptz, ${after.i}::uuid)`,
            ),
          )
          .orderBy(asc(OR.updatedAt), asc(OR.id))
          .limit(limit + 1);
        const page = rows.slice(0, limit);
        const feeds =
          deps.feedsForOrders !== undefined && page.length > 0
            ? await deps.feedsForOrders(tx, organizationId, page.map((r) => r.id))
            : new Map<string, string>();
        const items: HeldTransmissionItem[] = page.map((r) => {
          const ageMs = Math.max(0, at.getTime() - r.failedAt.getTime());
          return {
            orderId: r.id,
            patientId: r.patientId,
            reason: r.reason as string,
            failedAt: r.failedAtIso,
            ageSeconds: Math.floor(ageMs / 1000),
            stage: heldStage(ageMs, thresholds),
            feedId: feeds.get(r.id) ?? null,
          };
        });
        const last = page[page.length - 1];
        return {
          items,
          nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last.failedAtIso, last.id) : null,
        };
      });
    },
  };
}

export type StuckTransmissionRecovery = ReturnType<typeof createStuckTransmissionRecovery>;
