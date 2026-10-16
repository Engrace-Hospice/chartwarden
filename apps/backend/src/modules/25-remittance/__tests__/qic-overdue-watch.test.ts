// M25 milestone 4 - the QIC overdue cron handler: one alert per under-review reconsideration whose recorded decision
// date has passed and that has no escalation request yet; nothing before the due day ends, without a receipt date,
// or once escalation is requested.
import { describe, expect, it } from "vitest";
import { type QicOverdueRow, runQicOverdueWatch } from "../jobs/qic-overdue";

const now = new Date("2026-03-10T12:00:00Z");

const row = (over: Partial<QicOverdueRow> = {}): QicOverdueRow => ({
  id: "a",
  receivedOn: "2026-01-05", // + 60 days = 2026-03-06
  extensions: [],
  escalationRequested: false,
  ...over,
});
const asStore = (rows: QicOverdueRow[]) => ({
  async overdueCandidates() {
    return rows;
  },
});

describe("runQicOverdueWatch", () => {
  it("alerts once per overdue reconsideration with the days overdue", async () => {
    const { alerts } = await runQicOverdueWatch(asStore([row()]), now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: "appeal.qic_decision_overdue",
      appealCaseId: "a",
      detail: { appealCaseId: "a", daysOverdue: 4 },
    });
  });

  it("counts a recorded late-evidence extension before calling it overdue", async () => {
    const extended = row({ extensions: [{ days: 14, recordedAt: "2026-02-01T00:00:00Z" }] }); // due 2026-03-20
    expect((await runQicOverdueWatch(asStore([extended]), now)).alerts).toEqual([]);
  });

  it("stays silent once an escalation request is recorded", async () => {
    const requested = row({ escalationRequested: true });
    expect((await runQicOverdueWatch(asStore([requested]), now)).alerts).toEqual([]);
  });

  it("never fires before the due day has ended in the latest-ending US zone", async () => {
    // due 2026-03-06; at 2026-03-07T10:00Z it is still 2026-03-06 in American Samoa (UTC-11)
    const early = new Date("2026-03-07T10:00:00Z");
    expect((await runQicOverdueWatch(asStore([row()]), early)).alerts).toEqual([]);
  });
});
