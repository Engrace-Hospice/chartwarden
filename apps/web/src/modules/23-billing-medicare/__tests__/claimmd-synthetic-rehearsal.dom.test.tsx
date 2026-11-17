// M23-CM5-T1 — frontend projection of the synthetic Claim.MD rehearsal outcomes. These rows contain
// identifiers and status codes only; no raw X12, MBI, or vendor response text reaches the UI fixture.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AcknowledgmentsTable } from "../acknowledgments-timeline";
import { SubmissionsTable } from "../submissions-timeline";

afterEach(cleanup);

describe("M23-CM5-T1 Claim.MD status projection", () => {
  it("T1-12 shows submitted, reconciliation, and ACK outcomes without implying payment", () => {
    render(
      <>
        <SubmissionsTable
          rows={[
            {
              submissionId: "synthetic-submitted",
              kind: "claim_837i",
              claimControlNumber: "SYNTHETIC-1",
              attemptIndex: 0,
              outcome: "submitted",
              dispatchState: "finished",
              outcomeReason: null,
              generatedFileUri: null,
              submittedAt: "2026-11-17T15:00:00.000Z",
              createdAt: "2026-11-17T15:00:00.000Z",
            },
            {
              submissionId: "synthetic-uncertain",
              kind: "claim_837i",
              claimControlNumber: "SYNTHETIC-2",
              attemptIndex: 1,
              outcome: "failed_portal",
              dispatchState: "in_doubt",
              dispatchReasonCode: "TRANSPORT_OUTCOME_UNCERTAIN",
              outcomeReason: null,
              generatedFileUri: null,
              submittedAt: null,
              createdAt: "2026-11-17T15:01:00.000Z",
            },
          ]}
        />
        <AcknowledgmentsTable
          rows={[
            {
              acknowledgmentId: "synthetic-ack",
              submissionId: "synthetic-submitted",
              kind: "277ca",
              macJurisdiction: "ngs_j6",
              ackReceivedAt: "2026-11-17T15:02:00.000Z",
              parsedAt: "2026-11-17T15:02:00.000Z",
              outcomeStatus: "rejected",
              parsedPayload: { reasonCodes: ["A7:21"] },
            },
          ]}
        />
      </>,
    );

    expect(screen.getAllByText("Submitted")).toHaveLength(2);
    expect(screen.getByText(/Transport outcome uncertain/)).toBeTruthy();
    expect(screen.getByText("277CA · Claim ack")).toBeTruthy();
    expect(screen.getByText("Rejected")).toBeTruthy();
    expect(screen.queryByText(/paid/i)).toBeNull();
  });
});
