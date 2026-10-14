import {
  Button,
  Glyph,
  InlineAlert,
  TextAreaField,
  useApiClient,
} from "@wardenx/ui";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent, JSX } from "react";
import { usePortalPatient } from "../patient-context";
import { PortalPage } from "./portal-page";

interface Channel {
  channelId: string;
  lastReadPointer: string | null;
}
interface PortalMessage {
  messageId: string;
  body: string;
  sentAt: string;
  direction: "incoming" | "outgoing";
  senderLabel: string;
}
interface HistoryPage {
  messages: PortalMessage[];
  nextCursor?: string;
}
type Resource<T> =
  | { status: "loading"; data: null }
  | { status: "ready"; data: T }
  | { status: "error"; data: null };
const loading = <T,>(): Resource<T> => ({ status: "loading", data: null });
interface ApiResult {
  data?: unknown;
  error?: unknown;
  response?: { status?: number };
}
const sortMessages = (messages: PortalMessage[]): PortalMessage[] =>
  [...messages].sort((left, right) => {
    const leftTime = Date.parse(left.sentAt);
    const rightTime = Date.parse(right.sentAt);
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime))
      return left.messageId.localeCompare(right.messageId);
    return (
      leftTime - rightTime || left.messageId.localeCompare(right.messageId)
    );
  });

function messageTime(value: string): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(instant);
}

function messageDay(value: string): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return "Date unavailable";
  const today = new Date();
  const sameDay = (left: Date, right: Date) =>
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate();
  if (sameDay(instant, today)) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(instant, yesterday)) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: instant.getFullYear() === today.getFullYear() ? undefined : "numeric",
  }).format(instant);
}

function MessagingSkeleton(): JSX.Element {
  return (
    <output
      className="wx-portal-messaging-skeleton"
      aria-label="Loading messages"
    >
      <span />
      <span />
      <span />
      <span />
    </output>
  );
}

