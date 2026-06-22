import { EmptyState, LoadingSpinner, PageHeader, WorkQueueLayout, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/36-messaging — Notifications & Tasks / Worklist (M36, Track A).
// Spec: docs/ui/screens/core/WARDENX_UI_NOTIFICATIONS_TASKS.md — "Use Work Queue."
// The caller's alert inbox. Backed by GET /api/v1/alerts/inbox via the generated typed client.
import { useEffect, useState } from "react";
import type { JSX } from "react";

interface AlertItem {
  alertId: string;
  eventType: string;
  category: string;
  severity: string;
  summary: string;
  createdAt: string;
  deliveryStatus: "delivered" | "partial" | "failed" | "pending";
}

const severityColor: Record<string, string> = {
  critical: "#b91c1c",
  warn: "#b45309",
  high: "#b91c1c",
  info: "#6b7280",
};

export function NotificationsInbox(): JSX.Element {
  const client = useApiClient();
  const [alerts, setAlerts] = useState<AlertItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error: err } = await client.GET("/api/v1/alerts/inbox");
      if (!active) return;
      if (err) return setError("Could not load notifications.");
      setAlerts((data?.alerts ?? []) as AlertItem[]);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Notifications & Tasks" />}
      table={<AlertTable alerts={alerts} error={error} />}
    />
  );
}

function AlertTable({
  alerts,
  error,
}: { alerts: AlertItem[] | null; error: string | null }): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (alerts === null) return <LoadingSpinner />;
  if (alerts.length === 0)
    return <EmptyState title="All clear" description="You have no notifications." />;
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#6b7280" }}>
            <th style={th}>Severity</th>
            <th style={th}>Category</th>
            <th style={th}>Summary</th>
            <th style={th}>When</th>
            <th style={th}>Delivery</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((a) => (
            <tr key={a.alertId} style={{ borderTop: "1px solid #f3f4f6" }}>
              <td style={{ ...td, color: severityColor[a.severity] ?? "#111827", fontWeight: 600 }}>
                {a.severity}
              </td>
              <td style={td}>{a.category}</td>
              <td style={td}>{a.summary}</td>
              <td style={td}>{new Date(a.createdAt).toLocaleString()}</td>
              <td style={td}>{a.deliveryStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
