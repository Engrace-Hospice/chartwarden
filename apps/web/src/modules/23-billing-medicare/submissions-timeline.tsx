import {
  CorrelationIdBadge,
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the SUBMISSIONS TIMELINE (R2, §5.1 #8).
// All `claim_submission` dispatch attempts for one claim: attempt index, outcome (§6.6 pill), the MinIO
// presigned generated-file link, and the per-attempt correlation id (CorrelationIdBadge). Reads
// GET /api/v1/billing/claims/:id/submissions (read-only; no writes). The server is the only authz point
// (ADR-0030) — a 404/503/403 degrades the surface. Lantern: DetailPageLayout + No-Line table (§6.7), mono
// identifiers (control #), tabular-nums attempt index, CSS-var tokens only; tones flow through
// billing-status.ts (§6.6). NOTE: the openapi marks the body as `never`, so the result payload is cast — the
// server stays the authoritative shape.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { statusLabel, submissionStatusTone } from "./billing-status";

interface ClaimSubmission {
  submissionId: string;
  kind: string;
  claimControlNumber: string;
  attemptIndex: number;
  outcome: string;
  outcomeReason: string | null;
  generatedFileUri: string | null;
  submittedAt: string | null;
  createdAt: string;
}

// :claimId is the second-to-last path segment of /billing/claims/:claimId/submissions.
function claimIdFromPath(): string {
  const segs = window.location.pathname.split("/").filter(Boolean);
  return segs[segs.length - 2] ?? "";
}

export function SubmissionsTimeline(): JSX.Element {
  const client = useApiClient();
  const [claimId] = useState(claimIdFromPath);
  const [rows, setRows] = useState<ClaimSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/billing/claims/{id}/submissions", {
      params: { path: { id: claimId } },
    });
    if (err) {
      setError("Submissions unavailable — the billing read seam is not bound, or you lack scope.");
      setLoading(false);
      return;
    }
    setRows(((data as unknown as ClaimSubmission[]) ?? []) as ClaimSubmission[]);
    setLoading(false);
  }, [client, claimId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Submissions"
          breadcrumb={
            <>
              Billing — Medicare ·{" "}
              <a
                href={`/billing/claims/${claimId}`}
                style={{ fontFamily: "var(--font-mono)", color: "var(--color-primary)" }}
              >
                {claimId}
              </a>
            </>
          }
        />
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          title="No submissions"
          description="No dispatch attempts have been recorded for this claim."
        />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.84rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--color-on-surface-variant)" }}>
              <th style={{ ...thStyle, textAlign: "right" }}>Attempt</th>
              <th style={thStyle}>Kind</th>
              <th style={thStyle}>Outcome</th>
              <th style={thStyle}>Reason</th>
              <th style={thStyle}>Submitted</th>
              <th style={thStyle}>File</th>
              <th style={thStyle}>Reference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={r.submissionId}
                style={{ background: i % 2 === 1 ? "var(--color-surface-low)" : "transparent" }}
              >
                <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {r.attemptIndex}
                </td>
                <td style={tdStyle}>{statusLabel(r.kind)}</td>
                <td style={tdStyle}>
                  <StatusPill
                    label={statusLabel(r.outcome)}
                    tone={submissionStatusTone(r.outcome)}
                  />
                </td>
                <td style={{ ...tdStyle, color: "var(--color-on-surface-variant)" }}>
                  {r.outcomeReason ?? "—"}
                </td>
                <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                  {r.submittedAt ?? r.createdAt}
                </td>
                <td style={tdStyle}>
                  {r.generatedFileUri ? (
                    <a
                      href={r.generatedFileUri}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "var(--color-primary)" }}
                    >
                      Download →
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={tdStyle}>
                  <CorrelationIdBadge correlationId={r.submissionId} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </DetailPageLayout>
  );
}

const thStyle = {
  padding: "0.5rem 0.75rem",
  fontSize: "0.7rem",
  fontWeight: 600 as const,
};
const tdStyle = { padding: "0.5rem 0.75rem", color: "var(--color-on-surface)" };
