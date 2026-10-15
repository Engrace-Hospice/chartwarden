// M25 milestone 3 — which path a denial takes (appeal vs. MAC reopening), decided by dated per-organization
// rules. Pure: most specific rule wins, an unmatched denial stays appealable, unverified rules are flagged.
import { describe, expect, it } from "vitest";
import {
  type DenialRouteInput,
  PLATFORM_ROUTE_RULES,
  type RouteRule,
  resolveRoute,
} from "../denial-route";

const rule = (over: Partial<RouteRule>): RouteRule => ({
  id: "r1",
  macName: null,
  codeKind: "mac_reason",
  code: "56900",
  route: "reopening",
  verifiedOn: null,
  effectiveFrom: "2026-01-01",
  sourceNote: "CGS guidance",
  ...over,
});
const denial = (over: Partial<DenialRouteInput> = {}): DenialRouteInput => ({
  macName: "CGS",
  macReasonCode: "56900",
  carcCode: "50",
  rarcCode: null,
  asOf: "2026-06-01",
  ...over,
});

describe("resolveRoute", () => {
  it("routes a matching MAC reason code to its rule and flags an unverified rule", () => {
    const r = resolveRoute(denial(), [rule({})]);
    expect(r).toMatchObject({ route: "reopening", unverified: true });
    expect(r.rule?.id).toBe("r1");
  });

  it("leaves an unmatched denial appealable (undetermined), never blocked", () => {
    expect(resolveRoute(denial({ macReasonCode: null }), [rule({})])).toEqual({
      route: "undetermined",
      rule: null,
      unverified: false,
    });
  });

  it("is not unverified once the rule carries a verified date", () => {
    expect(resolveRoute(denial(), [rule({ verifiedOn: "2026-05-01" })]).unverified).toBe(false);
  });

  it("matches codes ignoring case and surrounding spaces", () => {
    const r = resolveRoute(denial({ macReasonCode: " 5ffTF " }), [
      rule({ code: "5FFTF", route: "appeal" }),
    ]);
    expect(r.route).toBe("appeal");
  });

  it("ignores a rule that is not yet effective on the as-of day", () => {
    expect(resolveRoute(denial({ asOf: "2025-12-31" }), [rule({})]).route).toBe("undetermined");
  });

  it("prefers a MAC-specific rule over a generic one", () => {
    const generic = rule({ id: "g", route: "appeal" });
    const specific = rule({ id: "s", macName: "CGS", route: "reopening" });
    expect(resolveRoute(denial(), [generic, specific]).rule?.id).toBe("s");
  });

  it("does not apply a rule written for another MAC", () => {
    expect(resolveRoute(denial(), [rule({ macName: "Palmetto" })]).route).toBe("undetermined");
  });

  it("matches the MAC name case-insensitively", () => {
    expect(resolveRoute(denial({ macName: "cgs" }), [rule({ macName: "CGS" })]).route).toBe(
      "reopening",
    );
  });

  it("ranks the MAC reason code above RARC above CARC when specificity ties", () => {
    const carc = rule({ id: "c", codeKind: "carc", code: "50", route: "appeal" });
    const rarc = rule({ id: "a", codeKind: "rarc", code: "N54", route: "appeal" });
    const reason = rule({ id: "m" });
    expect(resolveRoute(denial({ rarcCode: "N54" }), [carc, rarc, reason]).rule?.id).toBe("m");
    expect(
      resolveRoute(denial({ rarcCode: "N54", macReasonCode: null }), [carc, rarc]).rule?.id,
    ).toBe("a");
  });

  it("lets a tenant's own rule outrank the built-in default, whatever the dates", () => {
    const own = rule({ id: "own", route: "appeal", effectiveFrom: "1999-01-01" });
    const builtIn = { ...PLATFORM_ROUTE_RULES[0]!, effectiveFrom: "2026-05-01" };
    expect(resolveRoute(denial(), [builtIn, own]).rule?.id).toBe("own");
  });

  it("routes a 56900 to a reopening out of the box, unverified, with no tenant rules", () => {
    expect(resolveRoute(denial(), PLATFORM_ROUTE_RULES)).toMatchObject({
      route: "reopening",
      unverified: true,
    });
  });

  it("lets the MAC reason code outrank a MAC-specific CARC rule, so a 56900 stays protected", () => {
    const carcForCgs = rule({
      id: "c",
      macName: "CGS",
      codeKind: "carc",
      code: "50",
      route: "appeal",
    });
    const reason56900 = rule({ id: "m", macName: null, route: "reopening" });
    expect(resolveRoute(denial(), [carcForCgs, reason56900]).rule?.id).toBe("m");
  });

  it("takes the latest effective rule when two tie, deterministically", () => {
    const older = rule({ id: "o", effectiveFrom: "2026-01-01", route: "appeal" });
    const newer = rule({ id: "n", effectiveFrom: "2026-03-01", route: "reopening" });
    expect(resolveRoute(denial(), [older, newer]).rule?.id).toBe("n");
    expect(resolveRoute(denial(), [newer, older]).rule?.id).toBe("n");
  });
});
