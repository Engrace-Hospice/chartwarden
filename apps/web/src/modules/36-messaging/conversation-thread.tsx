import {
  BACKGROUND_REQUEST_HEADERS,
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { AttachButton, AttachmentChips } from "./attachment-composer";
import { sendBlockedReason } from "./attachment-utils";
import { formatShortcutMarker, toggleWrap } from "./composer-format";
import { MentionMenu } from "./mention-menu";
import { activeMentionQuery, reconcileReferences } from "./mention-utils";
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
  mergeMessages,
} from "./messaging-utils";
import { useAttachmentUploads } from "./use-attachment-upload";
import { sentMessageRow, useMessageSender } from "./use-message-sender";
import type { SentMessage } from "./use-message-sender";
import { useScanningRefresh } from "./use-scanning-refresh";

const MESSAGE_PAGE_SIZE = 50;
const POLL_INTERVAL_MS = 15_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const REALTIME_POLL_INTERVAL_MS = 120_000;

function isAccessError(error: unknown): boolean {
  const serialized = JSON.stringify(error ?? "").toLowerCase();
  return (
    serialized.includes("forbidden") ||
    serialized.includes("not_found") ||
    serialized.includes("not found")
  );
}

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
}: ConversationThreadProps): JSX.Element {
  const client = useApiClient();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [draft, setDraft] = useState("");
  const [draftReferences, setDraftReferences] = useState<MessageReferenceInput[]>([]);
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([]);
  const [mentionQuery, setMentionQuery] = useState<{ query: string; start: number } | null>(null);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionError, setMentionError] = useState(false);
  const [mentionRetry, setMentionRetry] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [patient, setPatient] = useState<PatientHeaderInfo | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[] | null>(null);
  const generationRef = useRef(0);
  const latestInFlight = useRef(false);
  const handledAnchor = useRef(anchorMessageId);
  // A hint that lands while a read is in flight may postdate that read: read once more when it settles.
  const rereadAfterFlight = useRef(false);
  const nearBottomRef = useRef(true);
  const initialScrollPending = useRef(false);
  const readBoundaryRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionGenerationRef = useRef(0);
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
  useEffect(() => {
    anchorRef.current = anchorMessageId;
    meIdRef.current = meId;
    onReadConfirmedRef.current = onReadConfirmed;
    onAccessRevokedRef.current = onAccessRevoked;
  }, [anchorMessageId, meId, onReadConfirmed, onAccessRevoked]);

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
      const anchorMessageId = anchorRef.current;
      try {
        const { data, error } = await client.GET("/api/v1/messaging/channels/{id}/messages", {
          params: {
            path: { id: channel.channelId },
            query: {
              limit: MESSAGE_PAGE_SIZE,
              direction: "backward",
              ...(anchorMessageId ? { anchorMessageId } : {}),
            },
          },
          ...(background ? { headers: BACKGROUND_REQUEST_HEADERS } : {}),
        });
        if (generation !== generationRef.current) return false;
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
        const currentMessages = messagesRef.current;
        const wasInitial = currentMessages === null;
        const existingIds = new Set(currentMessages?.map((message) => message.messageId) ?? []);
        const added = incoming.filter((message) => !existingIds.has(message.messageId)).length;
        setLoadError(null);
        setRefreshError(false);
        setOlderCursor((data?.nextCursor as string | undefined) ?? null);
        const merged =
          currentMessages === null ? incoming : mergeMessages(currentMessages, incoming);
        messagesRef.current = merged;
        setMessages(merged);
        if (wasInitial) initialScrollPending.current = true;
        else if (background && added > 0 && !nearBottomRef.current) {
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
    [channel.channelId, client, markReadBoundary],
  );

  useEffect(() => {
    // Incrementing this value is the explicit retry signal for the same query.
    void mentionRetry;
    if (!mentionQuery) {
      mentionGenerationRef.current += 1;
      setMentionCandidates([]);
      setMentionLoading(false);
      setMentionError(false);
      return;
    }
    const generation = ++mentionGenerationRef.current;
    setMentionLoading(true);
    setMentionError(false);
    const timer = window.setTimeout(() => {
      void client
        .GET("/api/v1/messaging/channels/{id}/mention-candidates", {
          params: { path: { id: channel.channelId }, query: { q: mentionQuery.query } },
        })
        .then(({ data, error }) => {
          if (generation !== mentionGenerationRef.current) return;
          setMentionLoading(false);
          setMentionError(Boolean(error));
          setMentionCandidates(
            error
              ? []
              : ((data?.candidates ?? []) as MentionCandidate[]).filter(
                  (candidate) => !(candidate.kind === "staff" && candidate.entityId === meId),
                ),
          );
          setMentionIndex(0);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [channel.channelId, client, meId, mentionQuery, mentionRetry]);

  const loadOlder = useCallback(async (): Promise<void> => {
    if (!olderCursor || loadingOlder) return;
    const timeline = timelineRef.current;
    const previousHeight = timeline?.scrollHeight ?? 0;
    const generation = generationRef.current;
    setLoadingOlder(true);
    const { data, error } = await client.GET("/api/v1/messaging/channels/{id}/messages", {
      params: {
        path: { id: channel.channelId },
        query: { limit: MESSAGE_PAGE_SIZE, direction: "backward", cursor: olderCursor },
      },
    });
    if (generation !== generationRef.current) return;
    setLoadingOlder(false);
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
    setMentionCandidates([]);
    setMentionLoading(false);
    setMentionError(false);
    setLoadError(null);
    setRefreshError(false);
    setPatient(null);
    setContextOpen(false);
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
  }, [loadLatest, resetSender]);

  // A new anchor on the same channel re-reads around it without touching the draft, chips or an in-flight send.
  useEffect(() => {
    if (anchorMessageId === handledAnchor.current) return;
    handledAnchor.current = anchorMessageId;
    if (latestInFlight.current) rereadAfterFlight.current = true;
    else void loadLatest(true);
  }, [anchorMessageId, loadLatest]);

  // The composer is replaced by a notice when the channel is archived or unreadable: drop the uploads with it.
  const { reset: resetUploads } = uploads;
  const composerHidden = Boolean(channel.archivedAt) || loadError !== null;
  useEffect(() => {
    if (composerHidden) resetUploads();
  }, [composerHidden, resetUploads]);

  useLayoutEffect(() => {
    if (!anchorMessageId || messages === null) return;
    const target = document.querySelector(`[data-message-id="${CSS.escape(anchorMessageId)}"]`);
    target?.scrollIntoView({ block: "center" });
  }, [anchorMessageId, messages]);

  useEffect(() => {
    if (channel.kind !== "care_team" || !channel.subjectId) return;
    const generation = generationRef.current;
    void client
      .GET("/api/v1/patients/{id}", { params: { path: { id: channel.subjectId } } })
      .then(({ data, error }) => {
        if (generation !== generationRef.current) return;
        setPatient(error || !data ? null : (data as PatientHeaderInfo));
      });
  }, [channel.kind, channel.subjectId, client]);

  // Starts at the token this thread mounted with: the initial load already reads the latest, so only a LATER bump acts.
  const handledLiveToken = useRef(liveToken);
  useEffect(() => {
    if (liveToken === handledLiveToken.current) return;
    handledLiveToken.current = liveToken;
    if (latestInFlight.current) rereadAfterFlight.current = true;
    else void loadLatest(true);
  }, [liveToken, loadLatest]);

  useEffect(() => {
    let timer: number | undefined;
    let failures = 0;
    let stopped = false;
    const base = realtimeConnected ? REALTIME_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    const schedule = (): void => {
      const delay = Math.min(base * 2 ** failures, Math.max(MAX_POLL_INTERVAL_MS, base));
      timer = window.setTimeout(tick, delay);
    };
    const tick = async (): Promise<void> => {
      if (stopped) return;
      if (document.hidden) {
        schedule();
        return;
      }
      failures = (await loadLatest(true)) ? 0 : Math.min(failures + 1, 2);
      schedule();
    };
    const refreshWhenVisible = (): void => {
      if (!document.hidden) void loadLatest(true);
    };
    schedule();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [loadLatest, realtimeConnected]);

  useLayoutEffect(() => {
    if (!initialScrollPending.current || messages === null) return;
    initialScrollPending.current = false;
    const timeline = timelineRef.current;
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }, [messages]);

  function applyFormatShortcut(event: KeyboardEvent<HTMLTextAreaElement>, marker: string): void {
    event.preventDefault();
    const textarea = event.currentTarget;
    const edit = toggleWrap(draft, textarea.selectionStart, textarea.selectionEnd, marker);
    setDraftReferences(reconcileReferences(draft, edit.value, draftReferences));
    setDraft(edit.value);
    window.requestAnimationFrame(() =>
      textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd),
    );
  }

  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const marker = formatShortcutMarker(event);
    if (marker) {
      applyFormatShortcut(event, marker);
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
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !composingRef.current &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void send();
      return;
    }
    // Escape never traps: it closes the mention popup (above) or, with none open, hands focus back to the page.
    if (event.key === "Escape") event.currentTarget.blur();
  }

  function chooseMention(candidate: MentionCandidate): void {
    if (!mentionQuery) return;
    const textarea = textareaRef.current;
    const cursor = textarea?.selectionStart ?? draft.length;
    const token = `@${candidate.displayName}`;
    const next = `${draft.slice(0, mentionQuery.start)}${token}${draft.slice(cursor)}`;
    const end = mentionQuery.start + token.length;
    setDraft(next);
    setDraftReferences((current) => [
      ...current.filter(
        (reference) => reference.end <= mentionQuery.start || reference.start >= cursor,
      ),
      {
        kind: candidate.kind,
        entityId: candidate.entityId,
        start: mentionQuery.start,
        end,
        displayLabel: candidate.displayName,
      },
    ]);
    setMentionQuery(null);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(end, end);
    });
  }

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
      <header className="wx-messaging-thread-header">
        <button
          type="button"
          className="wx-messaging-back"
          onClick={onBack}
          aria-label="Back to conversations"
        >
          <Glyph name="chevron-left" size={20} />
        </button>
        <span className={`wx-messaging-avatar wx-kind-${channel.kind}`} aria-hidden="true">
          {channel.kind === "care_team" ? <Glyph name="users" size={18} /> : initialsOf(title)}
        </span>
        <div className="wx-messaging-thread-title">
          <h2>{channel.kind === "care_team" && patient ? `${title} · Care Team` : title}</h2>
          <span>{patient ? `MRN ${patient.mrn}` : subtitle}</span>
        </div>
        {channel.archivedAt ? (
          <span className="wx-messaging-readonly">
            <Glyph name="lock" size={13} /> Archived · read only
          </span>
        ) : null}
        {channel.kind === "care_team" && patient ? (
          <button
            type="button"
            className="wx-messaging-context-toggle"
            aria-expanded={contextOpen}
            aria-controls="messaging-patient-context"
            onClick={() => setContextOpen((open) => !open)}
          >
            <Glyph name="user-circle" size={16} /> Patient context
          </button>
        ) : null}
      </header>

      <div className="wx-messaging-thread-body">
        <div
          ref={timelineRef}
          className="wx-message-timeline"
          aria-label="Message history"
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
                  anchorMessageId={anchorMessageId}
                />
              ))}
            </>
          )}
        </div>

        {contextOpen && patient ? (
          <aside
            id="messaging-patient-context"
            className="wx-messaging-patient-context"
            aria-label="Patient context"
          >
            <header>
              <strong>Patient context</strong>
              <button
                type="button"
                onClick={() => setContextOpen(false)}
                aria-label="Close patient context"
              >
                <Glyph name="close" size={17} />
              </button>
            </header>
            <div className="wx-messaging-patient-identity">
              <span className="wx-messaging-avatar">
                {initialsOf(`${patient.firstName} ${patient.lastName}`)}
              </span>
              <div>
                <strong>
                  {patient.firstName} {patient.lastName}
                </strong>
                <span>MRN {patient.mrn}</span>
              </div>
            </div>
            <p>Minimum identification details for this authorized care-team conversation.</p>
            <Link to={`/patients/${patient.id}`}>
              Open patient chart <Glyph name="arrow-right" size={14} />
            </Link>
          </aside>
        ) : null}
      </div>

      {newMessageCount > 0 ? (
        <button type="button" className="wx-new-messages" onClick={showLatest}>
          {newMessageCount} new {newMessageCount === 1 ? "message" : "messages"}
        </button>
      ) : null}
      {refreshError && !loadError ? (
        <output className="wx-thread-refresh-warning">
          Connection interrupted.{" "}
          <button type="button" onClick={() => void loadLatest(true)}>
            Retry now
          </button>
        </output>
      ) : null}

      {channel.archivedAt || loadError ? (
        <output className="wx-messaging-archived">
          <Glyph name="lock" size={16} />
          {channel.archivedAt
            ? "This conversation is archived. Message history remains read-only."
            : "Messaging is unavailable until access can be verified."}
        </output>
      ) : (
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
          <AttachmentChips uploads={uploads} disabled={sending} attachButtonRef={attachButtonRef} />
          <AttachButton uploads={uploads} disabled={sending} buttonRef={attachButtonRef} />
          {mentionQuery ? (
            <MentionMenu
              loading={mentionLoading}
              error={mentionError}
              candidates={mentionCandidates}
              activeIndex={mentionIndex}
              onChoose={chooseMention}
              onRetry={() => setMentionRetry((value) => value + 1)}
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
          <small>Enter to send · Shift+Enter for a new line</small>
          {sendHint ? (
            <div id="messaging-send-hint" className="wx-send-hint">
              {sendHint}
            </div>
          ) : null}
          {sendError ? (
            <div role="alert" className="wx-composer-error">
              {sendError}{" "}
              <button type="submit" disabled={sending}>
                Retry
              </button>
            </div>
          ) : null}
        </form>
      )}
    </section>
  );
}
