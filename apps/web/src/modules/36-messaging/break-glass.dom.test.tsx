// M36 WP 5.8 (ADR-0087, PROPOSED) - break-glass on the web against a mocked network boundary: the request entry (key + live flag), the dialog (validation,
// the exact body, error mapping that never says why, step-up with a stashed draft, offline), the persistent read-only conversation with its banner
// (End now, expiry, no write control), and the compliance review (queue, detail, complete, a concern needs a note, still-active, own grant). Plus axe.
import type {
  BreakGlassGrantDto,
  BreakGlassReviewDetailDto,
  BreakGlassReviewDto,
} from "@chartwarden/types";
import { type ApiClient, ApiClientProvider, FeatureFlagProvider } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { BreakGlassPane } from "./break-glass-conversation";
import { BreakGlassRequest } from "./break-glass-request";
import { BreakGlassReview } from "./break-glass-review";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const GRANT = "22222222-2222-4222-8222-222222222222";
const REVIEW = "33333333-3333-4333-8333-333333333333";
const ME = "99999999-9999-4999-8999-999999999999";
const WHY = "Covering the on-call RN for a deteriorating patient";

type Reply = { data?: unknown; error?: unknown; response?: { status: number } };
const ok = (data: unknown): Reply => ({ data, response: { status: 200 } });
const fail = (status: number, error: unknown = {}): Reply => ({ error, response: { status } });

const grant = (over: Partial<BreakGlassGrantDto> = {}): BreakGlassGrantDto => ({
  id: GRANT,
  channelId: CHANNEL,
  channelKind: "discipline",
  reasonCode: "patient_safety",
  grantedAt: "2026-10-21T10:00:00.000Z",
  expiresAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
  revokedAt: null,
  status: "active",
  ...over,
});
const review = (over: Partial<BreakGlassReviewDto> = {}): BreakGlassReviewDto => ({
  reviewId: REVIEW,
  grantId: GRANT,
  granteeUserId: "77777777-7777-4777-8777-777777777777",
  granteeName: "Casey Nurse",
  channelId: CHANNEL,
  channelKind: "discipline",
  channelTitle: "Night team",
  patientId: null,
  reasonCode: "covering_colleague",
  justification: "<b>Needed</b> to correct a handoff note",
  grantedAt: "2026-10-18T10:00:00.000Z",
  endedAt: "2026-10-18T14:00:00.000Z",
  stillActive: false,
  readCount: 3,
  status: "pending",
  outcome: null,
  reviewedAt: null,
  reviewerUserId: null,
  note: null,
  dueAt: "2026-10-19T14:00:00.000Z",
  overdue: true,
  ...over,
});
const detail = (over: Partial<BreakGlassReviewDetailDto> = {}): BreakGlassReviewDetailDto => ({
  ...review(),
  readsTruncated: false,
  reads: [
    { readKind: "channel", resourceId: null, itemCount: null, readAt: "2026-10-18T10:05:00.000Z" },
    { readKind: "messages", resourceId: null, itemCount: 12, readAt: "2026-10-18T10:06:00.000Z" },
  ],
  ...over,
});

interface Routes {
  mine?: () => Reply;
  messages?: () => Reply;
  reviews?: (query: unknown) => Reply;
  detail?: () => Reply;
  create?: (body: unknown) => Reply;
  end?: () => Reply;
  complete?: (body: unknown) => Reply;
}
const MESSAGES = {
  messages: [
    {
      messageId: "m1",
      channelId: CHANNEL,
      authorUserId: null,
      authorDisplayName: "Pat <i>Nurse</i>",
      body: "<script>alert(1)</script> hello",
      bodyKind: "plain",
      createdAt: "2026-10-21T09:00:00.000Z",
      parentMessageId: null,
      references: [],
    },
  ],
};

