import {
  EmptyState,
  Glyph,
  LoadingSpinner,
  PatientBanner,
  PatientWorkspaceLayout,
  StatusPill,
  ageYears,
  cardSurface,
  ghostBorder,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/09-assessments — Clinical Assessments Suite (M9 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md — "Use Patient Workspace + Documentation Workspace."
// Matched to the P1 Pencil frame (wardenx-P1-clinical.pen `aSIwN`): a Patient Workspace (banner) over a
// scale list | the selected scale's captures | a right-rail score trend. Every scale captured for the
// patient, newest first: scale · captured-at · captured-by discipline · server-computed score +
// interpretation · cosign-needed · SUD/redacted indicators. SUD rows the caller may not see are dropped
// SERVER-side (§7.6, `redacted: true`) — never a frontend hide. Reads GET /patients/:patientId/assessments
// (+ the patient summary for the banner). Honest gap: the timeline exposes each capture's TOTAL score, not
// the per-item breakdown the frame's symptom bars show — so the center shows the real score + the capture
// history, and the right rail plots the real score trend, rather than fabricating per-symptom values.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ASSESSMENT_TONE, stateLabel } from "./assessment-status";

interface AssessmentRow {
  id: string;
  patientId: string;
  scaleType: string;
  score: number | null;
  scoreInterpretation: string | null;
  capturedAt: string;
  capturedByDiscipline: string;
  cosignRequired: boolean;
  cosignedAt: string | null;
  sudContext: boolean;
  status: string;
  redacted: boolean;
}
interface PatientSummary {
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

export function AssessmentTimeline(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const [items, setItems] = useState<AssessmentRow[]>([]);
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [scale, setScale] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!patientId) return;
      setLoading(true);
      setError(null);
      const [aRes, pRes] = await Promise.all([
        client.GET("/api/v1/patients/{patientId}/assessments", { params: { path: { patientId } } }),
        client.GET("/api/v1/patients/{id}", { params: { path: { id: patientId } } }),
      ]);
      if (!active) return;
      if (pRes.data) setPatient(pRes.data as PatientSummary);
      if (aRes.error) {
        setError("Could not load assessments.");
        setLoading(false);
        return;
      }
      setItems((aRes.data?.assessments ?? []) as AssessmentRow[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, patientId]);

  // One entry per distinct scale, with its captures (newest first) + latest summary — the left list.
  const scales = useMemo(() => {
    const by = new Map<string, AssessmentRow[]>();
    for (const a of items) by.set(a.scaleType, [...(by.get(a.scaleType) ?? []), a]);
    return [...by.entries()]
      .map(([scaleType, rows]) => {
        const sorted = [...rows].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
        return { scaleType, rows: sorted, latest: sorted[0]!, count: rows.length };
      })
      .sort((a, b) => b.latest.capturedAt.localeCompare(a.latest.capturedAt));
  }, [items]);

  // Default-select the most recently captured scale.
  useEffect(() => {
    if (scale === null && scales.length > 0) setScale(scales[0]!.scaleType);
  }, [scale, scales]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const banner = patient ? (
    <PatientBanner
      name={`${patient.firstName} ${patient.lastName}`}
      meta={`DOB ${patient.dob}${ageYears(patient.dob) != null ? ` · ${ageYears(patient.dob)}y` : ""}`}
      chips={
        <>
          <MonoChip>{patient.mrn}</MonoChip>
          <StatusPill
            label={stateLabel(patient.status)}
            tone={ASSESSMENT_TONE[patient.status] ?? "neutral"}
          />
        </>
      }
    />
  ) : (
    <PatientBanner name="Assessments" />
  );

  if (items.length === 0) {
    return (
      <PatientWorkspaceLayout banner={banner}>
        <EmptyState
          title="No assessments"
          description="No clinical scales have been recorded for this patient."
        />
      </PatientWorkspaceLayout>
    );
  }

  const selected = scales.find((s) => s.scaleType === scale) ?? scales[0]!;
  // Chronological (oldest→newest) numeric scores → the right-rail trend bars.
  const series = [...selected.rows].reverse().filter((r) => r.score != null) as (AssessmentRow & {
    score: number;
  })[];

  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
        {/* Scale list */}
        <div style={scaleListStyle}>
          <span style={listHead}>Scales</span>
          {scales.map((s) => {
            const active = s.scaleType === selected.scaleType;
            const needsCosign = s.latest.cosignRequired && !s.latest.cosignedAt;
            return (
              <button
                key={s.scaleType}
                type="button"
                onClick={() => setScale(s.scaleType)}
                style={{ ...scaleItem, ...(active ? scaleItemActive : null) }}
              >
                <span
                  style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontWeight: 600 }}
                >
                  {s.scaleType}
                  {s.latest.sudContext ? (
                    <Glyph name="lock" size={12} label="Substance-use context" />
                  ) : null}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <span style={listMeta}>{s.count}</span>
                  {needsCosign ? <span style={cosignDot} title="Cosignature pending" /> : null}
                </span>
              </button>
            );
          })}
        </div>

        {/* Selected scale — latest score + capture history */}
        <div style={{ flex: 1, overflow: "auto", padding: "1.5rem", minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: "1rem",
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
              {selected.scaleType}
            </h1>
            {selected.latest.redacted ? (
              <span style={restricted}>
                <Glyph name="lock" size={12} /> redacted
              </span>
            ) : (
              <div style={{ textAlign: "right" }}>
                <div
                  className="tabular-nums"
                  style={{ fontSize: "2rem", fontWeight: 700, lineHeight: 1, color: t.onSurface }}
                >
                  {selected.latest.score ?? "—"}
                </div>
                {selected.latest.scoreInterpretation ? (
                  <div style={{ fontSize: "0.78rem", color: t.onSurfaceVariant }}>
                    {selected.latest.scoreInterpretation}
                  </div>
                ) : null}
              </div>
            )}
          </div>
          <p style={{ ...meta, marginTop: "0.25rem" }}>
            Each capture's total score is shown; the per-item breakdown renders here once the
            assessment read exposes individual scale items.
          </p>

          <section style={{ ...cardSurface, padding: "0.5rem 1.25rem", marginTop: "1rem" }}>
            {selected.rows.map((a, i) => {
              const needsCosign = a.cosignRequired && !a.cosignedAt;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() =>
                    patientId && navigate(`/patients/${patientId}/scales/${a.scaleType}`)
                  }
                  style={{ ...captureRow, borderTop: i === 0 ? "none" : ghostBorder }}
                >
                  <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                    <span className="tabular-nums" style={{ color: t.onSurface }}>
                      {a.capturedAt.slice(0, 16).replace("T", " ")}
                    </span>
                    <span style={{ ...meta, margin: 0 }}>
                      {" "}
                      · {stateLabel(a.capturedByDiscipline)}
                    </span>
                  </span>
                  {a.redacted ? (
                    <span style={meta}>Redacted</span>
                  ) : (
                    <span className="tabular-nums" style={{ fontWeight: 600, color: t.onSurface }}>
                      {a.score ?? "—"}
                      {a.scoreInterpretation ? (
                        <span style={tag}> {a.scoreInterpretation}</span>
                      ) : null}
                    </span>
                  )}
                  <StatusPill
                    label={stateLabel(a.status)}
                    tone={ASSESSMENT_TONE[a.status] ?? "neutral"}
                  />
                  {needsCosign ? <StatusPill label="Cosign needed" tone="warning" /> : null}
                  <Glyph name="arrow-right" size={16} />
                </button>
              );
            })}
          </section>
        </div>

        {/* Right rail — real score trend for the selected scale */}
        <aside style={rightRail}>
          <div style={{ ...cardSurface, padding: "1.125rem" }}>
            <h2 style={railTitle}>{selected.scaleType} trend</h2>
            {series.length === 0 ? (
              <p style={meta}>No numeric scores to trend.</p>
            ) : (
              <Trend series={series} />
            )}
            <p style={{ ...meta, marginTop: "0.5rem" }}>
              {series.length} scored capture{series.length === 1 ? "" : "s"} · significant changes
              are triaged in the changes inbox.
            </p>
          </div>
        </aside>
      </div>
    </PatientWorkspaceLayout>
  );
}

