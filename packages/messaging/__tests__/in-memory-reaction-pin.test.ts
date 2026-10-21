/**
 * WP 2.4 on the in-memory service (the dev/slice twin of the DB service): reactions and pins share the channel's
 * access rule, are idempotent, never touch read/ack state, and surface on the message reads.
 */
import { MAX_PINS_PER_CHANNEL } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { createInMemoryMessagingService } from "../src/store/in-memory-service";

const ORG = "org_1";

function makeService() {
  return createInMemoryMessagingService({
    seed: {
      eligibleStaff: ["member", "other", "outsider"].map((userId) => ({
        orgId: ORG,
        userId,
        displayName: userId,
        roles: ["RN"],
      })),
      channels: ["ch_1", "ch_2"].map((channelId) => ({
        channelId,
        orgId: ORG,
        kind: "location" as const,
        subjectId: `loc_${channelId}`,
        members: [{ userId: "member" }, { userId: "other" }],
      })),
    },
  });
}
type Service = ReturnType<typeof makeService>;
const send = (service: Service, channelId: string, body = "hello") =>
  service.sendMessage(ORG, { channelId, authorUserId: "member", body });
const react = (
  service: Service,
  userId: string,
  channelId: string,
  messageId: string,
  emoji = "heart",
) =>
  service.setReaction(ORG, { userId, channelId, messageId, emoji: emoji as never, present: true });
const unreact = (
  service: Service,
  userId: string,
  channelId: string,
  messageId: string,
  emoji = "heart",
) =>
  service.setReaction(ORG, { userId, channelId, messageId, emoji: emoji as never, present: false });
const page = async (service: Service, userId: string, channelId = "ch_1") =>
  (await service.listMessages(ORG, { channelId, userId })).messages;

describe("in-memory service: reactions", () => {
  it("counts per emoji, flags the viewer's own, and is idempotent", async () => {
    const service = makeService();
    const m = await send(service, "ch_1");
    await react(service, "member", "ch_1", m.messageId);
    await react(service, "member", "ch_1", m.messageId);
    const result = await react(service, "other", "ch_1", m.messageId);
    expect(result.reactions).toEqual([{ emoji: "heart", count: 2, reactedByMe: true }]);
    const mine = (await page(service, "member"))[0]!;
    expect(mine.reactions).toEqual([{ emoji: "heart", count: 2, reactedByMe: true }]);
    await unreact(service, "other", "ch_1", m.messageId);
    await unreact(service, "other", "ch_1", m.messageId);
    expect((await page(service, "other"))[0]!.reactions).toEqual([
      { emoji: "heart", count: 1, reactedByMe: false },
    ]);
  });

  it("answers a non-member, an unknown message and a message of another channel with the same 404", async () => {
    const service = makeService();
    const m = await send(service, "ch_1");
    const other = await send(service, "ch_2");
    const attempts = [
      react(service, "outsider", "ch_1", m.messageId),
      react(service, "member", "ch_1", "msg_unknown"),
      react(service, "member", "ch_1", other.messageId),
    ];
    for (const attempt of attempts)
      await expect(attempt).rejects.toMatchObject({ statusCode: 404 });
  });

  it("refuses a reaction on a deleted message and in an archived channel, and an unknown emoji", async () => {
    const service = makeService();
    const m = await send(service, "ch_1");
    await expect(
      react(service, "member", "ch_1", m.messageId, "thumbs_down"),
    ).rejects.toMatchObject({
      statusCode: 422,
    });
    await service.deleteMessage(ORG, { userId: "member", messageId: m.messageId });
    await expect(react(service, "other", "ch_1", m.messageId)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("refuses a reaction or a pin in an archived channel with 410", async () => {
    const archived = createInMemoryMessagingService({
      seed: {
        eligibleStaff: [{ orgId: ORG, userId: "member", displayName: "member", roles: ["RN"] }],
        channels: [
          {
            channelId: "ch_a",
            orgId: ORG,
            kind: "location" as const,
            subjectId: "loc",
            archivedAt: "2026-01-01T00:00:00.000Z",
            members: [{ userId: "member" }],
          },
        ],
        messages: [{ messageId: "m1", channelId: "ch_a", orgId: ORG, authorUserId: "member" }],
      },
    });
    const input = { userId: "member", channelId: "ch_a", messageId: "m1" };
    await expect(
      archived.setReaction(ORG, { ...input, emoji: "heart", present: true }),
    ).rejects.toMatchObject({ statusCode: 410 });
    await expect(archived.pinMessage(ORG, input)).rejects.toMatchObject({ statusCode: 410 });
    await expect(archived.unpinMessage(ORG, input)).rejects.toMatchObject({ statusCode: 410 });
  });

  it("never marks anything read or acknowledged", async () => {
    const service = makeService();
    const m = await send(service, "ch_1");
    const before = await service.listChannels(ORG, "other");
    await react(service, "other", "ch_1", m.messageId);
    expect(await service.listChannels(ORG, "other")).toEqual(before);
  });
});

describe("in-memory service: pins", () => {
  it("pins and unpins idempotently and lists newest pin first", async () => {
    const service = makeService();
    const a = await send(service, "ch_1", "a");
    const b = await send(service, "ch_1", "b");
    await service.pinMessage(ORG, { userId: "member", channelId: "ch_1", messageId: a.messageId });
    await service.pinMessage(ORG, { userId: "other", channelId: "ch_1", messageId: a.messageId });
    await service.pinMessage(ORG, { userId: "other", channelId: "ch_1", messageId: b.messageId });
    const listed = await service.listPins(ORG, { userId: "member", channelId: "ch_1" });
    expect(listed.pins.map((p) => p.body)).toEqual(["b", "a"]);
    expect((await page(service, "member")).every((m) => m.pinned === true)).toBe(true);
    await service.unpinMessage(ORG, {
      userId: "member",
      channelId: "ch_1",
      messageId: a.messageId,
    });
    await service.unpinMessage(ORG, {
      userId: "member",
      channelId: "ch_1",
      messageId: a.messageId,
    });
    expect(
      (await service.listPins(ORG, { userId: "member", channelId: "ch_1" })).pins,
    ).toHaveLength(1);
  });

  it("caps pins per channel and gives a non-member the 404 of a random id", async () => {
    const service = makeService();
    for (let i = 0; i < MAX_PINS_PER_CHANNEL; i++) {
      const m = await send(service, "ch_1", `m${i}`);
      await service.pinMessage(ORG, {
        userId: "member",
        channelId: "ch_1",
        messageId: m.messageId,
      });
    }
    const extra = await send(service, "ch_1", "extra");
    await expect(
      service.pinMessage(ORG, { userId: "member", channelId: "ch_1", messageId: extra.messageId }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      service.pinMessage(ORG, {
        userId: "outsider",
        channelId: "ch_1",
        messageId: extra.messageId,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.listPins(ORG, { userId: "outsider", channelId: "ch_1" }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("drops a deleted message from the pin list", async () => {
    const service = makeService();
    const a = await send(service, "ch_1", "a");
    await service.pinMessage(ORG, { userId: "member", channelId: "ch_1", messageId: a.messageId });
    await service.deleteMessage(ORG, { userId: "member", messageId: a.messageId });
    expect((await service.listPins(ORG, { userId: "member", channelId: "ch_1" })).pins).toEqual([]);
  });
});
