import { Button, Modal, SelectField, TextField, t, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/08-encounters — the §2.2 "open a visit note" modal (F-083, #91).
//
// THE FIRST STEP OF THE AUTHORED-THEN-SIGNED PATH DID NOT EXIST. `screens.ts` records that #91/F-063
// made the note authorable, and it did — the composer, the served template menu, the selection save,
// the finalize and the sign ceremony are all real. What none of them could be reached from is a NEW
// encounter: `createDraft` has been exported from `encounters-api.ts` since that change with NO CALLER
// anywhere in the web app, and no screen offered a control that would produce one. Every encounter in
// the product arrived from a seed script or an integration; a clinician finishing a visit had nothing
// to open.
//
// It is the same shape the F-030 registry is full of — a complete, typed, correct client function whose
// input nothing produces — and it hid for the same reason: the composer, reached with an id in hand,
// works perfectly, so every test and every walkthrough that started from a seeded draft passed.
//
// THE DISCIPLINE IS DERIVED, NOT CHOSEN. `discipline` is the encounter's clinical attribution and the
// server pairs it against `encounterType` (`ENCOUNTER_DISCIPLINE_RULES`, a 422 on an illegal pair). It
// is offered from the caller's OWN M3 role keys — the `discipline-derivation.test.ts` rule that M17's
// `resolveDisciplinesTx`, M19's `TRIAGE_DISCIPLINE_FOR_ROLE_KEY` and M10's `authorDisciplinesForRoles`
// all already follow — so a chaplain cannot open an RN routine visit by picking "rn" off a list. That
// is a convenience, not the control: the server is still the enforcement point (ADR-0030), and what
// this avoids is offering a choice whose only outcome is a refusal.
//
// THE ADMISSION IS RESOLVED, NOT TYPED. `POST /api/v1/encounters` requires `admissionId`, and the
// org-wide census takes no patient filter — the gap F-065 hit in M12 and fixed by adding
// `GET /api/v1/patients/{patientId}/admissions`. This reads that same route rather than minting a
// second one, takes the active admission when there is exactly one, and offers a select when the
// patient has been admitted more than once. With none, it says so instead of showing a form whose
// submit can only 422: an encounter documents care under an election, so there is nothing to open.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useSession } from "../../shell/session";
import { stateLabel } from "./encounter-status";
import {
  type EncounterDiscipline,
  type EncounterType,
  createDraft,
  disciplinesForRoles,
  encounterTypesForDisciplines,
  legalDisciplinesFor,
  loadPatientAdmissions,
} from "./encounters-api";

/** Local `yyyy-mm-dd` — the service date is a calendar day in the org's timezone, never a UTC instant. */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const body: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.75rem" };
const title: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.125rem",
  color: t.onSurface,
};
const meta: CSSProperties = { margin: 0, fontSize: "0.8125rem", color: t.muted, lineHeight: 1.5 };
const errorText: CSSProperties = { margin: 0, fontSize: "0.8rem", color: t.error };
const actions: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
  marginTop: "0.25rem",
};

export interface NewEncounterModalProps {
  readonly open: boolean;
  readonly patientId: string;
  readonly onClose: () => void;
  /** Called with the new draft's id once the server has created it (the caller navigates to compose). */
  readonly onCreated: (encounterId: string) => void;
}

interface AdmissionOption {
  readonly id: string;
  readonly state: string;
  readonly admissionAt: string | null;
  readonly dischargedAt: string | null;
}

