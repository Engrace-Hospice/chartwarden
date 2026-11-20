// apps/web/src/modules/09-assessments/wounds — close a wound as healed or resolved for another reason. One-way: a closed
// wound takes no more observations, so the form says so before it is saved. The date closed defaults to today on the
// server; the clinician sets it only when the wound closed on an earlier day.
import {
  Button,
  InlineAlert,
  SelectField,
  TextField,
  WriteFailureNotice,
  useApiClient,
} from "@chartwarden/ui";
import type { OpsFailure } from "@chartwarden/ui";
import { type FormEvent, type JSX, useState } from "react";
import { RESOLUTION_LABELS, optionsOf } from "./wound-labels";
import { type WoundResolution, type WoundView, resolveWound } from "./wounds-api";

export interface WoundResolveFormProps {
  readonly patientId: string;
  readonly wound: WoundView;
  readonly onResolved: (wound: WoundView) => void;
  readonly onCancel: () => void;
  /** Fires true while the write is in flight and false once it settles, so a host can keep itself open until then. */
  readonly onBusyChange?: (busy: boolean) => void;
}

export function WoundResolveForm({
  patientId,
  wound,
  onResolved,
  onCancel,
  onBusyChange,
}: WoundResolveFormProps): JSX.Element {
  const client = useApiClient();
  const [status, setStatus] = useState<WoundResolution>("healed");
  const [closedOn, setClosedOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<OpsFailure | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    onBusyChange?.(true);
    setFailure(null);
    const result = await resolveWound(client, patientId, wound.id, {
      status,
      ...(closedOn === "" ? {} : { closedOn }),
    });
    setBusy(false);
    onBusyChange?.(false);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    onResolved(result.value);
  }

  return (
    <form
      className="wx-form-stack"
      noValidate
      aria-busy={busy}
      aria-label="Close this wound"
      onSubmit={(event) => void submit(event)}
    >
      <InlineAlert tone="warning">
        Closing a wound cannot be undone. It takes no more observations; its history stays on the
        record.
      </InlineAlert>
      <SelectField
        label="Outcome"
        value={status}
        options={optionsOf(RESOLUTION_LABELS)}
        disabled={busy}
        onChange={(event) => setStatus(event.target.value as WoundResolution)}
      />
      <TextField
        label="Date closed"
        type="date"
        value={closedOn}
        hint="Leave blank to use today."
        disabled={busy}
        onChange={(event) => setClosedOn(event.target.value)}
      />
      {failure ? <WriteFailureNotice failure={failure} /> : null}
      <div className="wx-action-row is-end">
        <Button tone="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" tone="danger" loading={busy}>
          Close wound
        </Button>
      </div>
    </form>
  );
}
