// TableScroll: an overflowing table frame with nothing focusable in it is a named, focusable region (so the keyboard can scroll it);
// a frame that does not overflow, or that already holds a tab stop, is left alone.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TableScroll } from "./table-scroll";

const FRAME_WIDTH = 400;
const TABLE_WIDTH = 800;
const originals = {
  scrollWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth"),
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
};

/** jsdom does no layout: report the frame as `scrollWidth` wide content inside a `FRAME_WIDTH` box. */
function overflowBy(scrollWidth: number): void {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get: () => scrollWidth,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => FRAME_WIDTH,
  });
}

beforeEach(() => overflowBy(TABLE_WIDTH));
afterEach(() => {
  cleanup();
  for (const key of ["scrollWidth", "clientWidth"] as const) {
    const original = originals[key];
    if (original) Object.defineProperty(HTMLElement.prototype, key, original);
    else Reflect.deleteProperty(HTMLElement.prototype, key);
  }
});

const table = (cell: JSX.Element | string = "cell"): JSX.Element => (
  <table>
    <caption>Add-ons</caption>
    <tbody>
      <tr>
        <td>{cell}</td>
      </tr>
    </tbody>
  </table>
);

describe("TableScroll", () => {
  it("makes an overflowing frame with nothing focusable a focusable region named by the caption", () => {
    render(<TableScroll>{table()}</TableScroll>);
    const region = screen.getByRole("region", { name: "Add-ons" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.classList.contains("wx-list-table-wrap")).toBe(true);
  });

  it("adds no tab stop when the frame does not overflow", () => {
    overflowBy(FRAME_WIDTH);
    const { container } = render(<TableScroll>{table()}</TableScroll>);
    const frame = container.querySelector(".wx-list-table-wrap");
    expect(frame?.getAttribute("tabindex")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("adds no tab stop when the table already has a focusable control", () => {
    const { container } = render(
      <TableScroll>{table(<button type="button">Cancel</button>)}</TableScroll>,
    );
    expect(container.querySelector(".wx-list-table-wrap")?.getAttribute("tabindex")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("adds no tab stop when a row is itself focusable (an interactive row)", () => {
    const { container } = render(
      <TableScroll>
        <table>
          <caption>Refunds</caption>
          <tbody>
            {/* biome-ignore lint/a11y/useSemanticElements: an interactive row is a <tr role=button tabindex=0> in the kit */}
            <tr role="button" tabIndex={0}>
              <td>row</td>
            </tr>
          </tbody>
        </table>
      </TableScroll>,
    );
    expect(container.querySelector(".wx-list-table-wrap")?.getAttribute("tabindex")).toBeNull();
  });

  it("still takes a tab stop when its only controls are disabled", () => {
    render(
      <TableScroll>
        {table(
          <button type="button" disabled>
            Cancel
          </button>,
        )}
      </TableScroll>,
    );
    expect(screen.getByRole("region", { name: "Add-ons" }).getAttribute("tabindex")).toBe("0");
  });
});
