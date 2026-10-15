// The scrolling message history of ConversationThread: load state, the load-older control and the message rows (moved
// out of it unchanged in WP 2.11 to keep that file under the line ceiling). Scroll bookkeeping and loading stay in the
// thread; this only renders what it is given.
import type { JSX, ReactNode, RefObject, UIEvent } from "react";
import { MessageRow } from "./message-row";
import type { Message } from "./messaging-types";
import { TimelineState } from "./timeline-state";
import type { useAnnouncementTools } from "./use-announcement-tools";

export interface MessageTimelineProps {
  timelineRef: RefObject<HTMLDivElement>;
  messages: Message[] | null;
  loadError: string | null;
  loadCorrelationId: string | null;
  olderCursor: string | null;
  loadingOlder: boolean;
  meId: string;
  highlightedMessageId: string | null;
  authorById: ReadonlyMap<string, string | null>;
  canReply: boolean;
  canAnnotate: boolean;
  /** WP 3.7: a patient's care-team conversation (messages can be proposed for the chart). */
  patientLinked?: boolean;
  onShowReceipts: ReturnType<typeof useAnnouncementTools>["onShowReceipts"];
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
  onRetry: () => void;
  onLoadOlder: () => void;
  onOpenThread: (id: string, opener: HTMLElement) => void;
  onJumpToMessage: (messageId: string) => void;
  /** The offline outbox's "Not sent" rows, shown after the last server message. */
  pending?: ReactNode;
}

export function MessageTimeline({
  timelineRef,
  messages,
  loadError,
  loadCorrelationId,
  olderCursor,
  loadingOlder,
  meId,
  highlightedMessageId,
  authorById,
  canReply,
  canAnnotate,
  patientLinked = false,
  onShowReceipts,
  onScroll,
  onRetry,
  onLoadOlder,
  onOpenThread,
  onJumpToMessage,
  pending,
}: MessageTimelineProps): JSX.Element {
  return (
    <div
      ref={timelineRef}
      className="wx-message-timeline"
      aria-label="Message history"
      tabIndex={-1}
      onScroll={onScroll}
    >
      <TimelineState
        loadError={loadError}
        correlationId={loadCorrelationId}
        loading={messages === null}
        empty={messages?.length === 0}
        onRetry={onRetry}
      />
      {!loadError && messages && messages.length > 0 ? (
        <>
          {olderCursor ? (
            <button
              type="button"
              className="wx-load-older"
              onClick={onLoadOlder}
              disabled={loadingOlder}
            >
              {loadingOlder ? "Loading…" : "Load older messages"}
            </button>
          ) : (
            <span className="wx-history-start">Beginning of conversation</span>
          )}
          {messages.map((message, index) => (
            <MessageRow
              key={message.messageId}
              message={message}
              previous={messages[index - 1]}
              meId={meId}
              anchorMessageId={highlightedMessageId}
              onOpenThread={onOpenThread}
              onJumpToParent={onJumpToMessage}
              parentAuthor={
                message.parentMessageId
                  ? (authorById.get(message.parentMessageId) ?? null)
                  : undefined
              }
              canReply={canReply}
              canAnnotate={canAnnotate}
              canPin
              patientLinked={patientLinked}
              onShowReceipts={onShowReceipts}
            />
          ))}
        </>
      ) : null}
      {pending}
    </div>
  );
}
