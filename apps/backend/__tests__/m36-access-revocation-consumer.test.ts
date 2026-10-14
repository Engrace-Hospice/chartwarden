import { describe, expect, it, vi } from "vitest";
import {
  buildM36AccessRevocationConsumer,
  buildM36AccessRevocationPlatformConsumer,
} from "../src/modules/36-messaging/outbox-consumers/access-revocation";

const ORG = "org_1";
const event = (eventType: string, payload: unknown) => ({
  id: "evt_1",
  organizationId: ORG,
  eventType,
  aggregateKind: "membership",
  aggregateId: "mem_1",
  payload,
  attemptCount: 0,
  createdAt: new Date(),
});

function setup() {
  const endChannelMemberships = vi.fn().mockResolvedValue(1);
  const disconnectUser = vi.fn().mockResolvedValue(undefined);
  const disconnectAccount = vi.fn().mockResolvedValue(undefined);
  return {
    endChannelMemberships,
    disconnectUser,
    disconnectAccount,
    consumer: buildM36AccessRevocationConsumer({
      endChannelMemberships,
      disconnectUser,
      disconnectAccount,
    }),
  };
}

describe("m36.access-revocation", () => {
  it("revoked: ends the user's channel memberships in the envelope org and drops sockets", async () => {
    const t = setup();
    await t.consumer.handle(
      event("m2.membership.revoked", {
        membershipId: "mem_1",
        organizationId: "evil",
        userId: "u1",
      }),
    );
    expect(t.endChannelMemberships).toHaveBeenCalledWith(ORG, "u1");
    expect(t.disconnectUser).toHaveBeenCalledWith(ORG, "u1");
  });

  it("suspended: drops sockets but keeps membership rows", async () => {
    const t = setup();
    await t.consumer.handle(
      event("m2.membership.suspended", { userId: "u1", from: "active", to: "suspended" }),
    );
    expect(t.disconnectUser).toHaveBeenCalledWith(ORG, "u1");
    expect(t.endChannelMemberships).not.toHaveBeenCalled();
  });

  it("revoked/suspended rows published before the userId field are a no-op, not a failure", async () => {
    const t = setup();
    await t.consumer.handle(event("m2.membership.revoked", { membershipId: "mem_1" }));
    await t.consumer.handle(
      event("m2.membership.suspended", { membershipId: "mem_1", to: "suspended" }),
    );
    expect(t.endChannelMemberships).not.toHaveBeenCalled();
    expect(t.disconnectUser).not.toHaveBeenCalled();
  });

  it("org-bound deactivation ends memberships and drops sockets; a missing userId fails loudly", async () => {
    const t = setup();
    await t.consumer.handle(event("m2.user.deactivated", { userId: "u2", reason: "left" }));
    expect(t.endChannelMemberships).toHaveBeenCalledWith(ORG, "u2");
    expect(t.disconnectUser).toHaveBeenCalledWith(ORG, "u2");
    await expect(t.consumer.handle(event("m2.user.deactivated", { reason: "x" }))).rejects.toThrow(
      /no userId/,
    );
  });

  it("works while realtime is not wired (membership ending only)", async () => {
    const endChannelMemberships = vi.fn().mockResolvedValue(0);
    const c = buildM36AccessRevocationConsumer({ endChannelMemberships });
    await expect(
      c.handle(event("m2.membership.revoked", { userId: "u1" })),
    ).resolves.toBeUndefined();
    expect(endChannelMemberships).toHaveBeenCalledOnce();
  });

  it("an unexpected event type throws (visible failure)", async () => {
    await expect(setup().consumer.handle(event("m2.something.else", {}))).rejects.toThrow(
      /unexpected event/,
    );
  });

  it("platform-scoped deactivation published under the operator's org drops every socket of the account", async () => {
    const t = setup();
    await t.consumer.handle(
      event("m2.user.deactivated", { userId: "u9", reason: "x", scope: "platform" }),
    );
    expect(t.disconnectAccount).toHaveBeenCalledWith("u9");
    expect(t.disconnectUser).not.toHaveBeenCalled(); // the operator's org room is the wrong room
  });

  it("platform deactivation drops sockets by user, with no org", async () => {
    const disconnectAccount = vi.fn().mockResolvedValue(undefined);
    const c = buildM36AccessRevocationPlatformConsumer({ disconnectAccount });
    await c.handle({
      id: "e",
      eventType: "m2.user.deactivated",
      aggregateKind: "user",
      aggregateId: "u3",
      payload: { userId: "u3", reason: "x", scope: "platform" },
      attemptCount: 0,
      createdAt: new Date(),
    });
    expect(disconnectAccount).toHaveBeenCalledWith("u3");
  });

  it("a socket-drop failure rejects so the dispatcher retries; the retry re-ends memberships idempotently", async () => {
    const endChannelMemberships = vi.fn().mockResolvedValue(0);
    const disconnectUser = vi
      .fn()
      .mockRejectedValueOnce(new Error("realtime emitter not ready (reconnecting)"))
      .mockResolvedValue(undefined);
    const c = buildM36AccessRevocationConsumer({ endChannelMemberships, disconnectUser });
    const e = event("m2.membership.revoked", { userId: "u1" });
    await expect(c.handle(e)).rejects.toThrow(/not ready/);
    await expect(c.handle(e)).resolves.toBeUndefined();
    expect(endChannelMemberships).toHaveBeenCalledTimes(2);
    expect(disconnectUser).toHaveBeenCalledTimes(2);
  });

  it("calls the owned-items reassignment seam on revoke and org deactivation, not on suspend", async () => {
    const reassignOwnedItems = vi.fn().mockResolvedValue(undefined);
    const c = buildM36AccessRevocationConsumer({
      endChannelMemberships: vi.fn().mockResolvedValue(1),
      reassignOwnedItems,
    });
    await c.handle(event("m2.membership.revoked", { userId: "u1" }));
    await c.handle(event("m2.user.deactivated", { userId: "u2" }));
    await c.handle(event("m2.membership.suspended", { userId: "u3", to: "suspended" }));
    expect(reassignOwnedItems.mock.calls).toEqual([
      [ORG, "u1"],
      [ORG, "u2"],
    ]);
  });

  it("drops the sockets even when the owned-items reassignment throws, and still rethrows so the dispatcher retries", async () => {
    const cases = [
      ["m2.membership.revoked", { userId: "u1" }, "disconnectUser", [ORG, "u1"]],
      ["m2.user.deactivated", { userId: "u2" }, "disconnectUser", [ORG, "u2"]],
      ["m2.user.deactivated", { userId: "u3", scope: "platform" }, "disconnectAccount", ["u3"]],
    ] as const;
    for (const [type, payload, which, args] of cases) {
      const t = setup();
      const c = buildM36AccessRevocationConsumer({
        endChannelMemberships: t.endChannelMemberships,
        disconnectUser: t.disconnectUser,
        disconnectAccount: t.disconnectAccount,
        reassignOwnedItems: vi.fn().mockRejectedValue(new Error("reassign down")),
      });
      await expect(c.handle(event(type, payload))).rejects.toThrow(/reassign down/);
      expect(t[which]).toHaveBeenCalledWith(...args);
    }
  });
});
