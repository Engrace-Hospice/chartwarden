// @vitest-environment jsdom
// A record's form as the redesign's right-hand drawer: the kit Drawer with Cancel and the save action in its footer.
// Like the dialog it replaces, it cannot be dismissed (Cancel, the close button, Escape) while a write is in flight.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormDrawer } from "./form-drawer";

afterEach(cleanup);

function renderDrawer(busy: boolean, onClose = vi.fn()) {
  render(
    <FormDrawer
      title="New support group"
      busy={busy}
      onClose={onClose}
      save={<button type="button">Create draft group</button>}
    >
      <label>
        Name
        <input />
      </label>
    </FormDrawer>,
  );
  return onClose;
}

describe("FormDrawer", () => {
  it("is a landmark named for the form, with its fields, Cancel and the save action", () => {
    renderDrawer(false);
    expect(screen.getByRole("complementary", { name: "New support group" })).toBeTruthy();
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create draft group" })).toBeTruthy();
  });

  it("closes from Cancel and from the close button", () => {
    const onClose = renderDrawer(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("refuses to close while a save is in flight", () => {
    const onClose = renderDrawer(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
