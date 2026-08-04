// @wardenx/emar — §2.5 D8 late-entry tier ladder — M13-T03.
import { describe, expect, it } from "vitest";
import { resolveLateEntryTier, tierRequiresElevatedPermission } from "../src/lifecycle";

const admin = "2026-06-22T00:00:00.000Z";
const plus = (h: number): string => new Date(Date.parse(admin) + h * 3_600_000).toISOString();

describe("§2.5 D8 resolveLateEntryTier", () => {
  it("≤4h → normal", () => {
    expect(resolveLateEntryTier(admin, plus(0))).toBe("normal");
    expect(resolveLateEntryTier(admin, plus(4))).toBe("normal");
  });
  it("4–24h → late", () => {
    expect(resolveLateEntryTier(admin, plus(4.5))).toBe("late");
    expect(resolveLateEntryTier(admin, plus(24))).toBe("late");
  });
  it("24h–7d → significant_late", () => {
    expect(resolveLateEntryTier(admin, plus(25))).toBe("significant_late");
    expect(resolveLateEntryTier(admin, plus(24 * 7))).toBe("significant_late");
  });
  it(">7d → administrative_override", () => {
    expect(resolveLateEntryTier(admin, plus(24 * 7 + 1))).toBe("administrative_override");
  });
  it("an offline 0300 capture synced 18h later is 'late' (computed off both instants, §2.10)", () => {
    expect(resolveLateEntryTier("2026-06-22T03:00:00.000Z", "2026-06-22T21:00:00.000Z")).toBe(
      "late",
    );
  });
  it("a non-positive gap (recorded ≤ administered) is normal", () => {
    expect(resolveLateEntryTier(plus(1), admin)).toBe("normal");
  });
  it("the elevated-permission tiers are significant_late + administrative_override", () => {
    expect(tierRequiresElevatedPermission("normal")).toBe(false);
    expect(tierRequiresElevatedPermission("late")).toBe(false);
    expect(tierRequiresElevatedPermission("significant_late")).toBe(true);
    expect(tierRequiresElevatedPermission("administrative_override")).toBe(true);
  });
});
