import type { IncomingMessage } from "node:http";
// apps/backend/src/bootstrap/realtime/client-key.ts — the per-client key for the handshake throttle (ADR-0054 A8).
import { BlockList, isIP } from "node:net";

/**
 * The socket's remote address, unless that peer is one of the trusted proxies (IP or CIDR entries), in which case the
 * last `X-Forwarded-For` entry: the address the nearest trusted proxy saw. A peer that is NOT a trusted proxy is never
 * believed, so a direct caller cannot choose its own bucket. Other `trustProxy` forms (keywords) are ignored: fail safe.
 */
export function realtimeClientKey(
  trustedProxies: readonly string[] | false,
): (req: IncomingMessage) => string {
  const trusted = new BlockList();
  for (const entry of trustedProxies || []) {
    const [addr = "", prefix] = entry.split("/");
    const family = isIP(addr);
    if (family === 0) continue;
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) trusted.addAddress(addr, type);
    else trusted.addSubnet(addr, Number(prefix), type);
  }
  return (req) => {
    const peer = req.socket.remoteAddress ?? "unknown";
    const family = isIP(peer);
    if (family === 0 || !trusted.check(peer, family === 4 ? "ipv4" : "ipv6")) return peer;
    const xff = req.headers["x-forwarded-for"];
    const last = (Array.isArray(xff) ? xff.join(",") : (xff ?? "")).split(",").pop()?.trim();
    return last || peer;
  };
}
