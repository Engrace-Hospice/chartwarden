import { describe, expect, it } from "vitest";
import { MASS_DELETE_FLOOR, massDeleteRefusal, xmlUnescape } from "../object-store-copy";

describe("object-store copy", () => {
  it("unescapes a SeaweedFS continuation token (the raw last key, XML-escaped)", () => {
    expect(xmlUnescape("a&amp;b=c#d?e&lt;&gt;&quot;&apos;&#38;&#x26;")).toBe(`a&b=c#d?e<>"'&&`);
    expect(xmlUnescape("&bogus;")).toBe("&bogus;");
  });

  it("refuses to empty a copy from an empty source, and caps deletions", () => {
    expect(massDeleteRefusal(0, 1003, 1003)).toMatch(/source bucket is empty/);
    expect(massDeleteRefusal(900, 1000, 100)).toBeNull();
    expect(massDeleteRefusal(899, 1000, 101)).toMatch(/101 of 1000/);
    expect(massDeleteRefusal(5, 5 + MASS_DELETE_FLOOR, MASS_DELETE_FLOOR)).toBeNull();
    expect(massDeleteRefusal(0, 0, 0)).toBeNull();
  });
});
