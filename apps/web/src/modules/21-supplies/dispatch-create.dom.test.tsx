// F-022 (#591) - the dispatch form never presents an empty picker when a prerequisite read was refused or failed (jsdom).
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ComfortKitDispatchCreate } from "./dispatch-create";

const REQUESTS = "/api/v1/supplies/supply-requests";
const TEMPLATES = "/api/v1/supplies/comfort-kit-templates";
const ok = { data: { data: [], has_more: false }, error: undefined, response: { status: 200 } };
const failure = (status: number) => ({
  data: undefined,
  error: { title: "boom" },
  response: { status },
});

function mount(replies: Record<string, unknown>) {
  // A reply may be a function (called per request) so a test can reject or answer a retry differently.
  const get = vi.fn((path: string) => {
    const reply = replies[path];
    return typeof reply === "function" ? reply() : Promise.resolve(reply);
  });
  render(
    <ApiClientProvider client={{ GET: get } as unknown as ApiClient}>
      <MemoryRouter>
        <ComfortKitDispatchCreate />
      </MemoryRouter>
    </ApiClientProvider>,
  );
  return get;
}

describe("Comfort-kit dispatch create read states", () => {
  it("shows a spinner while loading", () => {
    mount({ [REQUESTS]: ok, [TEMPLATES]: ok });
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("shows the genuine empty request copy when the reads succeed", async () => {
    mount({ [REQUESTS]: ok, [TEMPLATES]: ok });
    await screen.findByText(/No open comfort-kit request is available/);
  });

  it("shows a denied state without retry when the template read is 403", async () => {
    mount({ [REQUESTS]: ok, [TEMPLATES]: failure(403) });
    await screen.findByText("You do not have access");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText(/No open comfort-kit request/)).toBeNull();
  });

  it("shows a failed state with retry when the second request read is 503 and recovers", async () => {
    const replies: Record<string, unknown> = { [REQUESTS]: failure(503), [TEMPLATES]: ok };
    const get = mount(replies);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByText(/No open comfort-kit request/)).toBeNull();
    replies[REQUESTS] = ok;
    fireEvent.click(retry);
    await screen.findByText(/No open comfort-kit request is available/);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(get.mock.calls.length).toBe(6);
  });

  it("recovers when the first request read fails and the second succeeds", async () => {
    let first = 0;
    mount({
      // Both kit-kind reads hit REQUESTS; the first call overall fails, the rest succeed.
      [REQUESTS]: () => Promise.resolve(++first === 1 ? failure(500) : ok),
      [TEMPLATES]: ok,
    });
    const retry = await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    await screen.findByText(/No open comfort-kit request is available/);
  });

  it("shows a failed state, not a stuck spinner, when a request is rejected", async () => {
    mount({ [REQUESTS]: ok, [TEMPLATES]: () => Promise.reject(new Error("network")) });
    await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