function MessagingError({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <div className="wx-portal-messaging-error" role="alert">
      <Glyph name="alert-circle" size={22} />
      <div>
        <strong>Messages are unavailable</strong>
        <p>
          We couldn't load this conversation. Your typed message has not been
          removed.
        </p>
      </div>
      <button type="button" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

function MessageTimeline({
  messages,
  olderCursor,
  loadingOlder,
  onLoadOlder,
}: {
  messages: PortalMessage[];
  olderCursor?: string;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}): JSX.Element {
  let previousDay: string | null = null;
  return (
    <ol
      className="wx-portal-message-timeline"
      aria-label="Conversation with your care team"
    >
      <li className="wx-portal-message-history-control">
        {olderCursor ? (
          <button type="button" onClick={onLoadOlder} disabled={loadingOlder}>
            {loadingOlder ? "Loading…" : "Load earlier messages"}
          </button>
        ) : messages.length > 0 ? (
          <span>Beginning of conversation</span>
        ) : null}
      </li>
      {messages.map((message) => {
        const day = messageDay(message.sentAt);
        const separator = day !== previousDay;
        previousDay = day;
        return (
          <li
            key={message.messageId}
            className={`wx-portal-message-row is-${message.direction}`}
          >
            {separator ? (
              <div className="wx-portal-message-day">
                <span>{day}</span>
              </div>
            ) : null}
            <article className="wx-portal-message-bubble">
              <header>
                <strong>{message.senderLabel}</strong>
                <time dateTime={message.sentAt}>
                  {messageTime(message.sentAt)}
                </time>
              </header>
              <p>{message.body}</p>
            </article>
          </li>
        );
      })}
    </ol>
  );
}

function MessageComposer({
  draft,
  sending,
  feedback,
  onDraft,
  onSubmit,
}: {
  draft: string;
  sending: boolean;
  feedback: { tone: "ok" | "err"; msg: string } | null;
  onDraft: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}): JSX.Element {
  const tooLong = draft.length > 8000;
  return (
    <form className="wx-portal-message-composer" onSubmit={onSubmit}>
      <TextAreaField
        id="portal-msg"
        label="Message your care team"
        hint={`${draft.length.toLocaleString()} of 8,000 characters · Enter adds a new line.`}
        error={
          tooLong
            ? "Your message must be 8,000 characters or fewer."
            : undefined
        }
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        placeholder="Write a message…"
        disabled={sending}
        rows={4}
      />
      <div className="wx-portal-message-composer__footer">
        <p>
          <Glyph name="shield-check" size={16} /> Sent securely to the hospice
          care team.
        </p>
        <Button
          type="submit"
          loading={sending}
          disabled={!draft.trim() || tooLong || sending}
        >
          <Glyph name="send" size={16} /> Send message
        </Button>
      </div>
      {feedback ? (
        <InlineAlert tone={feedback.tone === "err" ? "error" : "success"}>
          {feedback.msg}
        </InlineAlert>
      ) : null}
    </form>
  );
}

export function PortalMessages(): JSX.Element {
  const { patientId } = usePortalPatient();
  // A fresh component per care record isolates the draft, channel and asynchronous
  // pagination/send state even when React Router reuses the same route component.
  return (
    <PortalMessagesForPatient
      key={patientId ?? "no-patient"}
      patientId={patientId}
    />
  );
}

function PortalMessagesForPatient({
  patientId,
}: {
  patientId: string | null;
}): JSX.Element {
  const client = useApiClient();
  // Keep this screen insulated from openapi-fetch's repository-wide path-union recursion limit.
  const portalGet = useMemo(
    () =>
      client.GET as unknown as (
        path: string,
        init: unknown,
      ) => Promise<ApiResult>,
    [client],
  );
  const portalPost = useMemo(
    () =>
      client.POST as unknown as (
        path: string,
        init: unknown,
      ) => Promise<ApiResult>,
    [client],
  );
  const [channel, setChannel] = useState<Resource<Channel>>(loading);
  const [history, setHistory] = useState<Resource<HistoryPage>>(loading);
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const sendInFlight = useRef(false);
  const pageGeneration = useRef(0);
  const [feedback, setFeedback] = useState<{
    tone: "ok" | "err";
    msg: string;
  } | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const previousHeightRef = useRef<number | null>(null);

  const loadHistory = useCallback(
    async (cursor?: string): Promise<HistoryPage | null> => {
      const query: { cursor?: string; limit: number } = { limit: 30 };
      if (cursor) query.cursor = cursor;
      const response = await portalGet("/api/v1/portal/messages/history", {
        params: { query },
      });
      if ("error" in response) return null;
      const page = response.data as HistoryPage;
      return { ...page, messages: sortMessages(page.messages) };
    },
    [portalGet],
  );

  useEffect(() => {
    void patientId;
    void attempt;
    let active = true;
    pageGeneration.current += 1;
    setChannel(loading());
    setHistory(loading());
    setOlderError(false);
    setLoadingOlder(false);
    previousHeightRef.current = null;
    // Refreshing a conversation must not delete an unsent draft.
    // Switching patients remounts the patient-keyed component above.
    void (async () => {
      try {
        const response = await portalGet("/api/v1/portal/messages/channel", {});
        if (!active) return;
        if ("error" in response) {
          setChannel({ status: "error", data: null });
          setHistory({ status: "error", data: null });
          return;
        }
        const resolved = response.data as Channel;
        setChannel({ status: "ready", data: resolved });
        if (!resolved.channelId) {
          setHistory({ status: "ready", data: { messages: [] } });
          return;
        }
        const page = await loadHistory();
        if (!active) return;
        setHistory(
          page
            ? { status: "ready", data: page }
            : { status: "error", data: null },
        );
      } catch {
        if (active) {
          setChannel({ status: "error", data: null });
          setHistory({ status: "error", data: null });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [patientId, attempt, loadHistory, portalGet]);

  useLayoutEffect(() => {
    void history;
    if (previousHeightRef.current === null || !timelineRef.current) return;
    timelineRef.current.scrollTop +=
      timelineRef.current.scrollHeight - previousHeightRef.current;
    previousHeightRef.current = null;
  }, [history]);

  async function loadOlder(): Promise<void> {
    if (history.status !== "ready" || !history.data.nextCursor || loadingOlder)
      return;
    const generation = pageGeneration.current;
    setLoadingOlder(true);
    setOlderError(false);
    previousHeightRef.current = timelineRef.current?.scrollHeight ?? null;
    try {
      const page = await loadHistory(history.data.nextCursor);
      if (generation !== pageGeneration.current) return;
      if (!page) {
        setOlderError(true);
        previousHeightRef.current = null;
        return;
      }
      setHistory((current) =>
        current.status === "ready"
          ? {
              status: "ready",
              data: {
                messages: sortMessages([
                  ...page.messages,
                  ...current.data.messages,
                ]),
                nextCursor: page.nextCursor,
              },
            }
          : current,
      );
    } catch {
      if (generation === pageGeneration.current) {
        setOlderError(true);
        previousHeightRef.current = null;
      }
    } finally {
      if (generation === pageGeneration.current) setLoadingOlder(false);
    }
  }

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (
      !draft.trim() ||
      draft.length > 8000 ||
      sendInFlight.current ||
      channel.status !== "ready" ||
      !channel.data.channelId
    )
      return;
    sendInFlight.current = true;
    setSending(true);
    setFeedback(null);
    const generation = pageGeneration.current;
    try {
      const response = await portalPost("/api/v1/portal/messages/send", {
        body: { body: draft },
      });
      if (generation !== pageGeneration.current) return;
      if ("error" in response) {
        setFeedback({
          tone: "err",
          msg:
            response.response?.status === 422
              ? "Check your message and try again."
              : "We could not confirm that your message was sent. Check the conversation before trying again.",
        });
        return;
      }
      setDraft("");
      setFeedback({ tone: "ok", msg: "Message sent to your care team." });
      // Sending and refreshing the timeline are separate operations. A failed
      // refresh must never turn an acknowledged send into a failure message.
      try {
        const page = await loadHistory();
        if (generation !== pageGeneration.current) return;
        if (page) setHistory({ status: "ready", data: page });
        else
          setFeedback({
            tone: "ok",
            msg: "Message sent. Refresh the conversation to check for updates.",
          });
      } catch {
        if (generation === pageGeneration.current)
          setFeedback({
            tone: "ok",
            msg: "Message sent. Refresh the conversation to check for updates.",
          });
      }
      requestAnimationFrame(() =>
        timelineRef.current?.scrollTo({
          top: timelineRef.current.scrollHeight,
        }),
      );
    } catch {
      if (generation === pageGeneration.current)
        setFeedback({
          tone: "err",
          msg: "We could not confirm that your message was sent. Check the conversation before trying again.",
        });
    } finally {
      sendInFlight.current = false;
      if (generation === pageGeneration.current) setSending(false);
    }
  }

  const unavailable = channel.status === "ready" && !channel.data.channelId;
  return (
    <PortalPage
      title="Messages"
      subtitle="Communicate securely with your hospice care team."
      width="workspace"
    >
      <section
        className="wx-portal-messaging"
        aria-labelledby="portal-conversation-title"
      >
        <header className="wx-portal-conversation-header">
          <span>
            <Glyph name="users" size={22} />
          </span>
          <div>
            <h2 id="portal-conversation-title">Your hospice care team</h2>
            <p>
              <Glyph name="lock" size={14} /> Secure conversation
            </p>
          </div>
          <button
            type="button"
            aria-label="Refresh conversation"
            disabled={sending}
            onClick={() => setAttempt((value) => value + 1)}
          >
            <Glyph name="rotate-ccw" size={18} /> <span>Refresh</span>
          </button>
        </header>
        <div className="wx-portal-conversation-body" ref={timelineRef}>
          {channel.status === "loading" || history.status === "loading" ? (
            <MessagingSkeleton />
          ) : null}
          {channel.status === "error" || history.status === "error" ? (
            <MessagingError onRetry={() => setAttempt((value) => value + 1)} />
          ) : null}
          {unavailable ? (
            <div className="wx-portal-messaging-empty">
              <Glyph name="message-square" size={28} />
              <strong>Secure messaging isn't available yet.</strong>
              <p>Contact your hospice team directly if you need help.</p>
            </div>
          ) : null}
          {history.status === "ready" &&
          !unavailable &&
          history.data.messages.length === 0 ? (
            <div className="wx-portal-messaging-empty">
              <Glyph name="message-square" size={28} />
              <strong>No messages yet</strong>
              <p>Send a message to your care team to start the conversation.</p>
            </div>
          ) : null}
          {history.status === "ready" && history.data.messages.length > 0 ? (
            <>
              {olderError ? (
                <p role="alert" className="wx-portal-messaging-older-error">
                  Earlier messages couldn't be loaded. You can try again.
                </p>
              ) : null}
              <MessageTimeline
                messages={history.data.messages}
                olderCursor={history.data.nextCursor}
                loadingOlder={loadingOlder}
                onLoadOlder={() => void loadOlder()}
              />
            </>
          ) : null}
        </div>
        {channel.status === "ready" && channel.data.channelId ? (
          <MessageComposer
            draft={draft}
            sending={sending}
            feedback={feedback}
            onDraft={(value) => {
              setDraft(value);
              setFeedback(null);
            }}
            onSubmit={(event) => void send(event)}
          />
        ) : null}
      </section>
    </PortalPage>
  );
}
