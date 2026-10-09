import { describe, expect, it } from "vitest";
import { normalizeE164 } from "./e164";

describe("normalizeE164", () => {
  it("normalises common US formats to E.164", () => {
    for (const raw of [
      "(415) 555-2671",
      "415-555-2671",
      "415.555.2671",
      "+1 415 555 2671",
      "4155552671",
    ]) {
      expect(normalizeE164(raw, "US")).toEqual({ ok: true, e164: "+14155552671" });
    }
  });

  it("rejects numbers too short to dial", () => {
    expect(normalizeE164("(555) 123", "US")).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects emergency and service short codes", () => {
    for (const raw of ["911", "112", "988", "411", "+1 911"]) {
      expect(normalizeE164(raw, "US").ok).toBe(false);
    }
  });

  it("rejects an extension (an automated call cannot dial one)", () => {
    expect(normalizeE164("415-555-2671 ext 12", "US")).toEqual({ ok: false, reason: "extension" });
  });

  it("rejects non-string and blank input", () => {
    expect(normalizeE164("   ", "US").ok).toBe(false);
    expect(normalizeE164(undefined as unknown as string, "US").ok).toBe(false);
  });

  it("accepts an international number when it carries its own plus prefix", () => {
    expect(normalizeE164("+44 20 7946 0958", "US")).toEqual({ ok: true, e164: "+442079460958" });
  });

  it("never echoes the input in the failure result", () => {
    expect(JSON.stringify(normalizeE164("(555) 123", "US"))).not.toContain("555");
  });
});
