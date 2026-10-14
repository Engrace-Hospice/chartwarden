import { Glyph } from "@wardenx/ui";
import { memo } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { MessageAnnotations } from "./message-annotations";
import { MessageAttachments } from "./message-attachments";
import type { Message } from "./messaging-types";
import { absoluteTime, dayLabel, initialsOf } from "./messaging-utils";
import { PollCard } from "./poll-card";
import { RichBodyView } from "./rich-body-view";
import "./announcements.css";

export function MessageText({ message }: { message: Message }): JSX.Element {
  // An attachment-only message has no text to show; the attachment list below is its content.
  if (
    !message.body &&
    (message.attachments?.length ?? 0) + (message.hiddenAttachmentCount ?? 0) > 0
  )
    return <></>;
  // WP 2.1: a structured body renders from its document; everything else renders exactly as it always has.
  if (message.bodyKind === "rich" && message.bodyUnreadable) {
    return <span className="wx-rich-fallback">Message could not be displayed</span>;
  }
  if (message.bodyKind === "rich") {
    return (
      <RichBodyView
        bodyDoc={message.bodyDoc}
        references={message.references ?? []}
        clinicalLinks={message.clinicalLinks}
        fallbackText={message.body || "Message deleted"}
      />
    );
  }
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

const clockTime = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));

/** RFC 3339 date-time prefix: `new Date("10")` parses in V8, so a bare Date check would accept it. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;

/**
 * WP 1.3: plain-text "Edited <time>" marker (the words carry the meaning, not colour). Not a button: opening a
 * revision list is Phase 5 (docs/messaging-hub/06-ux-design.md), tied to messaging.history.read.
 * The visible text is also the accessible text; the full date is real screen-reader text (a `title` is mouse-only).
 * A non-ISO or unparseable editedAt renders nothing rather than "Invalid Date".
 */
function EditedIndicator({
  editedAt,
}: { editedAt: string | null | undefined }): JSX.Element | null {
  const absolute = editedAt && ISO_INSTANT.test(editedAt) ? absoluteTime(editedAt) : "";
  if (!editedAt || !absolute) return null;
  return (
    <>
      <span aria-hidden="true">·</span>
      <span className="wx-message-edited">
        Edited{" "}
        <time dateTime={editedAt} title={absolute}>
          {clockTime(editedAt)}
        </time>
        <span className="wx-sr-only"> on {absolute}</span>
      </span>
    </>
  );
}

interface MessageRowProps {
  message: Message;
  previous: Message | undefined;
  meId: string;
  anchorMessageId: string | null;
  /** WP 2.2: open the thread of `rootId`; `opener` is the control to give focus back to when it closes. */
  onOpenThread?: (rootId: string, opener: HTMLElement) => void;
  /** WP 2.2: scroll to (loading its page if needed) and focus the message this one replies to. */
  onJumpToParent?: (parentMessageId: string) => void;
  /** Who the parent's author is, when the parent is on screen; otherwise the link says "an earlier message". */
  parentAuthor?: string | null;
  /** False in an archived channel: replies are read-only there, but an existing thread can still be opened. */
  canReply?: boolean;
  /** Reactions and pins are allowed wherever the channel is writable, even when sending is not (announcements need messaging.announce to send/reply, not to react). Defaults to canReply. */
  canAnnotate?: boolean;
  /** WP 2.4: offer Pin/Unpin (the conversation timeline only; the thread panel does not). */
  canPin?: boolean;
  /** WP 2.9: open who has read this announcement (only passed for a sender of announcements). */
  onShowReceipts?: (messageId: string) => void;
}

function pluralReplies(count: number): string {
  return `${count} ${count === 1 ? "reply" : "replies"}`;
}

