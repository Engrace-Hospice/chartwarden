// M14 WP 3.7: the "Proposed from secure messages" section. Metadata only (no message text); Add to agenda and Decline;
// hidden when off or empty; every owner-route refusal reads as one neutral line.
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingPromotions } from "./meeting-promotions";

afterEach(cleanup);

const PROPOSAL = {
  request_id: "req-1",
  patientId: "11111111-2222-3333-4444-555555555555",
  patient: { displayName: "Ann B.", mrnSuffix: "1234" },
  requested_by: "u1",
  requested_at: "2026-10-14T08:00:00.000Z",
  source_author_user_id: "u2",
  source_sent_at: "2026-10-14T07:00:00.000Z",
};
const list = (promotions: unknown[], enabled = true) => ({ data: { enabled, promotions } });

function mount(getAnswer: unknown, post: ReturnType<typeof vi.fn> = vi.fn()) {
  const GET = vi.fn().mockResolvedValue(getAnswer);
  const onAgendaChanged = vi.fn();
  render(
    <MemoryRouter>
      <ApiClientProvider client={{ GET, POST: post } as unknown as ApiClient}>
        <MeetingPromotions meetingId="mtg-1" onAgendaChanged={onAgendaChanged} />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, post, onAgendaChanged };
}

describe("MeetingPromotions", () => {
  it("is hidden while proposals are off", async () => {
    const { GET } = mount(list([PROPOSAL], false));
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(screen.queryByText("Proposed from secure messages")).toBeNull();
  });

  it("is hidden when there is nothing proposed", async () => {
    const { GET } = mount(list([]));
    await waitFor(() => expect(GET).toHaveBeenCalled());
    expect(screen.queryByText("Proposed from secure messages")).toBeNull();
  });

  it("says so when the read fails", async () => {
    mount({ data: undefined, error: { error: { code: "X" } }, response: { status: 500 } });
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
  });

  it("shows the patient and who/when, with no message text", async () => {
    mount(list([PROPOSAL]));
    const item = await screen.findByRole("listitem");
    expect(within(item).getByText("Ann B.")).toBeTruthy();
    expect(within(item).getByText(/Proposed by A care-team member on/)).toBeTruthy();
    expect(within(item).queryByRole("link", { name: /open message/i })).toBeNull();
  });

  it("adds to the agenda, refreshes the agenda and lands on the status line", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ data: { id: "a1", kind: "other" }, response: { status: 201 } });
    const { GET, onAgendaChanged } = mount(list([PROPOSAL]), post);
    await userEvent.click(await screen.findByRole("button", { name: "Add to agenda" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/idg/meetings/{id}/agenda/from-promotion", {
        params: {
          path: { id: "mtg-1" },
          header: { "Idempotency-Key": expect.stringMatching(/^[0-9a-f-]{36}$/) },
        },
        body: { promotionRequestId: "req-1" },
      }),
    );
    await waitFor(() => expect(onAgendaChanged).toHaveBeenCalled());
    await waitFor(() => expect(GET.mock.calls.length).toBeGreaterThan(1));
    expect(document.querySelector("output")?.textContent).toBe("Added to the agenda.");
  });

  it("shows one neutral line for PROMOTION_NOT_AVAILABLE", async () => {
    const post = vi.fn().mockResolvedValue({
      data: undefined,
      error: { error: { code: "PROMOTION_NOT_AVAILABLE", message: "server text" } },
      response: { status: 422 },
    });
    mount(list([PROPOSAL]), post);
    await userEvent.click(await screen.findByRole("button", { name: "Add to agenda" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("This proposal is no longer available.");
  });

  it("declines with a reason and returns focus to Decline on cancel", async () => {
    const post = vi.fn().mockResolvedValue({
      data: { promotionRequestId: "req-1", outcome: "rejected" },
      response: { status: 200 },
    });
    mount(list([PROPOSAL]), post);
    const decline = await screen.findByRole("button", { name: "Decline" });
    await userEvent.click(decline);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Decline" }));

    await userEvent.click(screen.getByRole("button", { name: "Decline" }));
    await userEvent.selectOptions(screen.getByLabelText("Reason for declining"), "wrong_patient");
    await userEvent.click(screen.getByRole("button", { name: "Decline proposal" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/idg/meetings/{id}/chart-promotions/{requestId}/reject",
        {
          params: { path: { id: "mtg-1", requestId: "req-1" } },
          body: { reasonCode: "wrong_patient" },
        },
      ),
    );
    await waitFor(() =>
      expect(document.querySelector("output")?.textContent).toBe("Proposal declined."),
    );
  });

  it("keeps the decline form and the chosen reason open on a generic failure, and focuses the status", async () => {
    const post = vi.fn().mockResolvedValue({
      data: undefined,
      error: { error: { code: "INTERNAL" } },
      response: { status: 500 },
    });
    mount(list([PROPOSAL]), post);
    await userEvent.click(await screen.findByRole("button", { name: "Decline" }));
    await userEvent.selectOptions(screen.getByLabelText("Reason for declining"), "duplicate");
    await userEvent.click(screen.getByRole("button", { name: "Decline proposal" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/That did not work/);
    expect((screen.getByLabelText("Reason for declining") as HTMLSelectElement).value).toBe(
      "duplicate",
    );
    expect(document.activeElement).toBe(alert);
  });

  it("clears the failure state when a new action starts", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        data: undefined,
        error: { error: { code: "INTERNAL" } },
        response: { status: 500 },
      })
      .mockResolvedValue({ data: { id: "a1", kind: "other" }, response: { status: 201 } });
    mount(list([PROPOSAL]), post);
    await userEvent.click(await screen.findByRole("button", { name: "Add to agenda" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Add to agenda" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("retries an add with the same Idempotency-Key until it settles", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        data: undefined,
        error: { error: { code: "INTERNAL" } },
        response: { status: 500 },
      })
      .mockResolvedValue({ data: { id: "a1", kind: "other" }, response: { status: 201 } });
    mount(list([PROPOSAL]), post);
    await userEvent.click(await screen.findByRole("button", { name: "Add to agenda" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Add to agenda" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const key = (call: number) => post.mock.calls[call]?.[1].params.header["Idempotency-Key"];
    expect(key(1)).toBe(key(0));
  });
});
