import { EmptyState, LoadingSpinner, PageHeader, WorkQueueLayout, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/17-scheduling — Week View (M17 §5.1, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". The week-view per-clinician: visits across the week from
// `?weekStart=` (defaults to today), grouped by service date. Recurring-visit + PTO bar overlays fill in as
// those surfaces harden; the SERVER owns the §2.2.1 lifecycle (ADR-0030 — no frontend authz). The clinician is
// taken from `?membership=`. Reads GET /api/v1/week-view via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { type VisitRow, VisitRows } from "./visit-table";

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
    () =>
      [...visits].sort(
        (a, b) => Date.parse(a.scheduledStartedAt) - Date.parse(b.scheduledStartedAt),
      ),
    [visits],
  );
  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Week View" breadcrumb="Scheduling">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Scheduled visits from {weekStart}
            {membership ? `, scoped to clinician ${membership.slice(0, 8)}` : ""}.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          <div style={infoBannerStyle}>
            Week view is grouped by the server response window and sorted by scheduled start. PTO
            overlays and recurring-policy actions remain on their dedicated scheduling surfaces.
          </div>
        </div>
      }
      table={
        error ? (
          <div style={emptyShellStyle}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : loading && visits.length === 0 ? (
          <div style={loadingShellStyle}>
            <LoadingSpinner />
          </div>
        ) : sorted.length === 0 ? (
          <div style={emptyShellStyle}>
            <EmptyState title="No visits" description="No visits are scheduled for this week." />
          </div>
        ) : (
          <div style={tableShellStyle}>
            <VisitRows visits={sorted} onSelect={(id) => navigate(`/scheduling/visits/${id}`)} />
          </div>
        )
      }
      fullPageScroll
    />
  );
}

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};

const tableShellStyle: CSSProperties = {
  width: "100%",
  overflowX: "auto",
  padding: "0 1.5rem 1.5rem",
};

const emptyShellStyle: CSSProperties = {
  padding: "2rem 1.5rem",
};

const loadingShellStyle: CSSProperties = {
  padding: "2.5rem 1.5rem",
  textAlign: "center",
};

const infoBannerStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid color-mix(in srgb, var(--color-primary) 25%, transparent)",
  background: "var(--color-primary-tint)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
};
