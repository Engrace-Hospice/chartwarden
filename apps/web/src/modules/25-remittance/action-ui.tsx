// apps/web/src/modules/25-remittance — the small presentation kit the M25 write panels share (GAP-074): one
// right-rail chrome (the admissions drawer pattern), one modal chrome, one label/value fact list, one reason
// box with the server's length floor shown, one alert. Flat sections; tokens and kit components only.
import { Button, Glyph, InlineAlert, Modal, TextAreaField, useDrawerA11y } from "@chartwarden/ui";
import type { JSX, ReactNode } from "react";
import { useId } from "react";

export interface ActionModalProps {
  readonly ariaLabel: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly width?: string;
}

/** Centered dialog with the standard padding; the caller owns the body. */
export function ActionModal({
  ariaLabel,
  onClose,
  children,
  width = "36rem",
}: ActionModalProps): JSX.Element {
  return (
    <Modal open onClose={onClose} ariaLabel={ariaLabel} width={width} accent="var(--color-primary)">
      <div className="wx-action-body is-modal">
        <h2 className="wx-action-title">{ariaLabel}</h2>
        {children}
      </div>
    </Modal>
  );
}

/** Right-hand work rail for a selected worklist row — same chrome as the admissions drawer. */
export function ActionRail({
  ariaLabel,
  onClose,
  children,
}: Omit<ActionModalProps, "width">): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  return (
    <aside className="wx-admission-drawer" {...drawer} aria-label={ariaLabel}>
      <header className="wx-drawer-head">
        <h2>{ariaLabel}</h2>
        <button type="button" className="wx-icon-link" aria-label="Dismiss panel" onClick={onClose}>
          <Glyph name="close" size={18} />
        </button>
      </header>
      <div className="wx-action-body">{children}</div>
    </aside>
  );
}

/** Label/value rows (the drawer's Key Information pattern). */
export function Facts({
  items,
}: {
  readonly items: readonly (readonly [string, ReactNode])[];
}): JSX.Element {
  return (
    <dl className="wx-kv">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Muted helper text. */
export function Hint({ children }: { readonly children: ReactNode }): JSX.Element {
  return <p className="wx-action-hint">{children}</p>;
}

/** A row of buttons; `end` right-aligns it (form footers). */
export function ButtonRow({
  children,
  end,
}: {
  readonly children: ReactNode;
  readonly end?: boolean;
}): JSX.Element {
  return <div className={end ? "wx-action-row is-end" : "wx-action-row"}>{children}</div>;
}

/** A required free-text rationale; the count line names the server's floor so a disabled submit explains itself. */
export function ReasonField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly min: number;
  readonly max?: number;
  readonly onChange: (next: string) => void;
}): JSX.Element {
  return (
    <>
      <TextAreaField
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        maxLength={max}
      />
      <Hint>
        {value.trim().length}/{min} characters minimum — the server enforces this floor.
      </Hint>
    </>
  );
}

export function ErrorAlert({ message }: { readonly message: string | null }): JSX.Element | null {
  return message ? <InlineAlert>{message}</InlineAlert> : null;
}

export function NoticeAlert({ message }: { readonly message: string | null }): JSX.Element | null {
  return message ? <InlineAlert tone="success">{message}</InlineAlert> : null;
}

/** An advisory (not an error): for a state the user should notice but that blocks nothing. */
export function WarningAlert({ children }: { readonly children: ReactNode }): JSX.Element {
  return <InlineAlert tone="warning">{children}</InlineAlert>;
}

/** One sentence under a free-text field: these notes are not patient-attributed, so PHI does not belong in them. */
export const PHI_NOTICE =
  "Do not enter patient names or Medicare numbers; free text is not patient-attributed.";

export function PhiNotice(): JSX.Element {
  return <Hint>{PHI_NOTICE}</Hint>;
}

/** An error with a Retry button: shown only when there is no data yet to keep on screen. */
export function RetryAlert({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}): JSX.Element {
  return (
    <>
      <ErrorAlert message={message} />
      <ButtonRow>
        <Button size="sm" tone="secondary" onClick={onRetry}>
          Retry
        </Button>
      </ButtonRow>
    </>
  );
}

/** A hint that explains why a submit is disabled, wired to the button with aria-describedby. */
export function BlockedReason({
  id,
  children,
}: {
  readonly id: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <p id={id} className="wx-action-hint">
      {children}
    </p>
  );
}

export function FormButtons({
  submitLabel,
  busy,
  blocked,
  blockedReason,
  danger,
  onSubmit,
  onCancel,
}: {
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly blocked: boolean;
  /** Why the submit is disabled; shown beside the buttons and linked with aria-describedby while blocked. */
  readonly blockedReason?: string;
  readonly danger?: boolean;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const reasonId = useId();
  const reason = blocked && blockedReason ? blockedReason : null;
  return (
    <>
      {reason ? <BlockedReason id={reasonId}>{reason}</BlockedReason> : null}
      <ButtonRow end>
        <Button tone="tertiary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          tone={danger ? "danger" : "primary"}
          onClick={onSubmit}
          disabled={busy || blocked}
          aria-describedby={reason ? reasonId : undefined}
        >
          {busy ? "Working…" : submitLabel}
        </Button>
      </ButtonRow>
    </>
  );
}
