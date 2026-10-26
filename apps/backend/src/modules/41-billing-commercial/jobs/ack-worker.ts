// apps/backend/src/modules/41-billing-commercial/jobs/ack-worker.ts - pull acknowledgments for sent commercial claims through the
// platform ClearinghouseTransport (ADR-0053 D2, D7, D10; the M23 #749 cursor pattern).
//
//   - one stream per (org, provider entity, usage) is SHARED with Medicare: an event whose control number is no commercial submission of
//     this provider entity is not ours and is skipped (counted, never stored). An event whose control number IS a commercial submission
//     of ANOTHER provider entity of the tenant is QUARANTINED: reported, never applied.
//   - events are applied durably, one transaction each, and only then is the persisted cursor advanced (a crash replays at most the page
//     in flight; replays collapse on the unique (organization, clearinghouse, event id) key).
//   - two stages, never conflated: a clearinghouse acceptance moves submitted -> ack_pending, only a payer acceptance reaches accepted.
//   - fail closed: the transport is only called when bound; a degraded answer fails that provider entity (cursor unmoved) and the tick.
//   - a pull only runs for provider entities that have a sent claim still waiting for its answer.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import {
  type AckEvent,
  CH,
  type ClearinghouseTransport,
  routeAckEvent,
} from "@chartwarden/x12-837-client";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { transitionForAck } from "../domain/ack-transition";
import type { CommercialContextPort } from "../eligibility/service";
import type { CommercialOutboxPort, CommercialTx } from "../services/types";
import { M41_CRON_QUEUES, M41_JOB_SCHEDULES } from "./queues";

/** Most pages one provider entity's stream may read per tick; the cursor is persisted per page, so the rest waits for the next tick. */
export const MAX_ACK_PAGES_PER_TICK = 50;
const MAX_CURSOR_LENGTH = 512;
const MAX_REASON_CODE_LENGTH = 64;
const MAX_REASON_CODES = 50;

export interface AckCursorKey {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly usage: "test" | "production";
  readonly vendor: string;
}
export interface AckCursorState {
  readonly cursor: string | null;
  readonly version: number;
}
/** `advance` is a compare-and-set on `version`: it returns false when another tick moved the cursor first. */
export interface AckCursorStore {
  read(key: AckCursorKey): Promise<AckCursorState>;
  advance(key: AckCursorKey, expectedVersion: number, next: string | null): Promise<boolean>;
}

export interface AckWorkerDeps {
  readonly db: DbClient;
  readonly binding: {
    readonly vendor: string | null;
    readonly transport: Pick<ClearinghouseTransport, "fetchAcknowledgments">;
  };
  readonly contexts: CommercialContextPort;
  readonly cursors: AckCursorStore;
  readonly outbox: CommercialOutboxPort;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  /** PHI-free log sink (ids and codes only). */
  readonly log?: (event: {
    readonly event: string;
    readonly submissionId?: string;
    readonly eventId?: string;
    readonly code?: string;
  }) => void;
}

export function createDrizzleAckCursorStore(db: DbClient): AckCursorStore {
  const C = schema.commercialAckCursors;
  const sameKey = (key: AckCursorKey) =>
    and(
      eq(C.organizationId, key.organizationId),
      eq(C.providerEntityId, key.providerEntityId),
      eq(C.vendor, key.vendor),
      eq(C.usage, key.usage),
    );
  return {
    read: (key) =>
      withOrgContext(db, systemOrgContext(key.organizationId), async (tx) => {
        const [row] = await tx
          .select({ cursor: C.cursor, version: C.version })
          .from(C)
          .where(sameKey(key))
          .limit(1);
        return row
          ? { cursor: row.cursor, version: Number(row.version) }
          : { cursor: null, version: 0 };
      }),
    advance: (key, expectedVersion, next) =>
      withOrgContext(db, systemOrgContext(key.organizationId), async (tx) => {
        if (expectedVersion === 0) {
          // First move: the unique key arbitrates a race; the loser inserts nothing.
          const inserted = await tx
            .insert(C)
            .values({
              organizationId: key.organizationId,
              providerEntityId: key.providerEntityId,
              vendor: key.vendor,
              usage: key.usage,
              cursor: next,
            })
            .onConflictDoNothing()
            .returning({ id: C.id });
          return inserted.length === 1;
        }
        const updated = await tx
          .update(C)
          .set({ cursor: next, version: sql`${C.version} + 1`, updatedAt: sql`now()` })
          .where(and(sameKey(key), eq(C.version, expectedVersion)))
          .returning({ id: C.id });
        return updated.length === 1;
      }),
  };
}

