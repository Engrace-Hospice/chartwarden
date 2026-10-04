import {
  Button,
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

// (+ the patient summary for the banner). The timeline remains a score summary; opening a capture loads
// its server-projected per-item response detail on the dedicated capture page.

import { useEffect, useMemo, useState } from "react";

import type { CSSProperties, JSX, ReactNode } from "react";

import { useNavigate, useParams } from "react-router-dom";

import { ChartModuleRail, PatientChartBail } from "../../shell/chart-module-rail";

import { ASSESSMENT_TONE, stateLabel } from "./assessment-status";

import { type ScaleDefinition, loadPatientAdmissions, loadScaleCatalog } from "./assessments-api";

import { RecordAssessmentModal } from "./record-assessment-modal";

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

  // Named `catalog`, not `scales`: this screen already has a `scales` — the captured rows grouped by

  // scale type. This one is the INSTRUMENT definitions the capture form is rendered from (F-067).

  const [catalog, setCatalog] = useState<ScaleDefinition[]>([]);

  const [admissionId, setAdmissionId] = useState<string | null>(null);

  const [recording, setRecording] = useState(false);

  const [reloadKey, setReloadKey] = useState(0);

  // #91 / F-067 — the instrument catalog and the admission the capture is filed against. Both are

  // SERVER reads: the scale items were TypeScript interfaces a client cannot read, and until F-065

  // nothing could resolve a patient's admission (see #161). With no open admission the Record control

  // is absent rather than present-and-certain-to-fail.

  useEffect(() => {
    if (!patientId) return;

    void loadScaleCatalog(client).then(setCatalog);

    void loadPatientAdmissions(client, patientId).then((rows) =>
      setAdmissionId(rows.find((a) => a.state === "active")?.id ?? null),
    );
  }, [client, patientId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the intentional refetch trigger a completed capture bumps, not read in the body.
  useEffect(() => {
    let active = true;

    (async () => {
      if (!patientId) return;

      setLoading(true);

      setError(null);

      const [aRes, pRes] = await Promise.all([
        client.GET("/api/v1/patients/{patientId}/assessments", {
          params: { path: { patientId } },
        }),

        client.GET("/api/v1/patients/{id}", {
          params: { path: { id: patientId } },
        }),
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
  }, [client, patientId, reloadKey]);

  // One entry per distinct scale, with its captures (newest first) + latest summary — the left list.

  const scales = useMemo(() => {
    const by = new Map<string, AssessmentRow[]>();

    for (const a of items) by.set(a.scaleType, [...(by.get(a.scaleType) ?? []), a]);

    return [...by.entries()]

      .map(([scaleType, rows]) => {
        const sorted = [...rows].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));

        return {
          scaleType,

          rows: sorted,

          latest: sorted[0]!,

          count: rows.length,
        };
      })

      .sort((a, b) => b.latest.capturedAt.localeCompare(a.latest.capturedAt));
  }, [items]);

  // Default-select the most recently captured scale.

  useEffect(() => {
    if (scale === null && scales.length > 0) setScale(scales[0]!.scaleType);
  }, [scale, scales]);

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

  /** The capture form + its trigger, rendered on every branch below (including the empty state, which is

   *  exactly where a clinician most needs it). */

  const recordControls =
    patientId && admissionId ? (
      <>
        <Button onClick={() => setRecording(true)}>Record assessment</Button>

        <RecordAssessmentModal
          open={recording}
          patientId={patientId}
          admissionId={admissionId}
          scales={catalog}
          {...(scale ? { initialScaleType: scale } : {})}
          onClose={() => setRecording(false)}
          onRecorded={() => setReloadKey((k) => k + 1)}
        />
      </>
    ) : null;

  const admissionRequired = patientId && admissionId === null;

  if (loading) {
    return (
      <PatientChartBail banner={banner} patientId={patientId} current="assessments">
        <div style={centeredStateStyle}>
          <LoadingSpinner />
          <span style={stateHelperText}>Loading assessments…</span>
        </div>
      </PatientChartBail>
    );
  }

  if (error) {
    return (
      <PatientWorkspaceLayout banner={banner}>
        <div style={workspaceShellStyle}>
          <ChartModuleRail patientId={patientId ?? ""} current="assessments" />
          <main style={fullWidthContentStyle}>
            <InlineAlert
              tone="error"
              title="Assessments could not be loaded"
              message={error}
              action={
                <Button size="sm" tone="secondary" onClick={() => setReloadKey((k) => k + 1)}>
                  Try again
                </Button>
              }
            />
            <div style={{ marginTop: "1rem" }}>
              <EmptyState
                title="Assessment history unavailable"
                description="The rest of the patient chart is still available. Retry when the assessments service is reachable."
              />
            </div>
          </main>
        </div>
      </PatientWorkspaceLayout>
    );
  }

  if (items.length === 0) {
    return (
      <PatientWorkspaceLayout banner={banner}>
        <div style={workspaceShellStyle}>
          <ChartModuleRail patientId={patientId ?? ""} current="assessments" />

          <main style={fullWidthContentStyle}>
            <div style={pageHeadingRowStyle}>
              <div>
                <p style={eyebrowStyle}>Clinical assessments</p>
                <h1 style={pageTitleStyle}>Assessment history</h1>
                <p style={pageDescriptionStyle}>
                  Record standardized clinical scales and follow changes over time.
                </p>
              </div>
              {recordControls}
            </div>

            {admissionRequired ? (
              <InlineAlert
                tone="warning"
                title="Active admission required"
                message="This patient does not currently have an active admission. Assessments can be reviewed here, but a new assessment cannot be recorded until an admission is active."
              />
            ) : null}

            <section style={{ ...cardSurface, ...emptyCardStyle }}>
              <EmptyState
                title="No assessments recorded"
                description="Once a clinician records a scale, its latest score, history, status and trend will appear here."
              />
            </section>
          </main>
        </div>
      </PatientWorkspaceLayout>
    );
  }

  const selected = scales.find((s) => s.scaleType === scale) ?? scales[0]!;
  const series = [...selected.rows].reverse().filter((r) => r.score != null) as (AssessmentRow & {
    score: number;
  })[];
  const pendingCosignCount = selected.rows.filter(
    (row) => row.cosignRequired && !row.cosignedAt,
  ).length;

  return (
    <PatientWorkspaceLayout banner={banner}>
      <div style={workspaceShellStyle}>
        <ChartModuleRail patientId={patientId ?? ""} current="assessments" />

        <div style={assessmentGridStyle}>
          {/* Scale navigation */}
          <aside style={scaleListStyle}>
            <div style={scaleListHeaderStyle}>
              <div>
                <span style={listHead}>Scales</span>
                <p style={scaleListHint}>
                  {scales.length} recorded instrument
                  {scales.length === 1 ? "" : "s"}
                </p>
              </div>
              <div style={recordButtonWrap}>{recordControls}</div>
            </div>

            {admissionRequired ? (
              <div style={{ padding: "0 0.5rem 0.75rem" }}>
                <InlineAlert
                  tone="warning"
                  compact
                  title="Recording unavailable"
                  message="An active admission is required."
                />
              </div>
            ) : null}

            <nav aria-label="Assessment scales" style={scaleNavStyle}>
              {scales.map((s) => {
                const active = s.scaleType === selected.scaleType;
                const needsCosign = s.latest.cosignRequired && !s.latest.cosignedAt;
                return (
                  <button
                    key={s.scaleType}
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => setScale(s.scaleType)}
                    style={{
                      ...scaleItem,
                      ...(active ? scaleItemActive : null),
                    }}
                  >
                    <span style={scaleItemPrimaryStyle}>
                      <span style={scaleNameStyle}>{formatScaleName(s.scaleType)}</span>
                      <span style={scaleItemSecondaryStyle}>
                        Latest {formatCapturedDate(s.latest.capturedAt)}
                      </span>
                    </span>

                    <span style={scaleItemTrailingStyle}>
                      <span style={countBadgeStyle}>{s.count}</span>
                      {needsCosign ? (
                        <span
                          style={cosignDot}
                          title="Cosignature pending"
                          aria-label="Cosignature pending"
                        />
                      ) : null}
                      {s.latest.sudContext ? (
                        <Glyph name="lock" size={12} label="Substance-use context" />
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </nav>
          </aside>

          {/* Selected scale content */}
          <main style={assessmentContentStyle}>
            <div style={contentInnerStyle}>
              <header style={selectedScaleHeaderStyle}>
                <div style={{ minWidth: 0 }}>
                  <p style={eyebrowStyle}>Selected scale</p>
                  <div style={titleWithBadgeStyle}>
                    <h1 style={selectedScaleTitleStyle}>{formatScaleName(selected.scaleType)}</h1>
                    <span style={captureCountChipStyle}>
                      {selected.count} capture{selected.count === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p style={pageDescriptionStyle}>
                    Review the latest result and the complete capture history for this instrument.
                  </p>
                </div>

                <LatestScoreCard assessment={selected.latest} />
              </header>

              {pendingCosignCount > 0 ? (
                <InlineAlert
                  tone="warning"
                  title={`${pendingCosignCount} capture${pendingCosignCount === 1 ? "" : "s"} need cosignature`}
                  message="Review the assessment history below and complete the outstanding cosignature workflow."
                />
              ) : null}

              {selected.latest.redacted ? (
                <InlineAlert
                  tone="warning"
                  title="Restricted assessment data"
                  message="Some assessment content is redacted by the server for this viewer. Access restrictions are enforced server-side."
                />
              ) : null}

              <section style={historySectionStyle}>
                <div style={sectionHeadingStyle}>
                  <div>
                    <h2 style={sectionTitleStyle}>Capture history</h2>
                    <p style={sectionDescriptionStyle}>
                      Newest first. Open a capture to review its assessment details.
                    </p>
                  </div>
                </div>

                <div style={historyListStyle}>
                  {selected.rows.map((a, i) => {
                    const needsCosign = a.cosignRequired && !a.cosignedAt;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() =>
                          patientId && navigate(`/patients/${patientId}/assessments/${a.id}`)
                        }
                        style={{
                          ...captureRow,
                          borderTop: i === 0 ? "none" : ghostBorder,
                        }}
                      >
                        <span style={captureDateColumnStyle}>
                          <span className="tabular-nums" style={captureDateStyle}>
                            {formatCapturedDateTime(a.capturedAt)}
                          </span>
                          <span style={captureMetaStyle}>{stateLabel(a.capturedByDiscipline)}</span>
                        </span>

                        <span style={captureScoreColumnStyle}>
                          {a.redacted ? (
                            <span style={restricted}>
                              <Glyph name="lock" size={12} /> Redacted
                            </span>
                          ) : (
                            <>
                              <span className="tabular-nums" style={captureScoreStyle}>
                                {a.score ?? "—"}
                              </span>
                              {a.scoreInterpretation ? (
                                <span style={captureInterpretationStyle}>
                                  {a.scoreInterpretation}
                                </span>
                              ) : (
                                <span style={captureInterpretationStyle}>No interpretation</span>
                              )}
                            </>
                          )}
                        </span>

                        <span style={captureStatusColumnStyle}>
                          <StatusPill
                            label={stateLabel(a.status)}
                            tone={ASSESSMENT_TONE[a.status] ?? "neutral"}
                          />
                          {needsCosign ? <StatusPill label="Cosign needed" tone="warning" /> : null}
                        </span>

                        <span style={rowArrowStyle}>
                          <Glyph name="arrow-right" size={16} />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
          </main>

          {/* Sticky score trend */}
          <aside style={rightRail}>
            <div style={stickyRailInnerStyle}>
              <section style={trendCardStyle}>
                <div style={trendHeaderStyle}>
                  <div>
                    <p style={eyebrowStyle}>Score trend</p>
                    <h2 style={railTitle}>{formatScaleName(selected.scaleType)}</h2>
                  </div>
                  {!selected.latest.redacted && selected.latest.score != null ? (
                    <span className="tabular-nums" style={railScoreStyle}>
                      {selected.latest.score}
                    </span>
                  ) : null}
                </div>

                {series.length === 0 ? (
                  <div style={trendEmptyStyle}>
                    <Glyph name="bar-chart" size={18} />
                    <p style={{ ...meta, margin: 0 }}>No numeric scores to trend yet.</p>
                  </div>
                ) : (
                  <Trend series={series} />
                )}

                <div style={trendStatsStyle}>
                  <TrendStat label="Captures" value={String(series.length)} />
                  <TrendStat
                    label="Latest"
                    value={selected.latest.score != null ? String(selected.latest.score) : "—"}
                  />
                </div>

                {selected.latest.scoreInterpretation ? (
                  <div style={interpretationBoxStyle}>
                    <span style={interpretationLabelStyle}>Latest interpretation</span>
                    <span style={interpretationValueStyle}>
                      {selected.latest.scoreInterpretation}
                    </span>
                  </div>
                ) : null}

                <p style={railHelperText}>
                  Scores are ordered oldest to newest. Significant changes continue to be triaged
                  through the changes inbox.
                </p>
              </section>
            </div>
          </aside>
        </div>
      </div>
    </PatientWorkspaceLayout>
  );
}

// A compact bar chart of the real per-capture scores (oldest → newest), normalized to the max.
function Trend({
  series,
}: {
  series: (AssessmentRow & { score: number })[];
}): JSX.Element {
  const max = Math.max(...series.map((s) => s.score), 1);

  return (
    <div style={trendChartStyle}>
      {series.map((s) => (
        <div
          key={s.id}
          style={trendBarColumnStyle}
          title={`${formatCapturedDate(s.capturedAt)} · ${s.score}`}
        >
          <span className="tabular-nums" style={trendValueStyle}>
            {s.score}
          </span>
          <div style={trendTrackStyle}>
            <div
              style={{
                ...trendBarStyle,
                height: `${Math.max(8, (s.score / max) * 100)}%`,
              }}
            />
          </div>
          <span style={trendDateStyle}>{formatShortDate(s.capturedAt)}</span>
        </div>
      ))}
    </div>
  );
}

function LatestScoreCard({
  assessment,
}: {
  assessment: AssessmentRow;
}): JSX.Element {
  if (assessment.redacted) {
    return (
      <div style={latestScoreCardStyle}>
        <span style={scoreCardLabelStyle}>Latest result</span>
        <span style={restricted}>
          <Glyph name="lock" size={12} /> Redacted
        </span>
      </div>
    );
  }

  return (
    <div style={latestScoreCardStyle}>
      <span style={scoreCardLabelStyle}>Latest score</span>
      <span className="tabular-nums" style={latestScoreValueStyle}>
        {assessment.score ?? "—"}
      </span>
      <span style={latestScoreInterpretationStyle}>
        {assessment.scoreInterpretation ?? "No interpretation available"}
      </span>
      <span style={latestScoreDateStyle}>Captured {formatCapturedDate(assessment.capturedAt)}</span>
    </div>
  );
}

function TrendStat({
  label,
  value,
}: {
  label: string;
  value: string;
}): JSX.Element {
  return (
    <div style={trendStatStyle}>
      <span style={trendStatLabelStyle}>{label}</span>
      <span className="tabular-nums" style={trendStatValueStyle}>
        {value}
      </span>
    </div>
  );
}

function InlineAlert({
  tone,
  title,
  message,
  action,
  compact = false,
}: {
  tone: "error" | "warning" | "info";
  title: string;
  message: string;
  action?: ReactNode;
  compact?: boolean;
}): JSX.Element {
  const toneStyle =
    tone === "error" ? alertErrorStyle : tone === "warning" ? alertWarningStyle : alertInfoStyle;

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      style={{
        ...alertBaseStyle,
        ...toneStyle,
        ...(compact ? alertCompactStyle : null),
      }}
    >
      <div style={alertIconWrapStyle}>
        <Glyph name="alert" size={16} />
      </div>
      <div style={alertContentStyle}>
        <div style={alertTitleStyle}>{title}</div>
        <div style={alertMessageStyle}>{message}</div>
      </div>
      {action ? <div style={alertActionStyle}>{action}</div> : null}
    </div>
  );
}

function MonoChip({ children }: { children: ReactNode }): JSX.Element {
  return <span style={monoChipStyle}>{children}</span>;
}

function formatScaleName(scaleType: string): string {
  return scaleType.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatCapturedDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16).replace("T", " ");

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCapturedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(5, 10);

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

const workspaceShellStyle: CSSProperties = {
  display: "flex",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  height: "100%",
  overflow: "hidden",
};

const fullWidthContentStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "auto",
  padding: "1.5rem",
};

const centeredStateStyle: CSSProperties = {
  minHeight: "14rem",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.75rem",
};

const stateHelperText: CSSProperties = {
  fontSize: "0.8rem",
  color: t.onSurfaceVariant,
};

const assessmentGridStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: "grid",
  gridTemplateColumns: "13.5rem minmax(0, 1fr) 19rem",
  overflow: "hidden",
  background: t.surface,
};

const scaleListStyle: CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  borderRight: ghostBorder,
  background: t.surfaceLow,
  padding: "1rem 0.75rem",
  overflowY: "auto",
  overflowX: "hidden",
};

const scaleListHeaderStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  paddingBottom: "0.75rem",
};

const listHead: CSSProperties = {
  display: "block",
  fontSize: "0.6875rem",
  fontWeight: 700,
  color: t.muted,
};

const scaleListHint: CSSProperties = {
  margin: "0.2rem 0 0",
  fontSize: "0.75rem",
  lineHeight: 1.4,
  color: t.onSurfaceVariant,
};

const recordButtonWrap: CSSProperties = {
  width: "100%",
};

const scaleNavStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.35rem",
};

const scaleItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.65rem",
  width: "100%",
  padding: "0.7rem 0.75rem",
  borderRadius: "0.65rem",
  border: "1px solid transparent",
  background: "transparent",
  cursor: "pointer",
  color: t.onSurface,
  textAlign: "left",
  transition: "background 120ms ease, border-color 120ms ease",
};

const scaleItemActive: CSSProperties = {
  background: t.primaryTint,
  color: t.primary,
  borderColor: "color-mix(in srgb, var(--color-primary) 18%, transparent)",
};

const scaleItemPrimaryStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  gap: "0.15rem",
};

const scaleNameStyle: CSSProperties = {
  fontSize: "0.82rem",
  lineHeight: 1.2,
  fontWeight: 650,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const scaleItemSecondaryStyle: CSSProperties = {
  fontSize: "0.68rem",
  lineHeight: 1.2,
  color: t.onSurfaceVariant,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const scaleItemTrailingStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
  flexShrink: 0,
};

const countBadgeStyle: CSSProperties = {
  minWidth: "1.35rem",
  height: "1.35rem",
  padding: "0 0.35rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurfaceVariant,
  fontSize: "0.68rem",
  fontWeight: 700,
};

const cosignDot: CSSProperties = {
  width: "0.45rem",
  height: "0.45rem",
  borderRadius: "9999px",
  background: t.warning,
  boxShadow: `0 0 0 2px ${t.surfaceLow}`,
};

const assessmentContentStyle: CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  overflowY: "auto",
  overflowX: "hidden",
  background: t.surface,
};

const contentInnerStyle: CSSProperties = {
  width: "100%",
  maxWidth: "72rem",
  margin: "0 auto",
  padding: "1.5rem",
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
};

const selectedScaleHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1.25rem",
};

const titleWithBadgeStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.65rem",
  flexWrap: "wrap",
};

const eyebrowStyle: CSSProperties = {
  margin: "0 0 0.3rem",
  fontSize: "0.8125rem",
  lineHeight: 1.2,
  fontWeight: 500,
  color: t.muted,
};

const selectedScaleTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 600,
  fontSize: "1.55rem",
  lineHeight: 1.2,
  color: t.onSurface,
};

const captureCountChipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "1.5rem",
  padding: "0.15rem 0.55rem",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurfaceVariant,
  fontSize: "0.72rem",
  fontWeight: 600,
};

const pageHeadingRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "1rem",
  marginBottom: "1rem",
};

const pageTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 600,
  fontSize: "1.55rem",
  color: t.onSurface,
};

const pageDescriptionStyle: CSSProperties = {
  margin: "0.35rem 0 0",
  maxWidth: "46rem",
  fontSize: "0.8rem",
  lineHeight: 1.5,
  color: t.onSurfaceVariant,
};

const emptyCardStyle: CSSProperties = {
  marginTop: "1rem",
  padding: "2rem",
  textAlign: "center",
};

const latestScoreCardStyle: CSSProperties = {
  ...cardSurface,
  minWidth: "14rem",
  maxWidth: "19rem",
  padding: "0.9rem 1rem",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: "0.2rem",
};

const scoreCardLabelStyle: CSSProperties = {
  fontSize: "0.68rem",
  fontWeight: 700,
  color: t.muted,
};

const latestScoreValueStyle: CSSProperties = {
  fontSize: "2rem",
  lineHeight: 1,
  fontWeight: 750,
  color: t.onSurface,
};

const latestScoreInterpretationStyle: CSSProperties = {
  fontSize: "0.75rem",
  lineHeight: 1.35,
  color: t.onSurfaceVariant,
  textAlign: "right",
};

const latestScoreDateStyle: CSSProperties = {
  marginTop: "0.25rem",
  fontSize: "0.68rem",
  color: t.muted,
};

