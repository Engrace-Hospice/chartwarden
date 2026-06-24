// apps/web/src/modules/11-orders — patient orders list (M11 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ORDERS.md — "Use Patient Workspace + Work Queue" (patient half).
// Reached from the patient chart "Orders" tab; lists every order for the patient with its §2.2 D2 lifecycle
// status, kind, priority, and (for verbal_pending) the live 48h deadline. A status filter narrows the list.
// Window/countdown colour is a UX cue only — the server owns the authoritative status (ADR-0030, no frontend
// authz). Reads GET /api/v1/orders?patientId via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  PatientWorkspaceLayout,
  useApiClient,
} from "@wardenx/ui";

interface OrderRow {
  id: string;
  patientId: string;
  kind: string;
  status: string;
  priority: string;
  verbalDeadlineAt: string | null;
  createdAt: string;
}

const statusColor: Record<string, string | undefined> = {
  active: "#15803d",
  verbal_pending: "#b45309",
  pending_signature: "#b45309",
  expired_unsigned: "#b91c1c",
  discontinued: "#6b7280",
  completed: "#6b7280",
};

export function PatientOrders(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const [items, setItems] = useState<OrderRow[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/orders", {
      params: { query: { patientId } },
    });
    if (err) {
      setError("Could not load orders for this patient.");
      setLoading(false);
      return;
    }
    setItems((data?.orders ?? []) as OrderRow[]);
    setLoading(false);
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const nowMs = Date.now();
  const rows = useMemo(() => {
    const visible = status ? items.filter((o) => o.status === status) : items;
    return [...visible].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [items, status]);

  return (
    <PatientWorkspaceLayout
      banner={<PageHeader title="Orders" />}
      contextHeader={
        <FilterBar
          actions={
            <button type="button" onClick={() => setStatus("")}>
              Clear
            </button>
          }
        >
          <select aria-label="Order status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            <option value="draft">draft</option>
            <option value="pending_signature">pending_signature</option>
            <option value="verbal_pending">verbal_pending</option>
            <option value="active">active</option>
            <option value="completed">completed</option>
            <option value="discontinued">discontinued</option>
            <option value="expired_unsigned">expired_unsigned</option>
          </select>
        </FilterBar>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : loading && items.length === 0 ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No orders" description="No active orders for this patient." />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280" }}>
              <th style={th}>Order · kind</th>
              <th style={th}>Priority</th>
              <th style={th}>Status</th>
              <th style={th}>Verbal deadline</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const overdue =
                o.status === "verbal_pending" &&
                o.verbalDeadlineAt != null &&
                nowMs > Date.parse(o.verbalDeadlineAt);
              return (
                <tr
                  key={o.id}
                  onClick={() => navigate(`/orders/${o.id}`)}
                  style={{ cursor: "pointer", borderTop: "1px solid #f3f4f6" }}
                >
                  <td style={td}>{o.kind}</td>
                  <td style={td}>{o.priority}</td>
                  <td style={{ ...td, color: statusColor[o.status] }}>{o.status}</td>
                  <td style={{ ...td, color: overdue ? "#b91c1c" : undefined }}>
                    {o.verbalDeadlineAt ? o.verbalDeadlineAt.slice(0, 16).replace("T", " ") : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </PatientWorkspaceLayout>
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
