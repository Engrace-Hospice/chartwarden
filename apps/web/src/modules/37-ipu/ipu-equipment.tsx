// apps/web/src/modules/37-ipu — M37 IPU equipment register (§5/§2.9). Lists durable/biomed equipment with
// its status + next inspection due date (an overdue inspection blocks bed assignment). GET
// /api/v1/ipu-equipment. Lantern: UI components + CSS-var tokens only.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

interface Equipment {
  id: string;
  serialNumber: string;
  equipmentType: string;
  currentStatus: string;
  nextInspectionDueDate: string | null;
}

export function IpuEquipment(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<Equipment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = new Date().toISOString().slice(0, 10);

  const load = useCallback(async () => {
    const res = await client.GET("/api/v1/ipu-equipment");
    if (res.error) {
      setError("Equipment unavailable.");
      return;
    }
    setRows((res.data as unknown as { items: Equipment[] }).items ?? []);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (rows === null) return <LoadingSpinner />;

  const overdue = (due: string | null): boolean => due !== null && due < now;

  return (
    <div>
      <PageHeader title="IPU equipment" breadcrumb="Durable + biomed equipment register" />
      {rows.length === 0 ? (
        <EmptyState title="No equipment" description="No IPU equipment is registered yet." />
      ) : (
        <table
          style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}
        >
          <thead>
            <tr style={{ textAlign: "left", color: "var(--color-text-muted)" }}>
              <th style={{ padding: "var(--space-2)" }}>Serial</th>
              <th style={{ padding: "var(--space-2)" }}>Type</th>
              <th style={{ padding: "var(--space-2)" }}>Status</th>
              <th style={{ padding: "var(--space-2)" }}>Inspection due</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} style={{ borderTop: "1px solid var(--color-border)" }}>
                <td style={{ padding: "var(--space-2)" }}>{e.serialNumber}</td>
                <td style={{ padding: "var(--space-2)" }}>{e.equipmentType.replace(/_/g, " ")}</td>
                <td style={{ padding: "var(--space-2)" }}>{e.currentStatus}</td>
                <td style={{ padding: "var(--space-2)" }}>
                  <StatusPill
                    tone={overdue(e.nextInspectionDueDate) ? "critical" : "success"}
                    label={e.nextInspectionDueDate ?? "—"}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
