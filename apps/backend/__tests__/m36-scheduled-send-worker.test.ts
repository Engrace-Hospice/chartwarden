// WP 2.6 - the scheduled-send tick fans out over active orgs, never lets one org's failure stop the others, and FAILS
// (so the failure is visible in the failed set / DLQ alert) when any org failed.
import { MESSAGING_QUEUES } from "@wardenx/messaging";
import { describe, expect, it, vi } from "vitest";
import { scheduledSendTick } from "../src/modules/36-messaging/scheduled/scheduled-send-worker";

const orgs = ["org_a", "org_b", "org_c"].map((organizationId) => ({ organizationId }));

describe("scheduledSendTick", () => {
  it("dispatches every active org and sums the results", async () => {
    const dispatchDueForOrg = vi.fn(async (_org: string) => ({ sent: 2, blocked: 1, failed: 0 }));
    const result = await scheduledSendTick({
      activeOrgs: { listActiveOrgs: async () => orgs },
      dispatcher: { dispatchDueForOrg },
    });
    expect(dispatchDueForOrg.mock.calls.map((c) => c[0])).toEqual(["org_a", "org_b", "org_c"]);
    expect(result).toEqual({ sent: 6, blocked: 3, failed: 0 });
  });

  it("keeps going past a failing org, reports it, then fails the tick", async () => {
    const onError = vi.fn();
    const dispatchDueForOrg = vi.fn(async (org: string) => {
      if (org === "org_b") throw new Error("db down");
      return { sent: 1, blocked: 0, failed: 0 };
    });
    await expect(
      scheduledSendTick({
        activeOrgs: { listActiveOrgs: async () => orgs },
        dispatcher: { dispatchDueForOrg },
        onError,
      }),
    ).rejects.toThrow(/scheduled_send failed for 1 of 3 org/);
    expect(dispatchDueForOrg).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledWith(
      { organizationId: "org_b", job: "scheduled_send" },
      expect.any(Error),
    );
  });

  it("uses the catalogued queue name", () => {
    expect(MESSAGING_QUEUES.scheduledSend).toBe("messaging.scheduled_send");
  });
});
