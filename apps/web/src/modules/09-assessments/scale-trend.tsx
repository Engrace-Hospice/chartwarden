import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/09-assessments — Per-scale trend view (M9 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md — "Use Patient Workspace + Documentation Workspace."
// A patient's scored series for one scale over a default 90-day window: score-over-time plus an item-level
// history table with significant-change markers. The full Recharts series chart (§5.2) fills in with the
// charting kit; this read view renders the server-computed points + change markers. Reads GET
// /api/v1/patients/:patientId/scales/:scaleType/series via the typed client; the server enforces every scope
// (ADR-0030 — no authz on the frontend). Imports only leaves (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";

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
  return { from: from.toISOString(), to: to.toISOString() };
}

export function ScaleTrend(): JSX.Element {
  const client = useApiClient();
  const { patientId, scaleType } = useParams<{ patientId: string; scaleType: string }>();
  const [points, setPoints] = useState<SeriesPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!patientId || !scaleType) return;
      setLoading(true);
      setError(null);
      const { from, to } = defaultWindow();
      const { data, error: err } = await client.GET(
        "/api/v1/patients/{patientId}/scales/{scaleType}/series",
        { params: { path: { patientId, scaleType }, query: { from, to } } },
      );
      if (!active) return;
      if (err) {
        setError("Could not load the trend.");
        setLoading(false);
        return;
      }
      setPoints((data?.points ?? []) as SeriesPoint[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, patientId, scaleType]);

  const changeCount = points.filter((p) => p.significantChange).length;

  return (
    <DetailPageLayout
      header={
        <PageHeader title={`Trend — ${scaleType ?? ""}`}>
          <span style={meta}>
            Last 90 days · {points.length} captures
            {changeCount > 0
              ? ` · ${changeCount} significant change${changeCount > 1 ? "s" : ""}`
              : ""}
          </span>
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading ? (
        <LoadingSpinner />
      ) : points.length === 0 ? (
        <EmptyState title="No data" description="No captures for this scale in the last 90 days." />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Captured</th>
              <th>Score</th>
              <th>Interpretation</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.assessmentId}>
                <td className="tabular-nums">{p.capturedAt.slice(0, 16).replace("T", " ")}</td>
                <td className="tabular-nums">{p.score ?? "—"}</td>
                <td>{p.scoreInterpretation ?? "—"}</td>
                <td>
                  {p.significantChange ? (
                    <StatusPill label="Significant" tone="warning" glyph="alert" />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DetailPageLayout>
  );
}

const meta = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
} as const;
