import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/17-scheduling — Day View (M17 §5.1, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". The scheduler's per-clinician day grid: one row per visit for the
// selected service date with its lifecycle chip + scheduled window. The drag-drop reschedule / publish-all
// write surfaces fill in as those write paths harden; the SERVER owns the §2.2.1 lifecycle + the §4.7 pre-
// schedule ABAC (ADR-0030 — no frontend authz; out-of-scope resources 404, never 403). The clinician is taken
// from `?membership=`, the date from `?date=` (defaults to today). Reads GET /api/v1/day-view via the typed
// client. Leaves only (@chartwarden/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { NewVisitButton, NewVisitModal } from "./scheduling-workflow";
import { type VisitRow, VisitRows } from "./visit-table";

export function SchedulingDay(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const membership = params.get("membership") ?? undefined;
  const date = params.get("date") ?? new Date().toISOString().slice(0, 10);
  const [visits, setVisits] = useState<VisitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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
          <PageHeader title="Day View" breadcrumb="Scheduling">
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Scheduled visits for {date}
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
              <EmptyState title="No visits" description="No visits are scheduled for this day." />
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
