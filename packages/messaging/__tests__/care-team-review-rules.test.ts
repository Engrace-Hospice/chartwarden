// WP 3.9 - the pure care-team-removal rules: still-on-roster check, stable deduped item set, the per-event cap.
import { describe, expect, it } from "vitest";
import {
  CARE_TEAM_REVIEW_MAX_ITEMS,
  careTeamTriggerRef,
  reviewItemsFor,
  shouldRoute,
} from "../src/care-team";

describe("shouldRoute", () => {
  it("routes when the clinician is no longer on the roster", () => {
    expect(shouldRoute(["a", "b"], "c")).toBe(true);
  });
  it("does not route when the clinician is still on the roster", () => {
    expect(shouldRoute(["a", "b"], "b")).toBe(false);
  });
});

describe("reviewItemsFor", () => {
  it("deduplicates and sorts so a redelivery yields the same set", () => {
    expect(reviewItemsFor(["b", "a", "b"])).toEqual({ taskIds: ["a", "b"], truncated: 0 });
  });
  it("caps at the maximum and reports how many were left out", () => {
    const ids = Array.from({ length: CARE_TEAM_REVIEW_MAX_ITEMS + 3 }, (_, i) =>
      String(i).padStart(5, "0"),
    );
    const r = reviewItemsFor(ids);
    expect(r.taskIds).toHaveLength(CARE_TEAM_REVIEW_MAX_ITEMS);
    expect(r.truncated).toBe(3);
  });
});

describe("careTeamTriggerRef", () => {
  it("is the outbox event id, stable across redelivery", () => {
    expect(careTeamTriggerRef("evt-1")).toBe("evt-1");
  });
});
