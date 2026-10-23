// M36 WP 6.1 (ADR-0100) - the work inbox screen: loading, rows in the server's band order with the server's reason, restricted rows with no
// link, flag off, empty, error with retry, a missing source and an incomplete urgent list said in words, no write controls, axe clean.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SmartInboxItemDto, SmartInboxResponse } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SmartInbox } from "./smart-inbox";
import {
  INBOX_DENIED,
  INBOX_EMPTY_TITLE,
  INBOX_LOAD_FAILED,
  INBOX_OFF_TITLE,
  INBOX_URGENT_INCOMPLETE,
  SOURCE_UNAVAILABLE,
} from "./smart-inbox-wording";

const item = (over: Partial<SmartInboxItemDto>): SmartInboxItemDto => ({
  key: "ack:1",
  band: "urgent_ack",
  rank: 1,
  title: "Acknowledgment request",
  reasons: [{ code: "ack_overdue", text: "Past its deadline by 10 min." }],
  since: "2026-10-23T11:00:00.000Z",
  due_at: "2026-10-23T11:50:00.000Z",
  channel_id: "c1",
  target: "acknowledgment_request",
  target_id: "a1",
  restricted: false,
  count: null,
  ...over,
});

const inbox = (over: Partial<SmartInboxResponse> = {}): SmartInboxResponse => ({
  enabled: true,
  items: [
    item({}),
    item({
      key: "task:1",
      band: "task_assigned",
      rank: 2,
      title: "Task assigned to you",
      reasons: [{ code: "task_open", text: "Assigned to you and still open." }],
      target: "task",
    }),
  ],
  band_counts: {
    urgent_ack: 1,
    handoff_awaiting: 0,
    task_assigned: 1,
    mention: 0,
    care_team_unread: 0,
  },
  complete: true,
  urgent_complete: true,
  unavailable_sources: [],
  ...over,
});

function mount(handler: () => unknown) {
  const GET = vi.fn(() => Promise.resolve(handler()));
  const writes = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  const view = render(
    <MemoryRouter>
      <ApiClientProvider
        client={
          { GET, POST: writes[0], PUT: writes[1], PATCH: writes[2], DELETE: writes[3] } as unknown as ApiClient
        }
      >
        <main>
          <SmartInbox />
        </main>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, writes, ...view };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SmartInbox", () => {
  it("shows rows in the server's band order, each with its reason, and no write control", async () => {
    const { GET, writes } = mount(() => ({ data: inbox() }));
    expect(screen.getByLabelText("Loading")).toBeTruthy();
    expect(await screen.findByText("Past its deadline by 10 min.")).toBeTruthy();
    expect(screen.getByText("Assigned to you and still open.")).toBeTruthy();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toContain("Urgent");
    expect(headings[1]).toContain("Tasks");
    expect(GET).toHaveBeenCalledWith("/api/v1/messaging/inbox", {});
    for (const w of writes) expect(w).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /acknowledge|accept|complete/i })).toBeNull();
  });

  it("gives a restricted request no link", async () => {
    mount(() => ({
      data: inbox({
        items: [item({ restricted: true, channel_id: null, target_id: null })],
        band_counts: { urgent_ack: 1, handoff_awaiting: 0, task_assigned: 0, mention: 0, care_team_unread: 0 },
      }),
    }));
    await screen.findByText(/cannot open this conversation/i);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("says the feature is off, never an empty list", async () => {
    mount(() => ({ data: inbox({ enabled: false, items: [] }) }));
    expect(await screen.findByText(INBOX_OFF_TITLE)).toBeTruthy();
  });

  it("says nothing is waiting only when every source was read", async () => {
    mount(() => ({ data: inbox({ items: [], band_counts: { urgent_ack: 0, handoff_awaiting: 0, task_assigned: 0, mention: 0, care_team_unread: 0 } }) }));
    expect(await screen.findByText(INBOX_EMPTY_TITLE)).toBeTruthy();
  });

  it("names a source that failed to read instead of showing a quiet inbox", async () => {
    mount(() => ({
      data: inbox({ items: [], unavailable_sources: ["urgent_ack"], urgent_complete: false }),
    }));
    expect(await screen.findByText(SOURCE_UNAVAILABLE("urgent_ack"))).toBeTruthy();
    expect(screen.getByText(INBOX_URGENT_INCOMPLETE)).toBeTruthy();
    expect(screen.queryByText(INBOX_EMPTY_TITLE)).toBeNull();
  });

  it("shows an error with a retry that reads again", async () => {
    let calls = 0;
    const { GET } = mount(() => {
      calls += 1;
      return calls === 1 ? { error: {}, response: { status: 500 } } : { data: inbox() };
    });
    expect(await screen.findByText(INBOX_LOAD_FAILED)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Past its deadline by 10 min.");
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it("fails closed on 403 with no retry", async () => {
    const { GET } = mount(() => ({ error: {}, response: { status: 403 } }));
    expect(await screen.findByText(INBOX_DENIED)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(1));
  });

  it("has no axe violations", async () => {
    const { container } = mount(() => ({ data: inbox() }));
    await screen.findByText("Past its deadline by 10 min.");
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});
