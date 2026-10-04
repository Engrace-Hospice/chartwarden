import {
  DerivedBadge,
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/09-assessments — Assessment-summary view (M9 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md — "Use Patient Workspace + Documentation Workspace."
// The latest value across all scales for a patient — a card per scale with its newest score + interpretation +
// captured-at. SUD-flagged scales are redacted SERVER-side per the caller's consent (§7.6) and surface only as
// `redacted: true`. This is the same summary projection M22 (PDF) consumes when it lands (forward seam — see
// erasers/.. and m22-summary-pdf.ts deny-stub). Reads GET /api/v1/patients/:patientId/assessments/summary via the
// typed client; the server enforces every scope (ADR-0030 — no authz on the frontend). Imports only leaves (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";

interface SummaryCard {
  id: string;
  scaleType: string;
  score: number | null;
  scoreInterpretation: string | null;
  capturedAt: string;
  redacted: boolean;
}

export function AssessmentSummary(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const [cards, setCards] = useState<SummaryCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!patientId) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET(
        "/api/v1/patients/{patientId}/assessments/summary",
        {
          params: { path: { patientId } },
        },
      );
      if (!active) return;
      if (err) {
        setError("Could not load the summary.");
        setLoading(false);
        return;
      }
      setCards((data?.latest ?? []) as SummaryCard[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, patientId]);

  return (
    <DetailPageLayout header={<PageHeader title="Assessment summary" />}>
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading ? (
        <LoadingSpinner />
      ) : cards.length === 0 ? (
        <EmptyState
          title="No assessments"
          description="No clinical scales have been recorded for this patient."
        />
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(14rem, 1fr))",
            gap: "1rem",
          }}
        >
          {cards.map((c) => (
            <div key={c.id} style={card}>
              <h3 style={h3}>{c.scaleType}</h3>
              {c.redacted ? (
                <p style={meta}>Redacted for this caller.</p>
              ) : (
                <>
                  <p
                    className="tabular-nums"
                    style={{ fontSize: "1.5rem", fontWeight: 600, margin: "0.25rem 0" }}
                  >
                    {c.score ?? "—"}
                  </p>
                  <p style={meta}>{c.scoreInterpretation ?? ""}</p>
                  {/* §Provenance — the score is server-computed by the scale scoring engine, not hand-entered. */}
                  {c.score !== null ? (
                    <div style={{ margin: "0.25rem 0" }}>
                      <DerivedBadge source="scale scoring" verb="computed from" />
                    </div>
                  ) : null}
                </>
              )}
              <p style={meta}>Captured {c.capturedAt.slice(0, 10)}</p>
            </div>
          ))}
        </div>
      )}
    </DetailPageLayout>
  );
}

const card = {
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
  borderRadius: "var(--radius-md)",
  padding: "1rem",
} as const;
const h3 = {
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
  margin: "0 0 0.25rem",
} as const;
const meta = {
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
  margin: "0.25rem 0",
} as const;
