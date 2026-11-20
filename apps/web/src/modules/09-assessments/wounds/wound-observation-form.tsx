// apps/web/src/modules/09-assessments/wounds — THE observation form, shared by the wound registry's drawer and the visit
// note's wound panel. It records one dated observation of one wound (every descriptor the server holds), or corrects an
// earlier one: a correction opens on the whole observation, asks why by code, and sends the observation's version as
// If-Match, so a stale one is refused rather than overwritten.
//
// The rules the server enforces are restated as field hints so most 422s never happen: a stage only for a pressure
// injury, a depth only with a length and a width, "intact" skin on its own, a dressing named when one was applied. The
// server stays the authority and any refusal it still makes is shown in its own words beside Save.
//
// The form knows only what it is given: it prefills nothing it cannot know (a new observation opens empty) and sends no
// date. `sourceEncounterId` ties a new observation to the visit it was made on.
import {
  Button,
  InlineAlert,
  SelectField,
  TextField,
  WriteFailureNotice,
  focusFirstInvalid,
  isValid,
  useApiClient,
} from "@chartwarden/ui";
import type { OpsFailure } from "@chartwarden/ui";
import { type FormEvent, type JSX, useRef, useState } from "react";
import {
  CORRECTION_REASON_LABELS,
  DRESSING_LABELS,
  EXUDATE_AMOUNT_LABELS,
  EXUDATE_TYPE_LABELS,
  ODOR_LABELS,
  PERIWOUND_LABELS,
  STAGE_LABELS,
  TREND_LABELS,
  WOUND_BED_LABELS,
  optionsOf,
} from "./wound-labels";
import {
  EMPTY_DRAFT,
  MAX_PAIN_SCORE,
  type ObservationDraft,
  type TriState,
  correctBodyOf,
  draftAreaCm2,
  draftFromObservation,
  draftProblems,
  recordBodyOf,
  togglePeriwound,
} from "./wound-observation-draft";
import {
  type CorrectionReason,
  type WoundObservation,
  type WoundView,
  correctObservation,
  recordObservation,
} from "./wounds-api";

const NOT_RECORDED = { value: "", label: "Not recorded" } as const;
const withNotRecorded = <C extends string>(options: readonly { value: C; label: string }[]) => [
  NOT_RECORDED,
  ...options,
];
const TRI_OPTIONS = [NOT_RECORDED, { value: "yes", label: "Yes" }, { value: "no", label: "No" }];
const PAIN_OPTIONS = [
  NOT_RECORDED,
  ...Array.from({ length: MAX_PAIN_SCORE + 1 }, (_, n) => ({
    value: String(n),
    label: n === 0 ? "0 (no pain)" : n === MAX_PAIN_SCORE ? `${n} (worst pain)` : String(n),
  })),
];
const REASON_OPTIONS = [
  { value: "", label: "Choose a reason" },
  ...optionsOf(CORRECTION_REASON_LABELS),
];

export interface WoundObservationFormProps {
  readonly patientId: string;
  readonly wound: WoundView;
  /** The visit this observation is made at (sent as `sourceEncounterId`). Absent for an observation made outside a visit. */
  readonly sourceEncounterId?: string;
  /** When present the form CORRECTS this observation: it opens on its values and asks for a coded reason. */
  readonly correcting?: WoundObservation;
  /** Fires with the saved observation (the new one, for a correction). */
  readonly onSaved: (observation: WoundObservation) => void;
  readonly onCancel: () => void;
  /** Fires true while the write is in flight and false once it settles, so a host can keep itself open until then. */
  readonly onBusyChange?: (busy: boolean) => void;
  /** Fires with a refusal of the write, after the form has shown it (and kept what was typed), so a host can re-read what moved. */
  readonly onRefused?: (failure: OpsFailure) => void;
}

interface FindingGroupProps<C extends string> {
  readonly legend: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly options: readonly { value: C; label: string }[];
  readonly selected: readonly C[];
  readonly disabled: boolean;
  readonly onToggle: (value: C) => void;
}