function mount(
  ui: JSX.Element,
  routes: Routes = {},
  opts: { permissions?: string[]; flag?: boolean } = {},
) {
  const GET = vi.fn((path: string, init?: { params?: { query?: unknown } }): Promise<Reply> => {
    if (path.endsWith("/mine")) return Promise.resolve(routes.mine?.() ?? ok({ grants: [] }));
    if (path.endsWith("/messages")) return Promise.resolve(routes.messages?.() ?? ok(MESSAGES));
    if (path.endsWith("/reviews/{id}")) return Promise.resolve(routes.detail?.() ?? ok(detail()));
    if (path.endsWith("/reviews"))
      return Promise.resolve(routes.reviews?.(init?.params?.query) ?? ok({ reviews: [review()] }));
    return Promise.resolve(fail(500));
  });
  const POST = vi.fn((path: string, init?: { body?: unknown }): Promise<Reply> => {
    if (path.endsWith("/complete"))
      return Promise.resolve(routes.complete?.(init?.body) ?? ok(detail({ status: "reviewed" })));
    if (path.endsWith("/end"))
      return Promise.resolve(routes.end?.() ?? ok(grant({ status: "revoked" })));
    return Promise.resolve(routes.create?.(init?.body) ?? ok(grant()));
  });
  const writes = [vi.fn(), vi.fn(), vi.fn()];
  const Where = () => <output data-testid="where">{useLocation().pathname}</output>;
  const view = render(
    <MemoryRouter initialEntries={["/messaging"]}>
      <ApiClientProvider
        client={
          { GET, POST, PUT: writes[0], PATCH: writes[1], DELETE: writes[2] } as unknown as ApiClient
        }
      >
        <SessionProvider
          session={{
            userId: ME,
            organizationId: "org-1",
            permissions: opts.permissions ?? ["messaging.break_glass.invoke"],
          }}
        >
          <FeatureFlagProvider flags={{ "messaging.break_glass": opts.flag ?? true }}>
            <main>
              {ui}
              <Where />
            </main>
          </FeatureFlagProvider>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST, writes, ...view };
}

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const fillRequest = async (justification = WHY) => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Request break-glass access" }));
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByLabelText(/Justification/), justification);
  return { user, dialog };
};

