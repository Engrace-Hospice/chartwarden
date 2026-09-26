// packages/ui/src/web/system — the activatable-row helper (#32) in isolation.
//
// The screen-level suites in apps/web prove the drawers actually open. These pin the primitive
// itself, because every future activatable row inherits whatever it does.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { interactiveRowProps } from "./interactive-row";

function Row({
  onActivate,
  selected = false,
  containsControls = false,
  withLink = false,
}: {
  onActivate: () => void;
  selected?: boolean;
  containsControls?: boolean;
  withLink?: boolean;
}) {
  return (
    <table>
      <tbody>
        <tr data-testid="row" {...interactiveRowProps(onActivate, selected, containsControls)}>
          <td>{withLink ? <a href="/elsewhere">open</a> : "cell"}</td>
        </tr>
      </tbody>
    </table>
  );
}

const row = () => screen.getByTestId("row");

describe("interactiveRowProps", () => {
  it("puts the row in the tab order", () => {
    render(<Row onActivate={() => {}} />);
    row().focus();
    expect(document.activeElement).toBe(row());
  });

  it("activates on Enter and on Space", () => {
    const onActivate = vi.fn();
    render(<Row onActivate={onActivate} />);
    fireEvent.keyDown(row(), { key: "Enter" });
    fireEvent.keyDown(row(), { key: " " });
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it("consumes the keystroke so Space does not also scroll the page", () => {
    render(<Row onActivate={() => {}} />);
    const ev = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    row().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("ignores every other key", () => {
    const onActivate = vi.fn();
    render(<Row onActivate={onActivate} />);
    for (const key of ["a", "Tab", "ArrowDown", "Escape"]) fireEvent.keyDown(row(), { key });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("announces itself as a button and reports which row is open", () => {
    const { rerender } = render(<Row onActivate={() => {}} />);
    expect(row().getAttribute("role")).toBe("button");
    expect(row().getAttribute("aria-pressed")).toBe("false");
    rerender(<Row onActivate={() => {}} selected />);
    expect(row().getAttribute("aria-pressed")).toBe("true");
  });

  it("drops the button role for a row that holds its own controls", () => {
    // A `button` may not contain focusable content — the nested control may not be exposed, and the
    // button's accessible name is computed from the entire row's text.
    render(<Row onActivate={() => {}} containsControls withLink />);
    expect(row().getAttribute("role")).toBeNull();
    expect(row().getAttribute("aria-pressed")).toBeNull();
    expect(row().getAttribute("tabindex")).toBe("0");
  });

  it("leaves a keystroke aimed at a nested control to that control", () => {
    // Otherwise Enter on the link both follows it and opens the row's drawer.
    const onActivate = vi.fn();
    render(<Row onActivate={onActivate} containsControls withLink />);
    fireEvent.keyDown(screen.getByRole("link"), { key: "Enter" });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("still activates from the pointer", () => {
    const onActivate = vi.fn();
    render(<Row onActivate={onActivate} />);
    fireEvent.click(row());
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
