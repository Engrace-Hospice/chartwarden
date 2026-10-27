// apps/backend/src/modules/41-billing-commercial/jobs/ack-worker.ts - pull acknowledgments for sent commercial claims through the
// platform ClearinghouseTransport (ADR-0053 D2, D7, D10; the M23 #749 cursor pattern).
//
//   - every event is VALIDATED field by field at the boundary (`domain/ack-event.ts`); one that fails is stored and skipped, never
//     thrown, so a poison event cannot stall a provider entity's stream.
//   - one stream per (org, provider entity, usage) is SHARED with Medicare. An event whose control number is no commercial submission of
//     this provider entity is NOT ours: it is counted and skipped, not stored (it would grow without a retention story). The actionable
//     ones are STORED in `commercial_ack_quarantine` (event id, control number, a reason code; no body) before the cursor can move
//     past them: `malformed`, `scope_mismatch` (another provider entity's control number), `vendor_mismatch` (the submission went
//     through another clearinghouse) and `no_receipt` (a payer-stage answer for a submission whose receipt we never recorded).
//   - `no_receipt`, `scope_mismatch` and `vendor_mismatch` are HELD, not lost: their validated fields are kept with the row and the pull
//     replays them (ack-held-replay.ts: per-reason meaning, claim-status inquiry past 45 days, explicit `m41.claim.ack_abandoned`
//     when one can never apply). `malformed` has nothing valid to keep and is for review only.
//   - an acknowledgment for an `in_doubt` (or in-flight `queued`) submission proves the file arrived: it settles the submission as
//     `sent` (resolution `acknowledgment`), moves the claim ready -> submitted, and then applies the acknowledgment as usual.
//   - events are applied durably, one transaction each, and only then is the persisted cursor advanced (a crash replays at most the page
//     in flight; replays collapse on the unique (organization, clearinghouse, event id) key). Locks are taken claim first, then the
//     submission: the same order as the worker and reconcile, so they serialize instead of deadlocking or overwriting provenance.
//   - two stages, never conflated: a clearinghouse acceptance moves submitted -> ack_pending, only a payer acceptance reaches accepted.
//   - fail closed: the transport is only called when bound and capable of commercial; a degraded answer fails that provider entity
//     (cursor unmoved) and the tick.
//   - a pull runs only for provider entities with work waiting: a submission in doubt, or a sent claim not yet in a terminal state and
//     not older than ACK_POLL_MAX_AGE_DAYS; the number of rows considered is bounded.
//   - AckEvent carries no payer id and no receipt id today (eventId, controlNumber, stage, disposition, reasonCodes, occurredAt and an
//     optional payerClaimNumber), so the trust binding is: the provider-entity scope of the stream, the control number, the
//     clearinghouse the submission was sent through, and the receipt rule above.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { COMMERCIAL_UNSUPPORTED_CLEARINGHOUSES } from "@chartwarden/types";
import { CH } from "@chartwarden/x12-837-client";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, asc, eq, gte, inArray, or, sql } from "drizzle-orm";
import {
  ACK_POLL_MAX_AGE_DAYS,
  type AckCursorKey,
  type AckCursorStore,
  type AckWorkerDeps,
  DAY_MS,
  type Scope,
  applyAckEvent,
  inOrg,
  nowOf,
} from "./ack-apply";
import { replayHeldEvents, sweepHeldEvents } from "./ack-held-replay";
import { M41_CRON_QUEUES, M41_JOB_SCHEDULES } from "./queues";

// the apply core lives in ack-apply.ts and the held-event replay in ack-held-replay.ts; this file keeps the public surface
export {
  ACK_POLL_MAX_AGE_DAYS,
  applyAckEvent,
  type AckCursorKey,
  type AckCursorState,
  type AckCursorStore,
  type AckWorkerDeps,
  type ApplyOutcome,
  type ApplyResult,
  type QuarantineReason,
} from "./ack-apply";
export {
  abandonForeignHeldEvents,
  heldQuarantineReport,
  replayHeldEvents,
} from "./ack-held-replay";

