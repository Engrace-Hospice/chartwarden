// @vitest-environment jsdom
// A record's form as the redesign's right-hand drawer: the kit Drawer with Cancel and the save action in its footer.
// Like the dialog it replaces, it cannot be dismissed (Cancel, the close button, Escape) while a write is in flight, and
// the page beside it goes inert for that time so nothing can swap or unmount the form before its outcome lands.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormDrawer } from "./form-drawer";

afterEach(cleanup);

function renderDrawer(busy: boolean, onClose = vi.fn(), error?: string) {
  render(
    <div data-testid="frame">
      <main data-testid="page">
        <button type="button">Edit row</button>
      </main>
      <FormDrawer
        title="New support group"
        busy={busy}
        onClose={onClose}
        error={error}
        save={<button type="button">Create draft group</button>}
      >
        <label>
          Name
          <input />
        </label>
      </FormDrawer>
    </div>,
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

  it("closes on Escape while idle", () => {
    const onClose = renderDrawer(false);
    fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables the close button while a save is in flight, so it does not look live", () => {
    renderDrawer(true);
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("leaves the page live while the form is idle", () => {
    renderDrawer(false);
    expect(screen.getByTestId("page").hasAttribute("inert")).toBe(false);
  });

  it("makes the page inert while a save is in flight and live again once it ends", () => {
    renderDrawer(true);
    expect(screen.getByTestId("page").hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("complementary").closest("[inert]")).toBeNull();
    cleanup();
    renderDrawer(false);
    expect(screen.getByTestId("page").hasAttribute("inert")).toBe(false);
  });

  it("lifts the inert page when the drawer unmounts mid-write", () => {
    const { unmount } = render(
      <div>
        <main data-testid="page" />
        <FormDrawer title="t" busy onClose={vi.fn()} save={<button type="button">Save</button>}>
          <p>body</p>
        </FormDrawer>
      </div>,
    );
    expect(screen.getByTestId("page").hasAttribute("inert")).toBe(true);
    const page = screen.getByTestId("page");
    unmount();
    expect(page.hasAttribute("inert")).toBe(false);
  });

  it("announces a failed write in the drawer beside Save", () => {
    renderDrawer(false, vi.fn(), "The group was not saved.");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("The group was not saved.");
    expect(screen.getByRole("complementary").contains(alert)).toBe(true);
  });
});