const historySectionStyle: CSSProperties = {
  ...cardSurface,
  overflow: "hidden",
};

const sectionHeadingStyle: CSSProperties = {
  padding: "1rem 1.1rem 0.85rem",
  borderBottom: ghostBorder,
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontSize: "1rem",
  fontWeight: 600,
  color: t.onSurface,
};

const sectionDescriptionStyle: CSSProperties = {
  margin: "0.2rem 0 0",
  fontSize: "0.75rem",
  color: t.onSurfaceVariant,
};

const historyListStyle: CSSProperties = {
  padding: "0 1.1rem",
};

const captureRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(10rem, 1.35fr) minmax(10rem, 1fr) auto 1.5rem",
  alignItems: "center",
  gap: "0.9rem",
  width: "100%",
  minHeight: "4.35rem",
  padding: "0.75rem 0",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: t.onSurface,
  textAlign: "left",
};

const captureDateColumnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  gap: "0.18rem",
};

const captureDateStyle: CSSProperties = {
  fontSize: "0.82rem",
  fontWeight: 600,
  color: t.onSurface,
};

const captureMetaStyle: CSSProperties = {
  fontSize: "0.72rem",
  color: t.onSurfaceVariant,
};

const captureScoreColumnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  gap: "0.12rem",
};

const captureScoreStyle: CSSProperties = {
  fontSize: "1rem",
  fontWeight: 700,
  color: t.onSurface,
};

