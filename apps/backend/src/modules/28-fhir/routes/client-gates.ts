// apps/backend/src/modules/28-fhir/routes/client-gates.ts — GAP-083: the §4.7 `fhir_client_active` posture
// (D12) as REQUEST-TIME gates. The per-client IP allowlist and the BAA status were stored and never read,
// so a leaked credential worked from anywhere and a lapsed BAA changed nothing. Both the token mint and
// `resolveBearer` call these, so a token minted from an allowed address is still refused from another one.
//
// The caller's address is `request.ip` and nothing else: Fastify derives it from the socket and only walks
// `X-Forwarded-For` for hops inside `TRUSTED_PROXY_CIDRS`. A raw header is never read here.
import { BlockList, isIP } from "node:net";

import type { FhirBaaStatusView } from "../seams/index";

/** An allowlist entry is a CIDR (`10.0.0.0/8`) or a bare address; an empty list means no restriction. */
export function isIpAllowed(ip: string | null | undefined, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  if (typeof ip !== "string") return false;
  // `::ffff:203.0.113.5` is the IPv4 peer as a dual-stack socket reports it.
  const address = ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const family = isIP(address);
  if (family === 0) return false;
  const list = new BlockList();
  for (const raw of allowlist) {
    const entry = raw.trim();
    const [base, prefix, ...rest] = entry.split("/");
    const baseFamily = base === undefined ? 0 : isIP(base);
    // A malformed entry never matches (fail closed) rather than throwing mid-request.
    if (baseFamily === 0 || rest.length > 0) continue;
    const type = baseFamily === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) {
      list.addAddress(base as string, type);
      continue;
    }
    const bits = Number(prefix);
    const max = baseFamily === 4 ? 32 : 128;
    if (!/^\d{1,3}$/.test(prefix) || bits > max) continue;
    list.addSubnet(base as string, bits, type);
  }
  return list.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** The BAA gate, fail-closed: an unbound port, a throw, or anything but `true` is "not active". */
export async function isBaaInForce(
  baa: Pick<FhirBaaStatusView, "isBaaActive"> | undefined,
  input: { organizationId: string; contractReference: string; asOf: string },
): Promise<boolean> {
  if (baa === undefined) return false;
  try {
    return (await baa.isBaaActive(input)) === true;
  } catch {
    return false;
  }
}

/** The distinct diagnostic code for a BAA refusal — separable from a bad credential in logs and the console. */
export const BAA_NOT_IN_FORCE_CODE = "BAA_NOT_IN_FORCE";

/** `unknown` is a seam error or an unbound port: the gate stays closed, but operators can tell it apart. */
export type FhirBaaStatus = "in_force" | "not_in_force" | "unknown";

/** Tri-state BAA status for the admin surface. Never throws; a seam error is `unknown`, not `not_in_force`. */
export async function baaStatusOf(
  baa: Pick<FhirBaaStatusView, "isBaaActive"> | undefined,
  input: { organizationId: string; contractReference: string; asOf: string },
): Promise<FhirBaaStatus> {
  if (baa === undefined) return "unknown";
  try {
    return (await baa.isBaaActive(input)) === true ? "in_force" : "not_in_force";
  } catch {
    return "unknown";
  }
}

/** A well-formed allowlist entry: an IPv4/IPv6 address, or one with a `/prefix` in range. */
export function isValidIpAllowlistEntry(raw: string): boolean {
  const entry = raw.trim();
  if (entry.length === 0) return false;
  const [base, prefix, ...rest] = entry.split("/");
  const family = base === undefined ? 0 : isIP(base);
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}
