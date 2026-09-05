import {
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill as UiStatusPill,
  ageYears,
  t,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import { PatientDocumentWorkspace } from "./document-workflows";

interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

const PATIENT_TONE: Record<
  string,
  "success" | "progress" | "neutral" | "error"
> = {
  active: "success",
  pending: "progress",
  admitted: "success",
  discharged: "neutral",
  deceased: "neutral",
};

export function PatientDocuments(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();

  const [patient, setPatient] = useState<PatientSummary | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;

    const { data } = await client.GET("/api/v1/patients/{id}", {
      params: { path: { id: patientId } },
    });

    if (data) setPatient(data as PatientSummary);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const age = patient ? ageYears(patient.dob) : null;

  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${patient.dob}${age != null ? ` · ${age}y` : ""}`}
      chips={
        <>
          <MonoChip>{patient.mrn}</MonoChip>

          <UiStatusPill
            label={titleCase(patient.status)}
            tone={PATIENT_TONE[patient.status] ?? "neutral"}
          />
        </>
      }
    />
  ) : (
    <PatientBanner name="Documents" />
  );

  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={workspace}>
        <ChartModuleRail
          patientId={patientId ?? ""}
          current="documents"
        />

        <main style={content}>
          {patientId ? (
            <PatientDocumentWorkspace patientId={patientId} />
          ) : (
            <div style={missingPatient}>
              Select a patient to view their documents.
            </div>
          )}
        </main>
      </div>
    </PatientWorkspaceLayout>
  );
}

const titleCase = (value: string): string =>
  value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());

function MonoChip({ children }: { children: ReactNode }): JSX.Element {
  return <span style={monoChip}>{children}</span>;
}

const workspace: CSSProperties = {
  display: "flex",
  height: "100%",
  minHeight: 0,
  background: "var(--color-surface-lowest, var(--color-surface))",
};

const content: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: "auto",
  padding: "1.5rem clamp(1rem, 2.5vw, 2rem) 2rem",
};

const missingPatient: CSSProperties = {
  minHeight: "20rem",
  display: "grid",
  placeItems: "center",
  color: t.onSurfaceVariant,
  fontSize: "0.9rem",
};

const monoChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontFamily: t.fontMono,
  fontSize: "0.76rem",
  lineHeight: 1.2,
  color: t.onSurfaceVariant,
  background: t.surfaceContainer,
  borderRadius: "9999px",
  padding: "0.2rem 0.55rem",
};
