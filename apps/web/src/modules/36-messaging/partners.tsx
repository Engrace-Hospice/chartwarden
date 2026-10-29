// M36 WP 6.6 (ADR-0096, PROPOSED) - "External partners": the staff screen to share ONE conversation read-only with a pharmacy or DME partner and to
// revoke a share now. Flat rows on the shared kit; state is a word, never colour alone. Creating needs the tenant flag messaging.external_partners
// (no provider reads as OFF); the list and Revoke never depend on it. The invitation token and the code are shown ONCE, with the instruction to give
// them to the partner through different channels, and live only in this screen's state: they are dropped when the panel is dismissed or the screen
// unmounts. The partner's own page is partner-page.tsx (/partner/share); the dialog and the secrets panel both show a synthetic preview of it
// (partner-preview.tsx, ADR-0096 D22) and say plainly that ChartWarden sends nothing: staff hand the link and the code over themselves.
// Revoke and Reissue each ask for a confirmation (the shared ConfirmDialog): one click ends the partner's access. Known limits: the conversation is
// entered as a raw id (no picker) and a step-up redirect loses what was typed.
import {
  type CreatedExternalShareDto,
  EXTERNAL_PARTNERS_FLAG_KEY,
  EXTERNAL_SHARE_DEFAULT_DAYS,
  EXTERNAL_SHARE_MAX_DAYS,
  EXTERNAL_SHARE_PARTNER_KINDS,
  type ExternalShareDto,
  type ExternalSharePartnerKind,
} from "@chartwarden/types";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Modal,
  PageHeader,
  StatusPill,
  TextField,
  useFeatureFlag,
} from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { LoadGate, formatTime, useFailureText } from "./export-common";
import { useOnlineStatus } from "./offline-banner";
import { buildPartnerInvitationLink } from "./partner-link";
import { PartnerPreview } from "./partner-preview";
import type { ExportResult } from "./use-export";
import { useExternalShares, usePartnerActions } from "./use-partners";
import "./export.css";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_LABELS: Record<ExternalSharePartnerKind, string> = {
  pharmacy: "Pharmacy",
  dme: "Medical equipment (DME)",
  other: "Other partner",
};
const STATUS_LABELS = { active: "Active", expired: "Expired", revoked: "Revoked" } as const;

function useFlag(key: string): boolean {
  try {
    return useFeatureFlag(key);
  } catch {
    return false; // no provider mounted: fail closed
  }
}

interface Draft {
  readonly channelId: string;
  readonly partnerName: string;
  readonly partnerKind: ExternalSharePartnerKind;
  readonly baaReference: string;
  readonly days: string;
  /** D15: the minimum-necessary confirmation; the API refuses a share without it. */
  readonly acknowledged: boolean;
}
const EMPTY: Draft = {
  channelId: "",
  partnerName: "",
  partnerKind: "pharmacy",
  baaReference: "",
  days: String(EXTERNAL_SHARE_DEFAULT_DAYS),
  acknowledged: false,
};

export type DraftField = "channelId" | "partnerName" | "baaReference" | "days" | "acknowledged";
export interface DraftProblem {
  readonly field: DraftField;
  readonly message: string;
}

/** The first thing wrong with the draft and WHICH control it is about (so the dialog can mark and focus it), or null when it can be sent. */
export function validateShareDraftField(draft: Draft): DraftProblem | null {
  if (!UUID.test(draft.channelId.trim())) {
    return { field: "channelId", message: "Enter the conversation id as a UUID." };
  }
  if (draft.partnerName.trim() === "") {
    return { field: "partnerName", message: "Enter the partner's name." };
  }
  if (draft.baaReference.trim() === "") {
    return { field: "baaReference", message: "Enter the business associate agreement reference." };
  }
  const days = Number(draft.days);
  if (!Number.isInteger(days) || days < 1 || days > EXTERNAL_SHARE_MAX_DAYS) {
    return { field: "days", message: `Choose 1 to ${EXTERNAL_SHARE_MAX_DAYS} days.` };
  }
  if (!draft.acknowledged) {
    return {
      field: "acknowledged",
      message: "Confirm the statement about what the partner will see.",
    };
  }
  return null;
}

