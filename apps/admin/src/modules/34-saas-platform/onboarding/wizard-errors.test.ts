import { describeOpsError } from "@chartwarden/ui";
import { describe, expect, it } from "vitest";
import {
  GUARD_COPY,
  WIZARD_ERROR_COPY,
  guardFailureLines,
  guardLabel,
  isAboutAnInput,
  viewHasMoved,
} from "./wizard-errors";

describe("WIZARD_ERROR_COPY", () => {
  it("a proxy 413 (no envelope) does not claim the API's 10 MiB limit and routes an under-limit file to engineering", () => {
    const copy = WIZARD_ERROR_COPY.PAYLOAD_TOO_LARGE ?? "";
    expect(copy).toContain("refused this upload as too large");
    expect(copy).not.toMatch(/at most 10 MiB/);
    expect(copy).toContain("under 10 MiB, tell engineering");
  });

  it("the API's own BAA_UPLOAD_TOO_LARGE states the 10 MiB limit", () => {
    expect(WIZARD_ERROR_COPY.BAA_UPLOAD_TOO_LARGE).toContain("at most 10 MiB");
  });

  it("names the route kit's stale-version code (409 STALE_VERSION): it changed, it is reloaded, enter the change again", () => {
    const copy = WIZARD_ERROR_COPY.STALE_VERSION ?? "";
    expect(copy).toContain("changed since you opened it");
    expect(copy).toContain("enter your change again");
  });
});

describe("isAboutAnInput", () => {
  it("is true for a validation refusal that names a field other than the reason", () => {
    expect(isAboutAnInput({ kind: "validation", fieldErrors: { npi: "x" } })).toBe(true);
    expect(isAboutAnInput({ kind: "validation", fieldErrors: { reason: "x", npi: "y" } })).toBe(
      true,
    );
  });
  it("is false when only the reason is refused, or for any other kind of refusal", () => {
    expect(isAboutAnInput({ kind: "validation", fieldErrors: { reason: "x" } })).toBe(false);
    expect(isAboutAnInput({ kind: "conflict", fieldErrors: {} })).toBe(false);
  });
});

describe("viewHasMoved", () => {
  it.each([
    "ONBOARDING_TASK_CHANGED",
    "ONBOARDING_STEP_ALREADY_SETTLED",
    "ONBOARDING_STEP_NOT_SETTLED",
    "TENANT_NOT_ONBOARDING",
    "GO_LIVE_NOT_ATTESTED",
    "GO_LIVE_ATTESTATION_STALE",
    "ACTIVATION_GUARDS_FAILED",
  ])("%s says the view on screen is out of date", (code) => {
    expect(viewHasMoved({ code })).toBe(true);
  });
  it("is false for a refusal that says nothing moved, and for no code", () => {
    expect(viewHasMoved({ code: "GO_LIVE_SAME_PERSON" })).toBe(false);
    expect(viewHasMoved({ code: null })).toBe(false);
  });
});

describe("guardLabel", () => {
  it("uses the operator's words for a known guard", () => {
    expect(guardLabel("baaExecuted")).toBe(GUARD_COPY.baaExecuted);
  });
  it("shows an unknown guard with the server's sentence, else a generic line that names it: never dropped, never a bare key", () => {
    expect(guardLabel("aNewGuard", "The new check does not pass")).toBe(
      "The new check does not pass",
    );
    expect(guardLabel("aNewGuard")).toBe("A go-live check does not pass (aNewGuard)");
  });
  it("lists each failing guard then each open step, in the order the server gave them", () => {
    expect(
      guardFailureLines([
        { field: "guard", code: "baaExecuted", message: "x" },
        { field: "templateKey", code: "locations_seeded", message: "Locations is pending" },
      ]),
    ).toEqual([GUARD_COPY.baaExecuted, "Locations is pending"]);
  });
});

describe("a rate-limited write (nginx's per-address limit or the API's own)", () => {
  it("tells the operator nothing was saved and to wait, whether or not the API's envelope came with it", () => {
    const bare = describeOpsError(
      "<html>429 Too Many Requests</html>",
      { status: 429 },
      WIZARD_ERROR_COPY,
    );
    const enveloped = describeOpsError(
      { error: { code: "RATE_LIMITED", message: "rate limit exceeded", correlationId: "c-1" } },
      { status: 429 },
      WIZARD_ERROR_COPY,
    );
    for (const failure of [bare, enveloped]) {
      expect(failure.kind).toBe("rate-limited");
      expect(failure.message).toBe(
        "Too many attempts. Nothing was saved. Wait before trying again; some limits take ten minutes to reset.",
      );
    }
  });

  it("a Retry-After the response names is said in words", () => {
    const failure = describeOpsError(
      "",
      { status: 429, headers: { get: () => "45" } },
      WIZARD_ERROR_COPY,
    );
    expect(failure.message).toBe("Too many attempts. Wait 45 seconds, then try again.");
  });
});
