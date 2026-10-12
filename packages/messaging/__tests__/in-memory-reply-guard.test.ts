/**
 * The in-memory service applies the DB service's reply guard (audit F5 / WP 1.7, messaging-write-core): a reply's
 * parent must be a message in the SAME channel; a missing or other-channel parent is one answer, 422.
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

const send = (
  service: ReturnType<typeof makeService>,
  channelId: string,
  parentMessageId?: string,
) =>
  service.sendMessage(ORG, {
    channelId,
    authorUserId: "member",
    body: "hi",
    bodyKind: "plain",
    parentMessageId,
  });

describe("in-memory service: reply parent must be in the same channel", () => {
  it("accepts a same-channel parent", async () => {
    const service = makeService();
    const parent = await send(service, "ch_1");
    await expect(send(service, "ch_1", parent.messageId)).resolves.toMatchObject({
      channelId: "ch_1",
    });
  });

  it("refuses an other-channel parent and a missing parent with the same typed 422", async () => {
    const service = makeService();
    const other = await send(service, "ch_2");
    for (const parentId of [other.messageId, "msg_missing"]) {
      await expect(send(service, "ch_1", parentId)).rejects.toMatchObject({
        statusCode: 422,
        code: "PARENT_MESSAGE_NOT_IN_CHANNEL",
      });
    }
  });
});