/** A group of yes-if-present findings. There is no kit checkbox, so the native one sits in the kit's `wx-action-check` row. */
function FindingGroup<C extends string>({
  legend,
  hint,
  error,
  options,
  selected,
  disabled,
  onToggle,
}: FindingGroupProps<C>): JSX.Element {
  return (
    <fieldset className="wx-form-stack">
      <legend>{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className="wx-action-check">
          <input
            type="checkbox"
            checked={selected.includes(option.value)}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            onChange={() => onToggle(option.value)}
          />
          {option.label}
        </label>
      ))}
      {hint ? <span className="wx-text-muted">{hint}</span> : null}
      {error ? (
        <span role="alert" className="wx-text-error">
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}

export function WoundObservationForm({
  patientId,
  wound,
  sourceEncounterId,
  correcting,
  onSaved,
  onCancel,
  onBusyChange,
  onRefused,
}: WoundObservationFormProps): JSX.Element {
  const client = useApiClient();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<ObservationDraft>(
    correcting ? draftFromObservation(correcting) : EMPTY_DRAFT,
  );
  const [reason, setReason] = useState<CorrectionReason | "">("");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<OpsFailure | null>(null);

  const isPressureInjury = wound.etiology === "pressure_injury";
  // Hints show once Save was pressed: a depth typed before its length is not yet a mistake.
  const problems = attempted ? draftProblems(draft, wound.etiology) : {};
  const reasonError =
    attempted && correcting && reason === "" ? "Choose why this is corrected." : undefined;
  const area = draftAreaCm2(draft);
  const set = <K extends keyof ObservationDraft>(key: K, value: ObservationDraft[K]): void =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setAttempted(true);
    const needsReason = correcting !== undefined && reason === "";
    if (needsReason || !isValid(draftProblems(draft, wound.etiology))) {
      focusFirstInvalid(formRef.current);
      return;
    }
    setBusy(true);
    onBusyChange?.(true);
    setFailure(null);
    const result = correcting
      ? await correctObservation(
          client,
          patientId,
          wound.id,
          correcting,
          correctBodyOf(
            draft,
            wound.etiology,
            reason as CorrectionReason,
            correcting.sourceEncounterId,
          ),
        )
      : await recordObservation(
          client,
          patientId,
          wound.id,
          recordBodyOf(draft, wound.etiology, sourceEncounterId),
        );
    setBusy(false);
    onBusyChange?.(false);
    if (!result.ok) {
      setFailure(result.failure);
      onRefused?.(result.failure);
      return;
    }
    onSaved(result.value);
  }

  return (
    <form
      ref={formRef}
      className="wx-form-stack"
      noValidate
      aria-busy={busy}
      aria-label={correcting ? "Correct observation" : "Record observation"}
      onSubmit={(event) => void submit(event)}
    >
      {correcting ? (
        <SelectField
          label="Reason for the correction"
          required
          value={reason}
          options={REASON_OPTIONS}
          error={reasonError}
          hint="The original stays on the record, marked as corrected."
          disabled={busy}
          onChange={(event) => setReason(event.target.value as CorrectionReason | "")}
        />
      ) : null}

      {isPressureInjury ? (
        <SelectField
          label="Pressure injury stage"
          value={draft.stage}
          options={withNotRecorded(optionsOf(STAGE_LABELS))}
          error={problems.stage}
          disabled={busy}
          onChange={(event) => set("stage", event.target.value as ObservationDraft["stage"])}
        />
      ) : null}

      <fieldset className="wx-form-stack">
        <legend>Size</legend>
        <div className="wx-form-grid">
          <TextField
            label="Length (cm)"
            inputMode="decimal"
            value={draft.lengthCm}
            error={problems.lengthCm}
            disabled={busy}
            onChange={(event) => set("lengthCm", event.target.value)}
          />
          <TextField
            label="Width (cm)"
            inputMode="decimal"
            value={draft.widthCm}
            error={problems.widthCm}
            disabled={busy}
            onChange={(event) => set("widthCm", event.target.value)}
          />
          <TextField
            label="Depth (cm)"
            inputMode="decimal"
            value={draft.depthCm}
            error={problems.depthCm}
            hint="Needs the length and the width."
            disabled={busy}
            onChange={(event) => set("depthCm", event.target.value)}
          />
          <SelectField
            label="Undermining"
            value={draft.undermining}
            options={TRI_OPTIONS}
            disabled={busy}
            onChange={(event) => set("undermining", event.target.value as TriState)}
          />
        </div>
        {area === null ? (
          <span className="wx-text-muted">
            Measurements are in centimetres, to one decimal place.
          </span>
        ) : (
          <span className="wx-text-muted">Area {area} cm² (length × width).</span>
        )}
      </fieldset>

      <fieldset className="wx-form-stack">
        <legend>Wound bed and drainage</legend>
        <FindingGroup
          legend="Wound bed"
          options={optionsOf(WOUND_BED_LABELS)}
          selected={draft.woundBed}
          disabled={busy}
          onToggle={(tissue) =>
            set(
              "woundBed",
              draft.woundBed.includes(tissue)
                ? draft.woundBed.filter((t) => t !== tissue)
                : [...draft.woundBed, tissue],
            )
          }
        />
        <div className="wx-form-grid">
          <SelectField
            label="Drainage amount"
            value={draft.exudateAmount}
            options={withNotRecorded(optionsOf(EXUDATE_AMOUNT_LABELS))}
            disabled={busy}
            onChange={(event) =>
              set("exudateAmount", event.target.value as ObservationDraft["exudateAmount"])
            }
          />
          <SelectField
            label="Drainage type"
            value={draft.exudateType}
            options={withNotRecorded(optionsOf(EXUDATE_TYPE_LABELS))}
            disabled={busy}
            onChange={(event) =>
              set("exudateType", event.target.value as ObservationDraft["exudateType"])
            }
          />
          <SelectField
            label="Odor"
            value={draft.odor}
            options={withNotRecorded(optionsOf(ODOR_LABELS))}
            disabled={busy}
            onChange={(event) => set("odor", event.target.value as ObservationDraft["odor"])}
          />
        </div>
      </fieldset>

      <FindingGroup
        legend="Skin around the wound"
        hint="Intact skin cannot be combined with another finding."
        error={problems.periwound}
        options={optionsOf(PERIWOUND_LABELS)}
        selected={draft.periwound}
        disabled={busy}
        onToggle={(condition) => set("periwound", togglePeriwound(draft.periwound, condition))}
      />

      <fieldset className="wx-form-stack">
        <legend>Pain, infection and trend</legend>
        <div className="wx-form-grid">
          <SelectField
            label="Pain at the wound"
            value={draft.painScore}
            options={PAIN_OPTIONS}
            disabled={busy}
            onChange={(event) => set("painScore", event.target.value)}
          />
          <SelectField
            label="Signs of infection"
            value={draft.infectionSigns}
            options={TRI_OPTIONS}
            disabled={busy}
            onChange={(event) => set("infectionSigns", event.target.value as TriState)}
          />
          <SelectField
            label="Trend"
            value={draft.trend}
            options={withNotRecorded(optionsOf(TREND_LABELS))}
            disabled={busy}
            onChange={(event) => set("trend", event.target.value as ObservationDraft["trend"])}
          />
        </div>
      </fieldset>

      <fieldset className="wx-form-stack">
        <legend>Dressing</legend>
        <div className="wx-form-grid">
          <SelectField
            label="Dressing changed at this visit"
            value={draft.dressingChanged}
            options={TRI_OPTIONS}
            disabled={busy}
            onChange={(event) => set("dressingChanged", event.target.value as TriState)}
          />
          <SelectField
            label="Dressing"
            required={draft.dressingChanged === "yes"}
            value={draft.dressing}
            options={withNotRecorded(optionsOf(DRESSING_LABELS))}
            error={problems.dressing}
            disabled={busy}
            onChange={(event) =>
              set("dressing", event.target.value as ObservationDraft["dressing"])
            }
          />
        </div>
      </fieldset>

      {problems.findings ? <InlineAlert tone="error">{problems.findings}</InlineAlert> : null}
      {failure ? <WriteFailureNotice failure={failure} /> : null}

      <div className="wx-action-row is-end">
        <Button tone="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={busy}>
          {correcting ? "Save correction" : "Record observation"}
        </Button>
      </div>
    </form>
  );
}
