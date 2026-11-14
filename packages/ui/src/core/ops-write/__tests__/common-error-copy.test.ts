// One code, one sentence: the codes every lane's versioned, screened or limited writes share live in one map the lanes spread.
import { describe, expect, it } from "vitest";
import { COMMON_OPS_ERROR_COPY } from "../common-error-copy";

describe("COMMON_OPS_ERROR_COPY", () => {
  it.each([
    "IF_MATCH_REQUIRED",
    "VERSION_CONFLICT",
    "STALE_VERSION",
    "EVIDENCE_LOOKS_LIKE_PHI",
    "RATE_LIMITED",
    "TENANT_NOT_ONBOARDING",
  ])("has a sentence for %s", (code) => {
    expect((COMMON_OPS_ERROR_COPY[code] ?? "").length).toBeGreaterThan(20);
  });

  it("says a stale record was reloaded and the change must be entered again", () => {
    for (const code of ["IF_MATCH_REQUIRED", "VERSION_CONFLICT", "STALE_VERSION"]) {
      expect(COMMON_OPS_ERROR_COPY[code]).toContain("It has been reloaded");
      expect(COMMON_OPS_ERROR_COPY[code]).toContain("enter your change again");
    }
  });

  it("speaks no lane's voice: it names neither a tenant nor an operator", () => {
    for (const sentence of Object.values(COMMON_OPS_ERROR_COPY)) {
      expect(sentence).not.toMatch(/\b(your organization|operator|ChartWarden)\b/i);
    }
  });
});
