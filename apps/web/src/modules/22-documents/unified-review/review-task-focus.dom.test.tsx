import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusTaskColumn, focusTrigger, restoreFocusAfterClose } from "./review-task-focus";

function mountColumn(inner: string): { column: HTMLElement; outside: HTMLButtonElement } {
  document.body.innerHTML = `<button type="button" id="outside">Outside</button><div class="wx-main"><div class="wx-unified-task-column" tabindex="-1">${inner}</div></div>`;
  const column = document.querySelector<HTMLElement>(".wx-unified-task-column");
  const outside = document.querySelector<HTMLButtonElement>("#outside");
  if (!column || !outside) throw new Error("Expected the synthetic task column");
  return { column, outside };
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});
afterEach(() => {
  document.body.innerHTML = "";
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.restoreAllMocks();
});

describe("focusing the task just opened", () => {
  it("focuses the task heading and scrolls the column back to its top", () => {
    const { column } = mountColumn('<h2 data-task-heading tabindex="-1">Mobile phone</h2>');
    column.scrollTop = 180;

    focusTaskColumn(column);

    expect(document.activeElement).toBe(column.querySelector("h2"));
    expect(column.scrollTop).toBe(0);
  });

  it("falls back to the column when the task has no heading", () => {
    const { column } = mountColumn("<p>No heading</p>");

    focusTaskColumn(column);

    expect(document.activeElement).toBe(column);
  });

  it("leaves focus alone when a control inside the task already holds it", () => {
    const { column } = mountColumn(
      '<h2 data-task-heading tabindex="-1">Task</h2><div tabindex="-1" id="block">Block</div>',
    );
    const block = column.querySelector<HTMLElement>("#block");
    block?.focus();
    column.scrollTop = 120;

    focusTaskColumn(column);

    expect(document.activeElement).toBe(block);
    expect(column.scrollTop).toBe(120);
  });

  it("brings the column into view when it starts outside the scrolling region", () => {
    const { column } = mountColumn("<p>Task</p>");
    const scrollport = document.querySelector<HTMLElement>(".wx-main");
    vi.spyOn(column, "getBoundingClientRect").mockReturnValue({ top: 900 } as DOMRect);
    vi.spyOn(scrollport as HTMLElement, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 600,
    } as DOMRect);

    focusTaskColumn(column);

    expect(column.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });
});

describe("returning focus when a task closes", () => {
  it("names the control that held focus, never the body or a control inside the column", () => {
    const { column, outside } = mountColumn('<button type="button" id="inside">Inside</button>');
    expect(focusTrigger(column)).toBeNull();

    outside.focus();
    expect(focusTrigger(column)).toBe(outside);

    column.querySelector<HTMLElement>("#inside")?.focus();
    expect(focusTrigger(column)).toBeNull();
  });

  it("goes back to the opener while it is on the page, else to the column", () => {
    const { column, outside } = mountColumn("<p>Task</p>");

    restoreFocusAfterClose(outside, column);
    expect(document.activeElement).toBe(outside);

    outside.remove();
    restoreFocusAfterClose(outside, column);
    expect(document.activeElement).toBe(column);

    restoreFocusAfterClose(null, null);
    expect(document.activeElement).toBe(column);
  });
});