export function NewEncounterModal({
  open,
  patientId,
  onClose,
  onCreated,
}: NewEncounterModalProps): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();

  const disciplines = useMemo(() => disciplinesForRoles(session?.roles ?? []), [session?.roles]);
  const types = useMemo(() => encounterTypesForDisciplines(disciplines), [disciplines]);

  const [admissions, setAdmissions] = useState<AdmissionOption[] | null>(null);
  const [admissionId, setAdmissionId] = useState("");
  const [encounterType, setEncounterType] = useState<EncounterType | "">("");
  const [discipline, setDiscipline] = useState<EncounterDiscipline | "">("");
  const [serviceDate, setServiceDate] = useState(todayLocal());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on each open so a refusal from a previous attempt never carries into the next one.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setServiceDate(todayLocal());
    setEncounterType(types[0] ?? "");
    setAdmissions(null);
    let live = true;
    void loadPatientAdmissions(client, patientId).then((rows) => {
      if (!live) return;
      setAdmissions(rows);
      // Prefer an OPEN admission: a discharged one would 422 on the service-date-after-admission rule
      // or document care under an election that has ended.
      const open_ = rows.filter((r) => r.dischargedAt === null);
      setAdmissionId((open_[0] ?? rows[0])?.id ?? "");
    });
    return () => {
      live = false;
    };
  }, [open, patientId, client, types]);

  // The legal disciplines narrow with the chosen type, so the pair sent can never be one the server
  // refuses. Reselect whenever the current one falls out of the list.
  const legal = useMemo(
    () =>
      encounterType === ""
        ? []
        : legalDisciplinesFor(encounterType).filter((d) => disciplines.includes(d)),
    [encounterType, disciplines],
  );
  useEffect(() => {
    if (discipline === "" || !legal.includes(discipline)) setDiscipline(legal[0] ?? "");
  }, [legal, discipline]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    if (encounterType === "" || discipline === "" || admissionId === "") return;
    setBusy(true);
    setError(null);
    const res = await createDraft(client, {
      patientId,
      admissionId,
      encounterType,
      discipline,
      serviceDate,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onCreated(res.value.id);
  };

  const noDiscipline = disciplines.length === 0;
  const noAdmission = admissions !== null && admissions.length === 0;

  return (
    <Modal open={open} onClose={busy ? undefined : onClose} ariaLabel="New encounter" width="30rem">
      <div style={body}>
        <h2 style={title}>New encounter</h2>

        {noDiscipline ? (
          <p style={meta}>
            None of your roles is a clinical discipline that may author an encounter, so there is
            nothing to open. Encounters are attributed to the discipline that provided the care.
          </p>
        ) : noAdmission ? (
          <p style={meta}>
            This patient has no admission. An encounter documents care delivered under a hospice
            election, so it is opened against one.
          </p>
        ) : (
          <>
            <SelectField
              label="Encounter type"
              value={encounterType}
              onChange={(e) => setEncounterType(e.target.value as EncounterType)}
              options={types.map((k) => ({ value: k, label: stateLabel(k) }))}
            />

            <SelectField
              label="Discipline"
              value={discipline}
              onChange={(e) => setDiscipline(e.target.value as EncounterDiscipline)}
              options={legal.map((d) => ({ value: d, label: stateLabel(d) }))}
            />

            {/* Offered only when the choice is real. One admission is the ordinary case and a select
                with a single option is a decision the clinician does not have to make. */}
            {admissions !== null && admissions.length > 1 ? (
              <SelectField
                label="Admission"
                value={admissionId}
                onChange={(e) => setAdmissionId(e.target.value)}
                options={admissions.map((a) => ({
                  value: a.id,
                  label: `${stateLabel(a.state)} · ${(a.admissionAt ?? "").slice(0, 10)}${
                    a.dischargedAt ? ` – ${a.dischargedAt.slice(0, 10)}` : ""
                  }`,
                }))}
              />
            ) : null}

            {/* `max` is today: §2.7 refuses a future service date outright, and the late-entry TIER for
                a past one is the server's to derive — this field is where the clinician says when the
                visit happened, not what tier it lands in. */}
            <TextField
              label="Service date"
              type="date"
              value={serviceDate}
              max={todayLocal()}
              onChange={(e) => setServiceDate(e.target.value)}
            />
          </>
        )}

        {error ? (
          <p role="alert" aria-live="assertive" style={errorText}>
            {error}
          </p>
        ) : null}

        <div style={actions}>
          <Button tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={
              busy ||
              noDiscipline ||
              admissions === null ||
              noAdmission ||
              encounterType === "" ||
              discipline === "" ||
              admissionId === ""
            }
          >
            {busy ? "Opening…" : "Open note"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
