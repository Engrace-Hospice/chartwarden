// apps/web/src/modules/09-assessments — Patient assessment timeline (M9 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md — "Use Patient Workspace + Documentation Workspace."
// Every scale captured for the patient, newest first: scale badge · captured-at · captured-by discipline ·
// server-computed score + interpretation · cosign-needed chip · significant-change/SUD indicators. SUD-flagged
// rows the caller may not see are dropped SERVER-side (§7.6) and surface only as `redacted: true` — never a
// frontend hide. A row drills into the per-scale trend. Reads GET /api/v1/patients/:patientId/assessments via
// the typed client; the server enforces every scope (ADR-0030 — no authz on the frontend). Leaves only (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";

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
            {items.length} captured{pendingCosign > 0 ? ` · ${pendingCosign} awaiting cosignature` : ""}
          </span>
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading ? (
        <LoadingSpinner />
      ) : items.length === 0 ? (
        <EmptyState title="No assessments" description="No clinical scales have been recorded for this patient." />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280" }}>
              <th style={th}>Scale</th>
              <th style={th}>Captured</th>
              <th style={th}>By</th>
              <th style={th}>Score</th>
              <th style={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr
                key={a.id}
                onClick={() => patientId && navigate(`/patients/${patientId}/scales/${a.scaleType}`)}
                style={{
                  cursor: "pointer",
                  borderTop: "1px solid #f3f4f6",
                  // Cosignature-pending rows render in italic (§5.2).
                  fontStyle: a.cosignRequired && !a.cosignedAt ? "italic" : "normal",
                }}
              >
                <td style={td}>
                  {a.scaleType}
                  {a.sudContext ? " 🔒" : ""}
                </td>
                <td style={td}>{a.capturedAt.slice(0, 16).replace("T", " ")}</td>
                <td style={td}>{a.capturedByDiscipline}</td>
                <td style={td}>
                  {a.redacted ? (
                    <span style={meta}>redacted</span>
                  ) : (
                    <>
                      {a.score ?? "—"}
                      {a.scoreInterpretation ? ` · ${a.scoreInterpretation}` : ""}
                    </>
                  )}
                </td>
                <td style={td}>
                  {a.status}
                  {a.cosignRequired && !a.cosignedAt ? " · cosign needed" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DetailPageLayout>
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
const meta = { fontSize: "0.75rem", color: "#6b7280", margin: "0.25rem 0" } as const;
