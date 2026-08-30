// @wardenx/messaging — M36-T04 alert-outcome tests (spec §2.4.3).
import { describe, expect, it } from "vitest";
import {
  type DeliveryRollupRow,
  type DeliverySettlement,
  computeOutcome,
  isTerminalDeliveryStatus,
  rollUpAlertOutcome,
} from "../src/index";

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

// ── F-109: the live-delivery-set roll-up ─────────────────────────────────────────────────────────────

const d = (
  recipientUserId: string,
  channel: DeliveryRollupRow["channel"],
  status: DeliveryRollupRow["status"],
): DeliveryRollupRow => ({ recipientUserId, channel, status });

describe("rollUpAlertOutcome (§2.4.3 over a live delivery set, F-109)", () => {
  it("pending while ANY row is still in flight", () => {
    expect(
      rollUpAlertOutcome([d("u-1", "in_app", "delivered"), d("u-2", "in_app", "pending")]),
    ).toBe("pending");
    // `sent` is the dispatcher-accepted step, not an ack — still in flight.
    expect(rollUpAlertOutcome([d("u-1", "in_app", "sent")])).toBe("pending");
  });

  it("failed on an EMPTY set — the no-op alert `emit()` writes when no rule fires", () => {
    // This is the case the old `alert.outcome NOT NULL DEFAULT 'delivered'` was most wrong about.
    expect(rollUpAlertOutcome([])).toBe("failed");
  });

  it("delivered once every recipient's in-app floor is acked and nothing else is outstanding", () => {
    expect(
      rollUpAlertOutcome([d("u-1", "in_app", "delivered"), d("u-2", "in_app", "delivered")]),
    ).toBe("delivered");
  });

  it("partial when a terminal row did not reach its recipient", () => {
    expect(
      rollUpAlertOutcome([d("u-1", "in_app", "delivered"), d("u-1", "sms", "skipped_quiet_hours")]),
    ).toBe("partial");
    expect(rollUpAlertOutcome([d("u-1", "in_app", "delivered"), d("u-1", "email", "failed")])).toBe(
      "partial",
    );
  });

  it("failed when every terminal row missed", () => {
    expect(rollUpAlertOutcome([d("u-1", "in_app", "failed")])).toBe("failed");
  });

  it("terminality is the whole difference — pending/sent are the only non-terminal states", () => {
    expect(
      (["delivered", "failed", "skipped_quiet_hours", "forwarded"] as const).every(
        isTerminalDeliveryStatus,
      ),
    ).toBe(true);
    expect((["pending", "sent"] as const).some(isTerminalDeliveryStatus)).toBe(false);
  });
});
