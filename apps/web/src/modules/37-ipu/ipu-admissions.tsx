// apps/web/src/modules/37-ipu — M37 IPU admissions worklist (§5). Lists the org's IPU admissions with
// their level of care + lifecycle state. GET /api/v1/ipu-admissions (RLS-scoped server-side). Lantern:
// UI components + CSS-var tokens only.
import { EmptyState, LoadingSpinner, PageHeader, type StatusTone, StatusPill, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

interface Admission {
  id: string;
  kind: string;
  state: string;
  unitId: string | null;
  remoteFacilityId: string | null;
  openedAt: string;
}

const tone = (state: string): StatusTone =>
  state === "active" ? "success" : state === "closed" || state === "discharged" ? "neutral" : "warning";

export function IpuAdmissions(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<Admission[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await client.GET("/api/v1/ipu-admissions");
    if (res.error) {
      setError("Admissions unavailable.");
      return;
    }
    setRows((res.data as unknown as { items: Admission[] }).items ?? []);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (rows === null) return <LoadingSpinner />;

  return (
    <div>
      <PageHeader title="IPU admissions" breadcrumb="General Inpatient (GIP) and Inpatient Respite (IRC) bedside stays" />
      {rows.length === 0 ? (
        <EmptyState title="No admissions" description="No active IPU admissions." />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--color-text-muted)" }}>
              <th style={{ padding: "var(--space-2)" }}>Level</th>
              <th style={{ padding: "var(--space-2)" }}>State</th>
              <th style={{ padding: "var(--space-2)" }}>Location</th>
              <th style={{ padding: "var(--space-2)" }}>Opened</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} style={{ borderTop: "1px solid var(--color-border)" }}>
                <td style={{ padding: "var(--space-2)", textTransform: "uppercase" }}>{a.kind}</td>
                <td style={{ padding: "var(--space-2)" }}>
                  <StatusPill tone={tone(a.state)} label={a.state.replace(/_/g, " ")} />
                </td>
                <td style={{ padding: "var(--space-2)" }}>{a.unitId ? "Own unit" : a.remoteFacilityId ? "Arranged" : "—"}</td>
                <td style={{ padding: "var(--space-2)" }}>{new Date(a.openedAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
