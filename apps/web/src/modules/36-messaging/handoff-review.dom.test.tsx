import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
// M36 WP 3.5: the review drawer. Nothing is pre-selected, accept sends exactly the chosen ids, buttons come only from
// allowed_actions, restricted items show fixed wording, and a stale or refused answer is handled without losing the view.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { HandoffReviewDialog } from "./handoff-review-dialog";
import { HANDOFF_FIXTURE, ITEM_FIXTURE } from "./handoffs-test-fixture";

function mount(handoff: unknown = HANDOFF_FIXTURE, post: unknown = vi.fn()) {
  const GET = vi.fn().mockResolvedValue({ data: { handoff } });
  const onChanged = vi.fn();
  render(
    <ApiClientProvider client={{ GET, POST: post } as unknown as ApiClient}>
      <HandoffReviewDialog handoffId="h1" onClose={vi.fn()} onChanged={onChanged} />
    </ApiClientProvider>,
  );
  return { GET, post: post as ReturnType<typeof vi.fn>, onChanged };
}
const answer = (handoff: unknown) => ({ data: { handoff }, response: { status: 200 } });
const refusal = (status: number, code: string) => ({
  error: { error: { code } },
  response: { status },
});

describe("HandoffReviewDialog", () => {
  it("starts with nothing selected and refuses to accept nothing", async () => {
    const { post } = mount();
    const boxes = await screen.findAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect((box as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Accept selected (0)" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/at least one item/);
    expect(post).not.toHaveBeenCalled();
  });

  it("accepts exactly the chosen ids and announces the result", async () => {
    const post = vi
      .fn()
      .mockResolvedValue(answer({ ...HANDOFF_FIXTURE, allowed_actions: [], state: "accepted" }));
    const { onChanged } = mount(HANDOFF_FIXTURE, post);
    await userEvent.click((await screen.findAllByRole("checkbox"))[1]!);
    await userEvent.click(screen.getByRole("button", { name: "Accept selected (1)" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(
      "/api/v1/messaging/handoffs/{handoffId}/accept",
      expect.objectContaining({ body: { item_ids: ["i2"] } }),
    );
    expect(await screen.findByText("Selected items accepted.")).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Accept selected/ })).toBeNull();
  });

  it("declines everything remaining when nothing is selected, and only the selection otherwise", async () => {
    const post = vi.fn().mockResolvedValue(answer({ ...HANDOFF_FIXTURE, allowed_actions: [] }));
    mount(HANDOFF_FIXTURE, post);
    await userEvent.click(await screen.findByRole("button", { name: "Decline remaining" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ body: {} }));
  });

  it("declines only the selected items", async () => {
    const post = vi.fn().mockResolvedValue(answer({ ...HANDOFF_FIXTURE, allowed_actions: [] }));
    mount(HANDOFF_FIXTURE, post);
    await userEvent.click((await screen.findAllByRole("checkbox"))[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Decline selected (1)" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ body: { item_ids: ["i1"] } }),
    );
  });

  it("gives the sender only Cancel offer, read-only, and cancels", async () => {
    const post = vi.fn().mockResolvedValue(answer({ ...HANDOFF_FIXTURE, allowed_actions: [] }));
    mount({ ...HANDOFF_FIXTURE, allowed_actions: ["cancel"] }, post);
    await screen.findByRole("button", { name: "Cancel offer" });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Accept|Decline/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cancel offer" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(await screen.findByText("Offer withdrawn.")).toBeTruthy();
  });

  it("shows a closed handoff read-only with who now holds each accepted item", async () => {
    mount({
      ...HANDOFF_FIXTURE,
      state: "accepted",
      allowed_actions: [],
      items: [{ ...ITEM_FIXTURE, state: "accepted", accountable_display_name: "Alex Nurse" }],
    });
    expect(await screen.findByText(/Accepted by Alex Nurse/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("renders restricted, gone and unavailable items with fixed wording and cannot select them", async () => {
    mount({
      ...HANDOFF_FIXTURE,
      items: [
        {
          ...ITEM_FIXTURE,
          id: "r",
          patient_id: null,
          patient_display_name: null,
          mrn_suffix: null,
          ref_id: null,
          summary: { state: "restricted" },
        },
        { ...ITEM_FIXTURE, id: "g", kind: "task", summary: { state: "gone" } },
        { ...ITEM_FIXTURE, id: "u", kind: "refill_request", summary: { state: "unavailable" } },
      ],
    });
    expect(await screen.findByText("Restricted patient")).toBeTruthy();
    expect(screen.getByText(/Details are not shown to you/)).toBeTruthy();
    expect(screen.getByText(/No longer available/)).toBeTruthy();
    expect(screen.getByText(/Status could not be loaded/)).toBeTruthy();
    for (const box of screen.getAllByRole("checkbox"))
      expect((box as HTMLInputElement).disabled).toBe(true);
  });

  it("reloads, clears the selection and lands on the heading after a stale 409", async () => {
    const post = vi.fn().mockResolvedValue(refusal(409, "HANDOFF_STATE_CONFLICT"));
    const { GET, onChanged } = mount(HANDOFF_FIXTURE, post);
    GET.mockResolvedValueOnce({
      data: { handoff: { ...HANDOFF_FIXTURE, state: "expired", allowed_actions: [] } },
    });
    await userEvent.click((await screen.findAllByRole("checkbox"))[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Accept selected (1)" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed since you opened it/);
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    expect(onChanged).toHaveBeenCalled();
    // The closed answer removed the button that had focus: focus lands on the heading, not <body>.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Handoff" })),
    );
  });

  it("keeps the selection when a task cannot be moved", async () => {
    const post = vi.fn().mockResolvedValue(refusal(422, "HANDOFF_ITEM_NOT_TRANSFERABLE"));
    const { GET } = mount(HANDOFF_FIXTURE, post);
    await userEvent.click((await screen.findAllByRole("checkbox"))[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Accept selected (1)" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot be moved to you/);
    expect(GET).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getAllByRole("checkbox")[0] as HTMLInputElement).checked).toBe(true);
  });

  it("is operable by keyboard alone and has no serious accessibility violations", async () => {
    const post = vi.fn().mockResolvedValue(answer({ ...HANDOFF_FIXTURE, allowed_actions: [] }));
    mount(HANDOFF_FIXTURE, post);
    const boxes = await screen.findAllByRole("checkbox");
    const violations = (
      await axe.run(document.body, {
        runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"],
        rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
      })
    ).violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(violations.map((v) => v.id)).toEqual([]);
    boxes[0]?.focus();
    await userEvent.keyboard(" ");
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    screen.getByRole("button", { name: "Accept selected (1)" }).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(post).toHaveBeenCalled());
  });

  it("disables every action when the reload after a stale refusal fails", async () => {
    const post = vi.fn().mockResolvedValue(refusal(409, "HANDOFF_STATE_CONFLICT"));
    const { GET } = mount(HANDOFF_FIXTURE, post);
    GET.mockResolvedValueOnce({ error: {}, response: { status: 500 } });
    await userEvent.click((await screen.findAllByRole("checkbox"))[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Accept selected (1)" }));
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Accept selected/ })).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: /Decline/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("This handoff is no longer available.")).toBeTruthy();
  });

  it.each([403, 404])("treats a %s on accept as stale with the generic text", async (status) => {
    const post = vi.fn().mockResolvedValue(refusal(status, "X"));
    const { GET, onChanged } = mount(HANDOFF_FIXTURE, post);
    await userEvent.click((await screen.findAllByRole("checkbox"))[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Accept selected (1)" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This handoff is no longer available.",
    );
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    expect(onChanged).toHaveBeenCalled();
  });

  it("drops a response that resolves after the dialog unmounts", async () => {
    let release: (value: unknown) => void = () => undefined;
    const GET = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const view = render(
      <ApiClientProvider client={{ GET, POST: vi.fn() } as unknown as ApiClient}>
        <HandoffReviewDialog handoffId="h1" onClose={vi.fn()} onChanged={vi.fn()} />
      </ApiClientProvider>,
    );
    view.unmount();
    release({ data: { handoff: HANDOFF_FIXTURE } });
    await Promise.resolve();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("ignores identity fields on a restricted item and groups it with the others", async () => {
    const restricted = {
      ...ITEM_FIXTURE,
      summary: { state: "restricted" },
    };
    mount({
      ...HANDOFF_FIXTURE,
      items: [
        {
          ...restricted,
          id: "a",
          patient_id: "pa",
          patient_display_name: "Leaky A",
          mrn_suffix: "9999",
        },
        {
          ...restricted,
          id: "b",
          patient_id: "pb",
          patient_display_name: "Leaky B",
          mrn_suffix: "8888",
        },
      ],
    });
    expect(await screen.findAllByRole("heading", { name: "Restricted patient" })).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/Leaky|9999|8888/);
    expect(screen.getAllByText(/Next visit: Details are not shown to you/)).toHaveLength(2);
  });

  it("shows no date text for an invalid timestamp", async () => {
    mount({
      ...HANDOFF_FIXTURE,
      items: [
        { ...ITEM_FIXTURE, summary: { state: "ok", status: "scheduled", occurred_at: "nope" } },
      ],
    });
    expect(await screen.findByText(/Next visit: scheduled\./)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Invalid Date/);
  });
});