export type { AckEvent };
export type ApplyResult = "applied" | "duplicate" | "unmatched" | "quarantined";

const inOrg = <T>(
  deps: AckWorkerDeps,
  organizationId: string,
  fn: (tx: CommercialTx) => Promise<T>,
): Promise<T> => withOrgContext(deps.db, systemOrgContext(organizationId), fn);

/** Reason codes as stored: bounded and clipped. They are vendor CODES; nothing else about the event is kept. */
const cleanCodes = (codes: readonly string[]): string[] =>
  codes
    .filter((c): c is string => typeof c === "string" && c.length > 0)
    .slice(0, MAX_REASON_CODES)
    .map((c) => c.slice(0, MAX_REASON_CODE_LENGTH));

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;

/**
 * Apply ONE acknowledgment event for the provider entity whose stream it came from. Matches on the control number among THIS provider
 * entity's `sent` submissions; records the acknowledgment, and in the same transaction moves the claim (when the transition is legal)
 * and writes the event. A repeated event id changes nothing.
 */
export async function applyAckEvent(
  deps: AckWorkerDeps,
  scope: { readonly organizationId: string; readonly providerEntityId: string },
  event: AckEvent,
): Promise<ApplyResult> {
  const routed = routeAckEvent(event);
  return inOrg(deps, scope.organizationId, async (tx) => {
    const S = schema.commercialSubmissions;
    const C = schema.commercialClaims;
    const [sub] = await tx
      .select()
      .from(S)
      .where(
        and(
          eq(S.organizationId, scope.organizationId),
          eq(S.providerEntityId, scope.providerEntityId),
          eq(S.controlNumber, event.controlNumber),
          eq(S.status, "sent"),
        ),
      )
      .limit(1);
    if (!sub) {
      const [elsewhere] = await tx
        .select({ id: S.id })
        .from(S)
        .where(
          and(
            eq(S.organizationId, scope.organizationId),
            ne(S.providerEntityId, scope.providerEntityId),
            eq(S.controlNumber, event.controlNumber),
          ),
        )
        .limit(1);
      return elsewhere ? "quarantined" : "unmatched";
    }
    const [claim] = await tx.select().from(C).where(eq(C.id, sub.claimId)).for("update");
    if (!claim) return "unmatched";
    const reasonCodes = cleanCodes(event.reasonCodes);
    const [recorded] = await tx
      .insert(schema.commercialAcknowledgments)
      .values({
        organizationId: sub.organizationId,
        providerEntityId: sub.providerEntityId,
        locationId: sub.locationId,
        claimId: sub.claimId,
        submissionId: sub.id,
        clearinghouseKey: sub.clearinghouseKey,
        eventId: event.eventId.slice(0, 256),
        stage: routed.stage,
        disposition: routed.outcome,
        reasonCodes,
        payerClaimNumber: event.payerClaimNumber ? event.payerClaimNumber.slice(0, 128) : null,
        occurredAt: ISO_INSTANT.test(event.occurredAt) ? new Date(event.occurredAt) : null,
      })
      .onConflictDoNothing()
      .returning({ id: schema.commercialAcknowledgments.id });
    if (!recorded) return "duplicate";

    if (routed.stage === "clearinghouse" && routed.outcome === "accepted") {
      await tx
        .update(S)
        .set({ clearinghouseAcceptedAt: sql`coalesce(${S.clearinghouseAcceptedAt}, now())` })
        .where(eq(S.id, sub.id));
    }
    const transition = transitionForAck(claim.state, routed.stage, routed.outcome);
    if (transition) {
      await tx
        .update(C)
        .set({ state: transition.to, updatedAt: new Date() })
        .where(eq(C.id, claim.id));
      await tx.insert(schema.commercialClaimStateHistory).values({
        organizationId: claim.organizationId,
        providerEntityId: claim.providerEntityId,
        locationId: claim.locationId,
        claimId: claim.id,
        fromState: claim.state,
        toState: transition.to,
        actorKind: "system",
        actorMembershipId: null,
        validationRunId: null,
      });
      await deps.outbox.publish(tx, {
        eventName: transition.event,
        organizationId: claim.organizationId,
        aggregateKind: "commercial_claim",
        aggregateId: claim.id,
        payload: {
          claimId: claim.id,
          submissionId: sub.id,
          stage: routed.stage,
          reasonCodes,
        },
      });
    }
    return "applied";
  });
}

