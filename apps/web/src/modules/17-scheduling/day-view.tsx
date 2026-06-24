// apps/web/src/modules/17-scheduling — Day View (M17 §5.1, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". The scheduler's per-clinician day grid: one row per visit for the
// selected service date with its lifecycle chip + scheduled window. The drag-drop reschedule / publish-all
// write surfaces fill in as those write paths harden; the SERVER owns the §2.2.1 lifecycle + the §4.7 pre-
// schedule ABAC (ADR-0030 — no frontend authz; out-of-scope resources 404, never 403). The clinician is taken
// from `?membership=`, the date from `?date=` (defaults to today). Reads GET /api/v1/day-view via the typed
// client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { EmptyState, LoadingSpinner, PageHeader, useApiClient, WorkQueueLayout } from "@wardenx/ui";
import { type VisitRow, VISIT_STATUS_COLOR, VisitRows } from "./visit-table";

export function SchedulingDay(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const membership = params.get("membership") ?? undefined;
  const date = params.get("date") ?? new Date().toISOString().slice(0, 10);
  const [visits, setVisits] = useState<VisitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/day-view", {
      params: { query: { date, ...(membership ? { membership } : {}) } },
    });
    if (err) {
      setError("Could not load the day view.");
      setLoading(false);
      return;
    }
    setVisits(((data?.visits ?? []) as VisitRow[]) ?? []);
    setLoading(false);
  }, [client, date, membership]);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = useMemo(
    () => [...visits].sort((a, b) => Date.parse(a.scheduledStartedAt) - Date.parse(b.scheduledStartedAt)),
    [visits],
  );

  return (
    <WorkQueueLayout
      header={<PageHeader title={`Day View — ${date}`} />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && visits.length === 0 ? (
          <LoadingSpinner />
        ) : sorted.length === 0 ? (
          <EmptyState title="No visits" description="No visits are scheduled for this day." />
        ) : (
          <VisitRows visits={sorted} onSelect={(id) => navigate(`/scheduling/visits/${id}`)} colorMap={VISIT_STATUS_COLOR} />
        )
      }
    />
  );
}
