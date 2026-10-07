// apps/web/src/modules/06-admission — the two FY2027 face-to-face write forms the F2F rail hosts:
//   · Record completion (R-F2F-05, 42 CFR 418.22(a)(4)(ii)): encounter date + modality; a telehealth
//     encounter asks the three (A)–(C) eligibility questions explicitly (no default answers).
//   · Attest (R-F2F-06, § 418.22(b)(4)): "Link signed visit note" (an M8 note signed by the performer on the
//     encounter date) or "Write attestation" (≥ 100 characters).
// Kit fields + Button only; the server enforces every rule — the client only shapes the request and
// explains a refusal.
import { Button, LoadingSpinner, SelectField, TextAreaField, TextField } from "@wardenx/ui";
import { useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { stateLabel } from "./admission-status";
import {
  type ElectionCertificationApi,
  type F2fEncounterLocation,
  FaceToFaceWriteError,
  type SignedVisitNote,
  type TelehealthEligibility,
} from "./election-certification-api";
import { formatDetailDate } from "./election-certification-detail-ui";

/** The R-F2F-05 telehealth sunset (§ 418.22(a)(4)(ii) "through December 31, 2027"); server-enforced. */
export const TELEHEALTH_F2F_ALLOWED_THROUGH = "2027-12-31";

/** Mirrors the server's `TEXT_MINIMUMS.f2fAttestation`. */
export const F2F_ATTESTATION_MIN_CHARS = 100;

export const F2F_LOCATION_LABEL: Record<F2fEncounterLocation, string> = {
  patient_home: "Patient home (in person)",
  alf: "Assisted living facility (in person)",
  snf: "Skilled nursing facility (in person)",
  ipu: "Inpatient unit (in person)",
  hospital: "Hospital (in person)",
  telehealth: "Telehealth (audio + video)",
};

const LOCATION_OPTIONS = [
  { value: "", label: "Select how the encounter took place" },
  ...(Object.keys(F2F_LOCATION_LABEL) as F2fEncounterLocation[]).map((value) => ({
    value,
    label: F2F_LOCATION_LABEL[value],
  })),
];

const YES_NO = [
  { value: "", label: "Select" },
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

/** Readable messages for the server's F2F refusal codes. */
const ERROR_MESSAGE: Record<string, string> = {
  F2F_TELEHEALTH_NOT_PERMITTED:
    "Telehealth is not permitted for this face-to-face (42 CFR 418.22(a)(4)(ii)). Record an in-person encounter.",
  F2F_TELEHEALTH_ATTESTATION_REQUIRED:
    "Answer the three telehealth eligibility questions before recording a telehealth encounter.",
  F2F_ATTESTATION_NOTE_INVALID:
    "That note cannot serve as the attestation: it must be signed by the face-to-face performer, for this patient, on the encounter date.",
  F2F_ATTESTATION_SOURCE_REQUIRED: "Provide either a linked signed note or a written attestation.",
  F2F_ATTESTATION_TOO_SHORT: `A written attestation must be at least ${F2F_ATTESTATION_MIN_CHARS} characters.`,
  F2F_INVALID_PERFORMER: "Only the clinician who performed the encounter can attest it.",
  F2F_OUTSIDE_WINDOW: "The encounter date is outside the 30-day window before the benefit period.",
  F2F_ENCOUNTER_DATE_INVALID: "The encounter date cannot be in the future or implausibly old.",
  VERSION_CONFLICT: "This face-to-face changed since it was loaded. Close and reopen it.",
};

export function f2fErrorMessage(err: unknown, fallback: string): string {
  const code = err instanceof FaceToFaceWriteError ? err.code : null;
  return (code && ERROR_MESSAGE[code]) || fallback;
}

type YesNo = "" | "yes" | "no";

/** R-F2F-05 — record the completed encounter with its modality. */
export function F2fCompletionForm({
  api,
  faceToFaceId,
  version,
  onDone,
  onError,
}: {
  api: ElectionCertificationApi;
  faceToFaceId: string;
  version: number;
  onDone: () => void;
  onError: (message: string) => void;
}): JSX.Element {
  const [encounterDate, setEncounterDate] = useState("");
  const [location, setLocation] = useState<F2fEncounterLocation | "">("");
  const [moratorium, setMoratorium] = useState<YesNo>("");
  const [oversight, setOversight] = useState<YesNo>("");
  const [enrolled, setEnrolled] = useState<YesNo>("");
  const [saving, setSaving] = useState(false);

  const telehealth = location === "telehealth";
  const eligibilityAnswered = moratorium !== "" && oversight !== "" && enrolled !== "";
  const ready = encounterDate !== "" && location !== "" && (!telehealth || eligibilityAnswered);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!ready) return;
    setSaving(true);
    const telehealthEligibility: TelehealthEligibility | undefined = telehealth
      ? {
          patientInMoratoriumArea: moratorium === "yes",
          hospiceUnderEnhancedOversight: oversight === "yes",
          performerMedicareEnrolledOrOptedOut: enrolled === "yes",
        }
      : undefined;
    try {
      await api.completeFaceToFace(faceToFaceId, {
        encounterDate,
        encounterLocation: location,
        ...(telehealthEligibility ? { telehealthEligibility } : {}),
        ifVersion: version,
      });
      onDone();
    } catch (err) {
      onError(f2fErrorMessage(err, "Could not record the face-to-face completion."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="wx-action-body is-flush" onSubmit={(e) => void submit(e)}>
      <TextField
        label="Encounter date"
        type="date"
        required
        value={encounterDate}
        onChange={(e) => setEncounterDate(e.target.value)}
      />
      <SelectField
        label="Modality"
        required
        value={location}
        options={LOCATION_OPTIONS}
        hint={`Telehealth is allowed for recertification through ${formatDetailDate(TELEHEALTH_F2F_ALLOWED_THROUGH)}.`}
        onChange={(e) => setLocation(e.target.value as F2fEncounterLocation | "")}
      />
      {telehealth ? (
        <fieldset className="wx-f2f-attest-set">
          <legend>Telehealth eligibility — 42 CFR 418.22(a)(4)(ii)(A)–(C)</legend>
          <SelectField
            label="Is the patient in a hospice enrollment-moratorium area?"
            required
            value={moratorium}
            options={YES_NO}
            onChange={(e) => setMoratorium(e.target.value as YesNo)}
          />
          <SelectField
            label="Is the hospice under CMS enhanced oversight?"
            required
            value={oversight}
            options={YES_NO}
            onChange={(e) => setOversight(e.target.value as YesNo)}
          />
          <SelectField
            label="Is the performer Medicare-enrolled or an opt-out practitioner?"
            required
            value={enrolled}
            options={YES_NO}
            onChange={(e) => setEnrolled(e.target.value as YesNo)}
          />
          <p className="wx-action-hint">
            Your answers are recorded with the encounter. A “yes” to either of the first two, or a
            “no” to the third, means the encounter must be in person.
          </p>
        </fieldset>
      ) : null}
      <div className="wx-action-row is-end">
        <Button type="submit" disabled={!ready} loading={saving}>
          Record completion
        </Button>
      </div>
    </form>
  );
}

type AttestMethod = "note" | "narrative";

const METHOD_OPTIONS = [
  { value: "note", label: "Link signed visit note" },
  { value: "narrative", label: "Write attestation" },
];

/** R-F2F-06 — attest via a linked signed visit note, or a written narrative. */
export function F2fAttestationForm({
  api,
  faceToFaceId,
  version,
  patientId,
  encounterDate,
  performerUserId,
  onDone,
  onError,
}: {
  api: ElectionCertificationApi;
  faceToFaceId: string;
  version: number;
  patientId: string | null;
  encounterDate: string | null;
  performerUserId: string | null;
  onDone: () => void;
  onError: (message: string) => void;
}): JSX.Element {
  const [method, setMethod] = useState<AttestMethod>("note");
  const [notes, setNotes] = useState<SignedVisitNote[] | null | undefined>(undefined);
  const [noteId, setNoteId] = useState("");
  const [narrative, setNarrative] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (method !== "note" || !patientId || !encounterDate) return;
    let active = true;
    setNotes(undefined);
    api
      .signedNotesOn(patientId, encounterDate, performerUserId)
      .then((rows) => active && setNotes(rows))
      .catch(() => active && setNotes(null));
    return () => {
      active = false;
    };
  }, [api, method, patientId, encounterDate, performerUserId]);

  const narrativeLength = narrative.trim().length;
  const ready = method === "note" ? noteId !== "" : narrativeLength >= F2F_ATTESTATION_MIN_CHARS;

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!ready) return;
    setSaving(true);
    try {
      await api.attestFaceToFace(
        faceToFaceId,
        method === "note"
          ? { signedNoteEncounterId: noteId, ifVersion: version }
          : { attestationNarrative: narrative.trim(), ifVersion: version },
      );
      onDone();
    } catch (err) {
      onError(f2fErrorMessage(err, "Could not attest the face-to-face."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="wx-action-body is-flush" onSubmit={(e) => void submit(e)}>
      <SelectField
        label="Attestation"
        value={method}
        options={METHOD_OPTIONS}
        onChange={(e) => setMethod(e.target.value as AttestMethod)}
      />
      {method === "note" ? (
        <NotePicker
          notes={notes}
          encounterDate={encounterDate}
          value={noteId}
          onChange={setNoteId}
        />
      ) : (
        <>
          <TextAreaField
            label="Attestation narrative"
            value={narrative}
            rows={5}
            maxLength={4000}
            onChange={(e) => setNarrative(e.target.value)}
          />
          <p className="wx-action-hint">
            {narrativeLength}/{F2F_ATTESTATION_MIN_CHARS} characters minimum. State that you had a
            face-to-face encounter with the patient, its date and clinical findings.
          </p>
        </>
      )}
      <div className="wx-action-row is-end">
        <Button type="submit" disabled={!ready} loading={saving}>
          Attest face-to-face
        </Button>
      </div>
    </form>
  );
}

function NotePicker({
  notes,
  encounterDate,
  value,
  onChange,
}: {
  notes: SignedVisitNote[] | null | undefined;
  encounterDate: string | null;
  value: string;
  onChange: (id: string) => void;
}): JSX.Element {
  if (!encounterDate) {
    return <p className="wx-action-hint">Record the encounter date before linking a note.</p>;
  }
  if (notes === undefined) return <LoadingSpinner />;
  if (notes === null) {
    return <p className="wx-action-hint">Signed visit notes could not be loaded.</p>;
  }
  if (notes.length === 0) {
    return (
      <p className="wx-action-hint">
        No note signed by the performer on {formatDetailDate(encounterDate)}. Sign the visit note
        first, or write the attestation.
      </p>
    );
  }
  return (
    <SelectField
      label="Signed visit note"
      value={value}
      hint="The note must document the encounter's clinical findings (42 CFR 418.22(b)(4))."
      options={[
        { value: "", label: "Select a signed note" },
        ...notes.map((n) => ({
          value: n.id,
          label: `${stateLabel(n.encounterType)} · ${n.discipline.toUpperCase()} · signed ${formatDetailDate(n.signedAt)}`,
        })),
      ]}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
