// Where keyboard and screen-reader focus goes when a review task opens or closes. Every task panel puts
// `data-task-heading` and `tabIndex={-1}` on its main heading; the task column itself is the fallback.
const TASK_HEADING_SELECTOR = "[data-task-heading]";
const SCROLLPORT_SELECTOR = ".wx-main";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** The control the reviewer was on when they chose a task, so closing the task can return there. */
export function focusTrigger(column: HTMLElement | null): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  // A control inside the column belongs to the task that is about to be replaced.
  return column?.contains(active) ? null : active;
}

function columnIsOutside(column: HTMLElement, scrollport: HTMLElement): boolean {
  const columnTop = column.getBoundingClientRect().top;
  const scrollportBounds = scrollport.getBoundingClientRect();
  return columnTop < scrollportBounds.top || columnTop >= scrollportBounds.bottom;
}

/**
 * Moves focus to the heading of the task just opened (the column when it has none) and brings the
 * column into view. A control inside the column that already holds focus, such as a safeguard block
 * the panel revealed itself, is left alone.
 */
export function focusTaskColumn(column: HTMLElement): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== column && column.contains(active)) return;
  column.scrollTop = 0;
  const target = column.querySelector<HTMLElement>(TASK_HEADING_SELECTOR) ?? column;
  target.focus({ preventScroll: true });
  const scrollport = column.closest<HTMLElement>(SCROLLPORT_SELECTOR);
  if (!scrollport || !columnIsOutside(column, scrollport)) return;
  const reduceMotion =
    typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
  column.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}

/** Back to the control that opened the task while it is still on the page, else to the task column. */
export function restoreFocusAfterClose(
  trigger: HTMLElement | null,
  column: HTMLElement | null,
): void {
  if (trigger?.isConnected) trigger.focus();
  else column?.focus({ preventScroll: true });
}
