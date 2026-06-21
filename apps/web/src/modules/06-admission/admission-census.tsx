// apps/web/src/modules/06-admission — Admission Census (M6 §5.2.12 entry, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_ADMISSIONS_REFERRAL_INTAKE.md — "Use Work Queue."
// Org-scoped admissions queue read from GET /api/v1/admissions (optional state filter) via the
// generated typed client; a row opens the Admission Detail (§5.2.4). The server enforces every scope
// (ADR-0030 — no authz on the frontend). Imports only leaves (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import {
  EmptyState,
  FilterBar,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";

interface AdmissionRow {
  id: string;
  state: string;
  version: number;
}

export function AdmissionCensus(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [state, setState] = useState("");
  const [items, setItems] = useState<AdmissionRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      const query: { state?: string; cursor?: string; limit?: number } = { limit: 50 };
      if (state) query.state = state;
      if (cursor) query.cursor = cursor;
      const { data, error: err } = await client.GET("/api/v1/admissions", { params: { query } });
      if (err) {
        setError("Could not load the admission census.");
        setLoading(false);
        return;
      }
      const page = data?.items ?? [];
      setItems((prev) => (cursor ? [...prev, ...page] : page));
      setNextCursor(data?.nextCursor ?? null);
      setLoading(false);
    },
    [client, state],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const activeCount = items.filter((a) => a.state === "active").length;

  return (
    <WorkQueueLayout
      header={<PageHeader title="Admissions" />}
      kpis={
        <KpiStrip>
          <KpiCard label="Active" value={activeCount} />
          <KpiCard label="In view" value={items.length} />
        </KpiStrip>
      }
      filters={
        <FilterBar actions={<button type="button" onClick={() => setState("")}>Clear</button>}>
          <select aria-label="Admission state" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Any state</option>
            <option value="pending">pending</option>
            <option value="active">active</option>
            <option value="on_hold">on_hold</option>
            <option value="discharged">discharged</option>
            <option value="bereavement">bereavement</option>
          </select>
        </FilterBar>
      }
      table={
        <AdmissionTable
          items={items}
          loading={loading}
          error={error}
          onOpen={(id) => navigate(`/admissions/${id}`)}
          onLoadMore={nextCursor ? () => load(nextCursor) : undefined}
        />
      }
    />
  );
}

function AdmissionTable({
  items,
  loading,
  error,
  onOpen,
  onLoadMore,
}: {
  items: AdmissionRow[];
  loading: boolean;
  error: string | null;
  onOpen: (id: string) => void;
  onLoadMore?: () => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading && items.length === 0) return <LoadingSpinner />;
  if (items.length === 0)
    return <EmptyState title="No admissions" description="No admissions match the current filters." />;
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#6b7280" }}>
            <th style={th}>Admission</th>
            <th style={th}>State</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id} onClick={() => onOpen(a.id)} style={{ cursor: "pointer", borderTop: "1px solid #f3f4f6" }}>
              <td style={td}>{a.id}</td>
              <td style={td}>{a.state}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {onLoadMore ? (
        <div style={{ marginTop: "1rem", textAlign: "center" }}>
          <button type="button" onClick={onLoadMore} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
