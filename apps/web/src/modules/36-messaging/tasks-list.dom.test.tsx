// M36 WP 3.4: "My tasks". Actions come only from the server's allowed_actions; a needs-owner badge is words plus a glyph;
// a closed answer replaces the row; the tenant flag off and the empty/error states say so plainly.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { TasksList } from "./tasks-list";
import { TASK_FIXTURE } from "./tasks-test-fixture";

function mount(list: unknown, post: unknown = vi.fn()) {
  const GET = vi.fn().mockResolvedValue(list);
  render(
    <MemoryRouter>
      <ApiClientProvider client={{ GET, POST: post } as unknown as ApiClient}>
        <TasksList meId="u1" />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, post: post as ReturnType<typeof vi.fn> };
}
const ready = (tasks: unknown[]) => ({ data: { enabled: true, tasks } });

describe("TasksList", () => {
  it("offers only the actions the server allows", async () => {
    mount(ready([{ ...TASK_FIXTURE, allowed_actions: ["reassign"] }]));
    const row = await screen.findByRole("listitem");
    expect(within(row).getByRole("button", { name: "Reassign" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Accept" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Complete" })).toBeNull();
    expect(within(row).getByRole("link", { name: "Open message" }).getAttribute("href")).toBe(
      "/messaging?channelId=c1&messageId=m1",
    );
  });

  it("marks a task that needs an owner with words, and a patient task as such", async () => {
    mount(
      ready([
        {
          ...TASK_FIXTURE,
          needs_owner: true,
          patient_id: "p1",
          clinical_concern: true,
          overdue: true,
          due_at: "2026-10-01T00:00:00.000Z",
        },
      ]),
    );
    expect(await screen.findByText("Needs new owner")).toBeTruthy();
    expect(screen.getByText("Patient task")).toBeTruthy();
    expect(screen.getByText("Overdue")).toBeTruthy();
  });

  it("replaces the row with the server's answer after Accept", async () => {
    const post = vi.fn().mockResolvedValue({
      data: { task: { ...TASK_FIXTURE, status: "accepted", allowed_actions: ["complete"] } },
      response: { status: 200 },
    });
    mount(ready([TASK_FIXTURE]), post);
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(await screen.findByText("Accepted")).toBeTruthy();
    expect(post).toHaveBeenCalledWith("/api/v1/messaging/tasks/{taskId}/accept", {
      params: { path: { taskId: "t1" } },
    });
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("reports a refused action and leaves the row as it was", async () => {
    const post = vi.fn().mockResolvedValue({
      data: undefined,
      error: { error: { code: "FORBIDDEN", message: "x" } },
      response: { status: 403 },
    });
    mount(ready([TASK_FIXTURE]), post);
    await userEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not allowed/);
    expect(screen.getByText("Open")).toBeTruthy();
  });

  it("opens the close dialog for Complete and drops the closed row from the active list", async () => {
    const post = vi.fn().mockResolvedValue({
      data: { task: { ...TASK_FIXTURE, status: "done", allowed_actions: [] } },
      response: { status: 200 },
    });
    mount(ready([TASK_FIXTURE]), post);
    await userEvent.click(await screen.findByRole("button", { name: "Complete" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Complete task" }),
    );
    await waitFor(() => expect(screen.queryByRole("listitem")).toBeNull());
    expect(screen.getByText("No active tasks.")).toBeTruthy();
  });

  it("re-reads when the scope or state toggle changes", async () => {
    const { GET } = mount(ready([]));
    await userEvent.click(await screen.findByRole("button", { name: "Created by me" }));
    await userEvent.click(screen.getByRole("button", { name: "Closed" }));
    await waitFor(() =>
      expect(GET).toHaveBeenLastCalledWith("/api/v1/messaging/tasks", {
        params: { query: { scope: "created", state: "closed" } },
      }),
    );
  });

  it("says plainly when tasks are off for the organization", async () => {
    mount({ data: { enabled: false, tasks: [] } });
    expect(await screen.findByText(/not turned on/)).toBeTruthy();
  });

  it("shows an error state when the list cannot be read", async () => {
    mount({ data: undefined, error: {}, response: { status: 500 } });
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be loaded/);
  });
});
