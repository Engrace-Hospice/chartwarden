import type { AckRequestDto } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
// M36 ADR-0078 (G-6) - the "Reassign" control on the acknowledgment-request card: offered only from viewer_actions.can_reassign,
// opening sends only the colleague read, a fresh Idempotency-Key per open, a generic refusal for every status, focus returns to the
// button on Escape or Cancel and goes to the card's status line after a saved reassign, and no id is ever shown.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REASSIGN_CANNOT_TAKE_TEXT,
  REASSIGN_CHANGED_TEXT,
  REASSIGN_COLLEAGUE_FALLBACK,
  REASSIGN_EMPTY_TEXT,
  REASSIGN_INDETERMINATE_TEXT,
  REASSIGN_LOAD_FAILED_TEXT,
  REASSIGN_NEEDS_COLLEAGUE_TEXT,
  REASSIGN_NOT_PERMITTED_TEXT,
  REASSIGN_SAVED_CARD_TEXT,
  REASSIGN_TOO_MANY_TEXT,
} from "./ack-reassign-wording";
import { AckForMessage, AckRequestsProvider } from "./ack-request-card";
import { ACK_STATUS_TEXT } from "./ack-wording";

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-15T12:10:00.000Z"), toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const LIST = "/api/v1/messaging/channels/{id}/escalations";
const CANDIDATES = "/api/v1/messaging/escalations/{id}/reassign-candidates";
const REASSIGN = "/api/v1/messaging/escalations/{id}/reassign";
const PERSON_ID = "11111111-1111-4111-8111-000000000003";
const OTHER_ID = "11111111-1111-4111-8111-000000000004";
const REQUEST_ID = "22222222-2222-4222-8222-000000000001";

const request = (over: Partial<AckRequestDto> = {}): AckRequestDto => ({
  id: REQUEST_ID,
  message_id: "m-1",
  channel_id: "c-1",
  patient_id: "p-1",
  ack_class: "important",
  addressed_role: null,
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
  viewer_actions: { can_acknowledge: false, can_reassign: true, can_resolve: false },
  ...over,
});
const colleagues = [
  { user_id: PERSON_ID, display_name: "Pat Nurse" },
  { user_id: OTHER_ID, display_name: null },
];
const candidatesOk = (candidates = colleagues) => ({
  data: { candidates },
  response: { status: 200 },
});

