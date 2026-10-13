import { Button, InlineAlert, TextAreaField, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Secure messaging (`/p/:patientId/messages`). M36 owns the message store; M31 is only
// the renderer + composer. This surface resolves the caregiver's channel (GET /portal/messages/channel) and
// posts new messages (POST /portal/messages/send) — the thread history streams from M36's channel, not from
// a portal-owned table, which is why there is no message list endpoint here to poll.
import { useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { readError } from "./portal-format";
import { PortalCard, PortalLoadState, PortalPage } from "./portal-page";

interface Channel {
  channelId: string;
  lastReadPointer: string | null;
}

export function PortalMessages(): JSX.Element {
  const client = useApiClient();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sendState, setSendState] = useState<{ tone: "ok" | "err"; msg: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    void loadAttempt;
    let active = true;
    void (async () => {
      setLoading(true);
      setError(null);
      const res = await client.GET("/api/v1/portal/messages/channel", {});
      if (!active) return;
      if (res.error) setError(readError(res.response?.status));
      else setChannel((res.data as Channel) ?? null);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, loadAttempt]);

  async function send(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSendState(null);
    setSending(true);
    const res = await client.POST("/api/v1/portal/messages/send", { body: { body: draft } });
    setSending(false);
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
        onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
      >
        <PortalCard heading="New message">
          <form className="wx-portal-form" onSubmit={(e) => void send(e)}>
            <TextAreaField
              id="portal-msg"
              label="Write to your care team"
              hint="Do not use portal messages for urgent concerns."
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              required
              placeholder="Type your message…"
            />
            <Button type="submit" loading={sending} disabled={draft.trim().length === 0}>
              Send message
            </Button>
            {sendState ? (
              <InlineAlert tone={sendState.tone === "err" ? "error" : "success"}>
                {sendState.msg}
              </InlineAlert>
            ) : null}
          </form>
          <p className="wx-portal-supporting-copy">
            Conversation history opens in your secure inbox. Replies from your team appear there.
          </p>
        </PortalCard>
      </PortalLoadState>
    </PortalPage>
  );
}
