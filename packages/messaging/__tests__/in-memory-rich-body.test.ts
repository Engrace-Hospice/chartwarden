/**
 * WP 2.1 / S6: the in-memory service sanitises a structured body itself, like the DB service, so a caller that
 * skips the route cannot store an unsafe document.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryMessagingService } from "../src/store/in-memory-service";

const ORG = "org_1";
const service = () =>
  createInMemoryMessagingService({
    seed: {
      eligibleStaff: [{ orgId: ORG, userId: "member", displayName: "Member", roles: ["RN"] }],
      channels: [
        {
          channelId: "ch_1",
          orgId: ORG,
          kind: "location" as const,
          subjectId: "loc",
          members: [{ userId: "member" }],
        },
      ],
    },
  });
const doc = (...marks: unknown[]) => ({
  schemaVersion: 1 as const,
  doc: {
    type: "doc" as const,
    content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks }] }],
  },
});
const send = (svc: ReturnType<typeof service>, richBody: unknown) =>
  svc.sendMessage(ORG, {
    channelId: "ch_1",
    authorUserId: "member",
    body: "x",
    richBody: richBody as never,
  });

describe("in-memory service sanitises richBody", () => {
  it("accepts a clean document", async () => {
    await expect(send(service(), doc({ type: "bold" }))).resolves.toMatchObject({
      channelId: "ch_1",
    });
  });
  it("rejects an unsafe link target with INVALID_RICH_BODY", async () => {
    await expect(
      send(service(), doc({ type: "link", href: "javascript:1" })),
    ).rejects.toMatchObject({ code: "INVALID_RICH_BODY", statusCode: 422 });
  });
  it("stores the sanitised copy, not the caller's object", async () => {
    const svc = service();
    const input = doc({ type: "bold" });
    await send(svc, input);
    const page = await svc.listMessages(ORG, { userId: "member", channelId: "ch_1" });
    expect(page.messages[0]?.bodyDoc).toEqual(input);
    expect(page.messages[0]?.bodyDoc).not.toBe(input);
  });
});
