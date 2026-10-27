import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
// M36 WP 3.4: handing a task to someone else. The candidates are the task channel's own members (the composer's source).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TaskReassignDialog } from "./task-reassign-dialog";
import { TASK_FIXTURE } from "./tasks-test-fixture";

const PEOPLE = {
  data: {
    candidates: [{ kind: "staff", entityId: "u9", displayName: "Pat Rivera", detail: null }],
  },
};

function mount(
  answer: unknown = {
    data: { task: { ...TASK_FIXTURE, assignee_id: "u9" } },
    response: { status: 200 },
  },
) {
  const GET = vi.fn().mockResolvedValue(PEOPLE);
  const POST = vi.fn().mockResolvedValue(answer);
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(
    <ApiClientProvider client={{ GET, POST } as unknown as ApiClient}>
      <TaskReassignDialog
        task={TASK_FIXTURE}
        meId="u1"
        onClose={onClose}
        onStale={vi.fn()}
        onDone={onDone}
      />
    </ApiClientProvider>,
  );
  return { GET, POST, onClose, onDone };
}

describe("TaskReassignDialog", () => {
  it("looks people up in the task's channel and posts the chosen assignee", async () => {
    const { GET, POST, onDone } = mount();
    expect(screen.getByRole("dialog", { name: "Reassign task" })).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: "Pat Rivera" }));
    await userEvent.click(screen.getByRole("button", { name: "Reassign" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(GET).toHaveBeenCalledWith(
      "/api/v1/messaging/channels/{id}/mention-candidates",
      expect.objectContaining({ params: expect.objectContaining({ path: { id: "c1" } }) }),
    );
    expect(POST).toHaveBeenCalledWith("/api/v1/messaging/tasks/{taskId}/reassign", {
      params: { path: { taskId: "t1" } },
      body: { assignee_user_id: "u9" },
    });
  });

  it("requires someone to be chosen", async () => {
    const { POST } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Reassign" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Choose who/);
    expect(POST).not.toHaveBeenCalled();
  });

  it("says when the person already holds an active task on the message", async () => {
    mount({
      data: undefined,
      error: { error: { code: "TASK_ASSIGNEE_ALREADY_HAS_ACTIVE", message: "x" } },
      response: { status: 409 },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Pat Rivera" }));
    await userEvent.click(screen.getByRole("button", { name: "Reassign" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already has an active task/);
  });

  it("closes on Escape", () => {
    const { onClose } = mount();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
