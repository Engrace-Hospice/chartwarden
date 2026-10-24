// M36 WP 6.8 (ADR-0097) - the acknowledge-required broadcast screen: the caller's waiting list with an explicit Acknowledge (opening is a link,
// never an acknowledgment), flag off said in words, the supervisor's list of every non-acknowledger apart from people no longer active, paging,
// errors with retry, and axe clean.
import type { AckBroadcastDetail, AckBroadcastSummary } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AckBroadcast } from "./ack-broadcast";
import { BROADCAST_OFF_TITLE, MINE_EMPTY_TITLE } from "./ack-broadcast-wording";

const counts = { audience: 5, acknowledged: 2, pending: 2, opened: 1, notOpened: 1, ineligible: 1, outsideAudience: 1 };
const summary: AckBroadcastSummary = {
  messageId: "m1",
  channelId: "c1",
  createdAt: "2026-10-23T10:00:00.000Z",
  counts,
  deadlineAt: null,
  withdrawnAt: null,
  pastDeadline: false,
};
const detail = (over: Partial<AckBroadcastDetail> = {}): AckBroadcastDetail => ({
  ...summary,
  filter: "pending",
  offset: 0,
  hasMore: false,
  people: [
    { userId: "u1", displayName: "Alice Opened", state: "opened", openedAt: "2026-10-23T11:00:00.000Z", acknowledgedAt: null },
    { userId: "u2", displayName: "Bob Unopened", state: "not_opened", openedAt: null, acknowledgedAt: null },
  ],
  ...over,
});