/** One timeline entry: optional day divider, then a system line or a message bubble. */
function MessageRowImpl({
  message,
  previous,
  meId,
  anchorMessageId,
  onOpenThread,
  onJumpToParent,
  parentAuthor,
  canReply = true,
  canAnnotate = canReply,
  canPin = false,
  onShowReceipts,
}: MessageRowProps): JSX.Element {
  const showDay = !previous || dayLabel(previous.createdAt) !== dayLabel(message.createdAt);
  const mine = message.authorUserId === meId;
  const replyCount = message.replyCount ?? 0;
  // A tombstone has no body and no files (live attachment-only messages keep a count): nothing to reply to.
  const deleted =
    !message.body &&
    (message.attachments?.length ?? 0) + (message.hiddenAttachmentCount ?? 0) === 0;
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
          tabIndex={-1}
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
            {message.parentMessageId && onJumpToParent ? (
              <button
                type="button"
                className="wx-reply-context"
                aria-label={
                  parentAuthor
                    ? `Jump to message from ${parentAuthor}`
                    : "Jump to the message this replies to"
                }
                onClick={() => onJumpToParent(message.parentMessageId!)}
              >
                <Glyph name="arrow-up" size={12} />
                {parentAuthor ? `Replying to ${parentAuthor}` : "Replying to an earlier message"}
              </button>
            ) : null}
            <div className="wx-message-bubble">
              {message.bodyKind === "rich" ? (
                <MessageText message={message} />
              ) : (
                <span>
                  <MessageText message={message} />
                </span>
              )}
              {message.poll && !deleted ? (
                <PollCard
                  channelId={message.channelId}
                  messageId={message.messageId}
                  poll={message.poll}
                  canVote={canAnnotate}
                />
              ) : null}
              <MessageAttachments attachments={message.attachments} />
              {message.hiddenAttachmentCount ? (
                <small className="wx-message-attachment-hidden">
                  {message.hiddenAttachmentCount === 1
                    ? "Attachment not available yet"
                    : `${message.hiddenAttachmentCount} attachments not available yet`}
                </small>
              ) : null}
              <div className="wx-message-meta">
                <time
                  dateTime={message.createdAt}
                  title={absoluteTime(message.createdAt)}
                  aria-label={absoluteTime(message.createdAt)}
                >
                  {clockTime(message.createdAt)}
                </time>
                {deleted ? null : <EditedIndicator editedAt={message.editedAt} />}
              </div>
            </div>
            {!deleted ? (
              <MessageAnnotations message={message} canAnnotate={canAnnotate} canPin={canPin} />
            ) : null}
            {onShowReceipts && !deleted ? (
              <button
                type="button"
                className="wx-message-receipts-button"
                aria-label={`Read receipts for the announcement from ${message.authorDisplayName || "staff member"}`}
                onClick={() => onShowReceipts(message.messageId)}
              >
                Read receipts
              </button>
            ) : null}
            {onOpenThread && (replyCount > 0 || (canReply && !deleted)) ? (
              <div className="wx-message-thread-actions">
                {replyCount > 0 ? (
                  <button
                    type="button"
                    className="wx-thread-count"
                    data-thread-opener={message.messageId}
                    aria-label={`Open thread, ${pluralReplies(replyCount)}`}
                    onClick={(event) => onOpenThread(message.messageId, event.currentTarget)}
                  >
                    <Glyph name="message-square" size={13} /> {pluralReplies(replyCount)}
                  </button>
                ) : null}
                {canReply && !deleted ? (
                  <button
                    type="button"
                    className="wx-thread-reply"
                    data-thread-opener={message.parentMessageId ?? message.messageId}
                    aria-label={`Reply in thread to ${message.authorDisplayName || "staff member"}`}
                    onClick={(event) =>
                      onOpenThread(
                        message.parentMessageId ?? message.messageId,
                        event.currentTarget,
                      )
                    }
                  >
                    Reply
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </article>
      )}
    </div>
  );
}

/** Memoised: typing in the composer re-renders the thread, but a row only re-renders when its own message changes. */
export const MessageRow = memo(MessageRowImpl);
