// apps/backend/src/bootstrap/realtime/client-key.ts — the per-client key for the handshake throttle (ADR-0054 A8).
import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";

const IPV4_MAPPED = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i;

/** Normalise one address into a rate-limit key: strip `:port`, unwrap IPv4-mapped IPv6, and collapse IPv6 to its /64. */
function normalise(raw: string): string {
  let addr = raw.trim();
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(addr);
  if (bracket) addr = bracket[1] ?? addr;
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(addr)) addr = addr.slice(0, addr.lastIndexOf(":"));
  const mapped = IPV4_MAPPED.exec(addr);
  if (mapped) return mapped[1] ?? addr;
  if (isIP(addr) !== 6) return addr;
  // A /64 holder controls 2^64 addresses: bucket the prefix, not the host. Expand `::` then keep the first 4 groups.
  const [head = "", tail = ""] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = addr.includes("::")
    ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t]
    : h;
  return `${groups.slice(0, 4).join(":").toLowerCase()}::/64`;
}

/**
 * The socket's remote address, unless that peer is one of the trusted proxies (IP or CIDR entries). Then the
 * `X-Forwarded-For` chain is walked right to left past every trusted hop (as Fastify's `trustProxy` does) and the first
 * untrusted entry is the client. A peer that is NOT a trusted proxy is never believed, so a direct caller cannot choose
 * its own bucket. Other `trustProxy` forms (keywords) are ignored: fail safe.
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
  const isTrusted = (addr: string): boolean => {
    const family = isIP(addr);
    return family !== 0 && trusted.check(addr, family === 4 ? "ipv4" : "ipv6");
  };
  return (req) => {
    const peer = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/i, "");
    if (!isTrusted(peer)) return normalise(peer);
    const xff = req.headers["x-forwarded-for"];
    const chain = (Array.isArray(xff) ? xff.join(",") : (xff ?? ""))
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    for (let i = chain.length - 1; i >= 0; i--) {
      const hop = normalise(chain[i] ?? "");
      if (!isTrusted(hop)) return hop;
    }
    return normalise(peer);
  };
}
