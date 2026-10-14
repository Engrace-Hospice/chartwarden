// M36 WP 3.4: closing a task. A clinical task cannot be closed without a reason code (the submit is blocked here and
// refused by the server); a non-clinical task may close without one. No free text anywhere.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { TaskCloseDialog } from "./task-close-dialog";
import { TASK_FIXTURE } from "./tasks-test-fixture";

function mount(
  clinical: boolean,
  action: "complete" | "cancel",
  answer: unknown = {
    data: { task: { ...TASK_FIXTURE, status: "done" } },
    response: { status: 200 },
  },
) {
  const POST = vi.fn().mockResolvedValue(answer);
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(
    <ApiClientProvider client={{ POST } as unknown as ApiClient}>
      <TaskCloseDialog
        task={{ ...TASK_FIXTURE, clinical_concern: clinical }}
        action={action}
        onClose={onClose}
        onStale={vi.fn()}
        onDone={onDone}
      />
    </ApiClientProvider>,
  );
  return { POST, onClose, onDone };
}

describe("TaskCloseDialog", () => {
  it("blocks submit without a reason on a clinical task", async () => {
    const { POST } = mount(true, "complete");
    expect(screen.getByRole("dialog", { name: "Complete task" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Complete task" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Choose a reason/);
    expect(POST).not.toHaveBeenCalled();
  });

  it("sends the chosen reason code", async () => {
    const { POST, onDone } = mount(true, "complete");
    await userEvent.selectOptions(screen.getByLabelText(/Reason/), "handled_elsewhere");
    await userEvent.click(screen.getByRole("button", { name: "Complete task" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(POST).toHaveBeenCalledWith("/api/v1/messaging/tasks/{taskId}/complete", {
      params: { path: { taskId: "t1" } },
      body: { reason: "handled_elsewhere" },
    });
  });

  it("lets a non-clinical task close without a reason", async () => {
    const { POST } = mount(false, "cancel");
    await userEvent.click(screen.getByRole("button", { name: "Cancel task" }));
    await waitFor(() => expect(POST).toHaveBeenCalled());
    expect(POST.mock.calls[0]?.[1]).toMatchObject({ body: { reason: null } });
  });

  it("shows a state conflict from the server and stays open", async () => {
    const { onClose } = mount(false, "complete", {
      data: undefined,
      error: { error: { code: "TASK_STATE_CONFLICT", message: "x" } },
      response: { status: 409 },
    });
    await userEvent.click(screen.getByRole("button", { name: "Complete task" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed since/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape and submits on Cmd+Enter", async () => {
    const { POST, onClose } = mount(false, "complete");
    fireEvent.keyDown(screen.getByLabelText(/Reason/), { key: "Enter", metaKey: true });
    await waitFor(() => expect(POST).toHaveBeenCalled());
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
