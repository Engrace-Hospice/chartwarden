// apps/backend/src/modules/35-subscription/routes/admin-transition.ts — the two things a platform operator's pause / resume / cancel of a
// tenant's subscription does before it writes: read the row under a lock, then refuse a transition its status does not allow.
import { schema } from "@chartwarden/db";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { eq } from "drizzle-orm";
import type { WriteTx } from "../pricing/ports";

type SubRow = typeof schema.subscriptionRow.$inferSelect;

export type AdminTransition = "pause" | "resume" | "cancel";

const conflict = (code: string, message: string): ChartWardenError =>
  new ChartWardenError(code, message, 409);

/** The `reason_code` of the ledger row an operator's pause writes (the only row whose `reason_detail` is read back as a pause end date). */
export const PLATFORM_PAUSE_REASON_CODE = "platform_ops_pause";

/**
 * How an admin pause with an end date writes that date into its ledger row's `reason_detail`. The subscription row's own `paused_until`
 * is cleared on resume, so the ledger keeps the date for the statement's pause windows (pricing/statement-inputs.ts reads it back).
 * The format is exact (`paused_until=` and `toISOString()`), and it is read back only from a row with PLATFORM_PAUSE_REASON_CODE: other
 * writers store free text in `reason_detail` (the M2 suspension reason), and that text must never be taken for an end date.
 */
const PAUSED_UNTIL_DETAIL = /^paused_until=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

export const pausedUntilDetail = (until: Date): string => `paused_until=${until.toISOString()}`;

/** The pause end date a ledger row records, or null: the row is not an operator pause, or its detail is not exactly {@link pausedUntilDetail}. */
export function pausedUntilOfLedgerRow(row: {
  readonly reasonCode?: string | null;
  readonly detail?: string | null;
}): Date | null {
  if (row.reasonCode !== PLATFORM_PAUSE_REASON_CODE) return null;
  const match = row.detail ? PAUSED_UNTIL_DETAIL.exec(row.detail) : null;
  const until = match?.[1] ? new Date(match[1]) : null;
  return until && !Number.isNaN(until.getTime()) ? until : null;
}

/** An ISO 8601 instant WITH an explicit offset (`Z` or `+hh:mm`): the only spelling whose meaning does not depend on the server's zone. */
const ISO_INSTANT_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The end date of an admin pause as an instant: null for an open-ended pause. The route's `date-time` format accepts a string with no
 * offset (`2026-11-28T10:00`), which `new Date` reads in the SERVER's zone, so the same request would end the pause at different
 * instants on differently configured hosts: an instant with no explicit offset (or one that is not an instant at all) is a typed 422.
 * Judged before the runner is opened; whether it is still in the future is judged later, against the clock read under the row lock.
 */
export function parsePauseEnd(pausedUntil: string | null): Date | null {
  if (!pausedUntil) return null;
  const until = new Date(pausedUntil);
  if (!ISO_INSTANT_WITH_OFFSET.test(pausedUntil) || Number.isNaN(until.getTime())) {
    throw new ChartWardenError(
      "PAUSE_UNTIL_INVALID",
      "pausedUntil must be an ISO 8601 instant with an explicit offset, for example 2026-12-15T00:00:00Z",
      422,
    );
  }
  return until;
}

/**
 * Nothing resumes a subscription when its end date arrives (billing just stops counting the pause), so a date that is not strictly
 * after `at` would make the pause meaningless: a typed 422. `at` is the instant the pause is written, read AFTER the row lock.
 */
export function refuseUnlessFuture(until: Date | null, at: Date): void {
  if (until && until.getTime() <= at.getTime()) {
    throw new ChartWardenError("PAUSE_UNTIL_NOT_FUTURE", "pausedUntil must be in the future", 422);
  }
}

/**
 * The subscription an admin transition acts on, read `FOR UPDATE` inside the write transaction. Two operators acting at once are
 * serialized: the second waits for the first to commit and then judges the status the first one left, instead of both reading the same
 * status and both writing (two history rows, two events, a canceled subscription resumed). Needs UPDATE on at least one `subscription`
 * column, which the platform carrier holds by column (provision-runtime-roles.ts).
 */
export async function lockSubscription(tx: WriteTx, subscriptionId: string): Promise<SubRow> {
  const S = schema.subscriptionRow;
  const [sub] = await tx.select().from(S).where(eq(S.id, subscriptionId)).for("update").limit(1);
  if (!sub) throw new NotFoundError("subscription", subscriptionId);
  return sub;
}

/**
 * A typed 409 (stable code) when `sub`'s status does not allow the transition, so nothing is written, audited or announced for it.
 * Mirrors what the org-lifecycle consumer already treats as a no-op (pause of a paused or canceled subscription, resume of one that is
 * not paused); at the operator surface a no-op would hide a mistake, so it is refused instead. A canceled subscription is final: it is
 * never resumed, paused or canceled again (its `canceled_at` and its history are the record the final statement is priced from).
 */
export function refuseAdminTransition(sub: Pick<SubRow, "status">, action: AdminTransition): void {
  if (action === "resume" && sub.status !== "paused") {
    throw conflict(
      "SUBSCRIPTION_NOT_PAUSED",
      `only a paused subscription can be resumed (it is ${sub.status})`,
    );
  }
  if (action === "resume") return;
  if (sub.status === "canceled") {
    throw conflict(
      "SUBSCRIPTION_CANCELED",
      `a canceled subscription is final; it cannot be ${action === "pause" ? "paused" : "canceled"} again`,
    );
  }
  if (action === "pause" && sub.status === "paused") {
    throw conflict("SUBSCRIPTION_ALREADY_PAUSED", "the subscription is already paused");
  }
}
