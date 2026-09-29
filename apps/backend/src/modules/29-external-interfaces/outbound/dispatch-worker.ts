// apps/backend/src/modules/29-external-interfaces/outbound/dispatch-worker.ts — the M29-T08 outbound
// dispatch worker (F-175/#248): the REAL, live path from `m11.order.hl7_orm_requested` to an MLLP wire send
// and back. Every core this file orchestrates (`dispatch-planner.ts`, `ack-correlation.ts`,
// `retry-policy.ts`, `outbound-events.ts`) is PURE — this file is the IO shell that mints ids/clock,
// resolves the feed + BAA gate, envelope-encrypts, persists, transmits over the injected `MllpTransport`
// (`./mllp-transport.ts`), and acts on every outcome. It never reimplements any pure core's decision logic.
//
// RETRY MECHANISM: a poll-based sweep over `idx_hmo_next_retry`, not per-row BullMQ delayed jobs — the
// decision and its reasoning live in `./queues.ts`'s header.
//
// TWO DOCUMENTED PHASE-1 GAPS THIS FILE INHERITS FROM `./feed-resolver.ts` (read that file's header first):
// (1) feed resolution ignores `labDestinationFacilityId` (no column links a feed to a facility on the real
// schema) and instead requires exactly one active `orm_outbound` feed per org; (2) the ORM wire's MSH-3/4/5/6
// identity fields fall back to the feed's `displayName` (no dedicated columns exist). Both are flagged for
// the coordinator, not silently guessed past.
//
// A THIRD DECISION THIS FILE MAKES: there is NO app-level M4 `audit()` API anywhere in this codebase — every
// M4 capture found (grep confirmed) is the GENERATED write-audit DB TRIGGER on a table write (migration 0148
// declares one on `hl7_message_outbound` for exactly this table, denylisting `payload_cipher`/
// `ack_payload_cipher`). Every `OutboundAuditRecord` this file's cores hand back that corresponds to a REAL
// row INSERT/UPDATE is therefore ALREADY captured automatically — no extra call needed. The two kinds with
// NO underlying row write (`hl7.outbound.baa_refuse` — pre-persist; `hl7.outbound.orphan_ack` — no
// correlating row) have nothing to trigger on, so `logAuditIntent` below structurally logs them instead of
// fabricating a call to an M4 write-API this codebase does not have.
import { randomUUID } from "node:crypto";

import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { OrmRequestedPayload } from "@wardenx/types";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, eq, isNotNull, lte } from "drizzle-orm";

import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { getSeam } from "../../../bootstrap/index";
import { decideBaaGate } from "../feed/baa-gate";
import { sha256Hex } from "../listener/mllp-framing";
import {
  type AckCorrelationResult,
  type CorrelatedOutboundRow,
  correlateAck,
  parseAckMsa,
} from "./ack-correlation";
import {
  type OutboundPayloadCipher,
  type OutboundTenantKeyProvider,
  createOutboundPayloadCipher,
} from "./dispatch-crypto";
import {
  ORM_SOURCE_KIND,
  type OutboundDispatchPlan,
  outboundIdempotencyKey,
  planOutboundDispatch,
} from "./dispatch-planner";
import {
  type FeedResolutionResult,
  type OutboundFeedResolver,
  buildDrizzleOutboundFeedResolver,
} from "./feed-resolver";
import {
  type MllpTransport,
  type MllpTransportOutcome,
  createNodeMllpTransport,
} from "./mllp-transport";
import type { OutboundAlert, OutboundAuditRecord } from "./outbound-events";
import { M29_OUTBOUND_CRON_QUEUES, M29_OUTBOUND_JOB_SCHEDULES, M29_OUTBOUND_QUEUE_PARAMS, M29_OUTBOUND_RETRY_SWEEP_BATCH_SIZE } from "./queues";
import { type FeedRateLimiter, createFeedRateLimiter } from "./rate-limiter";
import { decideRetry } from "./retry-policy";
import { resolveOutboundBaaResult } from "./resolve-baa";
import type { M29WriteOutboxPort } from "../routes/store-drizzle";

const HMO = schema.hl7MessageOutbound;

/** System-driven write (an outbox consumer, not a human reviewer) — the F-102 `CONSUMER_USER_ID`
 *  convention this arc uses throughout (`m5-patient-deceased.ts`, `state-channel-health-jobs.ts`, …). */
const SYSTEM_USER_ID = "";