/** The first thing wrong with the draft, as a sentence, or null when it can be sent. */
export function validateShareDraft(draft: Draft): string | null {
  return validateShareDraftField(draft)?.message ?? null;
}

const FIELD_ID: Record<DraftField, string> = {
  channelId: "share-channel-id",
  partnerName: "share-partner-name",
  baaReference: "share-baa-reference",
  days: "share-days",
  acknowledged: "share-acknowledged",
};

/** Sentences for a failed share action, specific to partner shares (never the export wording). A stale step-up navigates and says nothing. */
function useShareFailureText(): (
  result: ExportResult<unknown>,
  action: "create" | "revoke" | "reissue",
) => string | null {
  const stepUpText = useFailureText();
  return (result, action) => {
    switch (result.kind) {
      case "ok":
        return null;
      case "step_up":
        return stepUpText(result);
      case "not_available":
        return action === "create"
          ? "That conversation cannot be shared. Only team, location and on-call conversations you are a member of can be, and partner sharing must be switched on for your organisation."
          : "That share is no longer available.";
      case "limit":
        return action === "create"
          ? "Too many partner shares. Revoke one, or try again tomorrow."
          : "Too many requests. Wait a moment and try again.";
      case "conflict":
        return action === "reissue"
          ? "That share is no longer active, so its invitation cannot be reissued."
          : "That share has already been revoked.";
      case "invalid":
        return "Check the details and try again.";
      case "denied":
        return result.code === 401
          ? "Your session has ended. Sign in again."
          : "You do not have permission to manage partner shares.";
      default:
        return action === "create"
          ? "The share could not be created. Nothing was shared. If this keeps happening, partner access may not be available on this deployment."
          : action === "reissue"
            ? "The invitation could not be reissued. The partner may already be locked out; reissue again to get new secrets, or check the list first."
            : "The share could not be revoked. It may still be active; check the list and try again.";
    }
  };
}

