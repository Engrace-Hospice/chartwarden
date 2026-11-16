import {
  Button,
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  humanizeIdentifier,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/07-care-plan — Care Plan Summary (M7 §5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_CARE_PLAN.md — "Use Patient Workspace + Documentation Workspace."
// The printable, patient/family-friendly view, generated server-side from the active version's state.
// §7.6: SUD content is excluded unless the calling session has a matched consent — the response carries
// `redacted: true` when anything was filtered (the filter is SERVER-side, never a frontend hide).
// Reads GET /api/v1/care-plans/:planId/summary via the typed client; the server enforces every scope.
// Imports only leaves (@chartwarden/ui) and this module's own discipline labels (care-plan-overview).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { disciplineLabel } from "./care-plan-overview";

interface Summary {
  planId: string;
  versionId: string | null;
  activeProblems: { description: string; kind: string }[];
  patientStatedGoals: { text: string; measurableOutcome: string | null }[];
  activeInterventions: { layText: string; discipline: string; frequencyText: string }[];
  redacted: boolean;
}

export function CarePlanSummary(): JSX.Element {
  const client = useApiClient();
  const { planId } = useParams<{ planId: string }>();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ title: string; description: string } | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!planId) return;
      setLoading(true);
      setError(null);
      try {
        const {
          data,
          error: err,
          response,
        } = await client.GET("/api/v1/care-plans/{planId}/summary", {
          params: { path: { planId } },
        });
        if (!active) return;
        if (response?.status === 403) {
          setError({
            title: "No access",
            description: "You do not have access to this care plan summary.",
          });
        } else if (err || !data) {
          setError({ title: "Unavailable", description: "Could not load the summary." });
        } else {
          setSummary(data as Summary);
        }
      } catch {
        if (!active) return;
        setError({ title: "Unavailable", description: "Could not load the summary." });
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, planId]);

  if (loading) return <LoadingSpinner />;
  if (error || !summary)
    return (
      <EmptyState
        title={error?.title ?? "Unavailable"}
        description={error?.description ?? "No summary."}
      />
    );

  const header = (
    <PageHeader
      title="Care Plan Summary"
      actions={
        summary.versionId ? (
          <span className="wx-print-hide">
            <Button type="button" tone="secondary" onClick={() => window.print()}>
              <Glyph name="printer" size={16} /> Print summary
            </Button>
          </span>
        ) : null
      }
    />
  );

  // No active version: the server reads the live rows, but nothing has been signed, so there is no
  // care plan to hand a patient or family — empty lists here would read as "no problems", which is false.
  if (!summary.versionId)
    return (
      <DetailPageLayout header={header}>
        <EmptyState
          title="No signed care plan yet"
          description="A summary appears here once the care plan has been signed."
        />
      </DetailPageLayout>
    );

  return (
    <DetailPageLayout header={header}>
      <div style={{ maxWidth: "44rem" }}>
        {summary.redacted ? (
          <p
            role="note"
            style={{
              ...meta,
              color: "var(--color-warning)",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.3rem",
            }}
          >
            <Glyph name="lock" size={13} /> Some confidential content is not shown in this summary.
          </p>
        ) : null}

        <section>
          <h3 style={h3}>What we are working on</h3>
          {summary.activeProblems.length === 0 ? (
            <p style={meta}>No active problems.</p>
          ) : (
            <ul>
              {summary.activeProblems.map((p, idx) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static read-only list, never reordered.
                <li key={idx}>
                  {p.description} <span style={meta}>({humanizeIdentifier(p.kind)})</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 style={h3}>Your goals</h3>
          {summary.patientStatedGoals.length === 0 ? (
            <p style={meta}>No patient/family-stated goals recorded.</p>
          ) : (
            <ul>
              {summary.patientStatedGoals.map((g, idx) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static read-only list, never reordered.
                <li key={idx}>
                  {g.text}
                  {g.measurableOutcome ? <span style={meta}> — {g.measurableOutcome}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h3 style={h3}>How the team helps</h3>
          {summary.activeInterventions.length === 0 ? (
            <p style={meta}>No active interventions.</p>
          ) : (
            <ul>
              {summary.activeInterventions.map((i, idx) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static read-only list, never reordered.
                <li key={idx}>
                  {i.layText}{" "}
                  <span style={meta}>
                    ({disciplineLabel(i.discipline)} · {i.frequencyText})
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </DetailPageLayout>
  );
}

const h3 = {
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
  margin: "1rem 0 0.5rem",
} as const;
const meta = { fontSize: "0.8rem", color: "var(--color-on-surface-variant)" } as const;