export interface AckPullResult {
  readonly applied: number;
  readonly duplicates: number;
  readonly unmatched: number;
  /** Provider entities whose stream failed (PHI-free labels). */
  readonly failures: readonly string[];
  /** Provider entities that stopped at the page cap with more to read. */
  readonly backlog: readonly string[];
  /** Events that were not applied because they cannot be trusted (unroutable, or another provider entity's). Ids only. */
  readonly quarantined: readonly { readonly eventId: string; readonly reason: string }[];
}

const clip = (v: unknown): string => (typeof v === "string" ? v.slice(0, 128) : "");

async function pullEntity(
  deps: AckWorkerDeps,
  organizationId: string,
  providerEntityId: string,
  payerId: string,
  tally: { applied: number; duplicates: number; unmatched: number },
  quarantined: { eventId: string; reason: string }[],
): Promise<"done" | "backlog"> {
  const vendor = deps.binding.vendor;
  if (vendor === null) throw new Error("CH_NOT_WIRED: no clearinghouse is bound");
  const ctx = await deps.contexts.contextFor(organizationId, providerEntityId, payerId);
  if (ctx === null) throw new Error("the provider entity has no billing NPI on file");
  const key: AckCursorKey = { organizationId, providerEntityId, usage: ctx.usage, vendor };
  let state = await deps.cursors.read(key);
  let retriedFromStart = false;
  const seen = new Set<string | null>([state.cursor]);
  for (let pages = 0; pages < MAX_ACK_PAGES_PER_TICK; ) {
    const result = await deps.binding.transport.fetchAcknowledgments(ctx, state.cursor);
    if (!result.ok) {
      const refused = result.degraded.code === CH.INVALID_REQUEST;
      if (state.cursor === null || retriedFromStart || !refused) {
        throw new Error(`acknowledgment pull failed (${result.degraded.code})`);
      }
      // The vendor no longer honours the stored position: start over (replays collapse on the unique key).
      retriedFromStart = true;
      if (!(await deps.cursors.advance(key, state.version, null))) return "done";
      state = await deps.cursors.read(key);
      seen.clear();
      seen.add(null);
      continue;
    }
    pages += 1;
    const { items, nextCursor, hasMore } = result.data;
    if (nextCursor.length < 1 || nextCursor.length > MAX_CURSOR_LENGTH) {
      throw new Error("acknowledgment pull failed (the vendor cursor has an unusable length)");
    }
    if (hasMore && seen.has(nextCursor)) {
      throw new Error("acknowledgment pull failed (the vendor cursor did not advance)");
    }
    for (const event of items) {
      let outcome: ApplyResult;
      try {
        outcome = await applyAckEvent(deps, { organizationId, providerEntityId }, event);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("ack event:")) {
          // Unroutable (unknown stage or disposition): skipped so it cannot stall the stream behind it, and reported.
          quarantined.push({ eventId: clip(event?.eventId), reason: err.message });
          continue;
        }
        throw err; // a database or mapping fault fails the entity; the cursor does not move
      }
      if (outcome === "quarantined") {
        quarantined.push({
          eventId: clip(event.eventId),
          reason: "control number belongs to another provider entity",
        });
      } else if (outcome === "applied") tally.applied += 1;
      else if (outcome === "duplicate") tally.duplicates += 1;
      else tally.unmatched += 1;
    }
    if (nextCursor !== state.cursor) {
      if (!(await deps.cursors.advance(key, state.version, nextCursor))) return "done"; // another tick owns the stream now
      state = { cursor: nextCursor, version: state.version + 1 };
    }
    seen.add(nextCursor);
    if (!hasMore) return "done";
  }
  return "backlog";
}

