import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
// M8 WP 3.7: the "Proposed from a secure message" section. The quoted text is read-only and never copied into the
// addendum; the reviewer writes their own reason; hidden when off or empty; any refusal reads as "no longer available".
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { ProposedFromMessage } from "../proposed-from-message";

afterEach(cleanup);

const PROPOSAL = {
  request_id: "req-1",
  requested_by: "u1",
  requested_at: "2026-10-14T08:00:00.000Z",
  source_author_user_id: "u2",
  source_sent_at: "2026-10-14T07:00:00.000Z",
  snapshot_text: "Family reports new pain overnight.",
  source_state: "current" as const,
};
const list = (promotions: unknown[], enabled = true) => ({ data: { enabled, promotions } });
const refused = (status: number, code: string) => ({
  data: undefined,
  error: { error: { code, message: "server text" } },
  response: { status },
});

function mount(getAnswer: unknown, post: ReturnType<typeof vi.fn> = vi.fn()) {
  const GET = vi.fn().mockResolvedValue(getAnswer);
  const onChanged = vi.fn();
  render(
    <MemoryRouter>
      <ApiClientProvider client={{ GET, POST: post } as unknown as ApiClient}>
        <SessionProvider session={{ userId: "u3", organizationId: "o1" }}>
          <ProposedFromMessage encounterId="enc-1" onChanged={onChanged} />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, post, onChanged };
}

