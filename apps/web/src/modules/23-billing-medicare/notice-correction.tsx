import {
  Button,
  InlineAlert,
  StatusPill,
  TextAreaField,
  TextField,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — "File corrected NOE / NOTR" on a notice Medicare rejected (CMS Pub.
// 100-04 ch. 11 §20.1.1 / §20.1.2; M23 §2.2 "corrected NOE is its own row"): the rejection (stage + reason codes)
// beside a short form — the notice date to keep or correct and why — that drafts a NEW notice linked to the
// rejected one (POST …/:id/correct). The draft then appears in the queue and is submitted like any other. Also the
// link both ways: "Corrects …" on the correction, "Corrected by …" on the rejected notice.
//
// Redesign pattern (flat drawer cards, kit fields/buttons, wx-* classes). The server is the only authorization point
// and re-validates everything (ADR-0030); a refusal is shown inline, never a toast.
import { useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { noeNotrStateTone, statusLabel } from "./billing-status";
import {
  type CorrectionDraft,
  type CorrectionLinkFields,
  correctionAvailability,
  validateCorrectionDraft,
} from "./notice-correction-model";

/** What the correction surface needs from the NOE / NOTR config. */
export interface NoticeCorrectionConfig {
  acronym: string;
  routeBase: string;
  correctPath: string;
  /** The notice-owned date the biller may fix: NOE admission date, NOTR effective end date. */
  correctableDateLabel: string;
}

export interface CorrectableNotice extends CorrectionLinkFields {
  id: string;
  /** The notice's current value of the correctable date. */
  correctableDate: string | null;
  rejectionStage?: "999" | "277ca" | "clearinghouse" | null;
  rejectionCodes?: string[];
}

const STAGE: Record<"999" | "277ca" | "clearinghouse", string> = {
  clearinghouse: "Clearinghouse edits (before Medicare)",
  "999": "999 (file syntax)",
  "277ca": "277CA (claim content)",
};

const today = (): string => new Date().toISOString().slice(0, 10);

const idempotencyKey = (): string =>
  typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

function errorText(error: unknown, status: number | undefined, acronym: string): string {
  const message = (error as { error?: { message?: string } } | undefined)?.error?.message;
  if (status === 401 || status === 403) return "You don't have permission to file this correction.";
  if (status === 409 && message) return message;
  if (status === 422 && message) return message;
  if (status === 503) return "Billing is unavailable right now. Try again shortly.";
  return `The corrected ${acronym} could not be drafted.`;
}

/** The "Corrects …" / "Corrected by …" rows. Renders nothing for a notice outside any chain. */
export function NoticeCorrectionLinks({
  notice,
  config,
}: {
  notice: CorrectableNotice;
  config: NoticeCorrectionConfig;
}): JSX.Element | null {
  const by = notice.correctedBy ?? null;
  if (!notice.correctsNoticeId && !by) return null;
  return (
    <dl className="wx-kv" aria-label={`${config.acronym} correction`}>
      {notice.correctsNoticeId ? (
        <>
          <dt>Corrects</dt>
          <dd>
            <Link className="wx-nums" to={`${config.routeBase}/${notice.correctsNoticeId}`}>
              Rejected {config.acronym} {notice.correctsNoticeId.slice(0, 8)}
            </Link>
          </dd>
          {notice.correctionReason ? (
            <>
              <dt>Why</dt>
              <dd>{notice.correctionReason}</dd>
            </>
          ) : null}
        </>
      ) : null}
      {by ? (
        <>
          <dt>Corrected by</dt>
          <dd style={{ display: "inline-flex", gap: "0.5rem", alignItems: "center" }}>
            <Link className="wx-nums" to={`${config.routeBase}/${by.noticeId}`}>
              {config.acronym} {by.noticeId.slice(0, 8)}
            </Link>
            <StatusPill label={statusLabel(by.state)} tone={noeNotrStateTone(by.state)} />
          </dd>
        </>
      ) : null}
    </dl>
  );
}

/** The "File corrected NOE / NOTR" action and form, shown on a rejected notice only. */
export function NoticeCorrectionAction({
  notice,
  config,
  onFiled,
}: {
  notice: CorrectableNotice;
  config: NoticeCorrectionConfig;
  onFiled: () => void;
}): JSX.Element | null {
  const client = useApiClient();
  const availability = correctionAvailability(notice);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<CorrectionDraft>({
    date: notice.correctableDate ?? "",
    reason: "",
  });
  const [errors, setErrors] = useState<Partial<Record<keyof CorrectionDraft, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [filedId, setFiledId] = useState<string | null>(null);

  if (availability.kind === "none") return null;
  if (filedId) {
    return (
      <InlineAlert tone="success">
        Corrected {config.acronym} drafted.{" "}
        <Link to={`${config.routeBase}/${filedId}`}>Open it to review and submit</Link>.
      </InlineAlert>
    );
  }
  if (availability.kind !== "file") {
    return (
      <InlineAlert tone="info">
        {availability.kind === "in_progress"
          ? `A corrected ${config.acronym} has already been filed for this one. `
          : `Medicare also rejected the corrected ${config.acronym}: correct that one instead. `}
        <Link to={`${config.routeBase}/${availability.noticeId}`}>Open it</Link>.
      </InlineAlert>
    );
  }

  const submit = async (): Promise<void> => {
    const found = validateCorrectionDraft(draft, today());
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const { data, error, response } = (await client.POST(
        config.correctPath as never,
        {
          params: { path: { id: notice.id }, header: { "Idempotency-Key": idempotencyKey() } },
          body: {
            reason: draft.reason.trim(),
            ...(draft.date !== notice.correctableDate ? { correctedDate: draft.date } : {}),
          },
        } as never,
      )) as { data?: unknown; error?: unknown; response?: Response };
      if (error) {
        setFailure(errorText(error, response?.status, config.acronym));
        return;
      }
      const created = data as { notice?: { noeId?: string; notrId?: string } } | undefined;
      setFiledId(created?.notice?.noeId ?? created?.notice?.notrId ?? null);
      setOpen(false);
      onFiled();
    } catch {
      setFailure(`The corrected ${config.acronym} could not be drafted. Check your connection.`);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="wx-action-row">
        <Button onClick={() => setOpen(true)}>File corrected {config.acronym}</Button>
      </div>
    );
  }

  const codes = notice.rejectionCodes ?? [];
  return (
    <section className="wx-drawer-card" aria-label={`File corrected ${config.acronym}`}>
      <h3>File corrected {config.acronym}</h3>
      <p className="wx-row-sub">
        Drafts a new {config.acronym} that copies this one and replaces it. Fix the cause first (the
        patient's Medicare details, the provider, or the date below), then submit the draft. The
        5-day filing window still counts from the original date.
      </p>
      <dl className="wx-kv">
        <dt>Rejected at</dt>
        <dd>{notice.rejectionStage ? STAGE[notice.rejectionStage] : "Not recorded"}</dd>
        <dt>Reason codes</dt>
        <dd className={codes.length > 0 ? "wx-nums" : undefined}>
          {codes.length > 0 ? codes.join(", ") : "None reported"}
        </dd>
      </dl>
      {failure ? <InlineAlert>{failure}</InlineAlert> : null}
      <div style={{ display: "grid", gap: "0.75rem" }}>
        <TextField
          label={config.correctableDateLabel}
          type="date"
          required
          value={draft.date}
          error={errors.date}
          hint={
            notice.correctableDate && draft.date !== notice.correctableDate
              ? `Changed from ${notice.correctableDate}.`
              : "Keep it unless the date on the rejected notice was wrong."
          }
          onChange={(e) => setDraft({ ...draft, date: e.target.value })}
        />
        <TextAreaField
          label="What was wrong, and what you corrected"
          required
          rows={3}
          maxLength={2000}
          value={draft.reason}
          error={errors.reason}
          onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
        />
        <div className="wx-action-row is-end">
          <Button tone="tertiary" disabled={busy} onClick={() => setOpen(false)}>
            Back
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            Draft corrected {config.acronym}
          </Button>
        </div>
      </div>
    </section>
  );
}
