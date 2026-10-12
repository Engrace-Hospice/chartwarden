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
  it("falls back to the peer when a trusted proxy sent no header, and skips keyword entries", () => {
    expect(realtimeClientKey(["10.0.0.0/8"])(req("10.1.2.3"))).toBe("10.1.2.3");
    expect(realtimeClientKey(["loopback"])(req("127.0.0.1", "1.2.3.4"))).toBe("127.0.0.1");
  });
});
