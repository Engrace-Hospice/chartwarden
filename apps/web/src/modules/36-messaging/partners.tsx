// M36 WP 6.6 (ADR-0096, PROPOSED) - "External partners": the staff screen to share ONE conversation read-only with a pharmacy or DME partner and to
// revoke a share now. Flat rows on the shared kit; state is a word, never colour alone. Creating needs the tenant flag messaging.external_partners
// (no provider reads as OFF); the list and Revoke never depend on it. The invitation link parts and the code are shown ONCE, with the instruction to
// give them to the partner through different channels, and are dropped from state when the panel is dismissed. The PARTNER-facing view is not built.
import {
  type CreatedExternalShareDto,
  EXTERNAL_PARTNERS_FLAG_KEY,
  EXTERNAL_SHARE_DEFAULT_DAYS,
  EXTERNAL_SHARE_MANAGE_PERMISSION,
  EXTERNAL_SHARE_MAX_DAYS,
  EXTERNAL_SHARE_PARTNER_KINDS,
  type ExternalShareDto,
  type ExternalSharePartnerKind,
} from "@chartwarden/types";
import {
  Button,
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
}
const EMPTY: Draft = {
  channelId: "",
  partnerName: "",
  partnerKind: "pharmacy",
  baaReference: "",
  days: String(EXTERNAL_SHARE_DEFAULT_DAYS),
};

/** The first thing wrong with the draft, as a sentence, or null when it can be sent. */
export function validateShareDraft(draft: Draft): string | null {
  if (!UUID.test(draft.channelId.trim())) return "Enter the conversation id as a UUID.";
  if (draft.partnerName.trim() === "") return "Enter the partner's name.";
  if (draft.baaReference.trim() === "") return "Enter the business associate agreement reference.";
  const days = Number(draft.days);
  if (!Number.isInteger(days) || days < 1 || days > EXTERNAL_SHARE_MAX_DAYS) {
    return `Choose 1 to ${EXTERNAL_SHARE_MAX_DAYS} days.`;
  }
  return null;
}

