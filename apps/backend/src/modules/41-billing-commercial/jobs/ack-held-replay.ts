// apps/backend/src/modules/41-billing-commercial/jobs/ack-held-replay.ts - re-apply the acknowledgments held in quarantine.
//
// Per-reason semantics (the row's validated event is kept for the three replayable reasons; see REPLAYABLE_REASONS):
//   - no_receipt      : re-applied once its submission is settled (a clearinghouse-stage answer or a person's reconcile).
//   - scope_mismatch  : re-checked as it stands, under the SAME stream scope AND the producing stream's vendor (only rows whose
//   - vendor_mismatch   clearinghouse_key is the current binding are replayed; unbound replays nothing). It applies only if the
//                       situation changed and is never re-routed to the other provider entity or vendor; otherwise it stays held.
//   - malformed       : nothing valid was kept, so there is nothing to replay; review only.
// Replay is idempotent: an applied row collapses on the unique (organization, clearinghouse, event id) key and is stamped resolved.
//
// A held row ALWAYS leaves the queue, and never silently. Past ACK_POLL_MAX_AGE_DAYS a held payer answer is first ASKED about
// (`fetchClaimStatus`, outside any transaction; only the `latest` acknowledgment it returns is used, and `not_found` is never read as
// "not received"). Whatever cannot apply is then abandoned with a `resolution`, and that abandonment is an `m41.claim.ack_abandoned`
// event in the same transaction as the stamp (plus the row's own write audit and a warn-level log, ids only): it may be the only proof
// a file arrived. Relay ticks are not requests: everything here takes an explicit organization and runs under `inOrg`.
import { schema } from "@chartwarden/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { validateAckEvent } from "../domain/ack-event";
import type { CommercialTx } from "../services/types";
import {
  ACK_POLL_MAX_AGE_DAYS,
  type AckWorkerDeps,
  DAY_MS,
  type QuarantineReason,
  type Scope,
  applyAckEvent,
  applyValidEvent,
  inOrg,
  nowOf,
} from "./ack-apply";

/** Held events re-applied per provider entity per pass. */
const HELD_REPLAY_LIMIT = 100;
/** Provider entities swept for dead held events per org per tick. */
const HELD_ENTITY_LIMIT = 200;

type HeldResolution =
  | "applied"
  | "applied_status_inquiry"
  | "abandoned_no_submission"
  | "abandoned_scope_mismatch"
  | "abandoned_vendor_mismatch"
  | "abandoned_aged"
  | "abandoned_invalid";

/** What the claim-status inquiry made of an aged row: not tried, no answer or not wired, or it produced an applied acknowledgment. */
type InquiryOutcome = "not_attempted" | "unavailable" | "no_answer" | "applied";

interface HeldRow {
  readonly id: string;
  readonly eventId: string;
  readonly controlNumber: string | null;
  readonly reason: string;
  readonly event: unknown;
  readonly createdAt: Date;
}
interface SubmissionRef {
  readonly claimId: string;
  readonly requestedAt: Date;
  readonly payerId: string;
}

/**
 * Rows a pass may replay: no_receipt always, the other replayable reasons only when their event was kept (older rows have none) AND
 * only the rows the CURRENT binding's own stream produced (`clearinghouse_key`). A row held from vendor X's stream is never replayed
 * under a binding for vendor Y: the vendor check compares the submission with the binding, so after a vendor switch it would otherwise
 * pass and record X's answer against Y's submission. Such an orphan ages out (abandoned, audited). An unbound binding replays nothing.
 */
const replayable = (Q: typeof schema.commercialAckQuarantine, vendor: string) =>
  and(
    eq(Q.clearinghouseKey, vendor),
    or(
      eq(Q.reason, "no_receipt"),
      and(inArray(Q.reason, ["scope_mismatch", "vendor_mismatch"]), isNotNull(Q.event)),
    ),
  );

/** The newest submission of this provider entity with that control number, if any. */
const submissionOf = (
  deps: AckWorkerDeps,
  scope: Scope,
  controlNumber: string | null,
): Promise<SubmissionRef | null> =>
  controlNumber === null
    ? Promise.resolve(null)
    : inOrg(deps, scope.organizationId, async (tx) => {
        const S = schema.commercialSubmissions;
        const [s] = await tx
          .select({ claimId: S.claimId, requestedAt: S.requestedAt, payerId: S.clearinghousePayerId })
          .from(S)
          .where(
            and(
              eq(S.organizationId, scope.organizationId),
              eq(S.providerEntityId, scope.providerEntityId),
              eq(S.controlNumber, controlNumber),
            ),
          )
          .orderBy(desc(S.requestedAt))
          .limit(1);
        return s ?? null;
      });

