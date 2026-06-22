// apps/web/src/modules/18-evv — Aggregator Submission Queue (M18 §5.1 `/app/evv/aggregator-submissions`,
// Track B / ADR-0030). Spec: docs/ui/screens — "Use Work Queue". The per-state aggregator submission backlog:
// one row per `evv_aggregator_submission` with its §2.2.5 D7 status + attempt count. Filter by state_code /
// status. The resubmit / cancel write CTAs fill in as those write paths harden; the SERVER owns the D7
// transition + RLS (ADR-0030 — no frontend authz). Reads GET /api/v1/evv/aggregator-submissions via the typed
// client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { EmptyState, LoadingSpinner, PageHeader, useApiClient, WorkQueueLayout } from "@wardenx/ui";
import { DataTable, EVV_SUBMISSION_COLOR, StatusChip } from "./evv-shared";

interface SubmissionRow {
  id: string;
  visitId: string;
  stateCode: string;
  aggregatorVendor: string;
  status: string;
  attemptCount: number;
}

export function EvvAggregatorSubmissions(): JSX.Element {
  const client = useApiClient();
  const [params] = useSearchParams();
  const stateCode = params.get("stateCode") ?? undefined;
  const status = params.get("status") ?? undefined;
  const [rows, setRows] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/evv/aggregator-submissions", {
      params: { query: { ...(stateCode ? { stateCode } : {}), ...(status ? { status } : {}) } },
    });
    if (err) {
      setError("Could not load the aggregator submission queue.");
      setLoading(false);
      return;
    }
    setRows(((data ?? []) as SubmissionRow[]) ?? []);
    setLoading(false);
  }, [client, stateCode, status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Aggregator Submissions" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No submissions" description="No aggregator submissions match your filters." />
        ) : (
          <DataTable<SubmissionRow>
            rows={rows}
            rowKey={(r) => r.id}
            columns={[
              { header: "Submission", cell: (r) => r.id },
              { header: "State", cell: (r) => r.stateCode },
              { header: "Vendor", cell: (r) => r.aggregatorVendor },
              { header: "Visit", cell: (r) => r.visitId },
              { header: "Attempts", cell: (r) => String(r.attemptCount) },
              { header: "Status", cell: (r) => <StatusChip value={r.status} colorMap={EVV_SUBMISSION_COLOR} /> },
            ]}
          />
        )
      }
    />
  );
}
