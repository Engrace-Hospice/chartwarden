// @vitest-environment jsdom
// A ceremony as a modal: the kit Modal with Cancel and the save action. It blocks the page, cannot be dismissed while a
// write is in flight, never closes from a click on the scrim, and announces a failed write inside itself.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormModal } from "./form-modal";

afterEach(cleanup);

function renderModal(busy: boolean, onClose = vi.fn(), error?: string) {
  render(
    <FormModal
      title="Attest delivery"
      busy={busy}
      onClose={onClose}
      error={error}
      save={<button type="button">Attest</button>}
    >
      <label>
        Delivered at
        <input />
      </label>
    </FormModal>,
  );
  return onClose;
}

describe("FormModal", () => {
  it("is a dialog named for the act, with its fields, Cancel and the save action", () => {
    renderModal(false);
    const dialog = screen.getByRole("dialog", { name: "Attest delivery" });
    expect(dialog.querySelector("h2")?.textContent).toBe("Attest delivery");
    expect(screen.getByLabelText("Delivered at")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attest" })).toBeTruthy();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("closes from Cancel and from Escape while idle", () => {
    const onClose = renderModal(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("does not close from a click on the scrim, so typed text is not lost", () => {
    const onClose = renderModal(false);
    const scrim = document.querySelector(".wx-modal-scrim");
    expect(scrim).toBeTruthy();
    fireEvent.click(scrim as Element);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("refuses to close while a write is in flight", () => {
    const onClose = renderModal(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("announces a failed write inside the dialog", () => {
    renderModal(false, vi.fn(), "The delivery was not recorded.");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("The delivery was not recorded.");
    expect(screen.getByRole("dialog").contains(alert)).toBe(true);
  });
});
