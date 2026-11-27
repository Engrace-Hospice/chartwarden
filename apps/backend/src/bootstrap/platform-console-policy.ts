// apps/backend/src/bootstrap/platform-console-policy.ts - CW-AC-22: the PURE half of the platform console's address allowlist: which routes are
// the console, and how PLATFORM_CONSOLE_ALLOWED_CIDRS is read. No I/O and no audit import, so env.ts (the deploy-time env check) can use it
// without pulling the server's dependencies in. The request hook and the audit sink are in ./platform-console-allowlist.
//
// THE ROUTES. Decided on the MATCHED ROUTE PATTERN (`request.routeOptions.url`), not the raw URL, so percent-encoding, doubled slashes and dot
// segments cannot step around a prefix: an unmatched path has no pattern and is a 404 either way. A family goes in only when no tenant
// surface (apps/web, apps/portal) calls it: `/api/admin/external-interfaces`, `/api/v1/reporting/admin` and `/api/v1/orgs` are shared with
// tenant administrators, so they stay out of this list. They are not left open: from an address outside the allowlist a request to ANY
// route not in it loses the caller's platform roles and permissions instead (platform-console-allowlist.ts), so a platform operator
// there is judged as the tenant user they would otherwise be.
import { BlockList, isIP } from "node:net";

export const PLATFORM_CONSOLE_ALLOWED_CIDRS_ENV = "PLATFORM_CONSOLE_ALLOWED_CIDRS";

/** Route-pattern prefixes of the platform console. A pattern matches when it equals a prefix or sits under it at a `/` boundary. */
export const PLATFORM_CONSOLE_ROUTE_PREFIXES = [
  "/api/v1/platform",
  "/api/v1/ops",
  // M35's cross-tenant billing admin (`platform_billing_scope`).
  "/api/admin/addons",
  "/api/admin/dunning",
  "/api/admin/plans",
  "/api/admin/pricing",
  "/api/admin/promos",
  "/api/admin/refunds",
  "/api/admin/revenue",
  "/api/admin/subscriptions",
  "/api/admin/usage",
  "/api/admin/webhooks",
  // Other platform-operator surfaces that only the admin console calls (checked against apps/web, apps/portal and the deploy scripts).
  "/api/v1/admin/mdm", // mdm_admin_platform_ops
  "/api/v1/admin/messaging/alert-deliveries", // cross-tenant delivery ledger, platform_ops only
  "/api/v1/admin/system", // POST /status: requireRole platform_ops
  "/api/v1/admin/billing/npi-verifications", // platform_billing_scope
  "/api/v1/admin/platform-medicaid-rules",
  "/api/v1/admin/state-rate-schedule-load",
  "/api/admin/external-interfaces/nppes/sync-runs", // nppes_platform_job_caller; the rest of external-interfaces is a tenant surface
] as const;

/** True when a matched route pattern belongs to the platform console. */
export function isPlatformConsoleRoute(routePattern: string): boolean {
  return PLATFORM_CONSOLE_ROUTE_PREFIXES.some(
    (prefix) => routePattern === prefix || routePattern.startsWith(`${prefix}/`),
  );
}

export type PlatformConsolePolicy =
  /** Variable unset: no gate. */
  | { readonly kind: "open" }
  /** A usable list: only these addresses reach the console. */
  | {
      readonly kind: "allowlist";
      readonly entries: readonly string[];
      readonly allows: (address: string) => boolean;
    }
  /** Set but unusable: every console request is refused. */
  | { readonly kind: "closed"; readonly invalid: readonly string[] };

type Family = "ipv4" | "ipv6";
interface ParsedEntry {
  /** The address as the list will match it: an IPv4-mapped IPv6 address is the IPv4 address it wraps. */
  readonly address: string;
  readonly family: Family;
  /** Prefix length; the family's width for a bare address. */
  readonly bits: number;
}

const PREFIX_DIGITS = /^\d{1,3}$/;
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const WIDTH: Readonly<Record<Family, number>> = { ipv4: 32, ipv6: 128 };

/**
 * Space that is not the public internet: an entry that lies wholly inside one of these blocks may be any width (an office's 10.0.0.0/8),
 * and nothing else may be wider than {@link MIN_PUBLIC_PREFIX}. A bare "no /0" rule let `0.0.0.0/1`, `::/1`, `34.0.0.0/8` or `::ffff:0:0/96`
 * through, each of which admits an attacker who rents a cloud VM; a fixed canary list missed whole quarters of the space.
 */
const NON_PUBLIC_BLOCKS: readonly (readonly [string, number, Family])[] = [
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["192.0.2.0", 24, "ipv4"], // RFC 5737 documentation
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["fc00::", 7, "ipv6"], // unique local
  ["fe80::", 10, "ipv6"], // link local
  ["::1", 128, "ipv6"],
  ["2001:db8::", 32, "ipv6"], // RFC 3849 documentation
];
/** The widest a public range may be: a site's own block (an IPv4 /24, an IPv6 /48). */
const MIN_PUBLIC_PREFIX: Readonly<Record<Family, number>> = { ipv4: 24, ipv6: 48 };
const MAPPED_V6 = ((): BlockList => {
  const list = new BlockList();
  list.addSubnet("::ffff:0:0", 96, "ipv6");
  return list;
})();

