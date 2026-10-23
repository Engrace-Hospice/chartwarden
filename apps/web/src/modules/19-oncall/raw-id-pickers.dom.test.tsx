// #627 F-027: the on-call policy form picks a provider entity / clinician / location from a
// lookup instead of asking the operator to paste a UUID.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OnCallPolicyScreen } from "./oncall-policy";

const PE = "22222222-2222-4222-8222-222222222222";
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let paths: string[] = [];

async function stub(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(req.url);
  paths.push(`${req.method} ${url.pathname}${url.search}`);
  if (url.pathname === "/api/v1/provider-entities") {
    return json(200, {
      items: [{ id: PE, legalName: "Cedar Hospice", ccn: "381588", npi: null, status: "active" }],
      nextCursor: null,
    });
  }
  return json(404, { error: { code: "NOT_FOUND", message: "none", correlationId: "c" } });
}

function mount(ui: JSX.Element): void {
  render(
    <MemoryRouter>
      <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
        {ui}
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  paths = [];
});
afterEach(cleanup);

describe("#627 F-027 provider entity is picked, not pasted", () => {
  it("on-call policy: a lookup replaces the id box, and the chosen entity loads its policy", async () => {
    mount(<OnCallPolicyScreen />);
    expect(screen.queryByLabelText(/Provider entity id/)).toBeNull();
    fireEvent.focus(screen.getByRole("combobox", { name: /Provider entity/ }));
    fireEvent.click(await screen.findByRole("option", { name: /Cedar Hospice/ }));
    await waitFor(() =>
      expect(paths).toContain(`GET /api/v1/oncall/policy?providerEntityId=${PE}`),
    );
  });
});
