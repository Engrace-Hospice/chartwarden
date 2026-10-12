import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { realtimeClientKey } from "../src/bootstrap/realtime/client-key";

const req = (peer: string, xff?: string) =>
  ({
    socket: { remoteAddress: peer },
    headers: xff ? { "x-forwarded-for": xff } : {},
  }) as unknown as IncomingMessage;

describe("realtimeClientKey", () => {
  it("ignores X-Forwarded-For when no proxy is trusted", () => {
    expect(realtimeClientKey(false)(req("203.0.113.9", "1.2.3.4"))).toBe("203.0.113.9");
  });
  it("ignores X-Forwarded-For from a peer that is not a trusted proxy", () => {
    expect(realtimeClientKey(["10.0.0.0/8"])(req("203.0.113.9", "1.2.3.4"))).toBe("203.0.113.9");
  });
  it("uses the last entry when the peer is a trusted proxy (CIDR or single IP)", () => {
    expect(realtimeClientKey(["10.0.0.0/8"])(req("10.1.2.3", "9.9.9.9, 198.51.100.7"))).toBe(
      "198.51.100.7",
    );
    expect(realtimeClientKey(["10.1.2.3"])(req("10.1.2.3", "198.51.100.7"))).toBe("198.51.100.7");
  });
  it("walks the chain right to left past every trusted hop (CDN -> LB -> app)", () => {
    const key = realtimeClientKey(["10.0.0.0/8", "172.16.0.0/12"]);
    expect(key(req("10.1.2.3", "198.51.100.7, 172.16.0.9"))).toBe("198.51.100.7");
    expect(key(req("10.1.2.3", "198.51.100.7:4711"))).toBe("198.51.100.7"); // :port suffix
  });
  it("buckets an IPv6 caller by its /64 and unwraps IPv4-mapped peers", () => {
    const key = realtimeClientKey(false);
    expect(key(req("2001:db8:1:2:aaaa::1"))).toBe(key(req("2001:db8:1:2:bbbb::2")));
    expect(key(req("2001:db8:1:3::1"))).not.toBe(key(req("2001:db8:1:2::1")));
    expect(key(req("::ffff:203.0.113.9"))).toBe("203.0.113.9");
  });
  it("recognises a trusted IPv6 proxy hop in the chain instead of mistaking it for the client", () => {
    const key = realtimeClientKey(["2001:db8:ffff::/48"]);
    expect(key(req("2001:db8:ffff::5", "198.51.100.7, 2001:db8:ffff::9"))).toBe("198.51.100.7");
  });
  it("ignores a non-IP forwarded entry and strips an IPv6 zone id", () => {
    const key = realtimeClientKey(["10.0.0.0/8"]);
    expect(key(req("10.1.2.3", "198.51.100.7, garbage"))).toBe("10.1.2.3");
    expect(realtimeClientKey(["fd00::/8"])(req("fd00::1%eth0", "198.51.100.7"))).toBe(
      "198.51.100.7",
    );
  });
  it("falls back to the peer when a trusted proxy sent no header, and skips keyword entries", () => {
    expect(realtimeClientKey(["10.0.0.0/8"])(req("10.1.2.3"))).toBe("10.1.2.3");
    expect(realtimeClientKey(["loopback"])(req("127.0.0.1", "1.2.3.4"))).toBe("127.0.0.1");
  });
});
