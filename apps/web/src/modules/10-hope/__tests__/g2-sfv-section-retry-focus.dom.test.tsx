// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { SfvLookup } from "../hope-sfv-lookup";
import { SfvWorkflowSection } from "../hope-sfv-section";

// Group g2: Retry on the follow-up card removes its own button while the lookup runs again. The keyboard must keep its place:
// the card takes focus when the failed lookup stops being failed, and does not take it from a control that already has it.

const ITEMS = [{ itemCode: "J2052A", value: null, applicability: "applicable" }] as const;
const FAILED: SfvLookup = { state: "failed" };
const LOADING: SfvLookup = { state: "loading" };
const card = () => document.getElementById("hope-item-J2052A") as HTMLElement;

function renderCard(lookup: SfvLookup, onRetryLookup: () => void = () => undefined) {
  const element = (next: SfvLookup) => (
    <MemoryRouter>
      <SfvWorkflowSection
        items={ITEMS}
        signed
        lookup={next}
        onRetryLookup={onRetryLookup}
        focusKey={0}
        returnFocusKey={0}
        onComplete={() => undefined}
        onReview={() => undefined}
      />
    </MemoryRouter>
  );
  const view = render(element(lookup));
  return { ...view, setLookup: (next: SfvLookup) => view.rerender(element(next)) };
}

describe("the follow-up card's Retry", () => {
  it("hands focus to the card when the lookup it retried is running, so the keyboard keeps its place", () => {
    const { setLookup } = renderCard(FAILED, () => setLookup(LOADING));
    const retry = screen.getByRole("button", { name: "Retry" });
    retry.focus();
    expect(document.activeElement).toBe(retry);

    fireEvent.click(retry);

    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(document.activeElement).toBe(card());
  });

  it("keeps the card as the place to Tab on from when the lookup fails again", () => {
    const { setLookup } = renderCard(FAILED, () => setLookup(LOADING));
    screen.getByRole("button", { name: "Retry" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    setLookup(FAILED);

    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(document.activeElement).toBe(card());
  });

  it("does not take focus from a control that has it, nor when the card merely mounts", () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      const { setLookup, unmount } = renderCard(FAILED);
      outside.focus();
      setLookup(LOADING);
      expect(document.activeElement).toBe(outside);
      unmount();

      renderCard(LOADING);
      expect(document.activeElement).not.toBe(card());
    } finally {
      outside.remove();
    }
  });
});
