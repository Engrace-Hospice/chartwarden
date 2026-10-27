import { describe, expect, it } from "vitest";
import { csvCell, submissionKpis, submissionLogCsv } from "./submission-log";

const base = { submissionPeriod: "2026-Q3", itemCount: 1, acceptedCount: 0, rejectedCount: 0 };

describe("submission log", () => {
  it("neutralises formula-leading cells and quotes specials", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+x")).toBe("'+x");
    expect(csvCell("-x")).toBe("'-x");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=a,b")).toBe(`"'=a,b"`);
    expect(csvCell(null)).toBe("");
    expect(csvCell(0)).toBe("0");
  });

  it("writes a header and one line per row with injected references escaped", () => {
    const csv = submissionLogCsv([
      { ...base, id: "b1", status: "exported", iqiesSubmissionReference: "=HYPERLINK(1)" },
    ]);
    expect(csv.startsWith("\uFEFFBatch ID")).toBe(true);
    const [header, line] = csv.split("\r\n");
    expect(header).toContain("Batch ID");
    expect(line).toBe("b1,2026-Q3,exported,1,0,0,,,,'=HYPERLINK(1)");
  });

  it("rolls up KPIs", () => {
    const k = submissionKpis([
      { ...base, id: "a", status: "exported" },
      { ...base, id: "b", status: "submitted_pending_result" },
      {
        ...base,
        id: "c",
        status: "rejected",
        needsCorrectionCount: 3,
        correctionInProgressCount: 1,
        resubmittedCount: 2,
      },
      { ...base, id: "d", status: "accepted" },
    ]);
    expect(k).toEqual({
      awaitingConfirmation: 2,
      rejectedRecords: 3,
      rejectedBatches: 1,
      resubmissionsInProgress: 3,
    });
  });
});
