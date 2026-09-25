import { describe, expect, it } from "vitest";
import { ATTENTION_STATUSES, workspaceCount, workspaceStatus } from "../medication-workspace";

describe("M12 medication workspace filters", () => {
  it("defaults an absent or invalid query filter to All", () => {
    expect(workspaceStatus(null)).toBe("all");
    expect(workspaceStatus("not-a-status")).toBe("all");
  });
  it("uses server lifecycle totals for KPI counts", () => {
    const counts = { draft: 2, pending_signature: 1, active: 4, verbal_pending: 1, nack_received: 1 };
    expect(workspaceCount("all", counts)).toBe(9);
    expect(workspaceCount("draft", counts)).toBe(2);
    expect(workspaceCount("needs_attention", counts)).toBe(2);
    expect(ATTENTION_STATUSES).toContain("transmission_failed");
  });
});
