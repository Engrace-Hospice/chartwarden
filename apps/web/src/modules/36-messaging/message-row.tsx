import type { JSX } from "react";
import { Link } from "react-router-dom";
import { MessageAttachments } from "./message-attachments";
import type { Message } from "./messaging-types";
import { absoluteTime, dayLabel, initialsOf } from "./messaging-utils";

function MessageText({ message }: { message: Message }): JSX.Element {
  // An attachment-only message has no text to show; the attachment list below is its content.
  if (!message.body && (message.attachments?.length ?? 0) > 0) return <></>;
  const references = [...(message.references ?? [])]
    .filter(
      (reference) =>
        reference.start >= 0 &&
        reference.end <= message.body.length &&
        reference.end > reference.start,
    )
    .sort((a, b) => a.start - b.start);
  if (references.length === 0) return <>{message.body || "Message deleted"}</>;
  const parts: JSX.Element[] = [];
  let cursor = 0;
  for (const reference of references) {
    if (reference.start < cursor) continue;
    if (reference.start > cursor)
      parts.push(<span key={`t-${cursor}`}>{message.body.slice(cursor, reference.start)}</span>);
    const text = message.body.slice(reference.start, reference.end);
    parts.push(
      reference.kind === "patient" && reference.navigable ? (
        <Link
          key={`r-${reference.start}`}
          className="wx-message-reference"
          to={`/patients/${reference.entityId}`}
        >
          {text}
        </Link>
      ) : (
        <span key={`r-${reference.start}`} className="wx-message-reference">
          {text}
        </span>
      ),
    );
    cursor = reference.end;
  }
  if (cursor < message.body.length)
    parts.push(<span key={`t-${cursor}`}>{message.body.slice(cursor)}</span>);
  return <>{parts}</>;
}

const GROUP_WINDOW_MS = 300_000;

interface MessageRowProps {
  message: Message;
  previous: Message | undefined;
  meId: string;
  anchorMessageId: string | null;
}

/** One timeline entry: optional day divider, then a system line or a message bubble. */
export function MessageRow({
  message,
  previous,
  meId,
  anchorMessageId,
}: MessageRowProps): JSX.Element {
  const showDay = !previous || dayLabel(previous.createdAt) !== dayLabel(message.createdAt);
  const mine = message.authorUserId === meId;
  const system = message.authorUserId === null || message.bodyKind === "system";
  const grouped =
    previous &&
    previous.authorUserId === message.authorUserId &&
    new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() <
      GROUP_WINDOW_MS &&
    !showDay;
  return (
    <div>
      {showDay ? (
        <div className="wx-message-day">
          <span>{dayLabel(message.createdAt)}</span>
        </div>
      ) : null}
      {system ? (
        <div className="wx-system-message">{message.body || "Message deleted"}</div>
      ) : (
        <article
          data-message-id={message.messageId}
          data-highlighted={message.messageId === anchorMessageId || undefined}
          className={`wx-message-row ${mine ? "is-mine" : ""} ${grouped ? "is-grouped" : ""}`}
        >
          {!mine && !grouped ? (
            <span className="wx-message-avatar" aria-hidden="true">
              {initialsOf(message.authorDisplayName || "Staff")}
            </span>
          ) : !mine ? (
            <span className="wx-message-avatar-spacer" />
          ) : null}
          <div className="wx-message-copy">
            {!mine && !grouped ? (
              <strong>{message.authorDisplayName || "Staff member"}</strong>
            ) : null}
            <div className="wx-message-bubble">
              <span>
                <MessageText message={message} />
              </span>
              <MessageAttachments attachments={message.attachments} />
              <time
                dateTime={message.createdAt}
                title={absoluteTime(message.createdAt)}
                aria-label={absoluteTime(message.createdAt)}
              >
                {new Intl.DateTimeFormat(undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                }).format(new Date(message.createdAt))}
              </time>
            </div>
          </div>
        </article>
      )}
    </div>
  );
}
