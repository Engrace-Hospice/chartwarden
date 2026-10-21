// M36 WP 3.4 review fixes: the picker's single debounced lookup, scope-aware row replacement, a refetch after a stale
// refusal, one shared "my tasks" read in the inbox, and a double-click guard on Accept.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCloseDialog } from "./task-close-dialog";
import { TaskConvertDialog } from "./task-convert-dialog";
import { TasksList } from "./tasks-list";
import { TASK_FIXTURE } from "./tasks-test-fixture";

const PEOPLE = {
  data: {
    candidates: [{ kind: "staff", entityId: "u9", displayName: "Pat Rivera", detail: null }],
  },
};
const ready = (tasks: unknown[]) => ({ data: { enabled: true, tasks } });
const TASKS_PATH = "/api/v1/messaging/tasks";

function mountList(
  list: unknown,
  post: unknown = vi.fn(),
  people: unknown = PEOPLE,
): { GET: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> } {
  const GET = vi.fn(async (path: string) => (path === TASKS_PATH ? list : people));
  render(
    <MemoryRouter>
      <ApiClientProvider client={{ GET, POST: post } as unknown as ApiClient}>
        <TasksList meId="u1" />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, post: post as ReturnType<typeof vi.fn> };
}
const taskReads = (GET: ReturnType<typeof vi.fn>) =>
  GET.mock.calls.filter(([path]) => path === TASKS_PATH).length;

describe("assignee picker lookup", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("reads the candidates once after the debounce, and not again on re-render", async () => {
    const GET = vi.fn().mockResolvedValue(PEOPLE);
    render(
      <ApiClientProvider client={{ GET, POST: vi.fn() } as unknown as ApiClient}>
        <TaskConvertDialog
          channelId="c1"
          messageId="m1"
          meId="u1"
          onClose={vi.fn()}
          onCreated={vi.fn()}
        />
      </ApiClientProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(await screen.findByRole("button", { name: "Pat Rivera" })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(GET).toHaveBeenCalledTimes(1);
  });
});

describe("TasksList scope and staleness", () => {
  it("drops a reassigned-away row from Assigned to me", async () => {
    const post = vi.fn().mockResolvedValue({
      data: { task: { ...TASK_FIXTURE, assignee_id: "u9", allowed_actions: [] } },
      response: { status: 200 },
    });
    mountList(ready([{ ...TASK_FIXTURE, allowed_actions: ["reassign"] }]), post);
    await userEvent.click(await screen.findByRole("button", { name: "Reassign" }));
    await userEvent.click(await screen.findByRole("button", { name: "Pat Rivera" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Reassign" }),
    );
    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
    expect(screen.getByText("No active tasks.")).toBeTruthy();
  });

  it("re-reads the list after Accept is refused as a conflict", async () => {
    const post = vi.fn().mockResolvedValue({
      data: undefined,
      error: { error: { code: "TASK_STATE_CONFLICT", message: "x" } },
      response: { status: 409 },
    });
    const { GET } = mountList(ready([TASK_FIXTURE]), post);
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await waitFor(() => expect(taskReads(GET)).toBe(2));
  });

  it("re-reads the list after a close is refused as gone", async () => {
    const post = vi.fn().mockResolvedValue({
      data: undefined,
      error: { error: { code: "NOT_FOUND", message: "x" } },
      response: { status: 404 },
    });
    const { GET } = mountList(ready([TASK_FIXTURE]), post);
    await userEvent.click(await screen.findByRole("button", { name: "Complete" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Complete task" }),
    );
    await waitFor(() => expect(taskReads(GET)).toBe(2));
  });

  it("sends one request for two quick clicks on Accept", async () => {
    let release: (value: unknown) => void = () => undefined;
    const post = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    mountList(ready([TASK_FIXTURE]), post);
    const accept = await screen.findByRole("button", { name: "Accept" });
    await act(async () => {
      accept.click();
      accept.click();
    });
    expect(post).toHaveBeenCalledTimes(1);
    release({ data: { task: { ...TASK_FIXTURE, status: "accepted" } }, response: { status: 200 } });
  });
});

describe("close dialog error wiring", () => {
  it("ties the reason error to the select", async () => {
    render(
      <ApiClientProvider client={{ GET: vi.fn(), POST: vi.fn() } as unknown as ApiClient}>
        <TaskCloseDialog
          task={{ ...TASK_FIXTURE, clinical_concern: true }}
          action="complete"
          onClose={vi.fn()}
          onStale={vi.fn()}
          onDone={vi.fn()}
        />
      </ApiClientProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Complete task" }));
    const alert = await screen.findByRole("alert");
    expect(screen.getByRole("combobox").getAttribute("aria-describedby")).toBe(alert.id);
  });
});
