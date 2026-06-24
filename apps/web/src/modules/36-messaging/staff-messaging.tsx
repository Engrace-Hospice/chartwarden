import { ConversationView, EmptyState, LoadingSpinner, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/36-messaging — Internal Staff Secure Messaging (M36, Track A).
// Spec: docs/design/screens/core/WARDENX_UI_STAFF_MESSAGING.md — "Use Conversation View."
// Channel list | message thread + composer. Backed by GET /messaging/channels,
// GET/POST /messaging/channels/:id/messages via the generated typed client. Imports only leaves.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

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

export function StaffMessaging(): JSX.Element {
  const client = useApiClient();
  const [channels, setChannels] = useState<ChannelSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

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

  return (
    <ConversationView
      list={<ChannelList channels={channels} activeId={activeId} onSelect={setActiveId} />}
    >
      {activeId ? (
        <Thread channelId={activeId} />
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
  if (channels.length === 0)
    return <EmptyState title="No channels" description="You’re not a member of any channel yet." />;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: "0.5rem" }}>
      {channels.map((c) => (
        <li key={c.channelId}>
          <button
            type="button"
            onClick={() => onSelect(c.channelId)}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "0.5rem 0.625rem",
              border: "none",
              borderRadius: "0.375rem",
              cursor: "pointer",
              background: c.channelId === activeId ? "#eff6ff" : "transparent",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{channelLabel(c)}</span>
            {c.unreadCount > 0 ? (
              <span
                style={{
                  fontSize: "0.7rem",
                  background: "#1d4ed8",
                  color: "#fff",
                  borderRadius: "999px",
                  padding: "0 0.4rem",
                }}
              >
                {c.unreadCount}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Thread({ channelId }: { channelId: string }): JSX.Element {
  const client = useApiClient();
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
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "1rem 1.5rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
      >
        {messages === null ? (
          <LoadingSpinner />
        ) : messages.length === 0 ? (
          <EmptyState title="No messages" description="Start the conversation below." />
        ) : (
          messages.map((m) => (
            <div key={m.messageId}>
              <div style={{ fontSize: "0.7rem", color: "#6b7280" }}>
                {m.authorUserId ?? "system"} · {new Date(m.createdAt).toLocaleString()}
              </div>
              <div style={{ fontSize: "0.9rem", whiteSpace: "pre-wrap" }}>{m.body}</div>
            </div>
          ))
        )}
      </div>
      <div
        style={{
          borderTop: "1px solid #e5e7eb",
          padding: "0.75rem 1.5rem",
          display: "flex",
          gap: "0.5rem",
        }}
      >
        <input
          aria-label="Message"
          placeholder="Write a message…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
          style={{
            flex: 1,
            padding: "0.5rem 0.75rem",
            border: "1px solid #e5e7eb",
            borderRadius: "0.5rem",
          }}
        />
        <button type="button" onClick={() => void send()} disabled={sending || !draft.trim()}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </>
  );
}
