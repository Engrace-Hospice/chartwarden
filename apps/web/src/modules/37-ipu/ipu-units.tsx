// apps/web/src/modules/37-ipu — M37 IPU units board (§5, ADR-0030). Lists the org's inpatient units with
// their bed count + RN-coverage horizon. Composed client-side from GET /api/v1/inpatient-units (RLS-scoped
// server-side; the server is the authoritative enforcer, this only presents). Lantern: UI components +
// CSS-var tokens only.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

interface Unit {
  id: string;
  displayName: string;
  bedCount: number;
  isActive: boolean;
  rnCoverageHorizonHours: number;
  turnoverSlaMinutes: number;
}

export function IpuUnits(): JSX.Element {
  const client = useApiClient();
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await client.GET("/api/v1/inpatient-units");
    if (res.error) {
      setError("Units unavailable.");
      return;
    }
    setUnits(((res.data as unknown as { items: Unit[] }).items ?? []));
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (units === null) return <LoadingSpinner />;

  return (
    <div>
      <PageHeader title="Inpatient units" breadcrumb="General Inpatient / Respite bed capacity" />
      {units.length === 0 ? (
        <EmptyState title="No units" description="No inpatient units are configured for this organization yet." />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--color-text-muted)" }}>
              <th style={{ padding: "var(--space-2)" }}>Unit</th>
              <th style={{ padding: "var(--space-2)" }}>Beds</th>
              <th style={{ padding: "var(--space-2)" }}>RN horizon</th>
              <th style={{ padding: "var(--space-2)" }}>Turnover SLA</th>
              <th style={{ padding: "var(--space-2)" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <tr key={u.id} style={{ borderTop: "1px solid var(--color-border)" }}>
                <td style={{ padding: "var(--space-2)" }}>{u.displayName}</td>
                <td style={{ padding: "var(--space-2)" }}>{u.bedCount}</td>
                <td style={{ padding: "var(--space-2)" }}>{u.rnCoverageHorizonHours}h</td>
                <td style={{ padding: "var(--space-2)" }}>{u.turnoverSlaMinutes}m</td>
                <td style={{ padding: "var(--space-2)" }}>
                  <StatusPill tone={u.isActive ? "success" : "neutral"} label={u.isActive ? "Active" : "Inactive"} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
