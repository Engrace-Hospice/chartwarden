import {
  Button,
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/09-assessments — Per-scale trend view (M9 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md —
// "Use Patient Workspace + Documentation Workspace."
//
// A patient's scored series for one scale over a default 90-day window:
// score-over-time + capture history + significant-change markers.
//
// Reads GET /api/v1/patients/:patientId/scales/:scaleType/series.
// Authorization is enforced server-side.

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";

interface SeriesPoint {
  assessmentId: string;
  capturedAt: string;
  score: number | null;
  scoreInterpretation: string | null;
  significantChange: boolean;
}

/** Default trend window: the last 90 days (§5.2 "default 90 days"). */
function defaultWindow(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);

  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}

export function ScaleTrend(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();

  const { patientId, scaleType } = useParams<{
    patientId: string;
    scaleType: string;
  }>();

  const [points, setPoints] = useState<SeriesPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the intentional refetch trigger, not read in the body.
  useEffect(() => {
    let active = true;

    (async () => {
      if (!patientId || !scaleType) return;

      setLoading(true);
      setError(null);

      const { from, to } = defaultWindow();

      const { data, error: err } = await client.GET(
        "/api/v1/patients/{patientId}/scales/{scaleType}/series",
        {
          params: {
            path: {
              patientId,
              scaleType,
            },
            query: {
              from,
              to,
            },
          },
        },
      );

      if (!active) return;

      if (err) {
        setError("The assessment trend could not be loaded.");
        setLoading(false);
        return;
      }

      setPoints((data?.points ?? []) as SeriesPoint[]);
      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, [client, patientId, scaleType, reloadKey]);

  const sortedPoints = useMemo(
    () => [...points].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)),
    [points],
  );

  const chronologicalPoints = useMemo(
    () => [...points].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)),
    [points],
  );

  const scoredPoints = useMemo(
    () =>
      chronologicalPoints.filter(
        (point): point is SeriesPoint & { score: number } => point.score != null,
      ),
    [chronologicalPoints],
  );

  const changeCount = points.filter((point) => point.significantChange).length;

  const latestPoint = sortedPoints[0] ?? null;

  const previousScoredPoint =
    scoredPoints.length >= 2 ? scoredPoints[scoredPoints.length - 2] : null;

  const latestScoredPoint = scoredPoints.length > 0 ? scoredPoints[scoredPoints.length - 1] : null;

  const scoreDelta =
    latestScoredPoint && previousScoredPoint
      ? latestScoredPoint.score - previousScoredPoint.score
      : null;

  const scaleLabel = formatScaleName(scaleType ?? "");

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title={`${scaleLabel} trend`}
          actions={
            <Button tone="tertiary" onClick={() => navigate(-1)}>
              Go back
            </Button>
          }
        >
          <div style={headerMetaStyle}>
            <span style={headerMetaItemStyle}>
              <Glyph name="clock" size={14} />
              Last 90 days
            </span>

            <span style={headerDividerStyle}>•</span>

            <span>
              {points.length} capture{points.length === 1 ? "" : "s"}
            </span>

            {changeCount > 0 ? (
              <>
                <span style={headerDividerStyle}>•</span>

                <span style={warningMetaStyle}>
                  <Glyph name="alert" size={14} />
                  {changeCount} significant change
                  {changeCount === 1 ? "" : "s"}
                </span>
              </>
            ) : null}
          </div>
        </PageHeader>
      }
    >
      <div style={pageStyle}>
        {error ? (
          <ErrorState message={error} onRetry={() => setReloadKey((current) => current + 1)} />
        ) : loading ? (
          <LoadingState />
        ) : points.length === 0 ? (
          <section style={emptyCardStyle}>
            <EmptyState
              title="No trend data"
              description={`No ${scaleLabel} assessments were captured during the last 90 days.`}
            />
          </section>
        ) : (
          <>
            <section style={summaryGridStyle}>
              <SummaryCard
                label="Latest score"
                value={latestPoint?.score != null ? String(latestPoint.score) : "—"}
                helper={latestPoint?.scoreInterpretation ?? "No interpretation available"}
                icon={<Glyph name="bar-chart" size={18} />}
              />

              <SummaryCard
                label="Captures"
                value={String(points.length)}
                helper="Recorded during the last 90 days"
                icon={<Glyph name="clipboard-list" size={18} />}
              />

              <SummaryCard
                label="Significant changes"
                value={String(changeCount)}
                helper={
                  changeCount === 0
                    ? "No significant changes detected"
                    : "Requires clinical attention"
                }
                tone={changeCount > 0 ? "warning" : "default"}
                icon={<Glyph name="alert" size={18} />}
              />

              <SummaryCard
                label="Previous change"
                value={
                  scoreDelta == null ? "—" : scoreDelta > 0 ? `+${scoreDelta}` : String(scoreDelta)
                }
                helper={
                  scoreDelta == null
                    ? "More scored captures are needed"
                    : "Difference from previous scored capture"
                }
                icon={<Glyph name="trending-up" size={18} />}
              />
            </section>

            <section style={trendCardStyle}>
              <div style={sectionHeaderStyle}>
                <div>
                  <p style={eyebrowStyle}>Score over time</p>

                  <h2 style={sectionTitleStyle}>{scaleLabel} trend</h2>

                  <p style={sectionDescriptionStyle}>
                    Scores are displayed chronologically from oldest to newest. Significant changes
                    are highlighted for easier review.
                  </p>
                </div>

                {latestPoint ? (
                  <div style={latestCaptureStyle}>
                    <span style={latestCaptureLabelStyle}>Latest capture</span>

                    <span style={latestCaptureValueStyle}>
                      {formatDate(latestPoint.capturedAt)}
                    </span>
                  </div>
                ) : null}
              </div>

              {scoredPoints.length > 0 ? (
                <TrendChart points={scoredPoints} />
              ) : (
                <div style={chartEmptyStyle}>
                  <Glyph name="bar-chart" size={22} />

                  <div>
                    <div style={chartEmptyTitleStyle}>No numeric scores</div>

                    <div style={chartEmptyDescriptionStyle}>
                      Captures exist, but none contain a numeric score that can be plotted.
                    </div>
                  </div>
                </div>
              )}
            </section>

            <section style={historyCardStyle}>
              <div style={sectionHeaderStyle}>
                <div>
                  <p style={eyebrowStyle}>Assessment history</p>

                  <h2 style={sectionTitleStyle}>Recorded captures</h2>

                  <p style={sectionDescriptionStyle}>
                    Newest capture first. Significant score changes are clearly identified.
                  </p>
                </div>
              </div>

              <div style={tableScrollerStyle}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={tableHeaderStyle}>Captured</th>
                      <th style={tableHeaderStyle}>Score</th>
                      <th style={tableHeaderStyle}>Interpretation</th>
                      <th
                        style={{
                          ...tableHeaderStyle,
                          textAlign: "right",
                        }}
                      >
                        Change
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {sortedPoints.map((point) => (
                      <tr
                        key={point.assessmentId}
                        style={{
                          ...tableRowStyle,
                          ...(point.significantChange ? significantRowStyle : null),
                        }}
                      >
                        <td style={tableCellStyle}>
                          <div style={dateCellStyle}>
                            <span className="tabular-nums" style={primaryCellStyle}>
                              {formatDateTime(point.capturedAt)}
                            </span>

                            <span style={secondaryCellStyle}>
                              {formatRelativeDate(point.capturedAt)}
                            </span>
                          </div>
                        </td>

                        <td style={tableCellStyle}>
                          <span className="tabular-nums" style={scoreCellStyle}>
                            {point.score ?? "—"}
                          </span>
                        </td>

                        <td style={tableCellStyle}>
                          {point.scoreInterpretation ? (
                            <span style={interpretationStyle}>{point.scoreInterpretation}</span>
                          ) : (
                            <span style={mutedValueStyle}>No interpretation</span>
                          )}
                        </td>

                        <td
                          style={{
                            ...tableCellStyle,
                            textAlign: "right",
                          }}
                        >
                          {point.significantChange ? (
                            <StatusPill label="Significant" tone="warning" glyph="alert" />
                          ) : (
                            <span style={noChangeStyle}>—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </DetailPageLayout>
  );
}

function SummaryCard({
  label,
  value,
  helper,
  icon,
  tone = "default",
}: {
  label: string;
  value: string;
  helper: string;
  icon: ReactNode;
  tone?: "default" | "warning";
}): JSX.Element {
  const warning = tone === "warning";

  return (
    <article
      style={{
        ...summaryCardStyle,
        ...(warning ? summaryWarningCardStyle : null),
      }}
    >
      <div
        style={{
          ...summaryIconStyle,
          ...(warning ? summaryWarningIconStyle : null),
        }}
      >
        {icon}
      </div>

      <div style={summaryContentStyle}>
        <span style={summaryLabelStyle}>{label}</span>

        <span
          className="tabular-nums"
          style={{
            ...summaryValueStyle,
            ...(warning ? summaryWarningValueStyle : null),
          }}
        >
          {value}
        </span>

        <span style={summaryHelperStyle}>{helper}</span>
      </div>
    </article>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div role="alert" style={errorCardStyle}>
      <div style={errorIconStyle}>
        <Glyph name="alert-circle" size={20} />
      </div>

      <div style={errorContentStyle}>
        <div style={errorTitleStyle}>Assessment trend unavailable</div>

        <div style={errorMessageStyle}>{message}</div>

        <div style={errorActionStyle}>
          <Button size="sm" tone="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}

function LoadingState(): JSX.Element {
  return (
    <div style={loadingStateStyle}>
      <LoadingSpinner />

      <span style={loadingTextStyle}>Loading assessment trend…</span>
    </div>
  );
}

function TrendChart({
  points,
}: {
  points: (SeriesPoint & { score: number })[];
}): JSX.Element {
  const scores = points.map((point) => point.score);

  const min = Math.min(...scores);
  const max = Math.max(...scores);

  const range = Math.max(max - min, 1);

  return (
    <div style={chartShellStyle}>
      <div style={chartScaleStyle}>
        <span>{max}</span>
        <span>{Math.round((max + min) / 2)}</span>
        <span>{min}</span>
      </div>

      <div style={chartStyle}>
        <div style={horizontalGuideTopStyle} />
        <div style={horizontalGuideMiddleStyle} />
        <div style={horizontalGuideBottomStyle} />

        {points.map((point, index) => {
          const normalized = ((point.score - min) / range) * 100;

          return (
            <div
              key={point.assessmentId}
              style={chartColumnStyle}
              title={`${formatDateTime(point.capturedAt)} · ${point.score}`}
            >
              <div style={chartBarAreaStyle}>
                <span className="tabular-nums" style={chartPointValueStyle}>
                  {point.score}
                </span>

                <div
                  style={{
                    ...chartBarStyle,
                    height: `${Math.max(8, normalized)}%`,
                    ...(point.significantChange ? chartBarSignificantStyle : null),
                  }}
                />

                {point.significantChange ? (
                  <span style={changeMarkerStyle} title="Significant change">
                    !
                  </span>
                ) : null}
              </div>

              <span style={chartDateStyle}>{formatShortDate(point.capturedAt)}</span>

              {index === points.length - 1 ? (
                <span style={latestMarkerStyle}>Latest</span>
              ) : (
                <span style={latestMarkerPlaceholderStyle}>&nbsp;</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatScaleName(value: string): string {
  if (!value) return "Assessment";

  return value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 10);
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatShortDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value.slice(5, 10);
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 16).replace("T", " ");
  }

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelativeDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  const today = new Date();

  const dayMs = 24 * 60 * 60 * 1000;

  const diff = Math.floor((today.getTime() - date.getTime()) / dayMs);

  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";

  return `${diff} days ago`;
}

const pageStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  width: "100%",
};

const headerMetaStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.45rem",
  flexWrap: "wrap",
  marginTop: "0.3rem",
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};

const headerMetaItemStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
};

const headerDividerStyle: CSSProperties = {
  color: "var(--color-outline)",
};

const warningMetaStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  color: "var(--color-warning)",
  fontWeight: 600,
};

const summaryGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
  gap: "0.75rem",
};

const summaryCardStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "flex-start",
  gap: "0.75rem",
  padding: "0.9rem 1rem",
  borderRadius: "var(--radius-lg)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
  background: "var(--color-surface-container-low)",
};

const summaryWarningCardStyle: CSSProperties = {
  borderColor: "color-mix(in srgb, var(--color-warning) 35%, transparent)",
  background: "color-mix(in srgb, var(--color-warning) 7%, var(--color-surface-container-low))",
};

const summaryIconStyle: CSSProperties = {
  width: "2.25rem",
  height: "2.25rem",
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "0.65rem",
  color: "var(--color-primary)",
  background: "color-mix(in srgb, var(--color-primary) 12%, transparent)",
};

const summaryWarningIconStyle: CSSProperties = {
  color: "var(--color-warning)",
  background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
};

const summaryContentStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.12rem",
};

const summaryLabelStyle: CSSProperties = {
  fontSize: "0.7rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
};

const summaryValueStyle: CSSProperties = {
  fontSize: "1.35rem",
  lineHeight: 1.2,
  fontWeight: 700,
  color: "var(--color-on-surface)",
};

const summaryWarningValueStyle: CSSProperties = {
  color: "var(--color-warning)",
};

const summaryHelperStyle: CSSProperties = {
  marginTop: "0.1rem",
  fontSize: "0.68rem",
  lineHeight: 1.35,
  color: "var(--color-on-surface-variant)",
};

const trendCardStyle: CSSProperties = {
  borderRadius: "var(--radius-lg)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
  background: "var(--color-surface-container-lowest)",
  overflow: "hidden",
};

const historyCardStyle: CSSProperties = {
  borderRadius: "var(--radius-lg)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 55%, transparent)",
  background: "var(--color-surface-container-lowest)",
  overflow: "hidden",
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "1rem",
  padding: "1rem 1.1rem",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
};

const eyebrowStyle: CSSProperties = {
  margin: "0 0 0.2rem",
  fontSize: "0.65rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color: "var(--color-on-surface-variant)",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "1rem",
  fontWeight: 650,
  color: "var(--color-on-surface)",
};

const sectionDescriptionStyle: CSSProperties = {
  maxWidth: "40rem",
  margin: "0.2rem 0 0",
  fontSize: "0.74rem",
  lineHeight: 1.45,
  color: "var(--color-on-surface-variant)",
};

const latestCaptureStyle: CSSProperties = {
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: "0.15rem",
};

const latestCaptureLabelStyle: CSSProperties = {
  fontSize: "0.65rem",
  color: "var(--color-on-surface-variant)",
};

const latestCaptureValueStyle: CSSProperties = {
  fontSize: "0.78rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const chartShellStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "2.5rem minmax(0, 1fr)",
  gap: "0.5rem",
  padding: "1rem 1.1rem 1.2rem",
  minHeight: "15rem",
};

const chartScaleStyle: CSSProperties = {
  padding: "0.95rem 0 2rem",
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  alignItems: "flex-end",
  fontSize: "0.6rem",
  color: "var(--color-on-surface-variant)",
};

const chartStyle: CSSProperties = {
  position: "relative",
  minHeight: "12rem",
  display: "flex",
  alignItems: "stretch",
  gap: "0.5rem",
  overflowX: "auto",
};

const horizontalGuideTopStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  top: "1rem",
  borderTop: "1px dashed color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
};

const horizontalGuideMiddleStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  top: "45%",
  borderTop: "1px dashed color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};

const horizontalGuideBottomStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: "2.55rem",
  borderTop: "1px dashed color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
};

const chartColumnStyle: CSSProperties = {
  position: "relative",
  zIndex: 1,
  flex: "1 0 3rem",
  maxWidth: "5rem",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "flex-end",
};

const chartBarAreaStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  flex: 1,
  display: "flex",
  flexDirection: "column",
  justifyContent: "flex-end",
  alignItems: "center",
};

const chartPointValueStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  fontSize: "0.62rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
};

const chartBarStyle: CSSProperties = {
  width: "55%",
  minHeight: "0.5rem",
  borderRadius: "0.3rem 0.3rem 0 0",
  background: "var(--color-primary)",
};

const chartBarSignificantStyle: CSSProperties = {
  background: "var(--color-warning)",
};

const changeMarkerStyle: CSSProperties = {
  position: "absolute",
  top: "1.05rem",
  right: "0.05rem",
  width: "1rem",
  height: "1rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "9999px",
  fontSize: "0.6rem",
  fontWeight: 800,
  color: "var(--color-on-warning)",
  background: "var(--color-warning)",
};

const chartDateStyle: CSSProperties = {
  marginTop: "0.35rem",
  fontSize: "0.58rem",
  color: "var(--color-on-surface-variant)",
  whiteSpace: "nowrap",
};

const latestMarkerStyle: CSSProperties = {
  marginTop: "0.2rem",
  padding: "0.05rem 0.3rem",
  borderRadius: "9999px",
  fontSize: "0.55rem",
  fontWeight: 600,
  color: "var(--color-primary)",
  background: "color-mix(in srgb, var(--color-primary) 12%, transparent)",
};

const latestMarkerPlaceholderStyle: CSSProperties = {
  marginTop: "0.2rem",
  fontSize: "0.55rem",
};

const chartEmptyStyle: CSSProperties = {
  minHeight: "12rem",
  margin: "1rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container-low)",
  color: "var(--color-on-surface-variant)",
};

const chartEmptyTitleStyle: CSSProperties = {
  fontSize: "0.8rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const chartEmptyDescriptionStyle: CSSProperties = {
  maxWidth: "26rem",
  marginTop: "0.15rem",
  fontSize: "0.7rem",
  lineHeight: 1.4,
};

const tableScrollerStyle: CSSProperties = {
  overflowX: "auto",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.8rem",
};

const tableHeaderStyle: CSSProperties = {
  padding: "0.65rem 1rem",
  textAlign: "left",
  fontSize: "0.66rem",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.045em",
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container-low)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
};

