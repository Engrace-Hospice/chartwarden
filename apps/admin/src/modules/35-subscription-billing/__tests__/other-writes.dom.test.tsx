import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/admin/src/modules/35-subscription-billing — the console's other platform writes (revenue recompute, dunning overrides) read
// success the same way as the money writes: "no error AND response.ok". An empty-body gateway 502 is a failure, and a request that
// never gets an answer releases the row's lock and says so, instead of a success line or an endless spinner.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { Dunning } from "../dunning";
import { Revenue } from "../revenue";

const SUB = "44444444-4444-4444-8444-444444444444";
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Writer = () => Response;
const gateway502: Writer = () =>
  new Response(null, { status: 502, headers: { "content-length": "0" } });
const offline: Writer = () => {
  throw new TypeError("Failed to fetch");
};

const current = {
  mrrCents: 120000,
  arrCents: 1440000,
  activeSubscriptions: 12,
  asOf: "2026-11-01T00:00:00.000Z",
};
const dunningRow = {
  subscriptionId: SUB,
  organizationId: SUB,
  organizationName: "Cedar Ridge",
  planName: "Pro Monthly",
  stage: "day_7",
  enteredAt: "2026-11-01T00:00:00.000Z",
  nextAttemptAt: null,
};

function mount(element: JSX.Element, write: Writer): void {
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.method !== "GET") return write();
    const path = new URL(req.url).pathname;
    if (path === "/api/admin/revenue/current") return json(current);
    if (path === "/api/admin/revenue/snapshots")
      return json({ items: [], nextCursor: null, hasMore: false });
    return json({ items: [dunningRow], nextCursor: null, hasMore: false });
  };
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}>
      <ToastProvider>
        <MemoryRouter>{element}</MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
}

afterEach(cleanup);

describe("revenue recompute", () => {
  it("an empty-body 502 is a failure, not 'recomputed'", async () => {
    mount(<Revenue />, gateway502);
    fireEvent.click(await screen.findByRole("button", { name: "Recompute" }));
    expect(await screen.findByText("Could not recompute revenue.")).toBeTruthy();
    expect(screen.queryByText("Revenue snapshot recomputed.")).toBeNull();
  });

  it("no answer at all releases the button and says the server was not reached", async () => {
    mount(<Revenue />, offline);
    fireEvent.click(await screen.findByRole("button", { name: "Recompute" }));
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Recompute" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });
});

describe("dunning overrides", () => {
  it("an empty-body 502 is a failure, not 'reset'", async () => {
    mount(<Dunning />, gateway502);
    fireEvent.click(await screen.findByRole("button", { name: "Reset" }));
    expect(await screen.findByText("Could not reset.")).toBeTruthy();
    expect(screen.queryByText("Dunning reset.")).toBeNull();
  });

  it("no answer at all releases the row's buttons", async () => {
    mount(<Dunning />, offline);
    fireEvent.click(await screen.findByRole("button", { name: "Skip stage" }));
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Skip stage" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });
});
