// apps/web/src/modules/17-scheduling — Week View (M17 §5.1, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". The week-view per-clinician: visits across the week from
// `?weekStart=` (defaults to today), grouped by service date. Recurring-visit + PTO bar overlays fill in as
// those surfaces harden; the SERVER owns the §2.2.1 lifecycle (ADR-0030 — no frontend authz). The clinician is
// taken from `?membership=`. Reads GET /api/v1/week-view via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { EmptyState, LoadingSpinner, PageHeader, useApiClient, WorkQueueLayout } from "@wardenx/ui";
import { type VisitRow, VISIT_STATUS_COLOR, VisitRows } from "./visit-table";

export function SchedulingWeek(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const membership = params.get("membership") ?? undefined;
  const weekStart = params.get("weekStart") ?? new Date().toISOString().slice(0, 10);
  const [visits, setVisits] = useState<VisitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/week-view", {
      params: { query: { weekStart, ...(membership ? { membership } : {}) } },
    });
    if (err) {
      setError("Could not load the week view.");
      setLoading(false);
      return;
    }
    setVisits(((data?.visits ?? []) as VisitRow[]) ?? []);
    setLoading(false);
  }, [client, weekStart, membership]);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(
    () => [...visits].sort((a, b) => Date.parse(a.scheduledStartedAt) - Date.parse(b.scheduledStartedAt)),
    [visits],
  );

  return (
    <WorkQueueLayout
      header={<PageHeader title={`Week View — from ${weekStart}`} />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && visits.length === 0 ? (
          <LoadingSpinner />
        ) : sorted.length === 0 ? (
          <EmptyState title="No visits" description="No visits are scheduled for this week." />
        ) : (
          <VisitRows visits={sorted} onSelect={(id) => navigate(`/scheduling/visits/${id}`)} colorMap={VISIT_STATUS_COLOR} />
        )
      }
    />
  );
}
