import type { SafeguardFocus } from "./review-exception-tasks";

const TASK_COLUMN_SELECTOR = ".wx-unified-task-column";
const BLOCK_SELECTOR = "[data-safeguard-block]";

/** The `data-safeguard-block` value of a safeguard block. */
export function safeguardBlockId(focus: SafeguardFocus): string {
  return focus.kind === "sud" ? "sud" : `identity-${focus.page}`;
}

/** Wide layouts scroll the task column itself; narrow ones let it grow and the page scroll instead. */
function scrollsItself(column: HTMLElement): boolean {
  return /^(auto|scroll)$/.test(getComputedStyle(column).overflowY);
}

/**
 * Brings a safeguard block to the top of whatever scrolls it (the task column, or the page when the
 * column does not scroll) and focuses it so keyboard and screen-reader users land on it too.
 * ponytail: runs once per request; an image that finishes loading above the block afterwards can
 * shift it (scroll anchoring covers Chromium/Firefox), re-reveal on load if Safari needs it.
 */
export function revealSafeguardBlock(block: HTMLElement): void {
  const column = block.closest<HTMLElement>(TASK_COLUMN_SELECTOR);
  if (column && scrollsItself(column))
    column.scrollTop += block.getBoundingClientRect().top - column.getBoundingClientRect().top;
  else block.scrollIntoView({ block: "start" });
  block.focus({ preventScroll: true });
}

/**
 * A button inside a safeguard block is about to unmount because its job is done ("Review source page"
 * once the page shows): park focus on the block so keyboard and screen-reader users are not dropped.
 */
export function focusEnclosingBlock(control: HTMLElement): void {
  control.closest<HTMLElement>(BLOCK_SELECTOR)?.focus({ preventScroll: true });
}
