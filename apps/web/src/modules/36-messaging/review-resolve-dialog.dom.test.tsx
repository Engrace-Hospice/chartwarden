// M36 WP 3.8: the decision dialog. A reason or a person is required before anything is sent; typed refusals map to field
// text; a stale refusal (404/409) tells the list to re-read; nothing is sent twice.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { describe, expect, it, vi } from "vitest";
import { ReviewResolveDialog } from "./review-resolve-dialog";
import { REVIEW_FIXTURE } from "./review-test-fixture";

const PEOPLE = {
  data: {
    candidates: [{ kind: "staff", entityId: "u9", displayName: "Pat Rivera", detail: null }],
  },
};

function mount(mode: "reassign" | "close", answer: unknown) {
  const POST = vi.fn().mockResolvedValue(answer);
  const props = { onClose: vi.fn(), onStale: vi.fn(), onDone: vi.fn() };
  render(
    <ApiClientProvider
      client={{ GET: vi.fn().mockResolvedValue(PEOPLE), POST } as unknown as ApiClient}
    >
      <ReviewResolveDialog item={REVIEW_FIXTURE} mode={mode} meId="u1" {...props} />
    </ApiClientProvider>,
  );
  return { POST, ...props };
}
const refusal = (status: number, code: string) => ({
  data: undefined,
  error: { error: { code, message: "x" } },
  response: { status },
});

describe("ReviewResolveDialog", () => {
  it("requires a reason before closing and sends nothing without one", async () => {
    const { POST } = mount("close", { data: { item: REVIEW_FIXTURE } });
    await userEvent.click(screen.getByRole("button", { name: "Close task" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Choose a reason/);
    expect(POST).not.toHaveBeenCalled();
  });

  it("requires someone to be chosen before reassigning", async () => {
    const { POST } = mount("reassign", { data: { item: REVIEW_FIXTURE } });
    await userEvent.click(screen.getByRole("button", { name: "Reassign" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Choose who/);
    expect(POST).not.toHaveBeenCalled();
  });

  it("maps REVIEW_ASSIGNEE_INVALID to field text without echoing anything", async () => {
    const { onStale } = mount("reassign", refusal(422, "REVIEW_ASSIGNEE_INVALID"));
    await userEvent.click(await screen.findByRole("button", { name: "Pat Rivera" }));
    await userEvent.click(screen.getByRole("button", { name: "Reassign" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot take this task/);
    expect(onStale).not.toHaveBeenCalled();
  });

  it.each([
    [409, "REVIEW_ITEM_STATE_CONFLICT", /changed since you opened it/],
    [404, "NOT_FOUND", /no longer available/],
  ])("on a %s refusal says so and asks the list to re-read", async (status, code, text) => {
    const { onStale, onDone } = mount("close", refusal(status, code));
    await userEvent.click(screen.getByRole("radio", { name: /Duplicate/ }));
    await userEvent.click(screen.getByRole("button", { name: "Close task" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(text);
    expect(onStale).toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("reports done once on success and closes on Back without sending", async () => {
    const { POST, onDone, onClose } = mount("close", { data: { item: REVIEW_FIXTURE } });
    await userEvent.click(screen.getByRole("radio", { name: /Action taken/ }));
    await userEvent.click(screen.getByRole("button", { name: "Close task" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("close"));
    expect(POST).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalled();
  });
});
