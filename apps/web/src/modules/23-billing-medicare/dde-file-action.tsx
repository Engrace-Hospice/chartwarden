import { Button, InlineAlert, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/23-billing-medicare — one-click "File in DDE" on a claim or NOE/NOTR (ADR-0052, #766).
// FISS-side work (adjust or cancel a paid claim, fix a returned claim, key or correct a notice) has no electronic
// signal, so the biller queues it here with one click: POST /api/v1/billing/dde-items {itemType, subjectId}. The
// server resolves provider entity / patient / deadline from the subject and refuses a second open item of the same
// type (409). Nothing is sent to FISS (D2); the item lands in the DDE queue for a person to key.
import { useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";

export type DdeFileItemType = "rtp_correction" | "adjustment" | "cancel" | "noe" | "notr";

export interface DdeFileOption {
  itemType: DdeFileItemType;
  label: string;
  hint: string;
}

const RTP: DdeFileOption = {
  itemType: "rtp_correction",
  label: "Correct returned claim",
  hint: "Medicare returned it to the provider (status T); fix and resubmit in DDE.",
};
const ADJUST: DdeFileOption = {
  itemType: "adjustment",
  label: "Adjust claim",
  hint: "Change a claim Medicare already processed (TOB xx7).",
};
const CANCEL: DdeFileOption = {
  itemType: "cancel",
  label: "Cancel claim",
  hint: "Cancel a claim Medicare already processed (TOB xx8).",
};

const PROCESSED = new Set(["ack_accepted", "ack_partial", "paid", "partial_paid", "denied"]);
const FILED = new Set(["submitted", "ack_pending", "ack_rejected", ...PROCESSED]);

/** Which DDE items make sense for a claim in this state (the server still re-validates). */
export function claimDdeOptions(state: string): DdeFileOption[] {
  if (!FILED.has(state)) return [];
  return PROCESSED.has(state) ? [ADJUST, CANCEL, RTP] : [RTP];
}

/** A notice that is not yet accepted or cancelled can be keyed (or re-keyed) in DDE. */
export function noticeDdeOptions(kind: "noe" | "notr", state: string): DdeFileOption[] {
  if (state === "ack_accepted" || state === "cancelled") return [];
  const acronym = kind.toUpperCase();
  return [
    {
      itemType: kind,
      label: `File ${acronym} in DDE`,
      hint: `Queue keying or correcting this ${acronym} in DDE (the filing window still applies).`,
    },
  ];
}

const idempotencyKey = (): string =>
  typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

function failureText(error: unknown, status: number | undefined): string {
  const message = (error as { error?: { message?: string } } | undefined)?.error?.message;
  if (status === 401 || status === 403) return "You don't have permission to queue DDE work.";
  if ((status === 409 || status === 422) && message) return message;
  if (status === 503) return "Billing is unavailable right now. Try again shortly.";
  return "The DDE item could not be queued.";
}

export function DdeFileAction({
  subjectId,
  options,
}: {
  subjectId: string;
  options: DdeFileOption[];
}): JSX.Element | null {
  const client = useApiClient();
  const [busy, setBusy] = useState<DdeFileItemType | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [filed, setFiled] = useState<string | null>(null);
  if (options.length === 0) return null;

  const file = async (option: DdeFileOption): Promise<void> => {
    if (busy) return;
    setBusy(option.itemType);
    setFailure(null);
    setFiled(null);
    try {
      const { error, response } = (await client.POST(
        "/api/v1/billing/dde-items" as never,
        {
          params: { header: { "Idempotency-Key": idempotencyKey() } },
          body: { itemType: option.itemType, subjectId },
        } as never,
      )) as { error?: unknown; response?: Response };
      if (error) setFailure(failureText(error, response?.status));
      else setFiled(option.label);
    } catch {
      setFailure("The DDE item could not be queued. Check your connection.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="wx-drawer-card" aria-label="File in DDE">
      <h3>File in DDE</h3>
      <p className="wx-row-sub">
        Queues the work for a biller to key in Medicare DDE. Nothing is sent from here.
      </p>
      {failure ? <InlineAlert>{failure}</InlineAlert> : null}
      {filed ? (
        <InlineAlert tone="success">
          Queued: {filed}. <Link to="/billing/dde">Open the DDE queue</Link>.
        </InlineAlert>
      ) : null}
      <div className="wx-action-row">
        {options.map((o) => (
          <Button
            key={o.itemType}
            title={o.hint}
            loading={busy === o.itemType}
            disabled={busy !== null}
            onClick={() => void file(o)}
          >
            {o.label}
          </Button>
        ))}
      </div>
    </section>
  );
}
