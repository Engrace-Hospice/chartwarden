import { describe, expect, it } from "vitest";
import { createInMemoryMessagingService } from "../src/store/in-memory-service";

const orgId = "org-1";
const service = () =>
  createInMemoryMessagingService({
    seed: {
      eligibleStaff: ["owner", "peer-a", "peer-b"].map((userId) => ({
        orgId,
        userId,
        displayName: userId,
        roles: ["rn"],
      })),
    },
  });

describe("context-free staff groups", () => {
  it("creates a care conversation visible to every selected member", async () => {
    const messaging = service();
    const group = await messaging.createGroup(orgId, "owner", {
      title: "Weekend team",
      userIds: ["peer-a", "peer-b"],
    });
    const detail = await messaging.getChannel(orgId, "peer-a", group.channelId);
    expect(detail).toMatchObject({ kind: "group", title: "Weekend team", subjectId: null });
    expect(detail.members.map((member) => member.userId).sort()).toEqual([
      "owner",
      "peer-a",
      "peer-b",
    ]);
    const sent = await messaging.sendMessage(orgId, {
      channelId: group.channelId,
      authorUserId: "peer-a",
      body: "Ready",
    });
    const history = await messaging.listMessages(orgId, {
      channelId: group.channelId,
      userId: "peer-b",
    });
    expect(history.messages.map((message) => message.messageId)).toContain(sent.messageId);
  });

  it("rejects a group with fewer than three people or an ineligible peer", async () => {
    const messaging = service();
    await expect(
      messaging.createGroup(orgId, "owner", { title: "Small", userIds: ["peer-a"] }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      messaging.createGroup(orgId, "owner", { title: "Unknown", userIds: ["peer-a", "missing"] }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