/** MLLP TCP connect timeout. No spec value is pinned for this; a conservative default. */
const OUTBOUND_CONNECT_TIMEOUT_MS = 10_000;
/** ACK wait timeout — the one number the (superseded) T-29.08 addendum sketch actually pins ("30s timeout"),
 *  kept as the one concrete precedent even though the rest of that doc is stale against the real schema. */
const OUTBOUND_ACK_TIMEOUT_MS = 30_000;

export const M29_OUTBOUND_DISPATCH_CONSUMER = {
  eventName: "m11.order.hl7_orm_requested",
  consumerName: "m29.outbound-dispatch",
} as const;

/** The M36 `AlertEmitter` seam's structural shape (the `getSeam("AlertEmitter")` inline-cast precedent used
 *  throughout this arc, e.g. M23's taxonomy consumer in `index.ts`) — declared locally so this file never
 *  imports a concrete M36 package. */
export interface OutboundAlertPort {
  emit(
    organizationId: string,
    input: {
      readonly eventType: string;
      readonly payload: Record<string, unknown>;
      readonly severity: string;
      readonly correlationId: string;
    },
  ): Promise<unknown>;
}

export interface OutboundDispatchWorkerDeps {
  readonly db: DbClient;
  /** The catalog-validating tx outbox publisher, bound `bindCallerModule(txOutboxPublisher, "m29")` at the
   *  composition root (the same `m29OutboxPublisher` the `m5-patient-deceased` consumer already uses). */
  readonly outbox: M29WriteOutboxPort;
  /** M34's real per-tenant DEK seam (`getTenantKeyProvider()`), or a test double. */
  readonly keys: OutboundTenantKeyProvider;
  /** Defaults to `createNodeMllpTransport()`. Injectable — the live test suite passes a real transport
   *  pointed at an in-process mock MLLP server; nothing here talks to a socket directly. */
  readonly transport?: MllpTransport;
  readonly feedResolver?: OutboundFeedResolver;
  /** Share ONE instance across the dispatch consumer AND the retry-sweep worker (pass the SAME object to
   *  both builders) so the per-feed throttle budget is shared across both paths — see `./rate-limiter.ts`. */
  readonly rateLimiter?: FeedRateLimiter;
  /** The M36 alert seam. Defaults to `getSeam("AlertEmitter")`, resolved lazily per call (never at module
   *  load — the RULE-4-adjacent "resolve at call time" posture other M29 files already use). */
  readonly alerts?: OutboundAlertPort;
  readonly now?: () => Date;
}

interface ResolvedDeps {
  readonly db: DbClient;
  readonly outbox: M29WriteOutboxPort;
  readonly cipher: OutboundPayloadCipher;
  readonly transport: MllpTransport;
  readonly feedResolver: OutboundFeedResolver;
  readonly rateLimiter: FeedRateLimiter;
  readonly alerts?: OutboundAlertPort;
  readonly now: () => Date;
}

function resolveDeps(deps: OutboundDispatchWorkerDeps): ResolvedDeps {
  return {
    db: deps.db,
    outbox: deps.outbox,
    cipher: createOutboundPayloadCipher(deps.keys),
    transport: deps.transport ?? createNodeMllpTransport(),
    feedResolver: deps.feedResolver ?? buildDrizzleOutboundFeedResolver(),
    rateLimiter: deps.rateLimiter ?? createFeedRateLimiter(),
    alerts: deps.alerts,
    now: deps.now ?? (() => new Date()),
  };
}

function logAuditIntent(record: OutboundAuditRecord): void {
  // See the file header — the two no-row-backed audit kinds (`baa_refuse`, `orphan_ack`) have no M4
  // write-API to call, so this is a structured log line, not a fabricated persistence call.
  console.info("m29.outbound.audit_intent", record);
}

async function emitAlert(
  deps: ResolvedDeps,
  organizationId: string,
  alert: OutboundAlert,
): Promise<void> {
  try {
    const emitter = deps.alerts ?? (getSeam("AlertEmitter") as OutboundAlertPort);
    await emitter.emit(organizationId, {
      eventType: alert.kind,
      payload: { feedId: alert.feedId, detail: alert.detail },
      severity: alert.severity,
      correlationId: `m29-outbound:${alert.kind}:${alert.feedId}`,
    });
  } catch (err) {
    // Alerting failure must never block or crash the dispatch pipeline itself.
    console.error("m29.outbound.alert_emit_failed", err);
  }
}

