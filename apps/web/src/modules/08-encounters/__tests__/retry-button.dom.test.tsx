// @vitest-environment jsdom
// The retry beside a failed read keeps keyboard focus while the read is out, and says so in a status region that was already on the page
// (S1 React review): a button that turns `disabled` on press drops focus to the page, and a region mounted with its text is not announced.
// Synthetic data only.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AmendmentReview } from "../amendment-review";
import { DraftUnavailable } from "../draft-summary";
import type { NoteDraft } from "../use-note-draft";

afterEach(cleanup);

describe("the retry of the composer's draft strip", () => {
  it("stays focusable, says it is working, and sends nothing more while the read is out", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const { rerender } = render(<DraftUnavailable retrying={false} onRetry={onRetry} />);
    const status = document.querySelector("output.wx-row-sub") as HTMLOutputElement;
    expect(status.textContent).toBe("");
    const retry = screen.getByRole("button", { name: "Try again" });
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<DraftUnavailable retrying onRetry={onRetry} />);
    expect(retry).not.toBeDisabled();
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).toHaveFocus();
    expect(status.textContent).toMatch(/reading/i);
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<DraftUnavailable retrying={false} onRetry={onRetry} />);
    expect(retry).not.toHaveAttribute("aria-disabled");
    expect(status.textContent).toBe("");
  });
});

describe("the retry of an amendment's review", () => {
  const unavailable = (refreshing: boolean, reload: () => Promise<void>): NoteDraft => ({
    load: { status: "unavailable" },
    busySectionId: null,
    notes: {},
    refreshing,
    reload,
    resolve: vi.fn(async () => false),
  });

  it("stays focusable and sends nothing more while the draft is read again", async () => {
    const user = userEvent.setup();
    const reload = vi.fn(async () => undefined);
    const view = (refreshing: boolean) => (
      <AmendmentReview
        addendumId="add-1"
        opened="2026-10-01 10:00"
        sectionIds={["pain"]}
        draft={unavailable(refreshing, reload)}
      />
    );
    const { rerender } = render(view(false));
    const retry = screen.getByRole("button", { name: "Try again" });
    await user.click(retry);
    expect(reload).toHaveBeenCalledTimes(1);
    rerender(view(true));
    expect(retry).not.toBeDisabled();
    expect(retry).toHaveAttribute("aria-disabled", "true");
    expect(retry).toHaveFocus();
    await user.click(retry);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
