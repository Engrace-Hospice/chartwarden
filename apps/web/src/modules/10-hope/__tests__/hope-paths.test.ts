import { describe, expect, it } from "vitest";
import { COMPLETE_SFV_PARAM, completeSfvPath } from "../hope-paths";

describe("completeSfvPath", () => {
  it("names the triggering assessment and asks for its completion dialog", () => {
    expect(completeSfvPath("0a1b2c3d-4444-4444-8444-0a1b2c3d4e5f")).toBe(
      `/hope/assessments/0a1b2c3d-4444-4444-8444-0a1b2c3d4e5f?${COMPLETE_SFV_PARAM}=1`,
    );
  });

  it("encodes an id that is not path-safe, so it cannot add a segment or a query of its own", () => {
    expect(completeSfvPath("a/b?c=1#d")).toBe(
      `/hope/assessments/a%2Fb%3Fc%3D1%23d?${COMPLETE_SFV_PARAM}=1`,
    );
  });
});
