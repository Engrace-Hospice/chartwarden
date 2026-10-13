/**
 * WP 2.2 on the in-memory service (the dev/slice twin of the DB service): reply count and last reply on the channel
 * list, and the thread read, with the same channel scoping and the same 404 for a message that is not in the channel.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryMessagingService } from "../src/store/in-memory-service";

const ORG = "org_1";

function makeService() {
  return createInMemoryMessagingService({
    seed: {
      eligibleStaff: [{ orgId: ORG, userId: "member", displayName: "Member", roles: ["RN"] }],
      channels: ["ch_1", "ch_2"].map((channelId) => ({
        channelId,
        orgId: ORG,
        kind: "location" as const,
        subjectId: `loc_${channelId}`,
        members: [{ userId: "member" }],
      })),
    },
  });
}
type Service = ReturnType<typeof makeService>;
const send = (service: Service, channelId: string, body: string, parentMessageId?: string) =>
  service.sendMessage(ORG, { channelId, authorUserId: "member", body, parentMessageId });

describe("in-memory service: threads", () => {
  it("counts live direct replies on the channel list and omits deleted ones", async () => {
    const service = makeService();
    const root = await send(service, "ch_1", "root");
    const a = await send(service, "ch_1", "a", root.messageId);
    await send(service, "ch_1", "b", root.messageId);
    await service.deleteMessage(ORG, { userId: "member", messageId: a.messageId });
    const page = await service.listMessages(ORG, { channelId: "ch_1", userId: "member" });
    const found = page.messages.find((m) => m.messageId === root.messageId);
    expect(found?.replyCount).toBe(1);
    expect(found?.lastReplyAt).not.toBeNull();
    expect(page.messages.find((m) => m.messageId === a.messageId)?.replyCount).toBe(0);
  });

  it("reads the root and its replies oldest first, in pages without repeats", async () => {
    const service = makeService();
    const root = await send(service, "ch_1", "root");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await send(service, "ch_1", `r${i}`, root.messageId)).messageId);
    }
    await send(service, "ch_1", "other top-level");
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await service.listThread(ORG, {
        channelId: "ch_1",
        messageId: root.messageId,
        userId: "member",
        limit: 2,
        cursor,
      });
      expect(res.root.messageId).toBe(root.messageId);
      seen.push(...res.replies.map((r) => r.messageId));
      cursor = res.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ids);
  });

  it("a message of another channel, or a missing one, is the same NOT_FOUND", async () => {
    const service = makeService();
    const other = await send(service, "ch_2", "elsewhere");
    for (const messageId of [other.messageId, "msg_missing"]) {
      await expect(
        service.listThread(ORG, { channelId: "ch_1", messageId, userId: "member" }),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
  });

  it("clamps the page size to 1..200 like the DB service", async () => {
    const service = makeService();
    const root = await send(service, "ch_1", "root");
    for (let i = 0; i < 3; i++) await send(service, "ch_1", `r${i}`, root.messageId);
    const zero = await service.listThread(ORG, {
      channelId: "ch_1",
      messageId: root.messageId,
      userId: "member",
      limit: 0,
    });
    expect(zero.replies).toHaveLength(1);
    expect(zero.nextCursor).toBeTruthy();
    const huge = await service.listThread(ORG, {
      channelId: "ch_1",
      messageId: root.messageId,
      userId: "member",
      limit: 100000,
    });
    expect(huge.replies).toHaveLength(3);
  });

  it("refuses a reply to a reply (422), allows replying to the root and quoting is untouched", async () => {
    const service = makeService();
    const root = await send(service, "ch_1", "root");
    const reply = await send(service, "ch_1", "reply", root.messageId);
    await expect(send(service, "ch_1", "nested", reply.messageId)).rejects.toMatchObject({
      code: "PARENT_MESSAGE_IS_REPLY",
      statusCode: 422,
    });
    await expect(send(service, "ch_1", "again", root.messageId)).resolves.toBeTruthy();
  });
});
