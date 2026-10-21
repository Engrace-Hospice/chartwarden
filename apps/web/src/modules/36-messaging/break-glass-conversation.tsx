// M36 WP 5.8 (ADR-0087, PROPOSED) - what the messaging screen shows for a requested conversation that is NOT in the person's list. If they hold a
// live break-glass grant for it, a READ-ONLY view with a persistent, non-dismissible banner (ends HH:MM, every read is recorded, End now);
// otherwise the "not available" state with the request entry. The grant only opens the channel detail, the message list and the thread over REST, so
// this view has no composer, reaction, pin, search or attachment control (each would answer 403) and renders message text as plain text only.
// The banner's status text is static (the end time); the countdown beside it changes at most once a minute and is not a live region. Expiry is
// judged by the server's instants: when the end passes, the grants are re-read and the view falls back politely.
import type { BreakGlassGrantDto } from "@chartwarden/types";
import {
  BACKGROUND_REQUEST_HEADERS,
  Button,
  EmptyState,
  LoadingSpinner,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { BreakGlassRequest } from "./break-glass-request";
import * as W from "./break-glass-wording";
import type { Message } from "./messaging-types";
import { channelKindLabel } from "./messaging-utils";
import { useOnlineStatus } from "./offline-banner";
import { useBreakGlassActions, useMyGrants } from "./use-break-glass";
import "./break-glass.css";

const MINUTE_MS = 60_000;
const EXPIRY_SLACK_MS = 750;
const PAGE_SIZE = 50;

const formatClock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
const formatTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

const REREAD_RETRY_MS = 15_000;

/**
 * Re-renders once a minute (the countdown text only). Shortly after the grant's end it fires `onExpired`, and keeps firing every 15 s while
 * mounted: if the re-read still answers "active" (a skewed clock) or fails, the view must not sit dead. `pastEnd` is true from that first
 * firing, so the view is treated as ended locally until a re-read says otherwise (it unmounts when the grant is no longer active).
 */
function useGrantClock(
  expiresAt: string,
  onExpired: () => void,
): { readonly now: number; readonly pastEnd: boolean } {
  const [now, setNow] = useState(() => Date.now());
  const [pastEnd, setPastEnd] = useState(false);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  useEffect(() => {
    setPastEnd(false);
    let retry: number | undefined;
    const fire = (): void => {
      setPastEnd(true);
      expired.current();
      retry = window.setTimeout(fire, REREAD_RETRY_MS);
    };
    const tick = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    const wait = Math.max(0, new Date(expiresAt).getTime() - Date.now()) + EXPIRY_SLACK_MS;
    const stop = window.setTimeout(fire, wait);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(stop);
      if (retry !== undefined) window.clearTimeout(retry);
    };
  }, [expiresAt]);
  return { now, pastEnd };
}

