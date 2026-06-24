import {
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/05-patient — Patient List / Census (M5, Track A).
// Spec: docs/design/screens/clinical/WARDENX_UI_PATIENT_LIST_CENSUS.md — "Use Work Queue."
// Filterable, cursor-paginated census over GET /api/v1/patients via the generated typed client.
// A row opens the patient chart (/patients/:id, built later). Imports only leaves (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";

interface PatientSummary {
  id: string;
  organizationId: string;
  mrn: string;
  lastName: string;
  firstName: string;
  dob: string;
  status: string;
}

export function PatientListCensus(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<PatientSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setError(null);
      const query: Record<string, string | number> = { limit: 50 };
      if (q.trim()) query.q = q.trim();
      if (status) query.status = status;
      if (cursor) query.cursor = cursor;

      const { data, error: err } = await client.GET("/api/v1/patients", { params: { query } });
      if (err) {
        setError("Could not load the patient census.");
        setLoading(false);
        return;
      }
      const page = (data?.items ?? []) as PatientSummary[];
      setItems((prev) => (cursor ? [...prev, ...page] : page));
      setNextCursor(data?.nextCursor ?? null);
      setLoading(false);
    },
    [client, q, status],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Patients" />}
      filters={
        <FilterBar
          actions={
            <button
              type="button"
              onClick={() => {
                setQ("");
                setStatus("");
              }}
            >
              Clear
            </button>
          }
        >
          <input
            aria-label="Search name or MRN"
            placeholder="Name or MRN"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            <option value="prospective">prospective</option>
            <option value="active">active</option>
            <option value="discharged">discharged</option>
            <option value="deceased">deceased</option>
          </select>
        </FilterBar>
      }
      table={
        <CensusTable
          items={items}
          loading={loading}
          error={error}
          onOpen={(id) => navigate(`/patients/${id}`)}
          onLoadMore={nextCursor ? () => load(nextCursor) : undefined}
        />
      }
    />
  );
}

function CensusTable({
  items,
  loading,
  error,
  onOpen,
  onLoadMore,
}: {
  items: PatientSummary[];
  loading: boolean;
  error: string | null;
  onOpen: (id: string) => void;
  onLoadMore?: () => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading && items.length === 0) return <LoadingSpinner />;
  if (items.length === 0)
    return <EmptyState title="No patients" description="No patients match the current filters." />;
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#6b7280" }}>
            <th style={th}>Name</th>
            <th style={th}>MRN</th>
            <th style={th}>DOB</th>
            <th style={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr
              key={p.id}
              // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
              role="button"
              tabIndex={0}
              onClick={() => onOpen(p.id)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onOpen(p.id);
                }
              }}
              style={{ cursor: "pointer", borderTop: "1px solid #f3f4f6" }}
            >
              <td style={td}>
                {p.lastName}, {p.firstName}
              </td>
              <td style={td}>{p.mrn}</td>
              <td style={td}>{p.dob}</td>
              <td style={td}>{p.status}</td>
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
