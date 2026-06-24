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
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";

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
      const { data, error: err } = await client.GET("/api/v1/patients/{patientId}/hope/assessments", {
        params: { path: { patientId } },
      });
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
    <DetailPageLayout
      header={
        <PageHeader title="HOPE Timeline">
          <span style={meta}>
            {items.length} timepoints{triggered > 0 ? ` · ${triggered} triggered an SFV` : ""}
          </span>
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading ? (
        <LoadingSpinner />
      ) : items.length === 0 ? (
        <EmptyState title="No HOPE timepoints" description="No HOPE assessments have been recorded for this patient." />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280" }}>
              <th style={th}>RFA</th>
              <th style={th}>Target date</th>
              <th style={th}>Author</th>
              <th style={th}>J2051</th>
              <th style={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr
                key={a.id}
                onClick={() => navigate(`/hope/assessments/${a.id}`)}
                style={{
                  cursor: "pointer",
                  borderTop: "1px solid #f3f4f6",
                  // Superseded (corrected) rows render in strikethrough as a chronology cue (§5.2).
                  textDecoration: a.supersededByAssessmentId ? "line-through" : "none",
                }}
              >
                <td style={td}>{a.rfaKind}</td>
                <td style={td}>{a.targetDate.slice(0, 10)}</td>
                <td style={td}>{a.authorDiscipline}</td>
                <td style={{ ...td, color: a.j2051TriggerFired ? "#b91c1c" : undefined }}>
                  {a.j2051MaxSeverity ?? "—"}
                  {a.j2051TriggerFired ? " · SFV" : ""}
                </td>
                <td style={td}>
                  {a.status}
                  {a.wasLate ? " · late" : ""}
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
