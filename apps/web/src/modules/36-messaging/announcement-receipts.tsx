// M36 WP 2.9 — the sender's view of who has read an announcement. Opened from a message in the announcement channel
// by a holder of messaging.announce; the server refuses everyone else (403), so a client that shows the button to the
// wrong person still learns nothing.
import { Button, LoadingSpinner, Modal, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
  REQUIRE_DONE,
  REQUIRE_FAILED,
  REQUIRE_HINT,
  REQUIRE_LABEL,
  REQUIRE_OFF,
} from "./ack-broadcast-wording";
import { apiErrorMessage } from "./messaging-utils";
import "./announcements.css";

interface Person {
  userId: string;
  displayName: string;
}
interface Reader extends Person {
  readAt: string;
}
interface Receipts {
  recipientCount: number;
  readCount: number;
  readers: Reader[];
  unread: Person[];
  truncated: boolean;
}

const READ_AT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A read time the browser cannot parse renders as nothing rather than throwing out of the whole list. */
function formatReadAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : READ_AT.format(date);
}

export function AnnouncementReceiptsDialog({
  messageId,
  onClose,
}: {
  messageId: string | null;
  onClose: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [receipts, setReceipts] = useState<Receipts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);

  useEffect(() => {
    const attempt = ++sequence.current;
    setReceipts(null);
    setError(null);
    if (!messageId || retry < 0) return;
    void client
      .GET("/api/v1/messaging/announcements/{messageId}/receipts", {
        params: { path: { messageId } },
      })
      .then(({ data, error: failure }) => {
        if (attempt !== sequence.current) return;
        if (failure || !data) {
          setError(apiErrorMessage(failure, "Read receipts could not be loaded."));
          return;
        }
        setReceipts(data);
      })
      .catch(() => {
        if (attempt === sequence.current) setError("Read receipts could not be loaded.");
      });
    return () => {
      sequence.current += 1;
    };
  }, [client, messageId, retry]);

  return (
    <Modal
      open={messageId !== null}
      onClose={onClose}
      ariaLabel="Announcement read receipts"
      width="34rem"
    >
      <div className="wx-new-conversation wx-announcement-receipts">
        <header>
          <h2>Read receipts</h2>
          <p>
            A receipt only means the message was opened. It does not show that it was understood or
            agreed to.
          </p>
        </header>
        {error ? (
          <div role="alert" className="wx-conversation-picker-state">
            <span>{error}</span>
            <Button size="sm" tone="secondary" onClick={() => setRetry((value) => value + 1)}>
              Retry
            </Button>
          </div>
        ) : receipts === null ? (
          <output className="wx-conversation-picker-state">
            <LoadingSpinner label="Loading read receipts" />
          </output>
        ) : (
          <ReceiptLists receipts={receipts} />
        )}
        <RequireAcknowledgment messageId={messageId} />
        <footer>
          <Button tone="secondary" onClick={onClose}>
            Close
          </Button>
        </footer>
      </div>
    </Modal>
  );
}

type RequireState = "idle" | "busy" | "done" | "off" | "failed";

/**
 * WP 6.8 (ADR-0097): the author asks everyone to acknowledge this announcement. An explicit action with its audience said first; the
 * server answers 404 while the tenant flag is off and for anyone but the author, and the words say which is the likelier cause.
 */
function RequireAcknowledgment({ messageId }: { messageId: string | null }): JSX.Element | null {
  const client = useApiClient();
  const [state, setState] = useState<RequireState>("idle");
  useEffect(() => setState("idle"), [messageId]);
  if (!messageId) return null;
  const run = (): void => {
    setState("busy");
    void client
      .POST("/api/v1/messaging/announcements/{messageId}/ack-broadcast", {
        params: { path: { messageId } },
      })
      .then(({ data, response }) =>
        setState(data ? "done" : response?.status === 404 ? "off" : "failed"),
      )
      .catch(() => setState("failed"));
  };
  return (
    <section aria-label={REQUIRE_LABEL} className="wx-announcement-require">
      <p className="wx-announcement-empty">{REQUIRE_HINT}</p>
      {state === "done" ? <p role="status">{REQUIRE_DONE}</p> : null}
      {state === "off" ? <p role="alert">{REQUIRE_OFF}</p> : null}
      {state === "failed" ? <p role="alert">{REQUIRE_FAILED}</p> : null}
      <Button tone="secondary" size="sm" disabled={state === "busy" || state === "done"} onClick={run}>
        {REQUIRE_LABEL}
      </Button>
    </section>
  );
}

function ReceiptLists({ receipts }: { receipts: Receipts }): JSX.Element {
  return (
    <>
      <p className="wx-announcement-summary" aria-live="polite">
        <strong>
          Read by {receipts.readCount} of {receipts.recipientCount}
        </strong>
        {receipts.recipientCount > 0 ? (
          <progress value={receipts.readCount} max={receipts.recipientCount} aria-hidden="true" />
        ) : null}
      </p>
      <section aria-labelledby="announcement-read-heading">
        <h3 id="announcement-read-heading">Read ({receipts.readCount})</h3>
        {receipts.readers.length === 0 ? (
          <p className="wx-announcement-empty">Nobody has read this yet.</p>
        ) : (
          <ul>
            {receipts.readers.map((person) => (
              <li key={person.userId}>
                <span>{person.displayName}</span>
                <time dateTime={person.readAt}>{formatReadAt(person.readAt)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="announcement-unread-heading">
        <h3 id="announcement-unread-heading">Not read yet ({receipts.unread.length})</h3>
        {receipts.unread.length === 0 ? (
          <p className="wx-announcement-empty">Everyone has read this.</p>
        ) : (
          <ul>
            {receipts.unread.map((person) => (
              <li key={person.userId}>
                <span>{person.displayName}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {receipts.truncated ? (
        <p className="wx-announcement-empty">Lists show the first 500 people each.</p>
      ) : null}
    </>
  );
}

/** Which announcement's receipts are open, and the dialog to render for it. */
export function useAnnouncementReceipts(): {
  open: (messageId: string) => void;
  dialog: JSX.Element;
} {
  const [messageId, setMessageId] = useState<string | null>(null);
  const close = useCallback(() => setMessageId(null), []);
  return {
    open: setMessageId,
    dialog: <AnnouncementReceiptsDialog messageId={messageId} onClose={close} />,
  };
}
