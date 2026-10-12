/**
 * The in-memory service must apply the same edit/delete/mark-read access rule as the DB service
 * (messaging-route-service-db.ts `assertMessageChannelAccess`): the author needs live channel access.
 * An archived channel is seeded with a pre-existing message (sendMessage refuses archived channels).
 */
import { describe, expect, it } from "vitest";
import { createInMemoryMessagingService } from "../src/store/in-memory-service";

const ORG = "org_1";
const OTHER_ORG = "org_2";
const CHANNEL = "ch_1";

function makeService() {
  return createInMemoryMessagingService({
    seed: {
      eligibleStaff: [
        { orgId: ORG, userId: "member", displayName: "Member", roles: ["RN"] },
        { orgId: ORG, userId: "peer", displayName: "Peer", roles: ["RN"] },
        { orgId: ORG, userId: "former", displayName: "Former", roles: ["RN"] },
        {
          orgId: ORG,
          userId: "suspended",
          displayName: "Suspended",
          roles: ["RN"],
          status: "suspended",
        },
      ],
      channels: [
        {
          channelId: CHANNEL,
          orgId: ORG,
          kind: "location",
          subjectId: "loc_1",
          members: [{ userId: "member" }, { userId: "peer" }, { userId: "suspended" }],
        },
      ],
    },
  });
}

async function sendAs(service: ReturnType<typeof makeService>, authorUserId: string) {
  return service.sendMessage(ORG, {
    channelId: CHANNEL,
    authorUserId,
    body: `from ${authorUserId}`,
    bodyKind: "plain",
  });
}

describe("in-memory service: message access for edit/delete/mark-read", () => {
  it("lets a current member edit, mark-read and delete their own message", async () => {
    const service = makeService();
    const { messageId } = await sendAs(service, "member");
    await expect(
      service.editMessage(ORG, { userId: "member", messageId, body: "fixed" }),
    ).resolves.toMatchObject({ messageId });
    await expect(service.markRead(ORG, { userId: "member", messageId })).resolves.not.toThrow();
    await expect(
      service.deleteMessage(ORG, { userId: "member", messageId }),
    ).resolves.not.toThrow();
  });

  it("returns 403 for a channel member who is not the author", async () => {
    const service = makeService();
    const { messageId } = await sendAs(service, "member");
    await expect(
      service.editMessage(ORG, { userId: "peer", messageId, body: "tampered" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.deleteMessage(ORG, { userId: "peer", messageId })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("returns 404 for an author who is not (or no longer) a channel member", async () => {
    const service = makeService();
    const { messageId } = await sendAs(service, "former");
    await expect(
      service.editMessage(ORG, { userId: "former", messageId, body: "sneaky" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.deleteMessage(ORG, { userId: "former", messageId })).rejects.toMatchObject(
      {
        statusCode: 404,
      },
    );
    await expect(service.markRead(ORG, { userId: "former", messageId })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("returns 404 for a suspended member even though they are still on the channel roster", async () => {
    const service = makeService();
    const { messageId } = await sendAs(service, "suspended");
    await expect(
      service.deleteMessage(ORG, { userId: "suspended", messageId }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("returns 404 for an unknown message and for another tenant's message", async () => {
    const service = makeService();
    const { messageId } = await sendAs(service, "member");
    await expect(
      service.editMessage(ORG, { userId: "member", messageId: "msg_missing", body: "x" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.deleteMessage(OTHER_ORG, { userId: "member", messageId }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns 410 on edit/delete in an archived channel but still lets a member mark-read", async () => {
    const service = createInMemoryMessagingService({
      seed: {
        eligibleStaff: [{ orgId: ORG, userId: "member", displayName: "Member", roles: ["RN"] }],
        channels: [
          {
            channelId: "ch_old",
            orgId: ORG,
            kind: "location",
            subjectId: "loc_2",
            archivedAt: "2026-01-01T00:00:00.000Z",
            members: [{ userId: "member" }],
          },
        ],
        messages: [
          { messageId: "msg_old", channelId: "ch_old", orgId: ORG, authorUserId: "member" },
        ],
      },
    });
    const input = { userId: "member", messageId: "msg_old" };
    await expect(service.editMessage(ORG, { ...input, body: "late" })).rejects.toMatchObject({
      statusCode: 410,
    });
    await expect(service.deleteMessage(ORG, input)).rejects.toMatchObject({ statusCode: 410 });
    await expect(service.markRead(ORG, input)).resolves.not.toThrow();
  });
});
