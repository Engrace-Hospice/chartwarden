import {
  cardSurface,
  EmptyState,
  ghostBorder,
  Glyph,
  GuardChip,
  LeftNavRail,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/10-hope — HOPE assessment detail (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_HOPE_ENGINE.md — "Use Patient Workspace + Documentation Workspace."
// Matched to the P1 Pencil frame (wardenx-P1-clinical.pen `KQ8kz`): a Patient Workspace (banner) over a
// timepoint rail | the selected timepoint's SECTION list | a right rail (validation & triggers + iQIES
// submission), with a sticky footer (submission guard + actions). Reads GET /hope/assessments/:id (+ its
// /validation, the patient summary, and the patient's HOPE timeline for the rail). The server is
// authoritative for status / J2051 / validation (ADR-0030). Honest gap: the per-section completion the
// frame shows isn't exposed — the section `data` is opaque server-side except Section J (J2051). So the
// section list is a faithful scaffold with J2051 real and the rest '—' (never fabricated completeness).
import { useEffect, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ASSESSMENT_TONE, J2051_TONE, SEVERITY_TONE, rfaLabel, stateLabel } from "./hope-status";

interface AssessmentDetail {
  id: string;
  patientId: string;
  rfaKind: string;
  status: string;
  targetDate: string;
  authorDiscipline: string;
  j2051MaxSeverity: string | null;
  j2051TriggerFired: boolean;
  wasLate: boolean;
  signedAt: string | null;
  signedBy: string | null;
  correctsAssessmentId: string | null;
  supersededByAssessmentId: string | null;
  snapshot: Record<string, number | null> | null;
}
interface TimepointRow {
  id: string;
  rfaKind: string;
  status: string;
  targetDate: string;
}
interface Finding {
  ruleId: string;
  severity: string;
  message: string;
}
interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

// The HOPE section list the documentation frame lays out. Only Section J (J2051 symptom impact) is
// exposed on the read; the rest are carried opaquely server-side, so their cell renders '—'.
const SECTIONS: { code: string; label: string; j2051?: boolean }[] = [
  { code: "A", label: "Administrative" },
  { code: "B", label: "Health conditions" },
  { code: "J", label: "Symptom impact (J2051)", j2051: true },
  { code: "M", label: "Medications" },
  { code: "N", label: "Care preferences" },
];

export function HopeAssessmentDetail(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<AssessmentDetail | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [timeline, setTimeline] = useState<TimepointRow[]>([]);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!id) return;
      setLoading(true);
      setError(null);
      const [a, v] = await Promise.all([
        client.GET("/api/v1/hope/assessments/{id}", { params: { path: { id } } }),
        client.GET("/api/v1/hope/assessments/{id}/validation", { params: { path: { id } } }),
      ]);
      if (!active) return;
      if (a.error || !a.data) {
        setError("Could not load the HOPE assessment.");
        setLoading(false);
        return;
      }
      const detail = a.data as AssessmentDetail;
      setRow(detail);
      setFindings((v.data?.findings ?? []) as Finding[]);
      // The timepoint rail + banner need the patient; fetch by the assessment's patientId.
      const [tl, pat] = await Promise.all([
        client.GET("/api/v1/patients/{patientId}/hope/assessments", { params: { path: { patientId: detail.patientId } } }),
        client.GET("/api/v1/patients/{id}", { params: { path: { id: detail.patientId } } }),
      ]);
      if (!active) return;
      setTimeline((tl.data?.assessments ?? []) as TimepointRow[]);
      if (pat.data) setPatient(pat.data as PatientSummary);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, id]);

  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading || !row) return <LoadingSpinner />;

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const snapshotEntries = row.snapshot ? Object.entries(row.snapshot) : [];
  const orderedTimeline = [...timeline].sort((a, b) => a.targetDate.localeCompare(b.targetDate));

  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${patient.dob}${ageYears(patient.dob) != null ? ` · ${ageYears(patient.dob)}y` : ""}`}
      chips={
        <>
          <MonoChip>{patient.mrn}</MonoChip>
          <StatusPill label={stateLabel(patient.status)} tone={ASSESSMENT_TONE[patient.status] ?? "neutral"} />
        </>
      }
    />
  ) : (
    <PatientBanner name="HOPE Assessment" />
  );

  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          {/* Timepoint rail */}
          <LeftNavRail ariaLabel="HOPE timepoints">
            <span style={railHead}>Timepoints</span>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.125rem" }}>
              {orderedTimeline.map((tp) => {
                const current = tp.id === row.id;
                const inner = (
                  <>
                    <span style={{ fontWeight: current ? 600 : 500 }}>{rfaLabel(tp.rfaKind)}</span>
                    <span style={tpDate} className="tabular-nums">{tp.targetDate.slice(0, 10)}</span>
                  </>
                );
                return (
                  <li key={tp.id}>
                    {current ? (
                      <span style={{ ...tpItem, ...tpItemActive }} aria-current="page">{inner}</span>
                    ) : (
                      <Link to={`/hope/assessments/${tp.id}`} style={tpItem}>{inner}</Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </LeftNavRail>

          {/* Center — timepoint header + section list */}
          <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
              <h1 style={{ margin: 0, fontFamily: t.fontDisplay, fontWeight: 500, fontSize: "1.375rem", color: t.onSurface }}>
                HOPE — {rfaLabel(row.rfaKind)} timepoint
              </h1>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                <StatusPill label={stateLabel(row.status)} tone={ASSESSMENT_TONE[row.status] ?? "neutral"} />
                {row.wasLate ? <StatusPill label="Late" tone="warning" /> : null}
              </span>
            </div>
            <p style={meta}>
              {stateLabel(row.authorDiscipline)} · target <span className="tabular-nums">{row.targetDate.slice(0, 10)}</span>
              {row.signedAt ? ` · signed ${row.signedAt.slice(0, 10)}${row.signedBy ? ` · ${row.signedBy}` : ""}` : " · unsigned"}
            </p>

            <section style={{ ...cardSurface, padding: "0.5rem 1.25rem", marginTop: "1rem" }}>
              {SECTIONS.map((s, i) => {
                const j2051Done = s.j2051 && row.j2051MaxSeverity != null;
                return (
                  <div key={s.code} style={{ ...sectionRow, borderTop: i === 0 ? "none" : ghostBorder }}>
                    <span style={{ flex: 1, color: t.onSurface }}>
                      <span style={{ fontWeight: 600 }}>Section {s.code}</span> — {s.label}
                    </span>
                    {s.j2051 ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                        <StatusPill label={stateLabel(row.j2051MaxSeverity ?? "none")} tone={J2051_TONE[row.j2051MaxSeverity ?? "none"] ?? "neutral"} />
                        {row.j2051TriggerFired ? <StatusPill label="SFV" tone="warning" glyph="alert" /> : null}
                        <StatusPill label={j2051Done ? "Recorded" : "Pending"} tone={j2051Done ? "success" : "neutral"} />
                      </span>
                    ) : (
                      <span style={{ color: t.muted, fontSize: "0.78rem" }}>completion not exposed —</span>
                    )}
                  </div>
                );
              })}
            </section>

            {snapshotEntries.length > 0 ? (
              <section style={{ marginTop: "1.25rem" }}>
                <h2 style={sectionTitle}>Clinical context snapshot (D8)</h2>
                <div style={{ ...cardSurface, padding: "1rem 1.25rem", display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
                  {snapshotEntries.map(([k, v]) => (
                    <div key={k} style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>
                      <span style={vitalLabel}>{k}</span>
                      <span className="tabular-nums" style={{ fontSize: "1.1rem", color: v == null ? t.muted : t.onSurface }}>{v ?? "—"}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          {/* Right rail — validation & triggers + iQIES submission */}
          <aside style={rightRail}>
            <div style={{ ...cardSurface, padding: "1.125rem" }}>
              <h2 style={railTitle}>Validation &amp; triggers</h2>
              {errorCount > 0 ? <GuardChip tone="error" reason={`${errorCount} validation error${errorCount === 1 ? "" : "s"} block submission`} /> : null}
              {findings.length === 0 ? (
                <p style={meta}>No findings.</p>
              ) : (
                <ul style={{ listStyle: "none", margin: "0.5rem 0 0", padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {findings.map((f) => (
                    <li key={f.ruleId} style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                      <StatusPill label={stateLabel(f.severity)} tone={SEVERITY_TONE[f.severity] ?? "neutral"} />
                      <span style={{ fontSize: "0.8rem", color: t.onSurface }}>{f.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div style={{ ...cardSurface, padding: "1.125rem" }}>
              <h2 style={railTitle}>iQIES submission</h2>
              <p style={meta}>
                The submission record (export → timecheck → accepted/rejected) is tracked in the HOPE
                submission worklist; this assessment reaches it once signed and validation is clean.
              </p>
            </div>
          </aside>
        </div>

        {/* Sticky footer — submission guard + actions */}
        <div style={footer}>
          {errorCount > 0 ? (
            <span style={guardChip}><Glyph name="lock" size={14} /> {errorCount} error{errorCount === 1 ? "" : "s"} block iQIES submission</span>
          ) : row.status !== "signed" ? (
            <span style={guardChip}><Glyph name="lock" size={14} /> Sign to enable submission</span>
          ) : (
            <span style={{ flex: 0 }} />
          )}
          <span style={{ flex: 1 }} />
          <button type="button" onClick={() => navigate("/hope/submissions")} style={ghostBtn}>Submission worklist</button>
          <button type="button" onClick={() => navigate(`/patients/${row.patientId}/hope`)} style={primaryBtn}>HOPE timeline</button>
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

function ageYears(dob: string): number | null {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a >= 0 && a < 150 ? a : null;
}
function MonoChip({ children }: { children: ReactNode }): JSX.Element {
  return <span style={{ fontFamily: t.fontMono, fontSize: "0.78rem", color: t.onSurfaceVariant, background: t.surfaceContainer, borderRadius: "9999px", padding: "0.15rem 0.55rem" }}>{children}</span>;
}

const railHead: CSSProperties = { fontSize: "0.6875rem", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: t.muted, padding: "0 0.5rem 0.5rem" };
const tpItem: CSSProperties = { display: "flex", flexDirection: "column", gap: "0.1rem", padding: "0.5rem 0.625rem", borderRadius: "0.5rem", textDecoration: "none", color: t.onSurfaceVariant, fontSize: "0.8125rem" };
const tpItemActive: CSSProperties = { background: t.primaryTint, color: t.primary };
const tpDate: CSSProperties = { fontSize: "0.72rem", color: t.muted };
const rightRail: CSSProperties = { width: "19rem", flexShrink: 0, overflow: "auto", padding: "1.5rem", background: t.surfaceLow, display: "flex", flexDirection: "column", gap: "1rem" };
const railTitle: CSSProperties = { margin: "0 0 0.625rem", fontFamily: t.fontDisplay, fontWeight: 500, fontSize: "1rem", color: t.onSurface };
const sectionTitle: CSSProperties = { fontSize: "0.6875rem", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: t.muted, margin: "0 0 0.5rem" };
const sectionRow: CSSProperties = { display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem 0", fontSize: "0.85rem" };
const vitalLabel: CSSProperties = { fontSize: "0.68rem", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: t.muted };
const footer: CSSProperties = { display: "flex", alignItems: "center", gap: "0.625rem", padding: "0.875rem 1.5rem", borderTop: ghostBorder, background: t.surfaceLowest, flexShrink: 0 };
const guardChip: CSSProperties = { display: "inline-flex", alignItems: "center", gap: "0.4rem", fontSize: "0.78rem", fontWeight: 600, color: t.warning, background: "color-mix(in srgb, var(--color-warning) 14%, transparent)", borderRadius: "9999px", padding: "0.3rem 0.7rem" };
const ghostBtn: CSSProperties = { display: "inline-flex", alignItems: "center", padding: "0.45rem 0.9rem", borderRadius: "9999px", background: t.surfaceContainer, color: t.onSurface, fontSize: "0.8125rem", fontWeight: 600, border: "none", cursor: "pointer" };
const primaryBtn: CSSProperties = { padding: "0.45rem 1rem", borderRadius: "9999px", background: t.primary, color: t.onPrimary, fontSize: "0.8125rem", fontWeight: 600, border: "none", cursor: "pointer" };
const meta: CSSProperties = { fontSize: "0.78rem", color: t.onSurfaceVariant, margin: "0.25rem 0 0" };
