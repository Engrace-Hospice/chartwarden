import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
// M36 WP 3.8: the Review tab list. Buttons come only from allowed_actions; a restricted row shows no patient and no
// actions; a decision re-reads the list and focus lands on the persistent status line; Esc returns focus to the trigger.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReviewQueueList } from "./review-queue-list";
import { RESTRICTED_FIXTURE, REVIEW_FIXTURE } from "./review-test-fixture";
import { useReviewItems } from "./use-review-items";

const PEOPLE = {
  data: {
    candidates: [{ kind: "staff", entityId: "u9", displayName: "Pat Rivera", detail: null }],
  },
};
const ready = (items: unknown[]) => ({ data: { enabled: true, items } });

function Harness() {
  const shared = useReviewItems("open");
  return <ReviewQueueList meId="u1" shared={shared} />;
}

function mount(open: unknown[], post: unknown = vi.fn(), resolved: unknown[] = []) {
  const GET = vi.fn((path: string, init?: { params?: { query?: { state?: string } } }) =>
    Promise.resolve(
      path === "/api/v1/messaging/review-items"
        ? ready(init?.params?.query?.state === "resolved" ? resolved : open)
        : PEOPLE,
    ),
  );
  render(
    <ApiClientProvider client={{ GET, POST: post } as unknown as ApiClient}>
      <Harness />
    </ApiClientProvider>,
  );
  return { GET, post: post as ReturnType<typeof vi.fn> };
}
const reads = (GET: ReturnType<typeof vi.fn>) =>
  GET.mock.calls.filter(([path]) => path === "/api/v1/messaging/review-items").length;

describe("ReviewQueueList", () => {
  it("always shows the no-paging notice and lists the patient with its cause", async () => {
    mount([REVIEW_FIXTURE]);
    const row = await screen.findByRole("listitem");
    expect(within(row).getByText("Jane Doe")).toBeTruthy();
    expect(within(row).getByText("Death")).toBeTruthy();
    expect(
      screen.getByText(
        "Messaging does not page anyone. Pending handoff items for this patient expire by policy.",
      ),
    ).toBeTruthy();
  });

  it("labels a care-team removal as such", async () => {
    mount([{ ...REVIEW_FIXTURE, source: "care_team_change", cause: "care_team_removed" }]);
    const row = await screen.findByRole("listitem");
    expect(within(row).getByText("Removed from the care team")).toBeTruthy();
  });

  it("offers only the actions the server allows", async () => {
    mount([{ ...REVIEW_FIXTURE, allowed_actions: ["close"] }]);
    const row = await screen.findByRole("listitem");
    expect(within(row).getByRole("button", { name: "Close task" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Reassign" })).toBeNull();
  });

  it("shows a restricted row with no patient and no actions", async () => {
    mount([RESTRICTED_FIXTURE]);
    const row = await screen.findByRole("listitem");
    expect(within(row).getByText("Restricted patient")).toBeTruthy();
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("marks a task that needs an owner with words", async () => {
    mount([{ ...REVIEW_FIXTURE, task: { ...REVIEW_FIXTURE.task, needs_owner: true } }]);
    expect(await screen.findByText("Needs new owner")).toBeTruthy();
  });

  it("renders names as text, never as markup", async () => {
    mount([{ ...REVIEW_FIXTURE, patient_display_name: "<img src=x onerror=alert(1)>" }]);
    await screen.findByText("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
  });

  it("reads the resolved state on demand and never shows open rows under it", async () => {
    const resolved = {
      ...REVIEW_FIXTURE,
      id: "r9",
      state: "resolved",
      resolution: "closed",
      resolution_reason: "action_taken",
      resolved_by_display_name: "Sup Visor",
      allowed_actions: [],
      patient_display_name: "Old Patient",
    };
    mount([REVIEW_FIXTURE], vi.fn(), [resolved]);
    await screen.findByText("Jane Doe");
    await userEvent.click(screen.getByRole("button", { name: "Resolved" }));
    expect(await screen.findByText("Old Patient")).toBeTruthy();
    expect(screen.queryByText("Jane Doe")).toBeNull();
    expect(screen.getByText(/Closed, Action taken, by Sup Visor/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close task" })).toBeNull();
  });

  it("says plainly when the queue is empty", async () => {
    mount([]);
    expect(await screen.findByText("Nothing is waiting for a decision.")).toBeTruthy();
  });

  it("closes with a reason code, re-reads, and lands focus on the status line", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ data: { item: REVIEW_FIXTURE }, response: { status: 200 } });
    const { GET } = mount([REVIEW_FIXTURE], post);
    await userEvent.click(await screen.findByRole("button", { name: "Close task" }));
    await userEvent.click(screen.getByRole("radio", { name: /Handled elsewhere/ }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Close task" }),
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/messaging/review-items/{reviewItemId}/close", {
        params: { path: { reviewItemId: "r1" } },
        body: { reason: "handled_elsewhere" },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(reads(GET)).toBeGreaterThan(1));
    const status = screen.getByText("Task closed. The review is resolved.");
    expect(document.activeElement).toBe(status);
  });

  it("reassigns to the chosen person", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ data: { item: REVIEW_FIXTURE }, response: { status: 200 } });
    mount([REVIEW_FIXTURE], post);
    await userEvent.click(await screen.findByRole("button", { name: "Reassign" }));
    await userEvent.click(await screen.findByRole("button", { name: "Pat Rivera" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Reassign" }),
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/messaging/review-items/{reviewItemId}/reassign", {
        params: { path: { reviewItemId: "r1" } },
        body: { to_user_id: "u9" },
      }),
    );
    expect(await screen.findByText("Task reassigned. The review is resolved.")).toBeTruthy();
  });

  it("returns focus to the opening button when Esc closes the dialog", async () => {
    mount([REVIEW_FIXTURE]);
    const trigger = await screen.findByRole("button", { name: "Close task" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("says the queue could not be loaded and shows no rows", async () => {
    const GET = vi.fn().mockResolvedValue({ error: {}, response: { status: 500 } });
    render(
      <ApiClientProvider client={{ GET, POST: vi.fn() } as unknown as ApiClient}>
        <Harness />
      </ApiClientProvider>,
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
  });
});
