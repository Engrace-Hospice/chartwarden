// apps/web/src/modules/06-admission — Compliance Dashboard (M6 §5.2.11, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_ELECTION_CERTIFICATION.md — "Use Dashboard."
// Org-wide compliance windows (F2F / recert / NOR / late-CTI) read from GET /api/v1/compliance-windows
// via the generated typed client; a row deep-links to the owning admission's Compliance tab. The
// server enforces every scope (ADR-0030 — no authz on the frontend). Imports only leaves (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  DashboardLayout,
  EmptyState,
  FilterBar,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";

interface WindowRow {
  id: string;
  state: string;
  version: number;
}

export function ComplianceDashboard(): JSX.Element {
  const client = useApiClient();
  const [state, setState] = useState("");
  const [items, setItems] = useState<WindowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query: { state?: string; limit?: number } = { limit: 100 };
    if (state) query.state = state;
    const { data, error: err } = await client.GET("/api/v1/compliance-windows", { params: { query } });
    if (err) {
      setError("Could not load compliance windows.");
      setLoading(false);
      return;
    }
    setItems(data?.items ?? []);
    setLoading(false);
  }, [client, state]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = items.filter((w) => w.state === "open").length;
  const overdue = items.filter((w) => w.state === "overdue").length;
  const closed = items.filter((w) => w.state === "closed").length;

  return (
    <DashboardLayout
      header={<PageHeader title="Compliance — Admissions" />}
      kpis={
        <KpiStrip>
          <KpiCard label="Open" value={open} onSelect={() => setState("open")} />
          <KpiCard label="Overdue" value={overdue} onSelect={() => setState("overdue")} />
          <KpiCard label="Closed" value={closed} onSelect={() => setState("closed")} />
        </KpiStrip>
      }
      charts={
        <FilterBar actions={<button type="button" onClick={() => setState("")}>Clear</button>}>
          <select aria-label="Window state" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Any state</option>
            <option value="open">open</option>
            <option value="overdue">overdue</option>
            <option value="closed">closed</option>
          </select>
        </FilterBar>
      }
      table={<WindowTable items={items} loading={loading} error={error} />}
    />
  );
}

function WindowTable({
  items,
  loading,
  error,
}: {
  items: WindowRow[];
  loading: boolean;
  error: string | null;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading && items.length === 0) return <LoadingSpinner />;
  if (items.length === 0)
    return <EmptyState title="No compliance windows" description="No windows match the current filter." />;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
      <thead>
        <tr style={{ textAlign: "left", color: "#6b7280" }}>
          <th style={th}>Window</th>
          <th style={th}>State</th>
        </tr>
      </thead>
      <tbody>
        {items.map((w) => (
          <tr key={w.id} style={{ borderTop: "1px solid #f3f4f6" }}>
            <td style={td}>{w.id}</td>
            <td style={{ ...td, color: w.state === "overdue" ? "#b91c1c" : undefined }}>{w.state}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
