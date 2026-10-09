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
import type { ChannelSummary, Message, PatientHeaderInfo } from "./messaging-types";
import {
  absoluteTime,
  apiErrorMessage,
  channelKindLabel,
  channelLabel,
  compareMessages,
  dayLabel,
  initialsOf,
  mergeMessages,
} from "./messaging-utils";

const MESSAGE_PAGE_SIZE = 50;
const POLL_INTERVAL_MS = 15_000;
const MAX_POLL_INTERVAL_MS = 60_000;

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
}

export function ConversationThread({
  channel,
  meId,
  meDisplayName,
  onBack,
  onReadConfirmed,
  onMessageSent,
  onAccessRevoked,
}: ConversationThreadProps): JSX.Element {
  const client = useApiClient();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [patient, setPatient] = useState<PatientHeaderInfo | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[] | null>(null);
  const generationRef = useRef(0);
  const latestInFlight = useRef(false);
  const nearBottomRef = useRef(true);
  const initialScrollPending = useRef(false);
  const readBoundaryRef = useRef<string | null>(null);
  const composingRef = useRef(false);

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
            query: { limit: MESSAGE_PAGE_SIZE, direction: "backward" },
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
      }
    },
    [channel.channelId, client, markReadBoundary, onAccessRevoked],
  );

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
    setLoadError(null);
    setRefreshError(false);
    setSendError(null);
    setPatient(null);
    setContextOpen(false);
    setNewMessageCount(0);
    readBoundaryRef.current = null;
    void loadLatest();
    return () => {
      generationRef.current += 1;
    };
  }, [loadLatest]);

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

  useEffect(() => {
    let timer: number | undefined;
    let failures = 0;
    let stopped = false;
    const schedule = (): void => {
      const delay = Math.min(POLL_INTERVAL_MS * 2 ** failures, MAX_POLL_INTERVAL_MS);
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
  }, [loadLatest]);

  useLayoutEffect(() => {
    if (!initialScrollPending.current || messages === null) return;
    initialScrollPending.current = false;
    const timeline = timelineRef.current;
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }, [messages]);

  async function send(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const submitted = draft.trim();
    if (!submitted || sending || channel.archivedAt) return;
    const generation = generationRef.current;
    setSending(true);
    setSendError(null);
    const { data, error } = await client.POST("/api/v1/messaging/channels/{id}/messages", {
      params: { path: { id: channel.channelId } },
      body: { body: submitted },
    });
    if (generation !== generationRef.current) return;
    setSending(false);
    if (error || !data) {
      setSendError(
        apiErrorMessage(error, "Message could not be sent. Your draft has been preserved."),
      );
      return;
    }
    setDraft((current) => (current.trim() === submitted ? "" : current));
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
                            <span>{message.body || "Message deleted"}</span>
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
            id="messaging-composer"
            aria-label="Message"
            rows={1}
            placeholder={`Message ${channelLabel(channel)}…`}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
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
