import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { EvvAggregatorSubmissions } from "./aggregator-submissions";

const SUBMISSION = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const VISIT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

let responseRows: Record<string, unknown>[] = [];

async function stubFetch(): Promise<Response> {
  return new Response(JSON.stringify(responseRows), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mount() {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "user-1",
          organizationId: "org-1",
          membershipId: "membership-1",
          roles: ["billing_reviewer"],
          permissions: ["evv.aggregator.read"],
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter initialEntries={["/evv/aggregator-submissions"]}>
            <EvvAggregatorSubmissions />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  responseRows = [];
});

describe("EVV aggregator status truthfulness", () => {
  it("does not present an empty submission list as proof that an integration is configured", async () => {
    mount();

    expect(await screen.findByText("Configuration status unavailable")).toBeInTheDocument();
    expect(screen.getByText("No submission records")).toBeInTheDocument();
    expect(
      screen.getByText(/does not confirm that a state or vendor integration is ready/i),
    ).toBeInTheDocument();
  });

  it("shows rejection evidence without exposing it in the queue row", async () => {
    responseRows = [
      {
        id: SUBMISSION,
        visitId: VISIT,
        stateCode: "TX",
        aggregatorVendor: "sandata",
        status: "rejected",
        aggregatorTransactionId: "txn-4031",
        attemptCount: 2,
        lastAttemptAt: "2026-11-19T17:00:00.000Z",
        nextRetryAt: null,
        submittedAt: "2026-11-19T17:00:01.000Z",
        aggregatorResponseAt: "2026-11-19T17:00:03.000Z",
        aggregatorRejectionCode: "AUTH-42",
        aggregatorRejectionReason: "Provider identifier was not enrolled for this program.",
      },
    ];
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByRole("button", { name: "View evidence" }));
    expect(screen.getByRole("dialog", { name: "Submission evidence" })).toBeInTheDocument();
    expect(screen.getByText("AUTH-42")).toBeInTheDocument();
    expect(
      screen.getByText("Provider identifier was not enrolled for this program."),
    ).toBeInTheDocument();
    expect(screen.getByText(/vendor refused this EVV submission/i)).toBeInTheDocument();
  });

  it("explains that vendor acceptance is not payer claim acceptance", async () => {
    responseRows = [
      {
        id: SUBMISSION,
        visitId: VISIT,
        stateCode: "TX",
        aggregatorVendor: "sandata",
        status: "accepted",
        aggregatorTransactionId: "txn-accepted",
        attemptCount: 1,
        lastAttemptAt: "2026-11-19T17:00:00.000Z",
        nextRetryAt: null,
        submittedAt: "2026-11-19T17:00:01.000Z",
        aggregatorResponseAt: "2026-11-19T17:00:03.000Z",
        aggregatorRejectionCode: null,
        aggregatorRejectionReason: null,
      },
    ];
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByRole("button", { name: "View evidence" }));
    expect(screen.getByText(/does not mean a payer accepted or paid a claim/i)).toBeInTheDocument();
    expect(screen.getByText("txn-accepted")).toBeInTheDocument();
  });

  it("keeps the submission evidence dialog free of automated WCAG A/AA violations", async () => {
    responseRows = [
      {
        id: SUBMISSION,
        visitId: VISIT,
        stateCode: "TX",
        aggregatorVendor: "sandata",
        status: "rejected",
        aggregatorTransactionId: "txn-4031",
        attemptCount: 2,
        aggregatorRejectionCode: "AUTH-42",
        aggregatorRejectionReason: "Provider identifier was not enrolled for this program.",
      },
    ];
    const user = userEvent.setup();
    const { container } = mount();

    await user.click(await screen.findByRole("button", { name: "View evidence" }));
    const results = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
