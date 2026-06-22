// @wardenx/messaging — M36-T04 alert-outcome tests (spec §2.4.3).
import { describe, expect, it } from "vitest";
import { type DeliverySettlement, computeOutcome } from "../src/index";

const s = (
  recipientUserId: string,
  channel: DeliverySettlement["channel"],
  delivered: boolean,
): DeliverySettlement => ({ recipientUserId, channel, delivered });

describe("alert outcome roll-up (§2.4.3)", () => {
  it("delivered: every recipient got the in-app floor and nothing failed", () => {
    expect(
      computeOutcome([s("u-1", "in_app", true), s("u-2", "in_app", true), s("u-1", "push", true)]),
    ).toBe("delivered");
  });

  it("partial: some delivered, some failed/skipped", () => {
    expect(computeOutcome([s("u-1", "in_app", true), s("u-1", "sms", false)])).toBe("partial");
  });

  it("partial: a recipient missed even the floor while another was reached", () => {
    expect(computeOutcome([s("u-1", "in_app", true), s("u-2", "in_app", false)])).toBe("partial");
  });

  it("failed: no recipient reached on any channel (ops-paged, §2.6)", () => {
    expect(computeOutcome([s("u-1", "in_app", false), s("u-1", "sms", false)])).toBe("failed");
  });

  it("failed: an empty settlement set is nobody reached", () => {
    expect(computeOutcome([])).toBe("failed");
  });
});
