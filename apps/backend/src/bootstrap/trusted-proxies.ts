// apps/backend/src/bootstrap/trusted-proxies.ts - the one validated reading of TRUSTED_PROXY_CIDRS. Fastify's `trustProxy` takes the list verbatim: an entry
// that matches every address makes `request.ip` (and so every per-address rate budget, the realtime client key and the tenant host guard) whatever the
// caller writes in X-Forwarded-For. proxy-addr (under Fastify) already refuses some shapes by THROWING at boot ("invalid range", "invalid IP address");
// this validates first, so a bad list never reaches it and never crashes the boot.
//
// A list is VALID only when every entry is one of: an IPv4 or IPv6 literal, an IPv4/IPv6 CIDR with a prefix of at least 1 (never /0, which trusts the
// whole internet), or one of proxy-addr's three keywords (loopback, linklocal, uniquelocal). Wildcards ("*"), booleans ("true"), bare hop counts ("1"),
// empty segments inside an entry and malformed addresses or prefixes are rejected.
//
// ONE invalid entry makes the WHOLE list unusable: `parseTrustedProxies` then returns `false` (trust nobody, the safe default) and the offending entries
// are reported by `inspectTrustedProxies` so a caller can say which. The feature gate for external partner access (ADR-0096 D17) reads the same result.
import { isIP } from "node:net";

export interface TrustedProxyInspection {
  /** Entries as written (trimmed, empties dropped), valid or not. */
  readonly entries: readonly string[];
  /** The entries that failed validation; empty when the list is usable. */
  readonly invalid: readonly string[];
  /** True when there is at least one entry and every entry is valid. */
  readonly valid: boolean;
}

const KEYWORDS: ReadonlySet<string> = new Set(["loopback", "linklocal", "uniquelocal"]);
const PREFIX = /^\d{1,3}$/;

function entryIsValid(entry: string): boolean {
  if (KEYWORDS.has(entry)) return true;
  const slash = entry.indexOf("/");
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const family = isIP(address);
  if (family === 0) return false; // also rejects "*", "true", "1" and anything that is not an address literal
  if (slash === -1) return true;
  const prefix = entry.slice(slash + 1);
  if (!PREFIX.test(prefix)) return false;
  const bits = Number(prefix);
  // /0 trusts every address: attacker-controlled, never acceptable. The upper bound is the family's width.
  return bits >= 1 && bits <= (family === 4 ? 32 : 128);
}

export function inspectTrustedProxies(raw: string | undefined): TrustedProxyInspection {
  const entries = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const invalid = entries.filter((e) => !entryIsValid(e));
  return { entries, invalid, valid: entries.length > 0 && invalid.length === 0 };
}

/** Fastify's `trustProxy` value: the entries when the whole list is valid, otherwise `false` (trust nobody). */
export function parseTrustedProxies(raw: string | undefined): string[] | false {
  const inspected = inspectTrustedProxies(raw);
  return inspected.valid ? [...inspected.entries] : false;
}
