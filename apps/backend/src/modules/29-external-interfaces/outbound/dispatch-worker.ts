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
// F-179 — CLAIM → SEND → FINALIZE, and the `in_flight` RECLAIM. Every attempt (fresh or retry) commits its
// `in_flight` claim (with `next_retry_at` as a LEASE expiry) in its own transaction, sends with NO transaction
// held across the socket, then writes the outcome in a second, claim-guarded transaction. The same tick first
// reclaims expired leases (`reclaimStaleInFlight`): a state transition back to `queued` that the retry pass then
// re-sends with the SAME stored wire (same MSH-10 → the receiver can dedupe), bounded by the shared attempt
// budget, alerting every time. Read `./retry-policy.ts`'s F-179 block for the duplicate-send reasoning.
//
// F-178 CLOSED THE TWO PHASE-1 GAPS this file used to inherit from `./feed-resolver.ts`: feeds now route by
// `external_feed.lab_destination_facility_id` (single-feed fallback only for an unlinked sole feed), and MSH-3/4/5/6
// come from dedicated `msh_*` columns — a feed missing a required one is REFUSED (`OutboundFeedIdentityIncompleteError`,
// alert + throw so the outbox dispatcher retries/DLQs) instead of borrowing its display name. Read that file's header.
//
// A DECISION THIS FILE MAKES: there is NO app-level M4 `audit()` API anywhere in this codebase — every
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
import { and, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

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
import {
  type OutboundDestinationPolicy,
  checkProtocol,
  resolveDestinationPolicy,
} from "./destination-policy";
import {
  OUTBOUND_IN_FLIGHT_LEASE_MS,
  decideInFlightReclaim,
  decidePermanentFailure,
  decideRetry,
} from "./retry-policy";
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
  /** F-178 — which protocols / destinations this deployment may dial. Defaults to
   *  `resolveDestinationPolicy(process.env)`: `mllp_plain` refused unless NOT production AND
   *  `M29_ALLOW_MLLP_PLAIN=true`; loopback refused in production; link-local/metadata always refused. */
  readonly destinationPolicy?: OutboundDestinationPolicy;
  /** F-179 — how long a claimed `in_flight` row is presumed to have a live worker behind it before the
   *  reclaim sweep may take it back. Defaults to `OUTBOUND_IN_FLIGHT_LEASE_MS`; keep it well above the
   *  transport's connect + ack timeouts (a reclaim of a merely-slow worker looks like a duplicate send). */
  readonly inFlightLeaseMs?: number;
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
  readonly policy: OutboundDestinationPolicy;
  readonly leaseMs: number;
}

