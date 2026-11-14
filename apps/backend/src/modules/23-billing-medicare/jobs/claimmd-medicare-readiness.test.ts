import { describe, expect, it } from "vitest";
import { claimMdEvidenceAccountMatches } from "../claimmd-evidence/store";
import { claimMdEnrollmentStatusReady } from "./clearinghouse-context";

describe("Claim.MD Medicare enrollment readiness", () => {
  it("requires exactly one applicable verified authorization or evidenced exemption", () => {
    expect(claimMdEnrollmentStatusReady("verified")).toBe(true);
    expect(claimMdEnrollmentStatusReady("not_required")).toBe(true);
    for (const status of [null, "unknown", "pending", "rejected", "suspended", "expired"]) {
      expect(claimMdEnrollmentStatusReady(status)).toBe(false);
    }
    expect(claimMdEnrollmentStatusReady("verified", 0)).toBe(false);
    expect(claimMdEnrollmentStatusReady("verified", 2)).toBe(false);
  });

  it("allows in-doubt reconciliation only through the exact original account and mode", () => {
    const original = { accountReference: "tenant:org-a", usage: "test" as const };
    expect(claimMdEvidenceAccountMatches(original, original)).toBe(true);
    expect(
      claimMdEvidenceAccountMatches(original, { accountReference: "tenant:org-b", usage: "test" }),
    ).toBe(false);
    expect(
      claimMdEvidenceAccountMatches(original, {
        accountReference: "tenant:org-a",
        usage: "production",
      }),
    ).toBe(false);
    expect(claimMdEvidenceAccountMatches(null, original)).toBe(false);
  });
});
