// apps/web/src/modules/11-orders — lab results-pending-review queue (M11 §4.1/§5 D17, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ORDERS.md — "Use Work Queue" (Lab flow). Result attachment does
// NOT auto-complete the order (D17 / 42 CFR 418.106); this queue surfaces every lab order whose results have
// been received and are awaiting the clinician's "Mark reviewed" acknowledgment. The Mark-reviewed action
// (the active → completed transition) fills in as its write surface hardens. Reads
// GET /api/v1/orders/results-pending-review via the typed client; the server enforces every scope incl. ABAC
// (ADR-0030 — no frontend authz). Leaves only (@wardenx/ui).
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
  resultsStatus: string;
  transmissionStatus: string;
  signedAt: string | null;
}

export function ResultsReviewQueue(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/orders/results-pending-review", {});
    if (err) {
      setError("Could not load the results-review queue.");
      setLoading(false);
      return;
    }
    setItems((data?.orders ?? []) as OrderRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = [...items].sort((a, b) => Date.parse(a.signedAt ?? "") - Date.parse(b.signedAt ?? ""));

  return (
    <WorkQueueLayout
      header={<PageHeader title="Lab Results — Pending Review" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No results to review" description="No lab results are awaiting clinician review." />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={th}>Order · kind</th>
                <th style={th}>Results</th>
                <th style={th}>Transmission</th>
                <th style={th}>Signed</th>
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
                  <td style={{ ...td, color: o.resultsStatus === "results_overdue" ? "#b91c1c" : undefined }}>
                    {o.resultsStatus}
                  </td>
                  <td style={td}>{o.transmissionStatus}</td>
                  <td style={td}>{o.signedAt ? o.signedAt.slice(0, 16).replace("T", " ") : "—"}</td>
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
