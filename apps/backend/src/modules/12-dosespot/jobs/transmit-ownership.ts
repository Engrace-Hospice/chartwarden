// apps/backend/src/modules/12-dosespot/jobs/transmit-ownership.ts — what a transmit worker owns, and the checks that stop it writing or sending when it
// no longer does (split out of transmit-newrx.ts).
//
// A worker owns its CLAIM from the claim to the fence (the order's `updated_at` the claim wrote) and its CALL from the fence on (the `call_token` nonce
// the fence wrote on the transmission row). Everything a worker does after its claim is conditional on that: the fence, recording a created
// prescription id (`rememberCreated`), the check just before the send (`requireOwnership`), and the settle (transmit-settle.ts). A worker that lost
// the order (drained and taken over, or resolved by an administrator) writes nothing and, before the send, is stopped.
//
// LOCK ORDER everywhere: the order row, then the transmission row (the order the administrator's resolution and the drain take them in).
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { NotEnabledError } from "@chartwarden/dosespot";
import { and, eq } from "drizzle-orm";
import { freshIdempotencyKey, vendorWriteIsCurrent } from "../tenant-config/registration-target";
import { type M12CronDeps, inOrg } from "./cron-common";

const MO = schema.medicationOrders;
const MOT = schema.medicationOrderTransmissions;

type OrderRow = typeof MO.$inferSelect;
type TransmissionRow = typeof MOT.$inferSelect;

/** One order a worker claimed: what it read, and the `updated_at` its claim wrote. */
export interface Claimed {
  readonly order: OrderRow;
  /**
   * The transmission row as the CLAIM read it: good for its id and its retry count. NOT for the created prescription id or the idempotency key the call
   * is made with: the registration's reset rewrites both on a claimed order that is not stamped yet, so the call takes them from the stamp's own answer.
   */
  readonly transmission: TransmissionRow;
  /** The `updated_at` this claim wrote: the fence compares against it, so a claim that was drained and taken over no longer matches. */
  readonly claimedAt: Date;
}

/**
 * What a worker owns when it comes to write. BEFORE the fence it owns the CLAIM: the order's `updated_at` that the claim wrote. AFTER the fence it
 * owns the CALL: the `call_token` nonce the fence wrote on the transmission row. `updated_at` cannot stay the token after the fence: it
 * is shared with writes that have nothing to do with the claim (a coverage determination is allowed in every status, a correction bumps the
 * original order's version), and one of them during the call would turn the legitimate owner into a "skipped" one, orphaning a prescription
 * DoseSpot had accepted and leaving a stamp the drain then holds.
 */
export type Ownership =
  | { readonly stage: "claim"; readonly claimedAt: Date }
  /** `target` is the registration target (registration-target.ts) the call began under: the settle drops the old clinic's ids if it moved. */
  | { readonly stage: "call"; readonly token: string; readonly target: string };

/**
 * A worker that no longer owns what it found writes nothing. It says so, with ids only and the KIND of what it discarded (never the content of it: a
 * success carries a prescription id), so a lost claim is visible whatever the worker found. A success is the case that matters most: DoseSpot
 * accepted a prescription for an order this worker could not record it on (an administrator resolved the order while the call ran, say).
 */
export function discarded(
  deps: M12CronDeps,
  organizationId: string,
  orderId: string,
  found: string,
): "skipped" {
  deps.warn?.(
    { organizationId, orderId, found },
    found === "success"
      ? "M12 transmit: DoseSpot accepted a prescription for an order this worker no longer owns; nothing was recorded here"
      : "M12 transmit: this worker no longer owns the order; what it found was discarded",
  );
  return "skipped";
}

/** The order row only while it is still in flight under the status it was claimed in and, before the fence, with the `updated_at` the claim wrote. */
export function orderStillTheWorkers(orderId: string, owns: Ownership) {
  return and(
    eq(MO.id, orderId),
    eq(MO.status, "queued_for_transmission"),
    eq(MO.dosespotSendState, "in_flight"),
    owns.stage === "claim" ? eq(MO.updatedAt, owns.claimedAt) : undefined,
  );
}

/**
 * Lock what the worker owns and say whether it still owns it: the ORDER row, then (after the fence) the TRANSMISSION row carrying the token this
 * worker wrote. That is the order the administrator's resolution and the drain lock them in, so none of them can deadlock; the locks last to the end of the
 * transaction, so what is checked here still holds for every write after it.
 */
export async function lockOwnership(tx: DbClient, c: Claimed, owns: Ownership): Promise<boolean> {
  const [order] = await tx
    .select({ id: MO.id })
    .from(MO)
    .where(orderStillTheWorkers(c.order.id, owns))
    .limit(1)
    .for("update");
  if (!order) return false;
  if (owns.stage === "claim") return true;
  const [stamp] = await tx
    .select({ id: MOT.id })
    .from(MOT)
    .where(and(eq(MOT.id, c.transmission.id), eq(MOT.callToken, owns.token)))
    .limit(1)
    .for("update");
  return stamp !== undefined;
}

