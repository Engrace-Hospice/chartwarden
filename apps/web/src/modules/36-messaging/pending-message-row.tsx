// A queued channel message (use-outbox): shown after the last server message with a text "Not sent" label, Retry and
// Discard. Accessible names say only "message" - the body is PHI and stays out of aria labels.
import { useState } from "react";
import type { JSX } from "react";
import { MessageText } from "./message-row";
import { sentMessageRow } from "./use-message-sender";
import type { OutboxItem } from "./use-outbox";
import "./pending-message.css";

interface PendingMessageRowProps {
  item: OutboxItem;
  meId: string;
  meDisplayName: string;
  onRetry: (localId: string) => void;
  onDiscard: (localId: string) => void;
}

function PendingMessageRow({
  item,
  meId,
  meDisplayName,
  onRetry,
  onDiscard,
}: PendingMessageRowProps): JSX.Element {
  const message = sentMessageRow(item.sent, item.channelId, meId, meDisplayName);
  const sending = item.status === "sending";
  return (
    <article className="wx-message-row is-mine wx-pending-row" data-pending-message={item.localId}>
      <div className="wx-message-copy">
        <div className="wx-message-bubble">
          <span>
            <MessageText message={message} />
          </span>
        </div>
        <div className="wx-pending-meta">
          <strong className="wx-pending-label">{sending ? "Sending…" : "Not sent"}</strong>
          {item.error ? <span className="wx-pending-error">{item.error}</span> : null}
          {item.permanent ? null : (
            <button
              type="button"
              className="wx-pending-action"
              aria-label="Retry sending message"
              disabled={sending}
              onClick={() => onRetry(item.localId)}
            >
              Retry
            </button>
          )}
          <button
            type="button"
            className="wx-pending-action"
            aria-label="Discard message"
            disabled={sending}
            onClick={() => onDiscard(item.localId)}
          >
            Discard
          </button>
        </div>
      </div>
    </article>
  );
}

/** The queued rows plus a live region that says once, when one is queued, that a message was not sent. */
export function PendingMessageList({
  items,
  ...rest
}: { items: readonly OutboxItem[] } & Omit<PendingMessageRowProps, "item">): JSX.Element {
  // Adjusted during render (not in an effect) so the text lands in the already-mounted region in the same commit.
  const [announcement, setAnnouncement] = useState("");
  const [seenCount, setSeenCount] = useState(0);
  if (items.length !== seenCount) {
    setSeenCount(items.length);
    setAnnouncement(items.length > seenCount ? "Message not sent" : "");
  }
  return (
    <>
      <output className="wx-sr-only" aria-live="polite">
        {announcement}
      </output>
      {items.map((item) => (
        <PendingMessageRow key={item.localId} item={item} {...rest} />
      ))}
    </>
  );
}
