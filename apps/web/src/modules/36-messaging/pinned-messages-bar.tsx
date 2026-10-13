// WP 2.4: the channel's pinned messages, one collapsed line above the timeline. Each entry jumps to the message in the
// conversation (the same jump the thread links use). Re-read when this tab pins/unpins, and when the pinned flags of the
// loaded messages change (that is how another member's pin or unpin arrives, through the normal list refresh), so the
// audited pin-list read is not repeated on every hint.
import { useApiClient } from "@wardenx/ui";
import { useEffect, useId, useState } from "react";
import type { JSX } from "react";
import type { Message } from "./messaging-types";
import { onPinsChanged } from "./pin-events";
import "./message-annotations.css";

const PREVIEW_CHARS = 110;

function preview(message: Message): string {
  const text = message.body.replace(/\s+/g, " ").trim();
  if (!text) return "Attachment";
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}

interface PinnedMessagesBarProps {
  readonly channelId: string;
  /** The loaded messages: only their pinned flags are read, to notice a pin change made elsewhere. */
  readonly messages: readonly Message[] | null;
  readonly onJump: (messageId: string) => void;
}

export function PinnedMessagesBar({
  channelId,
  messages,
  onJump,
}: PinnedMessagesBarProps): JSX.Element | null {
  const client = useApiClient();
  const listId = useId();
  const [pins, setPins] = useState<readonly Message[]>([]);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const signature = (messages ?? [])
    .filter((message) => message.pinned)
    .map((message) => message.messageId)
    .join(",");

  useEffect(() => onPinsChanged(channelId, () => setVersion((v) => v + 1)), [channelId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` and `version` are the re-read triggers
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const { data, error } = await client.GET("/api/v1/messaging/channels/{id}/pins", {
          params: { path: { id: channelId } },
        });
        if (!current) return;
        if (error || !data) {
          setFailed(true);
          return;
        }
        setPins((data.pins ?? []) as Message[]);
        setFailed(false);
      } catch {
        if (current) setFailed(true);
      }
    })();
    return () => {
      current = false;
    };
  }, [client, channelId, signature, version]);

  if (failed) {
    return (
      <output className="wx-pinned-bar wx-pinned-bar-error">
        Pinned messages could not be loaded.
      </output>
    );
  }
  if (pins.length === 0) return null;

  return (
    <nav className="wx-pinned-bar" aria-label="Pinned messages">
      <button
        type="button"
        className="wx-pinned-bar-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        Pinned messages ({pins.length})
      </button>
      {open ? (
        <ul id={listId} className="wx-pinned-bar-list">
          {pins.map((pin) => (
            <li key={pin.messageId}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onJump(pin.messageId);
                }}
              >
                <strong>{pin.authorDisplayName || "Staff member"}</strong>
                <span>{preview(pin)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </nav>
  );
}
