// WP 2.2: the thread side panel. A flat right-hand pane beside the channel timeline (a slide-over on narrow screens,
// like the patient-context pane): the root message, its replies oldest first, and a composer whose sends carry
// `parentMessageId`. Permissions are the channel's; there is nothing thread-specific to grant or deny.
//
// Keyboard: focus lands on the panel when it opens; Escape closes it (and the caller returns focus to whatever opened
// it) except inside a composer that holds a draft, where a stray key must never lose the text; Tab is never trapped.
import { Button, EmptyState, Glyph, LoadingSpinner } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { AttachButton, AttachmentChips } from "./attachment-composer";
import { sendBlockedReason } from "./attachment-utils";
import { MessageRow } from "./message-row";
import { useAttachmentUploads } from "./use-attachment-upload";
import { sentMessageRow, useMessageSender } from "./use-message-sender";
import type { SentMessage } from "./use-message-sender";
import { type LiveHint, useThread } from "./use-thread";
import "./thread-panel.css";

export interface ThreadPanelProps {
  channelId: string;
  rootId: string;
  archived: boolean;
  meId: string;
  meDisplayName: string;
  liveHint: LiveHint | null;
  onClose: () => void;
  /** Scroll to (and focus) a message in the channel timeline, loading its page if needed. */
  onJumpToMessage: (messageId: string) => void;
  /** A reply was accepted: the channel timeline's reply count is now stale. */
  onReplySent: () => void;
}

function replyCountLabel(count: number): string {
  return count === 0 ? "No replies yet" : `${count} ${count === 1 ? "reply" : "replies"}`;
}

