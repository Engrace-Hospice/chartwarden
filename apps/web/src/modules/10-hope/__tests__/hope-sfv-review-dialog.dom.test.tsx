// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { formatDate } from "../hope-format";
import { ReviewSfvDialog } from "../hope-sfv-review-dialog";

// The read-only look at a completed Symptom Follow-Up Visit: the date it was completed and what was answered.

const SEVERITY = [
  { valueCode: "0", label: "None" },
  { valueCode: "1", label: "Mild" },
];
const ITEMS = [
  { itemCode: "J2052B", label: "SFV completion date", value: "2026-09-01", options: [] },
  { itemCode: "J2053A", label: "Impact of pain", value: "1", options: SEVERITY },
  { itemCode: "J2053B", label: "Impact of shortness of breath", value: "0", options: SEVERITY },
];

function renderReview() {
  const onClose = vi.fn();
  render(<ReviewSfvDialog items={ITEMS} onClose={onClose} />);
  return { onClose, dialog: screen.getByRole("dialog", { name: "SFV details" }) };
}

describe("ReviewSfvDialog", () => {
  it("shows when the visit was completed and what was answered, in the answer's own words", () => {
    const { dialog } = renderReview();
    expect(within(dialog).getByText(formatDate("2026-09-01"))).toBeTruthy();
    expect(within(dialog).getByText("Impact of pain")).toBeTruthy();
    expect(within(dialog).getByText("Mild")).toBeTruthy();
    expect(within(dialog).getByText("None")).toBeTruthy();
  });

  it("moves focus into the dialog when it opens", () => {
    const { dialog } = renderReview();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes from its Close buttons, from Escape, and from a click on the backdrop (it holds nothing to lose)", () => {
    const { dialog, onClose } = renderReview();
    for (const close of within(dialog).getAllByRole("button", { name: "Close" }))
      fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
    for (const scrim of screen.getAllByRole("button", { name: "Close" })) {
      if (!dialog.contains(scrim)) fireEvent.click(scrim);
    }
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it("has one scrolling region, like the completion dialog: the body, with nothing on the card to scroll beside it", () => {
    const { dialog } = renderReview();
    const scrolling = [...dialog.querySelectorAll<HTMLElement>("*")].filter((el) =>
      ["auto", "scroll"].includes(getComputedStyle(el).overflowY),
    );
    expect(scrolling).toHaveLength(1);
    expect(dialog.style.borderTop).toBe("");
    expect(dialog.style.padding).toBe("");
  });
});
