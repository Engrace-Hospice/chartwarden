// WP 3.10 - the in-memory send core honours the `inTransaction` hook like the database core: it runs once after the message
// exists, receives the new ids, and a throw removes the message again.
import { describe, expect, it } from "vitest";
import { createInMemoryMessagingService } from "../src/store/in-memory-service";

const ORG = "org_1";

function makeService() {
  return createInMemoryMessagingService({
    seed: {
      eligibleStaff: [{ orgId: ORG, userId: "member", displayName: "Member", roles: ["RN"] }],
      channels: [
        {
          channelId: "ch_1",
          orgId: ORG,
          kind: "location" as const,
          subjectId: "loc_1",
          members: [{ userId: "member" }],
        },
      ],
    },
  });
}

const input = { channelId: "ch_1", authorUserId: "member", body: "hi", bodyKind: "plain" as const };
const listIds = async (service: ReturnType<typeof makeService>) =>
  (await service.listMessages(ORG, { channelId: "ch_1", userId: "member" })).messages.map(
    (m) => m.messageId,
  );

describe("in-memory sendMessage inTransaction hook", () => {
  it("calls the hook once with the new message id", async () => {
    const service = makeService();
    const seen: string[] = [];
    const sent = await service.sendMessage(ORG, {
      ...input,
      inTransaction: async (_tx, s) => void seen.push(s.messageId),
    });
    expect(seen).toEqual([sent.messageId]);
  });

  it("rolls the message back when the hook throws", async () => {
    const service = makeService();
    await expect(
      service.sendMessage(ORG, {
        ...input,
        inTransaction: async () => {
          throw new Error("task store down");
        },
      }),
    ).rejects.toThrow("task store down");
    expect(await listIds(service)).toEqual([]);
  });
});