function mount(
  opts: {
    requests?: AckRequestDto[];
    candidates?: () => unknown;
    post?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const GET = vi.fn((path: string, _init?: unknown) =>
    Promise.resolve(
      path === CANDIDATES
        ? (opts.candidates ?? candidatesOk)()
        : { data: { requests: opts.requests ?? [request()] }, response: { status: 200 } },
    ),
  );
  const POST = opts.post ?? vi.fn().mockResolvedValue({ data: {}, response: { status: 200 } });
  render(
    <MemoryRouter>
      <ApiClientProvider client={{ GET, POST } as unknown as ApiClient}>
        <main>
          <AckRequestsProvider channelId="c-1" enabled>
            <AckForMessage messageId="m-1" />
          </AckRequestsProvider>
        </main>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST };
}

const reassignButton = () => screen.findByRole("button", { name: /^Reassign the request/ });
const confirmButton = () =>
  within(screen.getByRole("dialog")).getByRole("button", { name: /^Reassign request|^Saving/ });
const calls = (fn: ReturnType<typeof vi.fn>, path: string) =>
  fn.mock.calls.filter((c) => c[0] === path);

async function openDialog() {
  fireEvent.click(await reassignButton());
  return await screen.findByRole("dialog");
}
async function choosePat(dialog: HTMLElement) {
  fireEvent.click(await within(dialog).findByRole("radio", { name: "Pat Nurse" }));
}

describe("ack request card - reassign (G-6)", () => {
  it("offers no Reassign control when viewer_actions.can_reassign is false", async () => {
    mount({
      requests: [
        request({
          viewer_actions: { can_acknowledge: true, can_reassign: false, can_resolve: false },
        }),
      ],
    });
    await screen.findByRole("button", { name: /^Take responsibility/ });
    expect(screen.queryByRole("button", { name: /^Reassign/ })).toBeNull();
  });

  it("opens with only the colleague read, moves focus into the dialog, shows names and never an id", async () => {
    const { GET, POST } = mount();
    const dialog = await openDialog();

    await within(dialog).findByRole("radio", { name: "Pat Nurse" });
    expect(within(dialog).getByRole("radio", { name: REASSIGN_COLLEAGUE_FALLBACK })).toBeTruthy();
    expect(calls(GET, CANDIDATES)).toHaveLength(1);
    expect(GET.mock.calls.find((c) => c[0] === CANDIDATES)?.[1]).toEqual({
      params: { path: { id: REQUEST_ID } },
    });
    expect(POST).not.toHaveBeenCalled();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(
      within(dialog).getByText(/must sign in and take responsibility themselves/),
    ).toBeTruthy();
    expect(within(dialog).getByText(/not the emergency path/)).toBeTruthy();
    for (const id of [PERSON_ID, OTHER_ID, REQUEST_ID]) {
      expect(document.body.textContent).not.toContain(id);
    }
    expect(await axe.run(document.body)).toHaveProperty("violations", []);
  });

  it("keeps Confirm inert, with its explanation, until a colleague is chosen", async () => {
    const { POST } = mount();
    const dialog = await openDialog();
    await within(dialog).findByRole("radio", { name: "Pat Nurse" });

    const confirm = confirmButton();
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(confirm.getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.click(confirm);
    expect(POST).not.toHaveBeenCalled();

    await choosePat(dialog);
    expect(confirmButton().getAttribute("aria-disabled")).toBeNull();
  });

  it("says nobody else can take it when there are no colleagues", async () => {
    const { POST } = mount({ candidates: () => candidatesOk([]) });
    const dialog = await openDialog();
    expect(await within(dialog).findByText(REASSIGN_EMPTY_TEXT)).toBeTruthy();
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(within(dialog).queryByText(REASSIGN_NEEDS_COLLEAGUE_TEXT)).toBeNull();
    const confirm = confirmButton();
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(confirm.getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.click(confirm);
    expect(POST).not.toHaveBeenCalled();
  });

  it("says the colleagues could not be loaded and offers Retry", async () => {
    let fail = true;
    const { GET } = mount({
      candidates: () => (fail ? { error: {}, response: { status: 500 } } : candidatesOk()),
    });
    const dialog = await openDialog();
    expect(await within(dialog).findByText(REASSIGN_LOAD_FAILED_TEXT)).toBeTruthy();

    fail = false;
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(await within(dialog).findByRole("radio", { name: "Pat Nurse" })).toBeTruthy();
    expect(calls(GET, CANDIDATES)).toHaveLength(2);
  });

  it("sends the choice with a fresh Idempotency-Key, announces success politely, re-reads and focuses the status line", async () => {
    const { GET, POST } = mount();
    const dialog = await openDialog();
    await choosePat(dialog);
    fireEvent.click(confirmButton());

    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    const [path, init] = POST.mock.calls[0] as [string, Record<string, any>];
    expect(path).toBe(REASSIGN);
    expect(init.params.path.id).toBe(REQUEST_ID);
    expect(init.body).toEqual({ assigned_user_id: PERSON_ID });
    expect(init.params.header["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);

    expect(await screen.findByText(REASSIGN_SAVED_CARD_TEXT)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(calls(GET, LIST).length).toBeGreaterThanOrEqual(2));
    const status = screen.getByText(ACK_STATUS_TEXT.pending).closest("p");
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(screen.queryByRole("alert")?.textContent ?? "").toBe("");
  });

  it("mints a different Idempotency-Key each time the dialog is opened", async () => {
    const post = vi.fn().mockResolvedValue({ error: {}, response: { status: 422 } });
    const { POST } = mount({ post });
    const keys: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const dialog = await openDialog();
      await choosePat(dialog);
      fireEvent.click(confirmButton());
      await screen.findByText(REASSIGN_CANNOT_TAKE_TEXT);
      keys.push(
        (POST.mock.calls.at(-1)?.[1] as Record<string, any>).params.header["Idempotency-Key"],
      );
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    }
    expect(new Set(keys).size).toBe(2);
  });

  it.each([
    [422, REASSIGN_CANNOT_TAKE_TEXT, true],
    [429, REASSIGN_TOO_MANY_TEXT, true],
    [403, REASSIGN_NOT_PERMITTED_TEXT, true],
    [409, REASSIGN_CHANGED_TEXT, false],
    [404, REASSIGN_CHANGED_TEXT, false],
    [500, REASSIGN_INDETERMINATE_TEXT, false],
  ])("answers %s with generic words (dialog stays open: %s)", async (status, text, stays) => {
    const post = vi
      .fn()
      .mockResolvedValue({ error: { error: { code: "X" } }, response: { status } });
    mount({ post });
    const dialog = await openDialog();
    await choosePat(dialog);
    fireEvent.click(confirmButton());

    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole("dialog") !== null).toBe(stays);
    expect(document.body.textContent).not.toMatch(/ineligible|eligible|not on the care team/i);
  });

  it("treats a thrown call as indeterminate", async () => {
    mount({ post: vi.fn().mockRejectedValue(new Error("network")) });
    const dialog = await openDialog();
    await choosePat(dialog);
    fireEvent.click(confirmButton());
    expect(await screen.findByText(REASSIGN_INDETERMINATE_TEXT)).toBeTruthy();
  });

  it("sends a second confirm click only once while the first is in flight", async () => {
    let resolvePost: (v: unknown) => void = () => undefined;
    const post = vi.fn(
      () =>
        new Promise((r) => {
          resolvePost = r;
        }),
    );
    mount({ post });
    const dialog = await openDialog();
    await choosePat(dialog);
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());
    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => resolvePost({ data: {}, response: { status: 200 } }));
    await screen.findByText(REASSIGN_SAVED_CARD_TEXT);
  });

  it("returns focus to the Reassign button on Cancel and on Escape, sending nothing", async () => {
    const { POST } = mount();
    const button = await reassignButton();
    fireEvent.click(button);
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(POST).not.toHaveBeenCalled();
  });

  it("announces how many colleagues are available, politely", async () => {
    mount();
    const dialog = await openDialog();

    const status = await within(dialog).findByText("2 colleagues available.");

    expect(status.tagName).toBe("OUTPUT");
  });

  it("does not disable the colleague list while saving (aria-busy instead) and keeps focus inside the dialog", async () => {
    let finish: (v: unknown) => void = () => undefined;
    const post = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mount({ post });
    const dialog = await openDialog();
    await choosePat(dialog);

    fireEvent.click(confirmButton());

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const fieldset = within(dialog).getByRole("radio", { name: "Pat Nurse" }).closest("fieldset");
    expect(fieldset?.hasAttribute("disabled")).toBe(false);
    expect(fieldset?.getAttribute("aria-busy")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => finish({ data: {}, response: { status: 200 } }));
  });

  it("keeps focus inside the dialog when Retry reloads, and after a refusal; a changed choice clears the refusal", async () => {
    const candidates = vi
      .fn()
      .mockReturnValueOnce({ data: undefined, response: { status: 500 } })
      .mockReturnValue(candidatesOk());
    const post = vi.fn().mockResolvedValue({ error: {}, response: { status: 422 } });
    mount({ candidates, post });
    const dialog = await openDialog();
    const retry = await within(dialog).findByRole("button", { name: "Retry" });
    retry.focus();

    fireEvent.click(retry);

    await within(dialog).findByRole("radio", { name: "Pat Nurse" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await choosePat(dialog);
    fireEvent.click(confirmButton());
    const alert = await within(dialog).findByText(REASSIGN_CANNOT_TAKE_TEXT);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(alert).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("radio", { name: REASSIGN_COLLEAGUE_FALLBACK }));
    expect(within(dialog).queryByText(REASSIGN_CANNOT_TAKE_TEXT)).toBeNull();
  });

  it("says one generic thing for 404 and 409 and closes", async () => {
    const post = vi.fn().mockResolvedValue({ error: {}, response: { status: 409 } });
    mount({ post });
    const dialog = await openDialog();
    await choosePat(dialog);

    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await screen.findAllByText(REASSIGN_CHANGED_TEXT)).length).toBeGreaterThan(0);
  });

  it("keeps the open dialog (and the choice) when the list is re-read in the background", async () => {
    const { GET } = mount();
    const dialog = await openDialog();
    await choosePat(dialog);
    const before = calls(GET, "/api/v1/messaging/channels/{id}/escalations").length;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() =>
      expect(calls(GET, "/api/v1/messaging/channels/{id}/escalations").length).toBeGreaterThan(
        before,
      ),
    );
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(
      (within(dialog).getByRole("radio", { name: "Pat Nurse" }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("never leaves focus on the page when the Reassign button left with the re-read: the card, else the result region", async () => {
    // 409 and the re-read shows the request without the control (it moved on)
    let after = false;
    const GETs = vi.fn((path: string, _init?: unknown) =>
      Promise.resolve(
        path === CANDIDATES
          ? candidatesOk()
          : {
              data: {
                requests: [
                  after
                    ? request({
                        viewer_actions: {
                          can_acknowledge: false,
                          can_reassign: false,
                          can_resolve: false,
                        },
                      })
                    : request(),
                ],
              },
              response: { status: 200 },
            },
      ),
    );
    const POSTs = vi.fn(async () => {
      after = true;
      return { error: {}, response: { status: 409 } };
    });
    render(
      <MemoryRouter>
        <ApiClientProvider client={{ GET: GETs, POST: POSTs } as unknown as ApiClient}>
          <main>
            <AckRequestsProvider channelId="c-1" enabled>
              <AckForMessage messageId="m-1" />
            </AckRequestsProvider>
          </main>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    const dialog = await openDialog();
    await choosePat(dialog);

    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(screen.queryByRole("button", { name: /^Reassign the request/ })).toBeNull();
  });

  it("closes the dialog when the provider is turned off, and works where crypto.randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", {});
    try {
      const post = vi.fn().mockResolvedValue({ data: {}, response: { status: 200 } });
      const GETs = vi.fn((path: string, _init?: unknown) =>
        Promise.resolve(
          path === CANDIDATES
            ? candidatesOk()
            : { data: { requests: [request()] }, response: { status: 200 } },
        ),
      );
      const view = (enabled: boolean) => (
        <MemoryRouter>
          <ApiClientProvider client={{ GET: GETs, POST: post } as unknown as ApiClient}>
            <main>
              <AckRequestsProvider channelId="c-1" enabled={enabled}>
                <AckForMessage messageId="m-1" />
              </AckRequestsProvider>
            </main>
          </ApiClientProvider>
        </MemoryRouter>
      );
      const { rerender } = render(view(true));
      const dialog = await openDialog();
      await choosePat(dialog);
      fireEvent.click(confirmButton());
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      const calls0 = post.mock.calls[0] as unknown as [
        string,
        { params: { header: Record<string, string> } },
      ];
      expect((calls0[1].params.header["Idempotency-Key"] ?? "").length).toBeGreaterThan(8);

      await openDialog().catch(() => undefined);
      rerender(view(false));
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
