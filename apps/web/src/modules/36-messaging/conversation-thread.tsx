import {
  BACKGROUND_REQUEST_HEADERS,
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { AttachButton, AttachmentChips } from "./attachment-composer";
import { sendBlockedReason } from "./attachment-utils";
import { ComposerFooter } from "./composer-footer";
import {
  applyTextEdit,
  detectMac,
  formatShortcutMarker,
  insertText,
  toggleWrap,
} from "./composer-format";
import { DraftSyncNotice } from "./draft-conflict-prompt";
import { MentionMenu } from "./mention-menu";
import { activeMentionQuery, insertMention, reconcileReferences } from "./mention-utils";
import { MessageRow } from "./message-row";
import type {
  ChannelSummary,
  MentionCandidate,
  Message,
  MessageReference,
  MessageReferenceInput,
  PatientHeaderInfo,
} from "./messaging-types";
import {
  channelKindLabel,
  channelLabel,
  compareMessages,
  initialsOf,
  isAccessError,
  mergeMessages,
} from "./messaging-utils";
import { PinnedMessagesBar } from "./pinned-messages-bar";
import { TemplatePicker } from "./template-picker";
import { PatientContextAside, ThreadHeader } from "./thread-header";
import { ThreadPanel } from "./thread-panel";
import { useAnnouncementTools } from "./use-announcement-tools";
import { useAttachmentUploads } from "./use-attachment-upload";
import { INITIAL_READ_VIEW, type ReadView, useJumpToMessage } from "./use-jump-to-message";
import { useLatestPolling } from "./use-latest-polling";
import { useMentionCandidates } from "./use-mention-candidates";
import { sentMessageRow, useMessageSender } from "./use-message-sender";
import type { SentMessage } from "./use-message-sender";
import { usePatientHeader } from "./use-patient-header";
import { useScanningRefresh } from "./use-scanning-refresh";
import { useServerDraft } from "./use-server-draft";
import type { LiveHint } from "./use-thread";
import { useThreadPanelState } from "./use-thread-panel-state";

const MESSAGE_PAGE_SIZE = 50;

export interface ConversationThreadProps {
  channel: ChannelSummary;
  meId: string;
  meDisplayName: string;
  onBack: () => void;
  onReadConfirmed: (channelId: string) => void;
  onMessageSent: () => void;
  onAccessRevoked: (channelId: string) => void;
  anchorMessageId?: string | null;
  /** Changes when a realtime hint (or a socket reconnect) says this channel has news: read the latest now. */
  liveToken?: number;
  /** While the socket is up, polling is only a safety net and runs slowly. */
  realtimeConnected?: boolean;
  /** WP 2.2: what the latest realtime hint said changed, so an open thread panel refreshes only when it is concerned. */
  liveHint?: LiveHint | null;
  /** WP 2.9: the viewer holds messaging.announce / messaging.manage_members (the server enforces both). */
  canAnnounce?: boolean;
  canManageMembers?: boolean;
}

export function ConversationThread({
  channel,
  meId,
  meDisplayName,
  onBack,
  onReadConfirmed,
  onMessageSent,
  onAccessRevoked,
  anchorMessageId = null,
  liveToken = 0,
  realtimeConnected = false,
  liveHint = null,
  canAnnounce = false,
  canManageMembers = false,
}: ConversationThreadProps): JSX.Element {
  const client = useApiClient();
  const tools = useAnnouncementTools(channel, canAnnounce, canManageMembers);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [draft, setDraft] = useState("");
  const [draftReferences, setDraftReferences] = useState<MessageReferenceInput[]>([]);
  const [mentionQuery, setMentionQuery] = useState<{ query: string; start: number } | null>(null);
  const {
    candidates: mentionCandidates,
    loading: mentionLoading,
    error: mentionError,
    activeIndex: mentionIndex,
    setActiveIndex: setMentionIndex,
    retry: retryMentions,
  } = useMentionCandidates({ channelId: channel.channelId, meId, query: mentionQuery });
  const [contextOpen, setContextOpen] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[] | null>(null);
  const generationRef = useRef(0);
  const [patient, setPatient] = usePatientHeader(channel, generationRef);
  const latestInFlight = useRef(false);
  const handledAnchor = useRef(anchorMessageId);
  // A hint that lands while a read is in flight may postdate that read: read once more when it settles.
  const rereadAfterFlight = useRef(false);
  const nearBottomRef = useRef(true);
  const initialScrollPending = useRef(false);
  const readBoundaryRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const [isMac] = useState(detectMac);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // WP 1.5: resets itself on channel switch and unmount (generation-guarded inside the hook).
  const uploads = useAttachmentUploads(channel.channelId);
  const attachButtonRef = useRef<HTMLButtonElement>(null);
  // The ids the newest latest-page read returned (plus our own sends): only these can be updated by a refresh.
  const latestPageIdsRef = useRef<ReadonlySet<string>>(new Set());
  // Changing identities of these props must not re-run the channel reset (it would clear the draft/sender).
  const anchorRef = useRef(anchorMessageId);
  const meIdRef = useRef(meId);
  const onReadConfirmedRef = useRef(onReadConfirmed);
  const onAccessRevokedRef = useRef(onAccessRevoked);
  // The route anchor follows ONLY its own prop: "Back to latest" clears the mirror, and a re-render with new callback
  // identities must not write the old anchor back.
  useEffect(() => {
    anchorRef.current = anchorMessageId;
  }, [anchorMessageId]);
  useEffect(() => {
    meIdRef.current = meId;
    onReadConfirmedRef.current = onReadConfirmed;
    onAccessRevokedRef.current = onAccessRevoked;
  }, [meId, onReadConfirmed, onAccessRevoked]);

  // WP 2.2 jump-to-parent (and "Back to latest" after an anchored page): see use-jump-to-message.ts.
  const readViewRef = useRef<ReadView>(INITIAL_READ_VIEW);
  const jumpedRef = useRef(false);
  const jump = useJumpToMessage({
    timelineRef,
    messages,
    routeAnchorRef: anchorRef,
    initialScrollPending,
    nearBottomRef,
    viewRef: readViewRef,
    jumpedRef,
  });
  const { reset: jumpReset, anchorGone, routeAnchorChanged } = jump;
  const panel = useThreadPanelState({
    timelineRef,
    textareaRef,
    jumpToMessage: jump.jumpToMessage,
  });
  const { reset: panelReset } = panel;

  const handleSent = (sent: SentMessage): void => {
    latestPageIdsRef.current = new Set([...latestPageIdsRef.current, sent.messageId]);
    setDraft((current) => (current === sent.body ? "" : current));
    setDraftReferences([]);
    setMentionQuery(null);
    const withSentMessage = mergeMessages(messagesRef.current ?? [], [
      sentMessageRow(sent, channel.channelId, meId, meDisplayName),
    ]);
    messagesRef.current = withSentMessage;
    setMessages(withSentMessage);
    nearBottomRef.current = true;
    window.requestAnimationFrame(() => {
      const timeline = timelineRef.current;
      if (timeline) timeline.scrollTop = timeline.scrollHeight;
    });
    onMessageSent();
  };
  // WP 2.5: the draft follows the user across reloads and devices (restore, debounced autosave, merge prompt).
  const serverDraft = useServerDraft({
    channelId: channel.channelId,
    text: draft,
    references: draftReferences,
    hydrate: (text, references) => {
      setDraft(text);
      setDraftReferences(references);
    },
  });
  const { send, sending, sendError, clearSendError, resetSender } = useMessageSender({
    channelId: channel.channelId,
    archived: Boolean(channel.archivedAt),
    draft,
    draftReferences,
    uploads,
    generationRef,
    onSent: handleSent,
  });

  useLayoutEffect(() => {
    // Recalculate after every controlled-value change, including selection and send/reset.
    void draft;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const maximum = Number.parseFloat(window.getComputedStyle(textarea).maxHeight);
    const nextHeight = Number.isFinite(maximum)
      ? Math.min(textarea.scrollHeight, maximum)
      : textarea.scrollHeight;
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      Number.isFinite(maximum) && textarea.scrollHeight > maximum ? "auto" : "hidden";
  }, [draft]);

  const markReadBoundary = useCallback(
    async (candidateMessages: readonly Message[]): Promise<void> => {
      if (document.hidden) return;
      const latestIncoming = [...candidateMessages]
        .sort(compareMessages)
        .reverse()
        .find(
          (message) => message.authorUserId !== null && message.authorUserId !== meIdRef.current,
        );
      if (!latestIncoming || readBoundaryRef.current === latestIncoming.messageId) return;
      const generation = generationRef.current;
      readBoundaryRef.current = latestIncoming.messageId;
      const { error } = await client.POST("/api/v1/messaging/messages/{id}/read", {
        params: { path: { id: latestIncoming.messageId } },
        body: { upTo: true },
      });
      if (generation !== generationRef.current) return;
      if (error) {
        readBoundaryRef.current = null;
        return;
      }
      onReadConfirmedRef.current(channel.channelId);
    },
    [channel.channelId, client],
  );

  const loadLatest = useCallback(
    async (background = false): Promise<boolean> => {
      if (latestInFlight.current) return true;
      latestInFlight.current = true;
      const generation = generationRef.current;
      // The request is captured when the read is issued (see use-jump-to-message.ts).
      const view = readViewRef.current;
      const anchorMessageId = view.anchor ?? anchorRef.current;
      try {
        const { data, error, response } = await client.GET(
          "/api/v1/messaging/channels/{id}/messages",
          {
            params: {
              path: { id: channel.channelId },
              query: {
                limit: MESSAGE_PAGE_SIZE,
                direction: "backward",
                ...(anchorMessageId ? { anchorMessageId } : {}),
              },
            },
            ...(background ? { headers: BACKGROUND_REQUEST_HEADERS } : {}),
          },
        );
        if (generation !== generationRef.current) return false;
        if (view !== readViewRef.current) {
          // A newer request (a jump, back to latest) arrived while this read was in flight: this answer is for the
          // wrong page. Drop it; the queued re-read carries the new request.
          rereadAfterFlight.current = true;
          return true;
        }
        if (error && view.anchor && response?.status === 404) {
          // A 404 on a user jump's page: the message is gone, not access revoked. Say so, show the newest page, and
          // let that read surface a real revocation. Other errors keep the page (ordinary path below).
          anchorGone();
          rereadAfterFlight.current = true;
          return false;
        }
        if (error) {
          if (isAccessError(error)) onAccessRevokedRef.current(channel.channelId);
          if (background) setRefreshError(true);
          else {
            setMessages([]);
            setPatient(null);
            setLoadError("This conversation is unavailable or your access has changed.");
          }
          return false;
        }
        const incoming = (data?.messages ?? []) as Message[];
        latestPageIdsRef.current = new Set(incoming.map((message) => message.messageId));
        // WP 2.2: a jump to an unloaded message (or back to latest) shows ONE contiguous page, never a merge of two.
        const replace = view.replace;
        if (replace) readViewRef.current = { ...view, replace: false };
        const currentMessages = replace ? null : messagesRef.current;
        const wasInitial = messagesRef.current === null;
        const existingIds = new Set(currentMessages?.map((message) => message.messageId) ?? []);
        const added = replace
          ? 0
          : incoming.filter((message) => !existingIds.has(message.messageId)).length;
        setLoadError(null);
        setRefreshError(false);
        setOlderCursor((data?.nextCursor as string | undefined) ?? null);
        const merged =
          currentMessages === null ? incoming : mergeMessages(currentMessages, incoming);
        messagesRef.current = merged;
        setMessages(merged);
        if (wasInitial) initialScrollPending.current = true;
        else if (replace && !view.anchor) {
          initialScrollPending.current = true;
          nearBottomRef.current = true;
          setNewMessageCount(0);
        } else if (background && added > 0 && !nearBottomRef.current) {
          setNewMessageCount((count) => count + added);
        } else if (added > 0 && nearBottomRef.current) {
          window.requestAnimationFrame(() => {
            const timeline = timelineRef.current;
            if (timeline) timeline.scrollTop = timeline.scrollHeight;
          });
        }
        if (!background) window.setTimeout(() => void markReadBoundary(incoming), 0);
        return true;
      } finally {
        // A thread that was unmounted or switched meanwhile bumped the generation: the reset effect already
        // cleared these flags for the new channel, so a stale reply must neither clear them (it would unlock a
        // second read while the new channel's first read is in flight) nor trigger a read for the old thread.
        if (generation === generationRef.current) {
          latestInFlight.current = false;
          if (rereadAfterFlight.current) {
            rereadAfterFlight.current = false;
            void loadLatest(true);
          }
        }
      }
    },
    [channel.channelId, client, markReadBoundary, anchorGone, setPatient],
  );

  const loadOlder = useCallback(async (): Promise<void> => {
    if (!olderCursor || loadingOlder) return;
    const timeline = timelineRef.current;
    const previousHeight = timeline?.scrollHeight ?? 0;
    const generation = generationRef.current;
    const token = readViewRef.current.token;
    setLoadingOlder(true);
    const { data, error } = await client.GET("/api/v1/messaging/channels/{id}/messages", {
      params: {
        path: { id: channel.channelId },
        query: { limit: MESSAGE_PAGE_SIZE, direction: "backward", cursor: olderCursor },
      },
    });
    if (generation !== generationRef.current) return;
    setLoadingOlder(false);
    // A jump or Back to latest replaced the list while this page was in flight: it belongs to the old list.
    if (token !== readViewRef.current.token) return;
    if (error) {
      setRefreshError(true);
      return;
    }
    setOlderCursor((data?.nextCursor as string | undefined) ?? null);
    const merged = mergeMessages(messagesRef.current ?? [], (data?.messages ?? []) as Message[]);
    messagesRef.current = merged;
    setMessages(merged);
    window.requestAnimationFrame(() => {
      const currentTimeline = timelineRef.current;
      if (currentTimeline)
        currentTimeline.scrollTop += currentTimeline.scrollHeight - previousHeight;
    });
  }, [channel.channelId, client, loadingOlder, olderCursor]);

  useEffect(() => {
    generationRef.current += 1;
    messagesRef.current = null;
    setMessages(null);
    setOlderCursor(null);
    setDraft("");
    setDraftReferences([]);
    setMentionQuery(null);
    setLoadError(null);
    setRefreshError(false);
    setPatient(null);
    setContextOpen(false);
    panelReset();
    jumpReset();
    setNewMessageCount(0);
    readBoundaryRef.current = null;
    latestPageIdsRef.current = new Set();
    // The previous channel's latest read may still be in flight: its reply is discarded by the generation
    // check, so it must not keep this channel's first read from being issued.
    latestInFlight.current = false;
    rereadAfterFlight.current = false;
    handledAnchor.current = anchorRef.current;
    resetSender();
    void loadLatest();
    return () => {
      generationRef.current += 1;
    };
    // loadLatest changes identity only with the channel (or client); every other input is read through a ref.
  }, [loadLatest, resetSender, jumpReset, panelReset, setPatient]);

  // A new anchor on the same channel re-reads around it without touching the draft, chips or an in-flight send.
  useEffect(() => {
    if (anchorMessageId === handledAnchor.current) return;
    handledAnchor.current = anchorMessageId;
    routeAnchorChanged(readViewRef.current.anchor !== null);
    if (latestInFlight.current) rereadAfterFlight.current = true;
    else void loadLatest(true);
  }, [anchorMessageId, loadLatest, routeAnchorChanged]);

  // The composer is replaced by a notice when the channel is archived or unreadable: drop the uploads with it.
  const { reset: resetUploads } = uploads;
  const composerHidden = Boolean(channel.archivedAt) || loadError !== null || tools.readOnly;
  useEffect(() => {
    if (composerHidden) resetUploads();
  }, [composerHidden, resetUploads]);

  useLayoutEffect(() => {
    if (!anchorMessageId || messages === null || jumpedRef.current) return;
    const target = timelineRef.current?.querySelector(
      `[data-message-id="${CSS.escape(anchorMessageId)}"]`,
    );
    target?.scrollIntoView({ block: "center" });
  }, [anchorMessageId, messages]);

  // Starts at the token this thread mounted with: the initial load already reads the latest, so only a LATER bump acts.
  const handledLiveToken = useRef(liveToken);
  useEffect(() => {
    if (liveToken === handledLiveToken.current) return;
    handledLiveToken.current = liveToken;
    if (latestInFlight.current) rereadAfterFlight.current = true;
    else void loadLatest(true);
  }, [liveToken, loadLatest]);

  useLatestPolling(loadLatest, realtimeConnected);

  useLayoutEffect(() => {
    if (!initialScrollPending.current || messages === null) return;
    initialScrollPending.current = false;
    const timeline = timelineRef.current;
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }, [messages]);

  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // While an IME is composing, every key belongs to the IME (candidate selection, cancel): handle none of ours.
    if (composingRef.current || event.nativeEvent.isComposing) return;
    const marker = formatShortcutMarker(event, isMac);
    if (marker) {
      // The edit runs through the textarea's own input path (undo stack, onChange, mention query recompute).
      event.preventDefault();
      const area = event.currentTarget;
      // Built from the live value: React state may lag a programmatic change (autofill, an extension).
      applyTextEdit(area, toggleWrap(area.value, area.selectionStart, area.selectionEnd, marker));
      return;
    }
    if (mentionQuery && event.key === "Escape") {
      event.preventDefault();
      setMentionQuery(null);
      return;
    }
    if (mentionQuery && mentionCandidates.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((index) =>
          event.key === "ArrowDown"
            ? (index + 1) % mentionCandidates.length
            : (index - 1 + mentionCandidates.length) % mentionCandidates.length,
        );
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        chooseMention(mentionCandidates[mentionIndex]!);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
      return;
    }
    // Escape in an EMPTY composer hands focus back to the page; with a draft it does nothing (the draft is never
    // lost to a stray key). Tab is never intercepted outside the mention popup, so there is no keyboard trap.
    if (event.key === "Escape" && draft === "") event.currentTarget.blur();
  }

  // WP 2.8: a saved reply is only text put in the draft at the caret; the user edits it and sends an ordinary message.
  function insertSavedReply(text: string): void {
    const area = textareaRef.current;
    if (!area) return;
    applyTextEdit(area, insertText(area.value, area.selectionStart, area.selectionEnd, text));
  }

  function chooseMention(candidate: MentionCandidate): void {
    if (!mentionQuery) return;
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? draft.length;
    const chosen = insertMention({
      draft,
      references: draftReferences,
      query: mentionQuery,
      cursor,
      candidate,
    });
    setDraft(chosen.draft);
    setDraftReferences(chosen.references);
    setMentionQuery(null);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(chosen.caret, chosen.caret);
    });
  }

  // The jump hook asks for a read of the latest (or requested) page through this. Bound after commit, not in render.
  const { reloadRef } = jump;
  useLayoutEffect(() => {
    reloadRef.current = (): void => {
      if (latestInFlight.current) rereadAfterFlight.current = true;
      else void loadLatest(true);
    };
  }, [reloadRef, loadLatest]);

  // A reply was accepted in the panel: patch that root's count now (it may be outside the latest page, which a
  // re-read would not refresh), then re-read, queueing the re-read if one is already in flight.
  const handleReplySent = useCallback(
    (rootId: string, createdAt: string): void => {
      const patched = (messagesRef.current ?? []).map((m) =>
        m.messageId === rootId
          ? { ...m, replyCount: (m.replyCount ?? 0) + 1, lastReplyAt: createdAt }
          : m,
      );
      messagesRef.current = patched;
      setMessages(patched);
      if (latestInFlight.current) rereadAfterFlight.current = true;
      else void loadLatest(true);
      onMessageSent();
    },
    [loadLatest, onMessageSent],
  );
  const authorById = useMemo(
    () => new Map((messages ?? []).map((m) => [m.messageId, m.authorDisplayName])),
    [messages],
  );

  function showLatest(): void {
    const timeline = timelineRef.current;
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
    nearBottomRef.current = true;
    setNewMessageCount(0);
    void markReadBoundary(messages ?? []);
  }

  const sendHint = sendBlockedReason(uploads.chips);
  // Only scanning files on the latest page count: a loadLatest cannot update a row loaded through "Load older".
  const scanningKey = (messages ?? [])
    .filter((message) => latestPageIdsRef.current.has(message.messageId))
    .flatMap((message) => message.attachments ?? [])
    .filter((attachment) => attachment.availability === "scanning")
    .map((attachment) => attachment.attachmentId)
    .sort()
    .join(",");
  // A file the uploader sent while it was still scanning turns openable on the server with no push: re-read.
  useScanningRefresh(scanningKey, loadLatest, channel.channelId);

  const title = patient ? `${patient.firstName} ${patient.lastName}` : channelLabel(channel);
  const subtitle =
    channel.kind === "dm"
      ? channel.participantRoles.join(" · ") || "Direct message"
      : channelKindLabel(channel.kind);

  return (
    <section className="wx-messaging-thread" aria-label={`Conversation with ${title}`}>
      <ThreadHeader
        channel={channel}
        title={title}
        subtitle={subtitle}
        patient={patient}
        contextOpen={contextOpen}
        onBack={onBack}
        onToggleContext={() => setContextOpen((open) => !open)}
        onShowMembers={tools.onShowMembers}
      />
      {tools.dialogs}

      <PinnedMessagesBar
        channelId={channel.channelId}
        messages={messages}
        onJump={jump.jumpToMessage}
      />

      <div className="wx-messaging-thread-body">
        <div
          ref={timelineRef}
          className="wx-message-timeline"
          aria-label="Message history"
          tabIndex={-1}
          onScroll={(event) => {
            const element = event.currentTarget;
            nearBottomRef.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            if (nearBottomRef.current) setNewMessageCount(0);
            if (element.scrollTop < 80 && olderCursor && !loadingOlder) void loadOlder();
          }}
        >
          {loadError ? (
            <div className="wx-message-state" role="alert">
              <Glyph name="shield" size={24} />
              <strong>Conversation unavailable</strong>
              <span>{loadError}</span>
              <Button size="sm" tone="secondary" onClick={() => void loadLatest()}>
                Retry
              </Button>
            </div>
          ) : messages === null ? (
            <output className="wx-message-state">
              <LoadingSpinner label="Loading messages" />
            </output>
          ) : messages.length === 0 ? (
            <div className="wx-message-state">
              <EmptyState
                title="No messages yet"
                description="Send the first secure message below."
              />
            </div>
          ) : (
            <>
              {olderCursor ? (
                <button
                  type="button"
                  className="wx-load-older"
                  onClick={() => void loadOlder()}
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
                  anchorMessageId={jump.highlightId ?? anchorMessageId}
                  onOpenThread={panel.openThread}
                  onJumpToParent={jump.jumpToMessage}
                  parentAuthor={
                    message.parentMessageId
                      ? (authorById.get(message.parentMessageId) ?? null)
                      : undefined
                  }
                  canReply={!channel.archivedAt && tools.canReply}
                  canAnnotate={!channel.archivedAt}
                  canPin
                  onShowReceipts={tools.onShowReceipts}
                />
              ))}
            </>
          )}
        </div>

        {contextOpen && patient ? (
          <PatientContextAside patient={patient} onClose={() => setContextOpen(false)} />
        ) : null}
        {panel.rootId ? (
          <ThreadPanel
            key={panel.rootId}
            channelId={channel.channelId}
            rootId={panel.rootId}
            archived={Boolean(channel.archivedAt)}
            meId={meId}
            meDisplayName={meDisplayName}
            liveHint={liveHint}
            realtimeConnected={realtimeConnected}
            sendInFlight={panel.sendingRoots.has(panel.rootId)}
            onSendStart={panel.beginSend}
            onSendEnd={panel.endSend}
            drafts={panel.draftsRef}
            onClose={panel.closeThread}
            onJumpToMessage={panel.showInConversation}
            onReplySent={handleReplySent}
          />
        ) : null}
      </div>

      {newMessageCount > 0 ? (
        <button type="button" className="wx-new-messages" onClick={showLatest}>
          {newMessageCount} new {newMessageCount === 1 ? "message" : "messages"}
        </button>
      ) : null}
      {jump.browsingHistory ? (
        <button type="button" className="wx-new-messages" onClick={jump.backToLatest}>
          Back to latest messages
        </button>
      ) : null}
      {jump.anchorMissing ? (
        <output className="wx-thread-refresh-warning">That message is no longer available.</output>
      ) : null}
      {refreshError && !loadError ? (
        <output className="wx-thread-refresh-warning">
          Connection interrupted.{" "}
          <button type="button" onClick={() => void loadLatest(true)}>
            Retry now
          </button>
        </output>
      ) : null}

      {composerHidden ? (
        <output className="wx-messaging-archived">
          <Glyph name="lock" size={16} />
          {channel.archivedAt
            ? "This conversation is archived. Message history remains read-only."
            : loadError
              ? "Messaging is unavailable until access can be verified."
              : "Only administrators can post announcements."}
        </output>
      ) : (
        <>
          <DraftSyncNotice sync={serverDraft} />
          <form className="wx-message-composer" onSubmit={(event) => void send(event)}>
            <label htmlFor="messaging-composer" className="sr-only">
              Message
            </label>
            <textarea
              ref={textareaRef}
              id="messaging-composer"
              aria-label="Message"
              rows={1}
              placeholder={`Message ${channelLabel(channel)}…`}
              value={draft}
              disabled={sending}
              aria-autocomplete="list"
              aria-expanded={mentionQuery !== null}
              aria-controls={mentionQuery ? "messaging-mention-suggestions" : undefined}
              onChange={(event) => {
                const next = event.target.value;
                const nextReferences = reconcileReferences(draft, next, draftReferences);
                setDraftReferences(nextReferences);
                setDraft(next);
                const cursor = event.target.selectionStart ?? next.length;
                setMentionQuery(activeMentionQuery(next, cursor, nextReferences));
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
            <TemplatePicker
              disabled={sending}
              onInsert={insertSavedReply}
              onClosed={() => textareaRef.current?.focus()}
            />
            {mentionQuery ? (
              <MentionMenu
                loading={mentionLoading}
                error={mentionError}
                candidates={mentionCandidates}
                activeIndex={mentionIndex}
                onChoose={chooseMention}
                onRetry={retryMentions}
              />
            ) : null}
            <Button
              type="submit"
              disabled={
                sending || (!draft.trim() && uploads.sendableIds.length === 0) || uploads.blocksSend
              }
              loading={sending}
              aria-label="Send"
              aria-describedby={sendHint ? "messaging-send-hint" : undefined}
            >
              <Glyph name="send" size={16} /> <span>Send</span>
            </Button>
            <ComposerFooter sendHint={sendHint} sendError={sendError} sending={sending} />
          </form>
        </>
      )}
    </section>
  );
}
