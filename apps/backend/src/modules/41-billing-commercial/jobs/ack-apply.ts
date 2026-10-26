// apps/backend/src/modules/41-billing-commercial/jobs/ack-apply.ts - apply ONE validated acknowledgment event (shared by the pull and
// the held-event replay; see ack-worker.ts for the stream rules and ack-held-replay.ts for the replay).
import { createHash } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import type { ClearinghouseTransport } from "@chartwarden/x12-837-client";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { type ValidAckEvent, validateAckEvent } from "../domain/ack-event";
import { transitionForAck } from "../domain/ack-transition";
import type { CommercialContextPort } from "../eligibility/service";
import type { CommercialOutboxPort, CommercialTx } from "../services/types";

/** A sent claim older than this is no longer polled for; a held answer past it is asked about once (claim status), then abandoned. */
export const ACK_POLL_MAX_AGE_DAYS = 45;
export const DAY_MS = 86_400_000;

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
    readonly transport: Pick<ClearinghouseTransport, "fetchAcknowledgments" | "fetchClaimStatus">;
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
    readonly controlNumber?: string;
    readonly claimId?: string;
  }) => void;
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

export const inOrg = <T>(
  deps: AckWorkerDeps,
  organizationId: string,
  fn: (tx: CommercialTx) => Promise<T>,
): Promise<T> => withOrgContext(deps.db, systemOrgContext(organizationId), fn);

export const nowOf = (deps: AckWorkerDeps): Date => (deps.now ?? (() => new Date()))();

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

export type Scope = { readonly organizationId: string; readonly providerEntityId: string };

/**
 * The reasons whose validated event is KEPT (codes and ids, no PHI) and re-applied by the replay, each with its own meaning:
 * `no_receipt` waits for its submission to be settled; `scope_mismatch` and `vendor_mismatch` are re-checked as they stand (they
 * apply only if the situation changed, e.g. the submission was re-sent through the bound clearinghouse) and are never re-routed to
 * another scope or vendor. `malformed` has nothing valid to keep, so it is review-only.
 */
export const REPLAYABLE_REASONS = ["no_receipt", "scope_mismatch", "vendor_mismatch"] as const;
export const isReplayableReason = (reason: QuarantineReason): boolean =>
  (REPLAYABLE_REASONS as readonly string[]).includes(reason);

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
      // a replayable reason keeps its validated fields (codes and ids, no PHI) so the pull can replay it
      event:
        isReplayableReason(reason) && held
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
export async function applyValidEvent(
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
