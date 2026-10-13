import { BACKGROUND_REQUEST_HEADERS, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX, KeyboardEvent, RefObject, UIEvent } from "react";
import { sendBlockedReason } from "./attachment-utils";
import { applyTextEdit, detectMac, insertText } from "./composer-format";
import { handleComposerKeyDown } from "./composer-keys";
import { deferUntilLoaded } from "./defer-until-loaded";
import { ThreadComposer } from "./message-composer";
import { MessageSearch } from "./message-search";
import { MessageTimeline } from "./message-timeline";
import type {
  ChannelSummary,
  Message,
  MessageReference,
  MessageReferenceInput,
  PatientHeaderInfo,
} from "./messaging-types";
import {
  channelKindLabel,
  channelLabel,
  compareMessages,
  correlationIdOf,
  initialsOf,
  isAccessError,
  mergeMessages,
} from "./messaging-utils";
import { PendingMessageList } from "./pending-message-row";
import { PinnedMessagesBar } from "./pinned-messages-bar";
import { PatientContextAside, ThreadHeader } from "./thread-header";
import { ThreadPanel } from "./thread-panel";
import { useAnnouncementTools } from "./use-announcement-tools";
import { useAttachmentUploads } from "./use-attachment-upload";
import { useAutoGrowTextarea } from "./use-auto-grow-textarea";
import { INITIAL_READ_VIEW, type ReadView, useJumpToMessage } from "./use-jump-to-message";
import { useLatestPolling } from "./use-latest-polling";
import { useMentionPicker } from "./use-mention-picker";
import { sentMessageRow, useMessageSender } from "./use-message-sender";
import type { SentMessage } from "./use-message-sender";
import { type Outbox, useBindOutboxThread, useOutbox } from "./use-outbox";
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
  /** The org-level outbox (it outlives this thread); without one the thread keeps its own. */
  outbox?: Outbox;
  /** An archive / unarchive succeeded: re-read the channel list. */
  onChannelChanged?: () => unknown;
  /** Receives focus when the user opens this conversation from the inbox on a narrow screen. */
  headingRef?: RefObject<HTMLHeadingElement>;
}

export function ConversationThread(props: ConversationThreadProps): JSX.Element {
  return props.outbox ? (
    <ConversationThreadView {...props} outbox={props.outbox} />
  ) : (
    <Own {...props} />
  );
}

const Own = (props: ConversationThreadProps): JSX.Element => (
  <ConversationThreadView {...props} outbox={useOutbox()} />
);

