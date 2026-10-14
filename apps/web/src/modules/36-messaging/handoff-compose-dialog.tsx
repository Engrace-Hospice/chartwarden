// M36 WP 3.5 - start a handoff: (1) choose caseload patients, (2) review the pre-filled open work (pointers only, each
// removable; a source that could not be read is named and not offered), (3) choose a colleague and offer. Nothing is
// stored or visible to the receiver until Offer. No free text anywhere: the narrative belongs in the care-team thread.
import type { HandoffDto, HandoffItemKind } from "@wardenx/types";
import { Button, Modal } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { HandoffRecipientPicker, type Recipient } from "./handoff-recipient-picker";
import {
  CALLBACKS_NOT_INCLUDED,
  CASELOAD_UNAVAILABLE,
  CHOOSE_ITEMS_TEXT,
  CHOOSE_PATIENTS_TEXT,
  CHOOSE_RECIPIENT_TEXT,
  HANDOFF_NOTICE,
  ITEM_KIND_LABELS,
  NO_CASELOAD_TEXT,
  PATIENT_CAP_TEXT,
  UNAVAILABLE_SOURCE_TEXT,
  expirySentence,
  handoffErrorText,
} from "./handoff-wording";
import {
  type CaseloadPatient,
  type HandoffPolicy,
  type PrefillPatient,
  useHandoffComposeApi,
} from "./use-handoff-compose";
import "./tasks.css";
import "./handoffs.css";

const MAX_PATIENTS = 50;
const itemKey = (patientId: string, kind: HandoffItemKind, refId: string): string =>
  `${patientId}:${kind}:${refId}`;
const toggled = <T,>(set: ReadonlySet<T>, value: T): ReadonlySet<T> => {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
};

export interface HandoffComposeDialogProps {
  readonly meId: string;
  readonly onClose: () => void;
  readonly onOffered: (handoff: HandoffDto, created: boolean) => void;
}

type Caseload =
  | { readonly status: "loading" | "failed" }
  | { readonly status: "ready"; readonly patients: readonly CaseloadPatient[] };

