// Modal Tab trap: focus must stay inside the card, including from elements that are focusable by script only
// (tabindex="-1" headings, the card itself), which are not in the Tab-order list the trap compares against.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./modal";

function renderModal(onClose = vi.fn()) {
  render(
    <>
      <button type="button">Behind</button>
      <Modal open onClose={onClose} ariaLabel="Test dialog">
        <h2 tabIndex={-1}>Heading</h2>
        <button type="button">First</button>
        <p tabIndex={-1}>Middle</p>
        <button type="button">Second</button>
        <button type="button">Last</button>
        <p tabIndex={-1}>Footer note</p>
      </Modal>
    </>,
  );
  return onClose;
}
const button = (name: string) => screen.getByRole("button", { name });
const focusText = (text: string) => screen.getByText(text).focus();

describe("Modal Tab trap", () => {
  it("wraps Shift+Tab from a tabindex=-1 heading above the first control to the last control", async () => {
    renderModal();
    focusText("Heading");
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(button("Last"));
  });

  it("wraps Tab from a tabindex=-1 element below the last control to the first control", async () => {
    renderModal();
    focusText("Footer note");
    await userEvent.tab();
    expect(document.activeElement).toBe(button("First"));
  });

  it("goes to the next control after a mid-card tabindex=-1 element, and to the previous on Shift+Tab", async () => {
    renderModal();
    focusText("Middle");
    await userEvent.tab();
    expect(document.activeElement).toBe(button("Second"));
    focusText("Middle");
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(button("First"));
  });

  it("still wraps at the ends and keeps Escape working afterwards", async () => {
    const onClose = renderModal();
    button("Last").focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(button("First"));
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(button("Last"));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps Tab inside a card with no focusable controls", async () => {
    render(
      <>
        <button type="button">Behind</button>
        <Modal open ariaLabel="Empty dialog">
          <p tabIndex={-1}>Only text</p>
        </Modal>
      </>,
    );
    screen.getByText("Only text").focus();
    await userEvent.tab();
    expect(document.activeElement).not.toBe(button("Behind"));
    await userEvent.tab({ shift: true });
    expect(document.activeElement).not.toBe(button("Behind"));
  });

  it("lets an inner modal handle its own Tab without the outer modal stealing focus", async () => {
    render(
      <Modal open ariaLabel="Outer">
        <button type="button">Outer one</button>
        {/* Last in the outer card: the inner card's last control is also the outer card's last control. */}
        <Modal open ariaLabel="Inner">
          <button type="button">Inner one</button>
          <p tabIndex={-1}>Inner note</p>
          <button type="button">Inner two</button>
        </Modal>
      </Modal>,
    );
    focusText("Inner note");
    await userEvent.tab();
    expect(document.activeElement).toBe(button("Inner two"));
    await userEvent.tab();
    expect(document.activeElement).toBe(button("Inner one"));
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(button("Inner two"));
  });
});
