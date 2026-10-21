// apps/web/src/modules/06-admission/records-request-fax-action.tsx — F-238: "Send by fax" for one records
// request, and the state of its latest fax (sent / failed / sending). Rendered in the request's actions cell
// by referral-records-requests.tsx; owns its own state so the list's other actions stay untouched.
//
// The fax number is prefilled from the request's own recipient fax (the referral itself carries no fax
// number — only the referrer's phone). The server normalises NANP / E.164 and refuses anything undialable;
// the send is idempotent per request, so once a fax is sent the action is replaced by its status.
import { Button, useApiClient } from "@chartwarden/ui";
import type { CSSProperties, JSX } from "react";
import { useEffect, useState } from "react";
import {
  type RecordsRequest,
  type RecordsRequestFax,
  displayFaxNumber,
  sendRecordsRequestFax,
} from "./records-requests-api";

/** Statuses a request may be faxed in (an expired request is re-opened first). */
const FAXABLE: ReadonlySet<RecordsRequest["status"]> = new Set(["requested", "partially_received"]);

const usDate = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
};

export function RecordsRequestFaxAction({
  referralId,
  request,
}: {
  referralId: string;
  request: RecordsRequest;
}): JSX.Element | null {
  const client = useApiClient();
  const [fax, setFax] = useState<RecordsRequestFax | null>(request.fax ?? null);
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState(request.recipientFax ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The list reload carries the latest fax; a row replaced by cancel / extend carries none (keep ours).
  useEffect(() => {
    if (request.fax !== undefined) setFax(request.fax);
  }, [request.fax]);

  async function send() {
    setBusy(true);
    const res = await sendRecordsRequestFax(client, referralId, request.id, number.trim());
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setError(null);
    setFax(res.value.fax);
    if (res.value.fax.status === "sent") setOpen(false);
  }

  const status = fax ? (
    <span
      style={fax.status === "failed" ? failedNote : note}
      data-testid={`fax-status-${request.id}`}
    >
      {fax.status === "sent"
        ? `Faxed ${usDate(fax.sentAt ?? fax.attemptedAt)} to ${displayFaxNumber(fax.faxNumber)}`
        : fax.status === "sending"
          ? `Fax sending to ${displayFaxNumber(fax.faxNumber)}…`
          : `Fax failed${fax.failureReason ? `: ${fax.failureReason}` : ""}`}
    </span>
  ) : null;

  const canSend =
    FAXABLE.has(request.status) && fax?.status !== "sent" && fax?.status !== "sending";
  if (!canSend) return status;

  return (
    <>
      {status}
      {open ? (
        <>
          <label style={inlineLabel}>
            Fax to
            <input
              type="tel"
              inputMode="tel"
              maxLength={40}
              value={number}
              onChange={(ev) => setNumber(ev.target.value)}
              placeholder="(503) 555-0100"
            />
          </label>
          <Button
            size="sm"
            tone="primary"
            loading={busy}
            disabled={number.trim().length < 7}
            onClick={() => void send()}
          >
            Send fax
          </Button>
          <Button
            size="sm"
            tone="tertiary"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
          >
            Keep
          </Button>
          {error ? (
            <span role="alert" style={failedNote}>
              {error}
            </span>
          ) : null}
        </>
      ) : (
        <Button size="sm" tone="secondary" onClick={() => setOpen(true)}>
          {fax?.status === "failed" ? "Retry fax" : "Send by fax"}
        </Button>
      )}
    </>
  );
}

const note: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8125rem",
  alignSelf: "center",
};
const failedNote: CSSProperties = { ...note, color: "var(--color-error)" };
const inlineLabel: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
  fontSize: "0.8125rem",
  fontWeight: 600,
};
