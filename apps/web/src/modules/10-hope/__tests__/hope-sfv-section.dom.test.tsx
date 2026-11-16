// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SfvWorkflowSection } from "../hope-sfv-section";

// The follow-up card: it takes focus when a completion changes what it shows (never just because it mounted), says the
// result once through its live region and then lets it go, and gets focus back when its dialog closes with no trigger.

const RECORDED_ITEMS = [{ itemCode: "J2052A", value: "1", applicability: "applicable" }] as const;
const REQUIRED_ITEMS = [{ itemCode: "J2052A", value: null, applicability: "applicable" }] as const;

interface CardProps {
  focusKey?: number;
  returnFocusKey?: number;
  items?: readonly { itemCode: string; value: unknown; applicability: string }[];
}

const card = () => document.getElementById("hope-item-J2052A") as HTMLElement;

function renderCard(props: CardProps = {}) {
  const element = (next: CardProps) => (
    <MemoryRouter>
      <SfvWorkflowSection
        items={next.items ?? RECORDED_ITEMS}
        signed={false}
        lookup={{ state: "idle" }}
        onRetryLookup={() => undefined}
        focusKey={next.focusKey ?? 0}
        returnFocusKey={next.returnFocusKey ?? 0}
        onComplete={() => undefined}
        onReview={() => undefined}
      />
    </MemoryRouter>
  );
  const view = render(element(props));
  return { ...view, update: (next: CardProps) => view.rerender(element(next)) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SfvWorkflowSection focus and announcement", () => {
  it("takes focus when its key changes, every time, and not when it merely mounts with a key already above zero", () => {
    const { update, unmount } = renderCard({ focusKey: 3 });
    expect(document.activeElement).not.toBe(card());
    update({ focusKey: 4 });
    expect(document.activeElement).toBe(card());
    (document.activeElement as HTMLElement).blur();
    update({ focusKey: 5 });
    expect(document.activeElement).toBe(card());
    unmount();

    renderCard({ focusKey: 5 });
    expect(document.activeElement).not.toBe(card());
  });

  it("says the visit was recorded when the key changes, then lets the line go so it is not a standing duplicate", () => {
    vi.useFakeTimers();
    const { update } = renderCard({ focusKey: 0 });
    expect(screen.getByRole("status").textContent).toBe("");
    update({ focusKey: 1 });
    expect(screen.getByRole("status").textContent).toBe("The follow-up visit was recorded.");

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByRole("status").textContent).toBe("");
    // The card's own description still says it, once.
    expect(
      screen.getByText("The follow-up visit has been recorded by the SFV workflow."),
    ).toBeTruthy();
  });

  it("restarts the announcement when a second completion changes the key again, and drops its timer with the card", () => {
    vi.useFakeTimers();
    const { update, unmount } = renderCard({ focusKey: 0 });
    update({ focusKey: 1 });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    update({ focusKey: 2 });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByRole("status").textContent).toBe("The follow-up visit was recorded.");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("when its dialog closes without a trigger", () => {
    it("takes focus back if nothing has it", () => {
      const { update } = renderCard({ items: REQUIRED_ITEMS });
      (document.activeElement as HTMLElement | null)?.blur();
      expect(document.activeElement).toBe(document.body);
      update({ items: REQUIRED_ITEMS, returnFocusKey: 1 });
      expect(document.activeElement).toBe(card());
    });

    it("leaves focus where it is if something else has it (the dialog's own trigger already got it back)", () => {
      const other = document.createElement("button");
      document.body.appendChild(other);
      const { update } = renderCard({ items: REQUIRED_ITEMS });
      other.focus();
      update({ items: REQUIRED_ITEMS, returnFocusKey: 1 });
      expect(document.activeElement).toBe(other);
      other.remove();
    });

    it("does not announce anything: nothing was recorded", () => {
      const { update } = renderCard({ items: REQUIRED_ITEMS });
      update({ items: REQUIRED_ITEMS, returnFocusKey: 1 });
      expect(screen.getByRole("status").textContent).toBe("");
    });
  });
});
