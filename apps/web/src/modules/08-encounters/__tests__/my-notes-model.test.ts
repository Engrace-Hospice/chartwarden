// ADR-0113 slice 1 — the pure half of My notes: labels, the Legacy rule, filters, KPI counts, and the deadline-first order.
import { describe, expect, it } from "vitest";
import {
  type NoteClosure,
  closureCounts,
  closureLabel,
  closureTone,
  deadlineText,
  isLegacyNote,
  matchesClosureFilter,
  noteHref,
  openNoteLabel,
  sortByDeadline,
} from "../my-notes-model";

const clocked = (stage: NoteClosure["stage"], deadlineAt: string): NoteClosure => ({
  clockStartedAt: "2026-11-16T00:00:00.000Z",
  deadlineAt,
  stage,
});
const LEGACY: NoteClosure = { clockStartedAt: null, deadlineAt: null, stage: "ok" };

describe("labels and tones", () => {
  it("a null clock is Legacy, whatever the stage says", () => {
    expect(isLegacyNote(LEGACY)).toBe(true);
    expect(closureLabel(LEGACY)).toBe("Legacy");
    expect(closureTone(LEGACY)).toBe("neutral");
    expect(closureLabel({ ...LEGACY, stage: "overdue" })).toBe("Legacy");
  });

  it("names each clocked stage and ranks the tones", () => {
    expect(closureLabel(clocked("ok", "2026-11-17T00:00:00.000Z"))).toBe("On track");
    expect(closureLabel(clocked("at_risk", "2026-11-17T00:00:00.000Z"))).toBe("At risk");
    expect(closureLabel(clocked("overdue", "2026-11-17T00:00:00.000Z"))).toBe("Overdue");
    expect(closureLabel(clocked("escalated", "2026-11-17T00:00:00.000Z"))).toBe("Escalated");
    expect(closureTone(clocked("at_risk", "2026-11-17T00:00:00.000Z"))).toBe("progress");
    expect(closureTone(clocked("overdue", "2026-11-17T00:00:00.000Z"))).toBe("warning");
    expect(closureTone(clocked("escalated", "2026-11-17T00:00:00.000Z"))).toBe("error");
  });

  it("shows a deadline for a clocked note and says plainly that a legacy note has none", () => {
    expect(deadlineText(clocked("ok", "2026-11-17T00:00:00.000Z"))).toMatch(/^Due /);
    expect(deadlineText(LEGACY)).toBe("No deadline");
  });
});

describe("filters and counts", () => {
  const rows = [
    { id: "a", closure: clocked("overdue", "2026-11-17T01:00:00.000Z") },
    { id: "b", closure: clocked("escalated", "2026-11-17T02:00:00.000Z") },
    { id: "c", closure: clocked("at_risk", "2026-11-17T03:00:00.000Z") },
    { id: "d", closure: clocked("ok", "2026-11-17T04:00:00.000Z") },
    { id: "e", closure: LEGACY },
  ];

  it("counts overdue (escalated included) and at risk; legacy and on-track notes count in neither", () => {
    expect(closureCounts(rows)).toEqual({ overdue: 2, atRisk: 1 });
  });

  it("filters: overdue covers escalated, legacy is only the clockless notes, empty keeps everything", () => {
    const pick = (filter: Parameters<typeof matchesClosureFilter>[1]) =>
      rows.filter((r) => matchesClosureFilter(r.closure, filter)).map((r) => r.id);
    expect(pick("overdue")).toEqual(["a", "b"]);
    expect(pick("at_risk")).toEqual(["c"]);
    expect(pick("legacy")).toEqual(["e"]);
    expect(pick("")).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("a legacy note never matches the at-risk or overdue filters, even with a stage on it", () => {
    const stale: NoteClosure = { clockStartedAt: null, deadlineAt: null, stage: "at_risk" };
    expect(matchesClosureFilter(stale, "at_risk")).toBe(false);
  });
});

describe("sortByDeadline", () => {
  it("puts the nearest deadline first and legacy notes last, keeping ties in their order, without mutating", () => {
    const input = [
      { id: "legacy-1", closure: LEGACY },
      { id: "later", closure: clocked("ok", "2026-11-18T09:00:00.000Z") },
      { id: "soonest", closure: clocked("overdue", "2026-11-17T01:00:00.000Z") },
      { id: "legacy-2", closure: LEGACY },
      { id: "tie-a", closure: clocked("ok", "2026-11-18T09:00:00.000Z") },
    ];
    const snapshot = input.map((r) => r.id);
    expect(sortByDeadline(input).map((r) => r.id)).toEqual([
      "soonest",
      "later",
      "tie-a",
      "legacy-1",
      "legacy-2",
    ]);
    expect(input.map((r) => r.id)).toEqual(snapshot);
  });
});

describe("noteHref", () => {
  const note = { id: "e-1", patientId: "p-1" };

  it("a draft opens the composer; a finalized note opens the read screen where it is signed", () => {
    expect(noteHref({ ...note, status: "draft" })).toBe("/patients/p-1/encounters/e-1/compose");
    expect(noteHref({ ...note, status: "finalized" })).toBe("/patients/p-1/encounters/e-1");
    expect(openNoteLabel("draft")).toBe("Continue Documentation");
    expect(openNoteLabel("finalized")).toBe("Review and Sign");
  });
});