const captureInterpretationStyle: CSSProperties = {
  fontSize: "0.72rem",
  lineHeight: 1.3,
  color: t.onSurfaceVariant,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const captureStatusColumnStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "0.4rem",
  flexWrap: "wrap",
};

const rowArrowStyle: CSSProperties = {
  color: t.muted,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const rightRail: CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  borderLeft: ghostBorder,
  background: t.surfaceLow,
  overflowY: "auto",
  overflowX: "hidden",
};

const stickyRailInnerStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  padding: "1.5rem 1rem",
};

const trendCardStyle: CSSProperties = {
  ...cardSurface,
  padding: "1rem",
};

const trendHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "0.75rem",
};

const railTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 600,
  fontSize: "1rem",
  color: t.onSurface,
};

const railScoreStyle: CSSProperties = {
  fontSize: "1.45rem",
  lineHeight: 1,
  fontWeight: 750,
  color: t.onSurface,
};

const trendChartStyle: CSSProperties = {
  height: "8rem",
  display: "flex",
  alignItems: "stretch",
  gap: "0.4rem",
  marginTop: "1rem",
  paddingTop: "0.25rem",
};

const trendBarColumnStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "0.25rem",
};

const trendValueStyle: CSSProperties = {
  minHeight: "0.8rem",
  fontSize: "0.62rem",
  color: t.onSurfaceVariant,
};

