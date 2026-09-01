import {
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill as UiStatusPill,
  ageYears,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/22-documents — patient-scoped documents workspace (M22 §5.1, Track B / ADR-0030).
// Keeps the existing patient chart route and shell while reusing M22's verified upload, signed URL, and
// append-only version APIs for POLST, consent forms, intake documents, and other uploaded artifacts.
import { useCallback, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
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

const PATIENT_TONE: Record<string, "success" | "progress" | "neutral" | "error"> = {
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

  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${patient.dob}${ageYears(patient.dob) != null ? ` · ${ageYears(patient.dob)}y` : ""}`}
      chips={
        <>
          <MonoChip>{patient.mrn}</MonoChip>
          <UiStatusPill label={titleCase(patient.status)} tone={PATIENT_TONE[patient.status] ?? "neutral"} />
        </>
      }
    />
  ) : (
    <PatientBanner name="Documents" />
  );

  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        <ChartModuleRail patientId={patientId ?? ""} current="documents" />
        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", minWidth: 0 }}>
          {patientId ? <PatientDocumentWorkspace patientId={patientId} /> : null}
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function MonoChip({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span
      style={{
        fontFamily: t.fontMono,
        fontSize: "0.78rem",
        color: t.onSurfaceVariant,
        background: t.surfaceContainer,
        borderRadius: "9999px",
        padding: "0.15rem 0.55rem",
      }}
    >
      {children}
    </span>
  );
}
