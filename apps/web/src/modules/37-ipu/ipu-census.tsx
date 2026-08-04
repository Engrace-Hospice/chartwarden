// apps/web/src/modules/37-ipu — M37 IPU daily census (§5/§2.13). Reads today's census snapshot rows and
// surfaces the GIP/IRC head-counts + bed-days + incident counts. GET /api/v1/ipu-census/:date. Lantern:
// KpiStrip + CSS-var tokens only.
import {
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

interface CensusRow {
  unitId: string | null;
  censusCountGip: number;
  censusCountIrc: number;
  bedDaysGip: number;
  bedDaysIrc: number;
  roomTurnoverCount: number;
  restraintIncidentCount: number;
}

const today = (): string => new Date().toISOString().slice(0, 10);

export function IpuCensus(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<CensusRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const date = today();

  const load = useCallback(async () => {
    const res = await client.GET("/api/v1/ipu-census/{date}", { params: { path: { date } } });
    if (res.error) {
      setError("Census unavailable.");
      return;
    }
    setRows((res.data as unknown as { items: CensusRow[] }).items ?? []);
  }, [client, date]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (rows === null) return <LoadingSpinner />;

  const sum = (f: (r: CensusRow) => number) => rows.reduce((n, r) => n + f(r), 0);

  return (
    <div>
      <PageHeader title="IPU census" breadcrumb={`Daily snapshot — ${date}`} />
      {rows.length === 0 ? (
        <EmptyState
          title="No snapshot"
          description="No census snapshot has been materialized for today yet."
        />
      ) : (
        <KpiStrip>
          <KpiCard label="GIP census" value={String(sum((r) => r.censusCountGip))} />
          <KpiCard label="IRC census" value={String(sum((r) => r.censusCountIrc))} />
          <KpiCard label="GIP bed-days" value={String(sum((r) => r.bedDaysGip))} />
          <KpiCard label="IRC bed-days" value={String(sum((r) => r.bedDaysIrc))} />
          <KpiCard label="Turnovers" value={String(sum((r) => r.roomTurnoverCount))} />
          <KpiCard
            label="Restraint incidents"
            value={String(sum((r) => r.restraintIncidentCount))}
          />
        </KpiStrip>
      )}
    </div>
  );
}
