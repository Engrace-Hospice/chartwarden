// M25 milestone 6a - the proof-missing cron handler: one alert per needs_manual attempt past the threshold, IDs and
// counts only; nothing for a young attempt.
import { describe, expect, it } from "vitest";
import { type ProofMissingRow, runSubmissionProofWatch } from "../jobs/submission-proof-watch";

const now = new Date("2026-04-10T12:00:00Z");

const row = (over: Partial<ProofMissingRow> = {}): ProofMissingRow => ({
  id: "att-1",
  subjectKind: "appeal",
  subjectId: "app-1",
  createdAt: "2026-04-01T12:00:00Z", // 9 days ago
  ...over,
});
const storeOf = (rows: ProofMissingRow[]) => ({
  async needsManualAttempts() {
    return rows;
  },
});

describe("runSubmissionProofWatch", () => {
  it("alerts once per attempt past the threshold with the days open", async () => {
    const { alerts } = await runSubmissionProofWatch(storeOf([row()]), now);
    expect(alerts).toEqual([
      {
        kind: "submission.proof_missing",
        detail: { subjectKind: "appeal", subjectId: "app-1", daysOpen: 9 },
      },
    ]);
  });

  it("stays silent for an attempt younger than the threshold", async () => {
    const young = row({ createdAt: "2026-04-09T12:00:00Z" });
    expect((await runSubmissionProofWatch(storeOf([young]), now)).alerts).toEqual([]);
  });

  it("honours a custom threshold", async () => {
    const young = row({ createdAt: "2026-04-09T12:00:00Z" });
    expect((await runSubmissionProofWatch(storeOf([young]), now, 1)).alerts).toHaveLength(1);
  });

  it("carries no confirmation reference or free text in the payload", async () => {
    const { alerts } = await runSubmissionProofWatch(storeOf([row()]), now);
    expect(Object.keys(alerts[0]?.detail ?? {}).sort()).toEqual([
      "daysOpen",
      "subjectId",
      "subjectKind",
    ]);
  });
});
