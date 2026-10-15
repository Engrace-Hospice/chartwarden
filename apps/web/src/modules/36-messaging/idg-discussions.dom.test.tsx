import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { IdgDiscussionsSection } from "./idg-discussions-section";

// WP 3.6: the IDG discussions section is read only and hides itself when the route says `enabled:false`.
const ROUTE = "/api/v1/messaging/channels/{id}/idg-discussions";
const root = (id: string, over: Record<string, unknown> = {}) => ({
  messageId: id,
  authorDisplayName: "Dana Reyes",
  body: `Discuss ${id} <b>pain</b>`,
  createdAt: "2026-10-10T09:00:00.000Z",
  replyCount: 3,
  ...over,
});

function mount(get: () => Promise<unknown>, onOpenThread = vi.fn()) {
  const api = { GET: vi.fn(get) } as unknown as ApiClient;
  const view = render(
    <ApiClientProvider client={api}>
      <IdgDiscussionsSection channelId="ch-1" onOpenThread={onOpenThread} />
    </ApiClientProvider>,
  );
  return { api, onOpenThread, ...view };
}
const ok = (data: unknown) => Promise.resolve({ data });

describe("IdgDiscussionsSection", () => {
  it("lists each discussion with author, excerpt and reply count when enabled", async () => {
    const { api } = mount(() =>
      ok({
        enabled: true,
        patientId: "p-1",
        discussions: [root("m-1"), root("m-2", { replyCount: 1 })],
      }),
    );
    expect(await screen.findByText("Discuss m-1 <b>pain</b>")).toBeTruthy();
    expect(screen.getAllByText("Dana Reyes")).toHaveLength(2);
    expect(screen.getByText("3 replies")).toBeTruthy();
    expect(screen.getByText("1 reply")).toBeTruthy();
    expect(screen.getByText(/does not change the IDG meeting/)).toBeTruthy();
    expect(api.GET).toHaveBeenCalledWith(ROUTE, { params: { path: { id: "ch-1" } } });
  });

  it("shows the empty state when enabled with no discussions", async () => {
    mount(() => ok({ enabled: true, patientId: null, discussions: [] }));
    expect(await screen.findByText("No IDG discussions in this conversation.")).toBeTruthy();
  });

  it("renders nothing once the route answers enabled:false", async () => {
    const { api, container } = mount(() =>
      ok({ enabled: false, patientId: null, discussions: [] }),
    );
    await waitFor(() => expect(screen.queryByText("Loading IDG discussions…")).toBeNull());
    expect(api.GET).toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("shows an error state when the read fails", async () => {
    mount(() => Promise.reject(new Error("boom")));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "IDG discussions could not be loaded.",
    );
  });

  it("shows an error state when the answer carries no data", async () => {
    mount(() => Promise.resolve({ error: {} }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("opens the thread of the discussion with its opener element", async () => {
    const { onOpenThread } = mount(() =>
      ok({ enabled: true, patientId: "p-1", discussions: [root("m-9")] }),
    );
    const button = await screen.findByRole("button", {
      name: "Open discussion started by Dana Reyes",
    });
    fireEvent.click(button);
    expect(onOpenThread).toHaveBeenCalledWith("m-9", button);
  });
});
