import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SubmissionsTable } from "../submissions-timeline";

afterEach(cleanup);

describe("M23 stale preview submission history", () => {
  it("clearly reports that stale-source holds were not sent and need a fresh review", () => {
    render(<SubmissionsTable rows={[{
      submissionId: "00000000-0000-4000-8000-000000000001",
      kind: "claim_837i",
      claimControlNumber: "SYNTHETIC-CTRL-01",
      attemptIndex: 0,
      outcome: "held_stale_source",
      outcomeReason: "CLAIM_PREVIEW_STALE",
      generatedFileUri: null,
      submittedAt: null,
      createdAt: "2026-11-08T00:00:00.000Z",
    }]} />);

    expect(screen.getByText("Review required — not sent")).toBeTruthy();
    expect(screen.getByText("CLAIM_PREVIEW_STALE")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("distinguishes a committed send from an uncertain outcome requiring reconciliation", () => {
    render(<SubmissionsTable rows={[{
      submissionId: "00000000-0000-4000-8000-000000000002",
      kind: "claim_837i",
      claimControlNumber: "SYNTHETIC-CTRL-02",
      attemptIndex: 1,
      outcome: "queued",
      dispatchState: "in_doubt",
      dispatchReasonCode: "TRANSPORT_OUTCOME_UNCERTAIN",
      outcomeReason: null,
      generatedFileUri: null,
      submittedAt: null,
      createdAt: "2026-11-08T00:00:00.000Z",
    }]} />);

    expect(screen.getByText("Outcome uncertain — review required")).toBeTruthy();
    expect(screen.getByText("Transport outcome uncertain. Reconcile this attempt before retrying.")).toBeTruthy();
  });
});
