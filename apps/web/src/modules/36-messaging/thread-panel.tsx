// WP 2.2: the thread side panel. A flat right-hand pane beside the channel timeline (a slide-over on narrow screens,
// like the patient-context pane): the root message, its replies oldest first, and a composer whose sends carry
// `parentMessageId`. Permissions are the channel's; there is nothing thread-specific to grant or deny.
//
// The panel is keyed by the root id by its caller, so it holds no state across threads; drafts live in the caller
// (`drafts`) and survive a switch. Keyboard: focus lands on the panel when it opens; Escape or Close returns focus to
// whatever opened it, except that Escape does nothing while a draft or an attachment is held (a stray key never loses
// the text); Tab is never trapped.
import { Button, EmptyState, Glyph, LoadingSpinner } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent, MutableRefObject } from "react";
import { AttachButton, AttachmentChips } from "./attachment-composer";
import { sendBlockedReason } from "./attachment-utils";
import { DraftSyncNotice, escapeKeepsMine } from "./draft-conflict-prompt";
import { LegalHoldChip } from "./legal-hold-chip";
import { MessageRow } from "./message-row";
import { useAttachmentUploads } from "./use-attachment-upload";
import { sentMessageRow, useMessageSender } from "./use-message-sender";
import type { SentMessage } from "./use-message-sender";
import { useServerDraft } from "./use-server-draft";
import { type LiveHint, useThread } from "./use-thread";
import "./thread-panel.css";

/** A stable empty list: the reply composer has no mention chips, and a fresh `[]` each render would re-run the autosave effect. */
const NO_REFERENCES: readonly never[] = [];

