// M25 milestone 12a-1 - the payer-appeal watches: boundary alerts for a path-computed deadline, one no-deadline alert, and
// ids-only payloads. The recorded-deadline watch carries the payer_appeal subject kind.
import { describe, expect, it } from "vitest";
import { runPayerAppealDeadlineWatch, runPayerAppealNoDeadlineWatch } from "../payer-appeal-watch";
import { runRecordedDeadlineWatch } from "../recorded-deadline-watch";

const now = new Date("2026-03-10T12:00:00Z");

describe("runPayerAppealDeadlineWatch", () => {
  it("alerts at the boundary the deadline is within, ids and a day count only", async () => {
    const r = await runPayerAppealDeadlineWatch(
      {
        draftsWithComputedDeadline: async () => [{ id: "c1", deadlineAt: "2026-03-17T04:00:00Z" }],
      },
      now,
    );
    expect(r.alerts).toEqual([
      {
        kind: "payer_appeal.deadline_approaching",
        detail: { payerAppealCaseId: "c1", daysRemaining: 7 },
      },
    ]);
  });
  it("does not alert a far or a past deadline", async () => {
    const r = await runPayerAppealDeadlineWatch(
      {
        draftsWithComputedDeadline: async () => [
          { id: "far", deadlineAt: "2027-01-01T00:00:00Z" },
          { id: "past", deadlineAt: "2026-03-01T00:00:00Z" },
        ],
      },
      now,
    );
    expect(r.alerts).toEqual([]);
  });
});

describe("runPayerAppealNoDeadlineWatch", () => {
  it("alerts an old draft with no deadline once, ids only", async () => {
    const row = {
      id: "c1",
      state: "draft",
      createdAt: "2026-03-01T00:00:00Z",
      hasDeadline: false,
      alreadyAlerted: false,
    };
    const r = await runPayerAppealNoDeadlineWatch(
      {
        openDrafts: async () => [
          row,
          { ...row, id: "c2", hasDeadline: true },
          { ...row, id: "c3", alreadyAlerted: true },
        ],
      },
      now,
    );
    expect(r.alertedIds).toEqual(["c1"]);
    expect(r.alerts).toEqual([
      { kind: "payer_appeal.no_deadline", detail: { payerAppealCaseId: "c1" } },
    ]);
  });
});

describe("runRecordedDeadlineWatch with a payer appeal subject", () => {
  it("carries subjectKind payer_appeal", async () => {
    const r = await runRecordedDeadlineWatch(
      {
        openDeadlines: async () => [
          {
            id: "d1",
            subjectKind: "payer_appeal" as const,
            subjectId: "c1",
            dueOn: "2026-03-17",
            zone: "America/New_York",
            satisfiedOn: null,
            lastAlertedBoundary: null,
          },
        ],
      },
      now,
    );
    expect(r.alerts[0]?.detail).toMatchObject({ subjectKind: "payer_appeal", subjectId: "c1" });
  });
});
