// apps/backend/src/modules/36-messaging/handoffs/handoff-settle.ts - WP 3.5: the one place a handoff is CLOSED. Accept,
// decline, cancel, the expiry tick and offboarding all end here, so the closing row, its history event and the
// `m36.handoff.unaccepted` announcement cannot drift apart. The caller holds the handoff row FOR UPDATE and has already
// moved the items; this closes the handoff in the same transaction. The announcement carries counts, never an item.
import { unacceptedCount } from "@wardenx/messaging";
import type {
  HandoffCloseReason,
  HandoffEventType,
  HandoffItemState,
  HandoffState,
  HandoffUnacceptedCause,
} from "@wardenx/types";
import type { HintOutboxPort } from "../message-hint-events";
import type { Tx } from "../messaging-write-core";
import { publishHandoffEvent } from "./handoff-events";
import type { HandoffActor, HandoffRow, HandoffStore } from "./handoff-store-db";

export interface SettleDeps {
  readonly store: HandoffStore;
  readonly outbox: HintOutboxPort | undefined;
  readonly now: () => Date;
}

export interface FinishArgs {
  readonly state: Exclude<HandoffState, "offered">;
  readonly reason: HandoffCloseReason;
  readonly eventType: HandoffEventType;
  readonly actor: HandoffActor;
  /** When set (and some item ended unaccepted), `m36.handoff.unaccepted` is published with this cause. */
  readonly unacceptedCause: HandoffUnacceptedCause | null;
}

/** Closes the OFFERED handoff `h` (locked by the caller), records the event and announces anything left unaccepted. */
export async function finishHandoff(
  deps: SettleDeps,
  tx: Tx,
  h: HandoffRow,
  args: FinishArgs,
): Promise<HandoffRow> {
  const at = deps.now();
  const items = await deps.store.itemsOf(tx, h.organizationId, h.id);
  const states = items.map((i) => i.state as HandoffItemState);
  const closed = await deps.store.closeHandoff(tx, {
    orgId: h.organizationId,
    handoffId: h.id,
    state: args.state,
    reason: args.reason,
    now: at,
  });
  await deps.store.appendEvent(tx, {
    orgId: h.organizationId,
    handoffId: h.id,
    type: args.eventType,
    actor: args.actor,
    itemCount: items.length,
    reasonCode: args.reason,
  });
  const unaccepted = unacceptedCount(states);
  if (args.unacceptedCause && unaccepted > 0) {
    await publishHandoffEvent(deps.outbox, tx, {
      kind: "unaccepted",
      orgId: h.organizationId,
      handoffId: h.id,
      fromUserId: h.fromUserId,
      toUserId: h.toUserId,
      cause: args.unacceptedCause,
      unacceptedItemCount: unaccepted,
      acceptedItemCount: states.filter((s) => s === "accepted").length,
      at,
    });
  }
  return closed;
}
