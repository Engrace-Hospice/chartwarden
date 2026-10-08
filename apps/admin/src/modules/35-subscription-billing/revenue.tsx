import {
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Revenue (`/admin/revenue`, revenue.admin.read). The
// MRR/ARR dashboard: the live current estimate (GET /api/admin/revenue/current) as KPI tiles, plus the
// trailing snapshot history (GET /api/admin/revenue/snapshots) broken into new / expansion / contraction /
// churn MRR. Recompute (revenue.admin.write, step-up) refreshes the latest snapshot. Amounts are cents.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { formatCents, formatDate, idempotencyKey } from "./status";
import {
  type Outcome,
  OutcomeBanner,
  actionButtonStyle,
  bodyRow,
  cell,
  cellRight,
  failureOutcome,
  tableStyle,
  theadRow,
} from "./ui";

type Current =
  operations["getApiAdminRevenueCurrent"]["responses"][200]["content"]["application/json"];
type SnapshotPage =
  operations["getApiAdminRevenueSnapshots"]["responses"][200]["content"]["application/json"];
type Snapshot = SnapshotPage["items"][number];

export function Revenue(): JSX.Element {
  const client = useApiClient();
  const [current, setCurrent] = useState<Current | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const cur = await client.GET("/api/admin/revenue/current");
    if (cur.error) {
      setError("Revenue unavailable.");
      setLoading(false);
      return;
    }
    setCurrent(cur.data);
    const snaps = await client.GET("/api/admin/revenue/snapshots", { params: { query: {} } });
    setSnapshots(snaps.error ? [] : snaps.data.items);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const recompute = useCallback(async () => {
    setBusy(true);
    setOutcome(null);
    const res = await client.POST("/api/admin/revenue/snapshots/compute", {
      headers: { "Idempotency-Key": idempotencyKey() },
    });
    if (res.error) {
      setOutcome(failureOutcome(res.error, "Could not recompute revenue."));
    } else {
      setOutcome({ ok: true, message: "Revenue snapshot recomputed." });
      await load();
    }
    setBusy(false);
  }, [client, load]);

  if (loading) return <LoadingSpinner />;
  if (error || !current)
    return <EmptyState title="Unavailable" description={error ?? "No revenue data."} />;

  return (
    <div
      style={{
        padding: "1.5rem 1.75rem",
        display: "flex",
        flexDirection: "column",
        gap: "1.25rem",
      }}
    >
      <PageHeader
        title="Revenue"
        breadcrumb="Platform Ops"
        actions={
          <button
            type="button"
            onClick={() => void recompute()}
            disabled={busy}
            style={actionButtonStyle(true, busy)}
          >
            {busy ? "Recomputing…" : "Recompute"}
          </button>
        }
      />
      {outcome ? <OutcomeBanner {...outcome} /> : null}
      <KpiStrip>
        <KpiCard label="MRR" value={formatCents(current.mrrCents)} />
        <KpiCard label="ARR" value={formatCents(current.arrCents)} />
        <KpiCard
          label="Active subscriptions"
          value={current.activeSubscriptions.toLocaleString()}
        />
        <KpiCard label="As of" value={formatDate(current.asOf)} />
      </KpiStrip>
      <div>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, margin: "0 0 0.5rem" }}>
          Trailing snapshots
        </h2>
        {snapshots.length === 0 ? (
          <p style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
            No revenue snapshots recorded yet — run a recompute.
          </p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr style={theadRow}>
                <th style={cell}>Month</th>
                <th style={cellRight}>MRR</th>
                <th style={cellRight}>New</th>
                <th style={cellRight}>Expansion</th>
                <th style={cellRight}>Contraction</th>
                <th style={cellRight}>Churn</th>
                <th style={cellRight}>Active</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.id} style={bodyRow}>
                  <td style={cell} className="tabular-nums">
                    {s.snapshotMonth}
                  </td>
                  <td style={cellRight} className="tabular-nums">
                    {formatCents(s.mrrCents)}
                  </td>
                  <td style={cellRight} className="tabular-nums">
                    {formatCents(s.newMrrCents)}
                  </td>
                  <td style={cellRight} className="tabular-nums">
                    {formatCents(s.expansionMrrCents)}
                  </td>
                  <td style={cellRight} className="tabular-nums">
                    {formatCents(s.contractionMrrCents)}
                  </td>
                  <td style={cellRight} className="tabular-nums">
                    {formatCents(s.churnMrrCents)}
                  </td>
                  <td style={cellRight} className="tabular-nums">
                    {s.activeSubscriptions.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
