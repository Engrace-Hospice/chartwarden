// apps/backend/src/modules/41-billing-commercial/jobs/ack-held-replay.ts - re-apply the acknowledgments held in quarantine.
//
// Per-reason semantics (the row's validated event is kept for the three replayable reasons; see REPLAYABLE_REASONS):
//   - no_receipt      : re-applied once its submission is settled (a clearinghouse-stage answer or a person's reconcile).
//   - scope_mismatch  : re-checked as it stands, under the SAME stream scope AND the producing stream's vendor (only rows whose
//   - vendor_mismatch   clearinghouse_key is the current binding are replayed, an unbound binding replays nothing; a foreign or unbound row is only aged out). It applies only if the
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
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
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
  | "abandoned_invalid"
  | "abandoned_no_event"
  | "abandoned_foreign_vendor";

/** What the claim-status inquiry made of an aged row: not tried, no answer or not wired, or it produced an applied acknowledgment. */
type InquiryOutcome = "not_attempted" | "unavailable" | "no_answer" | "applied";

interface HeldRow {
  readonly id: string;
  readonly eventId: string;
  readonly controlNumber: string | null;
  readonly reason: string;
  readonly clearinghouseKey: string;
  readonly event: unknown;
  readonly createdAt: Date;
}
interface SubmissionRef {
  readonly claimId: string;
  readonly requestedAt: Date;
  readonly payerId: string;
}

/**
 * Rows a pass looks at: no_receipt always, the other replayable reasons always too, AND either produced by the CURRENT binding's own
 * stream (`clearinghouse_key`), aged past the window, or carrying no event at all (a mismatch row written before migration 1279:
 * nothing can ever be re-applied, so it is closed out loud whatever the binding, see `abandoned_no_event`). A row held from vendor X's
 * stream is never REPLAYED under a binding for vendor Y (the vendor check compares the submission with the binding, so after a
 * vendor switch it would pass and record X's answer against Y's submission), but it must still LEAVE the queue: once aged, it is
 * abandoned out loud whatever the binding (also unbound), with no status inquiry on a stream we no longer hold.
 */
