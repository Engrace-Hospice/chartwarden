// apps/web/src/modules/17-scheduling — My Visits (M17 §5.1 `/app/me/visits`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". The clinician's own visits today + upcoming 7 days, mobile-
// optimized. Caseload scoping is the SERVER's job (the §4.7 `within_caseload_or_unassigned_pool` ABAC + RLS;
// ADR-0030 — no frontend authz, out-of-scope visits never appear). The "Start visit" (EVV-missing flow) action
// fills in as that write path hardens. Reads GET /api/v1/visits (date-window filtered) via the typed client.
// Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { EmptyState, LoadingSpinner, PageHeader, useApiClient, WorkQueueLayout } from "@wardenx/ui";
import { type VisitRow, VISIT_STATUS_COLOR, VisitRows } from "./visit-table";

export function MyVisits(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [visits, setVisits] = useState<VisitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const window = useMemo(() => {
    const from = new Date();
    const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000); // today + upcoming 7 days
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // The server resolves the caller's caseload; no clinician filter is sent (own-visits via ABAC + RLS).
    const { data, error: err } = await client.GET("/api/v1/visits", {
      params: { query: { from: window.from, to: window.to } },
    });
    if (err) {
      setError("Could not load your visits.");
      setLoading(false);
      return;
    }
    setVisits((data ?? []) as VisitRow[]);
    setLoading(false);
  }, [client, window]);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(
    () => [...visits].sort((a, b) => Date.parse(a.scheduledStartedAt) - Date.parse(b.scheduledStartedAt)),
    [visits],
  );

  return (
    <WorkQueueLayout
      header={<PageHeader title="My Visits" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && visits.length === 0 ? (
          <LoadingSpinner />
        ) : sorted.length === 0 ? (
          <EmptyState title="No upcoming visits" description="You have no visits scheduled in the next 7 days." />
        ) : (
          <VisitRows visits={sorted} onSelect={(id) => navigate(`/scheduling/visits/${id}`)} colorMap={VISIT_STATUS_COLOR} />
        )
      }
    />
  );
}
