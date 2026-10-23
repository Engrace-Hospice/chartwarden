// #627 F-027: the supervisor-subscription form picks a provider entity from a lookup instead of asking for a pasted UUID.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SupervisorSubscriptionsScreen } from "../supervisor-subscriptions";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stub(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname === "/api/v1/safety/supervisor-subscriptions") {
    return json(200, { data: [], next_cursor: null, has_more: false });
  }
  return json(200, { items: [], nextCursor: null });
}

afterEach(cleanup);

describe("#627 F-027 supervisor subscription ids are picked, not pasted", () => {
  it("the provider-entity scope offers the lookup, not an id box", async () => {
    render(
      <MemoryRouter>
        <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
          <SupervisorSubscriptionsScreen />
        </ApiClientProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Add subscription" }));
    fireEvent.change(await screen.findByLabelText("Scope"), {
      target: { value: "provider_entity" },
    });
    expect(screen.queryByLabelText(/Provider entity id/)).toBeNull();
    expect(screen.getByRole("combobox", { name: /Provider entity/ })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /Supervisor/ })).toBeTruthy();
  });

  // #649: the ledger filters pick staff by name instead of taking a pasted membership id.
  it("the ledger filters offer staff lookups, not membership-id boxes", async () => {
    render(
      <MemoryRouter>
        <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
          <SupervisorSubscriptionsScreen />
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Add subscription" });
    expect(screen.queryByRole("textbox", { name: /membership id/i })).toBeNull();
    expect(screen.getByRole("combobox", { name: /Filter by clinician/ })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /Filter by supervisor/ })).toBeTruthy();
  });
});