const replayable = (
  Q: typeof schema.commercialAckQuarantine,
  vendor: string | null,
  cutoff: Date,
) =>
  and(
    or(
      vendor === null ? undefined : eq(Q.clearinghouseKey, vendor),
      lt(Q.createdAt, cutoff),
      isNull(Q.event),
    ),
    inArray(Q.reason, ["no_receipt", "scope_mismatch", "vendor_mismatch"]),
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
          .select({
            claimId: S.claimId,
            requestedAt: S.requestedAt,
            payerId: S.clearinghousePayerId,
          })
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
    deps.log?.({
      event: "ack.status_inquiry_failed",
      code: err instanceof Error ? err.name : "error",
    });
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
  const own = row.clearinghouseKey === deps.binding.vendor;
  const submission = await submissionOf(deps, scope, row.controlNumber);
  const claimId = submission?.claimId ?? null;
  // a pre-1279 mismatch row kept no event: there is nothing to re-apply, ever. Close it explicitly (and audited), do not skip it forever.
  if (row.event === null && row.reason !== "no_receipt") {
    await abandonOutright(deps, scope, row, "abandoned_no_event", claimId, "not_attempted");
    return "abandoned";
  }
  // an answer held at time T can only belong to a submission requested before T: control numbers cycle, so a NEWER submission that
  // happens to reuse the number must never inherit an old held answer (and must not be asked about either)
  if (submission && submission.requestedAt.getTime() > row.createdAt.getTime()) {
    await abandonOutright(deps, scope, row, "abandoned_no_submission", claimId, "not_attempted");
    return "abandoned";
  }
  // Age counts from the submission when there is one AND from the moment the event was held, whichever is older.
  const refTime = Math.min(
    row.createdAt.getTime(),
    submission?.requestedAt.getTime() ?? Number.POSITIVE_INFINITY,
  );
  if (refTime < cutoff) {
    // a payer answer is asked about once before it is given up on (the other reasons are about the wrong scope or vendor, and a
    // foreign stream is not ours to ask about: no inquiry)
    const inquiry: InquiryOutcome =
      own && row.reason === "no_receipt" && submission
        ? await inquireStatus(deps, scope, row, submission)
        : "not_attempted";
    if (inquiry === "applied") {
      await abandonOutright(deps, scope, row, "applied_status_inquiry", claimId, inquiry);
      return "applied";
    }
    await abandonOutright(deps, scope, row, "abandoned_aged", claimId, inquiry);
    return "abandoned";
  }
  if (!own) return "held"; // a foreign stream's row is only ever aged out, never applied
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
    // claim the row first: an overlapping tick that already resolved it (applied OR abandoned) must not be applied a second way
    const Qr = schema.commercialAckQuarantine;
    const [live] = await tx
      .select({ id: Qr.id })
      .from(Qr)
      .where(and(eq(Qr.id, row.id), isNull(Qr.resolvedAt)))
      .for("update");
    if (!live) return "settled";
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
  const cutoff = nowOf(deps).getTime() - ACK_POLL_MAX_AGE_DAYS * DAY_MS;
  const heldRows: HeldRow[] = await inOrg(deps, scope.organizationId, (tx) =>
    tx
      .select({
        id: Q.id,
        eventId: Q.eventId,
        controlNumber: Q.controlNumber,
        reason: Q.reason,
        clearinghouseKey: Q.clearinghouseKey,
        event: Q.event,
        createdAt: Q.createdAt,
      })
      .from(Q)
      .where(
        and(
          eq(Q.organizationId, scope.organizationId),
          eq(Q.providerEntityId, scope.providerEntityId),
          replayable(Q, vendor, new Date(cutoff)),
          isNull(Q.resolvedAt),
        ),
      )
      // no_receipt first: mismatch rows can sit held for 45 days and must not crowd the live ones out of the limit
      .orderBy(sql`(${Q.reason} <> 'no_receipt')`, asc(Q.createdAt))
      .limit(HELD_REPLAY_LIMIT),
  );
  deps.log?.({ event: "ack.replay", count: heldRows.length }); // a counting seam: how often the held events are looked at
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
  const cutoff = new Date(nowOf(deps).getTime() - ACK_POLL_MAX_AGE_DAYS * DAY_MS);
  const rows = await inOrg(deps, organizationId, (tx) =>
    tx
      .selectDistinct({ providerEntityId: Q.providerEntityId })
      .from(Q)
      .where(
        and(
          eq(Q.organizationId, organizationId),
          replayable(Q, vendor, cutoff),
          isNull(Q.resolvedAt),
        ),
      )
      .orderBy(asc(Q.providerEntityId))
      .limit(HELD_ENTITY_LIMIT),
  );
  return rows.map((r) => r.providerEntityId);
}

/** Held rows of one organization by what is wrong with them. Counts only (no ids, no payload): safe for ops logs. */
export interface HeldQuarantineReport {
  /** Whether a clearinghouse is bound; with none, every held row is unbound and only ages out (or is closed by the no-event rule). */
  readonly bound: boolean;
  readonly held: number;
  /** Held from the current binding's own stream. */
  readonly ownStream: number;
  /** Held from another vendor's stream, or while unbound: never replayed, only aged out or swept by {@link abandonForeignHeldEvents}. */
  readonly strandedForeign: number;
  /** Pre-1279 mismatch rows with no stored event (closed by the next sweep). */
  readonly noEvent: number;
  /** Unresolved `malformed` rows: review-only, no replay exists. */
  readonly reviewOnlyMalformed: number;
  readonly oldestHeldAt: Date | null;
}