/** Provider entities of the org with a sent claim still waiting for an answer, each with a payer id for the call context. */
async function outstanding(
  deps: AckWorkerDeps,
  organizationId: string,
): Promise<{ providerEntityId: string; payerId: string }[]> {
  return inOrg(deps, organizationId, async (tx) => {
    const S = schema.commercialSubmissions;
    const C = schema.commercialClaims;
    const rows = await tx
      .select({ providerEntityId: S.providerEntityId, payerId: S.clearinghousePayerId })
      .from(S)
      .innerJoin(C, and(eq(C.id, S.claimId), eq(C.organizationId, S.organizationId)))
      .where(and(eq(S.status, "sent"), inArray(C.state, ["submitted", "ack_pending"])));
    const byEntity = new Map<string, string>();
    for (const r of rows)
      if (!byEntity.has(r.providerEntityId)) byEntity.set(r.providerEntityId, r.payerId);
    return [...byEntity].map(([providerEntityId, payerId]) => ({ providerEntityId, payerId }));
  });
}

export async function pullOrgAcks(
  deps: AckWorkerDeps,
  organizationId: string,
): Promise<AckPullResult> {
  const tally = { applied: 0, duplicates: 0, unmatched: 0 };
  const failures: string[] = [];
  const backlog: string[] = [];
  const quarantined: { eventId: string; reason: string }[] = [];
  for (const { providerEntityId, payerId } of await outstanding(deps, organizationId)) {
    try {
      const out = await pullEntity(
        deps,
        organizationId,
        providerEntityId,
        payerId,
        tally,
        quarantined,
      );
      if (out === "backlog") backlog.push(`org ${organizationId} provider ${providerEntityId}`);
    } catch (err) {
      failures.push(
        `org ${organizationId} provider ${providerEntityId}: ${err instanceof Error ? err.message : "failed"}`,
      );
    }
  }
  return { ...tally, failures, backlog, quarantined };
}

/** The cron body. Throws after every org ran when anything failed (BullMQ retries; the DLQ alert fires). Unbound with work waiting fails. */
export async function runAckPull(deps: AckWorkerDeps): Promise<AckPullResult> {
  const total = { applied: 0, duplicates: 0, unmatched: 0 };
  const failures: string[] = [];
  const backlog: string[] = [];
  const quarantined: { eventId: string; reason: string }[] = [];
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    if (deps.binding.vendor === null) {
      const waiting = await outstanding(deps, organizationId);
      if (waiting.length > 0) {
        failures.push(
          `org ${organizationId}: CH_NOT_WIRED (${waiting.length} provider entity(ies) waiting for acknowledgments)`,
        );
      }
      continue;
    }
    try {
      const res = await pullOrgAcks(deps, organizationId);
      total.applied += res.applied;
      total.duplicates += res.duplicates;
      total.unmatched += res.unmatched;
      failures.push(...res.failures);
      backlog.push(...res.backlog);
      quarantined.push(...res.quarantined);
    } catch (err) {
      failures.push(`org ${organizationId}: ${err instanceof Error ? err.name : "failed"}`);
    }
  }
  for (const q of quarantined)
    deps.log?.({ event: "ack.quarantined", eventId: q.eventId, code: q.reason });
  if (failures.length > 0)
    throw new Error(`commercial acknowledgment pull failed: ${failures.join("; ")}`);
  return { ...total, failures, backlog, quarantined };
}

const ACK_CONCURRENCY = 1;

export function registerM41AckWorker(connection: ConnectionOptions, deps: AckWorkerDeps): Worker {
  return new Worker(M41_CRON_QUEUES.ackPull, async () => runAckPull(deps), {
    connection,
    concurrency: ACK_CONCURRENCY,
  });
}

export async function scheduleM41AckJobs(connection: ConnectionOptions): Promise<Queue[]> {
  const queue = new Queue(M41_CRON_QUEUES.ackPull, { connection });
  await queue.add(
    "scheduled",
    {},
    { repeat: { pattern: M41_JOB_SCHEDULES.ackPull }, removeOnComplete: true },
  );
  return [queue];
}
