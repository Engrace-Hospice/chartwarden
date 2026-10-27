// The commercial claim timeline screen (issue #822): state changes, submissions and acknowledgments in order. Synthetic data only.
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CommercialClaimTimeline } from "./claim-timeline";
import { CLAIM_ID, PATIENT_ID, type Responder, mountScreen } from "./commercial-test-harness";

const TIMELINE = `GET /api/v1/billing/commercial/claims/${CLAIM_ID}/timeline`;

const timeline = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  claimId: CLAIM_ID,
  patientId: PATIENT_ID,
  state: "ready",
  truncated: false,
  items: [
    {
      kind: "state_change",
      at: "2026-03-02T10:00:00.000Z",
      fromState: null,
      toState: "draft",
      actorKind: "user",
    },
    {
      kind: "submission",
      at: "2026-03-03T10:00:00.000Z",
      submissionId: "s-1",
      status: "failed",
      controlNumber: "000000123",
      clearinghouseKey: "ch-1",
      attemptCount: 2,
      failureCode: "CH_REJECTED",
      failureMessage: "raw text that must not render",
      resolution: null,
      sentAt: null,
    },
    {
      kind: "acknowledgment",
      at: "2026-03-04T10:00:00.000Z",
      submissionId: "s-1",
      stage: "payer",
      disposition: "accepted",
      reasonCodes: ["A1", "A2"],
      payerClaimNumber: "PCN-77",
    },
  ],
  ...over,
});

function mount(routes: Record<string, Responder>): void {
  mountScreen({
    routes,
    calls: [],
    element: <CommercialClaimTimeline />,
    routePath: "/commercial/billing/claims/:claimId/timeline",
    entry: `/commercial/billing/claims/${CLAIM_ID}/timeline`,
  });
}

afterEach(cleanup);

describe("CommercialClaimTimeline", () => {
  it("renders each kind of event in a captioned table, without raw failure text", async () => {
    mount({ [TIMELINE]: () => ({ body: timeline() }) });
    expect(await screen.findByRole("table", { name: "Claim history" })).toBeTruthy();
    expect(screen.getByText("Claim created as Draft")).toBeTruthy();
    expect(screen.getByText(/Submission 000000123/)).toBeTruthy();
    expect(screen.getByText(/CH_REJECTED/)).toBeTruthy();
    expect(screen.getByText(/PCN-77/)).toBeTruthy();
    expect(screen.getByText(/A1, A2/)).toBeTruthy();
    expect(screen.queryByText(/raw text that must not render/)).toBeNull();
  });

  it("says older events were cut when truncated", async () => {
    mount({ [TIMELINE]: () => ({ body: timeline({ truncated: true }) }) });
    expect(await screen.findByText(/Older events are not shown/)).toBeTruthy();
  });

  it("shows an empty state when there is no history", async () => {
    mount({ [TIMELINE]: () => ({ body: timeline({ items: [] }) }) });
    expect(await screen.findByText("No history yet")).toBeTruthy();
  });

  it("shows a retryable error on failure", async () => {
    mount({ [TIMELINE]: () => ({ status: 500, body: {} }) });
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
