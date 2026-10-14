// apps/backend/src/modules/36-messaging/handoffs/handoff-reassign.ts - WP 3.5: offboarding never leaves a handoff
// ownerless. Called from the access-revocation consumer on `m2.membership.revoked` / `m2.user.deactivated` (not
// `suspended`: reinstatable). A relay tick is not a request: this is org-explicit and runs under the system actor, and it
// never depends on the `messaging.handoffs` flag.
//
//  * The leaver is the RECIPIENT of an offered handoff: its pending items are declined, the handoff closes `declined` with
//    reason `recipient_left`, and the sender and supervisors are told. Accountability never moved, so the sender still owns
//    every item. Items the leaver already accepted need nothing here (the task transfer and the item owner already moved).
//  * The leaver is the SENDER: a `sender_left` event is recorded once and supervisors are told now; the recipient may still
//    accept (the work is real), and the deadline still applies.
// Converges on redelivery: a closed handoff no longer matches, and `sender_left` is guarded by NOT EXISTS. Per-handoff
// failures are isolated, counted, and rethrown at the end; the error text carries no seam or driver message.
import type { DbClient } from "@wardenx/db";
import { unacceptedCount } from "@wardenx/messaging";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import type { HandoffItemState } from "@wardenx/types";
import type { HintOutboxPort } from "../message-hint-events";
import type { Tx } from "../messaging-write-core";
import { publishHandoffEvent } from "./handoff-events";
import { finishHandoff } from "./handoff-settle";
import type { HandoffRow, HandoffStore } from "./handoff-store-db";

export const HANDOFF_OFFBOARDING_BATCH_SIZE = 100;

export interface HandoffReassignDeps {
  readonly db: DbClient;
  readonly store: HandoffStore;
  readonly outbox: HintOutboxPort | undefined;
  readonly now?: () => Date;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

export interface ResolveSummary {
  readonly recipientClosed: number;
  readonly senderFlagged: number;
  readonly failed: number;
}

type Outcome = "recipient_closed" | "sender_flagged" | "skipped";

async function recipientLeft(deps: HandoffReassignDeps, clock: () => Date, tx: Tx, h: HandoffRow) {
  await deps.store.resolveItems(tx, {
    orgId: h.organizationId,
    handoffId: h.id,
    itemIds: null,
    action: "decline",
    now: clock(),
  });
  await finishHandoff({ store: deps.store, outbox: deps.outbox, now: clock }, tx, h, {
    state: "declined",
    reason: "recipient_left",
    eventType: "recipient_left",
    actor: { kind: "system" },
    unacceptedCause: "recipient_left",
  });
}

async function senderLeft(deps: HandoffReassignDeps, clock: () => Date, tx: Tx, h: HandoffRow) {
  const items = await deps.store.itemsOf(tx, h.organizationId, h.id);
  const states = items.map((i) => i.state as HandoffItemState);
  await deps.store.appendEvent(tx, {
    orgId: h.organizationId,
    handoffId: h.id,
    type: "sender_left",
    actor: { kind: "system" },
    itemCount: states.filter((s) => s === "pending").length,
  });
  await publishHandoffEvent(deps.outbox, tx, {
    kind: "unaccepted",
    orgId: h.organizationId,
    handoffId: h.id,
    fromUserId: h.fromUserId,
    toUserId: h.toUserId,
    cause: "sender_left",
    // The sender's pending items are now at risk: they are what supervisors must find a new owner for.
    unacceptedItemCount: states.filter((s) => s === "pending").length + unacceptedCount(states),
    acceptedItemCount: states.filter((s) => s === "accepted").length,
    at: clock(),
  });
}

async function resolveOne(
  deps: HandoffReassignDeps,
  orgId: string,
  leaverUserId: string,
  handoffId: string,
): Promise<Outcome> {
  const clock = deps.now ?? (() => new Date());
  return withOrgContext(deps.db, systemOrgContext(orgId), async (rawTx) => {
    const tx = rawTx as unknown as Tx;
    const h = await deps.store.getForUpdate(tx, orgId, handoffId);
    if (!h || h.state !== "offered") return "skipped";
    if (h.toUserId === leaverUserId) {
      await recipientLeft(deps, clock, tx, h);
      return "recipient_closed";
    }
    if (
      h.fromUserId !== leaverUserId ||
      (await deps.store.hasEvent(tx, orgId, handoffId, "sender_left"))
    )
      return "skipped";
    await senderLeft(deps, clock, tx, h);
    return "sender_flagged";
  });
}

export async function reassignHandoffsForLeaver(
  deps: HandoffReassignDeps,
  orgId: string,
  leaverUserId: string,
): Promise<ResolveSummary> {
  const seen = new Set<string>();
  const failedIds = new Set<string>();
  let recipientClosed = 0;
  let senderFlagged = 0;
  for (;;) {
    const ids = await deps.store.leaverHandoffIds(
      orgId,
      leaverUserId,
      HANDOFF_OFFBOARDING_BATCH_SIZE,
      [...seen],
    );
    if (ids.length === 0) break;
    for (const handoffId of ids) {
      seen.add(handoffId);
      try {
        const outcome = await resolveOne(deps, orgId, leaverUserId, handoffId);
        if (outcome === "recipient_closed") recipientClosed += 1;
        if (outcome === "sender_flagged") senderFlagged += 1;
      } catch (err) {
        failedIds.add(handoffId);
        deps.warn?.("offboarding handoff resolution failed", {
          handoff_id: handoffId,
          error_name: err instanceof Error ? err.name : "NonError",
        });
      }
    }
  }
  if (failedIds.size > 0) {
    throw new Error(`offboarding handoff resolution failed for ${failedIds.size} handoff(s)`);
  }
  return { recipientClosed, senderFlagged, failed: 0 };
}