/**
 * Ask the clearinghouse where an aged held claim stands, and apply the acknowledgment it reports (the normal apply rules, so a
 * duplicate collapses and a mismatch is refused). Never throws: an unwired or failing transport is `unavailable`.
 */
async function inquireStatus(
  deps: AckWorkerDeps,
  scope: Scope,
  row: HeldRow,
  submission: SubmissionRef,
): Promise<InquiryOutcome> {
  if (row.controlNumber === null) return "not_attempted";
  try {
    const ctx = await deps.contexts.contextFor(
      scope.organizationId,
      scope.providerEntityId,
      submission.payerId,
    );
    if (ctx === null) return "unavailable";
    const status = await deps.binding.transport.fetchClaimStatus(ctx, row.controlNumber);
    if (!status.ok) return "unavailable";
    const latest = status.data.latest;
    // only an answer about THIS control number counts, and only one that really applied now (a duplicate applied nothing)
    if (latest === null || latest.controlNumber !== row.controlNumber) return "no_answer";
    const out = await applyAckEvent(deps, scope, latest);
    return out.result === "applied" ? "applied" : "no_answer";
  } catch (err) {
    deps.log?.({ event: "ack.status_inquiry_failed", code: err instanceof Error ? err.name : "error" });
    return "unavailable";
  }
}

/** Stamp a held row and, for an abandonment, publish the explicit event in the SAME transaction. */
async function settle(
  deps: AckWorkerDeps,
  tx: CommercialTx,
  scope: Scope,
  row: HeldRow,
  resolution: HeldResolution,
  claimId: string | null,
  statusInquiry: InquiryOutcome,
): Promise<void> {
  const Q = schema.commercialAckQuarantine;
  // guarded: two overlapping ticks stamp (and publish) once; the loser changes nothing
  const stamped = await tx
    .update(Q)
    .set({ resolvedAt: nowOf(deps), resolution })
    .where(and(eq(Q.id, row.id), isNull(Q.resolvedAt)))
    .returning({ id: Q.id });
  if (stamped.length === 0 || !resolution.startsWith("abandoned_")) return;
  await deps.outbox.publish(tx, {
    eventName: "m41.claim.ack_abandoned",
    organizationId: scope.organizationId,
    aggregateKind: "commercial_ack_quarantine",
    aggregateId: row.id,
    payload: {
      eventId: row.eventId,
      controlNumber: row.controlNumber,
      claimId,
      reason: row.reason,
      resolution,
      statusInquiry,
    },
  });
  deps.log?.({
    event: "ack.held_abandoned",
    eventId: row.eventId,
    code: resolution,
    ...(row.controlNumber ? { controlNumber: row.controlNumber } : {}),
    ...(claimId ? { claimId } : {}),
  });
}

const abandonOutright = (
  deps: AckWorkerDeps,
  scope: Scope,
  row: HeldRow,
  resolution: HeldResolution,
  claimId: string | null,
  statusInquiry: InquiryOutcome,
) =>
  inOrg(deps, scope.organizationId, (tx) =>
    settle(deps, tx, scope, row, resolution, claimId, statusInquiry),
  );

