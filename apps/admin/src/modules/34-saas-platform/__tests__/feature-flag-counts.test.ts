// The Enabled KPI must count wire-shaped flags: the backend/DB value type for booleans is `bool`.
import { describe, expect, it } from "vitest";
import { type FeatureFlagView, countEnabledFlags } from "../feature-flags";

const flag = (over: Partial<FeatureFlagView>): FeatureFlagView => ({
  id: "f",
  flagKey: "k",
  organizationId: null,
  flagKind: "product",
  valueType: "bool",
  value: true,
  rolloutPercent: null,
  killSwitchActive: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("countEnabledFlags", () => {
  it("counts true bool flags, platform-global and per-tenant alike", () => {
    expect(countEnabledFlags([flag({}), flag({ organizationId: "org-1" })])).toBe(2);
  });
  it("skips false, kill-switched and non-boolean flags", () => {
    expect(
      countEnabledFlags([
        flag({ value: false }),
        flag({ killSwitchActive: true }),
        flag({ valueType: "string", value: "true" }),
      ]),
    ).toBe(0);
  });
});