export function ThreadPanel({
  channelId,
  rootId,
  archived,
  meId,
  meDisplayName,
  liveHint,
  onClose,
  onJumpToMessage,
  onReplySent,
}: ThreadPanelProps): JSX.Element {
  const thread = useThread(channelId, rootId, liveHint);
  const uploads = useAttachmentUploads(channelId);
  const [draft, setDraft] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachButtonRef = useRef<HTMLButtonElement>(null);
  const composingRef = useRef(false);
  // Bumped on unmount and on a different thread, so a send that answers late is dropped (useMessageSender contract).
  const generationRef = useRef(0);
  const { addSent } = thread;

  // Opening, or moving to another thread, puts focus on the panel so a keyboard or screen-reader user lands in it.
  // The draft belongs to one thread: a different root starts empty.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rootId is the trigger, not a value read in the body
  useEffect(() => {
    generationRef.current += 1;
    setDraft("");
    panelRef.current?.focus();
    return () => {
      generationRef.current += 1;
    };
  }, [rootId]);

  const handleSent = (sent: SentMessage): void => {
    setDraft((current) => (current === sent.body ? "" : current));
    addSent(sentMessageRow(sent, channelId, meId, meDisplayName, rootId));
    onReplySent();
    textareaRef.current?.focus();
  };
  const { send, sending, sendError, clearSendError, resetSender } = useMessageSender({
    channelId,
    parentMessageId: rootId,
    archived,
    draft,
    draftReferences: [],
    uploads,
    generationRef,
    onSent: handleSent,
  });
  const { reset: resetUploads } = uploads;
  // biome-ignore lint/correctness/useExhaustiveDependencies: rootId is the trigger; the sender and uploads reset with it
  useEffect(() => {
    resetSender();
    resetUploads();
  }, [rootId, resetSender, resetUploads]);

  function handlePanelKey(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const inDraftingComposer = event.target === textareaRef.current && draft !== "";
    if (inDraftingComposer) return;
    event.preventDefault();
    onClose();
  }

  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // While an IME is composing, every key belongs to the IME.
    if (composingRef.current || event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  const sendHint = sendBlockedReason(uploads.chips);
  const { root, replies } = thread;
  const replyCount = root?.replyCount ?? replies.length;

  return (
    <aside
      ref={panelRef}
      className="wx-thread-panel"
      aria-label="Thread"
      tabIndex={-1}
      onKeyDown={handlePanelKey}
    >
      <header>
        <div className="wx-thread-panel-title">
          <strong>Thread</strong>
          <span>{thread.status === "ready" ? replyCountLabel(replyCount) : " "}</span>
        </div>
        {thread.status === "ready" ? (
          <button
            type="button"
            className="wx-thread-panel-show"
            onClick={() => onJumpToMessage(rootId)}
          >
            Show in conversation
          </button>
        ) : null}
        <button type="button" onClick={onClose} aria-label="Close thread">
          <Glyph name="close" size={17} />
        </button>
      </header>

      <div className="wx-thread-panel-body">
        {thread.status === "loading" ? (
          <output className="wx-message-state">
            <LoadingSpinner label="Loading thread" />
          </output>
        ) : thread.status === "unavailable" ? (
          <div className="wx-message-state" role="alert">
            <strong>Thread unavailable</strong>
            <span>This thread is unavailable or your access has changed.</span>
          </div>
        ) : thread.status === "failed" || !root ? (
          <div className="wx-message-state" role="alert">
            <strong>Thread could not be loaded</strong>
            <Button size="sm" tone="secondary" onClick={thread.reload}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            <MessageRow message={root} previous={undefined} meId={meId} anchorMessageId={null} />
            <div className="wx-thread-divider" aria-hidden={replies.length === 0}>
              <span>{replyCountLabel(replyCount)}</span>
            </div>
            {replies.length === 0 ? (
              <EmptyState
                title="No replies yet"
                description={
                  archived ? "This conversation is read only." : "Start the thread below."
                }
              />
            ) : (
              <ul className="wx-thread-replies" aria-label="Replies">
                {replies.map((reply, index) => (
                  <li key={reply.messageId}>
                    <MessageRow
                      message={reply}
                      previous={index === 0 ? root : replies[index - 1]}
                      meId={meId}
                      anchorMessageId={null}
                    />
                  </li>
                ))}
              </ul>
            )}
            {thread.hasMore ? (
              <button
                type="button"
                className="wx-load-older"
                onClick={thread.loadMore}
                disabled={thread.loadingMore}
              >
                {thread.loadingMore ? "Loading…" : "Load more replies"}
              </button>
            ) : null}
          </>
        )}
        {thread.refreshFailed && thread.status === "ready" ? (
          <output className="wx-thread-refresh-warning">
            Connection interrupted.{" "}
            <button type="button" onClick={thread.reload}>
              Retry now
            </button>
          </output>
        ) : null}
      </div>

      {archived ? (
        <output className="wx-messaging-archived">
          <Glyph name="lock" size={16} />
          This conversation is archived. Replies are read only.
        </output>
      ) : thread.status === "ready" ? (
        <form className="wx-message-composer" onSubmit={(event) => void send(event)}>
          <label htmlFor="messaging-thread-composer" className="sr-only">
            Reply in thread
          </label>
          <textarea
            ref={textareaRef}
            id="messaging-thread-composer"
            rows={1}
            placeholder="Reply…"
            value={draft}
            disabled={sending}
            onChange={(event) => {
              setDraft(event.target.value);
              if (sendError) clearSendError();
            }}
            onKeyDown={handleComposerKey}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
          />
          <AttachmentChips uploads={uploads} disabled={sending} attachButtonRef={attachButtonRef} />
          <AttachButton uploads={uploads} disabled={sending} buttonRef={attachButtonRef} />
          <Button
            type="submit"
            disabled={
              sending || (!draft.trim() && uploads.sendableIds.length === 0) || uploads.blocksSend
            }
            loading={sending}
            aria-label="Send reply"
          >
            <Glyph name="send" size={16} /> <span>Reply</span>
          </Button>
          {sendHint ? <div className="wx-send-hint">{sendHint}</div> : null}
          {sendError ? (
            <div role="alert" className="wx-composer-error">
              {sendError}{" "}
              <button type="submit" disabled={sending}>
                Retry
              </button>
            </div>
          ) : null}
        </form>
      ) : null}
    </aside>
  );
}
