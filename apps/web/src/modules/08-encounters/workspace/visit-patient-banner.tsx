// apps/web/src/modules/08-encounters/workspace — the ONE patient banner of the note composer and the encounter record (Workflow 09, WP1):
// the name opens the chart, the chips carry the MRN and the patient's status, the meta line the date of birth. Shown from the patient the
// ENCOUNTER belongs to; while that patient is not known it says only "Encounter", never a name it was not given.
import { PatientBanner, StatusPill, ageYears } from "@chartwarden/ui";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { PATIENT_STATUS_TONE, patientStatusLabel } from "../../../shell/patient-context";
import "./visit-context.css";

interface BannerPatient {
  readonly firstName: string;
  readonly lastName: string;
  readonly mrn: string;
  readonly dob?: string;
  readonly status?: string;
}

interface VisitPatientBannerProps {
  readonly patient: BannerPatient | null;
  /** The encounter's patient, for the chart link. */
  readonly patientId: string | null;
}

function dobLine(dob: string | undefined): string | null {
  if (!dob) return null;
  const age = ageYears(dob);
  return `DOB ${dob}${age != null ? ` · ${age}y` : ""}`;
}

export function VisitPatientBanner({ patient, patientId }: VisitPatientBannerProps): JSX.Element {
  if (!patient) return <PatientBanner name="Encounter" />;
  const fullName = `${patient.firstName} ${patient.lastName}`;
  return (
    <PatientBanner
      name={
        patientId ? (
          <Link to={`/patients/${patientId}`} className="wx-visit-patient-link">
            {fullName}
          </Link>
        ) : (
          fullName
        )
      }
      meta={dobLine(patient.dob)}
      chips={
        <>
          <span className="wx-visit-chip">{patient.mrn}</span>
          {patient.status ? (
            <StatusPill
              label={patientStatusLabel(patient.status)}
              tone={PATIENT_STATUS_TONE[patient.status] ?? "neutral"}
            />
          ) : null}
        </>
      }
    />
  );
}
