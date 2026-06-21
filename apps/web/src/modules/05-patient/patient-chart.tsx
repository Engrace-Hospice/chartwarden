// apps/web/src/modules/05-patient — Patient Chart (M5, Track A).
// Spec: docs/ui/screens/clinical/WARDENX_UI_PATIENT_CHART.md — "Use Patient Workspace."
// The patient-scoped hub: sticky Patient Banner + a module nav rail + a center summary. This builds
// the M5 FRAME (banner + summary) plus the M5-owned Demographics & Identifiers tab (FB-T06); the
// cross-module tabs (Encounters, Orders, eMAR, …) graft on as those modules land (Track B). Backed by
// GET /api/v1/patients/:id (+ /demographics, /identifiers) via the typed client.
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
  const [section, setSection] = useState("Summary");
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
                onClick={s.ready ? () => setSection(s.label) : undefined}
                aria-current={s.ready && s.label === section ? "page" : undefined}
                style={{
                  padding: "0.4rem 0.5rem",
                  borderRadius: "0.375rem",
                  color: s.ready ? "#111827" : "#9ca3af",
                  cursor: s.ready ? "pointer" : "default",
                  background: s.ready && s.label === section ? "#eef2ff" : "transparent",
                  fontWeight: s.ready && s.label === section ? 600 : 400,
                }}
                title={s.ready ? undefined : "Available when this module ships"}
              >
                {s.label}
              </li>
            ))}
          </ul>
        </LeftNavRail>
        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem" }}>
          {section === "Demographics & Identifiers" ? (
            <DemographicsTab patientId={p.id} />
          ) : (
            <SummaryTab patient={p} />
          )}
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

function SummaryTab({ patient }: { patient: PatientSummary }): JSX.Element {
  return (
    <>
      <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Summary</h2>
      <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "0.4rem 1rem", fontSize: "0.9rem" }}>
        <dt style={dt}>MRN</dt>
        <dd style={dd}>{patient.mrn}</dd>
        <dt style={dt}>Date of birth</dt>
        <dd style={dd}>{patient.dob}</dd>
        <dt style={dt}>Status</dt>
        <dd style={dd}>{patient.status}</dd>
      </dl>
      <p style={{ marginTop: "1.5rem", color: "#6b7280", fontSize: "0.85rem" }}>
        Clinical sections (problems, visits, orders, medications, assessments) populate as their
        modules ship.
      </p>
    </>
  );
}

// SOGI/race/ethnicity/marital are USCDI codes resolved to display labels via M38 value-sets — shown
// here as the raw codes until the M38 label join is wired (codes are honest live data, not fabricated).
interface Demographics {
  id: string;
  mrn: string;
  legalFirstName: string;
  legalMiddleName: string | null;
  legalLastName: string;
  legalNameSuffix: string | null;
  dob: string;
  status: string;
  sexAssignedAtBirth: string;
  genderIdentityCode: string | null;
  sexualOrientationCode: string | null;
  pronounsCode: string | null;
  maritalStatusCode: string | null;
  raceCodes: string[];
  ethnicityCodes: string[];
  preferredLanguageCode: string | null;
  aliases: { kind: string; fullName: string | null; firstName: string | null; middleName: string | null; lastName: string | null }[];
}

interface Identifier {
  id: string;
  kind: string;
  value: string | null;
  last4: string | null;
  sensitive: boolean;
  issuer: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

function DemographicsTab({ patientId }: { patientId: string }): JSX.Element {
  const client = useApiClient();
  const [demographics, setDemographics] = useState<Demographics | null>(null);
  const [identifiers, setIdentifiers] = useState<Identifier[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let active = true;
    (async () => {
      setStatus("loading");
      const [demo, ids] = await Promise.all([
        client.GET("/api/v1/patients/{id}/demographics", { params: { path: { id: patientId } } }),
        client.GET("/api/v1/patients/{id}/identifiers", { params: { path: { id: patientId } } }),
      ]);
      if (!active) return;
      if (demo.error || !demo.data || ids.error || !ids.data) return setStatus("error");
      setDemographics(demo.data as Demographics);
      setIdentifiers((ids.data as { identifiers: Identifier[] }).identifiers);
      setStatus("ready");
    })();
    return () => {
      active = false;
    };
  }, [client, patientId]);

  if (status === "loading") return <LoadingSpinner />;
  if (status === "error" || !demographics || !identifiers) {
    return <p style={{ color: "#b91c1c", fontSize: "0.9rem" }}>Demographics could not be loaded.</p>;
  }