// A compact bar chart of the real per-capture scores (oldest → newest), normalized to the max.
function Trend({ series }: { series: (AssessmentRow & { score: number })[] }): JSX.Element {
  const max = Math.max(...series.map((s) => s.score), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: "0.35rem", height: "5rem" }}>
      {series.map((s) => (
        <div
          key={s.id}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: "0.2rem",
          }}
          title={`${s.capturedAt.slice(0, 10)} · ${s.score}`}
        >
          <span className="tabular-nums" style={{ fontSize: "0.6rem", color: t.onSurfaceVariant }}>
            {s.score}
          </span>
          <div
            style={{
              width: "100%",
              height: `${Math.max(8, (s.score / max) * 100)}%`,
              background: t.primary,
              borderRadius: "0.25rem 0.25rem 0 0",
            }}
          />
        </div>
      ))}
    </div>
  );
}

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

const scaleListStyle: CSSProperties = {
  width: "13rem",
  flexShrink: 0,
  borderRight: ghostBorder,
  padding: "1rem 0.75rem",
  overflow: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "0.125rem",
};
const listHead: CSSProperties = {
  fontSize: "0.6875rem",
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: t.muted,
  padding: "0 0.5rem 0.5rem",
};
const scaleItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
  padding: "0.5rem 0.625rem",
  borderRadius: "0.5rem",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: "0.8125rem",
  color: t.onSurface,
  textAlign: "left",
};
const scaleItemActive: CSSProperties = { background: t.primaryTint, color: t.primary };
const listMeta: CSSProperties = { fontSize: "0.72rem", color: t.muted };
const cosignDot: CSSProperties = {
  width: "0.45rem",
  height: "0.45rem",
  borderRadius: "9999px",
  background: t.warning,
};
const rightRail: CSSProperties = {
  width: "18rem",
  flexShrink: 0,
  overflow: "auto",
  padding: "1.5rem",
  background: t.surfaceLow,
};
const railTitle: CSSProperties = {
  margin: "0 0 0.75rem",
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1rem",
  color: t.onSurface,
};
const captureRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.625rem",
  width: "100%",
  padding: "0.75rem 0",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: t.muted,
};
const meta: CSSProperties = {
  fontSize: "0.78rem",
  color: t.onSurfaceVariant,
  margin: "0.25rem 0 0",
};
const tag: CSSProperties = { color: t.muted, fontSize: "0.75rem", fontWeight: 400 };
const restricted: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.25rem",
  color: t.warning,
  fontSize: "0.72rem",
  fontWeight: 600,
};
