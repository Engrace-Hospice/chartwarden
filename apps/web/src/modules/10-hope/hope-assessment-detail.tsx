// apps/web/src/modules/10-hope — HOPE assessment detail (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_HOPE_ENGINE.md — "Use Documentation Workspace."
// Read-only view of one HOPE timepoint: RFA kind, status, target/sign metadata, the server-authoritative
// J2051 max-severity + trigger outcome, the PPS/ESAS-r clinical-context snapshot (D8), and an aside of the
// on-demand pre-submission validation findings (§3). Two reads: GET /api/v1/hope/assessments/:id and
// GET /api/v1/hope/assessments/:id/validation, both via the typed client; the server enforces every scope
// (ADR-0030 — no authz on the frontend). Leaves only (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";

interface AssessmentDetail {
  id: string;
  patientId: string;
  rfaKind: string;
  status: string;
  targetDate: string;
  authorDiscipline: string;
  j2051MaxSeverity: string | null;
  j2051TriggerFired: boolean;
  wasLate: boolean;
  signedAt: string | null;
  signedBy: string | null;
  correctsAssessmentId: string | null;
  supersededByAssessmentId: string | null;
  snapshot: Record<string, number | null> | null;
}

interface Finding {
  ruleId: string;
  severity: string;
  message: string;
}

export function HopeAssessmentDetail(): JSX.Element {
  const client = useApiClient();
  const { id } = useParams<{ id: string }>();
  const [row, setRow] = useState<AssessmentDetail | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!id) return;
      setLoading(true);
      setError(null);
      const [a, v] = await Promise.all([
        client.GET("/api/v1/hope/assessments/{id}", { params: { path: { id } } }),
        client.GET("/api/v1/hope/assessments/{id}/validation", { params: { path: { id } } }),
      ]);
      if (!active) return;
      if (a.error) {
        setError("Could not load the HOPE assessment.");
        setLoading(false);
        return;
      }
      setRow(a.data as AssessmentDetail);
      setFindings((v.data?.findings ?? []) as Finding[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, id]);

  const snapshotEntries = row?.snapshot ? Object.entries(row.snapshot) : [];

  return (
    <DetailPageLayout
      header={
        <PageHeader title="HOPE Assessment">
          {row ? <span style={meta}>{row.rfaKind} · {row.status}</span> : null}
        </PageHeader>
      }
      aside={
        row ? (
          <div>
            <h3 style={{ fontSize: "0.85rem", margin: "0 0 0.5rem" }}>Validation findings</h3>
            {findings.length === 0 ? (
              <p style={meta}>No findings.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: "1rem", fontSize: "0.8rem" }}>
                {findings.map((f) => (
                  <li key={`${f.ruleId}`} style={{ color: f.severity === "error" ? "#b91c1c" : "#b45309" }}>
                    <strong>{f.severity}</strong> — {f.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : undefined
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading || !row ? (
        <LoadingSpinner />
      ) : (
        <dl style={{ display: "grid", gridTemplateColumns: "10rem 1fr", gap: "0.4rem 1rem", fontSize: "0.85rem" }}>
          <dt style={dt}>RFA kind</dt>
          <dd style={dd}>{row.rfaKind}</dd>
          <dt style={dt}>Status</dt>
          <dd style={dd}>{row.status}{row.wasLate ? " · late completion" : ""}</dd>
          <dt style={dt}>Target date</dt>
          <dd style={dd}>{row.targetDate.slice(0, 10)}</dd>
          <dt style={dt}>Author</dt>
          <dd style={dd}>{row.authorDiscipline}</dd>
          <dt style={dt}>Signed</dt>
          <dd style={dd}>{row.signedAt ? `${row.signedAt.slice(0, 16).replace("T", " ")} · ${row.signedBy ?? ""}` : "—"}</dd>
          <dt style={dt}>J2051</dt>
          <dd style={{ ...dd, color: row.j2051TriggerFired ? "#b91c1c" : undefined }}>
            {row.j2051MaxSeverity ?? "none"}
            {row.j2051TriggerFired ? " · Symptom Follow-Up Visit obligation created" : ""}
          </dd>
          {row.correctsAssessmentId ? (
            <>
              <dt style={dt}>Corrects</dt>
              <dd style={dd}>{row.correctsAssessmentId}</dd>
            </>
          ) : null}
          {row.supersededByAssessmentId ? (
            <>
              <dt style={dt}>Superseded by</dt>
              <dd style={dd}>{row.supersededByAssessmentId}</dd>
            </>
          ) : null}
          <dt style={dt}>Snapshot</dt>
          <dd style={dd}>
            {snapshotEntries.length === 0
              ? "—"
              : snapshotEntries.map(([k, v]) => `${k}: ${v ?? "—"}`).join(" · ")}
          </dd>
        </dl>
      )}
    </DetailPageLayout>
  );
}

const meta = { fontSize: "0.75rem", color: "#6b7280", margin: "0.25rem 0" } as const;
const dt = { fontWeight: 600, color: "#374151" } as const;
const dd = { margin: 0 } as const;
