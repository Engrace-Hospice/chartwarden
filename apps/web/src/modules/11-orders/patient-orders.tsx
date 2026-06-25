import {
  CountdownChip,
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  PatientWorkspaceLayout,
  StatusPill,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/11-orders — patient orders list (M11 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ORDERS.md — "Use Patient Workspace + Work Queue" (patient half).
// Reached from the patient chart "Orders" tab; lists every order for the patient with its §2.2 D2 lifecycle
// status, kind, priority, and (for verbal_pending) the live 48h deadline. A status filter narrows the list.
// Window/countdown colour is a UX cue only — the server owns the authoritative status (ADR-0030, no frontend
// authz). Reads GET /api/v1/orders?patientId via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ORDER_TONE, PRIORITY_TONE, stateLabel } from "./orders-status";

interface OrderRow {
  id: string;
  patientId: string;
  kind: string;
  status: string;
  priority: string;
  verbalDeadlineAt: string | null;
  createdAt: string;
}

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
          <select
            aria-label="Order status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">Any status</option>
            <option value="draft">Draft</option>
            <option value="pending_signature">Pending Signature</option>
            <option value="verbal_pending">Verbal Pending</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="discontinued">Discontinued</option>
            <option value="expired_unsigned">Expired Unsigned</option>
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
        <table>
          <thead>
            <tr>
              <th>Order · kind</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Verbal deadline</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr
                key={o.id}
                // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/orders/${o.id}`)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    navigate(`/orders/${o.id}`);
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <td>{stateLabel(o.kind)}</td>
                <td>
                  <StatusPill
                    label={stateLabel(o.priority)}
                    tone={PRIORITY_TONE[o.priority] ?? "neutral"}
                  />
                </td>
                <td>
                  <StatusPill
                    label={stateLabel(o.status)}
                    tone={ORDER_TONE[o.status] ?? "neutral"}
                  />
                </td>
                <td>
                  {/* §2.3 verbal-order 48h window — only verbal_pending orders run the clock. */}
                  {o.status === "verbal_pending" && o.verbalDeadlineAt ? (
                    <CountdownChip
                      dueAt={o.verbalDeadlineAt}
                      warnWithinHours={12}
                      alertWithinHours={2}
                      label="Sign"
                    />
                  ) : (
                    <span style={{ color: "var(--color-muted)" }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </PatientWorkspaceLayout>
  );
}