function ConversationThreadView({
  outbox,
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
  onChannelChanged,
  headingRef,
}: ConversationThreadProps & { outbox: Outbox }): JSX.Element {
  const client = useApiClient();
  const tools = useAnnouncementTools(channel, canAnnounce, canManageMembers, onChannelChanged);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadCorrelationId, setLoadCorrelationId] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [draft, setDraft] = useState("");
  const [draftReferences, setDraftReferences] = useState<MessageReferenceInput[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const {
    query: mentionQuery,
    setQuery: setMentionQuery,
    pendingAdd,
    adding: mentionAdding,
    addFailed: mentionAddFailed,
    addToConversation,
    choose: chooseMention,
    dismissMentionAdd,
    resetMention,
    menu: mentionMenu,
    canAdd: canAddMention,
    setActiveIndex: setMentionIndex,
  } = useMentionPicker({
    channelId: channel.channelId,
    meId,
    draft,
    draftReferences,
    setDraft,
    setDraftReferences,
    textareaRef,
  });
  const [contextOpen, setContextOpen] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[] | null>(null);
  const generationRef = useRef(0);
  const [patient, setPatient] = usePatientHeader(channel);
  const latestInFlight = useRef(false);
  const handledAnchor = useRef(anchorMessageId);
  // A hint that lands while a read is in flight may postdate that read: read once more when it settles.
  const rereadAfterFlight = useRef(false);
  const nearBottomRef = useRef(true);
  const initialScrollPending = useRef(false);
  const readBoundaryRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const [isMac] = useState(detectMac);
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

  /** The server confirmed `sent`: show it at the bottom. Leaves the draft alone (a queued message's draft moved on). */
  const mergeSent = (sent: SentMessage): void => {
    if (deferUntilLoaded(messagesRef, rereadAfterFlight, onMessageSent)) return;
    latestPageIdsRef.current = new Set([...latestPageIdsRef.current, sent.messageId]);
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
  const handleSent = (sent: SentMessage): void => {
    setDraft((current) => (current === sent.body ? "" : current));
    setDraftReferences([]);
    resetMention();
    mergeSent(sent);
  };
  const focusComposer = useCallback(() => {
    textareaRef.current?.focus();
    if (document.activeElement !== textareaRef.current) timelineRef.current?.focus();
  }, []);
  useBindOutboxThread(outbox, channel.channelId, mergeSent);
  const { send, sending, sendError, clearSendError, resetSender } = useMessageSender({
    channelId: channel.channelId,
    archived: Boolean(channel.archivedAt),
    draft,
    draftReferences,
    uploads,
    generationRef,
    onSent: handleSent,
    hasQueuedAhead: () => outbox.hasQueued(channel.channelId),
    onQueued: (queued, stillOpen) => {
      outbox.enqueue(channel.channelId, queued);
      if (!stillOpen) return;
      setDraft((current) => (current === queued.sent.body ? "" : current));
      setDraftReferences([]);
      resetMention();
    },
  });
  // WP 2.5: the draft follows the user across reloads and devices (restore, debounced autosave, merge prompt).
  const serverDraft = useServerDraft({
    channelId: channel.channelId,
    text: draft,
    references: draftReferences,
    suspended: sending,
    hydrate: (text, references) => {
      setDraft(text);
      setDraftReferences(references);
    },
  });

  useAutoGrowTextarea(textareaRef, draft);

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
            setLoadCorrelationId(correlationIdOf(error));
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
        setLoadCorrelationId(null);
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
    resetMention();
    setLoadError(null);
    setLoadCorrelationId(null);
    setRefreshError(false);
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
  }, [loadLatest, resetSender, resetMention, jumpReset, panelReset]);

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
    handleComposerKeyDown(event, {
      composing: composingRef.current,
      isMac,
      serverDraft,
      draft,
      pendingAdd,
      mentionQuery,
      mentionMenu,
      dismissMentionAdd,
      setMentionQuery,
      setMentionIndex,
      chooseMention,
      send,
    });
  }

  function handleTimelineScroll(event: UIEvent<HTMLDivElement>): void {
    const element = event.currentTarget;
    nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    if (nearBottomRef.current) setNewMessageCount(0);
    if (element.scrollTop < 80 && olderCursor && !loadingOlder) void loadOlder();
  }

  // WP 2.8: a saved reply is only text put in the draft at the caret; the user edits it and sends an ordinary message.
  function insertSavedReply(text: string): void {
    const area = textareaRef.current;
    if (!area) return;
    applyTextEdit(area, insertText(area.value, area.selectionStart, area.selectionEnd, text));
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
        headingRef={headingRef}
      />
      {tools.dialogs}
      <MessageSearch
        channelId={channel.channelId}
        archived={Boolean(channel.archivedAt)}
        meId={meId}
        messages={messages}
        onJump={jump.jumpToMessage}
      />
      <PinnedMessagesBar
        channelId={channel.channelId}
        messages={messages}
        onJump={jump.jumpToMessage}
      />

      <div className="wx-messaging-thread-body">
        <MessageTimeline
          timelineRef={timelineRef}
          messages={messages}
          loadError={loadError}
          loadCorrelationId={loadCorrelationId}
          olderCursor={olderCursor}
          loadingOlder={loadingOlder}
          meId={meId}
          highlightedMessageId={jump.highlightId ?? anchorMessageId}
          authorById={authorById}
          canReply={!channel.archivedAt && tools.canReply}
          canAnnotate={!channel.archivedAt}
          onShowReceipts={tools.onShowReceipts}
          onScroll={handleTimelineScroll}
          onRetry={() => void loadLatest()}
          onLoadOlder={() => void loadOlder()}
          onOpenThread={panel.openThread}
          onJumpToMessage={jump.jumpToMessage}
          pending={
            <PendingMessageList
              items={outbox.itemsFor(channel.channelId)}
              delivered={outbox.deliveredFor(channel.channelId)}
              channelId={channel.channelId}
              onFocusComposer={focusComposer}
              meId={meId}
              meDisplayName={meDisplayName}
              onRetry={(localId) => void outbox.retry(localId)}
              onDiscard={outbox.discard}
            />
          }
        />

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

      <ThreadComposer
        channel={channel}
        composerHidden={composerHidden}
        loadError={loadError}
        serverDraft={serverDraft}
        textareaRef={textareaRef}
        attachButtonRef={attachButtonRef}
        composingRef={composingRef}
        draft={draft}
        setDraft={setDraft}
        draftReferences={draftReferences}
        setDraftReferences={setDraftReferences}
        uploads={uploads}
        sending={sending}
        send={send}
        sendError={sendError}
        clearSendError={clearSendError}
        sendHint={sendHint}
        onKeyDown={handleComposerKey}
        onInsertSavedReply={insertSavedReply}
        mentionQuery={mentionQuery}
        setMentionQuery={setMentionQuery}
        pendingAdd={pendingAdd}
        mentionAdding={mentionAdding}
        mentionAddFailed={mentionAddFailed}
        canAddMention={canAddMention}
        mentionMenu={mentionMenu}
        addToConversation={addToConversation}
        dismissMentionAdd={dismissMentionAdd}
      />
    </section>
  );
}
