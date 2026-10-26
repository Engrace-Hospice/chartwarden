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
//   - `no_receipt` is HELD, not lost: its validated fields are kept with the row, and the pull re-applies it as soon as the submission
//     is settled (by a clearinghouse-stage acknowledgment in the same page, or by a person's reconcile). The others are for review.
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
import { createHash } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { COMMERCIAL_UNSUPPORTED_CLEARINGHOUSES } from "@chartwarden/types";
import { CH, type ClearinghouseTransport } from "@chartwarden/x12-837-client";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, asc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { type ValidAckEvent, validateAckEvent } from "../domain/ack-event";
import { transitionForAck } from "../domain/ack-transition";
import type { CommercialContextPort } from "../eligibility/service";
import type { CommercialOutboxPort, CommercialTx } from "../services/types";
import { M41_CRON_QUEUES, M41_JOB_SCHEDULES } from "./queues";

/** Most pages one provider entity's stream may read per tick; the cursor is persisted per page, so the rest waits for the next tick. */
export const MAX_ACK_PAGES_PER_TICK = 50;
const MAX_CURSOR_LENGTH = 512;
/** A sent claim older than this is no longer polled for (it needs a claim-status inquiry, which is not built yet). */
export const ACK_POLL_MAX_AGE_DAYS = 45;
/** Rows looked at when deciding which provider entities to pull for. */
export const OUTSTANDING_ROW_LIMIT = 500;
/** Held `no_receipt` events re-applied per provider entity per pass. */
const HELD_REPLAY_LIMIT = 100;
/** Provider entities swept for dead held events per org per tick. */
const HELD_ENTITY_LIMIT = 200;
const DAY_MS = 86_400_000;

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
  readonly now?: () => Date;
  /** PHI-free log sink (ids, codes and counts only). */
  readonly log?: (event: {
    readonly event: string;
    readonly submissionId?: string;
    readonly eventId?: string;
    readonly code?: string;
    readonly count?: number;
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

/** Why an event was stored. `unmatched` is deliberately NOT here: those are counted, not stored. */
export type QuarantineReason = "malformed" | "scope_mismatch" | "vendor_mismatch" | "no_receipt";
export type ApplyResult = "applied" | "duplicate" | "unmatched" | "quarantined";
export interface ApplyOutcome {
  readonly result: ApplyResult;
  readonly eventId: string;
  /** Present when the event was stored in quarantine. */
  readonly reason?: QuarantineReason;
  /** The stage of an applied event: only a clearinghouse-stage one can unblock a held payer-stage event. */
  readonly stage?: "clearinghouse" | "payer";
}

const inOrg = <T>(
  deps: AckWorkerDeps,
  organizationId: string,
  fn: (tx: CommercialTx) => Promise<T>,
): Promise<T> => withOrgContext(deps.db, systemOrgContext(organizationId), fn);

const nowOf = (deps: AckWorkerDeps): Date => (deps.now ?? (() => new Date()))();

/** A stable id for an event whose own id is unusable: a digest of what the vendor sent (never stored itself). */
function derivedEventId(raw: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(raw) ?? "undefined";
  } catch {
    text = "unserializable";
  }
  return `invalid:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
}

type Scope = { readonly organizationId: string; readonly providerEntityId: string };

/** Store an event that was not applied. Idempotent on (organization, clearinghouse, event id). */
async function quarantine(
  deps: AckWorkerDeps,
  tx: CommercialTx,
  scope: Scope,
  event: { readonly eventId: string; readonly controlNumber: string | null },
  reason: QuarantineReason,
  held?: ValidAckEvent,
): Promise<void> {
  await tx
    .insert(schema.commercialAckQuarantine)
    .values({
      organizationId: scope.organizationId,
      providerEntityId: scope.providerEntityId,
      clearinghouseKey: deps.binding.vendor ?? "unbound",
      eventId: event.eventId,
      controlNumber: event.controlNumber,
      reason,
      // only `no_receipt` keeps its validated fields (codes and ids, no PHI) so the pull can replay it
      event:
        reason === "no_receipt" && held
          ? {
              stage: held.stage,
              disposition: held.disposition,
              reasonCodes: [...held.reasonCodes],
              payerClaimNumber: held.payerClaimNumber,
              occurredAt: held.occurredAt ? held.occurredAt.toISOString() : null,
            }
          : null,
    })
    .onConflictDoNothing();
  deps.log?.({ event: "ack.quarantined", eventId: event.eventId, code: reason });
}

/** Statuses an acknowledgment may match, best first: a recorded receipt, a submission in doubt, one whose receipt may be in flight. */
const MATCHABLE = ["sent", "in_doubt", "queued"] as const;

/** Apply one VALIDATED event inside the caller's org transaction. */
async function applyValidEvent(
  deps: AckWorkerDeps,
  tx: CommercialTx,
  scope: Scope,
  event: ValidAckEvent,
): Promise<ApplyOutcome> {
  const S = schema.commercialSubmissions;
  const C = schema.commercialClaims;
  const held = (result: ApplyResult, reason: QuarantineReason): Promise<ApplyOutcome> =>
    quarantine(deps, tx, scope, event, reason, event).then(() => ({
      result,
      eventId: event.eventId,
      reason,
    }));

  const candidates = await tx
    .select()
    .from(S)
    .where(
      and(
        eq(S.organizationId, scope.organizationId),
        eq(S.providerEntityId, scope.providerEntityId),
        eq(S.controlNumber, event.controlNumber),
        inArray(S.status, [...MATCHABLE]),
      ),
    );
  const found = MATCHABLE.map((status) => candidates.find((c) => c.status === status)).find(
    (c) => c !== undefined,
  );
  if (!found) {
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
    if (elsewhere) return held("quarantined", "scope_mismatch");
    // Not a commercial submission of this provider entity (the stream is shared with Medicare): counted by the caller, not stored.
    return { result: "unmatched", eventId: event.eventId };
  }
  // Lock order: the claim, then the submission (the worker and reconcile do the same), and re-read the submission under the lock so a
  // concurrent reconcile or recordAccepted is seen, never overwritten.
  const [claim] = await tx.select().from(C).where(eq(C.id, found.claimId)).for("update");
  if (!claim) return { result: "unmatched", eventId: event.eventId };
  const [sub] = await tx.select().from(S).where(eq(S.id, found.id)).for("update");
  if (!sub || !(MATCHABLE as readonly string[]).includes(sub.status)) {
    return { result: "unmatched", eventId: event.eventId };
  }
  // Sent through another clearinghouse than the one this stream came from: not this submission's answer.
  if (deps.binding.vendor !== null && sub.clearinghouseKey !== deps.binding.vendor) {
    return held("quarantined", "vendor_mismatch");
  }
  // No recorded receipt: only a clearinghouse-stage answer may settle the submission. A payer-stage answer cannot, because nothing
  // proves the file ever reached the clearinghouse. It is HELD and re-applied once the submission is settled.
  if (sub.status !== "sent" && event.stage !== "clearinghouse") {
    return held("quarantined", "no_receipt");
  }

  const [recorded] = await tx
    .insert(schema.commercialAcknowledgments)
    .values({
      organizationId: sub.organizationId,
      providerEntityId: sub.providerEntityId,
      locationId: sub.locationId,
      claimId: sub.claimId,
      submissionId: sub.id,
      clearinghouseKey: sub.clearinghouseKey,
      eventId: event.eventId,
      stage: event.stage,
      disposition: event.disposition,
      reasonCodes: [...event.reasonCodes],
      payerClaimNumber: event.payerClaimNumber,
      occurredAt: event.occurredAt,
    })
    .onConflictDoNothing()
    .returning({ id: schema.commercialAcknowledgments.id });
  if (!recorded) return { result: "duplicate", eventId: event.eventId };

  const at = nowOf(deps);
  let claimState = claim.state;
  if (sub.status !== "sent") {
    // The acknowledgment proves the file arrived: settle the submission and file the claim as submitted first.
    await tx
      .update(S)
      .set({
        status: "sent",
        resolution: "acknowledgment",
        sentAt: at,
        transportCallStartedAt: null,
        updatedAt: at,
      })
      .where(eq(S.id, sub.id));
    if (claimState === "ready") {
      await tx.update(C).set({ state: "submitted", updatedAt: at }).where(eq(C.id, claim.id));
      await tx.insert(schema.commercialClaimStateHistory).values({
        organizationId: claim.organizationId,
        providerEntityId: claim.providerEntityId,
        locationId: claim.locationId,
        claimId: claim.id,
        fromState: "ready",
        toState: "submitted",
        actorKind: "system",
        actorMembershipId: null,
        validationRunId: null,
      });
      claimState = "submitted";
      await deps.outbox.publish(tx, {
        eventName: "m41.claim.submitted",
        organizationId: claim.organizationId,
        aggregateKind: "commercial_submission",
        aggregateId: sub.id,
        payload: {
          claimId: claim.id,
          submissionId: sub.id,
          controlNumber: sub.controlNumber,
          clearinghouseKey: sub.clearinghouseKey,
        },
      });
    }
  }

  if (event.stage === "clearinghouse" && event.disposition === "accepted") {
    await tx
      .update(S)
      .set({ clearinghouseAcceptedAt: sql`coalesce(${S.clearinghouseAcceptedAt}, now())` })
      .where(eq(S.id, sub.id));
  }
  const transition = transitionForAck(claimState, event.stage, event.disposition);
  if (transition) {
    await tx.update(C).set({ state: transition.to, updatedAt: at }).where(eq(C.id, claim.id));
    await tx.insert(schema.commercialClaimStateHistory).values({
      organizationId: claim.organizationId,
      providerEntityId: claim.providerEntityId,
      locationId: claim.locationId,
      claimId: claim.id,
      fromState: claimState,
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
        stage: event.stage,
        reasonCodes: [...event.reasonCodes],
      },
    });
  }
  return { result: "applied", eventId: event.eventId, stage: event.stage };
}

/**
 * Apply ONE acknowledgment event for the provider entity whose stream it came from. The event is validated first; anything that needs
 * attention and cannot be applied is stored in quarantine in the same transaction, so it is never lost to a log line. A repeated
 * event id changes nothing.
 */
export async function applyAckEvent(
  deps: AckWorkerDeps,
  scope: Scope,
  raw: unknown,
): Promise<ApplyOutcome> {
  const checked = validateAckEvent(raw);
  if (!checked.ok) {
    const eventId = checked.eventId ?? derivedEventId(raw);
    await inOrg(deps, scope.organizationId, (tx) =>
      quarantine(deps, tx, scope, { eventId, controlNumber: checked.controlNumber }, "malformed"),
    );
    return { result: "quarantined", eventId, reason: "malformed" };
  }
  return inOrg(deps, scope.organizationId, (tx) => applyValidEvent(deps, tx, scope, checked.event));
}

/**
 * Re-apply the payer-stage events that were held as `no_receipt`, now that their submissions may be settled. Each is applied in its
 * own transaction and stamped `resolved_at` there. One whose submission is still unsettled stays held.
 */
export async function replayHeldEvents(
  deps: AckWorkerDeps,
  scope: Scope,
): Promise<{ readonly applied: number; readonly abandoned: number }> {
  const Q = schema.commercialAckQuarantine;
  const heldRows = await inOrg(deps, scope.organizationId, (tx) =>
    tx
      .select({
        id: Q.id,
        eventId: Q.eventId,
        controlNumber: Q.controlNumber,
        event: Q.event,
        createdAt: Q.createdAt,
      })
      .from(Q)
      .where(
        and(
          eq(Q.organizationId, scope.organizationId),
          eq(Q.providerEntityId, scope.providerEntityId),
          eq(Q.reason, "no_receipt"),
          isNull(Q.resolvedAt),
        ),
      )
      .orderBy(asc(Q.createdAt))
      .limit(HELD_REPLAY_LIMIT),
  );
  const cutoff = nowOf(deps).getTime() - ACK_POLL_MAX_AGE_DAYS * DAY_MS;
  let applied = 0;
  let abandoned = 0;
  // A held row leaves the queue one way or another, so dead rows never starve the live ones behind them: applied, or abandoned with a
  // reason (aged out, no longer valid, or its submission can never take it).
  const settle = (tx: CommercialTx, id: string, resolution: HeldResolution) =>
    tx
      .update(Q)
      .set({ resolvedAt: nowOf(deps), resolution })
      .where(eq(Q.id, id));
  for (const row of heldRows) {
    if (row.createdAt.getTime() < cutoff) {
      await inOrg(deps, scope.organizationId, (tx) => settle(tx, row.id, "abandoned_aged"));
      abandoned += 1;
      continue;
    }
    const checked = validateAckEvent({
      ...(row.event as Record<string, unknown> | null),
      eventId: row.eventId,
      controlNumber: row.controlNumber,
    });
    if (!checked.ok) {
      deps.log?.({ event: "ack.held_invalid", eventId: row.eventId, code: checked.reason });
      await inOrg(deps, scope.organizationId, (tx) => settle(tx, row.id, "abandoned_invalid"));
      abandoned += 1;
      continue;
    }
    const outcome = await inOrg(deps, scope.organizationId, async (tx) => {
      const out = await applyValidEvent(deps, tx, scope, checked.event);
      if (out.result === "applied" || out.result === "duplicate") {
        await settle(tx, row.id, "applied");
      } else if (out.result === "unmatched") {
        await settle(tx, row.id, "abandoned_no_submission");
      } else if (out.reason === "vendor_mismatch") {
        await settle(tx, row.id, "abandoned_vendor_mismatch");
      } else if (out.reason === "scope_mismatch") {
        await settle(tx, row.id, "abandoned_scope_mismatch");
      }
      return out;
    });
    if (outcome.result === "applied") applied += 1;
    else if (outcome.result === "unmatched" || outcome.reason !== "no_receipt") abandoned += 1;
  }
  return { applied, abandoned };
}

type HeldResolution =
  | "applied"
  | "abandoned_no_submission"
  | "abandoned_scope_mismatch"
  | "abandoned_vendor_mismatch"
  | "abandoned_aged"
  | "abandoned_invalid";

/** Provider entities of the org that still hold unresolved `no_receipt` events (so dead ones get swept even with no live work). */
async function entitiesWithHeldEvents(
  deps: AckWorkerDeps,
  organizationId: string,
): Promise<string[]> {
  const Q = schema.commercialAckQuarantine;
  const rows = await inOrg(deps, organizationId, (tx) =>
    tx
      .selectDistinct({ providerEntityId: Q.providerEntityId })
      .from(Q)
      .where(
        and(eq(Q.organizationId, organizationId), eq(Q.reason, "no_receipt"), isNull(Q.resolvedAt)),
      )
      .limit(HELD_ENTITY_LIMIT),
  );
  return rows.map((r) => r.providerEntityId);
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
    for (const providerEntityId of await entitiesWithHeldEvents(deps, organizationId)) {
      if (!live.has(providerEntityId)) {
        await replayHeldEvents(deps, { organizationId, providerEntityId });
      }
    }
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
