import { Button, SelectField, StatusPill, TextField, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance — one appointment of representative in the right rail (milestone 13a). The signed copy
// is an M22 document the server validates against the patient and the document's ACTIVE version before linking; the
// element checklist is the organization's own form version; a SECOND person (not the recorder, not the last editor) with a
// fresh step-up activates, which the database decides atomically; this screen only explains why the button is off.
// A refused or stale action keeps every typed value and reloads the record behind a visible "record changed" cue. The step-up
// round trip stashes what was typed (shell/step-up-redirect) and restores it on a genuine return.
import { useId, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../../shell/session";
import {
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";
import { useStepUpOwner } from "../../shell/use-step-up-return";
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
  CHANGED_CUE,
  VALIDITY_NOT_RECORDED,
  VALIDITY_PASSED,
  activationBlockedReason,
} from "./beneficiary-copy";
import { type WriteResult, isUuid } from "./remittance-api";
import { REPRESENTATIVE_STATUS_TONE, formatDay, humanize, toneOf } from "./remittance-status";

export const REVOKE_DRAFT_ACTION = "representative-revoke";
export const EDIT_DRAFT_ACTION = "representative-edit";
export const ACTIVATE_DRAFT_ACTION = "representative-activate";
/** Every step-up draft action this drawer can stash (a module-level constant, as `useStepUpReturn` requires). */
export const REPRESENTATIVE_DRAFT_ACTIONS = [
  REVOKE_DRAFT_ACTION,
  EDIT_DRAFT_ACTION,
  ACTIVATE_DRAFT_ACTION,
] as const;

interface EditDraft {
  readonly name: string;
  readonly kind: string;
  readonly relationship: string;
  readonly beneficiarySignedOn: string;
  readonly representativeSignedOn: string;
  readonly validThroughOn: string;
  readonly validitySource: string;
  readonly confirmed: readonly string[];
}
interface RevokeDraft {
  readonly revokedOn: string;
  readonly revokeNote: string;
}

export interface AppointmentDetailProps {
  readonly appointment: Appointment;
  readonly canManage: boolean;
  readonly canVerify: boolean;
  /** True when the user is genuinely back from the step-up page: stashed drafts are restored. */
  readonly restore: boolean;
  readonly onChanged: () => void;
}

export function AppointmentDetail({
  appointment: a,
  canManage,
  canVerify,
  restore,
  onChanged,
}: AppointmentDetailProps): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const owner = useStepUpOwner();
  const navigate = useNavigate();
  const location = useLocation();
  const baseId = useId();
  const editKey = stepUpDraftKey(owner, EDIT_DRAFT_ACTION, a.id);
  const revokeKey = stepUpDraftKey(owner, REVOKE_DRAFT_ACTION, a.id);
  const activateKey = stepUpDraftKey(owner, ACTIVATE_DRAFT_ACTION, a.id);
  const [editDraft] = useState(() => (restore ? peekStepUpDraft<EditDraft>(editKey) : null));
  const [revokeDraft] = useState(() => (restore ? peekStepUpDraft<RevokeDraft>(revokeKey) : null));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changedCue, setChangedCue] = useState(false);
  // Typed values live here, not in the record, so a reload after a conflict never overwrites them.
  const [name, setName] = useState(editDraft?.name ?? a.representativeName);
  const [kind, setKind] = useState(editDraft?.kind ?? a.representativeKind);
  const [relationship, setRelationship] = useState(
    editDraft?.relationship ?? a.relationshipLabel ?? "",
  );
  const [beneficiarySignedOn, setBeneficiarySignedOn] = useState(
    editDraft?.beneficiarySignedOn ?? a.beneficiarySignedOn ?? "",
  );
  const [representativeSignedOn, setRepresentativeSignedOn] = useState(
    editDraft?.representativeSignedOn ?? a.representativeSignedOn ?? "",
  );
  const [validThroughOn, setValidThroughOn] = useState(
    editDraft?.validThroughOn ?? a.validThroughOn ?? "",
  );
  const [validitySource, setValiditySource] = useState(
    editDraft?.validitySource ?? a.validitySourceNote ?? "",
  );
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        editDraft?.confirmed ??
          a.elements.filter((e) => e.state === "confirmed").map((e) => e.label),
      ),
  );
  const [documentId, setDocumentId] = useState("");
  const [documentVersionId, setDocumentVersionId] = useState("");
  const [revokedOn, setRevokedOn] = useState(revokeDraft?.revokedOn ?? "");
  const [revokeNote, setRevokeNote] = useState(revokeDraft?.revokeNote ?? "");

  const isDraft = a.state === "draft";
  const editable = canManage && isDraft;
  const recordedByMe = session?.membershipId === a.recordedByMembershipId;
  const missing = a.elements.filter((e) => e.state !== "confirmed").length;
  const activateWhy = activationBlockedReason({
    recordedByMe,
    hasDocument: a.documentId !== null,
    elementsMissing: missing,
  });
  const docIdBad = documentId.trim() !== "" && !isUuid(documentId);
  const docVersionBad = documentVersionId.trim() !== "" && !isUuid(documentVersionId);
  const docWhy = !isUuid(documentId)
    ? "Enter the document's ID (a UUID)."
    : !isUuid(documentVersionId)
      ? "Enter the version ID of the uploaded copy (a UUID)."
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

  const clearDrafts = (): void => {
    clearStepUpDraft(editKey);
    clearStepUpDraft(revokeKey);
    clearStepUpDraft(activateKey);
  };
  const stashDrafts = (action: "revoke" | "activate"): void => {
    stashStepUpDraft(editKey, {
      name,
      kind,
      relationship,
      beneficiarySignedOn,
      representativeSignedOn,
      validThroughOn,
      validitySource,
      confirmed: [...confirmed],
    } satisfies EditDraft);
    if (action === "revoke")
      stashStepUpDraft(revokeKey, { revokedOn, revokeNote } satisfies RevokeDraft);
    else stashStepUpDraft(activateKey, {});
  };

  async function run<T>(
    act: () => Promise<WriteResult<T>>,
    stepUpFor?: "revoke" | "activate",
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    setChangedCue(false);
    const res = await act();
    setBusy(false);
    if (res.ok) {
      clearDrafts();
      onChanged();
      return true;
    }
    if (res.stepUp && stepUpFor) {
      // Stash what was typed, then verify; the drawer reopens with it on return.
      stashDrafts(stepUpFor);
      navigate(`/step-up?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
      return false;
    }
    clearDrafts();
    setError(res.message);
    if (res.status === 409) {
      // The record moved under us: read it again; what was typed stays so the retry carries the new version.
      setChangedCue(true);
      onChanged();
    }
    return false;
  }

  const submit = (fn: () => void) => (e: FormEvent) => {
    e.preventDefault();
    fn();
  };
  const toggle = (label: string, on: boolean): void => {
    const next = new Set(confirmed);
    if (on) next.add(label);
    else next.delete(label);
    setConfirmed(next);
  };
  const reasonOf = (suffix: string) => `${baseId}-${suffix}`;

  return (
    <>
      <ErrorAlert message={error} />
      {changedCue ? <WarningAlert>{CHANGED_CUE}</WarningAlert> : null}
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
        <form
          onSubmit={submit(
            () => void run(() => confirmAppointmentElements(client, a, [...confirmed])),
          )}
        >
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
                <Button size="sm" tone="secondary" type="submit">
                  Save checklist
                </Button>
              </ButtonRow>
            ) : null}
          </fieldset>
        </form>
      ) : null}

      {editable ? (
        <>
          <form
            aria-labelledby={reasonOf("edit-h")}
            onSubmit={submit(() => {
              if (saveWhy !== null || busy) return;
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
              );
            })}
          >
            <h4 className="wx-action-title" id={reasonOf("edit-h")}>
              Edit the draft
            </h4>
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
            {saveWhy ? <BlockedReason id={reasonOf("save")}>{saveWhy}</BlockedReason> : null}
            <ButtonRow>
              <Button
                size="sm"
                type="submit"
                disabled={busy || saveWhy !== null}
                aria-describedby={saveWhy ? reasonOf("save") : undefined}
              >
                Save changes
              </Button>
            </ButtonRow>
          </form>

          <form
            aria-labelledby={reasonOf("doc-h")}
            onSubmit={submit(() => {
              if (docWhy !== null || busy) return;
              void run(() =>
                attachAppointmentDocument(client, a, {
                  documentId: documentId.trim(),
                  documentVersionId: documentVersionId.trim(),
                }),
              ).then((okay) => {
                if (okay) {
                  setDocumentId("");
                  setDocumentVersionId("");
                }
              });
            })}
          >
            <h4 className="wx-action-title" id={reasonOf("doc-h")}>
              Signed appointment document
            </h4>
            <TextField
              label="Document ID"
              value={documentId}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setDocumentId(e.target.value)}
              error={docIdBad ? "Enter the document's UUID." : undefined}
            />
            <TextField
              label="Version ID of the uploaded copy"
              value={documentVersionId}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setDocumentVersionId(e.target.value)}
              error={docVersionBad ? "Enter the version's UUID." : undefined}
            />
            {docWhy ? <BlockedReason id={reasonOf("doc")}>{docWhy}</BlockedReason> : null}
            <Hint>
              Upload the signed copy to the patient's documents first. It must be that patient's
              current version; other patients' and restricted documents are refused.
            </Hint>
            <ButtonRow>
              <Button
                size="sm"
                tone="secondary"
                type="submit"
                disabled={busy || docWhy !== null}
                aria-describedby={docWhy ? reasonOf("doc") : undefined}
              >
                Attach document
              </Button>
            </ButtonRow>
          </form>
        </>
      ) : null}

      {canVerify && isDraft ? (
        <form
          aria-labelledby={reasonOf("act-h")}
          onSubmit={submit(() => {
            if (activateWhy !== null || busy) return;
            void run(() => activateAppointment(client, a), "activate");
          })}
        >
          <h4 className="wx-action-title" id={reasonOf("act-h")}>
            Activate
          </h4>
          <Hint>
            A second person activates an appointment, with a fresh step-up verification. Neither the
            person who recorded it nor the person who last edited it can.
          </Hint>
          {activateWhy ? (
            <BlockedReason id={reasonOf("activate")}>{activateWhy}</BlockedReason>
          ) : null}
          <ButtonRow>
            <Button
              size="sm"
              type="submit"
              disabled={busy || activateWhy !== null}
              aria-describedby={activateWhy ? reasonOf("activate") : undefined}
            >
              {busy ? "Working…" : "Activate appointment"}
            </Button>
          </ButtonRow>
        </form>
      ) : null}

      {canVerify && (isDraft || a.state === "active") ? (
        <form
          aria-labelledby={reasonOf("rev-h")}
          onSubmit={submit(() => {
            if (revokeWhy !== null || busy) return;
            void run(
              () => revokeAppointment(client, a, { revokedOn, note: revokeNote.trim() }),
              "revoke",
            );
          })}
        >
          <h4 className="wx-action-title" id={reasonOf("rev-h")}>
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
          {revokeWhy ? <BlockedReason id={reasonOf("revoke")}>{revokeWhy}</BlockedReason> : null}
          <ButtonRow>
            <Button
              size="sm"
              tone="danger"
              type="submit"
              disabled={busy || revokeWhy !== null}
              aria-describedby={revokeWhy ? reasonOf("revoke") : undefined}
            >
              {isDraft ? "Discard draft" : "Record revocation"}
            </Button>
          </ButtonRow>
        </form>
      ) : null}
    </>
  );
}
