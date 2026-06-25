import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/36-messaging — Notifications & Tasks / Worklist (M36, Track A).
// Spec: docs/design/screens/core/WARDENX_UI_NOTIFICATIONS_TASKS.md — "Use Work Queue."
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

// §6.6 — alert severity → tone. An *alert* severity of "critical" is operational urgency (→ error),
// NOT the reserved gold `critical` tone (safety / controlled-substance only), same call as M04 audit.
const SEVERITY_TONE: Record<string, StatusTone> = {
  critical: "error",
  high: "error",
  warn: "warning",
  info: "neutral",
};
// Fan-out delivery status (§4 outbox) → tone.
const DELIVERY_TONE: Record<AlertItem["deliveryStatus"], StatusTone> = {
  delivered: "success",
  partial: "warning",
  failed: "error",
  pending: "progress",
};
const cap = (s: string): string => s.replace(/\b\w/g, (c) => c.toUpperCase());

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
      <table>
        <thead>
          <tr>
            <th>Severity</th>
            <th>Category</th>
            <th>Summary</th>
            <th>When</th>
            <th>Delivery</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((a) => (
            <tr key={a.alertId}>
              <td>
                <StatusPill label={cap(a.severity)} tone={SEVERITY_TONE[a.severity] ?? "neutral"} />
              </td>
              <td>{cap(a.category.replace(/_/g, " "))}</td>
              <td>{a.summary}</td>
              <td className="tabular-nums">{new Date(a.createdAt).toLocaleString()}</td>
              <td>
                <StatusPill label={cap(a.deliveryStatus)} tone={DELIVERY_TONE[a.deliveryStatus]} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
