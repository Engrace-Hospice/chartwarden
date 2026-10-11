import type { AlertEmitter } from "@wardenx/messaging";
import { describe, expect, it, vi } from "vitest";
import { buildM36MessageMentionConsumer } from "./message-mentions";

const ORG = "11111111-1111-4111-8111-111111111111";
const event = (overrides: Record<string, unknown> = {}) =>
  ({
    eventType: "m36.message.mentioned",
    organizationId: ORG,
    payload: {
      organizationId: "attacker-copy-is-ignored",
      channelId: "channel-1",
      messageId: "message-1",
      mentionedUserId: "user-2",
      actorUserId: "user-1",
      ...overrides,
    },
  }) as never;

describe("M36 structured mention consumer", () => {
  it("emits one PHI-minimal in-app alert after current access is revalidated", async () => {
    const emit = vi.fn().mockResolvedValue({ alertId: "alert-1", resolvedRecipientCount: 1 });
    const canViewChannel = vi.fn().mockResolvedValue(true);
    const consumer = buildM36MessageMentionConsumer({
      alerts: { emit } as unknown as AlertEmitter,
      messaging: { canViewChannel },
    });

    await consumer.handle(event());

    expect(canViewChannel).toHaveBeenCalledWith(ORG, "user-2", "channel-1");
    expect(emit).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        eventType: "m36.message.mentioned",
        correlationId: "message-mention:message-1:user-2",
        payload: expect.objectContaining({
          mentionedUserId: "user-2",
          deepLink: "/messaging?channelId=channel-1&messageId=message-1",
        }),
      }),
    );
    expect(JSON.stringify(emit.mock.calls)).not.toContain("body");
  });

  it("fails closed when membership or clinical access was revoked", async () => {
    const emit = vi.fn();
    const consumer = buildM36MessageMentionConsumer({
      alerts: { emit } as unknown as AlertEmitter,
      messaging: { canViewChannel: vi.fn().mockResolvedValue(false) },
    });
    await consumer.handle(event());
    expect(emit).not.toHaveBeenCalled();
  });

  it("does not notify the author for a self-reference", async () => {
    const emit = vi.fn();
    const canViewChannel = vi.fn();
    const consumer = buildM36MessageMentionConsumer({
      alerts: { emit } as unknown as AlertEmitter,
      messaging: { canViewChannel },
    });
    await consumer.handle(event({ mentionedUserId: "user-1" }));
    expect(canViewChannel).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
