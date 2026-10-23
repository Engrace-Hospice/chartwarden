// F-022 (#591) - the dispatch form never presents an empty picker when a prerequisite read was refused or failed (jsdom).
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  const get = vi.fn((path: string) => Promise.resolve(replies[path]));
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

  it("shows a failed state with retry when the second request read is 503", async () => {
    const replies: Record<string, unknown> = { [REQUESTS]: failure(503), [TEMPLATES]: ok };
    const get = mount(replies);
    const retry = await screen.findByRole("button", { name: "Retry" });
    replies[REQUESTS] = ok;
    fireEvent.click(retry);
    await screen.findByText(/No open comfort-kit request is available/);
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(3));
  });
});
