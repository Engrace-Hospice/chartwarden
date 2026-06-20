// apps/web/src/modules/05-patient — Patient Chart (M5, Track A).
// Spec: docs/ui/screens/clinical/WARDENX_UI_PATIENT_CHART.md — "Use Patient Workspace."
// The patient-scoped hub: sticky Patient Banner + a module nav rail + a center summary. This builds
// the M5 FRAME (banner + demographics summary); the per-module tabs (Encounters, Orders, eMAR, …)
// graft on as those modules land (Track B). Backed by GET /api/v1/patients/:id via the typed client.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import {
  CenteredStatusLayout,
  LeftNavRail,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  useApiClient,
} from "@wardenx/ui";

interface PatientSummary {
  id: string;
  organizationId: string;
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

// Module nav rail (spec). Only sections whose module is built are active now; the rest are
// placeholders that light up in Track B as their module lands.
const NAV_SECTIONS: { label: string; ready: boolean }[] = [
  { label: "Summary", ready: true },
  { label: "Demographics & Identifiers", ready: true },
  { label: "Coverage / Payers", ready: false },
  { label: "Care Team & Assignments", ready: false },
  { label: "Care Plan", ready: false },
  { label: "Encounters / Visits", ready: false },
  { label: "Assessments", ready: false },
  { label: "Orders", ready: false },
  { label: "Medications / eMAR", ready: false },
  { label: "Documents", ready: false },
  { label: "Election & Certification", ready: false },
  { label: "IDG History", ready: false },
];

export function PatientChart(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "notfound" } | { kind: "error" } | { kind: "ready"; patient: PatientSummary }
  >({ kind: "loading" });

  useEffect(() => {
    let active = true;
    (async () => {
      if (!id) return;
      const { data, error, response } = await client.GET("/api/v1/patients/{id}", { params: { path: { id } } });
      if (!active) return;
      if (response?.status === 404) return setState({ kind: "notfound" });
      if (error || !data) return setState({ kind: "error" });
      setState({ kind: "ready", patient: data as PatientSummary });
    })();
    return () => {
      active = false;
    };
  }, [client, id]);

  if (state.kind === "loading") return <LoadingSpinner />;
  if (state.kind === "notfound") {
    return <CenteredStatusLayout headline="Patient not found" explanation="This patient does not exist or is outside your access." />;
  }
  if (state.kind === "error") {
    return <CenteredStatusLayout headline="Unavailable" explanation="The patient chart could not be loaded." />;
  }

  const p = state.patient;
  return (
    <PatientWorkspaceLayout
      banner={
        <PatientBanner
          name={`${p.lastName}, ${p.firstName}`}
          mrn={p.mrn}
          dob={p.dob}
          codeStatus={<span style={{ color: "#9ca3af" }}>—</span>}
        />
      }
    >
      <div style={{ display: "flex", minHeight: 0, flex: 1 }}>
        <LeftNavRail ariaLabel="Patient modules">
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            {NAV_SECTIONS.map((s) => (
              <li
                key={s.label}
                style={{ padding: "0.4rem 0.5rem", borderRadius: "0.375rem", color: s.ready ? "#111827" : "#9ca3af", cursor: s.ready ? "pointer" : "default" }}
                title={s.ready ? undefined : "Available when this module ships"}
              >
                {s.label}
              </li>
            ))}
          </ul>
        </LeftNavRail>
        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem" }}>
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Summary</h2>
          <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "0.4rem 1rem", fontSize: "0.9rem" }}>
            <dt style={dt}>MRN</dt>
            <dd style={dd}>{p.mrn}</dd>
            <dt style={dt}>Date of birth</dt>
            <dd style={dd}>{p.dob}</dd>
            <dt style={dt}>Status</dt>
            <dd style={dd}>{p.status}</dd>
          </dl>
          <p style={{ marginTop: "1.5rem", color: "#6b7280", fontSize: "0.85rem" }}>
            Clinical sections (problems, visits, orders, medications, assessments) populate as their
            modules ship.
          </p>
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

const dt = { color: "#6b7280", margin: 0 } as const;
const dd = { margin: 0 } as const;
