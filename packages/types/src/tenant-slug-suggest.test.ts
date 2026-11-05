import { describe, expect, it } from "vitest";
import { suggestTenantSlug, validateTenantSlug } from "./tenant-slug";

describe("suggestTenantSlug", () => {
  it.each([
    ["Sunrise Hospice of Ohio, LLC", "sunrise-hospice-of-ohio"],
    ["Cedar Ridge Hospice LLC", "cedar-ridge-hospice"],
    ["Harbor Hospice, Inc.", "harbor-hospice"],
    ["Acme Care Corp.", "acme-care"],
    ["Acme Care Corporation", "acme-care"],
    ["Pine Valley Ltd", "pine-valley"],
    ["Pine Valley Limited", "pine-valley"],
    ["Lakeside Hospice PLLC", "lakeside-hospice"],
    ["Lakeside Hospice, L.L.C.", "lakeside-hospice"],
    ["Meadow Partners LP", "meadow-partners"],
    ["Birch Hospice Co.", "birch-hospice"],
    ["Birch Hospice Co., Inc.", "birch-hospice"],
    ["Maple & Pine Hospice", "maple-pine-hospice"],
    ["St. Mary's Hospice", "st-marys-hospice"],
    ["  Sunrise   Hospice  ", "sunrise-hospice"],
    ["Café Ñandú Hospice", "cafe-nandu-hospice"],
    ["Hospice of the Valley", "hospice-of-the-valley"],
  ])("turns %j into %j", (legalName, expected) => {
    expect(suggestTenantSlug(legalName)).toBe(expected);
  });

  it("keeps the entity word when it is the whole name", () => {
    expect(suggestTenantSlug("LLC")).toBe("llc");
  });

  it.each(["", "   ", "AB", "A.B.", "API", "App LLC", "Admin, Inc.", "!!!", "株式会社"])(
    "returns an empty string when %j cannot make a valid slug",
    (legalName) => {
      expect(suggestTenantSlug(legalName)).toBe("");
    },
  );

  it("trims to 63 characters without a trailing hyphen", () => {
    const long = `${"abcdefghi ".repeat(10)}hospice`;

    const slug = suggestTenantSlug(long);

    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith("-")).toBe(false);
    expect(validateTenantSlug(slug)).toEqual({ ok: true });
  });

  it("never returns a slug validateTenantSlug refuses", () => {
    for (const name of [
      "Sunrise Hospice of Ohio, LLC",
      "x".repeat(200),
      "-- a --",
      "9 Lives Hospice",
      "xn--bcher Hospice",
      "Hospice\u0000Care",
    ]) {
      const slug = suggestTenantSlug(name);
      if (slug !== "") expect(validateTenantSlug(slug)).toEqual({ ok: true });
    }
  });
});
