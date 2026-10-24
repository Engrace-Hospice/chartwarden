import { SelectField, TextField, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — record an appointment of representative from a claim (milestone 13a). The instrument
// is one of THIS organization's own form versions or "another written instrument"; with no form version configured the
// form says so and offers only the other instrument. Every date is typed; the validity end is typed WITH its source or
// left out. A refusal keeps everything typed. The patient and provider entity come from the claim on the server.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
  ActionModal,
  ErrorAlert,
  FormButtons,
  Hint,
  PhiNotice,
  RetryAlert,
  WarningAlert,
} from "./action-ui";
import {
  type AppointmentDraftInput,
  REPRESENTATIVE_KINDS,
  createAppointmentDraft,
  loadFormVersions,
} from "./beneficiary-api";
import { NO_FORM_CONFIGURED, VALIDITY_NOT_RECORDED } from "./beneficiary-copy";
import { humanize } from "./remittance-status";
import { useGuardedLoad } from "./use-guarded-load";

const OTHER = "__other__";

/** The first thing still missing, or null when the form is complete. */
function blockedReason(f: {
  instrument: string;
  name: string;
  kind: string;
  relationship: string;
  instrumentNote: string;
  validThroughOn: string;
  validitySource: string;
}): string | null {
  if (f.instrument === "") return "Choose the instrument this appointment was made on.";
  if (f.instrument === OTHER && f.instrumentNote.trim() === "") {
    return "Describe the other written instrument.";
  }
  if (f.name.trim() === "") return "Enter the representative's name.";
  if (f.kind === "other" && f.relationship.trim() === "") {
    return "Describe the relationship when the kind is 'other'.";
  }
  if (f.validThroughOn !== "" && f.validitySource.trim() === "") {
    return "Say where the validity end came from, or clear it.";
  }
  if (f.validThroughOn === "" && f.validitySource.trim() !== "") {
    return "Enter the validity end the source note describes, or clear the note.";
  }
  return null;
}

export function RepresentativeCreateModal(props: {
  readonly claimId: string;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}): JSX.Element {
  const client = useApiClient();
  const load = useCallback(() => loadFormVersions(client), [client]);
  const forms = useGuardedLoad(load);
  const current = (forms.data?.items ?? []).filter((f) => f.retiredAt === null);
  const [instrument, setInstrument] = useState("");
  const [instrumentNote, setInstrumentNote] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof REPRESENTATIVE_KINDS)[number]>("family_or_friend");
  const [relationship, setRelationship] = useState("");
  const [beneficiarySignedOn, setBeneficiarySignedOn] = useState("");
  const [representativeSignedOn, setRepresentativeSignedOn] = useState("");
  const [validThroughOn, setValidThroughOn] = useState("");
  const [validitySource, setValiditySource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reason = blockedReason({
    instrument,
    name,
    kind,
    relationship,
    instrumentNote,
    validThroughOn,
    validitySource,
  });

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    const body: AppointmentDraftInput = {
      ...(instrument === OTHER
        ? { instrumentKind: "other_written_instrument", instrumentNote: instrumentNote.trim() }
        : { instrumentKind: "org_form", formVersionId: instrument }),
      representativeName: name.trim(),
      representativeKind: kind,
      ...(relationship.trim() ? { relationshipLabel: relationship.trim() } : {}),
      ...(beneficiarySignedOn ? { beneficiarySignedOn } : {}),
      ...(representativeSignedOn ? { representativeSignedOn } : {}),
      ...(validThroughOn ? { validThroughOn, validitySourceNote: validitySource.trim() } : {}),
    };
    const res = await createAppointmentDraft(client, props.claimId, body);
    if (!mounted.current) return;
    setBusy(false);
    // Everything typed stays on a refusal so it can be fixed and retried.
    if (!res.ok) setError(res.message);
    else props.onCreated();
  }

  return (
    <ActionModal ariaLabel="Record an appointment of representative" onClose={props.onClose}>
      {forms.data === null && forms.error ? (
        <RetryAlert
          message={`Form versions unavailable: ${forms.error}`}
          onRetry={() => void forms.load()}
        />
      ) : null}
      {forms.data !== null && current.length === 0 ? (
        <WarningAlert>{NO_FORM_CONFIGURED}</WarningAlert>
      ) : null}
      <SelectField
        label="Instrument"
        value={instrument}
        onChange={(e) => setInstrument(e.target.value)}
        options={[
          { value: "", label: "Choose..." },
          ...current.map((f) => ({
            value: f.id,
            label: `${f.label}${f.formIdentifier ? ` (${f.formIdentifier}${f.editionText ? `, ${f.editionText}` : ""})` : ""}`,
          })),
          { value: OTHER, label: "Another written instrument" },
        ]}
      />
      {instrument === OTHER ? (
        <TextField
          label="Describe the written instrument"
          value={instrumentNote}
          onChange={(e) => setInstrumentNote(e.target.value)}
          maxLength={1000}
        />
      ) : null}
      <TextField
        label="Representative's name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={200}
      />
      <SelectField
        label="Representative kind"
        value={kind}
        onChange={(e) => setKind(e.target.value as (typeof REPRESENTATIVE_KINDS)[number])}
        options={REPRESENTATIVE_KINDS.map((k) => ({ value: k, label: humanize(k) }))}
      />
      <TextField
        label={kind === "other" ? "Relationship (required)" : "Relationship (optional)"}
        value={relationship}
        onChange={(e) => setRelationship(e.target.value)}
        maxLength={200}
      />
      <TextField
        label="Beneficiary signed on"
        type="date"
        value={beneficiarySignedOn}
        onChange={(e) => setBeneficiarySignedOn(e.target.value)}
      />
      <TextField
        label="Representative signed on"
        type="date"
        value={representativeSignedOn}
        onChange={(e) => setRepresentativeSignedOn(e.target.value)}
      />
      <TextField
        label="Validity end (only if the signed document states one)"
        type="date"
        value={validThroughOn}
        onChange={(e) => setValidThroughOn(e.target.value)}
      />
      <TextField
        label="Where the validity end is stated (source note)"
        value={validitySource}
        onChange={(e) => setValiditySource(e.target.value)}
        maxLength={1000}
      />
      {validThroughOn === "" ? (
        <Hint>{VALIDITY_NOT_RECORDED}. No end date is ever computed.</Hint>
      ) : null}
      <PhiNotice />
      <Hint>The Medicare number stays on the signed document; do not type it here.</Hint>
      <ErrorAlert message={error} />
      <FormButtons
        submitLabel="Record draft"
        busy={busy}
        blocked={reason !== null}
        blockedReason={reason ?? undefined}
        onSubmit={() => void submit()}
        onCancel={props.onClose}
      />
    </ActionModal>
  );
}