/** Most pages one provider entity's stream may read per tick; the cursor is persisted per page, so the rest waits for the next tick. */
export const MAX_ACK_PAGES_PER_TICK = 50;
const MAX_CURSOR_LENGTH = 512;
/** Rows looked at when deciding which provider entities to pull for. */
export const OUTSTANDING_ROW_LIMIT = 500;

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

export interface AckPullResult {
  readonly applied: number;
  readonly duplicates: number;
  /** Events that are no commercial submission of the provider entity (Medicare's, mostly): counted, never stored. */
  readonly unmatched: number;
  /** Provider entities whose stream failed (PHI-free labels). */
  readonly failures: readonly string[];
  /** Provider entities that stopped at the page cap with more to read. */
  readonly backlog: readonly string[];
  /** Events stored in quarantine because they need attention. Ids and a reason only. */
  readonly quarantined: readonly { readonly eventId: string; readonly reason: string }[];
}

type Tally = { applied: number; duplicates: number; unmatched: number };

async function pullEntity(
  deps: AckWorkerDeps,
  scope: Scope,
  payerId: string,
  tally: Tally,
  quarantined: { eventId: string; reason: string }[],
): Promise<"done" | "backlog"> {
  const { organizationId, providerEntityId } = scope;
  const vendor = deps.binding.vendor;
  if (vendor === null) throw new Error("CH_NOT_WIRED: no clearinghouse is bound");
  if (COMMERCIAL_UNSUPPORTED_CLEARINGHOUSES.includes(vendor)) {
    throw new Error("the bound clearinghouse cannot carry commercial claims");
  }
  const ctx = await deps.contexts.contextFor(organizationId, providerEntityId, payerId);
  if (ctx === null) throw new Error("the provider entity has no billing NPI on file");
  const key: AckCursorKey = { organizationId, providerEntityId, usage: ctx.usage, vendor };
  // events held from an earlier pass may be ready now (a person reconciled the submission)
  tally.applied += (await replayHeldEvents(deps, scope)).applied;
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
    if (!Array.isArray(items)) throw new Error("acknowledgment pull failed (items is not a list)");
    if (
      typeof nextCursor !== "string" ||
      nextCursor.length < 1 ||
      nextCursor.length > MAX_CURSOR_LENGTH
    ) {
      throw new Error("acknowledgment pull failed (the vendor cursor has an unusable length)");
    }
    if (hasMore && seen.has(nextCursor)) {
      throw new Error("acknowledgment pull failed (the vendor cursor did not advance)");
    }
    let unblocked = false;
    for (const event of items) {
      // A database fault throws and fails the entity (the cursor does not move); a bad EVENT never throws, it is stored.
      const out = await applyAckEvent(deps, scope, event);
      if (out.result === "applied") {
        tally.applied += 1;
        if (out.stage === "clearinghouse") unblocked = true;
      } else if (out.result === "duplicate") tally.duplicates += 1;
      else if (out.result === "unmatched") tally.unmatched += 1;
      else quarantined.push({ eventId: out.eventId, reason: out.reason ?? "quarantined" });
    }
    // Held payer-stage events are re-applied once at the start of the pull, and again only when this page applied a clearinghouse-stage
    // event (the only thing that can settle a row with no receipt): not after every page.
    if (unblocked) tally.applied += (await replayHeldEvents(deps, scope)).applied;
    if (nextCursor !== state.cursor) {
      if (!(await deps.cursors.advance(key, state.version, nextCursor))) return "done"; // another tick owns the stream now
      state = { cursor: nextCursor, version: state.version + 1 };
    }
    seen.add(nextCursor);
    if (!hasMore) return "done";
  }
  return "backlog";
}

