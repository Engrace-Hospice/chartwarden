import {
  CountdownChip,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/11-orders — verbal-expiring queue (M11 §4.1/§5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ORDERS.md — "Use Work Queue" (verbal-order workflow). The RN's
// queue of verbal_pending orders inside the 48h signature window (42 CFR 418.104(b)), sorted by deadline.
// Each row shows a live countdown with pre-expiry colour tiers at 12h (amber) and 2h (red); past-deadline
// rows are flagged red (the server flips them to expired_unsigned — this is a UX cue only, ADR-0030, no
// frontend authz). Reads GET /api/v1/orders/verbal-expiring via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { stateLabel } from "./orders-status";

interface OrderRow {
  id: string;
  patientId: string;
  kind: string;
  status: string;
  verbalDeadlineAt: string | null;
}

export function VerbalExpiringQueue(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/orders/verbal-expiring", {});
    if (err) {
      setError("Could not load the verbal-expiring queue.");
      setLoading(false);
      return;
    }
    setItems((data?.orders ?? []) as OrderRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(
    () =>
      [...items].sort(
        (a, b) => Date.parse(a.verbalDeadlineAt ?? "") - Date.parse(b.verbalDeadlineAt ?? ""),
      ),
    [items],
  );

  return (
    <WorkQueueLayout
      header={<PageHeader title="Verbal Orders — Expiring" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No verbal orders pending"
            description="No verbal orders are awaiting signature."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Order · kind</th>
                <th>Deadline</th>
                <th>Time left</th>
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
                  <td className="tabular-nums">
                    {o.verbalDeadlineAt ? o.verbalDeadlineAt.slice(0, 16).replace("T", " ") : "—"}
                  </td>
                  <td>
                    {/* §2.3 verbal-order 48h window (42 CFR 418.104) — amber ≤12h, alert ≤2h, overdue past. */}
                    {o.verbalDeadlineAt ? (
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
        )
      }
    />
  );
}
