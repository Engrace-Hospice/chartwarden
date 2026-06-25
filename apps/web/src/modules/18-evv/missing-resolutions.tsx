import { EmptyState, LoadingSpinner, PageHeader, WorkQueueLayout, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/18-evv — Missing-EVV Resolutions (M18 §5.1 `/app/evv/missing-resolutions`, Track B /
// ADR-0030). Spec: docs/design/screens — "Use Work Queue". The late-checkout resolution backlog: one row per
// `evv_missing_resolution` with its §2.2.4 D6 status. `open` is the only billing-blocking state (ADR-0008).
// The clinician-attest / supervisor-override (step-up) write CTAs fill in as those write paths harden; the
// SERVER owns the D6 transition + RLS (ADR-0030 — no frontend authz). Reads GET /api/v1/evv/missing-resolutions
// via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { DataTable, EVV_RESOLUTION_TONE, StatusChip, mono, stateLabel } from "./evv-shared";

interface ResolutionRow {
  id: string;
  visitId: string;
  kind: string;
  status: string;
  resolvedByMembershipId: string | null;
}

export function EvvMissingResolutions(): JSX.Element {
  const client = useApiClient();
  const [params] = useSearchParams();
  const status = params.get("status") ?? undefined;
  const [rows, setRows] = useState<ResolutionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/evv/missing-resolutions", {
      params: { query: { ...(status ? { status } : {}) } },
    });
    if (err) {
      setError("Could not load the missing-resolution queue.");
      setLoading(false);
      return;
    }
    setRows(((data ?? []) as ResolutionRow[]) ?? []);
    setLoading(false);
  }, [client, status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Missing-EVV Resolutions" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No resolutions"
            description="No missing-EVV resolutions match your filters."
          />
        ) : (
          <DataTable<ResolutionRow>
            rows={rows}
            rowKey={(r) => r.id}
            columns={[
              { header: "Resolution", cell: (r) => mono(r.id) },
              { header: "Visit", cell: (r) => mono(r.visitId) },
              { header: "Kind", cell: (r) => stateLabel(r.kind) },
              {
                header: "Status",
                cell: (r) => <StatusChip value={r.status} toneMap={EVV_RESOLUTION_TONE} />,
              },
              {
                header: "Resolved by",
                cell: (r) => (r.resolvedByMembershipId ? mono(r.resolvedByMembershipId) : "—"),
              },
            ]}
          />
        )
      }
    />
  );
}
