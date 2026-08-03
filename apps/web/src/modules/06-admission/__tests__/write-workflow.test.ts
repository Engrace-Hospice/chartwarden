// M6 Admission — `write-workflow.ts` (TASK-031). Mirrors M23's write-workflow.test.ts.
import { describe, expect, it } from "vitest";
import { authFailureRedirect } from "../write-workflow";

describe("authFailureRedirect", () => {
  it("routes a 401 (session gone) to /login, regardless of any error code", () => {
    expect(authFailureRedirect(401, undefined, "/referrals/r1")).toBe("/login");
    expect(authFailureRedirect(401, "FORBIDDEN", "/referrals/r1")).toBe("/login");
  });

  it("routes a STEP_UP_REQUIRED denial to /step-up with the current path as returnTo", () => {
    const dest = authFailureRedirect(403, "STEP_UP_REQUIRED", "/admissions/a1");
    expect(dest).toBe("/step-up?returnTo=%2Fadmissions%2Fa1");
  });

  it("does NOT redirect an ordinary permission denial — that is a dead end step-up can't fix", () => {
    expect(authFailureRedirect(403, "FORBIDDEN", "/referrals/r1")).toBeNull();
  });

  it("does not redirect on unrelated failures (412/422/503)", () => {
    expect(authFailureRedirect(412, "VERSION_MISMATCH", "/referrals/r1")).toBeNull();
    expect(authFailureRedirect(422, "VALIDATION_FAILED", "/referrals/r1")).toBeNull();
    expect(authFailureRedirect(503, undefined, "/referrals/r1")).toBeNull();
    expect(authFailureRedirect(undefined, undefined, "/referrals/r1")).toBeNull();
  });
});
