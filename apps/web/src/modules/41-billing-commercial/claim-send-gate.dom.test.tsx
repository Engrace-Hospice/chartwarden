// The commercial claim send gate screen (issue #822): every reason a claim cannot be sent, before the click. Synthetic data only.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CommercialClaimSendGate } from "./claim-send-gate";
import { CLAIM_ID, PATIENT_ID, type Responder, mountScreen } from "./commercial-test-harness";

const GATE = `GET /api/v1/billing/commercial/claims/${CLAIM_ID}/send-gate`;

const gate = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  claimId: CLAIM_ID,
  state: "ready",
  patientId: PATIENT_ID,
  canSubmit: false,
  clearinghouseKey: null,
  reasons: [
    { code: "CH_NOT_WIRED", message: "No clearinghouse is connected yet. Ask an administrator." },
    {
      code: "VALIDATION_BLOCKED",
      message: "Fix the blocking validation rules, then re-validate.",
      ruleKeys: ["authorization_on_file"],
    },
  ],
  ...over,
});

function mount(routes: Record<string, Responder>): void {
  mountScreen({
    routes,
    calls: [],
    element: <CommercialClaimSendGate />,
    routePath: "/commercial/billing/claims/:claimId/send-gate",
    entry: `/commercial/billing/claims/${CLAIM_ID}/send-gate`,
  });
}

afterEach(cleanup);

describe("CommercialClaimSendGate", () => {
  it("lists every reason with its code, message and rule keys", async () => {
    mount({ [GATE]: () => ({ body: gate() }) });
    expect(await screen.findByText(/No clearinghouse is connected yet/)).toBeTruthy();
    expect(screen.getByText("CH_NOT_WIRED")).toBeTruthy();
    expect(screen.getByText(/authorization_on_file/)).toBeTruthy();
    expect(screen.getByText("Cannot be sent")).toBeTruthy();
  });

  it("says the claim can be sent when there are no reasons", async () => {
    mount({
      [GATE]: () => ({ body: gate({ canSubmit: true, reasons: [], clearinghouseKey: "ch-1" }) }),
    });
    expect(await screen.findByText("Ready to send")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Reasons the claim cannot be sent" })).toBeNull();
  });

  it("shows a retryable error, never an empty pass", async () => {
    let n = 0;
    mount({ [GATE]: () => (++n === 1 ? { status: 500, body: {} } : { body: gate() }) });
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
    expect(screen.queryByText("Ready to send")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("CH_NOT_WIRED")).toBeTruthy());
  });

  it("says the claim was not found on a 404", async () => {
    mount({ [GATE]: () => ({ status: 404, body: {} }) });
    expect(await screen.findByText("Claim not found")).toBeTruthy();
  });
});
