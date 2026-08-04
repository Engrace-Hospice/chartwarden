import { ConversationView, EmptyState, Glyph, LoadingSpinner, t, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/36-messaging — Internal Staff Secure Messaging (M36, Track A).
// Spec: docs/design/screens/core/WARDENX_UI_STAFF_MESSAGING.md — "Use Conversation View."
// Matched to the P0 Pencil frame (wardenx-P0-foundation.pen `A016Y`): a "Messages" conversation list
// (avatar + title + secondary + unread dot, active row indigo-tinted) | a thread of chat bubbles
// (mine right/indigo, others left/paper) under a header with a patient-scoped chip, over a rounded
// composer. Backed by GET /messaging/channels, GET/POST /messaging/channels/:id/messages. The list's
// last-message preview/time isn't exposed by the channels read yet, so the secondary line shows the
// channel's real scope (patient-scoped / kind) rather than a fabricated preview.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { authClient } from "../02-identity/auth-client";

interface ChannelSummary {
  channelId: string;
  kind: string;
  title: string | null;
  subjectId: string | null;
  archivedAt: string | null;
  unreadCount: number;
}
interface Message {
  messageId: string;
  channelId: string;
  authorUserId: string | null;
  body: string;
  bodyKind: string;
  createdAt: string;
  parentMessageId: string | null;
}

const channelLabel = (c: ChannelSummary): string => c.title ?? c.kind.replace(/_/g, " ");
const channelScope = (c: ChannelSummary): string =>
  c.subjectId
    ? "Patient-scoped"
    : c.kind.replace(/_/g, " ").replace(/\b\w/g, (x) => x.toUpperCase());
function initialsOf(s: string): string {
  const w = s.split(/[\s,_]+/).filter(Boolean);
  return (
    w
      .slice(0, 2)
      .map((x) => x[0]?.toUpperCase() ?? "")
      .join("") || "·"
  ).slice(0, 2);
}
function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export function StaffMessaging(): JSX.Element {
  const client = useApiClient();
  const [channels, setChannels] = useState<ChannelSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [meId, setMeId] = useState<string | null>(null);

  useEffect(() => {
    void authClient.getSession().then(({ data }) => setMeId(data?.user?.id ?? null));
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error: err } = await client.GET("/api/v1/messaging/channels");
      if (!active) return;
      if (err) return setError("Could not load channels.");
      const list = (data?.channels ?? []) as ChannelSummary[];
      setChannels(list);
      setActiveId((prev) => prev ?? list[0]?.channelId ?? null);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (channels === null) return <LoadingSpinner />;

  const activeChannel = channels.find((c) => c.channelId === activeId) ?? null;

  return (
    <ConversationView
      list={<ChannelList channels={channels} activeId={activeId} onSelect={setActiveId} />}
    >
      {activeChannel ? (
        <Thread channel={activeChannel} meId={meId} />
      ) : (
        <EmptyState
          title="No channel selected"
          description="Pick a channel to view its messages."
        />
      )}
    </ConversationView>
  );
}

function ChannelList({
  channels,
  activeId,
  onSelect,
}: {
  channels: ChannelSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <div>
      {/* List header — "Messages" (Fraunces) + a compose affordance, per the frame. */}
      <div style={listHeader}>
        <span style={{ fontFamily: t.fontDisplay, fontWeight: 500, fontSize: "1.05rem" }}>
          Messages
        </span>
        <span style={{ color: t.primary, display: "inline-flex" }} title="New message">
          <Glyph name="sparkle" size={18} />
        </span>
      </div>
      {channels.length === 0 ? (
        <EmptyState title="No channels" description="You’re not a member of any channel yet." />
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {channels.map((c) => {
            const active = c.channelId === activeId;
            return (
              <li key={c.channelId}>
                <button
                  type="button"
                  onClick={() => onSelect(c.channelId)}
                  style={{ ...convRow, background: active ? t.primaryTint : "transparent" }}
                >
                  <span style={listAvatar} aria-hidden>
                    {initialsOf(channelLabel(c))}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.1rem",
                    }}
                  >
                    <span style={convTitle}>{channelLabel(c)}</span>
                    <span style={convPreview}>{channelScope(c)}</span>
                  </span>
                  {c.unreadCount > 0 ? (
                    <span style={unreadDot} aria-label={`${c.unreadCount} unread`} />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Thread({ channel, meId }: { channel: ChannelSummary; meId: string | null }): JSX.Element {
  const client = useApiClient();
  const channelId = channel.channelId;
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    const { data } = await client.GET("/api/v1/messaging/channels/{id}/messages", {
      params: { path: { id: channelId }, query: { limit: 50 } },
    });
    setMessages((data?.messages ?? []) as Message[]);
  }, [client, channelId]);

  useEffect(() => {
    setMessages(null);
    void load();
  }, [load]);

  async function send(): Promise<void> {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    const { error } = await client.POST("/api/v1/messaging/channels/{id}/messages", {
      params: { path: { id: channelId } },
      body: { body },
    });
    setSending(false);
    if (!error) {
      setDraft("");
      void load();
    }
  }

  return (
    <>
      {/* Thread header — title + the patient-scoped chip (indigo) when the channel is patient-bound. */}
      <div style={threadHeader}>
        <span style={{ fontWeight: 600, color: t.onSurface }}>{channelLabel(channel)}</span>
        {channel.subjectId ? (
          <span style={scopeChip}>
            <Glyph name="shield" size={13} />
            Patient-scoped
          </span>
        ) : null}
      </div>

      <div style={messagesArea}>
        {messages === null ? (
          <LoadingSpinner />
        ) : messages.length === 0 ? (
          <EmptyState title="No messages" description="Start the conversation below." />
        ) : (
          messages.map((m) => {
            const mine = m.authorUserId != null && m.authorUserId === meId;
            const system = m.authorUserId == null;
            if (system) {
              return (
                <div key={m.messageId} style={{ textAlign: "center" }}>
                  <span style={systemNote}>{m.body}</span>
                </div>
              );
            }
            return (
              <div
                key={m.messageId}
                style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start" }}
              >
                <div style={mine ? bubbleMine : bubbleTheirs}>
                  <span style={{ whiteSpace: "pre-wrap" }}>{m.body}</span>
                  <span
                    style={{
                      ...bubbleMeta,
                      color: mine
                        ? `color-mix(in srgb, ${t.onEmphasis} 75%, transparent)`
                        : t.muted,
                    }}
                  >
                    {mine ? (
                      "You"
                    ) : (
                      <span className="wx-data-md">{m.authorUserId?.slice(0, 8)}</span>
                    )}{" "}
                    · {relTime(m.createdAt)}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div style={composer}>
        <input
          aria-label="Message"
          placeholder={`Message ${channelLabel(channel)}…`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
          style={composerInput}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || !draft.trim()}
          style={sendBtn}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </>
  );
}

const listHeader = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "1rem",
} as const;
const convRow = {
  display: "flex",
  alignItems: "center",
  gap: "0.625rem",
  width: "100%",
  textAlign: "left" as const,
  border: "none",
  cursor: "pointer",
  padding: "0.75rem 1rem",
} as const;
const listAvatar = {
  width: "2.375rem",
  height: "2.375rem",
  flexShrink: 0,
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurfaceVariant,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: t.fontDisplay,
  fontWeight: 600,
  fontSize: "0.8rem",
} as const;
const convTitle = {
  fontWeight: 600,
  fontSize: "0.8125rem",
  color: t.onSurface,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
} as const;
const convPreview = {
  fontSize: "0.75rem",
  color: t.muted,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
} as const;
const unreadDot = {
  width: "0.5rem",
  height: "0.5rem",
  flexShrink: 0,
  borderRadius: "9999px",
  background: t.primary,
} as const;
const threadHeader = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.875rem 1.5rem",
  borderBottom: `1px solid color-mix(in srgb, ${t.outlineVariant} 35%, transparent)`,
  background: t.surfaceLowest,
} as const;
const scopeChip = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  fontSize: "0.75rem",
  fontWeight: 600,
  color: t.primary,
  background: t.primaryTint,
  borderRadius: "9999px",
  padding: "0.15rem 0.55rem",
} as const;
const messagesArea = {
  flex: 1,
  overflow: "auto",
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.875rem",
  background: t.background,
} as const;
const bubbleBase = {
  maxWidth: "70%",
  padding: "0.625rem 0.875rem",
  fontSize: "0.875rem",
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.25rem",
} as const;
const bubbleTheirs = {
  ...bubbleBase,
  background: t.surfaceLow,
  color: t.onSurface,
  borderRadius: "16px 16px 16px 4px",
} as const;
const bubbleMine = {
  ...bubbleBase,
  background: t.primary,
  color: t.onPrimary,
  borderRadius: "16px 16px 4px 16px",
} as const;
const bubbleMeta = { fontSize: "0.6875rem" } as const;
const systemNote = { fontSize: "0.75rem", color: t.muted } as const;
const composer = {
  display: "flex",
  alignItems: "center",
  gap: "0.625rem",
  padding: "1rem 1.5rem",
  borderTop: `1px solid color-mix(in srgb, ${t.outlineVariant} 35%, transparent)`,
  background: t.surfaceLowest,
} as const;
const composerInput = {
  flex: 1,
  minWidth: 0,
  padding: "0.65rem 1rem",
  border: "none",
  borderRadius: "9999px",
  background: t.surfaceLow,
  outline: "none",
  fontSize: "0.9rem",
  color: t.onSurface,
} as const;
const sendBtn = {
  padding: "0.55rem 1.25rem",
  border: "none",
  borderRadius: "9999px",
  background: t.primary,
  color: t.onPrimary,
  fontWeight: 600,
  cursor: "pointer",
} as const;
