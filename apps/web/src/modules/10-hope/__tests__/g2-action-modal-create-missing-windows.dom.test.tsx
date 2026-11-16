// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HopeActionModal } from "../hope-action-modal";

// Group g2: the regenerate dialog says what the server does. POST /hope/admin/regenerate-schedules only CREATES the windows an
// admission is entitled to and does not have; a window that already exists (open, completed or skipped) is left exactly as it is,
// so a window computed from a wrong date is NOT moved. The dialog must not promise a recompute from corrected dates.

afterEach(cleanup);

const ADMISSION = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

function renderRegenerate() {
  const post = vi.fn(async () => ({
    data: { admissionId: ADMISSION, scheduleCount: 3 },
    error: undefined,
    response: new Response(null, { status: 200 }),
  }));
  const onDone = vi.fn();
  render(
    <ApiClientProvider client={{ GET: vi.fn(), POST: post } as unknown as ApiClient}>
      <HopeActionModal
        open
        action="regenerate"
        targetId={ADMISSION}
        onClose={vi.fn()}
        onDone={onDone}
      />
    </ApiClientProvider>,
  );
  return { post, onDone };
}

describe("the regenerate-schedules dialog", () => {
  it("is titled and worded as creating the missing windows", () => {
    renderRegenerate();

    const dialog = screen.getByRole("dialog", { name: "Create missing timepoint windows" });

    expect(within(dialog).getByRole("button", { name: "Create missing windows" })).toBeTruthy();
    expect(dialog.textContent).toContain("does not have yet");
    expect(dialog.textContent).toContain("left exactly as they are");
    expect(dialog.textContent).toContain("is not moved");
  });

  it("never says it recomputes or reopens anything", () => {
    renderRegenerate();

    const dialog = screen.getByRole("dialog", { name: "Create missing timepoint windows" });

    expect(dialog.textContent?.toLowerCase()).not.toContain("recompute");
    expect(dialog.textContent?.toLowerCase()).not.toContain("current dates");
  });

  it("still sends the admission to the route-20 write and reports done", async () => {
    const { post, onDone } = renderRegenerate();

    fireEvent.click(screen.getByRole("button", { name: "Create missing windows" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledTimes(1);
    const [path, init] = post.mock.calls[0] as unknown as [string, { body: unknown }];
    expect(path).toBe("/api/v1/hope/admin/regenerate-schedules");
    expect(init.body).toEqual({ admissionId: ADMISSION });
  });
});
