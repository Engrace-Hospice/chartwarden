// apps/web/src/modules/10-hope — HOPE submission worklist (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_HOPE_ENGINE.md — "Use Work Queue."
// Submission batches per ProviderEntity, per-period: status, item/accepted/rejected counts, transmit time.
// A row drills into the submission detail (per-item outcomes + retry). Reads GET /api/v1/hope/submissions
// via the typed client; the server enforces every scope incl. PE scope (ADR-0030 — no authz on the
// frontend). Leaves only (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
  WorkQueueLayout,
} from "@wardenx/ui";

interface SubmissionRow {
  id: string;
  providerEntityId: string;
  submissionPeriod: string;
  status: string;
  itemCount: number;
  acceptedCount: number;
  rejectedCount: number;
  transmittedAt: string | null;
}

export function SubmissionWorklist(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/hope/submissions", {
        params: { query: {} },
      });
      if (!active) return;
      if (err) {
        setError("Could not load HOPE submissions.");
        setLoading(false);
        return;
      }
      setItems((data?.submissions ?? []) as SubmissionRow[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="HOPE Submissions" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : items.length === 0 ? (
          <EmptyState title="No submissions" description="No HOPE submission batches have been assembled." />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={th}>Period</th>
                <th style={th}>Status</th>
                <th style={th}>Items</th>
                <th style={th}>Accepted</th>
                <th style={th}>Rejected</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr
                  key={s.id}
                  onClick={() => navigate(`/hope/submissions/${s.id}`)}
                  style={{ cursor: "pointer", borderTop: "1px solid #f3f4f6" }}
                >
                  <td style={td}>{s.submissionPeriod}</td>
                  <td style={{ ...td, color: s.status === "rejected" ? "#b91c1c" : undefined }}>
                    {s.status}
                  </td>
                  <td style={td}>{s.itemCount}</td>
                  <td style={td}>{s.acceptedCount}</td>
                  <td style={{ ...td, color: s.rejectedCount > 0 ? "#b91c1c" : undefined }}>
                    {s.rejectedCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