function CreateDialog({
  busy,
  onCancel,
  submit,
}: {
  readonly busy: boolean;
  readonly onCancel: () => void;
  /** Resolves to the sentence to show when it failed, or null. The in-flight state lives in the parent, so a dismissal cannot lose the result. */
  readonly submit: (draft: Draft) => Promise<string | null>;
}): JSX.Element {
  const online = useOnlineStatus();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const set = (patch: Partial<Draft>): void => {
    setProblem(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const errorFor = (field: DraftField): string | undefined =>
    problem?.field === field ? problem.message : undefined;

  const send = async (): Promise<void> => {
    if (busy) return;
    const found = validateShareDraftField(draft);
    if (found) {
      // Mark the failing control and put the focus on it, so a keyboard or screen-reader user lands where the problem is.
      setProblem(found);
      document.getElementById(FIELD_ID[found.field])?.focus();
      return;
    }
    setProblem(null);
    setError(null);
    setError(await submit(draft));
  };

  return (
    <Modal
      open
      ariaLabel="Share a conversation with a partner"
      // While a create is in flight the dialog cannot be dismissed (Escape does nothing): its outcome would be lost.
      {...(busy ? {} : { onClose: onCancel })}
      dismissOnScrim={false}
      width="40rem"
    >
      <form
        className="wx-export-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <h2>Share a conversation with a partner</h2>
        <div className="wx-export-notice">
          <p>
            The partner can read this one conversation, read-only, and only messages posted after
            you share it. Attachments, clinical links, patient or staff mentions, urgent messages
            and redacted messages are never shown. Free text is shown exactly as typed, so do not
            share a conversation where patients are named or described.
          </p>
        </div>
        <TextField
          id={FIELD_ID.channelId}
          label="Conversation id"
          error={errorFor("channelId")}
          value={draft.channelId}
          onChange={(e) => set({ channelId: e.target.value })}
        />
        <TextField
          id={FIELD_ID.partnerName}
          label="Partner name"
          error={errorFor("partnerName")}
          value={draft.partnerName}
          onChange={(e) => set({ partnerName: e.target.value })}
        />
        <label className="wx-export-choice">
          <span>Partner type</span>
          <select
            value={draft.partnerKind}
            onChange={(e) => set({ partnerKind: e.target.value as ExternalSharePartnerKind })}
          >
            {EXTERNAL_SHARE_PARTNER_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <TextField
          id={FIELD_ID.baaReference}
          label="Business associate agreement reference"
          error={errorFor("baaReference")}
          value={draft.baaReference}
          onChange={(e) => set({ baaReference: e.target.value })}
        />
        <TextField
          id={FIELD_ID.days}
          label="Days until access ends"
          error={errorFor("days")}
          hint={`1 to ${EXTERNAL_SHARE_MAX_DAYS}. Access cannot be extended; create a new share instead.`}
          type="number"
          value={draft.days}
          onChange={(e) => set({ days: e.target.value })}
        />
        <PartnerPreview
          partnerName={draft.partnerName}
          accessEndsText={`${draft.days.trim() || EXTERNAL_SHARE_DEFAULT_DAYS} day(s) after you create the share`}
        />
        <div className="wx-export-choice">
          <label htmlFor={FIELD_ID.acknowledged}>
            <input
              id={FIELD_ID.acknowledged}
              type="checkbox"
              checked={draft.acknowledged}
              aria-invalid={problem?.field === "acknowledged" || undefined}
              aria-describedby={
                problem?.field === "acknowledged"
                  ? "share-ack-statement share-ack-error"
                  : "share-ack-statement"
              }
              onChange={(e) => set({ acknowledged: e.target.checked })}
            />{" "}
            I confirm what the partner will see
          </label>
          <p id="share-ack-statement" className="wx-export-detail">
            An outside party will read this conversation, and patient names written in the messages
            are NOT filtered. Messages containing a date of birth, a record, account or phone
            number, an email or a street address are withheld, but names and indirect details are
            not detected.
          </p>
          {problem?.field === "acknowledged" ? (
            <p id="share-ack-error" className="wx-export-error" role="alert">
              {problem.message}
            </p>
          ) : null}
        </div>
        {!online ? (
          <p className="wx-export-error" role="alert">
            You are offline. Sharing needs a connection and is never queued.
          </p>
        ) : null}
        {error ? (
          <p className="wx-export-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="wx-export-actions">
          <Button type="button" tone="secondary" size="lg" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" tone="primary" size="lg" disabled={busy || !online}>
            {busy ? "Creating…" : "Create share"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Shown ONCE after creating. There is NO onClose: Escape and the scrim do nothing, so the only way out is the explicit button (a stray key must not
 * destroy the only copy of the secrets). The kit has no copy affordance, so none is offered; the values are selectable text.
 */
function Secrets({
  made,
  reissued,
  onDone,
}: {
  readonly made: CreatedExternalShareDto;
  readonly reissued: boolean;
  readonly onDone: () => void;
}): JSX.Element {
  return (
    <Modal
      open
      ariaLabel={reissued ? "Invitation reissued" : "Partner access created"}
      dismissOnScrim={false}
      width="40rem"
    >
      <div className="wx-export-dialog">
        <h2>
          {reissued
            ? `Invitation reissued for ${made.partnerName}`
            : `Partner access created for ${made.partnerName}`}
        </h2>
        <p>
          This is the only time these are shown. Give the partner the invitation and the code
          through <strong>different channels</strong> (for example, send the invitation, then read
          the code by phone). Never put either in a message about a patient.
        </p>
        <dl>
          <dt>Share id</dt>
          <dd className="wx-export-mono" translate="no">
            {made.id}
          </dd>
          <dt>Invitation link (works once)</dt>
          <dd className="wx-export-mono" translate="no">
            {buildPartnerInvitationLink(
              window.location.origin,
              made.organizationId,
              made.inviteToken,
            )}
          </dd>
          <dt>Verification code</dt>
          <dd className="wx-export-mono" translate="no">
            {made.verificationCode}
          </dd>
          <dt>Access ends</dt>
          <dd>{formatTime(made.expiresAt)}</dd>
        </dl>
        <p className="wx-export-notice">
          <strong>ChartWarden does not send this link or the code.</strong> No approved, covered
          delivery channel exists yet, so you must hand them over yourself: the link by a channel
          you trust, the code by phone. Do not paste either into a message about a patient.
        </p>
        <PartnerPreview
          partnerName={made.partnerName}
          accessEndsText={formatTime(made.expiresAt)}
        />
        <div className="wx-export-actions">
          <Button type="button" tone="primary" size="lg" onClick={onDone}>
            I have passed these on
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Row({
  share,
  busy,
  onRevoke,
  onReissue,
}: {
  readonly share: ExternalShareDto;
  readonly busy: boolean;
  readonly onRevoke: (share: ExternalShareDto) => void;
  readonly onReissue: (share: ExternalShareDto) => void;
}): JSX.Element {
  const online = useOnlineStatus();
  const titleId = `wx-share-${share.id}`;
  const tone =
    share.status === "active" ? "success" : share.status === "revoked" ? "error" : "neutral";
  return (
    <li className="wx-export-row">
      <div className="wx-export-main">
        <span className="wx-export-title" id={titleId}>
          {share.partnerName}{" "}
          <span className="wx-export-detail">({KIND_LABELS[share.partnerKind]})</span>
        </span>
        <span className="wx-export-detail">
          Conversation: {share.channelTitle ?? share.channelId} · Shared{" "}
          {formatTime(share.sharedFrom)} · Access ends {formatTime(share.expiresAt)}
        </span>
        <span className="wx-export-detail">
          {share.redeemed ? "Partner has opened the invitation." : "Invitation not yet used."}
          {share.codeLocked
            ? " The verification code is locked after too many wrong tries; revoke and create a new share."
            : ""}
        </span>
      </div>
      <div className="wx-export-meta">
        <StatusPill
          tone={tone}
          {...(share.status === "active" ? { glyph: "check" as const } : {})}
          label={STATUS_LABELS[share.status]}
        />
        {share.status === "active" ? (
          <Button
            type="button"
            tone="secondary"
            size="lg"
            disabled={busy || !online}
            aria-describedby={titleId}
            onClick={() => onReissue(share)}
          >
            Reissue invitation
          </Button>
        ) : null}
        {share.status === "active" ? (
          // The visible text is the whole accessible name (WCAG 2.5.3); the partner is named by the description.
          <Button
            type="button"
            tone="secondary"
            size="lg"
            disabled={busy || !online}
            aria-describedby={titleId}
            onClick={() => onRevoke(share)}
          >
            Revoke now
          </Button>
        ) : null}
      </div>
    </li>
  );
}

export function ExternalPartners(): JSX.Element {
  const { view, reload, refreshFailed } = useExternalShares();
  const actions = usePartnerActions();
  const failureText = useShareFailureText();
  const flagOn = useFlag(EXTERNAL_PARTNERS_FLAG_KEY);
  const online = useOnlineStatus();
  const inFlight = useRef(false);
  const statusRef = useRef<HTMLOutputElement>(null);
  const [creating, setCreating] = useState(false);
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [made, setMade] = useState<{
    readonly share: CreatedExternalShareDto;
    readonly reissued: boolean;
  } | null>(null);
  // `seq` keys the live region so an identical message is announced again.
  const [message, setMessage] = useState<{ text: string | null; seq: number }>({
    text: null,
    seq: 0,
  });
  const [busy, setBusy] = useState(false);
  // One click ends (revoke) or replaces (reissue) the partner's access, so each asks first.
  const [confirming, setConfirming] = useState<{
    readonly kind: "revoke" | "reissue";
    readonly share: ExternalShareDto;
  } | null>(null);
  const say = (text: string | null): void => setMessage((m) => ({ text, seq: m.seq + 1 }));

  const create = async (draft: Draft): Promise<string | null> => {
    if (inFlight.current) return null; // two fast submits before the disabled state paints send one request
    inFlight.current = true;
    setCreatingBusy(true);
    const result = await actions.create({
      channelId: draft.channelId.trim(),
      partnerName: draft.partnerName.trim(),
      partnerKind: draft.partnerKind,
      baaReference: draft.baaReference.trim(),
      expiresInDays: Number(draft.days),
      acknowledgedMinimumNecessary: true,
    });
    inFlight.current = false;
    setCreatingBusy(false);
    if (result.kind === "ok") {
      // The secrets come back exactly once: surface them whatever happened to the dialog.
      setMade({ share: result.data, reissued: false });
      setCreating(false);
      reload();
      return null;
    }
    return failureText(result, "create");
  };

  const reissue = (share: ExternalShareDto): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    say(null);
    void actions.reissue(share.id).then((result) => {
      inFlight.current = false;
      setBusy(false);
      if (result.kind === "ok") {
        // The new secrets come back exactly once; the old invitation, code and sessions are already dead.
        setMade({ share: result.data, reissued: true });
        reload();
        return;
      }
      say(failureText(result, "reissue"));
      if (result.kind === "conflict" || result.kind === "not_available") reload();
      statusRef.current?.focus();
    });
  };

  const revoke = (share: ExternalShareDto): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    say(null);
    void actions.revoke(share.id).then((result) => {
      inFlight.current = false;
      setBusy(false);
      say(
        result.kind === "ok"
          ? `Access for ${share.partnerName} ended. Their next request is refused.`
          : failureText(result, "revoke"),
      );
      if (result.kind === "ok" || result.kind === "conflict" || result.kind === "not_available")
        reload();
      statusRef.current?.focus();
    });
  };

  return (
    <>
      <PageHeader title="External partners">
        <p className="wx-export-detail">
          Share one conversation, read-only, with a pharmacy or equipment partner for a limited
          time. Every read is logged. Creating a share needs partner sharing to be switched on for
          your organisation; existing shares can always be revoked.
        </p>
        {flagOn ? (
          <Button
            type="button"
            tone="primary"
            disabled={busy || creatingBusy || !online}
            onClick={() => setCreating(true)}
          >
            Share a conversation
          </Button>
        ) : null}
      </PageHeader>
      <section className="wx-export" aria-label="External partner shares">
        <output
          key={message.seq}
          ref={statusRef}
          tabIndex={-1}
          className="wx-export-status"
          aria-live="polite"
        >
          {message.text}
        </output>
        {refreshFailed && view.status === "ready" ? (
          <div className="wx-export-error" role="alert">
            <p>The list could not be refreshed. The shares shown may be out of date.</p>
            <Button type="button" tone="secondary" size="lg" onClick={reload}>
              Retry
            </Button>
          </div>
        ) : null}
        <LoadGate view={view} retry={reload} deniedText="You do not have access to partner shares.">
          {(shares) =>
            shares.length === 0 ? (
              <EmptyState
                title="No partner shares"
                description="Conversations you share with a partner appear here."
              />
            ) : (
              <ul className="wx-export-rows" aria-label="Partner shares">
                {shares.map((s) => (
                  <Row
                    key={s.id}
                    share={s}
                    busy={busy || creatingBusy}
                    onRevoke={(share) => setConfirming({ kind: "revoke", share })}
                    onReissue={(share) => setConfirming({ kind: "reissue", share })}
                  />
                ))}
              </ul>
            )
          }
        </LoadGate>
      </section>
      {creating ? (
        <CreateDialog
          busy={creatingBusy}
          onCancel={() => !creatingBusy && setCreating(false)}
          submit={create}
        />
      ) : null}
      <ConfirmDialog
        open={confirming !== null}
        tone="danger"
        pending={busy}
        title={
          confirming?.kind === "reissue"
            ? `Reissue the invitation for ${confirming.share.partnerName}?`
            : `Revoke access for ${confirming?.share.partnerName ?? "this partner"} now?`
        }
        description={
          confirming?.kind === "reissue" ? (
            <p>
              The partner is signed out at once and the current invitation and code stop working.
              You will be shown a new invitation and a new code once, to pass on through different
              channels. The end date does not change.
            </p>
          ) : (
            <p>
              The partner can no longer read this conversation; their very next request is refused.
              To give access again you create a new share.
            </p>
          )
        }
        confirmLabel={
          confirming?.kind === "reissue" ? "Yes, reissue invitation" : "Yes, revoke access"
        }
        cancelLabel="Keep as is"
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const target = confirming;
          setConfirming(null);
          if (!target) return;
          if (target.kind === "reissue") reissue(target.share);
          else revoke(target.share);
        }}
      />
      {made ? (
        <Secrets
          made={made.share}
          reissued={made.reissued}
          onDone={() => {
            setMade(null);
            say("The invitation and code are no longer shown.");
          }}
        />
      ) : null}
    </>
  );
}
