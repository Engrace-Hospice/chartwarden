// M36 WP 3.4: the message-row trigger. Hidden while the tenant flag is off, opens the dialog, and gives focus back.
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider, FeatureFlagProvider } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { MessageTaskButton } from "./message-task-button";
import { TASKS_FLAG_KEY } from "./use-tasks-enabled";

function mount(enabled: boolean) {
  const GET = vi.fn().mockResolvedValue({ data: { candidates: [] } });
  const client = { GET, POST: vi.fn() } as unknown as ApiClient;
  render(
    <ApiClientProvider client={client}>
      <FeatureFlagProvider flags={{ [TASKS_FLAG_KEY]: enabled }}>
        <MessageTaskButton channelId="c1" messageId="m1" meId="u1" />
        <MessageTaskButton channelId="c1" messageId="m2" meId="u1" />
      </FeatureFlagProvider>
    </ApiClientProvider>,
  );
  return GET;
}

describe("MessageTaskButton", () => {
  it("renders nothing, and makes no request, while tasks are off", () => {
    const GET = mount(false);
    expect(screen.queryByRole("button", { name: /task/i })).toBeNull();
    expect(GET).not.toHaveBeenCalled();
  });

  it("renders nothing without a flag provider mounted", () => {
    render(
      <ApiClientProvider client={{ GET: vi.fn() } as unknown as ApiClient}>
        <MessageTaskButton channelId="c1" messageId="m1" meId="u1" />
      </ApiClientProvider>,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("opens the dialog and returns focus to the trigger on Escape", async () => {
    mount(true);
    const [trigger] = screen.getAllByRole("button", {
      name: "Convert this message to a task",
    });
    await userEvent.click(trigger as HTMLElement);
    expect(screen.getByRole("dialog", { name: "Convert to task" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
