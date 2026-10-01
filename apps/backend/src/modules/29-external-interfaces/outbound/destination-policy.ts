// apps/backend/src/modules/29-external-interfaces/outbound/destination-policy.ts — where the outbound MLLP
// worker may dial, and over what protocol (F-181, #248).
//
// The `external_feed.host` an outbound ORM is sent to is ADMIN-SUPPLIED, and the process holds PHI and cloud
// credentials, so a hostile or mistyped feed must not be able to aim it at the instance-metadata service or
// at the host itself. Everything here is PURE (the caller supplies resolved addresses and the environment):
//
//   · `mllp_plain` is cleartext PHI on the wire. It is refused for a real send unless the deployment is NOT
//     production AND explicitly opted in with `M29_ALLOW_MLLP_PLAIN=true` — fail closed, never a silent
//     downgrade. (Env validation separately refuses to BOOT a production deployment that sets the opt-in.)
//   · Link-local / metadata addresses (169.254.0.0/16, fe80::/10, the well-known cloud metadata names and
//     addresses) are refused ALWAYS. Loopback and the unspecified address are refused in production only —
//     the live test suites and local development dial loopback receivers.
//   · RFC1918 / ULA private ranges are deliberately ALLOWED: a hospital's lab receiver is usually reached
//     over a private VPN address, so denying them would break the feature's real use.
import { isIP } from "node:net";

export interface OutboundDestinationPolicy {
  /** `mllp_plain` may be dialled. Only ever true outside production with the explicit opt-in. */
  readonly allowPlain: boolean;
  /** Loopback / unspecified destinations may be dialled. False in production. */
  readonly allowLoopback: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The single production-mode decision the M29 outbound path uses (mirrors `bootstrap/env.ts`, which
 *  treats only `NODE_ENV === "production"` as production). */
export function isProductionEnv(env: Env): boolean {
  return env.NODE_ENV === "production";
}

export function resolveDestinationPolicy(env: Env): OutboundDestinationPolicy {
  const production = isProductionEnv(env);
  return {
    allowPlain: !production && env.M29_ALLOW_MLLP_PLAIN === "true",
    allowLoopback: !production,
  };
}

/** Short, PHI-free, fixed refusal labels (safe for logs / `detail`). */
export type DestinationRefusal =
  | "plain_protocol_refused"
  | "destination_link_local"
  | "destination_metadata_host"
  | "destination_loopback"
  | "destination_unspecified"
  | "destination_multicast";

/** null = the protocol is permitted. */
export function checkProtocol(
  protocol: "mllp_tls" | "mllp_plain",
  policy: OutboundDestinationPolicy,
): DestinationRefusal | null {
  return protocol === "mllp_plain" && !policy.allowPlain ? "plain_protocol_refused" : null;
}

const METADATA_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** Well-known metadata addresses that sit OUTSIDE 169.254/16. */
const METADATA_ADDRESSES = new Set(["100.100.100.200", "fd00:ec2::254"]);

/** Normalise an IPv4-mapped IPv6 literal (`::ffff:a.b.c.d` / `::ffff:aabb:ccdd`) to dotted IPv4. */
function unmap(ip: string): string {
  const lower = ip.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return lower;
}

/** Classify ONE resolved IP literal. null = acceptable under `policy`. */
export function classifyAddress(
  ip: string,
  policy: OutboundDestinationPolicy,
): DestinationRefusal | null {
  const addr = unmap(ip);
  if (METADATA_ADDRESSES.has(addr)) return "destination_metadata_host";
  const family = isIP(addr);
  if (family === 4) {
    const [a = 0, b = 0] = addr.split(".").map(Number);
    if (a === 169 && b === 254) return "destination_link_local";
    if (a >= 224) return "destination_multicast";
    if (a === 0) return policy.allowLoopback ? null : "destination_unspecified";
    if (a === 127) return policy.allowLoopback ? null : "destination_loopback";
    return null;
  }
  if (family === 6) {
    if (addr === "::") return policy.allowLoopback ? null : "destination_unspecified";
    if (addr === "::1") return policy.allowLoopback ? null : "destination_loopback";
    const first = Number.parseInt(addr.split(":")[0] || "0", 16);
    if ((first & 0xffc0) === 0xfe80) return "destination_link_local"; // fe80::/10
    if ((first & 0xff00) === 0xff00) return "destination_multicast"; // ff00::/8
    return null;
  }
  return null;
}

/** Classify a configured HOSTNAME before resolution (well-known metadata names, `localhost`). */
export function classifyHostname(
  host: string,
  policy: OutboundDestinationPolicy,
): DestinationRefusal | null {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (METADATA_HOSTNAMES.has(h)) return "destination_metadata_host";
  if (isIP(h) !== 0) return classifyAddress(h, policy);
  if (h === "localhost" || h.endsWith(".localhost")) {
    return policy.allowLoopback ? null : "destination_loopback";
  }
  return null;
}
