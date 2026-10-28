import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/17-scheduling — Week View (M17 §5.1, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". The week-view per-clinician: visits across the week from
// `?weekStart=` (defaults to today), grouped by service date. Recurring-visit + PTO bar overlays fill in as
// those surfaces harden; the SERVER owns the §2.2.1 lifecycle (ADR-0030 — no frontend authz). The clinician is
// taken from `?membership=`. Reads GET /api/v1/week-view via the typed client. Leaves only (@chartwarden/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { NewVisitButton, NewVisitModal } from "./scheduling-workflow";
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
  const [creating, setCreating] = useState(false);

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
    <>
      <WorkQueueLayout
        header={
          <PageHeader title="Week View">
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Scheduled visits from {weekStart}
              {membership ? `, scoped to clinician ${membership.slice(0, 8)}` : ""}.
            </div>
          </PageHeader>
        }
        filters={
          <div style={filterShellStyle}>
            <NewVisitButton onNewVisit={() => setCreating(true)} />
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
      <NewVisitModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(visit) => {
          setCreating(false);
          navigate(`/scheduling/visits/${visit.id}`);
        }}
      />
    </>
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