export async function heldQuarantineReport(
  deps: AckWorkerDeps,
  organizationId: string,
): Promise<HeldQuarantineReport> {
  const Q = schema.commercialAckQuarantine;
  const vendor = deps.binding.vendor;
  const replayableReason = inArray(Q.reason, ["no_receipt", "scope_mismatch", "vendor_mismatch"]);
  const n = (expr: ReturnType<typeof sql>) => sql<number>`count(*) filter (where ${expr})::int`;
  const own = vendor === null ? sql`false` : sql`${Q.clearinghouseKey} = ${vendor}`;
  const [r] = await inOrg(deps, organizationId, (tx) =>
    tx
      .select({
        held: n(sql`${replayableReason}`),
        ownStream: n(sql`${replayableReason} and ${own}`),
        strandedForeign: n(sql`${replayableReason} and not (${own})`),
        noEvent: n(sql`${replayableReason} and ${Q.reason} <> 'no_receipt' and ${Q.event} is null`),
        reviewOnlyMalformed: n(sql`${Q.reason} = 'malformed'`),
        oldestHeldAt: sql<Date | null>`min(${Q.createdAt}) filter (where ${replayableReason})`,
      })
      .from(Q)
      .where(and(eq(Q.organizationId, organizationId), isNull(Q.resolvedAt))),
  );
  return {
    bound: vendor !== null,
    held: r?.held ?? 0,
    ownStream: r?.ownStream ?? 0,
    strandedForeign: r?.strandedForeign ?? 0,
    noEvent: r?.noEvent ?? 0,
    reviewOnlyMalformed: r?.reviewOnlyMalformed ?? 0,
    oldestHeldAt: r?.oldestHeldAt ? new Date(r.oldestHeldAt) : null,
  };
}

/**
 * Operator call: close out, now and audited, the held rows of ONE organization that belong to another clearinghouse's stream than the
 * current binding (resolution `abandoned_foreign_vendor`, an `m41.claim.ack_abandoned` event each), without waiting out the 45 days.
 * It needs a bound vendor: while unbound every row is only "not served right now", which may be a config blip, so nothing is closed
 * here (the age sweep still runs). Never touches another organization (RLS plus the explicit organization filter); idempotent.
 * ponytail: bounded per call (HELD_ENTITY_LIMIT rows); call again for more.
 */
export async function abandonForeignHeldEvents(
  deps: AckWorkerDeps,
  organizationId: string,
): Promise<{ readonly abandoned: number }> {
  const vendor = deps.binding.vendor;
  if (vendor === null) return { abandoned: 0 };
  const Q = schema.commercialAckQuarantine;
  const rows = await inOrg(deps, organizationId, (tx) =>
    tx
      .select({
        id: Q.id,
        eventId: Q.eventId,
        controlNumber: Q.controlNumber,
        reason: Q.reason,
        clearinghouseKey: Q.clearinghouseKey,
        event: Q.event,
        createdAt: Q.createdAt,
        providerEntityId: Q.providerEntityId,
      })
      .from(Q)
      .where(
        and(
          eq(Q.organizationId, organizationId),
          inArray(Q.reason, ["no_receipt", "scope_mismatch", "vendor_mismatch"]),
          sql`${Q.clearinghouseKey} <> ${vendor}`,
          isNull(Q.resolvedAt),
        ),
      )
      .orderBy(asc(Q.createdAt))
      .limit(HELD_ENTITY_LIMIT),
  );
  for (const { providerEntityId, ...row } of rows) {
    const scope: Scope = { organizationId, providerEntityId };
    const submission = await submissionOf(deps, scope, row.controlNumber);
    await abandonOutright(
      deps,
      scope,
      row,
      "abandoned_foreign_vendor",
      submission?.claimId ?? null,
      "not_attempted",
    );
  }
  return { abandoned: rows.length };
}

/**
 * The org's held-row sweep of one pull: provider entities that hold events but have no live work are replayed (no transport call,
 * so aged, foreign and event-less rows leave audited, bound or not), and the stranded counts are logged (ids-free) so ops can see them.
 * Throws on a database fault; the caller turns that into a failure label.
 */
export async function sweepHeldEvents(
  deps: AckWorkerDeps,
  organizationId: string,
  liveProviderEntityIds: ReadonlySet<string>,
): Promise<void> {
  for (const providerEntityId of await entitiesWithHeldEvents(deps, organizationId)) {
    if (!liveProviderEntityIds.has(providerEntityId)) {
      await replayHeldEvents(deps, { organizationId, providerEntityId });
    }
  }
  const report = await heldQuarantineReport(deps, organizationId);
  if (report.strandedForeign > 0 || report.noEvent > 0) {
    deps.log?.({
      event: "ack.held_stranded",
      code: report.bound ? "bound" : "unbound",
      count: report.strandedForeign + report.noEvent,
    });
  }
}
