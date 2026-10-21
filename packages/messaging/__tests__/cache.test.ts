import {
  createInMemoryMessagingCache,
  hashResolverArgs,
  recipientResolverKey,
  recipientResolverPrefix,
  roomMembershipKey,
  unreadCountKey,
} from "@chartwarden/messaging";
// M36-T08 — cache key grammar + invalidation + the three access patterns (M36 spec §4.8).
//
// Accept: the §4.8 key grammar is stable; the resolver cache round-trips and prefix-invalidates; the
// room set round-trips; per-user unread counts increment and floor at 0; `hashResolverArgs` is
// order-independent and deterministic.
import { describe, expect, it } from "vitest";

describe("M36-T08 cache key grammar (§4.8)", () => {
  it("builds the documented key shapes", () => {
    expect(roomMembershipKey("u1")).toBe("rooms:user:u1");
    expect(recipientResolverKey("on_call", "org_a", "abc123")).toBe("recip:on_call:org_a:abc123");
    expect(recipientResolverPrefix("on_call")).toBe("recip:on_call:");
    expect(unreadCountKey("u1")).toBe("unread:user:u1");
  });

  it("hashResolverArgs is order-independent and deterministic", () => {
    expect(hashResolverArgs({ a: 1, b: 2 })).toBe(hashResolverArgs({ b: 2, a: 1 }));
    expect(hashResolverArgs({ a: 1 })).not.toBe(hashResolverArgs({ a: 2 }));
  });
});

describe("M36-T08 in-memory cache (§4.8)", () => {
  it("round-trips a resolver result and prefix-invalidates by resolver", async () => {
    const { cache } = createInMemoryMessagingCache();
    const k = recipientResolverKey("on_call", "org_a", hashResolverArgs({ patientId: "p1" }));
    await cache.set(k, JSON.stringify(["u1", "u2"]), 60);
    expect(await cache.get(k)).toBe('["u1","u2"]');
    const { deleted } = await cache.deletePrefix(recipientResolverPrefix("on_call"));
    expect(deleted).toBe(1);
    expect(await cache.get(k)).toBeNull();
  });

  it("round-trips a room set", async () => {
    const { cache } = createInMemoryMessagingCache();
    await cache.setRooms(roomMembershipKey("u1"), ["user:u1", "org:org_a"], 3600);
    expect((await cache.getRooms(roomMembershipKey("u1"))).sort()).toEqual([
      "org:org_a",
      "user:u1",
    ]);
  });

  it("increments and decrements unread counts, flooring at 0", async () => {
    const { cache } = createInMemoryMessagingCache();
    const k = unreadCountKey("u1");
    await cache.incrUnread(k, "c1", 1);
    await cache.incrUnread(k, "c1", 1);
    expect((await cache.getUnread(k)).c1).toBe(2);
    await cache.incrUnread(k, "c1", -3); // read more than outstanding → floors at 0
    expect((await cache.getUnread(k)).c1).toBe(0);
    await cache.clearUnread(k, "c1");
    expect(await cache.getUnread(k)).toEqual({});
  });
});
