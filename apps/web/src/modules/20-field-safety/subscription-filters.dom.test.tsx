// #664: picking a staff member in a ledger filter sends clinicianMembershipId; clearing the pick drops it.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { SupervisorSubscriptionsScreen } from "./supervisor-subscriptions";

const MEMBERSHIP = "33333333-aaaa-4aaa-8aaa-333333333333";
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

let ledgerQueries: URLSearchParams[] = [];

async function stub(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    "http://localhost",
  );
  if (url.pathname === "/api/v1/orgs/org-1/members") {
    return json({
      members: [
        {
          membershipId: MEMBERSHIP,
          userId: "u",
          displayName: "Jordan Clinician",
          email: "j@example.test",
          status: "active",
        },
      ],
    });
  }
  if (url.pathname === "/api/v1/safety/supervisor-subscriptions") {
    ledgerQueries.push(url.searchParams);
    return json({ data: [], nextCursor: null });
  }
  return json({ items: [], data: [], nextCursor: null });
}

afterEach(() => {
  cleanup();
  ledgerQueries = [];
});

describe("subscription ledger staff filter (#664)", () => {
  it("sends clinicianMembershipId once a clinician is picked and drops it when cleared", async () => {
    render(
      <MemoryRouter>
        <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
          <SessionProvider
            session={{
              userId: "v",
              organizationId: "org-1",
              membershipId: "m",
              roles: [],
              permissions: [],
              isAdmin: false,
            }}
          >
            <SupervisorSubscriptionsScreen />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(ledgerQueries.length).toBeGreaterThan(0));
    expect(ledgerQueries.at(-1)?.has("clinicianMembershipId")).toBe(false);

    const field = screen.getByLabelText(/^Filter by clinician/);
    fireEvent.focus(field);
    fireEvent.click(await screen.findByRole("option", { name: /Jordan Clinician/ }));
    await waitFor(() =>
      expect(ledgerQueries.at(-1)?.get("clinicianMembershipId")).toBe(MEMBERSHIP),
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    await waitFor(() => expect(ledgerQueries.at(-1)?.has("clinicianMembershipId")).toBe(false));
  });
});
