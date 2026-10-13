// Modal Tab trap: focus must wrap inside the card even from an element that is focusable by script only
// (tabindex="-1" headings, the card itself), which is not in the Tab-order list the trap compares against.
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
        <button type="button">Last</button>
      </Modal>
    </>,
  );
  return onClose;
}

describe("Modal Tab trap", () => {
  it("wraps Shift+Tab from a tabindex=-1 element to the last control", async () => {
    renderModal();
    screen.getByRole("heading", { name: "Heading" }).focus();
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
  });

  it("wraps Tab from a tabindex=-1 element to the first control", async () => {
    renderModal();
    screen.getByRole("heading", { name: "Heading" }).focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
  });

  it("still wraps at the ends and keeps Escape working afterwards", async () => {
    const onClose = renderModal();
    screen.getByRole("button", { name: "Last" }).focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