function Banner({
  grant,
  now,
  onChanged,
}: {
  readonly grant: BreakGlassGrantDto;
  readonly now: number;
  readonly onChanged: () => void;
}): JSX.Element {
  const actions = useBreakGlassActions();
  const online = useOnlineStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const left = Math.max(0, Math.ceil((new Date(grant.expiresAt).getTime() - now) / MINUTE_MS));
  const endNow = async (): Promise<void> => {
    if (busy || !online) return;
    setBusy(true);
    setError(null);
    const result = await actions.end(grant.id);
    setBusy(false);
    // Ended, already ended (409) or gone (404): all mean the access is over, so re-read instead of reporting a failure.
    if (result.kind === "ok" || result.kind === "not_available" || result.kind === "conflict") {
      onChanged();
    } else setError(W.END_FAILED);
  };
  return (
    <div className="wx-break-glass-banner">
      <output className="wx-break-glass-banner-text">
        {W.BANNER_ENDS(formatClock(grant.expiresAt))}
      </output>
      <span className="wx-break-glass-countdown">{W.minutesLeft(left)}</span>
      <Button
        type="button"
        tone="secondary"
        size="sm"
        disabled={busy || !online}
        onClick={() => void endNow()}
      >
        {busy ? W.ENDING : W.END_NOW}
      </Button>
      {error ? (
        <span className="wx-break-glass-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function ReadOnlyMessages({
  channelId,
  onEnded,
}: {
  readonly channelId: string;
  readonly onEnded: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loading = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const load = useCallback(
    async (before?: string): Promise<void> => {
      if (loading.current) return; // one read at a time: a double click must not fetch (and append) the same page twice
      loading.current = true;
      if (before) setLoadingOlder(true);
      try {
        const { data, response } = await client.GET("/api/v1/messaging/channels/{id}/messages", {
          params: {
            path: { id: channelId },
            query: {
              direction: "backward",
              limit: PAGE_SIZE,
              ...(before ? { cursor: before } : {}),
            },
          },
          headers: BACKGROUND_REQUEST_HEADERS,
        });
        if (!alive.current) return;
        if (!data) {
          // 403/404: the grant ended between the banner and this read. Re-read the grants and fall back.
          if (response?.status === 403 || response?.status === 404) onEnded();
          else setFailed(true);
          return;
        }
        setFailed(false);
        const page = data.messages as unknown as Message[];
        setMessages((current) => {
          if (!(before && current)) return page;
          const have = new Set(current.map((m) => m.messageId));
          return [...page.filter((m) => !have.has(m.messageId)), ...current];
        });
        setCursor(data.nextCursor ?? undefined);
      } catch {
        if (alive.current) setFailed(true);
      } finally {
        loading.current = false;
        if (alive.current) setLoadingOlder(false);
      }
    },
    [client, channelId, onEnded],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (failed && messages === null) {
    return (
      <p className="wx-break-glass-error" role="alert">
        {W.CONVERSATION_LOAD_FAILED}{" "}
        <Button type="button" tone="secondary" size="sm" onClick={() => void load()}>
          {W.RETRY_LABEL}
        </Button>
      </p>
    );
  }
  if (messages === null) return <LoadingSpinner />;
  return (
    <>
      {cursor ? (
        <Button
          type="button"
          tone="secondary"
          size="sm"
          disabled={loadingOlder}
          onClick={() => void load(cursor)}
        >
          {W.LOAD_OLDER}
        </Button>
      ) : null}
      {messages.length === 0 ? (
        <p className="wx-break-glass-detail">{W.NO_MESSAGES}</p>
      ) : (
        <ol className="wx-break-glass-messages" aria-label={W.READ_ONLY_NOTICE}>
          {messages.map((m) => (
            <li key={m.messageId} className="wx-break-glass-message">
              <span className="wx-break-glass-author">{m.authorDisplayName ?? "Staff member"}</span>{" "}
              <time className="wx-break-glass-detail" dateTime={m.createdAt}>
                {formatTime(m.createdAt)}
              </time>
              <p>{m.bodyUnreadable ? "This message cannot be shown." : m.body}</p>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function ReadOnlyConversation({
  grant,
  onChanged,
}: {
  readonly grant: BreakGlassGrantDto;
  readonly onChanged: () => void;
}): JSX.Element {
  const { now, pastEnd } = useGrantClock(grant.expiresAt, onChanged);
  // Past the server's own end instant the view is over, whatever a re-read says until it catches up (fail closed on a skewed clock).
  if (pastEnd) return <p className="wx-break-glass-detail">{W.EXPIRED_NOTICE}</p>;
  return (
    <section
      className="wx-break-glass-conversation"
      aria-label={channelKindLabel(grant.channelKind as never)}
    >
      <Banner grant={grant} now={now} onChanged={onChanged} />
      <p className="wx-break-glass-detail">{W.READ_ONLY_NOTICE}</p>
      <ReadOnlyMessages channelId={grant.channelId} onEnded={onChanged} />
    </section>
  );
}

/** Shown in place of the conversation pane for a requested channel that is not in the person's list. */
export function BreakGlassPane({
  channelId,
  onRefreshChannels,
}: {
  readonly channelId: string;
  /** The person turned out to be a member: re-read the channel list so the conversation opens. */
  readonly onRefreshChannels?: () => void;
}): JSX.Element {
  const { view, reload } = useMyGrants();
  const hadGrant = useRef(false);
  const [member, setMember] = useState(false);
  const active =
    view.status === "ready"
      ? view.data.find((g) => g.channelId === channelId && g.status === "active")
      : undefined;
  if (active) hadGrant.current = true;
  const note = member ? W.NOT_NEEDED_TEXT : hadGrant.current && !active ? W.EXPIRED_NOTICE : "";
  return (
    <div className="wx-break-glass-unavailable">
      {/* One persistent live region, mounted before any text lands in it, so the polite announcement is actually spoken. */}
      <output className="wx-break-glass-detail">{note}</output>
      {active ? (
        <ReadOnlyConversation key={active.id} grant={active} onChanged={reload} />
      ) : (
        <>
          <EmptyState
            title="This conversation is not available."
            description="Choose another conversation from the inbox."
          />
          <BreakGlassRequest
            channelId={channelId}
            onOpened={reload}
            onNotNeeded={() => {
              setMember(true);
              onRefreshChannels?.();
            }}
          />
        </>
      )}
    </div>
  );
}
