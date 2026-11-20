// apps/web/src/modules/08-encounters — the "Which fall?" choice beside the follow-up-after-a-fall visit reason (WF09).
import { SelectField } from "@chartwarden/ui";
import type { JSX } from "react";
import { humanize } from "./compose-text";
import type { FallIncidentsView } from "./encounters-api";

export interface FallLinkFieldProps {
  readonly choices: FallIncidentsView | null;
  readonly linked: { incidentId: string; occurredOn: string } | null;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onChange: (incidentId: string | null) => void;
}

/**
 * The recorded fall a follow-up-after-a-fall visit follows up (WF09). Picking one links it, and the note states its date; leaving it
 * unlinked is a complete note too, so a patient with no recorded fall, or a register that cannot be read, never blocks the reason.
 */
export function FallLinkField({
  choices,
  linked,
  value,
  disabled,
  onChange,
}: FallLinkFieldProps): JSX.Element {
  const incidents = choices?.incidents ?? [];
  // A fall linked earlier that the list no longer offers (older than the window) stays selectable, so saving does not drop it.
  const keptLink =
    linked !== null && !incidents.some((f) => f.incidentId === linked.incidentId) ? linked : null;
  const hint =
    choices === null
      ? "Loading the patient's recorded falls…"
      : choices.unavailable
        ? "Recorded falls could not be loaded. The reason is saved without a link; describe the fall in the notes below."
        : incidents.length === 0 && keptLink === null
          ? "No fall is recorded for this patient in the 90 days before this visit. Describe it in the notes below."
          : "Choose the recorded fall this visit follows up. The note states its date.";

  return (
    <>
      <SelectField
        label="Which fall?"
        value={value ?? ""}
        disabled={disabled || choices === null}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        options={[
          { value: "", label: "No fall linked" },
          ...incidents.map((f) => ({
            value: f.incidentId,
            label: `${f.occurredOn} — ${humanize(f.severity)}`,
          })),
          ...(keptLink === null
            ? []
            : [{ value: keptLink.incidentId, label: `${keptLink.occurredOn} — linked earlier` }]),
        ]}
      />
      <p className="wx-form-hint">{hint}</p>
    </>
  );
}
