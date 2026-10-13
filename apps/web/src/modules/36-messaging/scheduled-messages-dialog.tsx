// M36 WP 2.6 — "Scheduled": the sender's own queue of messages waiting to go out, with the ones that were blocked at
// dispatch shown with their reason. States: loading, error (Retry), empty, list. Org and user are server-side; this only
// ever receives the caller's own rows.
import { Button, LoadingSpinner, Modal, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { apiErrorMessage } from "./messaging-utils";
import { ScheduledMessageRow } from "./scheduled-message-row";
import type { ScheduledMessageItem } from "./scheduled-send-types";
import "./scheduled-send.css";

const LOAD_FAILED = "Scheduled messages could not be loaded.";

export function ScheduledMessagesDialog({
  open,
  onClose,
  channelName,
}: {
  open: boolean;
  onClose: () => void;
  /** The display name of a conversation by id (the inbox already holds them). */
  channelName: (channelId: string) => string;
}): JSX.Element | null {
  const client = useApiClient();
  const [items, setItems] = useState<ScheduledMessageItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const attempt = ++sequence.current;
    setItems(null);
    setError(null);
    try {
      const { data, error: failure } = await client.GET("/api/v1/messaging/scheduled-messages", {
        params: { query: {} },
      });
      if (attempt !== sequence.current) return;
      if (failure || !data) {
        setError(apiErrorMessage(failure, LOAD_FAILED));
        return;
      }
      setItems([...data.scheduledMessages]);
    } catch {
      if (attempt === sequence.current) setError(LOAD_FAILED);
    }
  }, [client]);

  useEffect(() => {
    if (!open) return;
    void load();
    return () => {
      sequence.current += 1;
    };
  }, [open, load]);

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Scheduled messages" width="36rem">
      <div className="wx-scheduled-dialog">
        <header>
          <h2>Scheduled</h2>
          <p>
            Messages waiting to be sent. Each one is checked again when it is due: if you can no
            longer send to that conversation, it is not sent and you are told here.
          </p>
        </header>
        {error ? (
          <div role="alert" className="wx-messaging-error">
            <span>{error}</span>
            <Button size="sm" tone="secondary" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : items === null ? (
          <div className="wx-conversation-picker-state">
            <LoadingSpinner label="Loading scheduled messages" />
          </div>
        ) : items.length === 0 ? (
          <p className="wx-scheduled-empty">Nothing is scheduled.</p>
        ) : (
          <ul className="wx-scheduled-list" aria-label="Scheduled messages">
            {items.map((item) => (
              <ScheduledMessageRow
                key={item.id}
                item={item}
                channelLabel={channelName(item.channelId)}
                onCancelled={(id) =>
                  setItems((current) => current?.filter((i) => i.id !== id) ?? null)
                }
                onRescheduled={(next) =>
                  setItems(
                    (current) =>
                      current
                        ?.map((i) => (i.id === next.id ? next : i))
                        .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor)) ?? null,
                  )
                }
              />
            ))}
          </ul>
        )}
        <footer>
          <Button tone="secondary" onClick={onClose}>
            Close
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
