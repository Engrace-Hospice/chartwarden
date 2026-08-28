import {
  Button,
  EmptyState,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  ageYears,
  cardSurface,
  interactiveRowProps,
  t,
  useApiClient,
} from "@wardenx/ui";
import { StatusPill as UiStatusPill } from "@wardenx/ui";
// apps/web/src/modules/22-documents — patient-scoped document list (M22 §5.1, Track B / ADR-0030).
// Spec: docs/modules/WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_5.md §5.1 "DOC.Explorer" — the per-patient
// slice reached from the patient chart "Documents" tab. A Patient Workspace (banner + shared module
// rail) over the patient's documents table | a retention-class filter + KPI right rail. The SERVER is
// the only authz point (ADR-0030): out-of-scope rows are non-leaking 404s, SUD content is redacted
// server-side, legal-hold blocks live in the response — never a frontend hide. Reads
// #91 — the chart's Documents tab now UPLOADS. One `type="file"` existed in the whole product before
// this and it was in the portal, so a family member could attach a document to a patient's record and
// the nurse could not. The dialog files against this patient by construction.
// GET /api/v1/documents?patientId (+ the patient summary for the banner) via the typed client, reusing
// the tenant Explorer's row shape and the Lantern helpers so the two views stay visually identical.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import { DocumentUploadDialog } from "./document-upload-dialog";
import { Mono, StatusPill, lifecycleTone, ts } from "./lantern";

interface DocumentRow {
  id: string;
  patientId: string | null;
  retentionClass: string;
  aggregateType: string;
  title: string;
  status: string;
  version: number;
  updatedAt: string;
}
interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  compliance: "Compliance",
  clinical_record: "Clinical",
  bereavement: "Bereavement",
  operational: "Operational",
  intake_artifact: "Intake",
  compliance_42cfr_part2: "Part 2 / SUD",
};

// Patient lifecycle → §6.6 status-pill tone (local map; module 22 does not import module 05).
const PATIENT_TONE: Record<string, "success" | "progress" | "neutral" | "error"> = {
  active: "success",
  pending: "progress",
  admitted: "success",
  discharged: "neutral",
  deceased: "neutral",
};

