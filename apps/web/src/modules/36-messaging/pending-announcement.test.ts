import { describe, expect, it } from "vitest";
import { initialAnnouncement, nextAnnouncement } from "./pending-announcement";
import type { OutboxItem } from "./use-outbox";

const item = (localId: string, extra: Partial<OutboxItem> = {}): OutboxItem =>
  ({ localId, channelId: "A", status: "not_sent", ...extra }) as OutboxItem;

describe("nextAnnouncement", () => {
  it("keeps both a delivery and a new failure that land in the same render", () => {
    const before = initialAnnouncement("A", [item("m1"), item("m2")], 0);

    const after = nextAnnouncement(
      before,
      [item("m2", { error: "Server hiccup", failCount: 1 })],
      1,
    );

    expect(after.text).toBe(
      "Message sent (1 waiting). Retry failed for message 1 of 1, attempt 1: Server hiccup",
    );
  });

  it("names the message in a permanent refusal", () => {
    const before = initialAnnouncement("A", [item("m1"), item("m2")], 0);

    const after = nextAnnouncement(
      before,
      [item("m1"), item("m2", { error: "No", failCount: 1, permanent: true })],
      0,
    );

    expect(after.text).toBe("Not sent, message 2 of 2: No");
  });
});
