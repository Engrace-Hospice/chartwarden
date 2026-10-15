// WP 4.1 - the limiter's replay test is the stored recipient, compared case-insensitively; nothing stored is not a replay.
import { describe, expect, it } from "vitest";
import { buildUrgentBinding } from "./binding";

const q = {
  organizationId: "o",
  userId: "u",
  channelId: "c",
  clientMessageId: "m",
  recipientUserId: "AAAA",
};
const make = (stored: string | null | "throw") =>
  buildUrgentBinding({
    messaging: { canViewChannel: async () => true, sendMessage: (async () => ({})) as never },
    channelFacts: async () => null,
    displayName: async () => null,
    eligibility: {} as never,
    findReplayRecipient: async () => {
      if (stored === "throw") throw new Error("db");
      return stored;
    },
  }).isReplay;

describe("isReplay", () => {
  it("is true only when the stored recipient is the requested one", async () => {
    expect(await make("aaaa")(q)).toBe(true);
    expect(await make("bbbb")(q)).toBe(false);
    expect(await make(null)(q)).toBe(false);
  });
  it("propagates a lookup failure so the limiter can treat it as not a replay", async () => {
    await expect(make("throw")(q)).rejects.toThrow();
  });
});
