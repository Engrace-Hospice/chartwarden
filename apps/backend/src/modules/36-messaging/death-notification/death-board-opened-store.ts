// apps/backend/src/modules/36-messaging/death-notification/death-board-opened-store.ts - decorates the death-board store so that creating a NEW board
// publishes `m36.death_board.opened` in the SAME transaction (an event never announces a rolled-back board). A replay, or the second death event for
// the same patient, finds the board and publishes nothing. Ids and one instant only: no patient id. The board service itself is untouched.
import { DEATH_NOTIFICATION_EVENTS } from "@chartwarden/types";
import type { DeathBoardStore } from "../death-board/death-board-store";
import type { HintOutboxPort } from "../message-hint-events";

export const DEATH_BOARD_AGGREGATE_KIND = "death_board";

export function withBoardOpenedEvent(
  inner: DeathBoardStore,
  outbox: HintOutboxPort | undefined,
  now: () => Date = () => new Date(),
): DeathBoardStore {
  if (!outbox) return inner;
  return {
    ...inner,
    async createBoard(tx, a) {
      const result = await inner.createBoard(tx, a);
      if (result.created) {
        await outbox.publish(tx, {
          eventName: DEATH_NOTIFICATION_EVENTS.opened,
          organizationId: a.orgId,
          aggregateKind: DEATH_BOARD_AGGREGATE_KIND,
          aggregateId: result.boardId,
          payload: { organizationId: a.orgId, boardId: result.boardId, at: now().toISOString() },
        });
      }
      return result;
    },
  };
}
