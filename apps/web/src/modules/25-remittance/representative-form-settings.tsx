import { Button, LoadingSpinner, TextAreaField, TextField, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — the organization's APPOINTMENT FORM VERSIONS (milestone 13a). Compliance types a
// version exactly as it is supplied (label, identifier and edition as entered, a source note, the required-element labels).
// Nothing is seeded and ChartWarden does not know or validate any form: with none entered, appointments can only be recorded
// against another written instrument. A version is frozen once saved; to change it, retire it and add a new one.
import { useCallback, useState } from "react";
import type { JSX } from "react";
import {
  ActionModal,
  ButtonRow,
  ErrorAlert,
  FormButtons,
  Hint,
  PhiNotice,
  RetryAlert,
  WarningAlert,
} from "./action-ui";
import {
  type FormVersion,
  createFormVersion,
  loadFormVersions,
  retireFormVersion,
} from "./beneficiary-api";
import { NO_FORM_CONFIGURED } from "./beneficiary-copy";
import { formatDay } from "./remittance-status";
import { useGuardedLoad } from "./use-guarded-load";

function AddModal(props: {
  readonly onClose: () => void;
  readonly onSaved: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [label, setLabel] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [edition, setEdition] = useState("");
  const [sourceNote, setSourceNote] = useState("");
  const [verifiedOn, setVerifiedOn] = useState("");
  const [elements, setElements] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = elements
    .split("\n")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  const reason =
    label.trim() === ""
      ? "Name this form version."
      : sourceNote.trim() === ""
        ? "Say where this form version came from (the compliance source)."
        : null;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await createFormVersion(client, {
      label: label.trim(),
      sourceNote: sourceNote.trim(),
      requiredElements: list,
      ...(identifier.trim() ? { formIdentifier: identifier.trim() } : {}),
      ...(edition.trim() ? { editionText: edition.trim() } : {}),
      ...(verifiedOn ? { verifiedOn } : {}),
    });
    setBusy(false);
    if (!res.ok) setError(res.message);
    else props.onSaved();
  }

  return (
    <ActionModal ariaLabel="Add an appointment form version" onClose={props.onClose}>
      <TextField
        label="Name (your organization's label)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        maxLength={200}
      />
      <TextField
        label="Form identifier (exactly as supplied)"
        value={identifier}
        onChange={(e) => setIdentifier(e.target.value)}
        maxLength={200}
      />
      <TextField
        label="Edition (exactly as supplied)"
        value={edition}
        onChange={(e) => setEdition(e.target.value)}
        maxLength={200}
      />
      <TextField
        label="Source note (who supplied it, and where)"
        value={sourceNote}
        onChange={(e) => setSourceNote(e.target.value)}
        maxLength={1000}
      />
      <TextField
        label="Verified on (optional)"
        type="date"
        value={verifiedOn}
        onChange={(e) => setVerifiedOn(e.target.value)}
      />
      <TextAreaField
        label="Required elements, one per line"
        value={elements}
        onChange={(e) => setElements(e.target.value)}
        rows={6}
      />
      <Hint>
        {list.length} element{list.length === 1 ? "" : "s"}. A person ticks each one on every
        appointment.
      </Hint>
      <PhiNotice />
      <ErrorAlert message={error} />
      <FormButtons
        submitLabel="Save form version"
        busy={busy}
        blocked={reason !== null}
        blockedReason={reason ?? undefined}
        onSubmit={() => void submit()}
        onCancel={props.onClose}
      />
    </ActionModal>
  );
}

export function RepresentativeFormSettings(): JSX.Element {
  const client = useApiClient();
  const load = useCallback(() => loadFormVersions(client), [client]);
  const { data, error, load: reload } = useGuardedLoad(load);
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function retire(f: FormVersion): Promise<void> {
    setActionError(null);
    const res = await retireFormVersion(client, f);
    if (!res.ok) {
      setActionError(res.message);
      if (res.status === 409) void reload();
    } else void reload();
  }

  if (data === null) {
    return error ? (
      <RetryAlert message={`Form versions unavailable: ${error}`} onRetry={() => void reload()} />
    ) : (
      <LoadingSpinner />
    );
  }
  const current = data.items.filter((f) => f.retiredAt === null);
  return (
    <section aria-label="Appointment form versions">
      <h2 className="wx-action-title">Appointment form versions</h2>
      <Hint>
        These are your organization's own entries. ChartWarden ships none and does not check them
        against any CMS form.
      </Hint>
      {error ? (
        <>
          <ErrorAlert message={`Form versions could not be refreshed: ${error}`} />
          <ButtonRow>
            <Button size="sm" tone="secondary" onClick={() => void reload()}>
              Retry
            </Button>
          </ButtonRow>
        </>
      ) : null}
      {current.length === 0 ? <WarningAlert>{NO_FORM_CONFIGURED}</WarningAlert> : null}
      {data.items.length > 0 ? (
        <table className="wx-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Identifier / edition</th>
              <th>Elements</th>
              <th>Source</th>
              <th>
                <span className="wx-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((f) => (
              <tr key={f.id}>
                <td>
                  {f.label}
                  {f.retiredAt ? ` (retired ${formatDay(f.retiredAt)})` : ""}
                </td>
                <td>{[f.formIdentifier, f.editionText].filter(Boolean).join(" / ") || "—"}</td>
                <td>{f.requiredElements.length}</td>
                <td>{f.sourceNote}</td>
                <td>
                  {f.retiredAt === null ? (
                    <Button
                      size="sm"
                      tone="tertiary"
                      aria-label={`Retire ${f.label}`}
                      onClick={() => void retire(f)}
                    >
                      Retire
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <ErrorAlert message={actionError} />
      <ButtonRow>
        <Button size="sm" tone="secondary" onClick={() => setAdding(true)}>
          Add a form version
        </Button>
      </ButtonRow>
      {adding ? (
        <AddModal
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            void reload();
          }}
        />
      ) : null}
    </section>
  );
}