export function PatientDocuments(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [retentionFilter, setRetentionFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const query: { patientId: string; retentionClass?: string } = { patientId };
    if (retentionFilter) query.retentionClass = retentionFilter;
    const [dRes, pRes] = await Promise.all([
      client.GET("/api/v1/documents", { params: { query } }),
      client.GET("/api/v1/patients/{id}", { params: { path: { id: patientId } } }),
    ]);
    if (pRes.data) setPatient(pRes.data as PatientSummary);
    if (dRes.error) {
      setError("Could not load documents for this patient.");
      setLoading(false);
      return;
    }
    setRows((dRes.data?.items ?? []) as DocumentRow[]);
    setLoading(false);
  }, [client, patientId, retentionFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(
    () => ({
      total: rows.length,
      part2: rows.filter((r) => r.retentionClass === "compliance_42cfr_part2").length,
      intake: rows.filter((r) => r.retentionClass === "intake_artifact").length,
    }),
    [rows],
  );

  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${patient.dob}${ageYears(patient.dob) != null ? ` · ${ageYears(patient.dob)}y` : ""}`}
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
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        <ChartModuleRail patientId={patientId ?? ""} current="documents" />

        {/* Center — patient documents table */}
        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
              marginBottom: "1rem",
            }}
          >
            <h1
              style={{
                margin: 0,
                fontFamily: t.fontDisplay,
                fontWeight: 500,
                fontSize: "1.375rem",
                color: t.onSurface,
              }}
            >
              Documents
            </h1>
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem" }}
            >
              <span style={{ color: t.onSurfaceVariant }}>Category</span>
              <select
                aria-label="Retention class"
                value={retentionFilter}
                onChange={(e) => setRetentionFilter(e.target.value)}
                style={selectStyle}
              >
                <option value="">All</option>
                {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" onClick={() => setUploading(true)}>
              Upload document
            </Button>
          </div>

          {error ? (
            <EmptyState title="Unavailable" description={error} />
          ) : loading && rows.length === 0 ? (
            <LoadingSpinner />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No documents"
              description="No documents on file for this patient in the selected category."
            />
          ) : (
            <section style={{ ...cardSurface, padding: "0.25rem 1.25rem" }}>
              <table className="tabular-nums" style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ textAlign: "left", color: t.muted, fontSize: "0.78rem" }}>
                    <th style={th}>Title</th>
                    <th style={th}>Category</th>
                    <th style={th}>Ver</th>
                    <th style={th}>Status</th>
                    <th style={th}>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr
                      key={d.id}
                      className="wx-data-row-interactive"
                      style={{ borderTop: `1px solid ${t.outlineVariant}` }}
                      // #91 — the version chain (upload a new version, correct the title, open the
                      // content, edit tags) was reachable from nowhere in the app.
                      {...interactiveRowProps(
                        () => navigate(`/documents/${d.id}/versions`),
                        false,
                        false,
                      )}
                    >
                      <td style={{ ...td, maxWidth: "22rem", color: t.onSurface, fontWeight: 600 }}>
                        {d.title}
                      </td>
                      <td style={td}>{CATEGORY_LABEL[d.retentionClass] ?? d.retentionClass}</td>
                      <td style={td}>
                        <Mono>{`v${d.version}`}</Mono>
                      </td>
                      <td style={td}>
                        <StatusPill tone={lifecycleTone(d.status)}>{d.status}</StatusPill>
                      </td>
                      <td style={td}>{ts(d.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>

        {/* Right rail — KPI summary */}
        <aside style={rightRail}>
          <div style={{ ...cardSurface, padding: "1.125rem" }}>
            <h2 style={railTitle}>On file</h2>
            <dl style={detailGrid}>
              <dt style={dtStyle}>Documents</dt>
              <dd style={ddStyle}>{counts.total}</dd>
              <dt style={dtStyle}>Part 2 / SUD</dt>
              <dd style={ddStyle}>{counts.part2}</dd>
              <dt style={dtStyle}>From intake</dt>
              <dd style={ddStyle}>{counts.intake}</dd>
            </dl>
            <p style={meta}>
              Part 2 / SUD content is redacted server-side; legal-hold and out-of-scope rows never
              appear here.
            </p>
          </div>
        </aside>
      </div>
      <DocumentUploadDialog
        open={uploading}
        patientId={patientId ?? null}
        onClose={() => setUploading(false)}
        onDone={() => {
          void load();
        }}
      />
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

const rightRail: CSSProperties = {
  width: "19rem",
  flexShrink: 0,
  overflow: "auto",
  padding: "1.5rem",
  background: t.surfaceLow,
};
const railTitle: CSSProperties = {
  margin: "0 0 0.625rem",
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1rem",
  color: t.onSurface,
};
const detailGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  alignItems: "center",
  gap: "0.5rem 1rem",
  margin: 0,
  fontSize: "0.85rem",
};
const dtStyle: CSSProperties = { color: t.onSurfaceVariant };
const ddStyle: CSSProperties = { margin: 0, color: t.onSurface, fontWeight: 600 };
const selectStyle: CSSProperties = {
  padding: "0.4rem 0.6rem",
  borderRadius: t.radiusMd,
  border: "none",
  background: t.surfaceLow,
  color: t.onSurface,
  fontSize: "0.85rem",
};
const th: CSSProperties = { padding: "0.6rem 0.5rem", fontWeight: 500 };
const td: CSSProperties = {
  padding: "0.6rem 0.5rem",
  fontSize: "0.85rem",
  color: t.onSurfaceVariant,
};
const meta: CSSProperties = {
  fontSize: "0.78rem",
  color: t.onSurfaceVariant,
  margin: "0.75rem 0 0",
};
