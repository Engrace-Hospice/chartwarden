// apps/web/src/modules/08-encounters/findings — the ADL section of the visit note (WF09).
//
//   GET|PUT /api/v1/encounters/{encounterId}/adl
//
// Seven activities each take one level of help, bladder and bowel take a continence level, and the assistive devices in use are ticked.
// Any of them may be left at "Not assessed", which is how it is stored: absent. One Save sends the WHOLE form, because the PUT replaces the
// stored record. The panel loads what is already recorded and shows it; a signed note (the `disabled` prop, or a 409 on Save) is read-only.
// Under the levels, the dependence score (how many assessed activities need hands-on help) follows the form live: an advisory for the
// clinician, derived from the form and never saved or read by the note gate.
import { statesAdlItemLevel } from "@chartwarden/types";
import { SelectField } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { type PanelStatusListener, useReportPanelStatus } from "../../../shell/panel-status";
import { AdlDependenceSummary } from "./adl-dependence-summary";
import { type AdlBody, type AdlView, loadAdl, saveAdl } from "./findings-api";
import { FindingsFrame, SaveRow } from "./findings-frame";
import {
  ADL_DEVICES,
  ADL_DEVICE_LABEL,
  ADL_ITEMS,
  ADL_ITEM_LABEL,
  ADL_LEVELS,
  ADL_LEVEL_OPTIONS,
  CONTINENCE_LEVELS,
  CONTINENCE_OPTIONS,
  codeOf,
} from "./findings-labels";
import {
  type AdlForm,
  adlBodyFromForm,
  adlFormFromView,
  adlFormSignature,
  withAdlItem,
  withDevice,
} from "./findings-model";
import { type FindingsRecord, useFindingsRecord } from "./use-findings-record";

export interface AdlPanelProps {
  readonly encounterId: string;
  /** The note cannot be edited (signed, or the caller may not author): every control is read-only. */
  readonly disabled?: boolean;
  /** Called after the ADLs were saved, so the note preview can be refreshed. */
  readonly onSaved?: () => void;
  /** Told whether the form holds unsaved input, whether a save is in flight and whether a record is stored (see `useReportPanelStatus`). */
  readonly onStatusChange?: PanelStatusListener;
}

const ignoreSaved = (): void => {};

export function AdlPanel({
  encounterId,
  disabled = false,
  onSaved = ignoreSaved,
  onStatusChange,
}: AdlPanelProps): JSX.Element {
  const record = useFindingsRecord({ encounterId, load: loadAdl, save: saveAdl, onSaved });
  return (
    <FindingsFrame
      title="Activities of daily living"
      description="Record how much help the patient needed on this visit. Leave an activity as Not assessed if it was not observed."
      loaded={record.loaded}
      onRetry={record.retry}
    >
      {record.loaded.phase === "ready" ? (
        <AdlFields
          initial={record.loaded.record}
          record={record}
          readOnly={disabled || record.locked !== null}
          onStatusChange={onStatusChange}
        />
      ) : null}
    </FindingsFrame>
  );
}

interface AdlFieldsProps {
  readonly initial: AdlView | null;
  readonly record: FindingsRecord<AdlView, AdlBody>;
  readonly readOnly: boolean;
  readonly onStatusChange: PanelStatusListener | undefined;
}

function AdlFields({ initial, record, readOnly, onStatusChange }: AdlFieldsProps): JSX.Element {
  const [form, setForm] = useState<AdlForm>(() => adlFormFromView(initial));
  // What is stored, as a form signature: the form is unsaved when it says something else.
  const [stored, setStored] = useState(() => adlFormSignature(adlFormFromView(initial)));
  // Input the note will never take (the panel locked) is shown read-only but no longer counts as unsaved: nothing could save it.
  const dirty = record.locked === null && adlFormSignature(form) !== stored;
  useReportPanelStatus(onStatusChange, {
    dirty,
    saving: record.saving,
    // A record documents its section only through an ADL level: a devices- or continence-only record is stored but states nothing,
    // and the server's gate does not count it (`statesAdlItemLevel` is the one rule both use).
    recorded: record.loaded.phase === "ready" && statesAdlItemLevel(record.loaded.record?.items),
  });
  /** Back to the record as it is stored (or as it was last saved). */
  function discard(): void {
    setForm(adlFormFromView(record.loaded.phase === "ready" ? record.loaded.record : initial));
    record.dismiss();
  }
  async function save(): Promise<void> {
    const sent = form;
    if (await record.save(adlBodyFromForm(sent))) setStored(adlFormSignature(sent));
  }
  const update = (next: AdlForm): void => {
    setForm(next);
    record.dismiss();
  };
  return (
    <>
      <fieldset className="wx-form-stack wx-fieldset-reset" disabled={readOnly}>
        <legend>Level of help needed</legend>
        <div className="wx-form-grid">
          {ADL_ITEMS.map((item) => (
            <SelectField
              key={item}
              className="wx-touch-select"
              label={ADL_ITEM_LABEL[item]}
              value={form.items[item] ?? ""}
              options={ADL_LEVEL_OPTIONS}
              onChange={(event) =>
                update(withAdlItem(form, item, codeOf(ADL_LEVELS, event.target.value)))
              }
            />
          ))}
        </div>
      </fieldset>
      <AdlDependenceSummary items={form.items} />
      <fieldset className="wx-form-stack wx-fieldset-reset" disabled={readOnly}>
        <legend>Continence</legend>
        <div className="wx-form-grid">
          <SelectField
            className="wx-touch-select"
            label="Bladder"
            value={form.bladder ?? ""}
            options={CONTINENCE_OPTIONS}
            onChange={(event) =>
              update({ ...form, bladder: codeOf(CONTINENCE_LEVELS, event.target.value) })
            }
          />
          <SelectField
            className="wx-touch-select"
            label="Bowel"
            value={form.bowel ?? ""}
            options={CONTINENCE_OPTIONS}
            onChange={(event) =>
              update({ ...form, bowel: codeOf(CONTINENCE_LEVELS, event.target.value) })
            }
          />
        </div>
      </fieldset>
      <fieldset className="wx-form-stack wx-fieldset-reset" disabled={readOnly}>
        <legend>Assistive devices in use</legend>
        <div className="wx-form-grid">
          {ADL_DEVICES.map((device) => (
            <label key={device} className="wx-action-check">
              <input
                type="checkbox"
                checked={form.devices.includes(device)}
                onChange={(event) => update(withDevice(form, device, event.target.checked))}
              />
              <span>{ADL_DEVICE_LABEL[device]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <SaveRow
        label="Save ADLs"
        savedMessage="ADLs saved."
        saving={record.saving}
        disabled={readOnly}
        saved={record.saved}
        failure={record.failure}
        locked={record.locked}
        stale={record.stale}
        onReload={record.retry}
        onDiscard={dirty ? discard : undefined}
        onSave={() => void save()}
      />
    </>
  );
}
