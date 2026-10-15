// M36 WP 4.2 - the acknowledgment-request card and its loader: text+icon status, buttons only from viewer_actions, one POST per
// click, indeterminate/definitive failure wording, a late answer for a left channel ignored, a transient load error with retry,
// and no request at all from opening, reading or focusing.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AckRequestDto } from "@wardenx/types";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AckForMessage, AckRequestsProvider } from "./ack-request-card";
import {
  ACK_CLOSE_LABEL,
  ACK_INDETERMINATE_TEXT,
  ACK_NOTICE,
  ACK_NOT_QUALIFIED_TEXT,
  ACK_STATUS_TEXT,
  ACK_TAKE_LABEL,
} from "./ack-wording";

const LIST = "/api/v1/messaging/channels/{id}/escalations";
const request = (over: Partial<AckRequestDto> = {}): AckRequestDto => ({
  id: "r-1",
  message_id: "m-1",
  channel_id: "c-1",
  patient_id: "p-1",
  ack_class: "important",
  status: "pending",
  requester_user_id: "u-1",
  assigned_user_id: "u-2",
  requested_at: "2026-10-15T12:00:00.000Z",
  window_started_at: "2026-10-15T12:00:00.000Z",
  deadline_at: "2026-10-15T13:00:00.000Z",
  current_tier: 0,
  acknowledged_at: null,
  acknowledged_by_user_id: null,
  resolved_at: null,
  cancelled_at: null,
  version: 0,
  viewer_actions: { can_acknowledge: true, can_reassign: true, can_resolve: false },
  ...over,
});
const ok = (requests: AckRequestDto[]) => ({ data: { requests }, response: { status: 200 } });

function mount(opts: {
  get?: (path: string, channel: string) => unknown;
  post?: ReturnType<typeof vi.fn>;
  channelId?: string;
}) {
  const GET = vi.fn((path: string, init: { params: { path: { id: string } } }) =>
    Promise.resolve(opts.get ? opts.get(path, init.params.path.id) : ok([request()])),
  );
  const POST = opts.post ?? vi.fn().mockResolvedValue({ data: {}, response: { status: 200 } });
  const client = { GET, POST } as unknown as ApiClient;
  const tree = (channelId: string) => (
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <AckRequestsProvider channelId={channelId} enabled>
          <AckForMessage messageId="m-1" />
        </AckRequestsProvider>
      </ApiClientProvider>
    </MemoryRouter>
  );
  const view = render(tree(opts.channelId ?? "c-1"));
  return { GET, POST, view, tree };
}

