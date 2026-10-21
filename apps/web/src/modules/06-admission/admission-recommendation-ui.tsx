// apps/web/src/modules/06-admission/admission-recommendation-ui.tsx — the 42 CFR 418.25(a) physician admission
// recommendation (FY 2026 rule, effective 2025-10-01) on the admission intake workspace.
//
// "The hospice admits a patient only on the recommendation of the medical director (or the physician designee)
// or the physician member of the hospice interdisciplinary group, in consultation with, or with input from, the
// patient's attending physician (if any)." Two pieces: a flat section (read-only, locked once recorded, with
// the source line) mounted in the intake page's requirement list, and the right-rail drawer that captures it
// (recommender picker limited to eligible signers, when, attending consulted + note). The readiness item
// `admission_recommendation` shows in the activation checklist; it is advisory (a payment condition, not a
// CoP — the server decides blocking, `ADMISSION_RECOMMENDATION_BLOCKS_ACTIVATION`). Mockup: "Admissions"
// right drawer (03_20_25).
import {
  Button,
  InlineAlert,
  SelectField,
  StatusPill,
  TextAreaField,
  TextField,
  useApiClient,
} from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import {
  AuthorityDrawer,
  AuthoritySection,
  CAPACITY_LABEL,
  LockedFacts,
  type PhysicianSignerCapacity,
  PhysicianSignerPicker,
  errorText,
  localInputToIso,
  nowLocalInput,
  signerName,
  usDateTime,
  usePhysicianSigners,
} from "./physician-authority-ui";

export interface AdmissionRecommendationView {
  recommendedByUserId: string;
  capacity: PhysicianSignerCapacity;
  recommendedAt: string;
  attendingConsulted: boolean;
  attendingConsultNote: string | null;
}

/** Shortest note the server accepts when the attending was not consulted (`ATTENDING_NOT_CONSULTED_NOTE_MIN`). */
const NOT_CONSULTED_NOTE_MIN = 10;

/** The intake-page section: what was recorded (locked) or the call to record it. */
export function AdmissionRecommendationSection({
  admissionId,
  recommendation,
  editable,
  onRecord,
}: {
  admissionId: string;
  recommendation: AdmissionRecommendationView | null | undefined;
  editable: boolean;
  onRecord: () => void;
}): JSX.Element {
  return (
    <AuthoritySection
      id="admission-recommendation"
      icon="stethoscope"
      title="Physician admission recommendation"
      description="Medical director, physician designee, or the patient's IDG physician, with the attending's input."
      aside={
        <>
          <span className="wx-muted-code">42 CFR 418.25(a)</span>
          <StatusPill
            label={recommendation ? "Recorded" : "Review advised"}
            tone={recommendation ? "success" : "warning"}
          />
        </>
      }
    >
      {recommendation ? (
        <RecordedRecommendation admissionId={admissionId} recommendation={recommendation} />
      ) : (
        <div className="wx-pa-stack">
          <p className="wx-action-hint">
            Not recorded yet. It doesn't block activation, but the admission's claims depend on it.
          </p>
          {editable ? (
            <div className="wx-action-row">
              <Button tone="secondary" onClick={onRecord}>
                Record recommendation
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </AuthoritySection>
  );
}

function RecordedRecommendation({
  admissionId,
  recommendation,
}: {
  admissionId: string;
  recommendation: AdmissionRecommendationView;
}): JSX.Element {
  const { signers } = usePhysicianSigners(admissionId);
  const who = signers?.find((s) => s.userId === recommendation.recommendedByUserId);
  return (
    <LockedFacts
      rows={[
        ["Recommended by", who ? signerName(who) : "Physician (no longer listed)"],
        ["Capacity", CAPACITY_LABEL[recommendation.capacity]],
        [
          "Recommended",
          <span key="at" className="wx-nums">
            {usDateTime(recommendation.recommendedAt)}
          </span>,
        ],
        ["Attending consulted", recommendation.attendingConsulted ? "Yes" : "No"],
        ...(recommendation.attendingConsultNote
          ? ([["Consultation note", recommendation.attendingConsultNote]] as const)
          : []),
      ]}
      source="Recorded on the admission · validated against the 418.25(a) signer set"
    />
  );
}

/** The right-rail capture drawer. */
export function AdmissionRecommendationDrawer({
  admissionId,
  version,
  hasAttending,
  onClose,
  onSaved,
}: {
  admissionId: string;
  version: number;
  hasAttending: boolean;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [recommender, setRecommender] = useState("");
  const [capacity, setCapacity] = useState<PhysicianSignerCapacity | null>(null);
  const [recommendedAt, setRecommendedAt] = useState(nowLocalInput());
  const [consulted, setConsulted] = useState<"" | "yes" | "no">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noteRequired = hasAttending && consulted === "no";
  const noteShort = noteRequired && note.trim().length < NOT_CONSULTED_NOTE_MIN;
  const ready = recommender !== "" && consulted !== "" && recommendedAt !== "" && !noteShort;

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const { error: err } = await client.POST("/api/v1/admissions/{id}/admission-recommendation", {
      params: { path: { id: admissionId } },
      body: {
        recommendedByUserId: recommender,
        recommendedAt: localInputToIso(recommendedAt),
        ...(capacity ? { capacity } : {}),
        attendingConsulted: consulted === "yes",
        ...(note.trim() ? { attendingConsultNote: note.trim() } : {}),
        ifVersion: version,
      },
    });
    setBusy(false);
    if (err) {
      setError(errorText(err, "The recommendation could not be recorded."));
      return;
    }
    onSaved();
  };

  return (
    <AuthorityDrawer
      icon="stethoscope"
      title="Admission recommendation"
      subtitle="42 CFR 418.25(a) · recorded before activation"
      onClose={onClose}
    >
      <PhysicianSignerPicker
        admissionId={admissionId}
        label="Recommending physician"
        value={recommender}
        onChange={(userId, cap) => {
          setRecommender(userId);
          setCapacity(cap);
        }}
      />
      <TextField
        label="Recommended at"
        type="datetime-local"
        required
        value={recommendedAt}
        onChange={(e) => setRecommendedAt(e.target.value)}
        hint="When the physician made the recommendation (not in the future)."
      />
      <SelectField
        label="Attending physician consulted"
        required
        value={consulted}
        onChange={(e) => setConsulted(e.target.value as "" | "yes" | "no")}
        hint={
          hasAttending
            ? "The patient has an attending physician: record their input."
            : "No attending physician is on file for this admission."
        }
        options={[
          { value: "", label: "Select" },
          { value: "yes", label: "Yes — consulted / gave input" },
          { value: "no", label: hasAttending ? "No — explain below" : "No attending physician" },
        ]}
      />
      <TextAreaField
        label="Consultation note"
        required={noteRequired}
        value={note}
        maxLength={2000}
        onChange={(e) => setNote(e.target.value)}
        error={
          noteShort
            ? `Say why the attending wasn't consulted (${NOT_CONSULTED_NOTE_MIN}+ characters).`
            : undefined
        }
        hint="The attending's input, or why it wasn't obtained."
      />
      {error ? <InlineAlert>{error}</InlineAlert> : null}
      <div className="wx-action-row is-end">
        <Button tone="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={!ready || busy} loading={busy}>
          Record recommendation
        </Button>
      </div>
    </AuthorityDrawer>
  );
}