  const d = demographics;
  const codes = (arr: string[]) => (arr.length ? arr.join(", ") : "—");
  const orDash = (v: string | null) => (v && v.length ? v : "—");

  return (
    <>
      <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Demographics &amp; Identifiers</h2>

      <h3 style={h3}>Name</h3>
      <dl style={grid}>
        <dt style={dt}>Legal name</dt>
        <dd style={dd}>
          {[d.legalLastName, [d.legalFirstName, d.legalMiddleName].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
          {d.legalNameSuffix ? ` ${d.legalNameSuffix}` : ""}
        </dd>
        <dt style={dt}>Aliases</dt>
        <dd style={dd}>
          {d.aliases.length === 0
            ? "—"
            : d.aliases
                .map((a) => `${a.fullName ?? [a.firstName, a.lastName].filter(Boolean).join(" ")} (${a.kind})`)
                .join("; ")}
        </dd>
      </dl>

      <h3 style={h3}>Demographics</h3>
      <dl style={grid}>
        <dt style={dt}>Date of birth</dt>
        <dd style={dd}>{d.dob}</dd>
        <dt style={dt}>Sex assigned at birth</dt>
        <dd style={dd}>{orDash(d.sexAssignedAtBirth)}</dd>
        <dt style={dt}>Gender identity</dt>
        <dd style={dd}>{orDash(d.genderIdentityCode)}</dd>
        <dt style={dt}>Sexual orientation</dt>
        <dd style={dd}>{orDash(d.sexualOrientationCode)}</dd>
        <dt style={dt}>Pronouns</dt>
        <dd style={dd}>{orDash(d.pronounsCode)}</dd>
        <dt style={dt}>Marital status</dt>
        <dd style={dd}>{orDash(d.maritalStatusCode)}</dd>
        <dt style={dt}>Race</dt>
        <dd style={dd}>{codes(d.raceCodes)}</dd>
        <dt style={dt}>Ethnicity</dt>
        <dd style={dd}>{codes(d.ethnicityCodes)}</dd>
        <dt style={dt}>Preferred language</dt>
        <dd style={dd}>{orDash(d.preferredLanguageCode)}</dd>
      </dl>
      <p style={{ color: "#9ca3af", fontSize: "0.78rem", margin: "0.3rem 0 0" }}>
        SOGI / race / ethnicity values are USCDI codes; M38 resolves them to display labels.
      </p>

      <h3 style={h3}>Identifiers</h3>
      <table style={{ borderCollapse: "collapse", fontSize: "0.85rem", width: "100%", maxWidth: 560 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#6b7280" }}>
            <th style={th}>Type</th>
            <th style={th}>Value</th>
            <th style={th}>Issuer</th>
          </tr>
        </thead>
        <tbody>
          {identifiers.map((i) => (
            <tr key={i.id} style={{ borderTop: "1px solid #f3f4f6" }}>
              <td style={td}>
                {i.kind.toUpperCase()}
                {i.kind === "mrn" ? <span style={{ color: "#9ca3af" }} title="MRN is immutable after creation"> · immutable</span> : null}
              </td>
              <td style={td}>
                {i.sensitive ? (
                  <span title="Full value requires phi.read_ssn (M5 SSN decryption follow-up)">
                    xxx-xx-{i.last4 ?? "####"} <span style={{ color: "#9ca3af" }}>(masked)</span>
                  </span>
                ) : (
                  orDash(i.value)
                )}
              </td>
              <td style={td}>{orDash(i.issuer)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: "#9ca3af", fontSize: "0.78rem", margin: "0.4rem 0 0" }}>
        SSN / state-ID are envelope-encrypted and shown masked; full reveal requires the
        <code style={{ margin: "0 0.25rem" }}>phi.read_ssn</code> permission.
      </p>
    </>
  );
}

const dt = { color: "#6b7280", margin: 0 } as const;
const dd = { margin: 0 } as const;
const grid = { display: "grid", gridTemplateColumns: "max-content 1fr", gap: "0.4rem 1rem", fontSize: "0.9rem", margin: "0.25rem 0 0" } as const;
const h3 = { fontSize: "0.92rem", margin: "1.25rem 0 0.4rem", color: "#374151" } as const;
const th = { padding: "0.3rem 0.5rem", fontWeight: 500 } as const;
const td = { padding: "0.3rem 0.5rem" } as const;
