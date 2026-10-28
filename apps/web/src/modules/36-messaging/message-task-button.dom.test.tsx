import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
// M36 WP 3.4: the message-row trigger. Hidden while the tenant has tasks off (read once from the tasks list route's
// `enabled` field and shared by every row), opens the dialog, and gives focus back.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageTaskButton } from "./message-task-button";

function mount(answer: unknown) {
  const GET = vi.fn(async (path: string) =>
    path === "/api/v1/messaging/tasks" ? answer : { data: { candidates: [] } },
  );
  const client = { GET, POST: vi.fn() } as unknown as ApiClient;
  render(
    <ApiClientProvider client={client}>
      <MessageTaskButton channelId="c1" messageId="m1" meId="u1" />
      <MessageTaskButton channelId="c1" messageId="m2" meId="u1" />
    </ApiClientProvider>,
  );
  return GET;
}
const taskReads = (GET: ReturnType<typeof vi.fn>) =>
  GET.mock.calls.filter(([path]) => path === "/api/v1/messaging/tasks").length;

describe("MessageTaskButton", () => {
  it("renders nothing while the list route says tasks are off", async () => {
    const GET = mount({ data: { enabled: false, tasks: [] } });
    await waitFor(() => expect(taskReads(GET)).toBe(1));
    expect(screen.queryByRole("button", { name: /task/i })).toBeNull();
  });

  it("renders a trigger per row after one shared read when tasks are on", async () => {
    const GET = mount({ data: { enabled: true, tasks: [] } });
    expect(
      await screen.findAllByRole("button", { name: "Convert this message to a task" }),
    ).toHaveLength(2);
    expect(taskReads(GET)).toBe(1);
  });

  it("fails closed when the list cannot be read", async () => {
    const GET = mount({ data: undefined, error: {}, response: { status: 500 } });
    await waitFor(() => expect(taskReads(GET)).toBe(1));
    expect(screen.queryByRole("button", { name: /task/i })).toBeNull();
  });

  it("opens the dialog and returns focus to the trigger on Escape", async () => {
    mount({ data: { enabled: true, tasks: [] } });
    const [trigger] = await screen.findAllByRole("button", {
      name: "Convert this message to a task",
    });
    await userEvent.click(trigger as HTMLElement);
    expect(screen.getByRole("dialog", { name: "Convert to task" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
