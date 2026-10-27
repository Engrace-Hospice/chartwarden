/**
 * The message history scrolls, so axe's `scrollable-region-focusable` needs it to be a keyboard tab stop
 * whenever it holds nothing focusable (a loading skeleton, an empty thread) — otherwise a keyboard user
 * cannot reach or scroll it. With message rows or a Retry button it already contains focusable content,
 * so it stays a script-only focus target (`tabIndex -1`) and does not add a redundant tab stop.
 * jsdom has no layout, so this pins the attribute; the live check is e2e/specs/messaging-responsive.spec.ts.
 */
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { MessageTimeline, type MessageTimelineProps } from "./message-timeline";

function historyRegion(overrides: Partial<MessageTimelineProps>): HTMLElement {
  const props: MessageTimelineProps = {
    timelineRef: createRef<HTMLDivElement>(),
    messages: [],
    loadError: null,
    loadCorrelationId: null,
    olderCursor: null,
    loadingOlder: false,
    meId: "me",
    highlightedMessageId: null,
    authorById: new Map(),
    canReply: false,
    canAnnotate: false,
    onShowReceipts: vi.fn() as MessageTimelineProps["onShowReceipts"],
    onScroll: vi.fn(),
    onRetry: vi.fn(),
    onLoadOlder: vi.fn(),
    onOpenThread: vi.fn(),
    onJumpToMessage: vi.fn(),
    ...overrides,
  };
  render(<MessageTimeline {...props} />);
  return screen.getByLabelText("Message history");
}

describe("MessageTimeline keyboard access", () => {
  it("is a tab stop while loading, with only a skeleton inside", () => {
    expect(historyRegion({ messages: null }).getAttribute("tabindex")).toBe("0");
  });

  it("is a tab stop when the thread is empty", () => {
    expect(historyRegion({ messages: [] }).getAttribute("tabindex")).toBe("0");
  });

  it("stays script-focus-only when it holds a Retry button", () => {
    const region = historyRegion({ messages: null, loadError: "The thread could not load." });
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(region.getAttribute("tabindex")).toBe("-1");
  });
});
