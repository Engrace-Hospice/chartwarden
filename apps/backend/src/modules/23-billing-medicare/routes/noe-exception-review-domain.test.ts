import { describe, expect, it } from "vitest";
import { initialNoeExceptionReviewStatus, recordedExternalDecisionStatus } from "./noe-exception-review-domain";

describe("NOE exception review state labels", () => {
  it("requires protected evidence and does not treat a late filing as approval", () => {
    expect(initialNoeExceptionReviewStatus(false)).toBe("evidence_required");
    expect(initialNoeExceptionReviewStatus(true)).toBe("ready_for_external_request");
    expect(initialNoeExceptionReviewStatus(true)).not.toContain("approved");
  });

  it("records an operator-attested external decision without calling it verified", () => {
    expect(recordedExternalDecisionStatus("approved")).toBe("external_approved_recorded");
    expect(recordedExternalDecisionStatus("denied")).toBe("external_denied_recorded");
  });
});
