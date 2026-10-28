import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
// M36 WP 3.4: the "Convert to task" dialog. Assignee is required, due is optional, the server's 422/409/404 land next to
// the field they describe, and the dialog follows the shared modal contract (labelled, Escape closes, Ctrl/Cmd+Enter submits).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TaskConvertDialog } from "./task-convert-dialog";
import { TASK_NOTICE } from "./task-wording";

const TASK = { id: "t1", allowed_actions: [] };
const PEOPLE = {
  data: {
    candidates: [{ kind: "staff", entityId: "u9", displayName: "Pat Rivera", detail: null }],
  },
};
const failure = (status: number, code: string) => ({
  data: undefined,
  error: { error: { code, message: "x" } },
  response: { status },
});

function mount(
  post: unknown = vi
    .fn()
    .mockResolvedValue({ data: { task: TASK, created: true }, response: { status: 201 } }),
) {
  const GET = vi.fn().mockResolvedValue(PEOPLE);
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <ApiClientProvider client={{ GET, POST: post } as unknown as ApiClient}>
      <TaskConvertDialog
        channelId="c1"
        messageId="m1"
        meId="u1"
        onClose={onClose}
        onCreated={onCreated}
      />
    </ApiClientProvider>,
  );
  return { post: post as ReturnType<typeof vi.fn>, onClose, onCreated };
}
const pick = async (name: string) => userEvent.click(await screen.findByRole("button", { name }));

describe("TaskConvertDialog", () => {
  it("is a labelled modal with the no-paging notice always visible", () => {
    mount();
    expect(screen.getByRole("dialog", { name: "Convert to task" })).toBeTruthy();
    expect(screen.getByText(TASK_NOTICE)).toBeTruthy();
  });

  it("refuses to submit without an assignee", async () => {
    const { post } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Choose who/);
    expect(post).not.toHaveBeenCalled();
  });

  it("posts the chosen assignee, an end-of-day due instant and the clinical flag", async () => {
    const { post, onCreated } = mount();
    await pick("Pat Rivera");
    fireEvent.change(screen.getByLabelText(/Due date/), { target: { value: "2099-03-04" } });
    await userEvent.click(screen.getByLabelText(/Clinical concern/));
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(true));
    const [path, init] = post.mock.calls[0] as [
      string,
      { params: unknown; body: Record<string, unknown> },
    ];
    expect(path).toBe("/api/v1/messaging/channels/{id}/messages/{messageId}/tasks");
    expect(init.params).toEqual({ path: { id: "c1", messageId: "m1" } });
    expect(init.body.assignee_user_id).toBe("u9");
    expect(init.body.clinical_concern).toBe(true);
    const due = new Date(init.body.due_at as string);
    expect([due.getFullYear(), due.getMonth(), due.getDate(), due.getHours()]).toEqual([
      2099, 2, 4, 23,
    ]);
  });

  it("can assign to the caller without a lookup", async () => {
    const { post } = mount();
    await userEvent.click(screen.getByRole("button", { name: /Assign to me/ }));
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(
      (post.mock.calls[0]?.[1] as { body: { assignee_user_id: string } }).body.assignee_user_id,
    ).toBe("u1");
  });

  it("shows an invalid assignee next to the picker and stays open", async () => {
    const { onClose, onCreated } = mount(
      vi.fn().mockResolvedValue(failure(422, "TASK_ASSIGNEE_INVALID")),
    );
    await pick("Pat Rivera");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot be given this task/);
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("shows an invalid due date next to the date field", async () => {
    mount(vi.fn().mockResolvedValue(failure(422, "TASK_DUE_INVALID")));
    await pick("Pat Rivera");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/due date/i);
  });

  it("says the message is unavailable on a 404", async () => {
    mount(vi.fn().mockResolvedValue(failure(404, "NOT_FOUND")));
    await pick("Pat Rivera");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/no longer available/);
  });

  it("closes on Escape and submits on Ctrl+Enter", async () => {
    const { post, onClose } = mount();
    await pick("Pat Rivera");
    fireEvent.keyDown(screen.getByLabelText(/Due date/), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
