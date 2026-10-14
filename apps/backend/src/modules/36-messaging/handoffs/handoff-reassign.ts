// apps/backend/src/modules/36-messaging/handoffs/handoff-reassign.ts - WP 3.5: offboarding never leaves a handoff
// ownerless. Called from the access-revocation consumer on `m2.membership.revoked` / `m2.user.deactivated` (not
// `suspended`: reinstatable). A relay tick is not a request: this is org-explicit and runs under the system actor, and it
// never depends on the `messaging.handoffs` flag.
//
//  * The leaver is the RECIPIENT of an offered handoff: its pending items are declined, the handoff closes (`declined`, or
//    `accepted` when the leaver had already accepted some items) with reason `recipient_left`, and the sender and
//    supervisors are told. Accountability never moved for the declined items, so the sender still owns them. Items the
//    leaver already accepted need nothing here (the task transfer and the item owner already moved).
//  * The leaver is the SENDER: a `sender_left` event is recorded once and supervisors are told now; the recipient may still
//    accept (the work is real), and the deadline still applies. A pending TASK item whose task the task sweep already moved
//    off the sender can never transfer, so it is declined now (reason `sender_left`); if that leaves nothing pending the
//    offer closes. Run AFTER the task reassignment (`combineReassignments` order) so the task has moved.
// Converges on redelivery: a closed handoff no longer matches, and `sender_left` is guarded by NOT EXISTS. Per-handoff
// failures are isolated, counted, and rethrown at the end; the error text carries no seam or driver message.
import type { DbClient } from "@wardenx/db";
import { closeOutcome, unacceptedCount } from "@wardenx/messaging";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import type { HandoffItemState } from "@wardenx/types";
import type { HintOutboxPort } from "../message-hint-events";
import type { Tx } from "../messaging-write-core";
import type { TaskStore } from "../tasks/task-store-db";
import { publishHandoffEvent } from "./handoff-events";
import { finishHandoff } from "./handoff-settle";
import type { HandoffRow, HandoffStore } from "./handoff-store-db";

export const HANDOFF_OFFBOARDING_BATCH_SIZE = 100;

export interface HandoffReassignDeps {
  readonly db: DbClient;
  readonly store: HandoffStore;
  readonly taskStore: TaskStore;
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
  // The outcome is derived from what is left: a recipient who accepted some items before leaving closes `accepted`.
  const after = await deps.store.itemsOf(tx, h.organizationId, h.id);
  const outcome = closeOutcome(after.map((i) => i.state as HandoffItemState));
  await finishHandoff({ store: deps.store, outbox: deps.outbox, now: clock }, tx, h, {
    state: outcome.kind === "closed" ? outcome.state : "declined",
    reason: "recipient_left",
    eventType: "recipient_left",
    actor: { kind: "system" },
    unacceptedCause: "recipient_left",
  });
}

/**
 * A pending TASK item whose task is no longer the sender's cannot be transferred on accept (the task sweep moved it, or it
 * closed): the item is declined now so the recipient is not offered a dead item. Other kinds are pointers that stay valid.
 */
async function declineStaleTaskItems(deps: HandoffReassignDeps, tx: Tx, h: HandoffRow) {
  const items = await deps.store.itemsOf(tx, h.organizationId, h.id);
  const stale: string[] = [];
  for (const item of items.filter((i) => i.state === "pending" && i.itemKind === "task")) {
    const task = await deps.taskStore.getForUpdate(tx, h.organizationId, item.refId);
    const live = task && (task.status === "open" || task.status === "accepted");
    if (!task || !live || task.assigneeId !== h.fromUserId) stale.push(item.id);
  }
  if (stale.length === 0) return;
  const moved = await deps.store.resolveItems(tx, {
    orgId: h.organizationId,
    handoffId: h.id,
    itemIds: stale,
    action: "decline",
    now: (deps.now ?? (() => new Date()))(),
  });
  await deps.store.appendEvent(tx, {
    orgId: h.organizationId,
    handoffId: h.id,
    type: "items_declined",
    actor: { kind: "system" },
    itemCount: moved.length,
    reasonCode: "sender_left",
  });
}

async function senderLeft(deps: HandoffReassignDeps, clock: () => Date, tx: Tx, h: HandoffRow) {
  await declineStaleTaskItems(deps, tx, h);
  const items = await deps.store.itemsOf(tx, h.organizationId, h.id);
  const states = items.map((i) => i.state as HandoffItemState);
  await deps.store.appendEvent(tx, {
    orgId: h.organizationId,
    handoffId: h.id,
    type: "sender_left",
    actor: { kind: "system" },
    itemCount: states.filter((s) => s === "pending").length,
  });
  const outcome = closeOutcome(states);
  if (outcome.kind === "closed") {
    // Every item was a dead task: nothing is left for the recipient, so the offer closes and supervisors are told once.
    await finishHandoff({ store: deps.store, outbox: deps.outbox, now: clock }, tx, h, {
      state: outcome.state,
      reason: outcome.reason,
      eventType: "closed",
      actor: { kind: "system" },
      unacceptedCause: "sender_left",
    });
    return;
  }
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
