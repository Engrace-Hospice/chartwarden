// M36 WP 2.11 phase 4 — archive / unarchive of a department channel, offered inside the members dialog to an org
// admin. Importers: channel-members-dialog.tsx. API: POST /channels/{id}/archive | unarchive (204; 409 for a kind that
// is not archivable, 403 for a non-admin). The status line is always mounted so a screen reader hears each outcome.
import { Button, useApiClient } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import "./channel-lifecycle.css";

const REFUSALS: Readonly<Record<number, string>> = {
  409: "This kind of conversation can't be archived.",
  403: "You don't have permission to archive conversations.",
};
const FAILED = "The conversation could not be updated. Try again.";

interface ArchiveControlProps {
  channelId: string;
  archived: boolean;
  /** Called after the server accepted the change, so the inbox and thread re-read the channel. */
  onChanged: () => void;
}

export function ChannelArchiveControl({
  channelId,
  archived,
  onChanged,
}: ArchiveControlProps): JSX.Element {
  const client = useApiClient();
  const verb = archived ? "unarchive" : "archive";
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (confirming) actionsRef.current?.querySelector("button")?.focus();
  }, [confirming]);

  async function run(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setStatus("");
    try {
      const path = `/api/v1/messaging/channels/{id}/${verb}` as const;
      const { error, response } = await client.POST(path, { params: { path: { id: channelId } } });
      if (error) {
        setFailed(true);
        setStatus(REFUSALS[response?.status ?? 0] ?? FAILED);
        return;
      }
      setFailed(false);
      setStatus(archived ? "Conversation unarchived." : "Conversation archived.");
      onChanged();
    } catch {
      setFailed(true);
      setStatus(FAILED);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <section className="wx-channel-lifecycle" aria-label="Conversation status">
      {confirming ? (
        <>
          <p>
            {archived
              ? "Unarchive this conversation? Members can send messages again."
              : "Archive this conversation? It stays readable but becomes read only."}
          </p>
          <div className="wx-channel-lifecycle-actions" ref={actionsRef}>
            <Button
              size="lg"
              disabled={busy}
              aria-label={`Confirm ${verb}`}
              onClick={() => void run()}
            >
              Confirm
            </Button>
            <Button size="lg" tone="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <Button size="lg" tone="secondary" onClick={() => setConfirming(true)}>
          {archived ? "Unarchive conversation" : "Archive conversation"}
        </Button>
      )}
      <output className={failed ? "wx-channel-lifecycle-error" : undefined}>
        {failed && status ? `Not updated. ${status}` : status}
      </output>
    </section>
  );
}