function isOrmRequestedPayload(payload: unknown): payload is OrmRequestedPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.orderId === "string" &&
    typeof p.organizationId === "string" &&
    typeof p.requestedAt === "string" &&
    typeof p.labOrderPayload === "object" &&
    p.labOrderPayload !== null
  );
}

// ── The shared transmit + outcome-handling core, used by BOTH the fresh-dispatch path and the retry sweep ──

interface TransmitContext {
  readonly id: string;
  readonly organizationId: string;
  readonly feedId: string;
  readonly sourceAggregateId: string;
  readonly messageControlId: string;
  /** Attempts already made and failed BEFORE this attempt (0 on the very first dispatch). */
  readonly retryCount: number;
  readonly host: string;
  readonly port: number;
  readonly protocol: "mllp_tls" | "mllp_plain";
  readonly channelCertPin: string | null;
  readonly rateLimitMsgPerSec: number;
  readonly wirePlaintext: string;
}

function transportErrorLabel(outcome: Exclude<MllpTransportOutcome, { kind: "ack" }>): string {
  switch (outcome.kind) {
    case "connect_error":
      return `connect_error:${outcome.errorClass}`;
    case "tls_error":
      return `tls_error:${outcome.errorClass}`;
    case "connect_timeout":
      return "connect_timeout";
    case "ack_timeout":
      return "ack_timeout";
    case "write_error":
      return `write_error:${outcome.errorClass}`;
    case "malformed_response":
      return `malformed_response:${outcome.errorClass}`;
  }
}

async function applyRetryDecision(
  deps: ResolvedDeps,
  tx: DbClient,
  ctx: TransmitContext,
  lastError: string,
  now: Date,
): Promise<void> {
  const decision = decideRetry({
    outbound: {
      id: ctx.id,
      feedId: ctx.feedId,
      organizationId: ctx.organizationId,
      sourceAggregateId: ctx.sourceAggregateId,
      retryCount: ctx.retryCount,
    },
    now,
    lastError,
  });

  await tx
    .update(HMO)
    .set({
      status: decision.statusUpdate.status,
      retryCount: decision.statusUpdate.retryCount,
      nextRetryAt: decision.statusUpdate.nextRetryAt,
    })
    .where(and(eq(HMO.id, ctx.id), eq(HMO.organizationId, ctx.organizationId)));

  if (decision.kind === "dlq") {
    await deps.outbox.publish(tx, {
      eventName: decision.event.name,
      payload: decision.event.payload as unknown as Record<string, unknown>,
      organizationId: ctx.organizationId,
      aggregateKind: "hl7_message_outbound",
      aggregateId: ctx.id,
    });
    await emitAlert(deps, ctx.organizationId, decision.alert);
  }
  logAuditIntent(decision.audit);
}

async function applyAckStatusUpdate(
  deps: ResolvedDeps,
  tx: DbClient,
  ctx: TransmitContext,
  rawAckPayload: string,
  statusUpdate: Extract<AckCorrelationResult, { kind: "acked" | "rejected" }>["statusUpdate"],
  extra: { retryCount?: number; nextRetryAt?: null } = {},
): Promise<void> {
  const ackPayloadCipher = await deps.cipher.encrypt(ctx.organizationId, "ack_payload", rawAckPayload);
  await tx
    .update(HMO)
    .set({
      status: statusUpdate.status,
      ackStatus: statusUpdate.ackStatus,
      ackReceivedAt: statusUpdate.ackReceivedAt,
      ackPayloadSha256: statusUpdate.ackPayloadSha256,
      ackPayloadCipher,
      transmittedAt: statusUpdate.transmittedAt,
      ...extra,
    })
    .where(and(eq(HMO.id, ctx.id), eq(HMO.organizationId, ctx.organizationId)));
}

