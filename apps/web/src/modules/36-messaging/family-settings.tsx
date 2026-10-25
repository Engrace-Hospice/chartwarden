// M36 WP 6.7 (ADR-0099 D7, D14, D15) - the tenant's family-messaging settings: the neutral sender name, the 24-hour number (required before any invitation) and the
// bereavement support number. Manage permission only. The numbers are shown to contacts on every page they open, so each is bounded and plain text.
import { FAMILY_SETTING_TEXT_MAX, type FamilySettingsDto } from "@chartwarden/types";
import { Button, Modal, TextField } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { FamilyGate, useFamilyFailureText } from "./family-failure";
import { ft } from "./family-text";
import { useFamilyActions, useFamilySettings } from "./use-family";

const asText = (v: string | null): string => v ?? "";
const asNullable = (v: string): string | null => (v.trim() === "" ? null : v.trim());

function SettingsForm({ initial }: { readonly initial: FamilySettingsDto }): JSX.Element {
  const actions = useFamilyActions();
  const failureText = useFamilyFailureText();
  const [name, setName] = useState(asText(initial.agencyName));
  const [phone, setPhone] = useState(asText(initial.agencyPhone));
  const [bereavement, setBereavement] = useState(asText(initial.bereavementPhone));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ readonly text: string; readonly error: boolean } | null>(
    null,
  );
  const tooLong = [name, phone, bereavement].some((v) => v.trim().length > FAMILY_SETTING_TEXT_MAX);
  const limitError = (v: string): string | undefined =>
    v.trim().length > FAMILY_SETTING_TEXT_MAX
      ? ft("family.settings.tooLong", { max: FAMILY_SETTING_TEXT_MAX })
      : undefined;

  const save = async (): Promise<void> => {
    if (busy || tooLong) return;
    setBusy(true);
    setStatus(null);
    const result = await actions.saveSettings({
      agencyName: asNullable(name),
      agencyPhone: asNullable(phone),
      bereavementPhone: asNullable(bereavement),
    });
    setBusy(false);
    if (result.kind === "ok") return setStatus({ text: ft("family.settings.saved"), error: false });
    const text = failureText(result, "settings");
    if (text) setStatus({ text, error: true });
  };

  return (
    <form
      className="wx-export-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <TextField
        id="family-agency-name"
        label={ft("family.settings.agencyName")}
        hint={ft("family.settings.agencyName.hint")}
        error={limitError(name)}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <TextField
        id="family-agency-phone"
        label={ft("family.settings.agencyPhone")}
        hint={ft("family.settings.agencyPhone.hint")}
        type="tel"
        error={limitError(phone)}
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
      />
      <TextField
        id="family-bereavement-phone"
        label={ft("family.settings.bereavementPhone")}
        type="tel"
        error={limitError(bereavement)}
        value={bereavement}
        onChange={(e) => setBereavement(e.target.value)}
      />
      <output
        className="wx-export-status"
        aria-live="polite"
        data-error={status?.error || undefined}
      >
        {status?.text}
      </output>
      <Button type="submit" tone="primary" size="lg" disabled={busy || tooLong}>
        {ft("family.settings.save")}
      </Button>
    </form>
  );
}

export function FamilySettingsPanel({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const { view, reload } = useFamilySettings();
  return (
    <Modal open ariaLabel={ft("family.settings.title")} onClose={onClose} width="36rem">
      <div className="wx-export-dialog">
        <h2>{ft("family.settings.title")}</h2>
        <FamilyGate
          view={view}
          retry={reload}
          failedText={ft("family.settings.loadFailed")}
          deniedText={ft("family.manage.denied")}
        >
          {(settings) => <SettingsForm initial={settings} />}
        </FamilyGate>
        <div className="wx-export-actions">
          <Button type="button" tone="secondary" size="lg" onClick={onClose}>
            {ft("family.settings.close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
