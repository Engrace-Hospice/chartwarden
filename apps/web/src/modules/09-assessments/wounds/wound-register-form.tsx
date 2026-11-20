// apps/web/src/modules/09-assessments/wounds — register a wound: where it is, what caused it and when it began. A wound is
// registered once and observed at every visit after, so this form carries no measurement. The site is a CODE from the
// site list plus a side, never typed text; the side choices follow the site (a sacrum is midline, a heel is left, right
// or both), which is the rule the server refuses a mismatch under.
import {
  Button,
  SelectField,
  TextField,
  WriteFailureNotice,
  focusFirstInvalid,
  isValid,
  useApiClient,
} from "@chartwarden/ui";
import type { FieldErrors, OpsFailure } from "@chartwarden/ui";
import { type FormEvent, type JSX, useRef, useState } from "react";
import {
  ACQUIRED_LABELS,
  ETIOLOGY_LABELS,
  LATERALITY_LABELS,
  WOUND_SITES,
  lateralitiesFor,
  optionsOf,
} from "./wound-labels";
import {
  type RegisterWoundBody,
  type WoundAcquired,
  type WoundEtiology,
  type WoundLaterality,
  type WoundSiteCode,
  type WoundView,
  registerWound,
} from "./wounds-api";

const SITE_OPTIONS = [
  { value: "", label: "Choose a site" },
  ...WOUND_SITES.map((s) => ({
    value: s.code,
    label: s.label.charAt(0).toUpperCase() + s.label.slice(1),
  })),
];
const ETIOLOGY_OPTIONS = [{ value: "", label: "Choose a cause" }, ...optionsOf(ETIOLOGY_LABELS)];
const ACQUIRED_OPTIONS = [{ value: "", label: "Not stated" }, ...optionsOf(ACQUIRED_LABELS)];

type RegisterField = "siteCode" | "laterality" | "etiology" | "onsetOn";

/** Today as `YYYY-MM-DD` on this device, the latest onset date the date field offers. */
function todayLocal(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export interface WoundRegisterFormProps {
  readonly patientId: string;
  /** Fires with the registered wound. */
  readonly onRegistered: (wound: WoundView) => void;
  readonly onCancel: () => void;
  /** Fires true while the write is in flight and false once it settles, so a host can keep itself open until then. */
  readonly onBusyChange?: (busy: boolean) => void;
}

export function WoundRegisterForm({
  patientId,
  onRegistered,
  onCancel,
  onBusyChange,
}: WoundRegisterFormProps): JSX.Element {
  const client = useApiClient();
  const formRef = useRef<HTMLFormElement>(null);
  const [siteCode, setSiteCode] = useState<WoundSiteCode | "">("");
  const [laterality, setLaterality] = useState<WoundLaterality | "">("");
  const [etiology, setEtiology] = useState<WoundEtiology | "">("");
  const [acquired, setAcquired] = useState<WoundAcquired | "">("");
  const [onsetOn, setOnsetOn] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<OpsFailure | null>(null);

  const sides = siteCode === "" ? [] : lateralitiesFor(siteCode);
  const today = todayLocal();

  function problemsOf(): FieldErrors<RegisterField> {
    return {
      ...(siteCode === "" ? { siteCode: "Choose where the wound is." } : {}),
      ...(laterality === "" || !sides.includes(laterality)
        ? { laterality: "Choose the side that fits this site." }
        : {}),
      ...(etiology === "" ? { etiology: "Choose what caused the wound." } : {}),
      ...(onsetOn > today ? { onsetOn: "The onset date cannot be in the future." } : {}),
    };
  }
  const problems = attempted ? problemsOf() : {};

  function chooseSite(code: WoundSiteCode | ""): void {
    setSiteCode(code);
    const next = code === "" ? [] : lateralitiesFor(code);
    // A midline site has one sensible side; a paired site leaves the choice to the clinician.
    setLaterality(code !== "" && next[0] === "midline" ? "midline" : "");
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setAttempted(true);
    if (!isValid(problemsOf()) || siteCode === "" || laterality === "" || etiology === "") {
      focusFirstInvalid(formRef.current);
      return;
    }
    const body: RegisterWoundBody = {
      siteCode,
      laterality,
      etiology,
      ...(acquired === "" ? {} : { acquired }),
      ...(onsetOn === "" ? {} : { onsetOn }),
    };
    setBusy(true);
    onBusyChange?.(true);
    setFailure(null);
    const result = await registerWound(client, patientId, body);
    setBusy(false);
    onBusyChange?.(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    onRegistered(result.value);
  }

  return (
    <form
      ref={formRef}
      className="wx-form-stack"
      noValidate
      aria-busy={busy}
      aria-label="Register a wound"
      onSubmit={(event) => void submit(event)}
    >
      <SelectField
        label="Site"
        required
        value={siteCode}
        options={SITE_OPTIONS}
        error={problems.siteCode}
        disabled={busy}
        onChange={(event) => chooseSite(event.target.value as WoundSiteCode | "")}
      />
      <SelectField
        label="Side"
        required
        value={laterality}
        options={[
          { value: "", label: siteCode === "" ? "Choose a site first" : "Choose a side" },
          ...sides.map((side) => ({ value: side, label: LATERALITY_LABELS[side] })),
        ]}
        error={problems.laterality}
        disabled={busy || siteCode === ""}
        onChange={(event) => setLaterality(event.target.value as WoundLaterality | "")}
      />
      <SelectField
        label="Cause"
        required
        value={etiology}
        options={ETIOLOGY_OPTIONS}
        error={problems.etiology}
        disabled={busy}
        onChange={(event) => setEtiology(event.target.value as WoundEtiology | "")}
      />
      <SelectField
        label="Where it started"
        value={acquired}
        options={ACQUIRED_OPTIONS}
        disabled={busy}
        onChange={(event) => setAcquired(event.target.value as WoundAcquired | "")}
      />
      <TextField
        label="Onset date"
        type="date"
        max={today}
        value={onsetOn}
        error={problems.onsetOn}
        hint="Leave blank when the date is not known."
        disabled={busy}
        onChange={(event) => setOnsetOn(event.target.value)}
      />

      {failure ? <WriteFailureNotice failure={failure} /> : null}

      <div className="wx-action-row is-end">
        <Button tone="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={busy}>
          Register wound
        </Button>
      </div>
    </form>
  );
}
