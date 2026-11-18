// @vitest-environment jsdom
// Re-entering a paper call is a multi-field form on a worklist screen, so it opens as a drawer in the detail rail beside
// the worklist (the redesign's pattern), not as a dialog over it. Cancel closes it and files nothing; File the call stays
// disabled until the form is complete.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperReentryWorklistView } from "./oncall-api";
import { PaperReentryWorklistScreen } from "./paper-reentry";

afterEach(cleanup);

const row: PaperReentryWorklistView = {
  id: "w1",
  providerEntityId: "pe-1",
  outageWindowId: "ow-1",
  shiftId: "shift-1",
  shiftStartsAt: "2026-11-17T20:00:00.000Z",
  shiftEndsAt: "2026-11-18T08:00:00.000Z",
  assignedToMembershipId: "m-lopez",
  reenteredAt: null,
  linkedTriageCallId: null,
  expiresAt: new Date(Date.now() + 36 * 3600_000).toISOString(),
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function mount(): { post: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async () => ok({}));
  const client = {
    GET: vi.fn(async () => ok([row])),
    POST: post,
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <PaperReentryWorklistScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post };
}

describe("paper re-entry worklist — re-enter a call", () => {
  it("opens the form as a drawer beside the worklist, not a dialog over it", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Re-enter a call" }));
    const drawer = await screen.findByRole("complementary", {
      name: "Re-enter a call taken on paper",
    });
    expect(within(drawer).getByLabelText("When the call actually came in")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The worklist stays on the page while the form is open.
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("closes from Cancel without filing anything", async () => {
    const { post } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Re-enter a call" }));
    const drawer = await screen.findByRole("complementary", {
      name: "Re-enter a call taken on paper",
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Re-enter a call taken on paper" }),
      ).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("pre-fills the call time, and keeps File the call disabled while that time is empty", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Re-enter a call" }));
    const drawer = await screen.findByRole("complementary", {
      name: "Re-enter a call taken on paper",
    });
    const filing = within(drawer).getByRole("button", {
      name: "File the call",
    }) as HTMLButtonElement;
    const when = within(drawer).getByLabelText(
      "When the call actually came in",
    ) as HTMLInputElement;
    expect(when.value).not.toBe("");
    expect(filing.disabled).toBe(false);
    fireEvent.change(when, { target: { value: "" } });
    expect(filing.disabled).toBe(true);
  });
});
