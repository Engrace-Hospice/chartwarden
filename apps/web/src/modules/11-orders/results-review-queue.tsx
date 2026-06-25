import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
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
import { RESULTS_TONE, TRANSMISSION_TONE, stateLabel } from "./orders-status";

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

  const rows = [...items].sort(
    (a, b) => Date.parse(a.signedAt ?? "") - Date.parse(b.signedAt ?? ""),
  );

  return (
    <WorkQueueLayout
      header={<PageHeader title="Lab Results — Pending Review" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No results to review"
            description="No lab results are awaiting clinician review."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Order · kind</th>
                <th>Results</th>
                <th>Transmission</th>
                <th>Signed</th>
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
                      label={stateLabel(o.resultsStatus)}
                      tone={RESULTS_TONE[o.resultsStatus] ?? "neutral"}
                    />
                  </td>
                  <td>
                    <StatusPill
                      label={stateLabel(o.transmissionStatus)}
                      tone={TRANSMISSION_TONE[o.transmissionStatus] ?? "neutral"}
                    />
                  </td>
                  <td className="tabular-nums">
                    {o.signedAt ? o.signedAt.slice(0, 16).replace("T", " ") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    />
  );
}
