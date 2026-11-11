import { isSentinelIncident } from "@chartwarden/quality";
import { describe, expect, it } from "vitest";

describe("M30 incident paging predicate", () => {
  it("pages every critical incident, including kinds formerly marked ineligible", () => {
    expect(isSentinelIncident("complaint", "critical")).toBe(true);
    expect(isSentinelIncident("other_safety_event", "critical")).toBe(true);
  });

  it("pages every abuse allegation regardless of severity", () => {
    expect(isSentinelIncident("allegation_of_abuse", "minor")).toBe(true);
  });

  it("does not page a non-critical incident that is not an abuse allegation", () => {
    expect(isSentinelIncident("fall", "severe")).toBe(false);
  });
});
