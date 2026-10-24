import { Button, SelectField, StatusPill, TextField, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — one appointment of representative in the right rail (milestone 13a). The signed copy
// is an M22 document the server validates against the patient and the document's ACTIVE version before linking; the
// element checklist is the organization's own form version; a SECOND person with a fresh step-up activates (the database
// decides it atomically, this screen only explains why the button is off). A refused or stale action keeps every typed value
// and reloads the record; the step-up round trip sends the user to /step-up and back.
import { useId, useState } from "react";
import type { JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  BlockedReason,
  ButtonRow,
  ErrorAlert,
  Facts,
  Hint,
  PhiNotice,
  WarningAlert,
} from "./action-ui";
import {
  type Appointment,
  REPRESENTATIVE_KINDS,
  activateAppointment,
  attachAppointmentDocument,
  confirmAppointmentElements,
  patchAppointment,
  revokeAppointment,
} from "./beneficiary-api";
import {
  APPOINTMENT_GRANTS_NOTHING,
  VALIDITY_NOT_RECORDED,
  VALIDITY_PASSED,
  activationBlockedReason,
} from "./beneficiary-copy";
import { type WriteResult, isUuid } from "./remittance-api";
import { REPRESENTATIVE_STATUS_TONE, formatDay, humanize, toneOf } from "./remittance-status";

export interface AppointmentDetailProps {
  readonly appointment: Appointment;
  readonly canManage: boolean;
  readonly canVerify: boolean;
  readonly onChanged: () => void;
}

export function AppointmentDetail({
  appointment: a,
  canManage,
  canVerify,
  onChanged,
}: AppointmentDetailProps): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const reasonId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Typed values live here, not in the record, so a reload after a conflict never overwrites them.
  const [name, setName] = useState(a.representativeName);
  const [kind, setKind] = useState(a.representativeKind);
  const [relationship, setRelationship] = useState(a.relationshipLabel ?? "");
  const [beneficiarySignedOn, setBeneficiarySignedOn] = useState(a.beneficiarySignedOn ?? "");
  const [representativeSignedOn, setRepresentativeSignedOn] = useState(
    a.representativeSignedOn ?? "",
  );
  const [validThroughOn, setValidThroughOn] = useState(a.validThroughOn ?? "");
  const [validitySource, setValiditySource] = useState(a.validitySourceNote ?? "");
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(
    () => new Set(a.elements.filter((e) => e.state === "confirmed").map((e) => e.label)),
  );
  const [documentId, setDocumentId] = useState("");
  const [documentVersionId, setDocumentVersionId] = useState("");
  const [revokedOn, setRevokedOn] = useState("");
  const [revokeNote, setRevokeNote] = useState("");

  const isDraft = a.state === "draft";
  const editable = canManage && isDraft;
  const recordedByMe = session?.membershipId === a.recordedByMembershipId;
  const missing = a.elements.filter((e) => e.state !== "confirmed").length;
  const activateWhy = activationBlockedReason({
    recordedByMe,
    hasDocument: a.documentId !== null,
    elementsMissing: missing,
  });
  const docWhy = !isUuid(documentId)
    ? "Enter the document's ID."
    : !isUuid(documentVersionId)
      ? "Enter the version ID of the uploaded copy."
      : null;
  const revokeWhy =
    revokedOn === ""
      ? "Enter the date the revocation was received."
      : revokeNote.trim() === ""
        ? "Say how the revocation was received."
        : null;
  const validityWhy =
    (validThroughOn === "") !== (validitySource.trim() === "")
      ? "Record the validity end together with where it is stated, or neither."
      : null;
  const saveWhy = name.trim() === "" ? "Enter the representative's name." : validityWhy;

  async function run<T>(act: () => Promise<WriteResult<T>>): Promise<boolean> {
    setBusy(true);
    setError(null);
    const res = await act();
    setBusy(false);
    if (res.ok) {
      onChanged();
      return true;
    }
    if (res.stepUp) {
      navigate(`/step-up?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
      return false;
    }
    setError(res.message);
    // The record moved under us: read it again; what was typed stays so the retry carries the new version.
    if (res.status === 409) onChanged();
    return false;
  }

  const toggle = (label: string, on: boolean): void => {
    const next = new Set(confirmed);
    if (on) next.add(label);
    else next.delete(label);
    setConfirmed(next);
  };

  return (
    <>
      <h3 className="wx-action-title">
        {a.representativeName}{" "}
        <StatusPill
          label={
            a.status === "validity_end_passed_as_recorded"
              ? "Validity end passed"
              : humanize(a.status)
          }
          tone={toneOf(REPRESENTATIVE_STATUS_TONE, a.status)}
        />
      </h3>
      <Hint>{APPOINTMENT_GRANTS_NOTHING}</Hint>
      <Facts
        items={[
          [
            "Instrument",
            a.formLabel ??
              (a.instrumentKind === "org_form"
                ? "Organization form"
                : "Another written instrument"),
          ],
          ["Kind", humanize(a.representativeKind)],
          ["Relationship", a.relationshipLabel ?? "—"],
          [
            "Beneficiary signed",
            a.beneficiarySignedOn ? formatDay(a.beneficiarySignedOn) : "Not entered",
          ],
          [
            "Representative signed",
            a.representativeSignedOn ? formatDay(a.representativeSignedOn) : "Not entered",
          ],
          [
            "Validity end",
            a.validThroughOn
              ? `${formatDay(a.validThroughOn)} (as typed: ${a.validitySourceNote ?? "no source"})`
              : VALIDITY_NOT_RECORDED,
          ],
          ["Signed document", a.documentId ? "Attached (version pinned)" : "None attached"],
          ["Recorded by you", recordedByMe ? "Yes" : "No"],
        ]}
      />
      {a.status === "validity_end_passed_as_recorded" ? (
        <WarningAlert>{VALIDITY_PASSED}</WarningAlert>
      ) : null}
      {a.state === "revoked" ? (
        <WarningAlert>
          Revoked on {formatDay(a.revokedOn)}: {a.revocationNote}
        </WarningAlert>
      ) : null}

      {a.elements.length > 0 ? (
        <fieldset disabled={!editable || busy}>
          <legend className="wx-action-title">
            Required elements (your organization's form version)
          </legend>
          {a.elements.map((e) => (
            <label key={e.label} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={confirmed.has(e.label)}
                onChange={(ev) => toggle(e.label, ev.target.checked)}
              />
              <span>{e.label}</span>
            </label>
          ))}
          {editable ? (
            <ButtonRow>
              <Button
                size="sm"
                tone="secondary"
                onClick={() =>
                  void run(() => confirmAppointmentElements(client, a, [...confirmed]))
                }
              >
                Save checklist
              </Button>
            </ButtonRow>
          ) : null}
        </fieldset>
      ) : null}

      {editable ? (
        <section aria-label="Edit the draft">
          <TextField
            label="Representative's name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
          />
          <SelectField
            label="Representative kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            options={REPRESENTATIVE_KINDS.map((k) => ({ value: k, label: humanize(k) }))}
          />
          <TextField
            label="Relationship"
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
          <PhiNotice />
          {saveWhy ? <BlockedReason id={`${reasonId}-save`}>{saveWhy}</BlockedReason> : null}
          <ButtonRow>
            <Button
              size="sm"
              disabled={busy || saveWhy !== null}
              aria-describedby={saveWhy ? `${reasonId}-save` : undefined}
              onClick={() =>
                void run(() =>
                  patchAppointment(client, a, {
                    representativeName: name.trim(),
                    representativeKind: kind as (typeof REPRESENTATIVE_KINDS)[number],
                    relationshipLabel: relationship.trim() || null,
                    beneficiarySignedOn: beneficiarySignedOn || null,
                    representativeSignedOn: representativeSignedOn || null,
                    validThroughOn: validThroughOn || null,
                    validitySourceNote: validThroughOn ? validitySource.trim() : null,
                  }),
                )
              }
            >
              Save changes
            </Button>
          </ButtonRow>

          <h4 className="wx-action-title">Signed appointment document</h4>
          <TextField
            label="Document ID"
            value={documentId}
            onChange={(e) => setDocumentId(e.target.value)}
          />
          <TextField
            label="Version ID of the uploaded copy"
            value={documentVersionId}
            onChange={(e) => setDocumentVersionId(e.target.value)}
          />
          {docWhy ? <BlockedReason id={`${reasonId}-doc`}>{docWhy}</BlockedReason> : null}
          <Hint>
            Upload the signed copy to the patient's documents first. It must be that patient's
            current version; other patients' and restricted documents are refused.
          </Hint>
          <ButtonRow>
            <Button
              size="sm"
              tone="secondary"
              disabled={busy || docWhy !== null}
              aria-describedby={docWhy ? `${reasonId}-doc` : undefined}
              onClick={() =>
                void run(() =>
                  attachAppointmentDocument(client, a, {
                    documentId: documentId.trim(),
                    documentVersionId: documentVersionId.trim(),
                  }),
                )
              }
            >
              Attach document
            </Button>
          </ButtonRow>
        </section>
      ) : null}

      {canVerify && isDraft ? (
        <section aria-label="Activate">
          <h4 className="wx-action-title">Activate</h4>
          <Hint>A second person activates an appointment, with a fresh step-up verification.</Hint>
          {activateWhy ? (
            <BlockedReason id={`${reasonId}-activate`}>{activateWhy}</BlockedReason>
          ) : null}
          <ButtonRow>
            <Button
              size="sm"
              disabled={busy || activateWhy !== null}
              aria-describedby={activateWhy ? `${reasonId}-activate` : undefined}
              onClick={() => void run(() => activateAppointment(client, a))}
            >
              {busy ? "Working…" : "Activate appointment"}
            </Button>
          </ButtonRow>
        </section>
      ) : null}

      {canVerify && (isDraft || a.state === "active") ? (
        <section aria-label="Revoke">
          <h4 className="wx-action-title">
            {isDraft ? "Discard this draft" : "Record a revocation"}
          </h4>
          <TextField
            label="Revocation received on"
            type="date"
            value={revokedOn}
            onChange={(e) => setRevokedOn(e.target.value)}
          />
          <TextField
            label="How it was received (note)"
            value={revokeNote}
            onChange={(e) => setRevokeNote(e.target.value)}
            maxLength={1000}
          />
          {revokeWhy ? <BlockedReason id={`${reasonId}-revoke`}>{revokeWhy}</BlockedReason> : null}
          <ButtonRow>
            <Button
              size="sm"
              tone="danger"
              disabled={busy || revokeWhy !== null}
              aria-describedby={revokeWhy ? `${reasonId}-revoke` : undefined}
              onClick={() =>
                void run(() => revokeAppointment(client, a, { revokedOn, note: revokeNote.trim() }))
              }
            >
              {isDraft ? "Discard draft" : "Record revocation"}
            </Button>
          </ButtonRow>
        </section>
      ) : null}
      <ErrorAlert message={error} />
    </>
  );
}
