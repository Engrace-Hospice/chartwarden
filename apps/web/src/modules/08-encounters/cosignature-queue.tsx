import {
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/08-encounters — Cosignature Queue (M8 §5.5, Track B / ADR-0030).
// Spec: docs/ui/screens/clinical/WARDENX_UI_ENCOUNTER_VISIT_DOCUMENTATION.md — "Use Work Queue."
// The RN / Clinical Supervisor cosignature work queue: one row per encounter awaiting cosignature,
// with an SLA chip derived from hours-since-primary-sign (green ≤12h, yellow 12–24h, orange 24–48h,
// red >48h, §5.5). A row opens the Encounter Read view. Reads GET /api/v1/encounters/cosignature-queue
// via the typed client; the server enforces every scope (ADR-0030 — no authz on the frontend).
// Imports only leaves (@wardenx/ui).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";

interface EncounterRow {
  id: string;
  patientId: string;
  encounterType: string;
  discipline: string;
  serviceDate: string;
  status: string;
  signedAt: string | null;
}

// SLA chip per §5.5: hours since the primary signature.
function slaChip(signedAt: string | null): { label: string; color: string } {
  if (!signedAt) return { label: "—", color: "#6b7280" };
  const hours = (Date.now() - new Date(signedAt).getTime()) / 3_600_000;
  if (hours <= 12) return { label: `${Math.floor(hours)}h`, color: "#15803d" };
  if (hours <= 24) return { label: `${Math.floor(hours)}h`, color: "#b45309" };
  if (hours <= 48) return { label: `${Math.floor(hours)}h`, color: "#c2410c" };
  return { label: `${Math.floor(hours)}h`, color: "#b91c1c" };
}

export function CosignatureQueue(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const [items, setItems] = useState<EncounterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/encounters/cosignature-queue");
      if (!active) return;
      if (err) {
        setError("Could not load the cosignature queue.");
        setLoading(false);
        return;
      }
      setItems((data?.encounters ?? []) as EncounterRow[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  const overdue = items.filter((e) => slaChip(e.signedAt).color === "#b91c1c").length;

  return (
    <WorkQueueLayout
      header={<PageHeader title="Cosignatures" />}
      kpis={
        <KpiStrip>
          <KpiCard label="Pending" value={items.length} />
          <KpiCard label="Past hard cap" value={overdue} />
        </KpiStrip>
      }
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading ? (
          <LoadingSpinner />
        ) : items.length === 0 ? (
          <EmptyState
            title="No cosignatures"
            description="No encounters are awaiting your cosignature."
          />
        ) : (
          <div style={{ padding: "0 1.5rem 1.5rem" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "#6b7280" }}>
                  <th style={th}>Encounter</th>
                  <th style={th}>Discipline</th>
                  <th style={th}>Service date</th>
                  <th style={th}>SLA</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => {
                  const chip = slaChip(e.signedAt);
                  return (
                    <tr
                      key={e.id}
                      // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
                      role="button"
                      tabIndex={0}
                      onClick={() => navigate(`/patients/${e.patientId}/encounters/${e.id}`)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          navigate(`/patients/${e.patientId}/encounters/${e.id}`);
                        }
                      }}
                      style={{ cursor: "pointer", borderTop: "1px solid #f3f4f6" }}
                    >
                      <td style={td}>{e.encounterType}</td>
                      <td style={td}>{e.discipline}</td>
                      <td style={td}>{e.serviceDate}</td>
                      <td style={td}>
                        <span style={{ color: chip.color, fontWeight: 600 }}>● {chip.label}</span>
                      </td>
                      <td style={td}>{e.status}</td>
                    </tr>
                  );
                })}
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