type Reply = { data?: unknown; error?: unknown; response?: { status: number } };
function mount(routes: Record<string, () => Reply>, post?: () => Reply) {
  const GET = vi.fn(async (path: string) => routes[path]?.() ?? { error: {}, response: { status: 500 } });
  const POST = vi.fn(async () => post?.() ?? { data: { messageId: "m1", acknowledgedAt: "2026-10-23T12:00:00.000Z", already: false } });
  const view = render(
    <MemoryRouter>
      <ApiClientProvider client={{ GET, POST, PUT: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() } as unknown as ApiClient}>
        <main>
          <AckBroadcast />
        </main>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST, ...view };
}
const MINE = "/api/v1/messaging/ack-broadcasts/mine";
const LIST = "/api/v1/messaging/ack-broadcasts";
const DETAIL = "/api/v1/messaging/announcements/{messageId}/ack-broadcast";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AckBroadcast", () => {
  it("opening is a link and never writes; Acknowledge is the only write, once, for the caller", async () => {
    let acked = false;
    const { POST } = mount(
      {
        [MINE]: () => ({ data: { items: [{ messageId: "m1", channelId: "c1", createdAt: summary.createdAt, acknowledgedAt: acked ? "2026-10-23T12:00:00.000Z" : null }] } }),
        [LIST]: () => ({ error: {}, response: { status: 403 } }),
      },
      () => {
        acked = true;
        return { data: { messageId: "m1", acknowledgedAt: "2026-10-23T12:00:00.000Z", already: false } };
      },
    );
    const link = await screen.findByRole("link", { name: /Open announcement/ });
    expect(link.getAttribute("href")).toContain("channelId=c1");
    expect(POST).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    expect(POST).toHaveBeenCalledWith(
      "/api/v1/messaging/announcements/{messageId}/ack",
      { params: { path: { messageId: "m1" } } },
    );
    expect(await screen.findByText(/Acknowledged .*2026|Acknowledged \w/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Acknowledge/ })).toBeNull();
    // a non-supervisor never sees the oversight section
    expect(screen.queryByText(/Announcements you oversee/)).toBeNull();
  });

  it("says the feature is off, never an empty list", async () => {
    mount({ [MINE]: () => ({ error: {}, response: { status: 404 } }), [LIST]: () => ({ error: {}, response: { status: 404 } }) });
    expect(await screen.findByText(BROADCAST_OFF_TITLE)).toBeTruthy();
    expect(screen.queryByText(MINE_EMPTY_TITLE)).toBeNull();
  });

  it("says nothing is waiting only when the read succeeded", async () => {
    mount({ [MINE]: () => ({ data: { items: [] } }), [LIST]: () => ({ error: {}, response: { status: 403 } }) });
    expect(await screen.findByText(MINE_EMPTY_TITLE)).toBeTruthy();
  });

  it("shows an error with retry that reads again", async () => {
    let calls = 0;
    const { GET } = mount({
      [MINE]: () => (++calls === 1 ? { error: {}, response: { status: 500 } } : { data: { items: [] } }),
      [LIST]: () => ({ error: {}, response: { status: 403 } }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText(MINE_EMPTY_TITLE)).toBeTruthy();
    expect(GET.mock.calls.filter((c) => c[0] === MINE)).toHaveLength(2);
  });

  it("a supervisor sees every non-acknowledger, the late joiners counted, and switches to the no-longer-active view", async () => {
    const { GET } = mount({
      [MINE]: () => ({ data: { items: [] } }),
      [LIST]: () => ({ data: { broadcasts: [summary] } }),
      [DETAIL]: () => ({ data: detail() }),
    });
    expect(await screen.findByText("Alice Opened")).toBeTruthy();
    expect(screen.getByText("Bob Unopened")).toBeTruthy();
    expect(screen.getByText(/2 of 5 acknowledged\. 2 still to acknowledge \(1 not opened\)\. 1 no longer active\./)).toBeTruthy();
    expect(screen.getByText(/1 person joined after this was sent/)).toBeTruthy();
    expect(screen.getByText("Opened, not acknowledged")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "No longer active" }));
    await waitFor(() =>
      expect(GET).toHaveBeenCalledWith(
        DETAIL,
        expect.objectContaining({ params: expect.objectContaining({ query: expect.objectContaining({ filter: "ineligible", offset: 0 }) }) }),
      ),
    );
  });

  it("pages exactly: Show more appends the next page", async () => {
    let page = 0;
    mount({
      [MINE]: () => ({ data: { items: [] } }),
      [LIST]: () => ({ data: { broadcasts: [summary] } }),
      [DETAIL]: () =>
        page++ === 0
          ? { data: detail({ hasMore: true }) }
          : { data: detail({ offset: 2, people: [{ userId: "u3", displayName: "Cara Third", state: "not_opened", openedAt: null, acknowledgedAt: null }] }) },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByText("Cara Third")).toBeTruthy();
    expect(screen.getByText("Alice Opened")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("Show more is busy while a page loads: a double click sends one request", async () => {
    let release!: (r: Reply) => void;
    const held = new Promise<Reply>((r) => {
      release = r;
    });
    let page = 0;
    const { GET } = mount({
      [MINE]: () => ({ data: { items: [] } }),
      [LIST]: () => ({ data: { broadcasts: [summary] } }),
      [DETAIL]: () => (page++ === 0 ? { data: detail({ hasMore: true }) } : (held as unknown as Reply)),
    });
    const button = await screen.findByRole("button", { name: "Show more" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(GET.mock.calls.filter((c) => c[0] === DETAIL)).toHaveLength(2);
    release({ data: detail({ offset: 2, people: [] }) });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Show more" })).toBeNull());
  });

  it("a failed Show more keeps the loaded pages and offers an inline retry", async () => {
    let page = 0;
    mount({
      [MINE]: () => ({ data: { items: [] } }),
      [LIST]: () => ({ data: { broadcasts: [summary] } }),
      [DETAIL]: () => {
        page += 1;
        if (page === 1) return { data: detail({ hasMore: true }) };
        if (page === 2) return { error: {}, response: { status: 500 } };
        return { data: detail({ offset: 2, people: [{ userId: "u3", displayName: "Cara Third", state: "not_opened", openedAt: null, acknowledgedAt: null }] }) };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByText(/could not be loaded\. The ones already shown are kept/)).toBeTruthy();
    expect(screen.getByText("Alice Opened")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Cara Third")).toBeTruthy();
    expect(screen.getByText("Alice Opened")).toBeTruthy();
  });

  it("moves focus to a status line that says Acknowledged after the row leaves the list", async () => {
    let acked = false;
    mount(
      {
        [MINE]: () => ({ data: { items: [{ messageId: "m1", channelId: "c1", createdAt: summary.createdAt, acknowledgedAt: acked ? "2026-10-23T12:00:00.000Z" : null }] } }),
        [LIST]: () => ({ error: {}, response: { status: 403 } }),
      },
      () => {
        acked = true;
        return { data: { messageId: "m1", acknowledgedAt: "2026-10-23T12:00:00.000Z", already: false } };
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: /Acknowledge/ }));
    const status = await screen.findByText("Acknowledged.");
    expect(status.getAttribute("role")).toBe("status");
    await waitFor(() => expect(document.activeElement).toBe(status));
  });

  it("keeps the list and says the refresh failed when the reload after an acknowledgment fails", async () => {
    let calls = 0;
    mount(
      {
        [MINE]: () =>
          ++calls === 1
            ? { data: { items: [{ messageId: "m1", channelId: "c1", createdAt: summary.createdAt, acknowledgedAt: null }] } }
            : { error: {}, response: { status: 500 } },
        [LIST]: () => ({ error: {}, response: { status: 403 } }),
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: /Acknowledge/ }));
    expect(await screen.findByText(/could not be refreshed/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open announcement/ })).toBeTruthy();
  });

  it("hides the notice when the feature is off", async () => {
    mount({ [MINE]: () => ({ error: {}, response: { status: 404 } }) });
    await screen.findByText(BROADCAST_OFF_TITLE);
    expect(screen.queryByText(/Opening an announcement does not acknowledge it/)).toBeNull();
  });

  it("has no axe violations with both sections shown", async () => {
    const { container } = mount({
      [MINE]: () => ({ data: { items: [{ messageId: "m1", channelId: "c1", createdAt: summary.createdAt, acknowledgedAt: null }] } }),
      [LIST]: () => ({ data: { broadcasts: [summary] } }),
      [DETAIL]: () => ({ data: detail() }),
    });
    await screen.findByText("Alice Opened");
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations).toEqual([]);
  });
});

const WITHDRAW = "/api/v1/messaging/announcements/{messageId}/ack-broadcast/withdraw";
const WITHDRAWN_AT = "2026-10-23T13:00:00.000Z";

describe("AckBroadcast: deadline and withdrawal (ADR-0097 D13-D14)", () => {
  it("shows the deadline to the recipient while waiting, and marks past-deadline and withdrawn broadcasts on the author's list", async () => {
    const past: AckBroadcastSummary = { ...summary, deadlineAt: "2026-10-23T09:00:00.000Z", pastDeadline: true };
    const gone: AckBroadcastSummary = { ...summary, messageId: "m2", withdrawnAt: WITHDRAWN_AT, deadlineAt: "2026-10-23T09:00:00.000Z" };
    mount({
      [MINE]: () => ({ data: { items: [{ messageId: "m1", channelId: "c1", createdAt: summary.createdAt, acknowledgedAt: null, deadlineAt: "2026-10-30T09:00:00.000Z" }] } }),
      [LIST]: () => ({ data: { broadcasts: [past, gone] } }),
      [DETAIL]: () => ({ data: detail() }),
    });
    expect((await screen.findAllByText(/^Deadline /, { selector: "p" })).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Past deadline").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Withdrawn").length).toBeGreaterThan(0);
  });

  it("a withdrawn broadcast is read-only: marker and note, no Withdraw button", async () => {
    const gone: AckBroadcastSummary = { ...summary, withdrawnAt: WITHDRAWN_AT };
    mount({
      [MINE]: () => ({ data: { items: [] } }),
      [LIST]: () => ({ data: { broadcasts: [gone] } }),
      [DETAIL]: () => ({ data: detail({ withdrawnAt: WITHDRAWN_AT }) }),
    });
    expect(await screen.findByText(/acknowledgments already given are kept/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Withdraw requirement" })).toBeNull();
  });

  it("withdraw asks first, cancelling writes nothing, confirming posts once (a double click too) and moves focus to the status line", async () => {
    let withdrawn = false;
    let release!: (r: Reply) => void;
    const held = new Promise<Reply>((r) => {
      release = r;
    });
    const { POST } = mount(
      {
        [MINE]: () => ({ data: { items: [] } }),
        [LIST]: () => ({ data: { broadcasts: [withdrawn ? { ...summary, withdrawnAt: WITHDRAWN_AT } : summary] } }),
        [DETAIL]: () => ({ data: detail() }),
      },
      () => held as unknown as Reply,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw requirement" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Withdraw this requirement?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep asking" }));
    expect(POST).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Withdraw requirement" }));
    const confirm = within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Withdraw" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(POST).toHaveBeenCalledTimes(1);
    expect(POST).toHaveBeenCalledWith(WITHDRAW, { params: { path: { messageId: "m1" } } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    withdrawn = true;
    release({ data: { ...summary, withdrawnAt: WITHDRAWN_AT, already: false } });
    const status = await screen.findByText("Requirement withdrawn. People are no longer asked.");
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw requirement" })).toBeNull();
    expect(screen.getAllByText("Withdrawn").length).toBeGreaterThan(0);
  });

  it("a failed withdrawal says nothing changed, keeps the dialog open and the button available", async () => {
    mount(
      {
        [MINE]: () => ({ data: { items: [] } }),
        [LIST]: () => ({ data: { broadcasts: [summary] } }),
        [DETAIL]: () => ({ data: detail() }),
      },
      () => ({ error: {}, response: { status: 500 } }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw requirement" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText(/could not be withdrawn\. Nothing changed/)).toBeTruthy();
    const dialog = screen.getByRole("alertdialog");
    expect((within(dialog).getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("the open confirmation has no axe violations", async () => {
    const { container } = mount({
      [MINE]: () => ({ data: { items: [] } }),
      [LIST]: () => ({ data: { broadcasts: [{ ...summary, deadlineAt: "2026-10-30T09:00:00.000Z" }] } }),
      [DETAIL]: () => ({ data: detail() }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw requirement" }));
    await screen.findByRole("alertdialog");
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations).toEqual([]);
  });
});