const trendTrackStyle: CSSProperties = {
  position: "relative",
  flex: 1,
  width: "100%",
  minHeight: "4.5rem",
  display: "flex",
  alignItems: "flex-end",
  borderRadius: "0.3rem",
  background: t.surfaceContainer,
  overflow: "hidden",
};

const trendBarStyle: CSSProperties = {
  width: "100%",
  minHeight: "0.45rem",
  background: t.primary,
  borderRadius: "0.3rem 0.3rem 0 0",
};

const trendDateStyle: CSSProperties = {
  maxWidth: "100%",
  fontSize: "0.58rem",
  color: t.muted,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const trendEmptyStyle: CSSProperties = {
  marginTop: "1rem",
  minHeight: "7rem",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.5rem",
  borderRadius: "0.6rem",
  background: t.surfaceLow,
  color: t.muted,
  textAlign: "center",
};

const trendStatsStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "0.5rem",
  marginTop: "0.9rem",
};

const trendStatStyle: CSSProperties = {
  padding: "0.65rem 0.7rem",
  borderRadius: "0.55rem",
  background: t.surfaceLow,
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
};

const trendStatLabelStyle: CSSProperties = {
  fontSize: "0.65rem",
  color: t.muted,
};

const trendStatValueStyle: CSSProperties = {
  fontSize: "0.9rem",
  fontWeight: 700,
  color: t.onSurface,
};

