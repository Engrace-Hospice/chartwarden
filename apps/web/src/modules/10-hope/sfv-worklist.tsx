// apps/web/src/modules/10-hope — SFV worklist (M10 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_HOPE_ENGINE.md — "Use Work Queue."
// Open / overdue / missed Symptom Follow-Up Visits across the org, sorted by due-at; each row shows the
// triggering assessment, the 2-calendar-day deadline countdown (ADR-0018 D1), and the server status. A
// state filter narrows the queue server-side. Reads GET /api/v1/hope/sfv via the typed client; the server
// enforces every scope (ADR-0030 — no authz on the frontend). Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  useApiClient,
  WorkQueueLayout,
} from "@wardenx/ui";

interface SfvRow {
  id: string;
  patientId: string;
  triggeringAssessmentId: string;
  status: string;
  triggeredAt: string;
  dueAt: string;
}

export function SfvWorklist(): JSX.Element {
  const client = useApiClient();
  const [state, setState] = useState("");
  const [items, setItems] = useState<SfvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query: { state?: string } = {};
    if (state) query.state = state;
    const { data, error: err } = await client.GET("/api/v1/hope/sfv", { params: { query } });
    if (err) {
      setError("Could not load the SFV worklist.");
      setLoading(false);
      return;
    }
    const rows = ((data?.sfvs ?? []) as SfvRow[]).sort(
      (a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt),
    );
    setItems(rows);
    setLoading(false);
  }, [client, state]);

  useEffect(() => {
    void load();
  }, [load]);

  const nowMs = Date.now();

  return (
    <WorkQueueLayout
      header={<PageHeader title="Symptom Follow-Up Visits" />}
      filters={
        <FilterBar
          actions={
            <button type="button" onClick={() => setState("")}>
              Clear
            </button>
          }
        >
          <select aria-label="SFV state" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Any state</option>
            <option value="open">open</option>
            <option value="overdue">overdue</option>
            <option value="missed">missed</option>
            <option value="completed">completed</option>
          </select>
        </FilterBar>
      }
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : items.length === 0 ? (
          <EmptyState title="No SFVs" description="No symptom-follow-up visits match the current filter." />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={th}>Triggered</th>
                <th style={th}>Due</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => {
                const overdue = s.status === "open" && nowMs > Date.parse(s.dueAt);
                return (
                  <tr key={s.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                    <td style={td}>{s.triggeredAt.slice(0, 16).replace("T", " ")}</td>
                    <td style={{ ...td, color: overdue ? "#b91c1c" : undefined }}>
                      {s.dueAt.slice(0, 16).replace("T", " ")}
                    </td>
                    <td style={{ ...td, color: s.status === "missed" ? "#b91c1c" : undefined }}>
                      {overdue ? "overdue" : s.status}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      }
    />
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
