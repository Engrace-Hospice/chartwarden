// M25 — the ADR deadline cron handler (milestone 2a): one alert per open ADR at its tightest T-boundary,
// nothing when more than 30 days remain or the due moment has passed.
import { describe, expect, it } from "vitest";
import { runAdrDeadlineWatch } from "../jobs/m25-jobs";

const now = new Date("2026-03-01T12:00:00Z");
const due = (days: number) => new Date(now.getTime() + days * 864e5).toISOString();

describe("runAdrDeadlineWatch", () => {
  it("alerts at the tightest boundary and ignores far-off and overdue cases", async () => {
    const store = {
      async watchableAdrs() {
        return [
          { id: "a", responseDueAt: due(6.5) }, // ~7 days -> T-7
          { id: "b", responseDueAt: due(0.5) }, // inside a day -> T-1
          { id: "c", responseDueAt: due(40) }, // far off -> no alert
          { id: "d", responseDueAt: due(-1) }, // past -> no alert
        ];
      },
    };
    const { alerts } = await runAdrDeadlineWatch(store, now);
    expect(alerts.map((a) => [a.kind, a.detail])).toEqual([
      ["adr.deadline_approaching", { adrCaseId: "a", daysRemaining: 7 }],
      ["adr.deadline_approaching", { adrCaseId: "b", daysRemaining: 1 }],
    ]);
  });
});
