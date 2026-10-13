// M36 WP 2.11 phase 4 — archive / unarchive of a department channel, offered inside the members dialog to an org
// admin. Importers: channel-members-dialog.tsx. API: POST /channels/{id}/archive | unarchive (204; 409 for a kind that
// is not archivable, 403 for a non-admin). The status line is always mounted so a screen reader hears each outcome.
import { Button, useApiClient } from "@wardenx/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
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
  /** Called after the server accepted the change; the control stays busy until the returned refetch settles. */
  onChanged: () => void | Promise<void>;
}

export function ChannelArchiveControl({
  channelId,
  archived,
  onChanged,
}: ArchiveControlProps): JSX.Element {
  const client = useApiClient();
  // The verb flips at once on success (`done`), before the parent's refetch brings the new `archived` prop.
  // It is dropped once the prop moves on (`base` no longer matches), so a later change of the real state wins.
  const [done, setDone] = useState<{ verb: "archive" | "unarchive"; base: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // Not flipped while a request is in flight, so Confirm keeps its name.
  const shownArchived =
    !busy && done && done.base === archived ? done.verb === "archive" : archived;
  const verb = shownArchived ? "unarchive" : "archive";
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const wasConfirming = useRef(false);
  const sentenceId = useId();

  // Buttons unmount as the confirm opens and closes: move focus on purpose so it never falls to <body> (which would
  // break the Modal's Tab trap and Escape). Cancel is the first stop in the confirm, the safer default.
  useEffect(() => {
    if (confirming === wasConfirming.current) return;
    wasConfirming.current = confirming;
    sectionRef.current?.querySelector("button")?.focus();
  }, [confirming]);

  function openConfirm(): void {
    setStatus("");
    setFailed(false);
    setConfirming(true);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !confirming || busy) return;
    event.stopPropagation();
    setConfirming(false);
  }

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
      setDone({ verb, base: archived });
      setFailed(false);
      setStatus(verb === "archive" ? "Conversation archived." : "Conversation unarchived.");
      await onChanged();
    } catch {
      setFailed(true);
      setStatus(FAILED);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <section
      className="wx-channel-lifecycle"
      aria-label="Conversation status"
      ref={sectionRef}
      onKeyDown={onKeyDown}
    >
      {confirming ? (
        <>
          <p id={sentenceId}>
            {shownArchived
              ? "Unarchive this conversation? Members can send messages again."
              : "Archive this conversation? It stays readable but becomes read only."}
          </p>
          <div className="wx-channel-lifecycle-actions">
            <Button
              size="lg"
              tone="secondary"
              aria-disabled={busy}
              onClick={() => (busy ? undefined : setConfirming(false))}
            >
              Cancel
            </Button>
            <Button
              size="lg"
              aria-disabled={busy}
              aria-label={`Confirm ${verb}`}
              aria-describedby={sentenceId}
              onClick={() => void run()}
            >
              Confirm
            </Button>
          </div>
        </>
      ) : (
        <Button size="lg" tone="secondary" onClick={openConfirm}>
          {shownArchived ? "Unarchive conversation" : "Archive conversation"}
        </Button>
      )}
      <output className={failed ? "wx-channel-lifecycle-error" : undefined}>
        {failed && status ? `Not updated. ${status}` : status}
      </output>
    </section>
  );
}
