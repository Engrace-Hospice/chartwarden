/**
 * `TRUSTED_PROXY_CIDRS` → Fastify `trustProxy` (SD-055).
 *
 * WHY THIS EXISTS. `plugins/security.ts` rate-limits unauthenticated traffic on `ip:${request.ip}`,
 * and `request.ip` is the SOCKET peer unless Fastify is told which hop to trust. Behind a load
 * balancer that made every anonymous request share ONE bucket — so the 30/min unauthenticated tier
 * was 30/min for the entire deployment, and a single client could lock everyone out of `/login`, the
 * public signup-intent route and collaborator-consume.
 *
 * The fix must NOT be `trustProxy: true`. Trusting every hop lets any caller send its own
 * `X-Forwarded-For` and therefore choose its own rate-limit bucket — or impersonate someone else's,
 * which also poisons `sourceIp` on every audit row. So it is an explicit allow-list, and the default
 * with the variable unset is `false`: trust nothing.
 */
import { describe, expect, it } from "vitest";
import { parseTrustedProxies } from "../src/bootstrap/index";

describe("parseTrustedProxies", () => {
  it("trusts NOTHING when the variable is unset or blank", () => {
    // The important case: a missing env var must not silently become "trust every hop".
    expect(parseTrustedProxies(undefined)).toBe(false);
    expect(parseTrustedProxies("")).toBe(false);
    expect(parseTrustedProxies("   ")).toBe(false);
    expect(parseTrustedProxies(",, ,")).toBe(false);
  });

  it("returns the explicit allow-list, trimmed", () => {
    expect(parseTrustedProxies("10.0.0.0/8")).toEqual(["10.0.0.0/8"]);
    expect(parseTrustedProxies("10.0.0.0/8, 172.16.0.0/12 ,192.168.1.5")).toEqual([
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.1.5",
    ]);
  });

  it("never yields boolean true — an allow-list, never blanket trust", () => {
    for (const raw of ["true", "1", "*", "0.0.0.0/0, 10.0.0.0/8"]) {
      const v = parseTrustedProxies(raw);
      expect(v).not.toBe(true);
      expect(Array.isArray(v) || v === false).toBe(true);
    }
    // ADR-0096 D17 (supersedes the earlier "operator explicitly asked for it" reading): a /0 prefix makes request.ip whatever the caller writes in
    // X-Forwarded-For, so it is REFUSED (and Fastify would throw "invalid range" on it at boot). The whole list is then unusable: trust nobody.
    expect(parseTrustedProxies("0.0.0.0/0")).toBe(false);
    expect(parseTrustedProxies("::/0")).toBe(false);
  });
});
