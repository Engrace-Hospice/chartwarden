import { describe, expect, it } from "vitest";
import { evaluateFixedHopeAttention, evaluateSfvAttention } from "../src/attention";

const NOW = "2026-09-10T12:00:00.000Z";

describe("HOPE fixed timepoint attention", () => {
  it("maps workflow_not_initialized to an operational workflow issue, not overdue", () => {
    expect(
      evaluateFixedHopeAttention({
        kind: "02_huv1",
        workflowStatus: "workflow_not_initialized",
        windowOpensAt: null,
        windowClosesAt: null,
        lateDeadlineAt: null,
        completedAt: null,
        nowIso: NOW,
      }),
    ).toMatchObject({ state: "workflow_issue", severity: "warn", action: "REPAIR_WORKFLOW" });
  });

  it("maps not_applicable, completed, and skipped to no active attention", () => {
    for (const workflowStatus of ["not_applicable", "completed", "skipped"] as const) {
      expect(
        evaluateFixedHopeAttention({
          kind: "05_discharge",
          workflowStatus,
          windowOpensAt: "2026-09-01T00:00:00.000Z",
          windowClosesAt: "2026-09-08T23:59:59.999Z",
          lateDeadlineAt: "2026-09-15T23:59:59.999Z",
          completedAt: workflowStatus === "completed" ? NOW : null,
          nowIso: NOW,
        }).state,
      ).toBe("none");
    }
  });

  it("keeps upcoming informational", () => {
    expect(
      evaluateFixedHopeAttention({
        kind: "03_huv2",
        workflowStatus: "upcoming",
        windowOpensAt: "2026-09-12T00:00:00.000Z",
        windowClosesAt: "2026-09-26T23:59:59.999Z",
        lateDeadlineAt: "2026-10-03T23:59:59.999Z",
        completedAt: null,
        nowIso: NOW,
      }),
    ).toMatchObject({ state: "upcoming", severity: "info", action: "NONE" });
  });

  it("maps open far from deadline to none, then due_soon and due by central policy", () => {
    const base = {
      kind: "02_huv1" as const,
      workflowStatus: "open" as const,
      windowOpensAt: "2026-09-02T00:00:00.000Z",
      lateDeadlineAt: "2026-09-18T23:59:59.999Z",
      completedAt: null,
      nowIso: NOW,
    };
    expect(
      evaluateFixedHopeAttention({ ...base, windowClosesAt: "2026-09-20T23:59:59.999Z" }).state,
    ).toBe("none");
    expect(
      evaluateFixedHopeAttention({ ...base, windowClosesAt: "2026-09-12T23:59:59.999Z" }).state,
    ).toBe("due_soon");
    expect(
      evaluateFixedHopeAttention({ ...base, windowClosesAt: "2026-09-11T00:00:00.000Z" }).state,
    ).toBe("due");
  });

  it("maps late to overdue attention and expired to window_expired", () => {
    const base = {
      kind: "02_huv1" as const,
      windowOpensAt: "2026-09-02T00:00:00.000Z",
      windowClosesAt: "2026-09-09T23:59:59.999Z",
      lateDeadlineAt: "2026-09-18T23:59:59.999Z",
      completedAt: null,
      nowIso: NOW,
    };
    expect(evaluateFixedHopeAttention({ ...base, workflowStatus: "late" }).state).toBe("overdue");
    expect(evaluateFixedHopeAttention({ ...base, workflowStatus: "expired" }).state).toBe(
      "window_expired",
    );
  });
});

describe("HOPE SFV attention", () => {
  it("maps open SFVs by dueAt and preserves real terminal lifecycle states", () => {
    expect(
      evaluateSfvAttention({
        status: "open",
        dueAt: "2026-09-20T00:00:00.000Z",
        completedAt: null,
        nowIso: NOW,
      }).state,
    ).toBe("none");
    expect(
      evaluateSfvAttention({
        status: "open",
        dueAt: "2026-09-12T00:00:00.000Z",
        completedAt: null,
        nowIso: NOW,
      }).state,
    ).toBe("due_soon");
    expect(
      evaluateSfvAttention({
        status: "open",
        dueAt: "2026-09-10T10:00:00.000Z",
        completedAt: null,
        nowIso: NOW,
      }).state,
    ).toBe("due");
  });

  it("maps overdue, missed, and completed without forcing SFV into fixed-RFA states", () => {
    expect(
      evaluateSfvAttention({ status: "overdue", dueAt: NOW, completedAt: null, nowIso: NOW }).state,
    ).toBe("overdue");
    expect(
      evaluateSfvAttention({ status: "missed", dueAt: NOW, completedAt: null, nowIso: NOW }).state,
    ).toBe("missed");
    expect(
      evaluateSfvAttention({
        status: "completed",
        dueAt: NOW,
        completedAt: NOW,
        nowIso: NOW,
      }).state,
    ).toBe("none");
  });
});
