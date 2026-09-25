import {
  PatientWorkspaceLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
import { ChartModuleRail } from "../../shell/chart-module-rail";
// apps/web/src/modules/10-hope — Patient HOPE timeline (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_HOPE_ENGINE.md — "Use Patient Workspace + Documentation Workspace."
// Per-patient chronology: Admission → HUV1 → HUV2 → SFV(s) → Discharge, newest first — each row carries the
// RFA kind, target date, author discipline, the server-authoritative J2051 max-severity + trigger chip, a
// late chip, and the signed/draft/superseded status. A row drills into the assessment detail. Reads
// GET /api/v1/patients/:patientId/hope/assessments via the typed client; the server enforces every scope
// (ADR-0030 — no authz on the frontend). Leaves only (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ASSESSMENT_TONE,
  J2051_TONE,
  rfaLabel,
  stateLabel,
} from "./hope-status";

interface AssessmentRow {
  id: string;
  rfaKind: string;
  status: string;
  targetDate: string;
  authorDiscipline: string;
  j2051MaxSeverity: string | null;
  j2051TriggerFired: boolean;
  wasLate: boolean;
  supersededByAssessmentId: string | null;
}

export function PatientHopeTimeline(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const [items, setItems] = useState<AssessmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!patientId) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET(
        "/api/v1/patients/{patientId}/hope/assessments",
        {
          params: { path: { patientId } },
        },
      );
      if (!active) return;
      if (err) {
        setError("Could not load HOPE timeline.");
        setLoading(false);
        return;
      }
      setItems((data?.assessments ?? []) as AssessmentRow[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, patientId]);

  const triggered = items.filter((a) => a.j2051TriggerFired).length;

  return (
    <PatientWorkspaceLayout
      banner={
        <PageHeader title="HOPE Timeline">
          <span style={meta}>
            {items.length} timepoints
            {triggered > 0 ? ` · ${triggered} triggered an SFV` : ""}
          </span>
        </PageHeader>
      }
    >
      <div
        style={{
          display: "flex",
          flex: 1,
          minHeight: 0,
        }}
      >
        <ChartModuleRail patientId={patientId ?? ""} current="hope" />

        <main
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "auto",
            padding: "1.5rem",
          }}
        >
          {error ? (
            <EmptyState title="Unavailable" description={error} />
          ) : loading ? (
            <LoadingSpinner />
          ) : items.length === 0 ? (
            <EmptyState
              title="No HOPE timepoints"
              description="No HOPE assessments have been recorded for this patient."
            />
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                }}
              >
                <thead>
                  <tr>
                    <th>RFA</th>
                    <th>Target date</th>
                    <th>Author</th>
                    <th>J2051</th>
                    <th>Status</th>
                  </tr>
                </thead>

                <tbody>
                  {items.map((a) => (
                    <tr
                      key={a.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate(`/hope/assessments/${a.id}`)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();

                          navigate(`/hope/assessments/${a.id}`);
                        }
                      }}
                      style={{
                        cursor: "pointer",
                        textDecoration: a.supersededByAssessmentId
                          ? "line-through"
                          : "none",
                      }}
                    >
                      <td>{rfaLabel(a.rfaKind)}</td>

                      <td className="tabular-nums">
                        {a.targetDate.slice(0, 10)}
                      </td>

                      <td>{stateLabel(a.authorDiscipline)}</td>

                      <td>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.35rem",
                          }}
                        >
                          {a.j2051MaxSeverity ? (
                            <StatusPill
                              label={stateLabel(a.j2051MaxSeverity)}
                              tone={J2051_TONE[a.j2051MaxSeverity] ?? "neutral"}
                            />
                          ) : (
                            <span
                              style={{
                                color: "var(--color-muted)",
                              }}
                            >
                              —
                            </span>
                          )}

                          {a.j2051TriggerFired ? (
                            <StatusPill
                              label="SFV"
                              tone="warning"
                              glyph="alert"
                            />
                          ) : null}
                        </span>
                      </td>

                      <td>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.35rem",
                          }}
                        >
                          <StatusPill
                            label={stateLabel(a.status)}
                            tone={ASSESSMENT_TONE[a.status] ?? "neutral"}
                          />

                          {a.wasLate ? (
                            <StatusPill label="Late" tone="warning" />
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </main>
      </div>
    </PatientWorkspaceLayout>
  );
}

const meta = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
} as const;
