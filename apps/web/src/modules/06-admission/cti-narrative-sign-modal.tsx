// apps/web/src/modules/06-admission/cti-narrative-sign-modal.tsx — sign a CTI whose draft has no (or too
// short a) physician narrative. The transfer-in route drafts the receiving hospice's CTI for the next benefit
// period with no narrative, and 42 CFR 418.22(b)(3) requires one on every certification, so the server
// answers the plain sign with 422 `CTI_NARRATIVE_REQUIRED`. The signing physician writes the narrative here
// and it is sent with the signature (`POST /cti/:id/sign-hospice-md` `narrative`). Kit Modal + fields only.
import { Button, InlineAlert, Modal, TextAreaField, t } from "@wardenx/ui";
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";

/** § 418.22(b)(3) narrative minimum the server enforces on a recertification. */
export const CTI_NARRATIVE_MIN = 200;
const CTI_NARRATIVE_MAX = 4000;

export interface CtiNarrativeSignModalProps {
  open: boolean;
  /** e.g. "Period 2" — names the certification being signed. */
  periodLabel: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (narrative: string) => void;
}

export function CtiNarrativeSignModal({
  open,
  periodLabel,
  busy,
  error,
  onCancel,
  onSubmit,
}: CtiNarrativeSignModalProps): JSX.Element | null {
  const [narrative, setNarrative] = useState("");

  useEffect(() => {
    if (open) setNarrative("");
  }, [open]);

  if (!open) return null;
  const length = narrative.trim().length;
  const short = length < CTI_NARRATIVE_MIN;

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onCancel}
      ariaLabel="Add the certification narrative"
      width="40rem"
    >
      <div style={body}>
        <h2 style={title}>Add the certification narrative</h2>
        <p style={meta}>
          {periodLabel} CTI has no physician narrative. Write the clinical findings that support a
          terminal prognosis of six months or less; it is saved with your signature.
        </p>
        <TextAreaField
          label="Physician narrative"
          value={narrative}
          required
          maxLength={CTI_NARRATIVE_MAX}
          rows={8}
          hint={`${length} / ${CTI_NARRATIVE_MIN} characters minimum (42 CFR 418.22(b)(3))`}
          onChange={(e) => setNarrative(e.target.value)}
        />
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <div style={actions}>
          <Button tone="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            tone="primary"
            loading={busy}
            disabled={busy || short}
            onClick={() => onSubmit(narrative)}
          >
            Sign CTI
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const body: CSSProperties = {
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.875rem",
};
const title: CSSProperties = {
  margin: 0,
  fontSize: "1.125rem",
  fontWeight: 700,
  color: t.onSurface,
};
const meta: CSSProperties = { margin: 0, fontSize: "0.8125rem", color: t.onSurfaceVariant };
const actions: CSSProperties = { display: "flex", justifyContent: "flex-end", gap: "0.5rem" };