function CreateDialog({
  onClose,
  onCreated,
}: {
  readonly onClose: () => void;
  readonly onCreated: (made: CreatedExternalShareDto) => void;
}): JSX.Element {
  const actions = usePartnerActions();
  const failureText = useFailureText();
  const online = useOnlineStatus();
  const inFlight = useRef(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }));

  const submit = async (): Promise<void> => {
    if (inFlight.current) return;
    const problem = validateShareDraft(draft);
    if (problem) {
      setError(problem);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const result = await actions.create({
      channelId: draft.channelId.trim(),
      partnerName: draft.partnerName.trim(),
      partnerKind: draft.partnerKind,
      baaReference: draft.baaReference.trim(),
      expiresInDays: Number(draft.days),
    });
    inFlight.current = false;
    setBusy(false);
    if (result.kind === "ok") {
      onCreated(result.data);
      return;
    }
    if (result.kind === "not_available") {
      setError(
        "That conversation cannot be shared. Only team, location, on-call and direct conversations can be, and partner sharing must be switched on for your organisation.",
      );
      return;
    }
    if (result.kind === "limit") {
      setError("Too many partner shares. Revoke one, or try again tomorrow.");
      return;
    }
    setError(failureText(result));
  };

  return (
    <Modal
      open
      ariaLabel="Share a conversation with a partner"
      onClose={() => !inFlight.current && onClose()}
      dismissOnScrim={false}
      width="40rem"
    >
      <form
        className="wx-export-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>Share a conversation with a partner</h2>
        <div className="wx-export-notice">
          <p>
            The partner can read this one conversation, read-only, and only messages posted after
            you share it. Attachments, clinical links, patient or staff mentions and redacted
            messages are never shown. Do not share a conversation that discusses patients by name.
          </p>
        </div>
        <TextField
          label="Conversation id"
          value={draft.channelId}
          onChange={(e) => set({ channelId: e.target.value })}
        />
        <TextField
          label="Partner name"
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
          label="Business associate agreement reference"
          value={draft.baaReference}
          onChange={(e) => set({ baaReference: e.target.value })}
        />
        <TextField
          label="Days until access ends"
          hint={`1 to ${EXTERNAL_SHARE_MAX_DAYS}. Access cannot be extended; create a new share instead.`}
          type="number"
          value={draft.days}
          onChange={(e) => set({ days: e.target.value })}
        />
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
          <Button type="button" tone="secondary" size="lg" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" tone="primary" size="lg" disabled={busy || !online}>
            Create share
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Shown ONCE after creating. The parts are kept only in this component's props; closing drops them. */
function Secrets({
  made,
  onClose,
}: { readonly made: CreatedExternalShareDto; readonly onClose: () => void }): JSX.Element {
  return (
    <Modal
      open
      ariaLabel="Partner access created"
      onClose={onClose}
      dismissOnScrim={false}
      width="40rem"
    >
      <div className="wx-export-dialog">
        <h2>Partner access created for {made.partnerName}</h2>
        <p>
          This is the only time these are shown. Give the partner the invitation and the code
          through <strong>different channels</strong> (for example, send the invitation, then read
          the code by phone). Never put either in a message about a patient.
        </p>
        <dl>
          <dt>Organisation id</dt>
          <dd className="wx-export-mono">{made.organizationId}</dd>
          <dt>Share id</dt>
          <dd className="wx-export-mono">{made.id}</dd>
          <dt>Invitation token</dt>
          <dd className="wx-export-mono">{made.inviteToken}</dd>
          <dt>Verification code</dt>
          <dd className="wx-export-mono">{made.verificationCode}</dd>
          <dt>Access ends</dt>
          <dd>{formatTime(made.expiresAt)}</dd>
        </dl>
        <div className="wx-export-actions">
          <Button type="button" tone="primary" size="lg" onClick={onClose}>
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
}: {
  readonly share: ExternalShareDto;
  readonly busy: boolean;
  readonly onRevoke: (share: ExternalShareDto) => void;
}): JSX.Element {
  const online = useOnlineStatus();
  const tone =
    share.status === "active" ? "success" : share.status === "revoked" ? "error" : "neutral";
  return (
    <li className="wx-export-row">
      <div className="wx-export-main">
        <span className="wx-export-title">
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
            aria-label={`Revoke access for ${share.partnerName} now`}
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
  const { view, reload } = useExternalShares();
  const actions = usePartnerActions();
  const failureText = useFailureText();
  const flagOn = useFlag(EXTERNAL_PARTNERS_FLAG_KEY);
  const inFlight = useRef(false);
  const statusRef = useRef<HTMLOutputElement>(null);
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<CreatedExternalShareDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const revoke = (share: ExternalShareDto): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    void actions.revoke(share.id).then((result) => {
      inFlight.current = false;
      setBusy(false);
      setMessage(
        result.kind === "ok"
          ? `Access for ${share.partnerName} ended. Their next request is refused.`
          : failureText(result),
      );
      if (result.kind === "ok" || result.kind === "conflict" || result.kind === "not_available")
        reload();
      statusRef.current?.focus();
    });
  };

  return (
    <>
      <PageHeader title="External partners" breadcrumb="Messaging">
        <p className="wx-export-detail">
          Share one conversation, read-only, with a pharmacy or equipment partner for a limited
          time. Every read is logged.{" "}
          {flagOn
            ? null
            : "Partner sharing is switched off for your organisation; existing shares can still be revoked."}
        </p>
        {flagOn ? (
          <Button type="button" tone="primary" onClick={() => setCreating(true)}>
            Share a conversation
          </Button>
        ) : null}
      </PageHeader>
      <section className="wx-export" aria-label="External partner shares">
        <output ref={statusRef} tabIndex={-1} className="wx-export-status" aria-live="polite">
          {message}
        </output>
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
                  <Row key={s.id} share={s} busy={busy} onRevoke={revoke} />
                ))}
              </ul>
            )
          }
        </LoadGate>
      </section>
      {creating ? (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(m) => {
            setCreating(false);
            setMade(m);
            reload();
          }}
        />
      ) : null}
      {made ? <Secrets made={made} onClose={() => setMade(null)} /> : null}
    </>
  );
}

export const EXTERNAL_PARTNERS_PERMISSION = EXTERNAL_SHARE_MANAGE_PERMISSION;
