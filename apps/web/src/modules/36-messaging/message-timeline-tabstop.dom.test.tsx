/**
 * The message history scrolls, so axe's `scrollable-region-focusable` needs it to be a keyboard tab stop
 * unless it already holds a focusable control — otherwise a keyboard user cannot reach or scroll it. Message
 * rows are not tab stops and their action buttons depend on permissions (a read-only thread has none), so
 * only the error state's Retry button lets it stay a script-only focus target (`tabIndex -1`).
 * jsdom has no layout, so this pins the attribute; the live check is e2e/specs/messaging-responsive.spec.ts.
 */
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { MessageTimeline, type MessageTimelineProps } from "./message-timeline";
import type { Message } from "./messaging-types";

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
  // MessageRow reads the API client; a stub is enough since nothing here fetches.
  render(
    <ApiClientProvider client={{} as unknown as ApiClient}>
      <MessageTimeline {...props} />
    </ApiClientProvider>,
  );
  return screen.getByLabelText("Message history");
}

describe("MessageTimeline keyboard access", () => {
  it("is a tab stop while loading, with only a skeleton inside", () => {
    expect(historyRegion({ messages: null }).getAttribute("tabindex")).toBe("0");
  });

  it("is a tab stop when the thread is empty", () => {
    expect(historyRegion({ messages: [] }).getAttribute("tabindex")).toBe("0");
  });

  it("is a tab stop for a read-only thread with messages (no action buttons to tab to)", () => {
    const message: Message = {
      messageId: "m1",
      channelId: "c1",
      authorUserId: "someone",
      authorDisplayName: "Someone",
      body: "Hello",
      bodyKind: "plain",
      createdAt: "2026-10-27T10:00:00.000Z",
      parentMessageId: null,
      references: [],
    };
    const region = historyRegion({ messages: [message], canReply: false, canAnnotate: false });
    expect(region.getAttribute("tabindex")).toBe("0");
  });

  it("stays script-focus-only when it holds a Retry button", () => {
    const region = historyRegion({ messages: null, loadError: "The thread could not load." });
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(region.getAttribute("tabindex")).toBe("-1");
  });
});
