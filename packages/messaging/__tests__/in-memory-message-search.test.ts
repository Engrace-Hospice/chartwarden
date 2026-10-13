/** WP 2.7a on the in-memory service: per-channel, member-only, current-body, live-only search. */
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
const send = (service: Service, channelId: string, body: string, authorUserId = "member") =>
  service.sendMessage(ORG, { channelId, authorUserId, body });
const search = (service: Service, query: string, extra: Record<string, unknown> = {}) =>
  service.searchMessages(ORG, { userId: "member", channelId: "ch_1", query, ...extra });

describe("in-memory service: searchMessages", () => {
  it("matches case-insensitively, newest first, and only inside the channel", async () => {
    const service = makeService();
    const a = await send(service, "ch_1", "Morphine dose changed");
    const b = await send(service, "ch_1", "morphine reviewed");
    await send(service, "ch_2", "morphine in the other channel");
    await send(service, "ch_1", "unrelated");
    const found = await search(service, "MORPHINE");
    expect(found.results.map((m) => m.messageId)).toEqual([b.messageId, a.messageId]);
  });

  it("never matches a deleted message and searches the edited body only", async () => {
    const service = makeService();
    const gone = await send(service, "ch_1", "secret plan");
    await service.deleteMessage(ORG, { userId: "member", messageId: gone.messageId });
    const edited = await send(service, "ch_1", "old wording");
    await service.editMessage(ORG, {
      userId: "member",
      messageId: edited.messageId,
      body: "new wording",
    });
    expect((await search(service, "secret")).results).toEqual([]);
    expect((await search(service, "old")).results).toEqual([]);
    expect((await search(service, "new wording")).results).toHaveLength(1);
  });

  it("filters by sender and date window", async () => {
    const service = makeService();
    await send(service, "ch_1", "visit note", "member");
    await send(service, "ch_1", "visit note", "other");
    const bySender = await search(service, "visit", { senderUserId: "other" });
    expect(bySender.results.map((m) => m.authorUserId)).toEqual(["other"]);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await search(service, "visit", { from: future })).results).toEqual([]);
  });

  it("answers a non-member and an unknown channel with the same 404", async () => {
    const service = makeService();
    await send(service, "ch_1", "hello there");
    const denied = service.searchMessages(ORG, {
      userId: "outsider",
      channelId: "ch_1",
      query: "hello",
    });
    const unknown = service.searchMessages(ORG, {
      userId: "outsider",
      channelId: "ch_nope",
      query: "hello",
    });
    await expect(denied).rejects.toMatchObject({ statusCode: 404 });
    await expect(unknown).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a too-short query with 422 and requires a query or a filter", async () => {
    const service = makeService();
    await expect(search(service, "a")).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      service.searchMessages(ORG, { userId: "member", channelId: "ch_1" }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("pages with a cursor and reports the scan", async () => {
    const service = makeService();
    for (let i = 0; i < 5; i += 1) await send(service, "ch_1", `needle ${i}`);
    const first = await search(service, "needle", { limit: 2 });
    expect(first.results).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await search(service, "needle", { limit: 10, cursor: first.nextCursor });
    expect(second.results).toHaveLength(3);
    expect(second.nextCursor).toBeUndefined();
    expect(second.scanCapped).toBe(false);
  });
});
