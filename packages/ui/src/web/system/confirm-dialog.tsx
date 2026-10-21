// @chartwarden/ui web — ConfirmDialog (UI-010): the missing confirmation primitive for destructive or
// consequential actions. Built on the shared, focus-trapped `Modal` (UI-005) so every confirmation
// gets Escape-to-close, a real focus trap, and focus restore for free instead of each caller
// re-inventing an arm-then-confirm two-click pattern (see the M2 staff-management containment this
// replaces).
import { useId } from "react";
import type { JSX, ReactNode } from "react";
import { t } from "../theme/tokens";
import { Modal } from "./modal";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" red-tones the confirm action for destructive/irreversible operations. */
  tone?: "default" | "danger";
  /** Disables both actions and swaps the confirm label to a busy state while a request is in flight. */
  pending?: boolean;
  /** Disables only the confirm action (e.g. until a required acknowledgement is ticked); Cancel stays available. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A two-action confirmation dialog for destructive or consequential writes (remove, rescind, void…). */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  pending = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): JSX.Element | null {
  const descId = useId();
  const isDanger = tone === "danger";
  if (!open) return null;
  return (
    <Modal
      open={open}
      onClose={pending ? undefined : onCancel}
      ariaLabel={title}
      role="alertdialog"
      width="26rem"
      accent={isDanger ? t.error : t.primary}
    >
      <div
        style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: t.space4 }}
        aria-describedby={description ? descId : undefined}
      >
        <h2
          style={{
            margin: 0,
            fontFamily: t.fontDisplay,
            fontSize: "1.25rem",
            fontWeight: 500,
            color: t.onSurface,
          }}
        >
          {title}
        </h2>
        {description ? (
          <div id={descId} style={{ margin: 0, fontSize: "0.875rem", color: t.onSurfaceVariant }}>
            {description}
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: t.space2 }}>
          <button type="button" onClick={onCancel} disabled={pending} style={ghostButtonStyle}>
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending || confirmDisabled}
            style={isDanger ? dangerButtonStyle : primaryButtonStyle}
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const buttonBase = {
  padding: "0.5rem 1rem",
  borderRadius: t.radiusMd,
  border: "none",
  fontWeight: 600,
  fontSize: "0.8125rem",
  cursor: "pointer",
} as const;
const ghostButtonStyle = { ...buttonBase, background: t.surfaceHigh, color: t.onSurface };
const primaryButtonStyle = { ...buttonBase, background: t.primary, color: t.onPrimary };
const dangerButtonStyle = { ...buttonBase, background: t.error, color: t.onEmphasis };
