import {
  BACKGROUND_REQUEST_HEADERS,
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, JSX, KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import type {
  ChannelSummary,
  MentionCandidate,
  Message,
  MessageReference,
  MessageReferenceInput,
  PatientHeaderInfo,
} from "./messaging-types";
import {
  absoluteTime,
  apiErrorMessage,
  channelKindLabel,
  channelLabel,
  compareMessages,
  dayLabel,
  initialsOf,
  mergeMessages,
  rotateIdempotencyKey,
  sendAttemptFor,
} from "./messaging-utils";
import type { SendAttempt } from "./messaging-utils";

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

function reconcileReferences(
  previous: string,
  next: string,
  references: readonly MessageReferenceInput[],
): MessageReferenceInput[] {
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  const removedEnd = previous.length - suffix;
  const delta = next.length - previous.length;
  return references.flatMap((reference) => {
    if (reference.end <= prefix) return [reference];
    if (reference.start >= removedEnd) {
      const shifted = { ...reference, start: reference.start + delta, end: reference.end + delta };
      return next.slice(shifted.start, shifted.end) === `@${shifted.displayLabel}` ? [shifted] : [];
    }
    return [];
  });
}

function referenceInput(reference: MessageReferenceInput) {
  return {
    kind: reference.kind,
    entityId: reference.entityId,
    start: reference.start,
    end: reference.end,
  };
}

function activeMentionQuery(
  value: string,
  cursor: number,
  references: readonly MessageReferenceInput[],
): { query: string; start: number } | null {
  const before = value.slice(0, cursor);
  const match = before.match(/(?:^|\s)@([\p{L}\p{N} .'-]{0,60})$/u);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = cursor - query.length - 1;
  // A selected token ends mention discovery. Text after its separating space is ordinary prose;
  // without this guard the regex treated the token and every following word as one long search.
  if (references.some((reference) => reference.start === start && cursor >= reference.end)) {
    return null;
  }
  return { query, start };
}

function MessageText({ message }: { message: Message }): JSX.Element {
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
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [patient, setPatient] = useState<PatientHeaderInfo | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[] | null>(null);
  const generationRef = useRef(0);
  const latestInFlight = useRef(false);
  // A hint that lands while a read is in flight may postdate that read: read once more when it settles.
  const rereadAfterFlight = useRef(false);
  const nearBottomRef = useRef(true);
  const initialScrollPending = useRef(false);
  const readBoundaryRef = useRef<string | null>(null);
  const sendAttemptRef = useRef<SendAttempt | null>(null);
  const sendInFlightRef = useRef(false);
  const composingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionGenerationRef = useRef(0);

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
        .find((message) => message.authorUserId !== null && message.authorUserId !== meId);
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
      onReadConfirmed(channel.channelId);
    },
    [channel.channelId, client, meId, onReadConfirmed],
  );

  const loadLatest = useCallback(
    async (background = false): Promise<boolean> => {
      if (latestInFlight.current) return true;
      latestInFlight.current = true;
      const generation = generationRef.current;
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
          if (isAccessError(error)) onAccessRevoked(channel.channelId);
          if (background) setRefreshError(true);
          else {
            setMessages([]);
            setPatient(null);
            setLoadError("This conversation is unavailable or your access has changed.");
          }
          return false;
        }
        const incoming = (data?.messages ?? []) as Message[];
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
        latestInFlight.current = false;
        if (rereadAfterFlight.current) {
          rereadAfterFlight.current = false;
          // A thread that was unmounted or switched meanwhile bumped the generation: do not read for it.
          if (generation === generationRef.current) void loadLatest(true);
        }
      }
    },
    [anchorMessageId, channel.channelId, client, markReadBoundary, onAccessRevoked],
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
    setSending(false);
    setLoadError(null);
    setRefreshError(false);
    setSendError(null);
    setPatient(null);
    setContextOpen(false);
    setNewMessageCount(0);
    readBoundaryRef.current = null;
    sendAttemptRef.current = null;
    sendInFlightRef.current = false;
    void loadLatest();
    return () => {
      generationRef.current += 1;
    };
  }, [loadLatest]);

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

  async function send(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const submitted = draft;
    if (!submitted.trim() || sending || sendInFlightRef.current || channel.archivedAt) return;
    sendInFlightRef.current = true;
    const generation = generationRef.current;
    setSending(true);
    setSendError(null);
    const references = draftReferences
      .filter((reference) => reference.end <= submitted.length)
      .map(referenceInput);
    // WP 1.2: one stable id pair per composed message, reused on retry (see sendAttemptFor).
    const attempt = sendAttemptFor(
      sendAttemptRef.current,
      JSON.stringify([channel.channelId, submitted, references]),
    );
    sendAttemptRef.current = attempt;
    const postMessage = () =>
      client.POST("/api/v1/messaging/channels/{id}/messages", {
        params: {
          path: { id: channel.channelId },
          header: { "Idempotency-Key": attempt.idempotencyKey },
        },
        body: { body: submitted, references, clientMessageId: attempt.clientMessageId },
      });
    let result: Awaited<ReturnType<typeof postMessage>>;
    try {
      result = await postMessage();
    } catch {
      // Network failure / aborted fetch: no response arrived, so keep the attempt for the retry.
      if (generation !== generationRef.current) return;
      sendInFlightRef.current = false;
      setSending(false);
      setSendError("Message could not be sent. Your draft has been preserved.");
      return;
    }
    const { data, error, response } = result;
    if (generation !== generationRef.current) return;
    sendInFlightRef.current = false;
    setSending(false);
    // The idempotency store caches every answered response, errors included, so a retry under the
    // same key would replay the failure. Keep the key only when no response arrived (lost reply).
    if (response && response.status >= 400)
      sendAttemptRef.current = rotateIdempotencyKey(attempt);
    if (error || !data) {
      setSendError(
        apiErrorMessage(error, "Message could not be sent. Your draft has been preserved."),
      );
      return;
    }
    sendAttemptRef.current = null;
    setDraft((current) => (current === submitted ? "" : current));
    setDraftReferences([]);
    setMentionQuery(null);
    const withSentMessage = mergeMessages(messagesRef.current ?? [], [
      {
        messageId: data.messageId,
        channelId: channel.channelId,
        authorUserId: meId,
        authorDisplayName: meDisplayName,
        body: submitted,
        bodyKind: "plain",
        createdAt: data.createdAt,
        parentMessageId: null,
        references: draftReferences.map((reference) => ({ ...reference, navigable: true })),
      },
    ]);
    messagesRef.current = withSentMessage;
    setMessages(withSentMessage);
    nearBottomRef.current = true;
    window.requestAnimationFrame(() => {
      const timeline = timelineRef.current;
      if (timeline) timeline.scrollTop = timeline.scrollHeight;
    });
    onMessageSent();
  }

  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
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
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionQuery(null);
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
    }
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
              {messages.map((message, index) => {
                const previous = messages[index - 1];
                const showDay =
                  !previous || dayLabel(previous.createdAt) !== dayLabel(message.createdAt);
                const mine = message.authorUserId === meId;
                const system = message.authorUserId === null || message.bodyKind === "system";
                const grouped =
                  previous &&
                  previous.authorUserId === message.authorUserId &&
                  new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() <
                    300_000 &&
                  !showDay;
                return (
                  <div key={message.messageId}>
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
              })}
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
              if (sendError) setSendError(null);
            }}
            onKeyDown={handleComposerKey}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
          />
          {mentionQuery ? (
            // biome-ignore lint/a11y/useFocusableInteractive: focus remains in the composer while arrow keys control this ARIA combobox popup
            <div
              id="messaging-mention-suggestions"
              className="wx-mention-menu"
              // biome-ignore lint/a11y/useSemanticElements: a native select cannot serve as a rich, async composer popup
              role="listbox"
              aria-label="Mention suggestions"
            >
              {mentionLoading ? (
                <span className="wx-mention-state">Searching…</span>
              ) : mentionError ? (
                <span className="wx-mention-state" role="alert">
                  Suggestions could not be loaded.{" "}
                  <button type="button" onClick={() => setMentionRetry((value) => value + 1)}>
                    Retry
                  </button>
                </span>
              ) : mentionCandidates.length === 0 ? (
                <span className="wx-mention-state">No eligible people or patients</span>
              ) : (
                mentionCandidates.map((candidate, index) => (
                  <button
                    // biome-ignore lint/a11y/useSemanticElements: a native option cannot render the required staff/patient detail markup
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={index === mentionIndex}
                    className={index === mentionIndex ? "is-active" : undefined}
                    key={`${candidate.kind}:${candidate.entityId}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseMention(candidate)}
                  >
                    <strong>{candidate.displayName}</strong>
                    <span>
                      {candidate.kind === "patient" ? "Patient" : "Staff"}
                      {candidate.detail ? ` · ${candidate.detail}` : ""}
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : null}
          <Button
            type="submit"
            disabled={sending || !draft.trim()}
            loading={sending}
            aria-label="Send"
          >
            <Glyph name="send" size={16} /> <span>Send</span>
          </Button>
          <small>Enter to send · Shift+Enter for a new line</small>
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
