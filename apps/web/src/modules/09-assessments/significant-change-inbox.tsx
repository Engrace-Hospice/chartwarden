import {
  Button,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
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
import { CHANGE_TONE, SEVERITY_TONE, stateLabel } from "./assessment-status";
import { acknowledgeChange } from "./assessments-api";

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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the intentional refetch trigger a completed acknowledgement bumps, not read in the body.
  useEffect(() => {
    let active = true;
    (async () => {
      if (!patientId) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET(
        "/api/v1/patients/{patientId}/significant-changes",
        {
          params: { path: { patientId } },
        },
      );
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
  }, [client, patientId, reloadKey]);

  /**
   * #91 — acknowledge the detected change. This is the ONE action this queue exists for and it did not
   * offer it: a decline the detector found sat unacknowledged forever, and the escalation that keys off
   * acknowledgement never stopped. The event row is KEPT — acknowledging records that a clinician saw
   * it, it does not erase the finding.
   */
  async function acknowledge(eventId: string): Promise<void> {
    setBusyId(eventId);
    setNotice(null);
    const res = await acknowledgeChange(client, eventId);
    setBusyId(null);
    setNotice(res.ok ? "Acknowledged." : res.message);
    if (res.ok) setReloadKey((k) => k + 1);
  }

  const open = items.filter((c) => c.status !== "acknowledged").length;
  const high = items.filter((c) => c.severity === "high" && c.status !== "acknowledged").length;

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Significant changes">
          {notice ? (
            <output
              style={{
                display: "block",
                fontSize: "0.8rem",
                color: "var(--color-on-surface-variant)",
              }}
            >
              {notice}
            </output>
          ) : null}
        </PageHeader>
      }
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
          <EmptyState
            title="No changes"
            description="No significant changes detected for this patient."
          />
        ) : (
          <div style={{ padding: "0 1.5rem 1.5rem" }}>
            <table>
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>Severity</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Acknowledge</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td>{stateLabel(c.ruleId)}</td>
                    <td>
                      <StatusPill
                        label={stateLabel(c.severity)}
                        tone={SEVERITY_TONE[c.severity] ?? "neutral"}
                      />
                    </td>
                    <td>
                      <StatusPill
                        label={stateLabel(c.status)}
                        tone={CHANGE_TONE[c.status] ?? "neutral"}
                      />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {c.status === "acknowledged" ? (
                        <span style={{ color: "var(--color-muted)" }}>—</span>
                      ) : (
                        <Button
                          tone="tertiary"
                          size="sm"
                          disabled={busyId === c.id}
                          onClick={() => void acknowledge(c.id)}
                        >
                          Acknowledge
                        </Button>
                      )}
                    </td>
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
