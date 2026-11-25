import { describe, expect, it } from "vitest";
import { resolveRhcHomeResidence } from "./rhc-pricing-snapshot";

const HOME = {
  addressId: "11111111-1111-1111-1111-111111111111",
  kind: "home",
  facilityId: null,
  effectiveFrom: "2026-11-01",
  effectiveTo: null,
} as const;

describe("RHC service-location qualification", () => {
  it("requires one stable home residence covering the inclusive service window", () => {
    expect(resolveRhcHomeResidence([HOME], "2026-11-01", "2026-11-04")).toEqual({
      status: "resolved",
      span: HOME,
    });
    expect(
      resolveRhcHomeResidence([{ ...HOME, effectiveTo: "2026-11-03" }], "2026-11-01", "2026-11-04"),
    ).toEqual({ status: "unresolved", reasonCode: "RHC_SERVICE_RESIDENCE_PERIOD_INCOMPLETE" });
  });

  it("refuses facility and ambiguous residence histories instead of emitting Q5001", () => {
    expect(
      resolveRhcHomeResidence(
        [{ ...HOME, kind: "facility", facilityId: "22222222-2222-2222-2222-222222222222" }],
        "2026-11-01",
        "2026-11-04",
      ),
    ).toEqual({ status: "unsupported", reasonCode: "RHC_Q5001_REQUIRES_HOME_RESIDENCE" });
    expect(resolveRhcHomeResidence([HOME, HOME], "2026-11-01", "2026-11-04")).toEqual({
      status: "ambiguous",
      reasonCode: "RHC_SERVICE_RESIDENCE_AMBIGUOUS",
    });
    expect(resolveRhcHomeResidence([], "2026-11-01", "2026-11-04")).toEqual({
      status: "unresolved",
      reasonCode: "RHC_SERVICE_RESIDENCE_MISSING",
    });
  });
});
