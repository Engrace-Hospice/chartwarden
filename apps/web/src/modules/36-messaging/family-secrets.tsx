// M36 WP 6.7 (ADR-0099 D3) - the link and the 8-digit code, shown ONCE after an invitation is created. There is NO onClose: Escape and the scrim do nothing, so the
// only way out is the explicit button (a stray key must not destroy the only copy). Both live only in the lane's state and are gone when the panel closes.
// The code is shown apart from the link and the panel says to SPEAK it. ChartWarden sends neither (no sender is wired, D17).
import type { CreatedFamilyInvitationDto } from "@chartwarden/types";
import { Button, Modal } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { formatTime } from "./export-common";
import { buildFamilyInvitationLink } from "./family-link";
import { ft } from "./family-text";

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false; // clipboard blocked or unavailable: the values are selectable text
  }
}

function Secret({
  label,
  value,
  copyLabel,
}: { readonly label: string; readonly value: string; readonly copyLabel: string }): JSX.Element {
  const [note, setNote] = useState("");
  return (
    <>
      <dt>{label}</dt>
      <dd className="wx-export-mono" translate="no">
        {value}
      </dd>
      <dd>
        <Button
          type="button"
          tone="secondary"
          size="lg"
          onClick={async () =>
            setNote(
              (await copy(value)) ? ft("family.secrets.copied") : ft("family.secrets.copyFailed"),
            )
          }
        >
          {copyLabel}
        </Button>{" "}
        <output aria-live="polite" className="wx-export-detail">
          {note}
        </output>
      </dd>
    </>
  );
}

export function FamilySecrets({
  made,
  onDone,
}: { readonly made: CreatedFamilyInvitationDto; readonly onDone: () => void }): JSX.Element {
  const link = buildFamilyInvitationLink(
    window.location.origin,
    made.organizationId,
    made.inviteToken,
    made.agencyPhone,
  );
  return (
    <Modal open ariaLabel={ft("family.secrets.title")} dismissOnScrim={false} width="40rem">
      <div className="wx-export-dialog">
        <h2>{ft("family.secrets.title")}</h2>
        <p>
          <strong>{ft("family.secrets.once")}</strong>
        </p>
        <dl>
          <Secret
            label={ft("family.secrets.link")}
            value={link}
            copyLabel={ft("family.secrets.copyLink")}
          />
          <Secret
            label={ft("family.secrets.code")}
            value={made.verificationCode}
            copyLabel={ft("family.secrets.copyCode")}
          />
        </dl>
        <p className="wx-export-notice">{ft("family.secrets.codeNote")}</p>
        <p className="wx-export-detail">
          {ft("family.secrets.expires", { when: formatTime(made.expiresAt) })}
        </p>
        <p className="wx-export-notice">{ft("family.secrets.notSent")}</p>
        <div className="wx-export-actions">
          <Button type="button" tone="primary" size="lg" onClick={onDone}>
            {ft("family.secrets.done")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
