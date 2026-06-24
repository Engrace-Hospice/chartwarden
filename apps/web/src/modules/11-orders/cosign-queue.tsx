// apps/web/src/modules/11-orders — cosign-pending queue (M11 §4.1/§5 §2.5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ORDERS.md — "Use Work Queue" (cosignature). LPN-drafted kinds
// (per tenant policy) require an RN / Clinical-Supervisor cosignature before the order may go Active; this is
// the queue of orders with cosign_status='pending', showing the cosigner role needed. The cosign step-up
// action fills in as its write surface hardens. Reads GET /api/v1/orders/cosign-pending via the typed client;
// the server enforces the §4.7 cosigner_role_match ABAC (ADR-0030 — no frontend authz). Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  useApiClient,
  WorkQueueLayout,
} from "@wardenx/ui";

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
          <EmptyState title="No cosignatures pending" description="No orders are awaiting cosignature." />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={th}>Order · kind</th>
                <th style={th}>Drafted by</th>
                <th style={th}>Status</th>
                <th style={th}>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr
                  key={o.id}
                  onClick={() => navigate(`/orders/${o.id}`)}
                  style={{ cursor: "pointer", borderTop: "1px solid #f3f4f6" }}
                >
                  <td style={td}>{o.kind}</td>
                  <td style={td}>{o.drafterDiscipline}</td>
                  <td style={td}>{o.status}</td>
                  <td style={td}>{o.createdAt.slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