export function HandoffComposeDialog({
  meId,
  onClose,
  onOffered,
}: HandoffComposeDialogProps): JSX.Element {
  const api = useHandoffComposeApi();
  const [caseload, setCaseload] = useState<Caseload>({ status: "loading" });
  const [patientIds, setPatientIds] = useState<ReadonlySet<string>>(new Set());
  const [prefill, setPrefill] = useState<readonly PrefillPatient[] | null>(null);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [policy, setPolicy] = useState<HandoffPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [patientsError, setPatientsError] = useState<string | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let current = true;
    void api.caseload().then((result) => {
      if (!current) return;
      setCaseload(
        result.ok ? { status: "ready", patients: result.data.patients } : { status: "failed" },
      );
    });
    void api.policy().then((result) => {
      if (current && result.ok) setPolicy(result.data);
    });
    return () => {
      current = false;
    };
  }, [api]);

  const patients = caseload.status === "ready" ? caseload.patients : [];
  const labelOf = (id: string): string => {
    const found = patients.find((patient) => patient.patient_id === id);
    return found
      ? `${found.display_name}${found.mrn_suffix ? ` (MRN ...${found.mrn_suffix})` : ""}`
      : "Patient";
  };

  function changePatients(next: ReadonlySet<string>): void {
    setPatientIds(next);
    setPrefill(null);
    setRemoved(new Set());
    setPatientsError(null);
  }

  function togglePatient(id: string): void {
    if (!patientIds.has(id) && patientIds.size >= MAX_PATIENTS) return;
    changePatients(toggled(patientIds, id));
  }

  async function loadOpenWork(): Promise<void> {
    if (inFlight.current) return;
    if (patientIds.size === 0) return setPatientsError(CHOOSE_PATIENTS_TEXT);
    inFlight.current = true;
    setBusy(true);
    setStatus("");
    const result = await api.prefill([...patientIds]);
    inFlight.current = false;
    setBusy(false);
    if (result.ok) {
      setPrefill(result.data.patients);
      setStatus("Open work loaded.");
    } else setPatientsError(handoffErrorText(result.status, result.code));
  }

  const chosen = (prefill ?? []).flatMap((patient) =>
    patient.items
      .filter((item) => !removed.has(itemKey(patient.patient_id, item.kind, item.ref_id)))
      .map((item) => ({ kind: item.kind, ref_id: item.ref_id, patient_id: patient.patient_id })),
  );
  const unavailable = [
    ...new Set((prefill ?? []).flatMap((patient) => patient.unavailable_sources)),
  ];

  async function offer(): Promise<void> {
    if (inFlight.current) return;
    setItemsError(null);
    setRecipientError(null);
    if (!prefill) return setPatientsError(CHOOSE_PATIENTS_TEXT);
    if (chosen.length === 0) return setItemsError(CHOOSE_ITEMS_TEXT);
    if (!recipient) {
      setRecipientError(CHOOSE_RECIPIENT_TEXT);
      searchRef.current?.focus();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    const result = await api.offer(recipient.id, chosen);
    inFlight.current = false;
    setBusy(false);
    if (result.ok) return onOffered(result.data.handoff, result.data.created);
    const text = handoffErrorText(result.status, result.code);
    if (result.code === "HANDOFF_RECIPIENT_INVALID") setRecipientError(text);
    else setItemsError(text);
  }

  return (
    <Modal open onClose={busy ? undefined : onClose} ariaLabel="Start handoff" width="40rem">
      <form
        className="wx-task-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void offer();
        }}
      >
        <h2 ref={headingRef} tabIndex={-1}>
          Start handoff
        </h2>
        <p className="wx-task-notice">{HANDOFF_NOTICE}</p>
        <output className="sr-only" aria-live="polite">
          {status}
        </output>

        <fieldset className="wx-handoff-section">
          <legend>1. Your patients</legend>
          {caseload.status === "loading" ? (
            <p className="wx-handoff-muted">Loading your caseload...</p>
          ) : null}
          {caseload.status === "failed" ? (
            <p className="wx-task-error" role="alert">
              {CASELOAD_UNAVAILABLE}
            </p>
          ) : null}
          {caseload.status === "ready" && patients.length === 0 ? (
            <p className="wx-handoff-muted">{NO_CASELOAD_TEXT}</p>
          ) : null}
          {patients.length > 0 ? (
            <>
              <button
                type="button"
                className="wx-task-link"
                onClick={() =>
                  changePatients(
                    patientIds.size > 0
                      ? new Set()
                      : new Set(patients.slice(0, MAX_PATIENTS).map((p) => p.patient_id)),
                  )
                }
              >
                {patientIds.size > 0 ? "Clear selection" : "Select all"}
              </button>
              <ul className="wx-handoff-checks wx-handoff-scroll">
                {patients.map((patient) => (
                  <li key={patient.patient_id}>
                    <label className="wx-handoff-check">
                      <input
                        type="checkbox"
                        checked={patientIds.has(patient.patient_id)}
                        disabled={
                          !patientIds.has(patient.patient_id) && patientIds.size >= MAX_PATIENTS
                        }
                        onChange={() => togglePatient(patient.patient_id)}
                      />
                      <span>{labelOf(patient.patient_id)}</span>
                    </label>
                  </li>
                ))}
              </ul>
              {patientIds.size >= MAX_PATIENTS ? (
                <p className="wx-handoff-muted">{PATIENT_CAP_TEXT}</p>
              ) : null}
              <div>
                <Button
                  type="button"
                  tone="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void loadOpenWork()}
                >
                  Load open work ({patientIds.size})
                </Button>
              </div>
            </>
          ) : null}
          {patientsError ? (
            <p className="wx-task-error" role="alert">
              {patientsError}
            </p>
          ) : null}
        </fieldset>

        {prefill ? (
          <fieldset className="wx-handoff-section">
            <legend>2. What to hand off</legend>
            {unavailable.map((kind) => (
              <p key={kind} className="wx-task-notice">
                {UNAVAILABLE_SOURCE_TEXT[kind]}
              </p>
            ))}
            <p className="wx-handoff-muted">{CALLBACKS_NOT_INCLUDED}</p>
            <div className="wx-handoff-scroll">
              {prefill.map((patient) => (
                <div key={patient.patient_id} className="wx-handoff-patient">
                  <h4>{labelOf(patient.patient_id)}</h4>
                  <ul className="wx-handoff-checks">
                    {patient.items.map((item) => {
                      const key = itemKey(patient.patient_id, item.kind, item.ref_id);
                      return (
                        <li key={key}>
                          <label className="wx-handoff-check">
                            <input
                              type="checkbox"
                              checked={!removed.has(key)}
                              onChange={() => setRemoved(toggled(removed, key))}
                            />
                            <span>
                              {ITEM_KIND_LABELS[item.kind]}
                              {item.status ? `: ${item.status.replace(/_/g, " ")}` : ""}
                              {item.occurred_at
                                ? `, ${new Date(item.occurred_at).toLocaleString()}`
                                : ""}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
            {itemsError ? (
              <p className="wx-task-error" role="alert">
                {itemsError}
              </p>
            ) : null}
          </fieldset>
        ) : null}

        {prefill ? (
          <fieldset className="wx-handoff-section">
            <legend>3. Who receives it</legend>
            <HandoffRecipientPicker
              meId={meId}
              selected={recipient}
              onSelect={(person) => {
                setRecipient(person);
                setRecipientError(null);
              }}
              error={recipientError}
              inputRef={searchRef}
            />
            {policy ? (
              <p className="wx-handoff-muted">{expirySentence(policy.expiry_minutes)}</p>
            ) : null}
          </fieldset>
        ) : null}

        <div className="wx-task-actions">
          <Button type="button" tone="secondary" disabled={busy} onClick={onClose}>
            Back
          </Button>
          {prefill ? (
            <Button type="submit" loading={busy}>
              Offer handoff ({chosen.length})
            </Button>
          ) : null}
        </div>
      </form>
    </Modal>
  );
}