describe("Request entry", () => {
  it("is offered only with the invoke key AND the live flag", () => {
    mount(<BreakGlassRequest channelId={CHANNEL} onOpened={() => {}} onNotNeeded={() => {}} />);
    expect(screen.getByRole("button", { name: "Request break-glass access" })).toBeTruthy();
    cleanup();
    mount(
      <BreakGlassRequest channelId={CHANNEL} onOpened={() => {}} onNotNeeded={() => {}} />,
      {},
      { flag: false },
    );
    expect(screen.queryByRole("button", { name: "Request break-glass access" })).toBeNull();
    cleanup();
    mount(
      <BreakGlassRequest channelId={CHANNEL} onOpened={() => {}} onNotNeeded={() => {}} />,
      {},
      { permissions: ["messaging.read"] },
    );
    expect(screen.queryByRole("button", { name: "Request break-glass access" })).toBeNull();
  });

  it("says plainly what the access is, refuses a short justification without a request, and sends the exact body", async () => {
    const onOpened = vi.fn();
    const { POST } = mount(
      <BreakGlassRequest channelId={CHANNEL} onOpened={onOpened} onNotNeeded={() => {}} />,
    );
    const { user, dialog } = await fillRequest("too short");
    expect(dialog.textContent).toContain("reading only");
    expect(dialog.textContent).toContain("Every read is recorded");
    expect(dialog.textContent).toContain("reviewer");
    await user.click(within(dialog).getByRole("button", { name: "Open access" }));
    expect(await within(dialog).findByText(/20 to 280 characters/)).toBeTruthy();
    expect(POST).not.toHaveBeenCalled();
    await user.clear(within(dialog).getByLabelText(/Justification/));
    await user.type(within(dialog).getByLabelText(/Justification/), WHY);
    await user.click(within(dialog).getByRole("button", { name: "Open access" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));
    expect(POST).toHaveBeenCalledWith("/api/v1/messaging/break-glass", {
      body: {
        channelId: CHANNEL,
        reasonCode: "patient_safety",
        justification: WHY,
        durationMinutes: 240,
      },
    });
  });

  it("a custom duration outside 15 to 1440 minutes is refused before any request", async () => {
    const { POST } = mount(
      <BreakGlassRequest channelId={CHANNEL} onOpened={() => {}} onNotNeeded={() => {}} />,
    );
    const { user, dialog } = await fillRequest();
    await user.selectOptions(within(dialog).getByLabelText("Duration"), "custom");
    await user.type(within(dialog).getByLabelText(/Minutes/), "5");
    await user.click(within(dialog).getByRole("button", { name: "Open access" }));
    expect(await within(dialog).findByText(/15 minutes to 24 hours/)).toBeTruthy();
    expect(POST).not.toHaveBeenCalled();
  });

  it("a refusal never says why; only ALREADY_ACTIVE counts as opened, NOT_NEEDED refreshes the list and says so", async () => {
    const onOpened = vi.fn();
    const onNotNeeded = vi.fn();
    const first = mount(
      <BreakGlassRequest channelId={CHANNEL} onOpened={onOpened} onNotNeeded={onNotNeeded} />,
      {
        create: () => fail(404, { error: { code: "NOT_FOUND" } }),
      },
    );
    const a = await fillRequest();
    await a.user.click(within(a.dialog).getByRole("button", { name: "Open access" }));
    expect(
      await within(a.dialog).findByText("Access is not available for this conversation."),
    ).toBeTruthy();
    expect(a.dialog.textContent).not.toMatch(/Part 2|substance|role|category|consent/i);
    expect(onOpened).not.toHaveBeenCalled();
    expect(onNotNeeded).not.toHaveBeenCalled();
    first.unmount();
    const opened = vi.fn();
    const notNeeded = vi.fn();
    const m = mount(
      <BreakGlassRequest channelId={CHANNEL} onOpened={opened} onNotNeeded={notNeeded} />,
      {
        create: () => fail(409, { error: { code: "BREAK_GLASS_ALREADY_ACTIVE" } }),
      },
    );
    const b = await fillRequest();
    await b.user.click(within(b.dialog).getByRole("button", { name: "Open access" }));
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    expect(notNeeded).not.toHaveBeenCalled();
    m.unmount();
    const o2 = vi.fn();
    const n2 = vi.fn();
    mount(<BreakGlassRequest channelId={CHANNEL} onOpened={o2} onNotNeeded={n2} />, {
      create: () => fail(409, { error: { code: "BREAK_GLASS_NOT_NEEDED" } }),
    });
    const c = await fillRequest();
    await c.user.click(within(c.dialog).getByRole("button", { name: "Open access" }));
    await waitFor(() => expect(n2).toHaveBeenCalledTimes(1));
    expect(o2).not.toHaveBeenCalled();
  });

  it("an unknown 409 is a failure, never an open", async () => {
    const onOpened = vi.fn();
    mount(<BreakGlassRequest channelId={CHANNEL} onOpened={onOpened} onNotNeeded={() => {}} />, {
      create: () => fail(409, { error: { code: "SOMETHING_ELSE" } }),
    });
    const a = await fillRequest();
    await a.user.click(within(a.dialog).getByRole("button", { name: "Open access" }));
    expect(await within(a.dialog).findByText(/could not be opened/)).toBeTruthy();
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("429 gets a fixed neutral message that names no cap, and sends no one to step-up", async () => {
    mount(<BreakGlassRequest channelId={CHANNEL} onOpened={() => {}} onNotNeeded={() => {}} />, {
      create: () => fail(429, { error: { code: "BREAK_GLASS_LIMIT" } }),
    });
    const a = await fillRequest();
    await a.user.click(within(a.dialog).getByRole("button", { name: "Open access" }));
    const text = await within(a.dialog).findByText(/Too many break-glass requests/);
    expect(text.textContent).toBe(
      "Too many break-glass requests. End access you no longer need, or try again later.",
    );
    expect(text.textContent).not.toMatch(/\d/);
    expect(screen.getByTestId("where").textContent).not.toContain("/step-up");
    expect(window.sessionStorage.length).toBe(0);
  });

  it("a stale step-up stashes the draft, goes to the step-up page, and coming back reopens the dialog filled", async () => {
    const first = mount(
      <BreakGlassRequest channelId={CHANNEL} onOpened={() => {}} onNotNeeded={() => {}} />,
      {
        create: () => fail(403, { error: { code: "STEP_UP_REQUIRED" } }),
      },
    );
    const a = await fillRequest();
    await a.user.click(within(a.dialog).getByRole("button", { name: "Open access" }));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toContain("/step-up"));
    // The justification is in the scoped session stash only: never in a URL or localStorage.
    expect(JSON.stringify(Object.entries(window.localStorage))).not.toContain("Covering");
    expect(window.sessionStorage.length).toBeGreaterThan(0);
    first.unmount();
    // Back from the step-up page for this path.
    const { markStepUpReturn } = await import("../../shell/step-up-redirect");
    markStepUpReturn("/messaging");
    mount(<BreakGlassRequest channelId={CHANNEL} onOpened={() => {}} onNotNeeded={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText(/Justification/) as HTMLTextAreaElement).value).toBe(WHY);
  });

  it("offline disables the request and says so; nothing is queued", async () => {
    const online = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    const { POST } = mount(
      <BreakGlassRequest channelId={CHANNEL} onOpened={() => {}} onNotNeeded={() => {}} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Request break-glass access" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Open access" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(dialog).getByText(/offline/i)).toBeTruthy();
    expect(POST).not.toHaveBeenCalled();
    online.mockRestore();
  });

  it("the dialog is axe clean", async () => {
    mount(<BreakGlassRequest channelId={CHANNEL} onOpened={() => {}} onNotNeeded={() => {}} />);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Request break-glass access" }));
    const dialog = await screen.findByRole("dialog");
    expect((await axe.run(dialog)).violations).toEqual([]);
  });
});

describe("Read-only conversation under a grant", () => {
  it("shows the persistent banner (role status), the messages as plain text, and no write control", async () => {
    const { GET } = mount(<BreakGlassPane channelId={CHANNEL} />, {
      mine: () => ok({ grants: [grant()] }),
    });
    const ends = await screen.findByText(/Break-glass access to this conversation ends/);
    // <output> is the status region (implicit role="status"); the countdown beside it is not a live region.
    expect(ends.closest("output")).not.toBeNull();
    expect(screen.getAllByRole("status").some((o) => o.textContent?.includes("ends"))).toBe(true);
    expect(screen.getByText(/Every read is recorded/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "End now" })).toBeTruthy();
    // Message text is text, never markup.
    expect(await screen.findByText("<script>alert(1)</script> hello")).toBeTruthy();
    expect(screen.getByText("Pat <i>Nurse</i>")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    // Read-only: nothing that would answer 403.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /send|react|pin|attach|reply/i })).toBeNull();
    expect(screen.getByText(/does not allow sending/)).toBeTruthy();
    expect(
      GET.mock.calls.some(([p]) => String(p).includes("/search") || String(p).includes("/pins")),
    ).toBe(false);
    expect(GET).toHaveBeenCalledWith(
      "/api/v1/messaging/channels/{id}/messages",
      expect.objectContaining({ params: expect.objectContaining({ path: { id: CHANNEL } }) }),
    );
  });

  it("End now ends the grant and falls back to the not-available state with the request entry", async () => {
    let live = true;
    const { POST } = mount(<BreakGlassPane channelId={CHANNEL} />, {
      mine: () => ok({ grants: live ? [grant()] : [grant({ status: "revoked" })] }),
      end: () => {
        live = false;
        return ok(grant({ status: "revoked" }));
      },
    });
    await userEvent.setup().click(await screen.findByRole("button", { name: "End now" }));
    expect(await screen.findByText("This conversation is not available.")).toBeTruthy();
    expect(screen.getByText("Break-glass access to this conversation has ended.")).toBeTruthy();
    expect(POST).toHaveBeenCalledWith("/api/v1/messaging/break-glass/{id}/end", {
      params: { path: { id: GRANT } },
    });
    expect(screen.getByRole("button", { name: "Request break-glass access" })).toBeTruthy();
  });

  it("when the grant's end passes, the grants are re-read and the view falls back politely", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let live = true;
    const { GET } = mount(<BreakGlassPane channelId={CHANNEL} />, {
      mine: () =>
        ok({
          grants: [
            live
              ? grant({ expiresAt: new Date(Date.now() + 5_000).toISOString() })
              : grant({ status: "expired" }),
          ],
        }),
    });
    expect(await screen.findByRole("button", { name: "End now" })).toBeTruthy();
    const reads = () => GET.mock.calls.filter(([p]) => String(p).endsWith("/mine")).length;
    const before = reads();
    live = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(await screen.findByText("This conversation is not available.")).toBeTruthy();
    expect(screen.getByText("Break-glass access to this conversation has ended.")).toBeTruthy();
  });

  it("a skewed clock cannot leave the view dead: past the end it is treated as ended and re-read every 15 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The server keeps answering "active" with the SAME end instant (our clock ran ahead of its).
    const fixed = grant({ expiresAt: new Date(Date.now() + 5_000).toISOString() });
    const { GET } = mount(<BreakGlassPane channelId={CHANNEL} />, {
      mine: () => ok({ grants: [fixed] }),
    });
    expect(await screen.findByRole("button", { name: "End now" })).toBeTruthy();
    const reads = () => GET.mock.calls.filter(([p]) => String(p).endsWith("/mine")).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(screen.queryByRole("button", { name: "End now" })).toBeNull();
    expect(screen.getByText("Break-glass access to this conversation has ended.")).toBeTruthy();
    const afterFirst = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(reads()).toBeGreaterThanOrEqual(afterFirst + 2);
  });

  it("End now on 409 or 404 means it already ended: it re-reads and reports no failure", async () => {
    for (const status of [409, 404]) {
      let live = true;
      mount(<BreakGlassPane channelId={CHANNEL} />, {
        mine: () => ok({ grants: live ? [grant()] : [grant({ status: "revoked" })] }),
        end: () => {
          live = false;
          return fail(status, { error: { code: "X" } });
        },
      });
      await userEvent.setup().click(await screen.findByRole("button", { name: "End now" }));
      expect(await screen.findByText("This conversation is not available.")).toBeTruthy();
      expect(screen.queryByText("Access could not be ended. Try again.")).toBeNull();
      cleanup();
    }
  });

  it("Load earlier messages is guarded: disabled while loading, one request for a double click, no duplicate rows", async () => {
    let settle: (r: Reply) => void = () => {};
    let calls = 0;
    const older = {
      messages: [
        MESSAGES.messages[0],
        {
          ...MESSAGES.messages[0],
          messageId: "m0",
          body: "older text",
          createdAt: "2026-10-21T08:00:00.000Z",
        },
      ],
    };
    mount(<BreakGlassPane channelId={CHANNEL} />, {
      mine: () => ok({ grants: [grant()] }),
      messages: () => {
        calls += 1;
        if (calls === 1) return ok({ ...MESSAGES, nextCursor: "c1" });
        return new Promise<Reply>((resolve) => {
          settle = resolve;
        }) as unknown as Reply;
      },
    });
    await screen.findByText("<script>alert(1)</script> hello");
    const more = screen.getByRole("button", { name: "Load earlier messages" });
    fireEvent.click(more);
    fireEvent.click(more);
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.getByRole("button", { name: "Load earlier messages" })).toHaveProperty(
      "disabled",
      true,
    );
    await act(async () => settle(ok(older)));
    expect(await screen.findByText("older text")).toBeTruthy();
    expect(calls).toBe(2);
    expect(screen.getAllByText("<script>alert(1)</script> hello")).toHaveLength(1);
  });

  it("a member who asks (NOT_NEEDED) sees the visible outcome and the channel list is refreshed", async () => {
    const refresh = vi.fn();
    mount(<BreakGlassPane channelId={CHANNEL} onRefreshChannels={refresh} />, {
      create: () => fail(409, { error: { code: "BREAK_GLASS_NOT_NEEDED" } }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Request break-glass access" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Justification/), WHY);
    await user.click(within(dialog).getByRole("button", { name: "Open access" }));
    expect(await screen.findByText(/You can already open this conversation/)).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("no grant: the same not-available state a stranger sees, with the request entry only when eligible", async () => {
    mount(<BreakGlassPane channelId={CHANNEL} />);
    expect(await screen.findByText("This conversation is not available.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request break-glass access" })).toBeTruthy();
    cleanup();
    mount(<BreakGlassPane channelId={CHANNEL} />, {}, { permissions: ["messaging.read"] });
    expect(await screen.findByText("This conversation is not available.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Request break-glass access" })).toBeNull();
  });

  it("a grant for another conversation does not open this one", async () => {
    mount(<BreakGlassPane channelId={CHANNEL} />, {
      mine: () => ok({ grants: [grant({ channelId: "44444444-4444-4444-8444-444444444444" })] }),
    });
    expect(await screen.findByText("This conversation is not available.")).toBeTruthy();
    expect(screen.queryByText(/Break-glass access to this conversation ends/)).toBeNull();
  });

  it("is axe clean", async () => {
    const { container } = mount(<BreakGlassPane channelId={CHANNEL} />, {
      mine: () => ok({ grants: [grant()] }),
    });
    await screen.findByText("<script>alert(1)</script> hello");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

const REVIEWER = { permissions: ["messaging.break_glass.review"] };

describe("Compliance review", () => {
  it("lists pending reviews oldest first with state as words, an overdue count and free text as text", async () => {
    const { GET } = mount(
      <BreakGlassReview />,
      {
        reviews: () =>
          ok({
            reviews: [
              review(),
              review({
                reviewId: "55555555-5555-4555-8555-555555555555",
                overdue: false,
                stillActive: true,
              }),
            ],
          }),
      },
      REVIEWER,
    );
    const list = await screen.findByRole("list", { name: "Break-glass reviews" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Casey Nurse");
    expect(rows[0]?.textContent).toContain("Night team");
    expect(rows[0]?.textContent).toContain("3 reads");
    expect(within(rows[0] as HTMLElement).getByText("Open")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Overdue")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Access still open")).toBeTruthy();
    expect(screen.getByText("1 review overdue")).toBeTruthy();
    expect(GET).toHaveBeenCalledWith("/api/v1/messaging/break-glass/reviews", {
      params: { query: { status: "pending" } },
    });
    fireEvent.click(screen.getByRole("tab", { name: "Reviewed" }));
    await waitFor(() =>
      expect(GET).toHaveBeenCalledWith("/api/v1/messaging/break-glass/reviews", {
        params: { query: { status: "reviewed" } },
      }),
    );
  });

  it("a care-team row never shows a channel title", async () => {
    mount(
      <BreakGlassReview />,
      {
        reviews: () =>
          ok({
            reviews: [review({ channelKind: "care_team", channelTitle: null, patientId: "pid" })],
          }),
      },
      REVIEWER,
    );
    expect(await screen.findByText(/A care-team conversation/)).toBeTruthy();
  });

  it("the detail shows the justification as text and the reads (kind, count, time) and no message text", async () => {
    mount(<BreakGlassReview />, {}, REVIEWER);
    fireEvent.click(await screen.findByRole("button", { name: "Open review" }));
    expect(await screen.findByText("<b>Needed</b> to correct a handoff note")).toBeTruthy();
    const reads = screen.getByRole("list", { name: "Recorded reads" });
    expect(reads.textContent).toContain("Opened the conversation");
    expect(reads.textContent).toContain("Read messages (12)");
  });

  it("a concern needs a note (no request without it); then completes with the exact body", async () => {
    const { POST } = mount(<BreakGlassReview />, {}, REVIEWER);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open review" }));
    await user.click(await screen.findByLabelText("Concern"));
    await user.click(screen.getByRole("button", { name: "Complete review" }));
    expect(await screen.findByText("A concern needs a note saying what it is.")).toBeTruthy();
    expect(POST).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(/Note/), "Read beyond what the reason needed");
    await user.click(screen.getByRole("button", { name: "Complete review" }));
    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith("/api/v1/messaging/break-glass/reviews/{id}/complete", {
        params: { path: { id: REVIEW } },
        body: { outcome: "concern", note: "Read beyond what the reason needed" },
      }),
    );
    expect(await screen.findByText("Review completed.")).toBeTruthy();
  });

  it("STILL_ACTIVE offers End access now, which ends the grant", async () => {
    const { POST } = mount(
      <BreakGlassReview />,
      {
        complete: () => fail(409, { error: { code: "BREAK_GLASS_STILL_ACTIVE" } }),
        detail: () => ok(detail({ stillActive: true })),
      },
      REVIEWER,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open review" }));
    await user.click(await screen.findByRole("button", { name: "Complete review" }));
    expect((await screen.findAllByText(/has not ended yet/)).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "End access now" }));
    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith("/api/v1/messaging/break-glass/{id}/end", {
        params: { path: { id: GRANT } },
      }),
    );
  });

  it("the person's own grant disables the form with the reason, before any request; another 403 is a generic refusal; REVIEW_DONE refreshes", async () => {
    const own = mount(
      <BreakGlassReview />,
      { detail: () => ok(detail({ granteeUserId: ME })) },
      REVIEWER,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open review" }));
    expect(
      await screen.findByText("You held this access, so someone else must review it."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Complete review" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(own.POST).not.toHaveBeenCalled();
    cleanup();
    mount(
      <BreakGlassReview />,
      { complete: () => fail(403, { error: { code: "FORBIDDEN" } }) },
      REVIEWER,
    );
    await user.click(await screen.findByRole("button", { name: "Open review" }));
    await user.click(await screen.findByRole("button", { name: "Complete review" }));
    expect(await screen.findByText("You are not permitted to complete this review.")).toBeTruthy();
    cleanup();
    const { GET } = mount(
      <BreakGlassReview />,
      { complete: () => fail(409, { error: { code: "BREAK_GLASS_REVIEW_DONE" } }) },
      REVIEWER,
    );
    await user.click(await screen.findByRole("button", { name: "Open review" }));
    await user.click(await screen.findByRole("button", { name: "Complete review" }));
    expect(await screen.findByText(/already completed/)).toBeTruthy();
    expect(
      GET.mock.calls.filter(([p]) => String(p).endsWith("/reviews/{id}")).length,
    ).toBeGreaterThan(1);
  });

  it("a truncated read list says so with the counts; a care-team row shows the patient id, never a title", async () => {
    mount(
      <BreakGlassReview />,
      {
        reviews: () =>
          ok({
            reviews: [
              review({
                channelKind: "care_team",
                channelTitle: null,
                patientId: "pat-1234",
                readCount: 600,
              }),
            ],
          }),
        detail: () =>
          ok(
            detail({
              channelKind: "care_team",
              channelTitle: null,
              patientId: "pat-1234",
              readCount: 600,
              readsTruncated: true,
            }),
          ),
      },
      REVIEWER,
    );
    const link = await screen.findByRole("link", { name: "pat-1234" });
    expect(link.getAttribute("href")).toBe("/patients/pat-1234");
    await userEvent.setup().click(screen.getByRole("button", { name: "Open review" }));
    expect(
      await screen.findByText(
        "Showing the first 2 of 600 reads. The rest are recorded but not listed here.",
      ),
    ).toBeTruthy();
    cleanup();
    mount(<BreakGlassReview />, {}, REVIEWER);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Open review" }));
    await screen.findByText("<b>Needed</b> to correct a handoff note");
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  it("End access now on 409 or 404 means it already ended: it re-reads and reports no failure", async () => {
    for (const status of [409, 404]) {
      const { GET } = mount(
        <BreakGlassReview />,
        {
          complete: () => fail(409, { error: { code: "BREAK_GLASS_STILL_ACTIVE" } }),
          detail: () => ok(detail({ stillActive: true })),
          end: () => fail(status, { error: { code: "X" } }),
        },
        REVIEWER,
      );
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Open review" }));
      await user.click(await screen.findByRole("button", { name: "End access now" }));
      const before = GET.mock.calls.filter(([p]) => String(p).endsWith("/reviews/{id}")).length;
      await waitFor(() =>
        expect(
          GET.mock.calls.filter(([p]) => String(p).endsWith("/reviews/{id}")).length,
        ).toBeGreaterThan(1),
      );
      expect(before).toBeGreaterThan(0);
      expect(screen.queryByText("Access could not be ended. Try again.")).toBeNull();
      cleanup();
    }
  });

  it("offline disables completing; a refusal on the list says so", async () => {
    const online = vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    const { POST } = mount(<BreakGlassReview />, {}, REVIEWER);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Open review" }));
    expect(await screen.findByRole("button", { name: "Complete review" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(POST).not.toHaveBeenCalled();
    online.mockRestore();
    cleanup();
    mount(<BreakGlassReview />, { reviews: () => fail(403) }, REVIEWER);
    expect(await screen.findByText(/not permitted to review break-glass access/)).toBeTruthy();
  });

  it("the queue and the detail are axe clean; the tabs work from the keyboard", async () => {
    const { container } = mount(<BreakGlassReview />, {}, REVIEWER);
    await screen.findByRole("list", { name: "Break-glass reviews" });
    expect((await axe.run(container)).violations).toEqual([]);
    const pending = screen.getByRole("tab", { name: "Pending" });
    pending.focus();
    fireEvent.keyDown(pending, { key: "ArrowRight" });
    expect(document.activeElement?.textContent).toBe("Reviewed");
    cleanup();
    mount(<BreakGlassReview />, {}, REVIEWER);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Open review" }));
    await screen.findByText("<b>Needed</b> to correct a handoff note");
    expect((await axe.run(document.body)).violations).toEqual([]);
  });
});
