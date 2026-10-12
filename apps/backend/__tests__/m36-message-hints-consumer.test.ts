import { describe, expect, it, vi } from "vitest";
import { buildM36MessageHintConsumer } from "../src/modules/36-messaging/outbox-consumers/message-hints";

const ORG = "org_1";
const event = (eventType: string, payload: unknown) => ({
  id: "evt_1",
  organizationId: ORG,
  eventType,
  aggregateKind: "message",
  aggregateId: "msg_1",
  payload,
  attemptCount: 0,
  createdAt: new Date(),
});
const payload = {
  organizationId: "evil",
  channelId: "ch_1",
  messageId: "msg_1",
  at: "2026-10-12T10:00:00.000Z",
};

describe("m36.message-hints", () => {
  it("sends one PHI-free hint to each current member's user room", async () => {
    const emitToRooms = vi.fn().mockResolvedValue(undefined);
    const audience = vi.fn().mockResolvedValue({ userIds: ["u1", "u2"] });
    await buildM36MessageHintConsumer({ audience, emitToRooms }).handle(
      event("m36.message.sent", payload),
    );
    expect(audience).toHaveBeenCalledWith(ORG, "ch_1"); // tenant from the envelope, not the payload
    const [rooms, hint] = emitToRooms.mock.calls[0]!;
    expect(rooms).toEqual(["user:u1", "user:u2"]);
    expect(hint).toMatchObject({
      kind: "message.new",
      ids: { channelId: "ch_1", messageId: "msg_1" },
    });
    expect(Object.keys(hint).sort()).toEqual(["cursor", "ids", "kind"]);
  });

  it("an announcement channel goes to the org room", async () => {
    const emitToRooms = vi.fn().mockResolvedValue(undefined);
    await buildM36MessageHintConsumer({
      audience: async () => ({ orgWide: true }),
      emitToRooms,
    }).handle(event("m36.message.deleted", payload));
    expect(emitToRooms.mock.calls[0]![0]).toEqual([`org:${ORG}`]);
  });

  it("an empty audience emits nothing; no transport wired is an acknowledged no-op", async () => {
    const emitToRooms = vi.fn();
    await buildM36MessageHintConsumer({
      audience: async () => ({ userIds: [] }),
      emitToRooms,
    }).handle(event("m36.message.edited", payload));
    expect(emitToRooms).not.toHaveBeenCalled();
    const audience = vi.fn();
    await buildM36MessageHintConsumer({ audience }).handle(event("m36.message.sent", payload));
    expect(audience).not.toHaveBeenCalled();
  });

  it("a malformed payload or foreign event fails loudly", async () => {
    const c = buildM36MessageHintConsumer({
      audience: async () => ({ userIds: [] }),
      emitToRooms: vi.fn(),
    });
    await expect(c.handle(event("m36.message.sent", { channelId: "c" }))).rejects.toThrow(
      /no messageId/,
    );
    await expect(c.handle(event("m36.message.mentioned", payload))).rejects.toThrow(
      /unexpected event/,
    );
  });
});
