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
  return {
    endChannelMemberships,
    disconnectUser,
    consumer: buildM36AccessRevocationConsumer({ endChannelMemberships, disconnectUser }),
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
    expect(t.disconnectUser).toHaveBeenCalledWith("u1");
  });

  it("suspended: drops sockets but keeps membership rows", async () => {
    const t = setup();
    await t.consumer.handle(
      event("m2.membership.suspended", { userId: "u1", from: "active", to: "suspended" }),
    );
    expect(t.disconnectUser).toHaveBeenCalledWith("u1");
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
    expect(t.disconnectUser).toHaveBeenCalledWith("u2");
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

  it("platform deactivation drops sockets by user, with no org", async () => {
    const disconnectUser = vi.fn().mockResolvedValue(undefined);
    const c = buildM36AccessRevocationPlatformConsumer({ disconnectUser });
    await c.handle({
      id: "e",
      eventType: "m2.user.deactivated",
      aggregateKind: "user",
      aggregateId: "u3",
      payload: { userId: "u3", reason: "x", scope: "platform" },
      attemptCount: 0,
      createdAt: new Date(),
    });
    expect(disconnectUser).toHaveBeenCalledWith("u3");
  });
});
