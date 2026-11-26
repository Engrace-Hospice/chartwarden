import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock, MockInstance } from "vitest";
import {
  focusEnclosingBlock,
  revealSafeguardBlock,
  safeguardBlockId,
} from "./review-safeguard-focus";

const COLUMN_TOP = 100;
const BLOCK_TOP = 300;

function rect(top: number): DOMRect {
  return {
    top,
    left: 0,
    right: 0,
    bottom: top,
    width: 0,
    height: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

interface Layout {
  column: HTMLElement;
  block: HTMLElement;
  scrollIntoView: Mock;
  focus: MockInstance<HTMLElement["focus"]>;
}

/** A task column holding one safeguard block, with the boxes a browser would give them. */
function layout(overflowY: string, scrollTop = 0): Layout {
  const column = document.createElement("div");
  column.className = "wx-unified-task-column";
  column.style.overflowY = overflowY;
  column.scrollTop = scrollTop;
  column.getBoundingClientRect = () => rect(COLUMN_TOP);
  const block = document.createElement("fieldset");
  block.tabIndex = -1;
  block.setAttribute("data-safeguard-block", "sud");
  block.getBoundingClientRect = () => rect(BLOCK_TOP);
  const scrollIntoView = vi.fn();
  block.scrollIntoView = scrollIntoView;
  column.append(block);
  document.body.append(column);
  return { column, block, scrollIntoView, focus: vi.spyOn(block, "focus") };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("safeguardBlockId", () => {
  it("names the Part 2 block and an identity block by its page", () => {
    expect(safeguardBlockId({ kind: "sud" })).toBe("sud");
    expect(safeguardBlockId({ kind: "identity", page: 4 })).toBe("identity-4");
  });
});

describe("revealSafeguardBlock", () => {
  it.each(["auto", "scroll"])(
    "scrolls a column that scrolls itself (overflow-y: %s) and focuses without scrolling",
    (overflowY) => {
      const { column, block, scrollIntoView, focus } = layout(overflowY);

      revealSafeguardBlock(block);

      expect(column.scrollTop).toBe(BLOCK_TOP - COLUMN_TOP);
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    },
  );

  it("adds to the position the column is already scrolled to", () => {
    const { column, block } = layout("scroll", 40);

    revealSafeguardBlock(block);

    expect(column.scrollTop).toBe(40 + BLOCK_TOP - COLUMN_TOP);
  });

  it("lets the page scroll when the column does not (the narrow layout)", () => {
    const { column, block, scrollIntoView, focus } = layout("visible", 25);

    revealSafeguardBlock(block);

    expect(column.scrollTop).toBe(25);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("lets the page scroll for a block that is outside any task column", () => {
    const block = document.createElement("fieldset");
    block.tabIndex = -1;
    const scrollIntoView = vi.fn();
    block.scrollIntoView = scrollIntoView;
    document.body.append(block);

    revealSafeguardBlock(block);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement).toBe(block);
  });
});

describe("focusEnclosingBlock", () => {
  it("focuses the block a control is in, without scrolling", () => {
    const { block, focus } = layout("scroll");
    const control = document.createElement("button");
    block.append(control);

    focusEnclosingBlock(control);

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("does nothing for a control that is not in a block", () => {
    const control = document.createElement("button");
    document.body.append(control);
    control.focus();

    focusEnclosingBlock(control);

    expect(document.activeElement).toBe(control);
  });
});