export interface ThreadPanelProps {
  channelId: string;
  rootId: string;
  archived: boolean;
  meId: string;
  meDisplayName: string;
  liveHint: LiveHint | null;
  realtimeConnected: boolean;
  /** A reply for THIS root is being sent (possibly by an earlier instance of this panel): hold Send. */
  sendInFlight: boolean;
  onSendStart: (rootId: string) => void;
  onSendEnd: (rootId: string) => void;
  /** Unsent reply TEXT per root id (a chosen file is not part of a draft); owned by the caller so it survives a switch.
   *  Unsent reply text per root id, owned by the caller so a draft survives switching threads. */
  drafts: MutableRefObject<Map<string, string>>;
  onClose: () => void;
  /** Scroll to (and focus) a message in the channel timeline, loading its page if needed. */
  onJumpToMessage: (messageId: string) => void;
  /** A reply was accepted: the root's reply count in the channel timeline is now stale. */
  onReplySent: (rootId: string, createdAt: string) => void;
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
  realtimeConnected,
  sendInFlight,
  onSendStart,
  onSendEnd,
  drafts,
  onClose,
  onJumpToMessage,
  onReplySent,
}: ThreadPanelProps): JSX.Element {
  const thread = useThread(channelId, rootId, liveHint, realtimeConnected);
  const uploads = useAttachmentUploads(channelId);
  const [draft, setDraft] = useState(() => drafts.current.get(rootId) ?? "");
  const [announcement, setAnnouncement] = useState({ text: "", n: 0 });
  const announce = (text: string): void => setAnnouncement((a) => ({ text, n: a.n + 1 }));
  const panelRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachButtonRef = useRef<HTMLButtonElement>(null);
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  const composingRef = useRef(false);
  // Never bumped: a reply that is accepted AFTER the panel closed must still be recorded (draft cleared, count
  // patched), so the sender must not drop its answer. The panel is keyed per thread, so nothing can cross threads.
  const generationRef = useRef(0);
  const { addSent, status, replies, loadingMore } = thread;

  // Opening puts focus on the panel so a keyboard or screen-reader user lands in it.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const changeDraft = (next: string): void => {
    setDraft(next);
    if (next) drafts.current.set(rootId, next);
    else drafts.current.delete(rootId);
  };

  const handleSent = (sent: SentMessage): void => {
    setDraft((current) => (current === sent.body ? "" : current));
    // Only the text that was sent: a newer draft typed after a reopen is not ours to erase.
    if (drafts.current.get(rootId) === sent.body) drafts.current.delete(rootId);
    const inserted = addSent(sentMessageRow(sent, channelId, meId, meDisplayName, rootId));
    if (!inserted) announce("Reply sent. Load more replies to see it.");
    onReplySent(rootId, sent.createdAt);
  };
  const { send, sending, sendError, clearSendError } = useMessageSender({
    channelId,
    parentMessageId: rootId,
    archived,
    draft,
    draftReferences: [],
    uploads,
    generationRef,
    onSent: handleSent,
    // The text moves into the in-flight record when the request is issued (so a reopened panel starts empty), and
    // comes back if the request fails and nothing newer has been typed since.
    onIssued: () => {
      drafts.current.delete(rootId);
      onSendStart(rootId);
    },
    onSettled: (ok, submitted) => {
      if (!ok && !drafts.current.has(rootId)) drafts.current.set(rootId, submitted);
      onSendEnd(rootId);
    },
  });
  const held = sending || sendInFlight;
  // WP 2.5: this root's reply draft follows the user across reloads and devices (text only; no mention chips here).
  const serverDraft = useServerDraft({
    channelId,
    parentMessageId: rootId,
    text: draft,
    references: NO_REFERENCES,
    // A reply being sent owns its text: closing the panel mid-send must not save it back as a draft.
    suspended: held,
    hydrate: (text) => changeDraft(text),
  });

  // Announce replies from other people that arrive after the thread was first shown (a polite live region).
  const seenRef = useRef<Set<string> | null>(null);
  const loadMoreFromRef = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: announce only sets state
  useEffect(() => {
    if (status !== "ready") return;
    if (seenRef.current === null) {
      seenRef.current = new Set(replies.map((r) => r.messageId));
      return;
    }
    const seen = seenRef.current;
    if (loadMoreFromRef.current !== null) {
      // Replies the user asked for with Load more are not news.
      for (const r of replies) seen.add(r.messageId);
      return;
    }
    const fresh = replies.filter((r) => !seen.has(r.messageId));
    for (const r of fresh) seen.add(r.messageId);
    const fromOthers = fresh.filter((r) => r.authorUserId !== meId).length;
    if (fromOthers > 0) {
      announce(`${fromOthers} new ${fromOthers === 1 ? "reply" : "replies"}`);
    }
  }, [replies, status, meId]);

  // Focus must not fall to the page when the control that had it unmounts: after Load more it goes to the first
  // reply that arrived (or back to the button if nothing did); after a successful Retry it goes to the panel.
  const wasLoadingMore = useRef(false);
  useEffect(() => {
    if (loadingMore) {
      wasLoadingMore.current = true;
      return;
    }
    if (!wasLoadingMore.current) return;
    wasLoadingMore.current = false;
    const from = loadMoreFromRef.current;
    loadMoreFromRef.current = null;
    const first = from !== null ? replies[from] : undefined;
    const target = first
      ? panelRef.current?.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(first.messageId)}"]`,
        )
      : loadMoreRef.current;
    target?.focus();
  }, [loadingMore, replies]);
  useEffect(() => {
    if (status === "ready" && document.activeElement === document.body) panelRef.current?.focus();
  }, [status]);
  // Open on the latest reply, not the parent: once, when the thread first becomes ready (a later reply never yanks the scroll).
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrolledToLatest = useRef(false);
  useEffect(() => {
    if (status !== "ready" || scrolledToLatest.current) return;
    scrolledToLatest.current = true;
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
  }, [status]);

  function handlePanelKey(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // A draft or a chosen file is the user's work: whichever element has focus, Escape never discards it.
    if (draft !== "" || uploads.chips.length > 0) return;
    event.preventDefault();
    onClose();
  }

  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // While an IME is composing, every key belongs to the IME.
    if (composingRef.current || event.nativeEvent.isComposing) return;
    if (escapeKeepsMine(event, serverDraft)) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!held) void send();
    }
  }

  const sendHint = sendBlockedReason(uploads.chips);
  const { root } = thread;
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
          <span>{status === "ready" ? replyCountLabel(replyCount) : " "}</span>
        </div>
        {/* WP 5.6: shown only when the server sent `legalHold` (a holder of messaging.retention.manage); words, not colour alone. */}
        {status === "ready" && (root?.legalHold || replies.some((r) => r.legalHold)) ? (
          <LegalHoldChip scope="thread" />
        ) : null}
        {status === "ready" ? (
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
      <output className="sr-only" aria-live="polite" aria-atomic="true">
        <span key={announcement.n}>{announcement.text}</span>
      </output>

      <div ref={bodyRef} className="wx-thread-panel-body">
        {status === "loading" ? (
          <output className="wx-message-state">
            <LoadingSpinner label="Loading thread" />
          </output>
        ) : status === "unavailable" ? (
          <div className="wx-message-state" role="alert">
            <strong>Thread unavailable</strong>
            <span>This thread is unavailable or your access has changed.</span>
          </div>
        ) : status === "failed" || !root ? (
          <div className="wx-message-state" role="alert">
            <strong>Thread could not be loaded</strong>
            <Button size="sm" tone="secondary" onClick={() => thread.reload(false)}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            <MessageRow message={root} previous={undefined} meId={meId} anchorMessageId={null} />
            <div
              className="wx-thread-divider"
              aria-hidden={replies.length === 0 ? true : undefined}
            >
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
                ref={loadMoreRef}
                type="button"
                className="wx-load-older"
                onClick={() => {
                  loadMoreFromRef.current = replies.length;
                  thread.loadMore();
                }}
                aria-disabled={loadingMore || undefined}
              >
                {loadingMore ? "Loading…" : "Load more replies"}
              </button>
            ) : null}
          </>
        )}
        {thread.refreshFailed && status === "ready" ? (
          <output className="wx-thread-refresh-warning">
            Connection interrupted.{" "}
            <button type="button" onClick={() => thread.reload(true)}>
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
      ) : status === "ready" ? (
        <>
          <DraftSyncNotice sync={serverDraft} />
          <form
            className="wx-message-composer"
            onSubmit={(event) => {
              if (held) event.preventDefault();
              else void send(event);
            }}
          >
            <label htmlFor="messaging-thread-composer" className="sr-only">
              Reply in thread
            </label>
            <textarea
              ref={textareaRef}
              id="messaging-thread-composer"
              rows={1}
              placeholder="Reply…"
              value={draft}
              // readOnly, not disabled: a disabled control drops focus, and Escape would stop reaching the panel.
              readOnly={sending}
              onChange={(event) => {
                changeDraft(event.target.value);
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
            <AttachmentChips
              uploads={uploads}
              disabled={sending}
              attachButtonRef={attachButtonRef}
            />
            <AttachButton uploads={uploads} disabled={sending} buttonRef={attachButtonRef} />
            <Button
              type="submit"
              disabled={
                held || (!draft.trim() && uploads.sendableIds.length === 0) || uploads.blocksSend
              }
              loading={sending}
              aria-label="Send reply"
            >
              <Glyph name="send" size={16} /> <span>Reply</span>
            </Button>
            {sendInFlight && !sending ? (
              <div className="wx-send-hint">Your previous reply is still being sent.</div>
            ) : null}
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
        </>
      ) : null}
    </aside>
  );
}
