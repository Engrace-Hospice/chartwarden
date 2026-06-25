import {
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/09-assessments — Patient assessment timeline (M9 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md — "Use Patient Workspace + Documentation Workspace."
// Every scale captured for the patient, newest first: scale badge · captured-at · captured-by discipline ·
// server-computed score + interpretation · cosign-needed chip · significant-change/SUD indicators. SUD-flagged
// rows the caller may not see are dropped SERVER-side (§7.6) and surface only as `redacted: true` — never a
// frontend hide. A row drills into the per-scale trend. Reads GET /api/v1/patients/:patientId/assessments via
// the typed client; the server enforces every scope (ADR-0030 — no authz on the frontend). Leaves only (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
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

export function AssessmentTimeline(): JSX.Element {
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
      const { data, error: err } = await client.GET("/api/v1/patients/{patientId}/assessments", {
        params: { path: { patientId } },
      });
      if (!active) return;
      if (err) {
        setError("Could not load assessments.");
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

  const pendingCosign = items.filter((a) => a.cosignRequired && !a.cosignedAt).length;

  return (
    <DetailPageLayout
      header={
        <PageHeader title="Assessments">
          <span style={meta}>
            {items.length} captured
            {pendingCosign > 0 ? ` · ${pendingCosign} awaiting cosignature` : ""}
          </span>
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading ? (
        <LoadingSpinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No assessments"
          description="No clinical scales have been recorded for this patient."
        />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Scale</th>
              <th>Captured</th>
              <th>By</th>
              <th>Score</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => {
              const needsCosign = a.cosignRequired && !a.cosignedAt;
              const open = () =>
                patientId && navigate(`/patients/${patientId}/scales/${a.scaleType}`);
              return (
                <tr
                  key={a.id}
                  // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                  role="button"
                  tabIndex={0}
                  onClick={open}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === " ") {
                      ev.preventDefault();
                      open();
                    }
                  }}
                  style={{
                    cursor: "pointer",
                    // Cosignature-pending rows render in italic (§5.2).
                    fontStyle: needsCosign ? "italic" : "normal",
                  }}
                >
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                      {a.scaleType}
                      {/* §7.6 SUD context marker — a lock glyph, not an emoji (on-system, grayscale-safe). */}
                      {a.sudContext ? (
                        <span style={{ color: "var(--color-on-surface-variant)" }}>
                          <Glyph name="lock" size={13} label="Substance-use context" />
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className="tabular-nums">{a.capturedAt.slice(0, 16).replace("T", " ")}</td>
                  <td>{stateLabel(a.capturedByDiscipline)}</td>
                  <td>
                    {a.redacted ? (
                      <span style={meta}>Redacted</span>
                    ) : (
                      <span className="tabular-nums">
                        {a.score ?? "—"}
                        {a.scoreInterpretation ? ` · ${a.scoreInterpretation}` : ""}
                      </span>
                    )}
                  </td>
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                      <StatusPill
                        label={stateLabel(a.status)}
                        tone={ASSESSMENT_TONE[a.status] ?? "neutral"}
                      />
                      {needsCosign ? <StatusPill label="Cosign needed" tone="warning" /> : null}
                    </span>
                  </td>
                </tr>
              );
            })}
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