/** What the adapter's hooks throw when the worker no longer owns the order: the adapter then does not send. Carries no id and no content. */
const LOST_ORDER = "this worker no longer owns the order, so the prescription is not sent";

/**
 * What a transmission row is set to when the clinic the registration names has changed under a call that had begun (the clear skips a stamped row, so
 * the worker whose call it was drops the old clinic's bindings itself, in the settle, transmit-settle.ts): the created prescription id goes (an id is
 * scoped to the clinic that created it, and DoseSpot refuses it for good under another) and the idempotency key is replaced (it names the order at the
 * old clinic). Both, or the requeued order would resume the old clinic's draft or reuse its key under the new one.
 */
export const retargetedBindings = () => ({
  dosespotPrescriptionId: null,
  idempotencyKey: freshIdempotencyKey(MOT.idempotencyKey),
});

/** Said when a worker drops the old clinic's ids because the registration moved during its call. Ids only. */
export function warnRegistrationMoved(
  deps: M12CronDeps,
  organizationId: string,
  orderId: string,
): void {
  deps.warn?.(
    { organizationId, orderId, class: "registration_moved" },
    "M12 transmit: the DoseSpot registration moved to another clinic during the call; the created prescription id and the idempotency key were dropped and the order waits",
  );
}

/**
 * The registration moved to another clinic while this worker's call was in flight (registration-target.ts). A NotEnabledError, so the worker settles
 * it as an outage: the order goes back to `queued`, no retry spent, and runs again under the new registration (the settle drops the old clinic's
 * created id and key, which it sees because the registration no longer names the clinic the call began under). Carries no id and no content.
 */
function registrationMoved(): NotEnabledError {
  return new NotEnabledError(
    "dosespot",
    "transmitNewRx",
    "The DoseSpot registration moved to another clinic while this prescription was being sent; it will be sent under the new registration.",
    randomUUID(),
  );
}

/**
 * The call-stage guard shared by {@link rememberCreated} and {@link requireOwnership}: in ONE transaction, check the registration still names the
 * clinic the call began under (FIRST, before any row lock, so it cannot deadlock with the clear), lock what the worker owns (a worker that lost the
 * order throws), and run `whileCurrent`. If the registration moved the caller throws, which stops the call; the created id this worker may already
 * have persisted is the OLD clinic's, and it is dropped, with the key, by the settle that follows (the clear skipped it: the call had begun).
 */
async function guardedCallStage(
  deps: M12CronDeps,
  organizationId: string,
  c: Claimed,
  token: string,
  target: string,
  whileCurrent: (tx: DbClient) => Promise<void>,
): Promise<void> {
  const current = await inOrg(deps.db, organizationId, async (tx) => {
    const isCurrent = await vendorWriteIsCurrent(tx, organizationId, target);
    if (!(await lockOwnership(tx, c, { stage: "call", token, target }))) {
      throw new Error(LOST_ORDER);
    }
    if (isCurrent) await whileCurrent(tx);
    return isCurrent;
  });
  if (!current) throw registrationMoved();
}

/**
 * Persist the id of a prescription that was CREATED at DoseSpot but not yet sent, on the transmission row, before the send. The order itself
 * carries an id only once it is really sent (webhooks bind by it). A failure here propagates: the send is not attempted, the order is retried.
 *
 * It answers only while the worker still owns the call (see {@link Ownership}): it throws otherwise, so the id of a prescription the worker had no
 * right to create for this order is not recorded, and the adapter stops before the send. The prescription stays at DoseSpot as an unsent draft, which
 * the administrator's own check of the prescriber's account shows. Locks the order, then the transmission row, like every other writer. It also
 * answers only while the registration still names the clinic the call began under (`target`): the id would be the old clinic's.
 */
export async function rememberCreated(
  deps: M12CronDeps,
  organizationId: string,
  c: Claimed,
  token: string,
  prescriptionId: string,
  target: string,
): Promise<void> {
  await guardedCallStage(deps, organizationId, c, token, target, async (tx) => {
    await tx
      .update(MOT)
      .set({ dosespotPrescriptionId: prescriptionId })
      .where(eq(MOT.id, c.transmission.id));
  });
}

/**
 * The adapter's `beforeSend`: just before it SENDS, on every path, the worker re-checks that it still owns the call and throws if not. `onCreated`
 * covers only a prescription this call created; a retry that is handed a persisted created id skips the create and goes straight to the send, so
 * without this a worker whose order an administrator resolved NOT SENT meanwhile would still send it. What it cannot cover: a send already in flight.
 * It also refuses to send once the registration has moved to another clinic since the call began (`target`).
 */
export async function requireOwnership(
  deps: M12CronDeps,
  organizationId: string,
  c: Claimed,
  token: string,
  target: string,
): Promise<void> {
  await guardedCallStage(deps, organizationId, c, token, target, async () => undefined);
}
