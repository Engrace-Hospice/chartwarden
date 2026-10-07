// apps/web/src/modules/06-admission/scanned-upload.tsx — the ONE scanned-paper upload kit every M6 upload path
// shares: the Notice of Rights / Election Statement / CTI evidence uploads (admission-evidence-upload.tsx) and the
// election statement addendum's signed paper copy (election-addendum-scan-form.tsx). Same file control, same
// upload-stage notice, same right-hand drawer shell (aside.wx-admission-drawer, rail header, flat drawer card),
// so the four ceremonies look and behave the same. Kit controls and tokens only.
import { Button, Glyph, IconButton, InlineAlert, TextField } from "@wardenx/ui";
import type { JSX, ReactNode } from "react";
import type { UploadStage } from "../../shell/document-workflows";

/** What the verified M22 upload accepts (document-workflows.tsx `verifiedUpload`). */
export const SCANNED_UPLOAD_ACCEPT =
  ".pdf,.docx,.jpg,.jpeg,.png,.tif,.tiff,application/pdf,image/*";

/** A stage of the verified upload, plus the attach call that follows it. */
export type ScannedUploadStage = UploadStage | "attaching";

export const UPLOAD_STAGE_LABEL: Record<ScannedUploadStage, string> = {
  idle: "",
  preparing: "Preparing the upload…",
  uploading: "Uploading the document…",
  verifying: "Verifying the upload…",
  complete: "Upload verified",
  attaching: "Attaching it to the record…",
};

/** The kit file control for a scanned paper copy (no raw input). */
export function ScannedFileField({
  label = "Scanned paper copy",
  accept = SCANNED_UPLOAD_ACCEPT,
  hint = "PDF, DOCX, JPEG, PNG or TIFF, up to 25 MB.",
  disabled,
  onFile,
}: {
  label?: string;
  accept?: string;
  hint?: string;
  disabled?: boolean;
  onFile: (file: File | null) => void;
}): JSX.Element {
  return (
    <TextField
      type="file"
      label={label}
      hint={hint}
      accept={accept}
      disabled={disabled}
      required
      onChange={(e) => onFile(e.target.files?.[0] ?? null)}
    />
  );
}

/** The polite "Uploading…" line while the verified upload runs (nothing when idle). */
export function UploadStageNotice({ stage }: { stage: ScannedUploadStage }): JSX.Element | null {
  return stage === "idle" ? null : (
    <InlineAlert tone="info">{UPLOAD_STAGE_LABEL[stage]}</InlineAlert>
  );
}

/**
 * The right-hand drawer an upload ceremony opens in: rail header (icon tile, title, subtitle, close), the
 * server's refusal verbatim, the form as one flat drawer card, the stage notice and the commit row.
 */
export function ScannedUploadDrawer({
  title,
  subtitle,
  error,
  stage,
  busy,
  submitLabel = "Attach document",
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  error: string | null;
  stage: ScannedUploadStage;
  busy: boolean;
  submitLabel?: string;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <aside className="wx-admission-drawer" aria-label={title}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon wx-addendum-icon" aria-hidden>
          <Glyph name="upload" size={16} />
        </span>
        <div className="wx-addendum-head-text">
          <h2>{title}</h2>
          <div className="wx-row-sub">{subtitle}</div>
        </div>
        <IconButton tone="tertiary" size="sm" aria-label="Close upload" onClick={onClose}>
          <Glyph name="close" size={16} />
        </IconButton>
      </header>
      <div className="wx-drawer-body">
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <section className="wx-drawer-card wx-addendum-scan">
          <h3>Paper copy</h3>
          {children}
          <UploadStageNotice stage={stage} />
          <div className="wx-action-row is-end">
            <Button tone="tertiary" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button loading={busy} onClick={onSubmit}>
              {busy ? "Uploading..." : submitLabel}
            </Button>
          </div>
        </section>
      </div>
    </aside>
  );
}
