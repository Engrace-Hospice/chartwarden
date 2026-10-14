// WP 3.5 - the tenant handoff policy: tighten-only over the 240-minute platform ceiling, re-applied on every read.
import {
  HANDOFF_EXPIRY_MIN_MINUTES,
  HANDOFF_EXPIRY_PLATFORM_MINUTES,
  WardenXError,
} from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  effectiveHandoffMinutes,
  handoffPolicyView,
  prepareHandoffPolicy,
} from "../src/handoffs/handoff-policy";

describe("effectiveHandoffMinutes", () => {
  it("is the platform ceiling when the tenant has no row", () => {
    expect(effectiveHandoffMinutes(null)).toBe(HANDOFF_EXPIRY_PLATFORM_MINUTES);
  });
  it("uses a stored value inside the range", () => {
    expect(effectiveHandoffMinutes(60)).toBe(60);
  });
  it("clamps a hand-edited longer row to the ceiling and a shorter one to the floor", () => {
    expect(effectiveHandoffMinutes(5000)).toBe(HANDOFF_EXPIRY_PLATFORM_MINUTES);
    expect(effectiveHandoffMinutes(1)).toBe(HANDOFF_EXPIRY_MIN_MINUTES);
  });
  it("ignores a non-finite stored value", () => {
    expect(effectiveHandoffMinutes(Number.NaN)).toBe(HANDOFF_EXPIRY_PLATFORM_MINUTES);
  });
});

describe("prepareHandoffPolicy", () => {
  it("accepts the bounds", () => {
    expect(prepareHandoffPolicy(HANDOFF_EXPIRY_MIN_MINUTES)).toBe(HANDOFF_EXPIRY_MIN_MINUTES);
    expect(prepareHandoffPolicy(HANDOFF_EXPIRY_PLATFORM_MINUTES)).toBe(
      HANDOFF_EXPIRY_PLATFORM_MINUTES,
    );
  });
  it.each([14, 241, 60.5, Number.NaN, "60", null, undefined])("rejects %s with 422", (v) => {
    try {
      prepareHandoffPolicy(v);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(WardenXError);
      expect((e as WardenXError).code).toBe("HANDOFF_POLICY_INVALID");
      expect((e as WardenXError).statusCode).toBe(422);
    }
  });
});

describe("handoffPolicyView", () => {
  it("flags a customised policy", () => {
    expect(handoffPolicyView(null)).toEqual({
      expiry_minutes: 240,
      platform_max_minutes: 240,
      customised: false,
    });
    expect(handoffPolicyView(90)).toEqual({
      expiry_minutes: 90,
      platform_max_minutes: 240,
      customised: true,
    });
  });
});
