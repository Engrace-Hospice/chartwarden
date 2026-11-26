// The offset logic that keeps a selected safeguard block and its evidence page on screen together.
import { afterEach, describe, expect, it, vi } from "vitest";
import { centerInStage, focusBlockOf, revealSafeguardBlock } from "./review-safeguard-focus";

const COLUMN_TOP = 100;
const STAGE_HEIGHT = 300;
const BLOCK_TOP = 1700;
const BLOCK_HEIGHT = 200;
const VIEWPORT_HEIGHT = 800;

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    height,
    x: 0,
    y: top,
  } as DOMRect;
}

function place(element: HTMLElement, top: number, height: number): void {
  Object.defineProperty(element, "getBoundingClientRect", { value: () => rect(top, height) });
  element.scrollIntoView = vi.fn();
}

interface Layout {
  column: HTMLElement;
  stage: HTMLElement;
  block: HTMLElement;
}

function build(options: { scrollsItself: boolean; blockTop?: number }): Layout {
  const column = document.createElement("section");
  column.className = "wx-unified-task-column";
  column.style.overflowY = options.scrollsItself ? "auto" : "visible";
  const stage = document.createElement("div");
  const block = document.createElement("fieldset");
  block.tabIndex = -1;
  column.append(stage, block);
  document.body.append(column);
  place(column, COLUMN_TOP, 0);
  place(stage, COLUMN_TOP, STAGE_HEIGHT);
  place(block, options.blockTop ?? BLOCK_TOP, BLOCK_HEIGHT);
  return { column, stage, block };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("revealing a safeguard block", () => {
  it("puts the block right below the sticky evidence stage in a column that scrolls itself", () => {
    const { column, stage, block } = build({ scrollsItself: true });
    column.scrollTop = 50;

    revealSafeguardBlock(block, stage);

    expect(column.scrollTop).toBe(50 + BLOCK_TOP - COLUMN_TOP - STAGE_HEIGHT);
    expect(block.scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(block);
  });

  it("aligns to the column top when there is no evidence stage", () => {
    const { column, block } = build({ scrollsItself: true });

    revealSafeguardBlock(block, null);

    expect(column.scrollTop).toBe(BLOCK_TOP - COLUMN_TOP);
  });

  it("scrolls the stage into view when the page scrolls and stage and block fit one viewport", () => {
    vi.stubGlobal("innerHeight", VIEWPORT_HEIGHT);
    const { stage, block } = build({ scrollsItself: false, blockTop: 500 });

    revealSafeguardBlock(block, stage);

    expect(stage.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(block.scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(block);
  });

  it("scrolls the block into view when the page scrolls and stage plus block exceed a viewport", () => {
    vi.stubGlobal("innerHeight", VIEWPORT_HEIGHT);
    const { stage, block } = build({ scrollsItself: false });

    revealSafeguardBlock(block, stage);

    expect(block.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(stage.scrollIntoView).not.toHaveBeenCalled();
  });

  it("measures the viewport by the page scroller when the layout has one", () => {
    vi.stubGlobal("innerHeight", 10);
    const main = document.createElement("main");
    main.className = "wx-main";
    Object.defineProperty(main, "clientHeight", { value: VIEWPORT_HEIGHT });
    document.body.append(main);
    const { column, stage, block } = build({ scrollsItself: false, blockTop: 500 });
    main.append(column);

    revealSafeguardBlock(block, stage);

    expect(stage.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });
});

describe("focusing the block that owns a control", () => {
  it("moves focus to the enclosing safeguard block without scrolling", () => {
    const block = document.createElement("fieldset");
    block.dataset.safeguardBlock = "sud";
    block.tabIndex = -1;
    const button = document.createElement("button");
    block.append(button);
    document.body.append(block);
    const focus = vi.spyOn(block, "focus");

    focusBlockOf(button);

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(block);
  });
});

describe("centring a highlight in the evidence stage", () => {
  it("scrolls the stage so the highlight sits in its middle", () => {
    const stage = document.createElement("div");
    const mark = document.createElement("span");
    stage.append(mark);
    document.body.append(stage);
    place(stage, 0, 300);
    place(mark, 900, 20);
    stage.scrollTop = 40;

    centerInStage(stage, mark);

    expect(stage.scrollTop).toBe(40 + 900 - (300 - 20) / 2);
  });
});