describe("ProposedFromMessage", () => {
  it("is hidden while proposals are off", async () => {
    const { GET } = mount(list([PROPOSAL], false));
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(screen.queryByText("Proposed from a secure message")).toBeNull();
  });

  it("is hidden when there is nothing proposed", async () => {
    const { GET } = mount(list([]));
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(screen.queryByText("Proposed from a secure message")).toBeNull();
  });

  it("is hidden when the response is not a proposal list at all", async () => {
    const { GET } = mount({ data: { templateKey: "k" } });
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(screen.queryByText("Proposed from a secure message")).toBeNull();
  });

  it.each([401, 403])(
    "renders nothing, and no alert, when the read is refused with %s",
    async (status) => {
      const { GET } = mount({
        data: undefined,
        error: { error: { code: "FORBIDDEN" } },
        response: { status },
      });
      await waitFor(() => expect(GET).toHaveBeenCalled());
      await Promise.resolve();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText(/could not be loaded/)).toBeNull();
    },
  );

  it("says so when the read fails", async () => {
    mount({ data: undefined, error: { error: { code: "X" } }, response: { status: 500 } });
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
  });

  it("shows the snapshot read-only with no edit control for it", async () => {
    mount(list([PROPOSAL]));
    const item = await screen.findByRole("listitem");
    expect(within(item).getByText("Family reports new pain overnight.")).toBeTruthy();
    expect(within(item).queryByRole("textbox")).toBeNull();
    expect(within(item).queryByText(/edited this message/)).toBeNull();
  });

  it("warns when the sender edited the message after it was proposed", async () => {
    mount(list([{ ...PROPOSAL, source_state: "edited_since" }]));
    expect((await screen.findByRole("note")).textContent).toMatch(/edited this message after/);
  });

  it("handles a proposal whose text cannot be shown", async () => {
    mount(list([{ ...PROPOSAL, snapshot_text: null }]));
    expect(await screen.findByText(/text is not available/)).toBeTruthy();
  });

  it("makes the reviewer write their own reason (nothing prefilled) and links the draft", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ data: { id: "add-9", status: "draft" }, response: { status: 201 } });
    const { onChanged } = mount(list([PROPOSAL]), post);
    await userEvent.click(await screen.findByRole("button", { name: "Start my addendum" }));
    const box = screen.getByRole("textbox");
    expect((box as HTMLTextAreaElement).value).toBe("");
    await userEvent.type(box, "too short");
    await userEvent.click(screen.getByRole("button", { name: "Create my addendum draft" }));
    expect(screen.getByText(/at least 20 characters in your own words/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();

    await userEvent.clear(box);
    await userEvent.type(box, "Family reported new overnight pain; reviewed with the nurse.");
    await userEvent.click(screen.getByRole("button", { name: "Create my addendum draft" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/api/v1/encounters/{encounterId}/addenda", {
      params: { path: { encounterId: "enc-1" } },
      body: {
        reason: "Family reported new overnight pain; reviewed with the nurse.",
        promotionRequestId: "req-1",
      },
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("focuses the textarea when the reason is too short", async () => {
    mount(list([PROPOSAL]));
    await userEvent.click(await screen.findByRole("button", { name: "Start my addendum" }));
    const box = screen.getByRole("textbox");
    await userEvent.click(screen.getByRole("button", { name: "Create my addendum draft" }));
    expect(screen.getByText(/at least 20 characters in your own words/)).toBeTruthy();
    expect(document.activeElement).toBe(box);
  });

  it("keeps focus on a surviving status line when the last proposal leaves", async () => {
    const post = vi.fn().mockResolvedValue({
      data: { promotionRequestId: "req-1", outcome: "rejected" },
      response: { status: 200 },
    });
    const GET = vi
      .fn()
      .mockResolvedValueOnce(list([PROPOSAL]))
      .mockResolvedValue(list([]));
    render(
      <MemoryRouter>
        <ApiClientProvider client={{ GET, POST: post } as unknown as ApiClient}>
          <SessionProvider session={{ userId: "u3", organizationId: "o1" }}>
            <ProposedFromMessage encounterId="enc-1" onChanged={vi.fn()} />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Decline" }));
    await userEvent.click(screen.getByRole("button", { name: "Decline proposal" }));
    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
    const status = await screen.findByText("Proposal declined.");
    expect(document.activeElement).toBe(status);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("returns focus to Start when the form is cancelled", async () => {
    mount(list([PROPOSAL]));
    const start = await screen.findByRole("button", { name: "Start my addendum" });
    await userEvent.click(start);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Start my addendum" }));
  });

  it("shows a neutral line on PROMOTION_NOT_AVAILABLE and re-reads", async () => {
    const post = vi.fn().mockResolvedValue(refused(422, "PROMOTION_NOT_AVAILABLE"));
    const { GET } = mount(list([PROPOSAL]), post);
    await userEvent.click(await screen.findByRole("button", { name: "Start my addendum" }));
    await userEvent.type(screen.getByRole("textbox"), "x".repeat(25));
    await userEvent.click(screen.getByRole("button", { name: "Create my addendum draft" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This proposal is no longer available.",
    );
    expect(GET.mock.calls.length).toBeGreaterThan(1);
  });

  it("explains a 409 (an addendum is already in progress)", async () => {
    const post = vi.fn().mockResolvedValue(refused(409, "CONFLICT"));
    mount(list([PROPOSAL]), post);
    await userEvent.click(await screen.findByRole("button", { name: "Start my addendum" }));
    await userEvent.type(screen.getByRole("textbox"), "x".repeat(25));
    await userEvent.click(screen.getByRole("button", { name: "Create my addendum draft" }));
    expect(await screen.findByText(/may already exist/)).toBeTruthy();
  });

  it("declines with a reason code and focuses the heading when the row leaves", async () => {
    const post = vi.fn().mockResolvedValue({
      data: { promotionRequestId: "req-1", outcome: "rejected" },
      response: { status: 200 },
    });
    const { GET } = mount(list([PROPOSAL]), post);
    await userEvent.click(await screen.findByRole("button", { name: "Decline" }));
    await userEvent.selectOptions(screen.getByLabelText("Reason for declining"), "duplicate");
    await userEvent.click(screen.getByRole("button", { name: "Decline proposal" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/encounters/{encounterId}/chart-promotions/{requestId}/reject",
        {
          params: { path: { encounterId: "enc-1", requestId: "req-1" } },
          body: { reasonCode: "duplicate" },
        },
      ),
    );
    await waitFor(() => expect(GET.mock.calls.length).toBeGreaterThan(1));
  });
});
