// M23 Billing — Medicare — `write-workflow.ts` (TASK-021/FLOW-008). Before this, a 401/403 from a claim
// write just showed a dead-end inline sentence, even when the real fix (the existing /step-up screen) was
// one redirect away — and an in-progress ceremony/wizard draft was silently discarded by that redirect.
import { describe, expect, it } from "vitest";
import { authFailureRedirect, clearDraft, loadDraft, saveDraft } from "../write-workflow";

describe("authFailureRedirect", () => {
  it("routes a 401 (session gone) to /login, regardless of any error code", () => {
    expect(authFailureRedirect(401, undefined, "/billing/claims/abc")).toBe("/login");
    expect(authFailureRedirect(401, "FORBIDDEN", "/billing/claims/abc")).toBe("/login");
  });

  it("routes a STEP_UP_REQUIRED denial to /step-up with the current path as returnTo", () => {
    const dest = authFailureRedirect(403, "STEP_UP_REQUIRED", "/billing/claims/abc/validation");
    expect(dest).toBe("/step-up?returnTo=%2Fbilling%2Fclaims%2Fabc%2Fvalidation");
  });

  it("preserves an existing query string in returnTo", () => {
    const dest = authFailureRedirect(403, "STEP_UP_REQUIRED", "/billing/claims/abc?ceremony=void");
    expect(dest).toBe("/step-up?returnTo=%2Fbilling%2Fclaims%2Fabc%3Fceremony%3Dvoid");
  });

  it("does NOT redirect an ordinary permission denial — that is a dead end step-up can't fix", () => {
    expect(authFailureRedirect(403, "FORBIDDEN", "/billing/claims/abc")).toBeNull();
    expect(
      authFailureRedirect(403, "OVERRIDE_ROLE_NOT_ELIGIBLE", "/billing/claims/abc"),
    ).toBeNull();
  });

  it("does not redirect on unrelated failures (412/422/503)", () => {
    expect(authFailureRedirect(412, "VERSION_CONFLICT", "/billing/claims/abc")).toBeNull();
    expect(authFailureRedirect(422, "VALIDATION_FAILED", "/billing/claims/abc")).toBeNull();
    expect(authFailureRedirect(503, undefined, "/billing/claims/abc")).toBeNull();
    expect(authFailureRedirect(undefined, undefined, "/billing/claims/abc")).toBeNull();
  });
});

describe("draft cache — process memory only, never browser storage", () => {
  it("round-trips a saved draft and clears it on demand", () => {
    const key = "test-ceremony:claim-1";
    expect(loadDraft(key)).toBeUndefined();
    saveDraft(key, { ceremony: "void", reason: "family requested cancellation" });
    expect(loadDraft(key)).toEqual({ ceremony: "void", reason: "family requested cancellation" });
    clearDraft(key);
    expect(loadDraft(key)).toBeUndefined();
  });

  it("keeps distinct keys independent", () => {
    saveDraft("a", 1);
    saveDraft("b", 2);
    expect(loadDraft("a")).toBe(1);
    expect(loadDraft("b")).toBe(2);
    clearDraft("a");
    expect(loadDraft("a")).toBeUndefined();
    expect(loadDraft("b")).toBe(2);
    clearDraft("b");
  });
});
