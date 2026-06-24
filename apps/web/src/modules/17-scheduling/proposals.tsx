// apps/web/src/modules/17-scheduling — Proposals Inbox (M17 §5.1 `/app/scheduling/proposals`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". The scheduler's pending-proposals inbox: frequency / supervisory /
// order / IDG-driven proposals awaiting publish. The bulk publish/dismiss write surfaces fill in as those write
// paths harden (publish reruns the §1.1 D8 pre-schedule gate SERVER-side); ADR-0030 — no frontend authz. The
// patient filter comes from `?patient=`. Reads GET /api/v1/visit-proposals via the typed client. Leaves only
// (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { EmptyState, LoadingSpinner, PageHeader, useApiClient, WorkQueueLayout } from "@wardenx/ui";

interface ProposalRow {
  id: string;
  patientId: string;
  proposedVisitPurpose: string;
  proposedForDate: string;
  status: string;
}

const statusColor: Record<string, string | undefined> = {
  pending: "#1d4ed8",
  published: "#15803d",
  dismissed: "#6b7280",
  stale: "#b45309",
};

export function SchedulingProposals(): JSX.Element {
  const client = useApiClient();
  const [params] = useSearchParams();
  const patient = params.get("patient") ?? undefined;
  const [rows, setRows] = useState<ProposalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/visit-proposals", {
      params: { query: patient ? { patient } : {} },
    });
    if (err) {
      setError("Could not load the proposal inbox.");
      setLoading(false);
      return;
    }
    setRows((data ?? []) as ProposalRow[]);
    setLoading(false);
  }, [client, patient]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = rows.filter((r) => r.status === "pending");

  return (
    <WorkQueueLayout
      header={<PageHeader title="Proposal Inbox" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && rows.length === 0 ? (
          <LoadingSpinner />
        ) : pending.length === 0 ? (
          <EmptyState title="No pending proposals" description="There are no proposals awaiting publish." />
        ) : (
          <table style={table}>
            <thead>
              <tr style={tr}>
                <th style={th}>For date</th>
                <th style={th}>Purpose</th>
                <th style={th}>Patient</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td style={td}>{r.proposedForDate}</td>
                  <td style={td}>{r.proposedVisitPurpose}</td>
                  <td style={mono}>{r.patientId.slice(0, 8)}</td>
                  <td style={{ ...td, color: statusColor[r.status] }}>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}

const table = { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" } as const;
const tr = { textAlign: "left", color: "#6b7280" } as const;
const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
const mono = { ...td, fontFamily: "monospace", fontSize: "0.8rem" } as const;
