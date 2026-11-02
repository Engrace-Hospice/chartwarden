import { describe, expect, it, vi } from "vitest";
import { createMemoryDeathBoardStore } from "../death-board/death-board-store-memory";
import { withBoardOpenedEvent } from "../death-notification/death-board-opened-store";
import {
  M36_DEATH_NOTIFICATIONS_CONSUMER,
  buildM36DeathNotificationsConsumer,
} from "./death-notifications";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const P1 = "00000000-0000-4000-8000-0000000000e1";
const board = { orgId: ORG, patientId: P1, templateVersion: 1, items: [] };

describe("withBoardOpenedEvent", () => {
  it("publishes once for a new board and nothing for the second death event or a replay", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const store = withBoardOpenedEvent(createMemoryDeathBoardStore(() => new Date()), { publish });
    const first = await store.createBoard({} as never, board);
    const second = await store.createBoard({} as never, board);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(publish).toHaveBeenCalledTimes(1);
    const emission = publish.mock.calls[0]![1];
    expect(emission.eventName).toBe("m36.death_board.opened");
    expect(emission.aggregateId).toBe(first.boardId);
    expect(JSON.stringify(emission.payload)).not.toContain(P1);
  });
});

describe("M36 death-notifications consumer", () => {
  it("subscribes to the opened event under its own name", () => {
    const c = buildM36DeathNotificationsConsumer({ service: { fanOutInternal: vi.fn() } });
    expect(c.consumerName).toBe(M36_DEATH_NOTIFICATIONS_CONSUMER);
    expect([...c.eventTypes]).toEqual(["m36.death_board.opened"]);
  });

  it("takes the tenant from the envelope, never the payload", async () => {
    const fanOutInternal = vi.fn().mockResolvedValue({ notified: 6 });
    const c = buildM36DeathNotificationsConsumer({ service: { fanOutInternal } });
    await c.handle({
      id: "evt-1",
      eventType: "m36.death_board.opened",
      organizationId: ORG,
      payload: { organizationId: "attacker", boardId: "b-1" },
    } as never);
    expect(fanOutInternal).toHaveBeenCalledWith(ORG, "b-1", "evt-1");
  });

  it("throws on a malformed payload so the relay retries", async () => {
    const c = buildM36DeathNotificationsConsumer({ service: { fanOutInternal: vi.fn() } });
    await expect(
      c.handle({ id: "e", eventType: "m36.death_board.opened", organizationId: ORG, payload: {} } as never),
    ).rejects.toThrow(/boardId/);
  });
});