const interpretationBoxStyle: CSSProperties = {
  marginTop: "0.75rem",
  padding: "0.75rem",
  borderRadius: "0.55rem",
  background: t.primaryTint,
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
};

const interpretationLabelStyle: CSSProperties = {
  fontSize: "0.64rem",
  fontWeight: 700,
  color: t.primary,
};

const interpretationValueStyle: CSSProperties = {
  fontSize: "0.75rem",
  lineHeight: 1.4,
  color: t.onSurface,
};

const railHelperText: CSSProperties = {
  margin: "0.8rem 0 0",
  fontSize: "0.7rem",
  lineHeight: 1.45,
  color: t.onSurfaceVariant,
};

const alertBaseStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.7rem",
  width: "100%",
  padding: "0.8rem 0.9rem",
  borderRadius: "0.65rem",
  border: "1px solid transparent",
};

const alertCompactStyle: CSSProperties = {
  padding: "0.65rem 0.7rem",
};

const alertErrorStyle: CSSProperties = {
  color: "var(--color-error)",
  background: "color-mix(in srgb, var(--color-error) 10%, transparent)",
  borderColor: "color-mix(in srgb, var(--color-error) 28%, transparent)",
};

const alertWarningStyle: CSSProperties = {
  color: t.warning,
  background: "color-mix(in srgb, var(--color-warning) 10%, transparent)",
  borderColor: "color-mix(in srgb, var(--color-warning) 28%, transparent)",
};

