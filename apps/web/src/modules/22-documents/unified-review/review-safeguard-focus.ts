import type { SafeguardFocus } from "./review-exception-tasks";

const TASK_COLUMN_SELECTOR = ".wx-unified-task-column";
const PAGE_SCROLLER_SELECTOR = ".wx-main";
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
 * The page scrolls: show the evidence stage with the block when both fit one viewport, otherwise the
 * block (it is what was chosen; the stage is one scroll up).
 */
function revealInPage(block: HTMLElement, stage: HTMLElement | null): void {
  const viewport =
    block.closest<HTMLElement>(PAGE_SCROLLER_SELECTOR)?.clientHeight || window.innerHeight;
  const together =
    stage !== null &&
    block.getBoundingClientRect().bottom - stage.getBoundingClientRect().top <= viewport;
  (together ? stage : block).scrollIntoView({ block: "start" });
}

/**
 * Brings a safeguard block on screen together with its evidence page, then focuses it so keyboard and
 * screen-reader users land on it too. In a column that scrolls itself the evidence stage sticks to the
 * column's top, so the block is aligned just below it; otherwise the page scrolls (see `revealInPage`).
 * ponytail: runs once per request; an image that finishes loading above the block afterwards can
 * shift it (scroll anchoring covers Chromium/Firefox), re-reveal on load if Safari needs it.
 */
export function revealSafeguardBlock(block: HTMLElement, stage: HTMLElement | null): void {
  const column = block.closest<HTMLElement>(TASK_COLUMN_SELECTOR);
  if (column && scrollsItself(column)) {
    const stageHeight = stage?.getBoundingClientRect().height ?? 0;
    column.scrollTop +=
      block.getBoundingClientRect().top - column.getBoundingClientRect().top - stageHeight;
  } else revealInPage(block, stage);
  block.focus({ preventScroll: true });
}

/**
 * A control that unmounts when used (a "Review source page N" button) hands focus to its own block,
 * so keyboard focus does not drop to the page.
 */
export function focusBlockOf(control: HTMLElement): void {
  control.closest<HTMLElement>(BLOCK_SELECTOR)?.focus({ preventScroll: true });
}

/** Scrolls the evidence stage (not the page) so a highlight sits in its middle. */
export function centerInStage(stage: HTMLElement, mark: HTMLElement): void {
  const view = stage.getBoundingClientRect();
  const box = mark.getBoundingClientRect();
  stage.scrollTop += box.top - view.top - (view.height - box.height) / 2;
}
