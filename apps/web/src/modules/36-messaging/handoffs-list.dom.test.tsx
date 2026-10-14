// M36 WP 3.5: the Handoffs tab list. Rows are patient-free, the toggles re-read with the chosen scope and state, and the
// loading, empty and error states say so.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { HandoffsList } from "./handoffs-list";
import { HANDOFF_FIXTURE } from "./handoffs-test-fixture";

const { items: _items, ...ROW } = HANDOFF_FIXTURE;

function mount(list: unknown) {
  const GET = vi.fn().mockResolvedValue(list);
  render(
    <ApiClientProvider client={{ GET, POST: vi.fn() } as unknown as ApiClient}>
      <HandoffsList meId="u1" />
    </ApiClientProvider>,
  );
  return GET;
}
const ready = (handoffs: unknown[]) => ({ data: { enabled: true, handoffs } });

describe("HandoffsList", () => {
  it("shows counts and the sender, never a patient", async () => {
    mount(ready([{ ...ROW, needs_attention: true }]));
    const row = await screen.findByRole("listitem");
    expect(within(row).getByText(/From Sam Lead\. 1 patient, 2 items, 2 waiting/)).toBeTruthy();
    expect(within(row).getByText("Needs attention")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Review" })).toBeTruthy();
    expect(row.textContent).not.toMatch(/Ann B|1234/);
  });

  it("re-reads with the outgoing scope and closed state", async () => {
    const GET = mount(ready([ROW]));
    await screen.findByRole("listitem");
    await userEvent.click(screen.getByRole("button", { name: "Outgoing" }));
    await waitFor(() =>
      expect(GET).toHaveBeenLastCalledWith("/api/v1/messaging/handoffs", {
        params: { query: { scope: "outgoing", state: "active" } },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Closed" }));
    await waitFor(() =>
      expect(GET).toHaveBeenLastCalledWith("/api/v1/messaging/handoffs", {
        params: { query: { scope: "outgoing", state: "closed" } },
      }),
    );
  });

  it("says so when there is nothing waiting", async () => {
    mount(ready([]));
    expect(await screen.findByText("No handoffs waiting for you.")).toBeTruthy();
  });

  it("says so when the list cannot be loaded", async () => {
    mount({ error: {}, response: { status: 500 } });
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
  });

  it("opens the compose drawer from Start handoff", async () => {
    const GET = vi.fn(async (path: string) =>
      path === "/api/v1/messaging/handoffs"
        ? ready([])
        : { data: { patients: [] }, response: { status: 200 } },
    );
    render(
      <ApiClientProvider client={{ GET, POST: vi.fn() } as unknown as ApiClient}>
        <HandoffsList meId="u1" />
      </ApiClientProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Start handoff" }));
    expect(await screen.findByRole("heading", { name: "Start handoff" })).toBeTruthy();
    expect(
      within(screen.getByRole("dialog")).getByText(/Handoffs do not page anyone/),
    ).toBeTruthy();
  });
});