/**
 * Provider entities of the org with a live submission still waiting for an answer: a submission in doubt (an acknowledgment is how it
 * gets resolved), or a sent claim that has not reached a terminal state and is younger than {@link ACK_POLL_MAX_AGE_DAYS}. Each comes
 * with a payer id for the call context. At most {@link OUTSTANDING_ROW_LIMIT} rows are considered, oldest first, so a tenant with a huge
 * backlog cannot make one tick unbounded.
 *
 * The payer id is only context: every transport (in-memory, direct-MAC, Stedi) scopes the acknowledgment stream by
 * (organization, provider entity, usage) and none filters it by `ctx.payerId`, so one pull per provider entity sees every payer.
 */
export async function outstanding(
  deps: AckWorkerDeps,
  organizationId: string,
): Promise<{ providerEntityId: string; payerId: string }[]> {
  return inOrg(deps, organizationId, async (tx) => {
    const S = schema.commercialSubmissions;
    const C = schema.commercialClaims;
    const cutoff = new Date(nowOf(deps).getTime() - ACK_POLL_MAX_AGE_DAYS * DAY_MS);
    const rows = await tx
      .select({ providerEntityId: S.providerEntityId, payerId: S.clearinghousePayerId })
      .from(S)
      .innerJoin(C, and(eq(C.id, S.claimId), eq(C.organizationId, S.organizationId)))
      .where(
        and(
          gte(S.requestedAt, cutoff),
          or(
            eq(S.status, "in_doubt"),
            and(eq(S.status, "sent"), inArray(C.state, ["submitted", "ack_pending"])),
          ),
        ),
      )
      .orderBy(asc(S.requestedAt))
      .limit(OUTSTANDING_ROW_LIMIT);
    const byEntity = new Map<string, string>();
    for (const r of rows) {
      if (!byEntity.has(r.providerEntityId)) byEntity.set(r.providerEntityId, r.payerId);
    }
    return [...byEntity].map(([providerEntityId, payerId]) => ({ providerEntityId, payerId }));
  });
}

export async function pullOrgAcks(
  deps: AckWorkerDeps,
  organizationId: string,
): Promise<AckPullResult> {
  const tally: Tally = { applied: 0, duplicates: 0, unmatched: 0 };
  const failures: string[] = [];
  const backlog: string[] = [];
  const quarantined: { eventId: string; reason: string }[] = [];
  const work = await outstanding(deps, organizationId);
  // Provider entities that hold events but have no live work left (their submission failed, the claim was voided) are still swept,
  // with no transport call, so a dead held event is abandoned instead of waiting forever.
  try {
    const live = new Set(work.map((w) => w.providerEntityId));
    await sweepHeldEvents(deps, organizationId, live);
  } catch (err) {
    failures.push(
      `org ${organizationId} held-event sweep: ${err instanceof Error ? err.message : "failed"}`,
    );
  }
  for (const { providerEntityId, payerId } of work) {
    try {
      const out = await pullEntity(
        deps,
        { organizationId, providerEntityId },
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
  const total: Tally = { applied: 0, duplicates: 0, unmatched: 0 };
  const failures: string[] = [];
  const backlog: string[] = [];
  const quarantined: { eventId: string; reason: string }[] = [];
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    if (deps.binding.vendor === null) {
      try {
        // unbound: no transport is needed to close out aged / foreign-stream / event-less held rows, so they still leave audited
        await sweepHeldEvents(deps, organizationId, new Set());
        const waiting = await outstanding(deps, organizationId);
        if (waiting.length > 0) {
          failures.push(
            `org ${organizationId}: CH_NOT_WIRED (${waiting.length} provider entity(ies) waiting for acknowledgments)`,
          );
        }
      } catch (err) {
        failures.push(`org ${organizationId}: ${err instanceof Error ? err.name : "failed"}`);
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
  if (total.unmatched > 0) deps.log?.({ event: "ack.unmatched", count: total.unmatched });
  if (failures.length > 0) {
    throw new Error(`commercial acknowledgment pull failed: ${failures.join("; ")}`);
  }
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