/** An IPv4-mapped IPv6 address (`::ffff:203.0.113.7`, what a dual-stack socket reports) is the IPv4 address it wraps. */
function normalizeAddress(address: string): string {
  const mapped = IPV4_MAPPED.exec(address);
  return mapped?.[1] ?? address;
}

function familyName(address: string): Family | null {
  const family = isIP(address);
  return family === 4 ? "ipv4" : family === 6 ? "ipv6" : null;
}

/**
 * Parse an address or `address/prefix` (prefix 1..width); null when it is not one, or is a prefix on a dotted IPv4-mapped address
 * (`::ffff:1.2.3.4/96`), which has no IPv4 reading. Ranges in hex form that overlap the mapped block parse, and `isWide` refuses them.
 */
function parseEntry(entry: string): ParsedEntry | null {
  const slash = entry.indexOf("/");
  const written = slash === -1 ? entry : entry.slice(0, slash);
  const address = normalizeAddress(written);
  const family = familyName(address);
  if (family === null || address.includes("%")) return null;
  if (slash === -1) return { address, family, bits: WIDTH[family] };
  // A mapped IPv6 CIDR does not translate to an IPv4 prefix: a prefix is only valid on the address as written.
  if (address !== written) return null;
  const digits = entry.slice(slash + 1);
  if (!PREFIX_DIGITS.test(digits)) return null;
  const bits = Number(digits);
  if (bits < 1 || bits > WIDTH[family]) return null;
  return { address, family, bits };
}

/**
 * True when an IPv6 RANGE overlaps the IPv4-mapped block (`::ffff:0:0/96`): it sits inside it, or contains it (`::/80`, `::1/64`,
 * `::fffe:0:0/95`, ...), and so matches IPv4 addresses, whatever its prefix length. `::ffff:0:1` is a probe inside the block.
 */
function overlapsMappedBlock({ address, family, bits }: ParsedEntry): boolean {
  if (family !== "ipv6" || bits === WIDTH.ipv6) return false;
  const alone = new BlockList();
  alone.addSubnet(address, bits, "ipv6");
  return MAPPED_V6.check(address, "ipv6") || alone.check("::ffff:0:1", "ipv6");
}

/** True when a parsed range is neither wholly inside non-public space nor narrow enough to name a site. */
function isWide(entry: ParsedEntry): boolean {
  const { address, family, bits } = entry;
  if (overlapsMappedBlock(entry)) return true;
  if (bits >= MIN_PUBLIC_PREFIX[family]) return false;
  return !NON_PUBLIC_BLOCKS.some(([block, blockBits, blockFamily]) => {
    if (blockFamily !== family || bits < blockBits) return false;
    const list = new BlockList();
    list.addSubnet(block, blockBits, family);
    return list.check(address, family);
  });
}

/**
 * True when `entry` is an address or CIDR that spans more public address space than one site's block. Used for `TRUSTED_PROXY_CIDRS` too
 * (env.ts): a trusted range that wide lets any client inside it write its own `X-Forwarded-For`, which defeats an allowlist built on it.
 * False for anything that is not an address or CIDR (a keyword, a typo): the caller's own validity check owns that.
 */
export function isCidrTooWide(entry: string): boolean {
  const parsed = parseEntry(entry);
  if (parsed !== null) return isWide(parsed);
  // A real address with a real prefix that parseEntry still refuses (a prefix on an IPv4-mapped address, `::ffff:0.0.0.0/96`) names a range
  // that matches IPv4 space: too wide for a trusted-proxy list. Anything else (a keyword, a typo) is the caller's own validity check.
  const slash = entry.indexOf("/");
  if (slash === -1) return false;
  const family = familyName(entry.slice(0, slash).replace(/%.*$/, ""));
  const digits = entry.slice(slash + 1);
  return (
    family !== null &&
    PREFIX_DIGITS.test(digits) &&
    Number(digits) >= 1 &&
    Number(digits) < WIDTH[family] // a /128 on a mapped address names one host, not a range
  );
}

/** Read `PLATFORM_CONSOLE_ALLOWED_CIDRS`. Pure. Blank = open; any bad or far too wide entry (or no entry at all) = closed. */
export function parsePlatformConsolePolicy(raw: string | undefined): PlatformConsolePolicy {
  if (raw === undefined || raw.trim() === "") return { kind: "open" };
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return { kind: "closed", invalid: [raw.trim()] };
  const list = new BlockList();
  const invalid: string[] = [];
  for (const entry of entries) {
    const parsed = parseEntry(entry);
    if (parsed === null || isWide(parsed)) {
      invalid.push(entry);
    } else if (parsed.bits === WIDTH[parsed.family]) {
      list.addAddress(parsed.address, parsed.family);
    } else {
      list.addSubnet(parsed.address, parsed.bits, parsed.family);
    }
  }
  if (invalid.length > 0) return { kind: "closed", invalid };
  return {
    kind: "allowlist",
    entries,
    allows: (address) => {
      // A zone id (`fe80::1%eth0`) is not an address a peer reaches the API from; BlockList would ignore it and match the bare address.
      if (address.includes("%")) return false;
      const normalized = normalizeAddress(address);
      const family = familyName(normalized);
      return family !== null && list.check(normalized, family);
    },
  };
}
