import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/11-orders — standing-order admin (M11 §4.1/§5 §2.4 D5, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_ORDERS.md — "Use Work Queue" (Standing orders). A signed template
// spawns instances on cadence (spawned instances do NOT re-require signature — the template is the signature
// anchor, D5). This worklist lists every standing-order template with its cadence, status (active/paused/
// discontinued), next-spawn time, and spawn count. The create / pause / resume / discontinue / PRN-spawn write
// actions fill in as their write surfaces harden. Reads GET /api/v1/standing-orders via the typed client; the
// server enforces every scope (ADR-0030 — no frontend authz). Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { STANDING_TONE, stateLabel } from "./orders-status";

interface StandingOrderRow {
  id: string;
  patientId: string;
  kind: string;
  cadence: string;
  status: string;
  nextSpawnAt: string | null;
  spawnCount: number;
  maxSpawns: number | null;
}

export function StandingOrders(): JSX.Element {
  const client = useApiClient();
  const [items, setItems] = useState<StandingOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/standing-orders", {});
    if (err) {
      setError("Could not load standing orders.");
      setLoading(false);
      return;
    }
    setItems((data?.standingOrders ?? []) as StandingOrderRow[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Standing Orders" />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : items.length === 0 ? (
          <EmptyState
            title="No standing orders"
            description="No standing-order templates are defined."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Kind</th>
                <th>Cadence</th>
                <th>Status</th>
                <th>Next spawn</th>
                <th>Spawns</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td>{stateLabel(s.kind)}</td>
                  <td>{stateLabel(s.cadence)}</td>
                  <td>
                    <StatusPill
                      label={stateLabel(s.status)}
                      tone={STANDING_TONE[s.status] ?? "neutral"}
                    />
                  </td>
                  <td className="tabular-nums">
                    {s.nextSpawnAt ? s.nextSpawnAt.slice(0, 16).replace("T", " ") : "—"}
                  </td>
                  <td className="tabular-nums">
                    {s.spawnCount}
                    {s.maxSpawns != null ? ` / ${s.maxSpawns}` : ""}
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