function resolveDeps(deps: OutboundDispatchWorkerDeps): ResolvedDeps {
  // Only an actual number overrides the default (`arch:outbox-bindings` builds every binding with a stub deps
  // object whose properties are placeholders — construction must not choke on a non-number there).
  const leaseMs =
    typeof deps.inFlightLeaseMs === "number" ? deps.inFlightLeaseMs : OUTBOUND_IN_FLIGHT_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new Error("M29 outbound: inFlightLeaseMs must be a positive number of milliseconds");
  }
  return {
    leaseMs,
    db: deps.db,
    outbox: deps.outbox,
    cipher: createOutboundPayloadCipher(deps.keys),
    transport: deps.transport ?? createNodeMllpTransport(),
    feedResolver: deps.feedResolver ?? buildDrizzleOutboundFeedResolver(),
    rateLimiter: deps.rateLimiter ?? createFeedRateLimiter(),
    alerts: deps.alerts,
    now: deps.now ?? (() => new Date()),
    policy: deps.destinationPolicy ?? resolveDestinationPolicy(process.env),
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
    // F-178 — log only the error's class and the feed id, never the error object: an emitter/driver error can
    // carry request context, and this path handles a PHI-adjacent outbound pipeline.
    console.error("m29.outbound.alert_emit_failed", {
      feedId: alert.feedId,
      errorName: err instanceof Error ? err.name : "unknown",
    });
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

/**
 * F-179 — the CLAIM GUARD every outcome write carries. A row is claimed `in_flight` (committed, with a lease)
 * before the socket send and finalized in a separate transaction; between the two, a reclaim sweep may have
 * taken the row back (`status → queued|dlq`, `retry_count + 1`). The finalizer therefore only writes while the
 * row is STILL `in_flight` at the `retry_count` it was claimed at — a slow worker that lost its lease affects
 * zero rows, publishes nothing, and the reclaimer's attempt (same wire, same MSH-10) stands.
 */
function claimGuard(ctx: TransmitContext) {
  return and(
    eq(HMO.id, ctx.id),
    eq(HMO.organizationId, ctx.organizationId),
    eq(HMO.status, "in_flight"),
    eq(HMO.retryCount, ctx.retryCount),
  );
}

/** Logged (ids only, no PHI) when a finalizer finds its claim gone — the reclaimer owns the row now. */
function logClaimLost(ctx: TransmitContext): void {
  console.warn("m29.outbound.claim_lost", { outboundMessageId: ctx.id, feedId: ctx.feedId });
}

function transportErrorLabel(outcome: Exclude<MllpTransportOutcome, { kind: "ack" }>): string {
  switch (outcome.kind) {
    case "connect_error":
      return `connect_error:${outcome.errorClass}`;
    case "tls_error":
      return `tls_error:${outcome.errorClass}`;
    case "connect_timeout":
      return "connect_timeout";
    case "destination_refused":
      return outcome.errorClass;
    case "ack_timeout":
      return "ack_timeout";
    case "write_error":
      return `write_error:${outcome.errorClass}`;
    case "malformed_response":
      return `malformed_response:${outcome.errorClass}`;
  }
}

/** F-178 — a refusal retrying cannot fix: terminal DLQ now (same persistence + event + alert as an
 *  exhausted DLQ). `label` is a short fixed PHI-free string. */
async function applyPermanentFailure(
  deps: ResolvedDeps,
  tx: DbClient,
  ctx: TransmitContext,
  label: string,
  now: Date,
): Promise<void> {
  const decision = decidePermanentFailure({
    outbound: {
      id: ctx.id,
      feedId: ctx.feedId,
      organizationId: ctx.organizationId,
      sourceAggregateId: ctx.sourceAggregateId,
      retryCount: ctx.retryCount,
    },
    now,
    lastError: label,
  });
  const held = await tx
    .update(HMO)
    .set({
      status: decision.statusUpdate.status,
      retryCount: decision.statusUpdate.retryCount,
      nextRetryAt: decision.statusUpdate.nextRetryAt,
    })
    .where(claimGuard(ctx))
    .returning({ id: HMO.id });
  if (held.length === 0) return logClaimLost(ctx);
  await deps.outbox.publish(tx, {
    eventName: decision.event.name,
    payload: decision.event.payload as unknown as Record<string, unknown>,
    organizationId: ctx.organizationId,
    aggregateKind: "hl7_message_outbound",
    aggregateId: ctx.id,
  });
  await emitAlert(deps, ctx.organizationId, decision.alert);
  logAuditIntent(decision.audit);
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

  const held = await tx
    .update(HMO)
    .set({
      status: decision.statusUpdate.status,
      retryCount: decision.statusUpdate.retryCount,
      nextRetryAt: decision.statusUpdate.nextRetryAt,
    })
    .where(claimGuard(ctx))
    .returning({ id: HMO.id });
  if (held.length === 0) return logClaimLost(ctx);

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
): Promise<boolean> {
  const ackPayloadCipher = await deps.cipher.encrypt(ctx.organizationId, "ack_payload", rawAckPayload);
  const held = await tx
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
    .where(claimGuard(ctx))
    .returning({ id: HMO.id });
  if (held.length === 0) logClaimLost(ctx);
  return held.length > 0;
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
    // brief: log + discard, no state change. F-179: the row is left `in_flight` on its lease, so the reclaim
    // sweep picks it up once the lease expires (attempt counted, same wire/MSH-10, alert raised) instead of
    // the row sitting `in_flight` forever as it did before the lease existed.
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
      if (!(await applyAckStatusUpdate(deps, tx, ctx, rawAckPayload, result.statusUpdate))) return;
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
      const held = await applyAckStatusUpdate(deps, tx, ctx, rawAckPayload, result.statusUpdate, {
        retryCount: ctx.retryCount + 1,
        nextRetryAt: null,
      });
      if (!held) return;
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

/**
 * F-179 — the CLAIM → SEND → FINALIZE split. Before F-179 this ran insert, the `in_flight` write, the socket
 * send and the outcome write inside ONE database transaction, so a crash mid-send rolled the row back with the
 * send's outcome unknown: no committed `in_flight` row existed to reclaim, and the outbox redelivery inserted a
 * FRESH row with a NEW MSH-10 (a possible second order at the lab). Now:
 *   1. CLAIM  — the caller commits the row as `in_flight` with `next_retry_at = now + lease` (its own tx);
 *   2. SEND   — `transmitClaimed`, NO transaction held open across the socket;
 *   3. FINALIZE — `finalizeClaimed`, a second tx whose writes are `claimGuard`ed.
 * A crash between 1 and 3 leaves a committed `in_flight` row the reclaim sweep recovers.
 */
async function transmitClaimed(deps: ResolvedDeps, ctx: TransmitContext): Promise<MllpTransportOutcome> {
  await deps.rateLimiter.acquire(ctx.feedId, ctx.rateLimitMsgPerSec);
  return deps.transport.send({
    host: ctx.host,
    port: ctx.port,
    protocol: ctx.protocol,
    channelCertPin: ctx.channelCertPin,
    wireMessage: ctx.wirePlaintext,
    connectTimeoutMs: OUTBOUND_CONNECT_TIMEOUT_MS,
    allowLoopback: deps.policy.allowLoopback,
    ackTimeoutMs: OUTBOUND_ACK_TIMEOUT_MS,
  });
}

async function finalizeClaimed(
  deps: ResolvedDeps,
  ctx: TransmitContext,
  outcome: MllpTransportOutcome,
): Promise<void> {
  await withOrgContext(
    deps.db,
    { organizationId: ctx.organizationId, userId: SYSTEM_USER_ID },
    async (scoped) => {
      const tx = scoped as unknown as DbClient;
      // The send can take up to connect + ack timeout, so the backoff is measured from when it FINISHED.
      const now = deps.now();
      if (outcome.kind === "ack") {
        await handleAckOutcome(deps, tx, ctx, outcome.rawAckPayload, now);
      } else if (outcome.kind === "destination_refused") {
        await applyPermanentFailure(deps, tx, ctx, outcome.errorClass, now);
      } else {
        await applyRetryDecision(deps, tx, ctx, transportErrorLabel(outcome), now);
      }
    },
  );
}

/** The lease a fresh claim takes: `next_retry_at` doubles as the `in_flight` lease expiry. */
function leaseExpiry(deps: ResolvedDeps, now: Date): Date {
  return new Date(now.getTime() + deps.leaseMs);
}

// ── Fresh dispatch: the `m11.order.hl7_orm_requested` OutboxConsumerBinding ──────────────────────────────

async function alertUnresolvedFeed(
  deps: ResolvedDeps,
  organizationId: string,
  orderId: string,
  failure: Extract<FeedResolutionResult, { kind: "unresolved" }>,
): Promise<void> {
  const feedId =
    failure.reason === "ambiguous_feed" || failure.reason === "no_feed_for_destination"
      ? failure.candidateFeedIds.join(",")
      : failure.reason === "feed_identity_incomplete"
        ? failure.feedId
        : "none";
  const detail =
    failure.reason === "feed_identity_incomplete"
      ? `outbound ORM dispatch refused: feed_identity_incomplete — MSH identity not configured (${failure.missingFields.join(",")}) (orderId=${orderId})`
      : failure.reason === "no_feed_for_destination"
        ? `outbound ORM dispatch refused: no_feed_for_destination — no active orm_outbound feed is linked to the order's lab destination (orderId=${orderId})`
        : `outbound ORM dispatch refused: ${failure.reason} active orm_outbound feed for org (orderId=${orderId})`;
  await emitAlert(deps, organizationId, {
    // Borrows the closest catalogued `OutboundAlert.kind` — no dedicated kind exists for "no destination
    // feed configured" in the pinned `outbound-events.ts` union, and extending that union is out of this
    // file's scope (it is one of the pure cores this file orchestrates, not reimplements).
    kind: "hl7_outbound.transmission_failed",
    severity: "HIGH",
    channel: "operator-on-call",
    feedId,
    detail,
  });
}

/**
 * F-178 — thrown when the resolved feed lacks a REQUIRED MSH identity field. Unlike `no_active_feed` /
 * `ambiguous_feed` (alert + return), an incomplete identity is an OPERATOR-FIXABLE configuration gap on a feed
 * that IS the right destination, so the order must not be silently dropped: the throw lets the outbox
 * dispatcher retry and, if the operator has not completed the feed by `maxAttempts`, dead-letter the event
 * for redrive. The message carries the feed id and FIELD NAMES only — no value, nothing PHI-shaped.
 */
export class OutboundFeedIdentityIncompleteError extends Error {
  readonly code = "M29_OUTBOUND_FEED_IDENTITY_INCOMPLETE";
  constructor(
    readonly feedId: string,
    readonly missingFields: readonly string[],
  ) {
    super(
      `outbound ORM dispatch refused: feed ${feedId} has no MSH identity for ${missingFields.join(", ")}`,
    );
    this.name = "OutboundFeedIdentityIncompleteError";
  }
}

async function handleOrmRequested(deps: ResolvedDeps, event: DispatchableOutboxEvent): Promise<void> {
  const organizationId = event.organizationId;
  if (!isOrmRequestedPayload(event.payload)) {
    throw new Error(
      `${M29_OUTBOUND_DISPATCH_CONSUMER.consumerName}: ${M29_OUTBOUND_DISPATCH_CONSUMER.eventName} carries a malformed OrmRequestedPayload`,
    );
  }
  const payload = event.payload;

  // F-179 — CLAIM transaction: everything up to and including the committed `in_flight` row. The socket send
  // happens AFTER this commits (see `transmitClaimed`), so a crash mid-send leaves a reclaimable row.
  const claimed = await withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (scoped): Promise<TransmitContext | null> => {
    const tx = scoped as unknown as DbClient;
    const now = deps.now();

    const feedResult = await deps.feedResolver.resolveForOrg(
      tx,
      organizationId,
      now,
      payload.labDestinationFacilityId ?? null,
    );
    if (feedResult.kind === "unresolved") {
      await alertUnresolvedFeed(deps, organizationId, payload.orderId, feedResult);
      if (feedResult.reason === "feed_identity_incomplete") {
        throw new OutboundFeedIdentityIncompleteError(feedResult.feedId, feedResult.missingFields);
      }
      return null;
    }
    const feed = feedResult.feed;

    // Idempotency (D14/§2.6): a redelivered `m11.order.hl7_orm_requested` for the same (feed, order) must
    // never double-dispatch — including under a TRUE CONCURRENT redelivery (F-178). `hl7_message_outbound` is
    // PARTITIONED BY RANGE (queued_at), and Postgres requires every unique index on a partitioned table to
    // contain the partition key, so a `UNIQUE (organization_id, idempotency_key)` cannot exist (a key that
    // included `queued_at` would never collide, since each attempt stamps its own). The dedupe is instead
    // serialized with a transaction-scoped advisory lock on (org, idempotency key): two overlapping deliveries
    // queue behind one another, and the loser's SELECT (a fresh READ COMMITTED snapshot, taken after the lock is
    // granted) sees the winner's committed row. The lock is released at commit/rollback — nothing to clean up.
    const idempotencyKey = outboundIdempotencyKey(feed.id, ORM_SOURCE_KIND, payload.orderId);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`m29.outbound:${organizationId}:${idempotencyKey}`}, 0))`,
    );
    const existing = await tx
      .select({ id: HMO.id })
      .from(HMO)
      .where(and(eq(HMO.organizationId, organizationId), eq(HMO.idempotencyKey, idempotencyKey)))
      .limit(1);
    // A redelivery that finds a row — including one a crashed worker left `in_flight` — sends nothing: the
    // row already owns its MSH-10 and the reclaim sweep (F-179) is the only path that may re-send it.
    if (existing.length > 0) return null;

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
      return null;
    }

    const payloadCipher = await deps.cipher.encrypt(organizationId, "payload", plan.wire);
    const [inserted] = await tx
      .insert(HMO)
      .values({
        ...plan.row,
        payloadCipher,
        status: "in_flight",
        // F-179 — `next_retry_at` on an `in_flight` row is its LEASE EXPIRY: the reclaim sweep only takes a
        // row back once this has passed, so a live worker mid-send is never mistaken for a crashed one.
        nextRetryAt: leaseExpiry(deps, now),
      })
      .returning();
    const row = inserted!;

    const ctx: TransmitContext = {
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
    };

    // F-178 — protocol guard BEFORE any socket: a `mllp_plain` feed is cleartext PHI on the wire and is refused
    // unless this deployment is explicitly non-production with the opt-in. Fail closed to a terminal DLQ.
    const protocolRefusal = checkProtocol(ctx.protocol, deps.policy);
    if (protocolRefusal !== null) {
      await applyPermanentFailure(deps, tx, ctx, protocolRefusal, now);
      return null;
    }
    return ctx;
  });

  if (claimed === null) return;
  // SEND with no transaction open, then FINALIZE in a second one (both guarded by the claim — see `claimGuard`).
  const outcome = await transmitClaimed(deps, claimed);
  await finalizeClaimed(deps, claimed, outcome);
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

/**
 * F-179 — RECLAIM `in_flight` rows whose lease expired (a worker died between the committed claim and the
 * finalize, or an ack came back for a different MSH-10). A pure STATE TRANSITION, never a send:
 *   • `queued` again, `retry_count + 1`, backoff — the retry pass below resends the STORED wire, so the resend
 *     carries the SAME MSH-10 and a receiver that already processed the lost attempt can dedupe it;
 *   • the reclaim is an attempt on the shared 5-attempt budget; once spent the row goes terminal (`dlq`) with
 *     `m29.lab_order.transmission_failed` so M11 (F-177) marks the order failed and a human verifies with the
 *     lab — an outcome that stays unknown is never re-sent forever;
 *   • an operator alert on EVERY reclaim: a lost attempt is never silent.
 * Race safety: `FOR UPDATE SKIP LOCKED` (concurrent sweepers never take the same row) plus a conditional UPDATE
 * on `status='in_flight' AND retry_count` (a row a worker finalized between our read and write is untouched).
 */
async function reclaimStaleInFlight(deps: ResolvedDeps, organizationId: string, now: Date): Promise<void> {
  await withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (scoped) => {
    const tx = scoped as unknown as DbClient;
    const stale = await tx
      .select()
      .from(HMO)
      .where(
        and(
          eq(HMO.organizationId, organizationId),
          eq(HMO.status, "in_flight"),
          or(isNull(HMO.nextRetryAt), lte(HMO.nextRetryAt, now)),
        ),
      )
      .limit(M29_OUTBOUND_RETRY_SWEEP_BATCH_SIZE)
      .for("update", { skipLocked: true });

    for (const row of stale) {
      const decision = decideInFlightReclaim({
        outbound: {
          id: row.id,
          feedId: row.feedId,
          organizationId,
          sourceAggregateId: row.sourceAggregateId,
          retryCount: row.retryCount,
        },
        now,
      });
      const reclaimed = await tx
        .update(HMO)
        .set({
          status: decision.statusUpdate.status,
          retryCount: decision.statusUpdate.retryCount,
          nextRetryAt: decision.statusUpdate.nextRetryAt,
        })
        .where(
          and(
            eq(HMO.id, row.id),
            eq(HMO.organizationId, organizationId),
            eq(HMO.status, "in_flight"),
            eq(HMO.retryCount, row.retryCount),
          ),
        )
        .returning({ id: HMO.id });
      if (reclaimed.length === 0) continue;

      if (decision.kind === "dlq") {
        await deps.outbox.publish(tx, {
          eventName: decision.event.name,
          payload: decision.event.payload as unknown as Record<string, unknown>,
          organizationId,
          aggregateKind: "hl7_message_outbound",
          aggregateId: row.id,
        });
      }
      await emitAlert(deps, organizationId, decision.alert);
      logAuditIntent(decision.audit);
    }
  });
}

/**
 * F-179 — CLAIM the due `queued` retries: `queued → in_flight` with a fresh lease, COMMITTED, before any send.
 * `FOR UPDATE SKIP LOCKED` means two overlapping sweeps never claim (hence never send) the same row — before
 * F-179 both would have read it `queued` and both transmitted.
 */
async function claimDueRetries(
  deps: ResolvedDeps,
  organizationId: string,
  now: Date,
): Promise<TransmitContext[]> {
  return withOrgContext(deps.db, { organizationId, userId: SYSTEM_USER_ID }, async (scoped) => {
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
      .limit(M29_OUTBOUND_RETRY_SWEEP_BATCH_SIZE)
      .for("update", { skipLocked: true });

    const claims: TransmitContext[] = [];
    for (const row of due) {
      // F-178 — resolve the row's OWN feed. The wire was built (and its destination decided) at queue time,
      // so a second feed appearing later must not stall it; if the row's feed was suspended/revoked/expired
      // since, defer rather than transmit through a feed no longer authorised — the next tick re-checks.
      const feedResult = await deps.feedResolver.resolveById(tx, organizationId, row.feedId, now);
      if (feedResult.kind !== "resolved") continue;

      let wirePlaintext: string;
      try {
        wirePlaintext = await deps.cipher.decrypt(organizationId, "payload", row.payloadCipher);
      } catch (err) {
        // One undecryptable row must not roll back the claims of its batch-mates; it stays `queued`.
        console.error("m29.outbound.sweep_decrypt_failed", {
          outboundMessageId: row.id,
          errorName: err instanceof Error ? err.name : "unknown",
        });
        continue;
      }

      const claimedRow = await tx
        .update(HMO)
        .set({ status: "in_flight", nextRetryAt: leaseExpiry(deps, now) })
        .where(
          and(
            eq(HMO.id, row.id),
            eq(HMO.organizationId, organizationId),
            eq(HMO.status, "queued"),
            eq(HMO.retryCount, row.retryCount),
          ),
        )
        .returning({ id: HMO.id });
      if (claimedRow.length === 0) continue;

      const ctx: TransmitContext = {
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
      };
      const protocolRefusal = checkProtocol(ctx.protocol, deps.policy);
      if (protocolRefusal !== null) {
        await applyPermanentFailure(deps, tx, ctx, protocolRefusal, now);
        continue;
      }
      claims.push(ctx);
    }
    return claims;
  });
}

/** Runs one sweep tick, driven directly (the `runStateChannelHealth` precedent — testable without BullMQ).
 *  Per org: (1) reclaim expired `in_flight` leases (F-179), (2) claim the due retries, (3) send + finalize each
 *  claim with no transaction held across the socket. */
export async function runOutboundRetrySweepOnce(deps: OutboundRetrySweepDeps): Promise<void> {
  const resolved = resolveDeps(deps);
  const now = resolved.now();
  const orgs = await deps.activeOrgs.listActiveOrgs();

  for (const { organizationId } of orgs) {
    await reclaimStaleInFlight(resolved, organizationId, now);
    const claims = await claimDueRetries(resolved, organizationId, now);
    for (const ctx of claims) {
      try {
        const outcome = await transmitClaimed(resolved, ctx);
        await finalizeClaimed(resolved, ctx, outcome);
      } catch (err) {
        // The row stays `in_flight` on its lease; the reclaim sweep recovers it. Ids and an error class only.
        console.error("m29.outbound.sweep_send_failed", {
          outboundMessageId: ctx.id,
          feedId: ctx.feedId,
          errorName: err instanceof Error ? err.name : "unknown",
        });
      }
    }
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
