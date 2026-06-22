// apps/web/src/modules/11-orders — verbal-expiring queue (M11 §4.1/§5, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_ORDERS.md — "Use Work Queue" (verbal-order workflow). The RN's
// queue of verbal_pending orders inside the 48h signature window (42 CFR 418.104(b)), sorted by deadline.
// Each row shows a live countdown with pre-expiry colour tiers at 12h (amber) and 2h (red); past-deadline
// rows are flagged red (the server flips them to expired_unsigned — this is a UX cue only, ADR-0030, no
// frontend authz). Reads GET /api/v1/orders/verbal-expiring via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useMemo, useState } from "react";
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
  verbalDeadlineAt: string | null;
}

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

// Pure countdown formatter — "expired" / "2h 14m" / "1d 3h"; a UX cue, the server owns the deadline.
function countdown(deadline: string | null, nowMs: number): { label: string; color?: string } {
  if (!deadline) return { label: "—" };
  const ms = Date.parse(deadline) - nowMs;
  if (ms <= 0) return { label: "expired", color: "#b91c1c" };
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const mins = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  const label = hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h ${mins}m`;
  if (ms <= TWO_HOURS_MS) return { label, color: "#b91c1c" };
  if (ms <= TWELVE_HOURS_MS) return { label, color: "#b45309" };
  return { label };
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

  const nowMs = Date.now();
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
          <EmptyState title="No verbal orders pending" description="No verbal orders are awaiting signature." />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280" }}>
                <th style={th}>Order · kind</th>
                <th style={th}>Deadline</th>
                <th style={th}>Time left</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const c = countdown(o.verbalDeadlineAt, nowMs);
                return (
                  <tr
                    key={o.id}
                    onClick={() => navigate(`/orders/${o.id}`)}
                    style={{ cursor: "pointer", borderTop: "1px solid #f3f4f6" }}
                  >
                    <td style={td}>{o.kind}</td>
                    <td style={td}>
                      {o.verbalDeadlineAt ? o.verbalDeadlineAt.slice(0, 16).replace("T", " ") : "—"}
                    </td>
                    <td style={{ ...td, color: c.color, fontWeight: c.color ? 600 : undefined }}>{c.label}</td>
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
