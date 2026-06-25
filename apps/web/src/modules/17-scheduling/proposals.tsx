import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/17-scheduling — Proposals Inbox (M17 §5.1 `/app/scheduling/proposals`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". The scheduler's pending-proposals inbox: frequency / supervisory /
// order / IDG-driven proposals awaiting publish. The bulk publish/dismiss write surfaces fill in as those write
// paths harden (publish reruns the §1.1 D8 pre-schedule gate SERVER-side); ADR-0030 — no frontend authz. The
// patient filter comes from `?patient=`. Reads GET /api/v1/visit-proposals via the typed client. Leaves only
// (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { PROPOSAL_TONE, stateLabel } from "./scheduling-status";

interface ProposalRow {
  id: string;
  patientId: string;
  proposedVisitPurpose: string;
  proposedForDate: string;
  status: string;
}

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
          <EmptyState
            title="No pending proposals"
            description="There are no proposals awaiting publish."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>For date</th>
                <th>Purpose</th>
                <th>Patient</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((r) => (
                <tr key={r.id}>
                  <td className="tabular-nums">{r.proposedForDate}</td>
                  <td>{stateLabel(r.proposedVisitPurpose)}</td>
                  <td className="wx-data-md">{r.patientId.slice(0, 8)}</td>
                  <td>
                    <StatusPill
                      label={stateLabel(r.status)}
                      tone={PROPOSAL_TONE[r.status] ?? "neutral"}
                    />
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
