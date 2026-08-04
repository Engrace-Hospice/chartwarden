import { t, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Secure messaging (`/p/:patientId/messages`). M36 owns the message store; M31 is only
// the renderer + composer. This surface resolves the caregiver's channel (GET /portal/messages/channel) and
// posts new messages (POST /portal/messages/send) — the thread history streams from M36's channel, not from
// a portal-owned table, which is why there is no message list endpoint here to poll.
import { useEffect, useState } from "react";
import type { CSSProperties, FormEvent, JSX } from "react";
import { readError } from "./portal-format";
import { PortalCard, PortalLoadState, PortalPage } from "./portal-page";

interface Channel {
  channelId: string;
  lastReadPointer: string | null;
}

const composer: CSSProperties = {
  width: "100%",
  minHeight: "5rem",
  padding: "0.6rem 0.7rem",
  borderRadius: "0.5rem",
  border: `1px solid ${t.surfaceContainer}`,
  background: t.surfaceLowest,
  color: t.onSurface,
  fontSize: "0.95rem",
  resize: "vertical",
};
const primaryBtn: CSSProperties = {
  padding: "0.55rem 0.9rem",
  borderRadius: "0.5rem",
  border: "none",
  background: t.primary,
  color: t.onPrimary,
  fontWeight: 600,
  cursor: "pointer",
};

export function PortalMessages(): JSX.Element {
  const client = useApiClient();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sendState, setSendState] = useState<{ tone: "ok" | "err"; msg: string } | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      const res = await client.GET("/api/v1/portal/messages/channel", {});
      if (!active) return;
      if (res.error) setError(readError(res.response?.status));
      else setChannel((res.data as Channel) ?? null);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  async function send(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSendState(null);
    const res = await client.POST("/api/v1/portal/messages/send", { body: { body: draft } });
    if (res.error) {
      setSendState({ tone: "err", msg: readError(res.response?.status) });
      return;
    }
    setSendState({ tone: "ok", msg: "Message sent to your care team." });
    setDraft("");
  }

  return (
    <PortalPage title="Messages" subtitle="A private line to your care team. Not for emergencies.">
      <PortalLoadState
        loading={loading}
        error={error}
        empty={!channel}
        emptyTitle="Messaging not available"
        emptyDescription="Secure messaging hasn't been set up for this account yet."
      >
        <PortalCard heading="New message">
          <form onSubmit={(e) => void send(e)}>
            <label
              htmlFor="portal-msg"
              style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.35rem" }}
            >
              Write to your care team
            </label>
            <textarea
              id="portal-msg"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              required
              style={composer}
              placeholder="Type your message…"
            />
            <div style={{ marginTop: "0.75rem" }}>
              <button type="submit" style={primaryBtn} disabled={draft.trim().length === 0}>
                Send
              </button>
            </div>
            {sendState ? (
              <p
                role={sendState.tone === "err" ? "alert" : "status"}
                style={{
                  margin: "0.6rem 0 0",
                  fontSize: "0.85rem",
                  color: sendState.tone === "err" ? t.error : t.success,
                }}
              >
                {sendState.msg}
              </p>
            ) : null}
          </form>
          <p style={{ margin: "0.9rem 0 0", fontSize: "0.78rem", color: t.onSurfaceVariant }}>
            Conversation history opens in your secure inbox. Replies from your team appear there.
          </p>
        </PortalCard>
      </PortalLoadState>
    </PortalPage>
  );
}
