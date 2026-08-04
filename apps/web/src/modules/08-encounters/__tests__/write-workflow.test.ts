// M8 Encounters — `write-workflow.ts` (TASK-031). Mirrors M23's write-workflow.test.ts: before this, a
// 401/403 from a sign/cosign ceremony had no principled redirect at all.
import { describe, expect, it } from "vitest";
import { authFailureRedirect } from "../write-workflow";

describe("authFailureRedirect", () => {
  it("routes a 401 (session gone) to /login, regardless of any error code", () => {
    expect(authFailureRedirect(401, undefined, "/patients/p1/encounters/e1")).toBe("/login");
    expect(authFailureRedirect(401, "FORBIDDEN", "/patients/p1/encounters/e1")).toBe("/login");
  });

  it("routes a STEP_UP_REQUIRED denial to /step-up with the current path as returnTo", () => {
    const dest = authFailureRedirect(403, "STEP_UP_REQUIRED", "/patients/p1/encounters/e1");
    expect(dest).toBe("/step-up?returnTo=%2Fpatients%2Fp1%2Fencounters%2Fe1");
  });

  it("does NOT redirect an ordinary permission denial — that is a dead end step-up can't fix", () => {
    expect(authFailureRedirect(403, "FORBIDDEN", "/patients/p1/encounters/e1")).toBeNull();
  });

  it("does not redirect on unrelated failures (412/422/503)", () => {
    expect(
      authFailureRedirect(412, "STEP_UP_AUTH_REQUIRED", "/patients/p1/encounters/e1"),
    ).toBeNull();
    expect(authFailureRedirect(422, "VALIDATION_FAILED", "/patients/p1/encounters/e1")).toBeNull();
    expect(authFailureRedirect(503, undefined, "/patients/p1/encounters/e1")).toBeNull();
    expect(authFailureRedirect(undefined, undefined, "/patients/p1/encounters/e1")).toBeNull();
  });
});