async function handleAckOutcome(
  deps: ResolvedDeps,
  tx: DbClient,
  ctx: TransmitContext,
  rawAckPayload: string,
  now: Date,
): Promise<void> {
  const parsed = parseAckMsa(rawAckPayload);
  if (parsed === null) {
    // No MSA segment at all in the response — malformed, handled exactly like the transport's own
    // `malformed_response` outcome.
    await applyRetryDecision(deps, tx, ctx, "malformed_response:no_msa", now);
    return;
  }

  const ackPayloadSha256 = sha256Hex(rawAckPayload);

  if (parsed.messageControlId !== ctx.messageControlId) {
    // An ack whose MSA-2 does not correlate to the request we just sent on THIS connection. Per the
    // brief: log + discard, no state change — the row is left as it was (an operator investigates a
    // stuck row manually; out of scope here, same as `correlateAck`'s own `orphan` shape for a truly
    // unsolicited ack).
    const orphan = correlateAck({ ack: parsed, outbound: null, ackReceivedAt: now, ackPayloadSha256 });
    // `outbound: null` always yields `kind: "orphan"` (`correlateAck`'s own first branch) — narrowed
    // explicitly since the function's declared return type is the full union regardless of the input.
    if (orphan.kind === "orphan") logAuditIntent(orphan.audit);
    return;
  }

  const correlated: CorrelatedOutboundRow = {
    id: ctx.id,
    feedId: ctx.feedId,
    organizationId: ctx.organizationId,
    sourceAggregateId: ctx.sourceAggregateId,
    // `correlateAck`'s own doc comment: "1-based once dispatched" — the CURRENT attempt, including this one.
    retryCount: ctx.retryCount + 1,
  };
  const result = correlateAck({ ack: parsed, outbound: correlated, ackReceivedAt: now, ackPayloadSha256 });

  switch (result.kind) {
    case "acked": {
      await applyAckStatusUpdate(deps, tx, ctx, rawAckPayload, result.statusUpdate);
      await deps.outbox.publish(tx, {
        eventName: result.event.name,
        payload: result.event.payload as unknown as Record<string, unknown>,
        organizationId: ctx.organizationId,
        aggregateKind: "hl7_message_outbound",
        aggregateId: ctx.id,
      });
      logAuditIntent(result.audit);
      return;
    }
    case "rejected": {
      await applyAckStatusUpdate(deps, tx, ctx, rawAckPayload, result.statusUpdate, {
        retryCount: ctx.retryCount + 1,
        nextRetryAt: null,
      });
      await deps.outbox.publish(tx, {
        eventName: result.event.name,
        payload: result.event.payload as unknown as Record<string, unknown>,
        organizationId: ctx.organizationId,
        aggregateKind: "hl7_message_outbound",
        aggregateId: ctx.id,
      });
      await emitAlert(deps, ctx.organizationId, result.alert);
      logAuditIntent(result.audit);
      return;
    }
    case "transport_error": {
      // AE (or any non-AA/AR code) — a retryable application error, handed to the retry policy verbatim
      // (never AR's own "no retry" path — `correlateAck` already routed AR through `rejected` above).
      await applyRetryDecision(
        deps,
        tx,
        ctx,
        `ack_${result.ackCode || "AE"}:${result.detail}`.slice(0, 160),
        now,
      );
      return;
    }
    case "orphan": {
      // Unreachable in practice (the mismatch branch above already returns) — defensive completeness.
      logAuditIntent(result.audit);
      return;
    }
  }
}

async function attemptTransmit(
  deps: ResolvedDeps,
  tx: DbClient,
  ctx: TransmitContext,
  now: Date,
): Promise<void> {
  await deps.rateLimiter.acquire(ctx.feedId, ctx.rateLimitMsgPerSec);

  await tx
    .update(HMO)
    .set({ status: "in_flight" })
    .where(and(eq(HMO.id, ctx.id), eq(HMO.organizationId, ctx.organizationId)));

  const outcome = await deps.transport.send({
    host: ctx.host,
    port: ctx.port,
    protocol: ctx.protocol,
    channelCertPin: ctx.channelCertPin,
    wireMessage: ctx.wirePlaintext,
    connectTimeoutMs: OUTBOUND_CONNECT_TIMEOUT_MS,
    ackTimeoutMs: OUTBOUND_ACK_TIMEOUT_MS,
  });

  if (outcome.kind === "ack") {
    await handleAckOutcome(deps, tx, ctx, outcome.rawAckPayload, now);
    return;
  }

  await applyRetryDecision(deps, tx, ctx, transportErrorLabel(outcome), now);
}

// ── Fresh dispatch: the `m11.order.hl7_orm_requested` OutboxConsumerBinding ──────────────────────────────

