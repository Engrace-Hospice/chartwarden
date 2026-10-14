// WP 3.5 - read-time item summaries: a failing source marks only its own items unavailable, a missing record is gone, a
// follow-up that is no longer an open obligation says so, and a task shows its current status.
import { describe, expect, it } from "vitest";
import { type HandoffSummaryPorts, resolveItemSummaries } from "./handoff-summaries";
import { ORG, P1, REFILL, SFV, VISIT } from "./handoff-test-kit";

const TASK = "00000000-0000-4000-8000-0000000000f9";
const ports = (over: Partial<HandoffSummaryPorts> = {}): HandoffSummaryPorts => ({
  visit: async () => ({ status: "scheduled", occurredAt: "2026-10-14T13:00:00.000Z" }),
  refill: async () => null,
  openSfv: async () => null,
  taskStatuses: async () => new Map([[TASK, "accepted"]]),
  ...over,
});
const items = [
  { id: "i1", kind: "visit" as const, refId: VISIT, patientId: P1 },
  { id: "i2", kind: "refill_request" as const, refId: REFILL, patientId: P1 },
  { id: "i3", kind: "symptom_followup" as const, refId: SFV, patientId: P1 },
  { id: "i4", kind: "task" as const, refId: TASK, patientId: P1 },
  { id: "i5", kind: "patient" as const, refId: P1, patientId: P1 },
];

describe("resolveItemSummaries", () => {
  it("resolves each kind through its own source", async () => {
    const out = await resolveItemSummaries(ports(), ORG, items);
    expect(out.get("i1")).toEqual({
      state: "ok",
      status: "scheduled",
      occurred_at: "2026-10-14T13:00:00.000Z",
    });
    expect(out.get("i2")).toEqual({ state: "gone" });
    expect(out.get("i3")).toEqual({ state: "ok", still_open: false });
    expect(out.get("i4")).toEqual({ state: "ok", status: "accepted" });
    expect(out.get("i5")).toEqual({ state: "ok" });
  });

  it("marks only the failing source's items unavailable", async () => {
    const out = await resolveItemSummaries(
      ports({
        visit: async () => {
          throw new Error("seam down");
        },
      }),
      ORG,
      items,
    );
    expect(out.get("i1")).toEqual({ state: "unavailable" });
    expect(out.get("i4")?.state).toBe("ok");
  });

  it("marks task items unavailable when the task read fails", async () => {
    const out = await resolveItemSummaries(
      ports({
        taskStatuses: async () => {
          throw new Error("db down");
        },
      }),
      ORG,
      items,
    );
    expect(out.get("i4")).toEqual({ state: "unavailable" });
    expect(out.get("i1")?.state).toBe("ok");
  });
});
