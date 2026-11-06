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
