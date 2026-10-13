// Queued channel messages (use-outbox): shown after the last server message with a text "Not sent" label, Retry and
// Discard. Accessible names say only "message" (plus its position) - the body is PHI and stays out of aria labels.
import { useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { MessageText } from "./message-row";
import {
  type AnnouncementState,
  initialAnnouncement,
  nextAnnouncement,
} from "./pending-announcement";
import { sentMessageRow } from "./use-message-sender";
import type { OutboxItem } from "./use-outbox";
import "./pending-message.css";

interface PendingMessageRowProps {
  item: OutboxItem;
  /** 1-based place among the channel's waiting messages, and how many wait: "Retry sending message 2 of 3". */
  position: number;
  total: number;
  meId: string;
  meDisplayName: string;
  onRetry: (localId: string) => void;
  onDiscard: (localId: string) => void;
}

function PendingMessageRow({
  item,
  position,
  total,
  meId,
  meDisplayName,
  onRetry,
  onDiscard,
}: PendingMessageRowProps): JSX.Element {
  const message = sentMessageRow(item.sent, item.channelId, meId, meDisplayName);
  const sending = item.status === "sending";
  const suffix = total > 1 ? ` ${position} of ${total}` : "";
  const statusId = `pending-status-${item.localId}`;
  return (
    <article className="wx-message-row is-mine wx-pending-row" data-pending-message={item.localId}>
      <div className="wx-message-copy">
        <div className="wx-message-bubble">
          <span>
            <MessageText message={message} />
          </span>
        </div>
        <div className="wx-pending-meta">
          <span id={statusId} className="wx-pending-status">
            <strong className="wx-pending-label">{sending ? "Sending…" : "Not sent"}</strong>
            {item.error ? <span className="wx-pending-error"> {item.error}</span> : null}
          </span>
          {item.permanent ? null : (
            // aria-disabled, not disabled: a disabled button drops focus to <body> mid-send.
            <button
              type="button"
              className="wx-pending-action"
              aria-label={`Retry sending message${suffix}`}
              aria-describedby={statusId}
              aria-disabled={sending}
              onClick={() => {
                if (!sending) onRetry(item.localId);
              }}
            >
              Retry
            </button>
          )}
          <button
            type="button"
            className="wx-pending-action"
            aria-label={`Discard message${suffix}`}
            aria-describedby={statusId}
            onClick={() => onDiscard(item.localId)}
          >
            Discard
          </button>
        </div>
      </div>
    </article>
  );
}

interface PendingMessageListProps
  extends Omit<PendingMessageRowProps, "item" | "position" | "total"> {
  items: readonly OutboxItem[];
  channelId: string;
  /** How many of this channel's queued messages the server has confirmed so far (a delivery is announced). */
  delivered: number;
  /** Where focus goes when the last row leaves (the composer). */
  onFocusComposer: () => void;
}

/** The queued rows plus a live region that says, per event, what happened to the queue. */
export function PendingMessageList({
  items,
  channelId,
  delivered,
  onFocusComposer,
  ...rest
}: PendingMessageListProps): JSX.Element {
  // Adjusted during render (not in an effect) so the text lands in the already-mounted region in the same commit.
  const [announcement, setAnnouncement] = useState<AnnouncementState>(() =>
    initialAnnouncement(channelId, items, delivered),
  );
  const current =
    announcement.channelId === channelId
      ? nextAnnouncement(announcement, items, delivered)
      : initialAnnouncement(channelId, items, delivered);
  if (current !== announcement) setAnnouncement(current);

  const listRef = useRef<HTMLDivElement>(null);
  const focusedIdRef = useRef<string | null>(null);
  const previousIdsRef = useRef<readonly string[]>([]);
  // A row that leaves (discarded, or delivered) while focus is in it must not drop focus to <body>: go to the next
  // row's first action, else the previous one, else the composer.
  useLayoutEffect(() => {
    const ids = items.map((item) => item.localId);
    const gone = focusedIdRef.current;
    if (
      gone &&
      !ids.includes(gone) &&
      (!document.activeElement || document.activeElement === document.body)
    ) {
      const index = previousIdsRef.current.indexOf(gone);
      const target = ids[index] ?? ids[index - 1];
      const action = target
        ? listRef.current?.querySelector<HTMLElement>(
            `[data-pending-message="${CSS.escape(target)}"] .wx-pending-action`,
          )
        : null;
      focusedIdRef.current = null;
      if (action) action.focus();
      else onFocusComposer();
    }
    previousIdsRef.current = ids;
  }, [items, onFocusComposer]);

  return (
    <>
      <output className="wx-sr-only" aria-live="polite">
        {current.text}
      </output>
      <div
        ref={listRef}
        onFocus={(event) => {
          focusedIdRef.current =
            event.target.closest<HTMLElement>("[data-pending-message]")?.dataset.pendingMessage ??
            null;
        }}
        onBlur={(event) => {
          // Focus left for something else, or for nothing (a click on empty space): the claim ends. A row that is
          // removed while focused fires no blur, so its claim survives; a blurred element still in the DOM was left.
          const target = event.target;
          queueMicrotask(() => {
            if (target.isConnected) focusedIdRef.current = null;
          });
        }}
      >
        {items.map((item, index) => (
          <PendingMessageRow
            key={item.localId}
            item={item}
            position={index + 1}
            total={items.length}
            {...rest}
          />
        ))}
      </div>
    </>
  );
}