describe("ack request card", () => {
  it("shows the status as words with an icon, the deadline, and the fixed notice wired to the button", async () => {
    mount({});
    const take = await screen.findByRole("button", { name: ACK_TAKE_LABEL });

    expect(screen.getByText(ACK_STATUS_TEXT.pending)).toBeTruthy();
    expect(screen.getByText(/Waiting for you/)).toBeTruthy();
    expect(screen.getByText(/Respond by/)).toBeTruthy();
    expect(document.querySelector(".wx-ack-status svg")).not.toBeNull();
    const notice = screen.getByText(ACK_NOTICE);
    expect(take.getAttribute("aria-describedby")).toBe(notice.id);
    const results = await axe.run(document.body);
    expect(results.violations).toEqual([]);
  });

  it.each([
    [
      "pending",
      { can_acknowledge: false, can_reassign: true, can_resolve: false },
      [],
      /person it was sent to/,
    ],
    [
      "pending",
      { can_acknowledge: true, can_reassign: true, can_resolve: false },
      [ACK_TAKE_LABEL],
      /Waiting for you/,
    ],
    [
      "acknowledged",
      { can_acknowledge: false, can_reassign: true, can_resolve: true },
      [ACK_CLOSE_LABEL],
      null,
    ],
    ["resolved", { can_acknowledge: false, can_reassign: false, can_resolve: false }, [], null],
  ] as const)(
    "offers only the controls viewer_actions allows (%s)",
    async (status, viewer_actions, labels, waiting) => {
      mount({ get: () => ok([request({ status, viewer_actions })]) });
      await screen.findByText(ACK_STATUS_TEXT[status]);

      const buttons = screen.queryAllByRole("button").map((b) => b.textContent);
      expect(buttons).toEqual([...labels]);
      if (waiting) expect(screen.getByText(waiting)).toBeTruthy();
    },
  );

  it("sends exactly one acknowledge POST for a double click, then reloads", async () => {
    let resolvePost: (v: unknown) => void = () => undefined;
    const post = vi.fn(
      () =>
        new Promise((r) => {
          resolvePost = r;
        }),
    );
    const { GET } = mount({ post });
    const take = await screen.findByRole("button", { name: ACK_TAKE_LABEL });

    fireEvent.click(take);
    fireEvent.click(take);
    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls as unknown[][])[0]?.[0]).toBe(
      "/api/v1/messaging/escalations/{id}/acknowledge",
    );
    expect((take as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolvePost({ data: {}, response: { status: 200 } }));

    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
  });

  it("tells the person it may not have been saved when no answer came, and reloads", async () => {
    const post = vi.fn().mockRejectedValue(new Error("network"));
    const { GET } = mount({ post });

    fireEvent.click(await screen.findByRole("button", { name: ACK_TAKE_LABEL }));

    expect(await screen.findByText(ACK_INDETERMINATE_TEXT)).toBeTruthy();
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
  });

  it("says plainly when the role cannot take the message", async () => {
    const post = vi.fn().mockResolvedValue({
      error: { error: { code: "ACK_NOT_QUALIFIED" } },
      response: { status: 403 },
    });
    mount({ post });

    fireEvent.click(await screen.findByRole("button", { name: ACK_TAKE_LABEL }));

    expect(await screen.findByText(ACK_NOT_QUALIFIED_TEXT)).toBeTruthy();
  });

  it("a 409 reloads and shows the current state", async () => {
    let calls = 0;
    const post = vi.fn().mockResolvedValue({ error: {}, response: { status: 409 } });
    mount({
      post,
      get: () => {
        calls += 1;
        return ok([
          request(
            calls > 1
              ? {
                  status: "acknowledged",
                  viewer_actions: { can_acknowledge: false, can_reassign: true, can_resolve: true },
                }
              : {},
          ),
        ]);
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: ACK_TAKE_LABEL }));

    expect(await screen.findByText(ACK_STATUS_TEXT.acknowledged)).toBeTruthy();
  });

  it("ignores a late answer for a channel the person has left", async () => {
    let releaseA: (v: unknown) => void = () => undefined;
    const { view, tree } = mount({
      get: (_p, channel) =>
        channel === "c-1"
          ? new Promise((r) => {
              releaseA = r;
            })
          : ok([
              request({
                channel_id: "c-2",
                status: "resolved",
                viewer_actions: { can_acknowledge: false, can_reassign: false, can_resolve: false },
              }),
            ]),
    });

    view.rerender(tree("c-2"));
    await screen.findByText(ACK_STATUS_TEXT.resolved);
    await act(async () => releaseA(ok([request()])));

    expect(screen.queryByText(ACK_STATUS_TEXT.pending)).toBeNull();
    expect(screen.getByText(ACK_STATUS_TEXT.resolved)).toBeTruthy();
  });

  it("a transient load error shows a retry; a definitive one shows nothing", async () => {
    const first = mount({ get: () => ({ error: {}, response: { status: 503 } }) });
    expect(await screen.findByText(/Could not load requests/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    first.view.unmount();

    mount({ get: () => ({ error: {}, response: { status: 404 } }) });
    await waitFor(() => expect(screen.queryByText(/Could not load requests/)).toBeNull());
    expect(screen.queryByText(ACK_STATUS_TEXT.pending)).toBeNull();
  });

  it("opening, focusing and scrolling to the card sends nothing", async () => {
    const { POST } = mount({});
    const take = await screen.findByRole("button", { name: ACK_TAKE_LABEL });

    take.focus();
    take.scrollIntoView?.();
    fireEvent.focus(take);
    fireEvent.mouseOver(take);

    expect(POST).not.toHaveBeenCalled();
  });
});
