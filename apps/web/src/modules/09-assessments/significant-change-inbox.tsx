// apps/web/src/modules/09-assessments — Significant-change inbox, per-patient (M9 §5.1/§5.2, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md — "Use Work Queue."
// The open / escalated significant-change events for this patient: one row per event with its rule, severity,
// and acknowledgement state. Even when M36 push is degraded, this list reads `significant_change_event` rows
// directly so the care team still sees the alert (§5.6 degraded-mode). The ack action (§5.2) fills in as the
// write path hardens. Reads GET /api/v1/patients/:patientId/significant-changes via the typed client; the
// server enforces every scope (ADR-0030 — no authz on the frontend). Imports only leaves (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import {
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";

interface ChangeRow {
  id: string;
  assessmentId: string;
  ruleId: string;
  status: string;
  severity: string;
}

export function SignificantChangeInbox(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const [items, setItems] = useState<ChangeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!patientId) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/patients/{patientId}/significant-changes", {
        params: { path: { patientId } },
      });
      if (!active) return;
      if (err) {
        setError("Could not load significant changes.");
        setLoading(false);
        return;
      }
      setItems((data?.events ?? []) as ChangeRow[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, patientId]);

  const open = items.filter((c) => c.status !== "acknowledged").length;
  const high = items.filter((c) => c.severity === "high" && c.status !== "acknowledged").length;

  return (
    <WorkQueueLayout
      header={<PageHeader title="Significant changes" />}
      kpis={
        <KpiStrip>
          <KpiCard label="Open" value={open} />
          <KpiCard label="High severity" value={high} />
        </KpiStrip>
      }
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading ? (
          <LoadingSpinner />
        ) : items.length === 0 ? (
          <EmptyState title="No changes" description="No significant changes detected for this patient." />
        ) : (
          <div style={{ padding: "0 1.5rem 1.5rem" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#6b7280" }}>
                  <th style={th}>Rule</th>
                  <th style={th}>Severity</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                    <td style={td}>{c.ruleId}</td>
                    <td style={{ ...td, color: c.severity === "high" ? "#b91c1c" : "#92400e" }}>{c.severity}</td>
                    <td style={td}>{c.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    />
  );
}

const th = { padding: "0.5rem 0.5rem", fontWeight: 600 } as const;
const td = { padding: "0.5rem 0.5rem" } as const;
