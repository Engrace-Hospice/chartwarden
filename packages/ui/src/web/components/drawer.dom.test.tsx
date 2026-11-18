// @vitest-environment jsdom
// The kit Drawer: the redesign's right-hand form/detail drawer. It is a labelled complementary landmark that takes
// focus when it opens, closes from its Close button or Escape, and keeps a half-filled form on a stray Escape.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Drawer } from "./drawer";

afterEach(cleanup);

function renderDrawer(onClose = vi.fn()) {
  render(
    <Drawer
      title="Record compliance gate"
      subtitle="Background check · append-only"
      label="Record compliance gate"
      onClose={onClose}
      footer={<button type="button">Save gate</button>}
    >
      <label>
        Notes
        <input />
      </label>
    </Drawer>,
  );
  return onClose;
}

describe("Drawer", () => {
  it("is a named landmark with an h2 title and a subtitle", () => {
    renderDrawer();
    expect(screen.getByRole("complementary", { name: "Record compliance gate" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Record compliance gate" })).toBeTruthy();
    expect(screen.getByText("Background check · append-only")).toBeTruthy();
  });

  it("renders its body and footer", () => {
    renderDrawer();
    expect(screen.getByLabelText("Notes")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save gate" })).toBeTruthy();
  });

  it("takes focus when it opens", () => {
    renderDrawer();
    expect(document.activeElement).toBe(screen.getByRole("complementary"));
  });

  it("closes from the Close button", () => {
    const onClose = renderDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape while nothing has been typed", () => {
    const onClose = renderDrawer();
    fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps a half-filled form open on Escape", () => {
    const onClose = renderDrawer();
    fireEvent.input(screen.getByLabelText("Notes"), { target: { value: "partial" } });
    fireEvent.keyDown(screen.getByRole("complementary"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
