// WP 3.9 - the pure care-team-removal rules: still-on-roster check, stable deduped item set, batching with no cap.
import { describe, expect, it } from "vitest";
import { careTeamTriggerRef, reviewItemBatches, shouldRoute } from "../src/care-team";

describe("shouldRoute", () => {
  it("routes when the clinician is no longer on the roster", () => {
    expect(shouldRoute(["a", "b"], "c")).toBe(true);
  });
  it("does not route when the clinician is still on the roster", () => {
    expect(shouldRoute(["a", "b"], "b")).toBe(false);
  });
});

describe("reviewItemBatches", () => {
  it("deduplicates and sorts so a redelivery yields the same set", () => {
    expect(reviewItemBatches(["b", "a", "b"])).toEqual([["a", "b"]]);
  });
  it("returns no batch for no tasks", () => {
    expect(reviewItemBatches([])).toEqual([]);
  });
  it("splits into ordered batches and drops nothing above 500 tasks", () => {
    const ids = Array.from({ length: 1234 }, (_, i) => String(i).padStart(5, "0"));
    const batches = reviewItemBatches([...ids].reverse(), 500);
    expect(batches.map((b) => b.length)).toEqual([500, 500, 234]);
    expect(batches.flat()).toEqual(ids);
  });
});

describe("careTeamTriggerRef", () => {
  it("is the outbox event id, stable across redelivery", () => {
    expect(careTeamTriggerRef("evt-1")).toBe("evt-1");
  });
});
