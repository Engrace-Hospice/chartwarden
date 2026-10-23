// M25 milestone 7a-1 - the two new watches: recorded-deadline alerts (once per boundary) and the audit
// no-deadline alert (once). Pure over fake stores.
import { describe, expect, it } from "vitest";
import { runAuditNoDeadlineWatch } from "../jobs/audit-no-deadline-watch";
import { runRecordedDeadlineWatch } from "../jobs/recorded-deadline-watch";

const NOW = new Date("2026-03-01T15:00:00.000Z");

describe("runRecordedDeadlineWatch", () => {
  const row = (over = {}) => ({
    id: "d1",
    subjectKind: "appeal" as const,
    subjectId: "a1",
    dueOn: "2026-03-07",
    zone: "America/New_York",
    satisfiedOn: null,
    lastAlertedBoundary: null,
    ...over,
  });

  it("emits a PHI-free alert at the boundary and asks to mark it", async () => {
    const out = await runRecordedDeadlineWatch({ openDeadlines: async () => [row()] }, NOW);
    expect(out.alerts).toEqual([
      {
        kind: "deadline.recorded_approaching",
        detail: { deadlineId: "d1", subjectKind: "appeal", subjectId: "a1", daysRemaining: 7 },
      },
    ]);
    expect(out.marks).toEqual([{ id: "d1", boundary: 7 }]);
  });

  it("is silent for a past date and for a boundary already alerted", async () => {
    const out = await runRecordedDeadlineWatch(
      {
        openDeadlines: async () => [
          row({ id: "past", dueOn: "2026-02-01" }),
          row({ id: "again", lastAlertedBoundary: 7 }),
        ],
      },
      NOW,
    );
    expect(out.alerts).toEqual([]);
    expect(out.marks).toEqual([]);
  });
});

describe("runAuditNoDeadlineWatch", () => {
  const row = (over = {}) => ({
    id: "r1",
    state: "received",
    createdAt: "2026-02-25T00:00:00.000Z",
    hasDeadline: false,
    alreadyAlerted: false,
    ...over,
  });

  it("alerts once for an old request with no deadline", async () => {
    const out = await runAuditNoDeadlineWatch({ openAudits: async () => [row()] }, NOW);
    expect(out.alerts).toEqual([
      { kind: "audit.no_deadline_recorded", detail: { auditRequestId: "r1", daysOpen: 4 } },
    ]);
    expect(out.alertedIds).toEqual(["r1"]);
  });

  it("is silent when a deadline exists, when already alerted, or when too new", async () => {
    const out = await runAuditNoDeadlineWatch(
      {
        openAudits: async () => [
          row({ id: "has", hasDeadline: true }),
          row({ id: "done", alreadyAlerted: true }),
          row({ id: "new", createdAt: "2026-02-28T12:00:00.000Z" }),
        ],
      },
      NOW,
    );
    expect(out.alerts).toEqual([]);
  });
});