/** One row, one pass. Returns how it left (or `held` when it stays). */
async function replayRow(
  deps: AckWorkerDeps,
  scope: Scope,
  row: HeldRow,
  cutoff: number,
): Promise<"applied" | "abandoned" | "held" | "settled"> {
  const submission = await submissionOf(deps, scope, row.controlNumber);
  const claimId = submission?.claimId ?? null;
  // Age counts from the submission when there is one AND from the moment the event was held, whichever is older.
  const refTime = Math.min(
    row.createdAt.getTime(),
    submission?.requestedAt.getTime() ?? Number.POSITIVE_INFINITY,
  );
  if (refTime < cutoff) {
    // a payer answer is asked about once before it is given up on (the other reasons are about the wrong scope or vendor: no inquiry)
    const inquiry: InquiryOutcome =
      row.reason === "no_receipt" && submission
        ? await inquireStatus(deps, scope, row, submission)
        : "not_attempted";
    if (inquiry === "applied") {
      await abandonOutright(deps, scope, row, "applied_status_inquiry", claimId, inquiry);
      return "applied";
    }
    await abandonOutright(deps, scope, row, "abandoned_aged", claimId, inquiry);
    return "abandoned";
  }
  // an answer held at time T can only belong to a submission requested before T: control numbers cycle, so a NEWER submission that
  // happens to reuse the number must never inherit an old held answer
  if (submission && submission.requestedAt.getTime() > row.createdAt.getTime()) {
    await abandonOutright(deps, scope, row, "abandoned_no_submission", claimId, "not_attempted");
    return "abandoned";
  }
  const checked = validateAckEvent({
    ...(row.event as Record<string, unknown> | null),
    eventId: row.eventId,
    controlNumber: row.controlNumber,
  });
  if (!checked.ok) {
    deps.log?.({ event: "ack.held_invalid", eventId: row.eventId, code: checked.reason });
    await abandonOutright(deps, scope, row, "abandoned_invalid", claimId, "not_attempted");
    return "abandoned";
  }
  return inOrg(deps, scope.organizationId, async (tx) => {
    const out = await applyValidEvent(deps, tx, scope, checked.event);
    if (out.result === "applied" || out.result === "duplicate") {
      await settle(deps, tx, scope, row, "applied", claimId, "not_attempted");
      return out.result === "applied" ? "applied" : "settled"; // a duplicate was already recorded: it leaves the queue, nothing new applied
    }
    if (out.result === "unmatched") {
      await settle(deps, tx, scope, row, "abandoned_no_submission", claimId, "not_attempted");
      return "abandoned";
    }
    // Still quarantined. A row that was held for the SAME reason keeps waiting for the situation to change. A no_receipt row that now
    // hits a scope/vendor mismatch can never apply here, so it leaves.
    const reason: QuarantineReason | undefined = out.reason;
    if (row.reason === "no_receipt" && reason === "vendor_mismatch") {
      await settle(deps, tx, scope, row, "abandoned_vendor_mismatch", claimId, "not_attempted");
      return "abandoned";
    }
    if (row.reason === "no_receipt" && reason === "scope_mismatch") {
      await settle(deps, tx, scope, row, "abandoned_scope_mismatch", claimId, "not_attempted");
      return "abandoned";
    }
    return "held";
  });
}

/**
 * Re-apply the held events of one provider entity (see the header for the per-reason meaning). Each row is handled in its own
 * transaction and stamped `resolved_at` there. A row that cannot apply yet stays held; one that never can is abandoned out loud.
 */
export async function replayHeldEvents(
  deps: AckWorkerDeps,
  scope: Scope,
): Promise<{ readonly applied: number; readonly abandoned: number }> {
  const Q = schema.commercialAckQuarantine;
  const vendor = deps.binding.vendor;
  if (vendor === null) return { applied: 0, abandoned: 0 }; // unbound: no stream to replay against
  const heldRows: HeldRow[] = await inOrg(deps, scope.organizationId, (tx) =>
    tx
      .select({
        id: Q.id,
        eventId: Q.eventId,
        controlNumber: Q.controlNumber,
        reason: Q.reason,
        event: Q.event,
        createdAt: Q.createdAt,
      })
      .from(Q)
      .where(
        and(
          eq(Q.organizationId, scope.organizationId),
          eq(Q.providerEntityId, scope.providerEntityId),
          replayable(Q, vendor),
          isNull(Q.resolvedAt),
        ),
      )
      // no_receipt first: mismatch rows can sit held for 45 days and must not crowd the live ones out of the limit
      .orderBy(sql`(${Q.reason} <> 'no_receipt')`, asc(Q.createdAt))
      .limit(HELD_REPLAY_LIMIT),
  );
  deps.log?.({ event: "ack.replay", count: heldRows.length }); // a counting seam: how often the held events are looked at
  const cutoff = nowOf(deps).getTime() - ACK_POLL_MAX_AGE_DAYS * DAY_MS;
  let applied = 0;
  let abandoned = 0;
  for (const row of heldRows) {
    const left = await replayRow(deps, scope, row, cutoff);
    if (left === "applied") applied += 1;
    else if (left === "abandoned") abandoned += 1;
  }
  return { applied, abandoned };
}

/** Provider entities of the org that still hold unresolved replayable events (so dead ones get swept even with no live work). */
export async function entitiesWithHeldEvents(
  deps: AckWorkerDeps,
  organizationId: string,
): Promise<string[]> {
  const Q = schema.commercialAckQuarantine;
  const vendor = deps.binding.vendor;
  if (vendor === null) return [];
  const rows = await inOrg(deps, organizationId, (tx) =>
    tx
      .selectDistinct({ providerEntityId: Q.providerEntityId })
      .from(Q)
      .where(
        and(eq(Q.organizationId, organizationId), replayable(Q, vendor), isNull(Q.resolvedAt)),
      )
      .orderBy(asc(Q.providerEntityId))
      .limit(HELD_ENTITY_LIMIT),
  );
  return rows.map((r) => r.providerEntityId);
}