async function alertUnresolvedFeed(
  deps: ResolvedDeps,
  organizationId: string,
  orderId: string,
  failure: Extract<FeedResolutionResult, { kind: "unresolved" }>,
): Promise<void> {
  const feedId = failure.reason === "ambiguous_feed" ? failure.candidateFeedIds.join(",") : "none";
  await emitAlert(deps, organizationId, {
    // Borrows the closest catalogued `OutboundAlert.kind` — no dedicated kind exists for "no destination
    // feed configured" in the pinned `outbound-events.ts` union, and extending that union is out of this
    // file's scope (it is one of the pure cores this file orchestrates, not reimplements).
    kind: "hl7_outbound.transmission_failed",
    severity: "HIGH",
    channel: "operator-on-call",
    feedId,
    detail: `outbound ORM dispatch refused: ${failure.reason} active orm_outbound feed for org (orderId=${orderId})`,
  });
}

async function handleOrmRequested(deps: ResolvedDeps, event: DispatchableOutboxEvent): Promise<void> {
  const organizationId = event.organizationId;
  if (!isOrmRequestedPayload(event.payload)) {
    throw new Error(
      `${M29_OUTBOUND_DISPATCH_CONSUMER.consumerName}: ${M29_OUTBOUND_DISPATCH_CONSUMER.eventName} carries a malformed OrmRequestedPayload`,
    );
  }
  const payload = event.payload;

  await withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (scoped) => {
    const tx = scoped as unknown as DbClient;
    const now = deps.now();

    const feedResult = await deps.feedResolver.resolveForOrg(tx, organizationId, now);
    if (feedResult.kind === "unresolved") {
      await alertUnresolvedFeed(deps, organizationId, payload.orderId, feedResult);
      return;
    }
    const feed = feedResult.feed;

    // Idempotency (D14/§2.6): a redelivered `m11.order.hl7_orm_requested` for the same (feed, order) must
    // never double-dispatch. `idx_hmo_idempotency` is a lookup index, not a unique constraint (checked
    // against the migration) — this SELECT-before-INSERT, run inside the same org-scoped transaction as
    // the insert, is the defense the brief asks for against a sequential redelivery (the realistic replay
    // shape: the SAME event handled twice by this consumer). It does not close a true concurrent-delivery
    // race (two overlapping transactions both passing the SELECT before either commits) — that would need
    // a real unique index, a genuine schema follow-up flagged in `feed-resolver.ts`'s header, not added
    // here since it is schema surface this task's scope did not include touching.
    const idempotencyKey = outboundIdempotencyKey(feed.id, ORM_SOURCE_KIND, payload.orderId);
    const existing = await tx
      .select({ id: HMO.id })
      .from(HMO)
      .where(and(eq(HMO.organizationId, organizationId), eq(HMO.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (existing.length > 0) return;

    const baaResult = await resolveOutboundBaaResult({
      organizationId,
      destinationFacilityId: payload.labDestinationFacilityId ?? null,
      asOf: now,
    });
    const baaDecision = decideBaaGate(baaResult);

    const outboundMessageId = randomUUID();
    const messageControlId = randomUUID().replace(/-/g, "");

    const plan: OutboundDispatchPlan = planOutboundDispatch({
      request: payload,
      feed: { id: feed.id, organizationId, endpoint: feed.endpoint },
      baa: baaDecision,
      destinationFacilityId: payload.labDestinationFacilityId ?? null,
      outboundMessageId,
      messageControlId,
      queuedAt: now,
    });

    if (plan.kind === "baa_refused") {
      // Per the dispatch planner's own header + the brief: NO row, NO `transmission_failed` (a BAA lapse
      // is transient) — publish the audit/alert intent and stop.
      await emitAlert(deps, organizationId, plan.alert);
      logAuditIntent(plan.audit);
      return;
    }

    const payloadCipher = await deps.cipher.encrypt(organizationId, "payload", plan.wire);
    const [inserted] = await tx
      .insert(HMO)
      .values({
        ...plan.row,
        payloadCipher,
        status: "in_flight",
        // A safety net, not part of the pure draft: if this process crashes between the insert below and
        // the transmit attempt that follows in the same call, the row is left `in_flight` with
        // `nextRetryAt` already due — but the retry sweep only ever picks up `status='queued'` rows, so a
        // genuinely crashed in-flight row needs its OWN reconciliation sweep (`in_flight` rows older than
        // the ack timeout), which is not built here (flagged, not fabricated) — this field is set for
        // forward-compatibility with such a sweep, not a currently-consumed value.
        nextRetryAt: now,
      })
      .returning();
    const row = inserted!;

    await attemptTransmit(
      deps,
      tx,
      {
        id: row.id,
        organizationId,
        feedId: feed.id,
        sourceAggregateId: row.sourceAggregateId,
        messageControlId: row.messageControlId,
        retryCount: row.retryCount,
        host: feed.host,
        port: feed.port,
        protocol: feed.protocol,
        channelCertPin: feed.channelCertPin,
        rateLimitMsgPerSec: feed.rateLimitMsgPerSec,
        wirePlaintext: plan.wire,
      },
      now,
    );
  });
}

export function buildM29OutboundDispatchConsumer(
  deps: OutboundDispatchWorkerDeps,
): OutboxConsumerBinding {
  const resolved = resolveDeps(deps);
  return {
    consumerName: M29_OUTBOUND_DISPATCH_CONSUMER.consumerName,
    consumerModule: "m29",
    eventTypes: [M29_OUTBOUND_DISPATCH_CONSUMER.eventName],
    handle: (event) => handleOrmRequested(resolved, event),
  };
}

// ── Retry sweep: the poll-based worker over `idx_hmo_next_retry` (see `./queues.ts`'s header for why) ─────

export interface OutboundRetrySweepDeps extends OutboundDispatchWorkerDeps {
  readonly activeOrgs: { listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]> };
}

/** Runs one sweep tick, driven directly (the `runStateChannelHealth` precedent — testable without BullMQ). */
export async function runOutboundRetrySweepOnce(deps: OutboundRetrySweepDeps): Promise<void> {
  const resolved = resolveDeps(deps);
  const now = resolved.now();
  const orgs = await deps.activeOrgs.listActiveOrgs();

  for (const { organizationId } of orgs) {
    await withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (scoped) => {
      const tx = scoped as unknown as DbClient;
      const due = await tx
        .select()
        .from(HMO)
        .where(
          and(
            eq(HMO.organizationId, organizationId),
            eq(HMO.status, "queued"),
            isNotNull(HMO.nextRetryAt),
            lte(HMO.nextRetryAt, now),
          ),
        )
        .limit(M29_OUTBOUND_RETRY_SWEEP_BATCH_SIZE);

      for (const row of due) {
        const feedResult = await resolved.feedResolver.resolveForOrg(tx, organizationId, now);
        // The row's feed must still be THE org's sole resolvable active feed — if the feed configuration
        // changed (suspended, or a second `orm_outbound` feed added) since this row was queued, defer
        // rather than risk transmitting through the wrong endpoint; the next tick re-checks.
        if (feedResult.kind !== "resolved" || feedResult.feed.id !== row.feedId) continue;

        const wirePlaintext = await resolved.cipher.decrypt(organizationId, "payload", row.payloadCipher);
        await attemptTransmit(
          resolved,
          tx,
          {
            id: row.id,
            organizationId,
            feedId: row.feedId,
            sourceAggregateId: row.sourceAggregateId,
            messageControlId: row.messageControlId,
            retryCount: row.retryCount,
            host: feedResult.feed.host,
            port: feedResult.feed.port,
            protocol: feedResult.feed.protocol,
            channelCertPin: feedResult.feed.channelCertPin,
            rateLimitMsgPerSec: feedResult.feed.rateLimitMsgPerSec,
            wirePlaintext,
          },
          now,
        );
      }
    });
  }
}

/** Construct the BullMQ Worker (one process-lifetime `resolveDeps()` — shares the rate limiter / transport
 *  across every tick, the `registerM24StateChannelHealthWorker` `breaker`-Map-outside-the-processor shape). */
export function registerM29OutboundRetrySweepWorker(
  deps: OutboundRetrySweepDeps & { readonly connection: ConnectionOptions },
): Worker {
  return new Worker(
    M29_OUTBOUND_CRON_QUEUES.retrySweep,
    () => runOutboundRetrySweepOnce(deps),
    { connection: deps.connection, concurrency: M29_OUTBOUND_QUEUE_PARAMS.retrySweep.concurrency },
  );
}

/** Register the repeatable schedule. Returns the Queue so the composition root can `close()` it. */
export async function scheduleM29OutboundRetrySweepJob(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M29_OUTBOUND_CRON_QUEUES.retrySweep, { connection });
  await queue.add("tick", {}, { repeat: { pattern: M29_OUTBOUND_JOB_SCHEDULES.retrySweep, tz: "UTC" } });
  return queue;
}
