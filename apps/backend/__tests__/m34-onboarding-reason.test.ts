// The platform operator's `reason` lands verbatim-looking in the tenant-visible `audit_event.context`, so it is
// normalised first: control and format characters (NUL, zero-width, bidi overrides) are removed, every run of
// whitespace becomes one space, and the 8-500 bounds are judged on what is left.
import { describe, expect, it } from "vitest";
import {
  ONBOARDING_REASON_MAX,
  ONBOARDING_REASON_MIN,
  normalizeReason,
} from "../src/modules/34-saas-tenant-platform/routes/platform/onboarding-data-typebox";

describe("normalizeReason", () => {
  it("turns line breaks, tabs and other whitespace into single spaces, never joining words", () => {
    expect(normalizeReason("ticket\nCHG-1\r\n\tsee  notes here ok")).toBe(
      "ticket CHG-1 see notes here ok",
    );
  });

  it("removes control, zero-width and bidi characters", () => {
    expect(normalizeReason("a\u0000b\u0007c\u200bd\u200ee\u202ef\u2066g\u2069h")).toBe("abcdefgh");
    expect(normalizeReason("ticket \u200b CHG-1")).toBe("ticket CHG-1");
  });

  it("trims and keeps ordinary punctuation and non-Latin letters", () => {
    expect(normalizeReason("  Kundenanfrage, Ticket #4521 (Zoë) ✓  ")).toBe(
      "Kundenanfrage, Ticket #4521 (Zoë) ✓",
    );
  });

  it("can leave nothing at all", () => {
    expect(normalizeReason(" \u200b\n\u0000 ")).toBe("");
  });

  it("exposes the bounds the route judges the normalised text against", () => {
    expect([ONBOARDING_REASON_MIN, ONBOARDING_REASON_MAX]).toEqual([8, 500]);
  });
});