const alertInfoStyle: CSSProperties = {
  color: t.primary,
  background: t.primaryTint,
  borderColor: "color-mix(in srgb, var(--color-primary) 24%, transparent)",
};

const alertIconWrapStyle: CSSProperties = {
  paddingTop: "0.05rem",
  flexShrink: 0,
};

const alertContentStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
};

const alertTitleStyle: CSSProperties = {
  fontSize: "0.78rem",
  lineHeight: 1.3,
  fontWeight: 700,
  color: "currentColor",
};

const alertMessageStyle: CSSProperties = {
  marginTop: "0.16rem",
  fontSize: "0.73rem",
  lineHeight: 1.45,
  color: t.onSurfaceVariant,
};

const alertActionStyle: CSSProperties = {
  flexShrink: 0,
};

const meta: CSSProperties = {
  fontSize: "0.78rem",
  color: t.onSurfaceVariant,
  margin: "0.25rem 0 0",
};

const restricted: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.25rem",
  color: t.warning,
  fontSize: "0.72rem",
  fontWeight: 650,
};

const monoChipStyle: CSSProperties = {
  fontFamily: t.fontMono,
  fontSize: "0.78rem",
  color: t.onSurfaceVariant,
  background: t.surfaceContainer,
  borderRadius: "9999px",
  padding: "0.15rem 0.55rem",
};