const tableRowStyle: CSSProperties = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};

const significantRowStyle: CSSProperties = {
  background: "color-mix(in srgb, var(--color-warning) 5%, transparent)",
};

const tableCellStyle: CSSProperties = {
  padding: "0.85rem 1rem",
  verticalAlign: "middle",
};

const dateCellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
};

const primaryCellStyle: CSSProperties = {
  fontWeight: 550,
  color: "var(--color-on-surface)",
};

const secondaryCellStyle: CSSProperties = {
  fontSize: "0.65rem",
  color: "var(--color-on-surface-variant)",
};

const scoreCellStyle: CSSProperties = {
  fontSize: "0.95rem",
  fontWeight: 700,
  color: "var(--color-on-surface)",
};

const interpretationStyle: CSSProperties = {
  lineHeight: 1.4,
  color: "var(--color-on-surface)",
};

const mutedValueStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
};

const noChangeStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
};

const errorCardStyle: CSSProperties = {
  display: "flex",
  gap: "0.75rem",
  padding: "1rem",
  borderRadius: "var(--radius-lg)",
  border: "1px solid color-mix(in srgb, var(--color-error) 32%, transparent)",
  background: "color-mix(in srgb, var(--color-error) 8%, transparent)",
};

const errorIconStyle: CSSProperties = {
  flexShrink: 0,
  color: "var(--color-error)",
};

const errorContentStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
};

const errorTitleStyle: CSSProperties = {
  fontSize: "0.82rem",
  fontWeight: 700,
  color: "var(--color-error)",
};

const errorMessageStyle: CSSProperties = {
  marginTop: "0.2rem",
  fontSize: "0.75rem",
  lineHeight: 1.45,
  color: "var(--color-on-surface-variant)",
};

const errorActionStyle: CSSProperties = {
  marginTop: "0.7rem",
};

const loadingStateStyle: CSSProperties = {
  minHeight: "18rem",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.75rem",
};

const loadingTextStyle: CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};

const emptyCardStyle: CSSProperties = {
  padding: "2rem",
  borderRadius: "var(--radius-lg)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 50%, transparent)",
  background: "var(--color-surface-container-lowest)",
};
