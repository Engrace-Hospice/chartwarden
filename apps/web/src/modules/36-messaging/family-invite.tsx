// M36 WP 6.7 (ADR-0099 D1-D3, D14) - "Invite a family contact": enter the patient id (no reusable patient picker here, so a plain id like the partners screen), look up
// the caregivers on record with the reason a person cannot be invited (plain words), choose one, and confirm that the code will be given by voice. The
// secrets come back once (family-secrets.tsx). Creating needs the tenant flag, the 24-hour number and a fresh step-up; a missing number is surfaced with a
// way to the settings panel. Known limit: a step-up redirect loses what was typed.
import {
  type CreatedFamilyInvitationDto,
  FAMILY_INVITE_DEFAULT_DAYS,
  FAMILY_INVITE_MAX_DAYS,
  type FamilyEligibleCaregiverDto,
} from "@chartwarden/types";
import { Button, Modal, TextField } from "@chartwarden/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { FamilyEligibilityList } from "./family-eligibility";
import { useFamilyFailureText } from "./family-failure";
import { ft } from "./family-text";
import { useOnlineStatus } from "./offline-banner";
import { useFamilyActions } from "./use-family";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function FamilyInviteDialog({
  flagOn,
  onCancel,
  onCreated,
  onOpenSettings,
}: {
  readonly flagOn: boolean;
  readonly onCancel: () => void;
  readonly onCreated: (made: CreatedFamilyInvitationDto) => void;
  readonly onOpenSettings: () => void;
}): JSX.Element {
  const actions = useFamilyActions();
  const failureText = useFamilyFailureText();
  const online = useOnlineStatus();
  const inFlight = useRef(false);
  const [patientId, setPatientId] = useState("");
  const [caregivers, setCaregivers] = useState<readonly FamilyEligibleCaregiverDto[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [days, setDays] = useState(String(FAMILY_INVITE_DEFAULT_DAYS));
  const [byVoice, setByVoice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ readonly field: string; readonly text: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [settingsMissing, setSettingsMissing] = useState(false);
  const errorFor = (field: string): string | undefined =>
    problem?.field === field ? problem.text : undefined;

  const lookUp = async (): Promise<void> => {
    if (inFlight.current) return;
    if (!UUID.test(patientId.trim())) {
      setProblem({ field: "patientId", text: ft("family.invite.patientId.invalid") });
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setProblem(null);
    const result = await actions.caregivers(patientId.trim());
    inFlight.current = false;
    setBusy(false);
    if (result.kind === "ok") {
      setCaregivers(result.data.caregivers);
      setChosen("");
      return;
    }
    setError(failureText(result, "invite"));
  };

  const create = async (): Promise<void> => {
    if (inFlight.current) return;
    const dayCount = Number(days);
    const found = !chosen
      ? { field: "chosen", text: ft("family.invite.pick.required") }
      : !Number.isInteger(dayCount) || dayCount < 1 || dayCount > FAMILY_INVITE_MAX_DAYS
        ? { field: "days", text: ft("family.invite.days.invalid", { max: FAMILY_INVITE_MAX_DAYS }) }
        : !byVoice
          ? { field: "byVoice", text: ft("family.invite.byVoice.required") }
          : null;
    if (found) {
      setProblem(found);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setProblem(null);
    setSettingsMissing(false);
    const result = await actions.invite({
      patientId: patientId.trim(),
      patientCaregiverId: chosen,
      expiresInDays: dayCount,
      codeByVoiceConfirmed: true,
    });
    inFlight.current = false;
    setBusy(false);
    if (result.kind === "ok") return onCreated(result.data);
    setSettingsMissing(result.kind === "conflict" && result.settingsMissing);
    setError(failureText(result, "invite"));
  };

  return (
    <Modal
      open
      ariaLabel={ft("family.invite.title")}
      {...(busy ? {} : { onClose: onCancel })}
      dismissOnScrim={false}
      width="40rem"
    >
      <form
        className="wx-export-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void (caregivers ? create() : lookUp());
        }}
      >
        <h2>{ft("family.invite.title")}</h2>
        <p className="wx-export-notice">{ft("family.notEmergency")}</p>
        {flagOn ? null : (
          <p className="wx-export-error" role="alert">
            {ft("family.invite.notOn")}
          </p>
        )}
        <TextField
          id="family-invite-patient"
          label={ft("family.invite.patientId")}
          hint={ft("family.invite.patientId.hint")}
          error={errorFor("patientId")}
          value={patientId}
          disabled={caregivers !== null}
          onChange={(e) => setPatientId(e.target.value)}
        />
        {caregivers === null ? null : (
          <>
            <FamilyEligibilityList
              caregivers={caregivers}
              chosen={chosen}
              error={errorFor("chosen")}
              onChoose={setChosen}
            />
            <TextField
              id="family-invite-days"
              label={ft("family.invite.days")}
              type="number"
              error={errorFor("days")}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            />
            <div className="wx-export-choice">
              <label htmlFor="family-invite-voice">
                <input
                  id="family-invite-voice"
                  type="checkbox"
                  checked={byVoice}
                  aria-invalid={problem?.field === "byVoice" || undefined}
                  onChange={(e) => setByVoice(e.target.checked)}
                />{" "}
                {ft("family.invite.byVoice")}
              </label>
              {problem?.field === "byVoice" ? (
                <p className="wx-export-error" role="alert">
                  {problem.text}
                </p>
              ) : null}
            </div>
          </>
        )}
        {online ? null : (
          <p className="wx-export-error" role="alert">
            {ft("family.invite.offline")}
          </p>
        )}
        {error ? (
          <p className="wx-export-error" role="alert">
            {error}{" "}
            {settingsMissing ? (
              <Button type="button" tone="secondary" size="lg" onClick={onOpenSettings}>
                {ft("family.settings.missing.link")}
              </Button>
            ) : null}
          </p>
        ) : null}
        <div className="wx-export-actions">
          <Button type="button" tone="secondary" size="lg" disabled={busy} onClick={onCancel}>
            {ft("family.invite.cancel")}
          </Button>
          <Button
            type="submit"
            tone="primary"
            size="lg"
            disabled={busy || !online || (caregivers !== null && !flagOn)}
          >
            {caregivers === null
              ? busy
                ? ft("family.invite.looking")
                : ft("family.invite.lookup")
              : busy
                ? ft("family.invite.creating")
                : ft("family.invite.create")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
