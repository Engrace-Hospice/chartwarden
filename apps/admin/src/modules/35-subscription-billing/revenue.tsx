import { Button, useApiClient, useRequestGuard } from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/admin/src/modules/35-subscription-billing — §5.2 Revenue (`/admin/revenue`, revenue.admin.read). The
// MRR/ARR dashboard: the live current estimate (GET /api/admin/revenue/current) as KPI tiles, plus the
// trailing snapshot history (GET /api/admin/revenue/snapshots) broken into new / expansion / contraction /
// churn MRR. Recompute (revenue.admin.write, step-up) refreshes the latest snapshot. Amounts are cents.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { formatCents, formatDate, idempotencyKey } from "./status";
import { type Outcome, OutcomeBanner, StateError, StateLoading, failureOutcome } from "./ui";

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

  const guard = useRequestGuard();
  const load = useCallback(async () => {
    const isCurrent = guard();
    setLoading(true);
    setError(null);
    const cur = await client.GET("/api/admin/revenue/current");
    if (!isCurrent()) return;
    if (cur.error) {
      setError("Revenue unavailable.");
      setLoading(false);
      return;
    }
    setCurrent(cur.data);
    const snaps = await client.GET("/api/admin/revenue/snapshots", { params: { query: {} } });
    if (!isCurrent()) return;
    setSnapshots(snaps.error ? [] : snaps.data.items);
    setLoading(false);
  }, [client, guard]);

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

  const stats = current
    ? [
        { label: "MRR", value: formatCents(current.mrrCents) },
        { label: "ARR", value: formatCents(current.arrCents) },
        { label: "Active subscriptions", value: current.activeSubscriptions.toLocaleString() },
        { label: "As of", value: formatDate(current.asOf) },
      ]
    : [];

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Revenue</h1>
            <p>Monthly and annual recurring revenue, with the trailing monthly snapshots.</p>
          </div>
          {current && !error ? (
            <div className="wx-list-toolbar-end">
              <Button loading={busy} disabled={loading} onClick={() => void recompute()}>
                Recompute
              </Button>
            </div>
          ) : null}
        </header>
        {outcome ? <OutcomeBanner {...outcome} /> : null}
        {loading ? (
          <StateLoading label="Loading revenue…" />
        ) : error || !current ? (
          <StateError message={error ?? "No revenue data."} onRetry={() => void load()} />
        ) : (
          <>
            <div className="wx-stat-grid" aria-label="Revenue summary">
              {stats.map((s) => (
                <div key={s.label} className="wx-stat-card">
                  <div>
                    <span className="wx-stat-label">{s.label}</span>
                    <span className="wx-stat-value wx-nums">{s.value}</span>
                  </div>
                </div>
              ))}
            </div>
            <h2 className="m-0 text-base font-semibold">Trailing snapshots</h2>
            {snapshots.length === 0 ? (
              <p className="m-0 text-sm">No revenue snapshots recorded yet — run a recompute.</p>
            ) : (
              <SnapshotsTable snapshots={snapshots} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

const MONEY_COLUMNS = [
  { label: "MRR", cents: (s: Snapshot) => s.mrrCents },
  { label: "New", cents: (s: Snapshot) => s.newMrrCents },
  { label: "Expansion", cents: (s: Snapshot) => s.expansionMrrCents },
  { label: "Contraction", cents: (s: Snapshot) => s.contractionMrrCents },
  { label: "Churn", cents: (s: Snapshot) => s.churnMrrCents },
] as const;

function SnapshotsTable({ snapshots }: { snapshots: readonly Snapshot[] }): JSX.Element {
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table wx-list-table-static">
        <caption className="wx-sr-only">Trailing revenue snapshots</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            {MONEY_COLUMNS.map((c) => (
              <th key={c.label} scope="col" className="wx-num-col">
                {c.label}
              </th>
            ))}
            <th scope="col" className="wx-num-col">
              Active
            </th>
          </tr>
        </thead>
        <tbody>
          {snapshots.map((s) => (
            <tr key={s.id}>
              <td className="wx-nums">{s.snapshotMonth}</td>
              {MONEY_COLUMNS.map((c) => (
                <td key={c.label} className="wx-num-col wx-nums">
                  {formatCents(c.cents(s))}
                </td>
              ))}
              <td className="wx-num-col wx-nums">{s.activeSubscriptions.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
