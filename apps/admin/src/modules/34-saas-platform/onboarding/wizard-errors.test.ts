import { describe, expect, it } from "vitest";
import { WIZARD_ERROR_COPY } from "./wizard-errors";

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
