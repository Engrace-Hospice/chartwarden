import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/11-orders — cosign-pending queue (M11 §4.1/§5 §2.5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ORDERS.md — "Use Work Queue" (cosignature). LPN-drafted kinds
// (per tenant policy) require an RN / Clinical-Supervisor cosignature before the order may go Active; this is
// the queue of orders with cosign_status='pending', showing the cosigner role needed. The cosign step-up
// action fills in as its write surface hardens. Reads GET /api/v1/orders/cosign-pending via the typed client;
// the server enforces the §4.7 cosigner_role_match ABAC (ADR-0030 — no frontend authz). Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { ORDER_TONE, stateLabel } from "./orders-status";

interface OrderRow {
  id: string;
  patientId: string;
  kind: string;
  status: string;
  drafterDiscipline: string;
  createdAt: string;
}

export function CosignQueue(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/orders/cosign-pending", {});
    if (err) {
      setError("Could not load the cosign-pending queue.");
      setLoading(false);
      return;
    }
    setItems((data?.orders ?? []) as OrderRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = [...items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  return (
    <WorkQueueLayout
      header={<PageHeader title="Orders — Cosign Pending" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No cosignatures pending"
            description="No orders are awaiting cosignature."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Order · kind</th>
                <th>Drafted by</th>
                <th>Status</th>
                <th>Created</th>
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
                  <td>{stateLabel(o.drafterDiscipline)}</td>
                  <td>
                    <StatusPill
                      label={stateLabel(o.status)}
                      tone={ORDER_TONE[o.status] ?? "neutral"}
                    />
                  </td>
                  <td className="tabular-nums">{o.createdAt.slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}
