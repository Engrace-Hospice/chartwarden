import { LoadingSpinner, SelectField, TextField, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — record an appeal the beneficiary (or their representative) filed (milestone 13a).
// ChartWarden RECORDS it; it computes no deadline and files nothing. The tier is the label the notice uses; every date is
// typed; nothing is pre-chosen (filer and level start at "Choose..."). Only ACTIVE appointments of this patient can be linked.
// A representative filer without an appointment on file is allowed and shows as a visible gap, but only after the appointment
// list actually loaded: if it failed the form says so and waits for a Retry, so "unlinked" is never recorded by accident.
// A refusal keeps everything typed.
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { ActionModal, ErrorAlert, FormButtons, Hint, PhiNotice, RetryAlert } from "./action-ui";
import {
  FILER_KINDS,
  TIER_LABELS,
  loadAppointments,
  recordBeneficiaryAppeal,
} from "./beneficiary-api";
import { RECORDS_NOT_FILES } from "./beneficiary-copy";
import { humanize } from "./remittance-status";
import { useGuardedLoad } from "./use-guarded-load";

const CHOOSE = { value: "", label: "Choose..." };

export function BeneficiaryIntakeModal(props: {
  readonly claimId: string;
  /** Holds representative.read: the appointments of this patient can be offered for linking. */
  readonly canReadAppointments: boolean;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}): JSX.Element {
  const client = useApiClient();
  const load = useCallback(
    () =>
      props.canReadAppointments
        ? loadAppointments(client, props.claimId)
        : Promise.resolve({ ok: true as const, value: null }),
    [client, props.claimId, props.canReadAppointments],
  );
  const appointments = useGuardedLoad(load);
  const [filerKind, setFilerKind] = useState("");
  const [tierLabel, setTierLabel] = useState("");
  const [filedOn, setFiledOn] = useState("");
  const [reference, setReference] = useState("");
  const [sourceNote, setSourceNote] = useState("");
  const [appointmentId, setAppointmentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const needsAppointments = filerKind === "representative" && props.canReadAppointments;
  const loading = needsAppointments && appointments.data === null && appointments.error === null;
  const loadFailed = needsAppointments && appointments.data === null && appointments.error !== null;
  const active = (appointments.data?.items ?? []).filter((a) => a.state === "active");

  const reason =
    filerKind === ""
      ? "Choose who filed the appeal."
      : tierLabel === ""
        ? "Choose the level the notice names."
        : sourceNote.trim() === ""
          ? "Say how the hospice learned of this appeal."
          : loading
            ? "Waiting for the appointments to load."
            : loadFailed
              ? "The appointments could not be loaded; retry before recording, so an existing appointment is not missed."
              : null;

  async function submit(): Promise<void> {
    if (reason !== null || busy) return;
    setBusy(true);
    setError(null);
    const res = await recordBeneficiaryAppeal(client, props.claimId, {
      filerKind: filerKind as (typeof FILER_KINDS)[number],
      tierLabel: tierLabel as (typeof TIER_LABELS)[number],
      sourceNote: sourceNote.trim(),
      ...(filedOn ? { filedOn } : {}),
      ...(reference.trim() ? { externalReference: reference.trim() } : {}),
      ...(filerKind === "representative" && appointmentId
        ? { representativeAppointmentId: appointmentId }
        : {}),
    });
    if (!mounted.current) return;
    setBusy(false);
    if (!res.ok) setError(res.message);
    else props.onCreated();
  }

  return (
    <ActionModal ariaLabel="Record a beneficiary-filed appeal" onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Hint>{RECORDS_NOT_FILES}</Hint>
        <SelectField
          label="Filed by"
          value={filerKind}
          onChange={(e) => setFilerKind(e.target.value)}
          options={[CHOOSE, ...FILER_KINDS.map((k) => ({ value: k, label: humanize(k) }))]}
        />
        <SelectField
          label="Level (as the notice names it)"
          value={tierLabel}
          onChange={(e) => setTierLabel(e.target.value)}
          options={[CHOOSE, ...TIER_LABELS.map((k) => ({ value: k, label: humanize(k) }))]}
        />
        <TextField
          label="Filed on (if known)"
          type="date"
          value={filedOn}
          onChange={(e) => setFiledOn(e.target.value)}
        />
        <TextField
          label="Reference (as printed)"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          maxLength={200}
        />
        <TextField
          label="How the hospice learned of it"
          value={sourceNote}
          onChange={(e) => setSourceNote(e.target.value)}
          maxLength={1000}
        />
        {loading ? <LoadingSpinner /> : null}
        {loadFailed ? (
          <RetryAlert
            message={`Appointments unavailable: ${appointments.error}`}
            onRetry={() => void appointments.load()}
          />
        ) : null}
        {needsAppointments && appointments.data !== null ? (
          <SelectField
            label="Appointment of representative (active only)"
            value={appointmentId}
            onChange={(e) => setAppointmentId(e.target.value)}
            options={[
              { value: "", label: "None on file yet" },
              ...active.map((a) => ({
                value: a.id,
                label: `${a.representativeName} (${humanize(a.status)})`,
              })),
            ]}
          />
        ) : null}
        {filerKind === "representative" && appointmentId === "" && !loading && !loadFailed ? (
          <Hint>No appointment will be linked; this appeal will show "none on file".</Hint>
        ) : null}
        <PhiNotice />
        <ErrorAlert message={error} />
        <FormButtons
          submitLabel="Record appeal"
          busy={busy}
          blocked={reason !== null}
          blockedReason={reason ?? undefined}
          asFormSubmit
          onSubmit={() => void submit()}
          onCancel={props.onClose}
        />
      </form>
    </ActionModal>
  );
}
